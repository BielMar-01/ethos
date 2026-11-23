import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { Router } from "express";
import { db } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";
import { parseId } from "./crud.js";
import { background } from "./background.js";
import { RateLimiter } from "./ratelimit.js";
import { SecretsNotConfigured, decryptSecret, encryptSecret, secretsReady } from "./secrets.js";

/**
 * Webhooks de SAÍDA: o Ethos avisa um endereço (n8n, Make, Zapier, seu sistema) quando algo acontece.
 *  - Assinado: `X-Ethos-Signature: t=<unix>,v1=<HMAC-SHA256(segredo, "<t>.<corpo>")>` — quem recebe confere a assinatura e rejeita `t` antigo.
 *  - Seguro: só HTTPS e só endereços PÚBLICOS (bloqueia localhost/rede interna/metadados de nuvem), sem seguir redirecionamentos.
 *  - Confiável o bastante: até 3 tentativas em falha de rede/5xx/429; cada entrega fica registrada (as últimas 50 por endereço).
 *  - Os eventos vêm do mesmo ponto da auditoria: toda escrita bem-sucedida de módulos de negócio.
 */

/** Catálogo de eventos que um endpoint pode assinar. */
export const EVENTS: { event: string; label: string; group: string }[] = [
  { event: "owner.created", label: "Proprietário cadastrado", group: "Cadastros" },
  { event: "owner.updated", label: "Proprietário alterado", group: "Cadastros" },
  { event: "tenant.created", label: "Inquilino cadastrado", group: "Cadastros" },
  { event: "tenant.updated", label: "Inquilino alterado", group: "Cadastros" },
  { event: "property.created", label: "Imóvel cadastrado", group: "Cadastros" },
  { event: "property.updated", label: "Imóvel alterado", group: "Cadastros" },
  { event: "unit.created", label: "Unidade cadastrada", group: "Cadastros" },
  { event: "unit.updated", label: "Unidade alterada", group: "Cadastros" },
  { event: "lease.created", label: "Contrato criado (rascunho)", group: "Contratos" },
  { event: "lease.updated", label: "Contrato alterado", group: "Contratos" },
  { event: "lease.status_changed", label: "Situação do contrato mudou (ativado, encerrado…)", group: "Contratos" },
  { event: "charge.created", label: "Cobrança criada", group: "Financeiro" },
  { event: "charges.generated", label: "Aluguéis do mês gerados", group: "Financeiro" },
  { event: "charge.cancelled", label: "Cobrança cancelada", group: "Financeiro" },
  { event: "boleto.created", label: "Boleto emitido", group: "Financeiro" },
  { event: "boletos.generated", label: "Boletos emitidos em lote", group: "Financeiro" },
  { event: "boleto.paid", label: "Boleto pago (informado pelo Asaas)", group: "Financeiro" },
  { event: "boleto.cancelled", label: "Boleto cancelado", group: "Financeiro" },
  { event: "payment.received", label: "Pagamento recebido", group: "Financeiro" },
  { event: "payment.voided", label: "Pagamento estornado", group: "Financeiro" },
  { event: "transfer.paid", label: "Repasse pago", group: "Financeiro" },
  { event: "maintenance.created", label: "Chamado de manutenção aberto", group: "Manutenção e vistorias" },
  { event: "maintenance.status_changed", label: "Situação do chamado mudou", group: "Manutenção e vistorias" },
  { event: "inspection.created", label: "Vistoria criada", group: "Manutenção e vistorias" },
  { event: "inspection.status_changed", label: "Situação da vistoria mudou", group: "Manutenção e vistorias" },
  { event: "announcement.published", label: "Comunicado publicado", group: "Comunicados" },
];
export const EVENT_NAMES = new Set(EVENTS.map((e) => e.event));

/** Entidades (recurso da auditoria) que geram evento genérico `<entidade>.created|updated|deleted`. */
const ENTITY_SINGULAR: Record<string, string> = {
  owners: "owner", tenants: "tenant", properties: "property", units: "unit", leases: "lease", charges: "charge",
  payments: "payment", transfers: "transfer", maintenance: "maintenance", inspections: "inspection", announcements: "announcement",
};
const GENERIC_VERB = { create: "created", update: "updated", delete: "deleted" } as const;

/** Nome do evento para uma escrita (ou `null` quando ela não deve sair do sistema). */
export function eventFor(entity: string | null | undefined, kind: string, explicit?: string): string | null {
  if (explicit) return explicit;
  const singular = entity ? ENTITY_SINGULAR[entity] : undefined;
  const verb = GENERIC_VERB[kind as keyof typeof GENERIC_VERB];
  return singular && verb ? `${singular}.${verb}` : null;
}

// ---------------------------------------------------------------------------------------------- segurança de URL (SSRF)

function isPrivateAddress(addr: string): boolean {
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = addr.toLowerCase();
  if (v6 === "::1" || v6 === "::") return true;
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb");
}

const allowPrivate = () => process.env.ETHOS_ALLOW_PRIVATE_WEBHOOKS === "1"; // SOMENTE para testes automatizados

/** Valida formato e aponta apenas para a internet pública. Lança Error com mensagem pronta para o usuário. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Endereço inválido. Use algo como https://n8n.seudominio.com/webhook/ethos");
  }
  if (allowPrivate()) return url;
  if (url.protocol !== "https:") throw new Error("O endereço precisa começar com https://");
  if (url.username || url.password) throw new Error("Não coloque usuário e senha no endereço.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) throw new Error("Endereços internos não são permitidos.");
  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addresses.length === 0) throw new Error("Não consegui encontrar esse endereço na internet.");
  if (addresses.some(isPrivateAddress)) throw new Error("O endereço aponta para uma rede interna, que não é permitida.");
  return url;
}

// ---------------------------------------------------------------------------------------------- envio

const sign = (secret: string, t: number, body: string) => crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");

interface Endpoint { id: number; organization_id: number; url: string; secret_enc: string }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BACKOFF = Number(process.env.ETHOS_WEBHOOK_BACKOFF_MS ?? 1000);

/** Envia um evento a um endereço (com tentativas) e registra o resultado. */
export async function deliver(ep: Endpoint, event: string, payload: Record<string, unknown>): Promise<{ ok: boolean; http_status: number | null; error: string | null; attempts: number }> {
  const deliveryId = crypto.randomUUID();
  const body = JSON.stringify({ id: deliveryId, ...payload });
  let secret: string;
  try {
    secret = decryptSecret(ep.secret_enc);
  } catch {
    return record(ep, event, { ok: false, http_status: null, error: "Segredo ilegível (INTEGRATIONS_SECRET mudou?). Gere um novo segredo.", attempts: 0 }, 0);
  }
  const started = Date.now();
  let last: { ok: boolean; http_status: number | null; error: string | null } = { ok: false, http_status: null, error: "Falha desconhecida" };
  let attempts = 0;
  for (; attempts < 3; ) {
    attempts++;
    try {
      const url = await assertPublicUrl(ep.url); // confere de novo na hora de enviar
      const t = Math.floor(Date.now() / 1000);
      const res = await fetch(url, {
        method: "POST",
        redirect: "manual", // redirecionar poderia levar para a rede interna
        signal: AbortSignal.timeout(5000),
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Ethos-Webhooks/1.0",
          "X-Ethos-Event": event,
          "X-Ethos-Delivery": deliveryId,
          "X-Ethos-Signature": `t=${t},v1=${sign(secret, t, body)}`,
        },
        body,
      });
      await res.arrayBuffer().catch(() => {});
      if (res.status >= 200 && res.status < 300) {
        last = { ok: true, http_status: res.status, error: null };
        break;
      }
      last = { ok: false, http_status: res.status, error: res.status >= 300 && res.status < 400 ? "O destino respondeu com redirecionamento (não seguimos)." : `O destino respondeu HTTP ${res.status}.` };
      if (res.status < 500 && res.status !== 429 && res.status !== 408) break; // erro do destino que repetir não resolve
    } catch (err) {
      const msg = err instanceof Error ? err.message : "erro de rede";
      last = { ok: false, http_status: null, error: /timeout|aborted/i.test(msg) ? "O destino demorou mais de 5 segundos." : msg.slice(0, 200) };
      if (/endereço|interna|https|encontrar/i.test(msg)) break; // bloqueio de segurança: não repetir
    }
    if (attempts < 3) await sleep(BACKOFF * attempts);
  }
  return record(ep, event, { ...last, attempts }, Date.now() - started);
}

async function record(ep: Endpoint, event: string, r: { ok: boolean; http_status: number | null; error: string | null; attempts: number }, ms: number) {
  try {
    await db.query(
      `INSERT INTO webhook_deliveries (organization_id, endpoint_id, event, status, http_status, error, attempts, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ep.organization_id, ep.id, event, r.ok ? "ok" : "error", r.http_status, r.error, r.attempts, ms],
    );
    await db.query(
      `DELETE FROM webhook_deliveries WHERE endpoint_id = $1 AND id < (SELECT min(id) FROM (SELECT id FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY id DESC LIMIT 50) x)`,
      [ep.id],
    );
  } catch (err) {
    console.error("Falha ao registrar entrega de webhook:", err instanceof Error ? err.message : err);
  }
  return r;
}

export interface EmitInput {
  organizationId: number;
  event: string;
  actor: { id: number; name: string | null; role: string | null } | null;
  entity: string | null;
  entityId: number | null;
  summary: string;
  data: unknown;
}

const MAX_DATA_BYTES = 200_000;

/** Dispara o evento para todos os endereços ativos da organização que o assinam. Nunca lança. */
export function emitWebhook(e: EmitInput): void {
  background(
    (async () => {
      const endpoints = await db.query<Endpoint>(
        `SELECT id, organization_id, url, secret_enc FROM webhook_endpoints
          WHERE organization_id = $1 AND enabled AND ($2 = ANY(events) OR '*' = ANY(events))`,
        [e.organizationId, e.event],
      );
      if (endpoints.length === 0) return;
      let data = e.data ?? null;
      let truncated = false;
      if (data && JSON.stringify(data).length > MAX_DATA_BYTES) {
        data = null;
        truncated = true;
      }
      const payload = {
        event: e.event,
        created_at: new Date().toISOString(),
        organization_id: e.organizationId,
        actor: e.actor,
        entity: e.entity,
        entity_id: e.entityId,
        summary: e.summary,
        data,
        ...(truncated ? { data_truncated: true } : {}),
      };
      await Promise.all(endpoints.map((ep) => deliver(ep, e.event, payload)));
    })(),
  );
}

// ---------------------------------------------------------------------------------------------- rotas (somente admin logado)

export const webhooksRouter = Router();
webhooksRouter.use("/webhooks", requireAuth, requireRole("admin"));
const testLimiter = new RateLimiter(20, 60 * 1000);

const newSecret = () => `whsec_${crypto.randomBytes(24).toString("hex")}`;

function parseEvents(v: unknown): string[] | { error: string } {
  if (!Array.isArray(v) || v.length === 0) return { error: "Escolha pelo menos um evento (ou todos)." };
  if (v.includes("*")) return ["*"];
  const list = [...new Set(v.map(String))];
  const bad = list.find((x) => !EVENT_NAMES.has(x));
  return bad ? { error: `Evento desconhecido: ${bad}` } : list;
}

const PUBLIC = "id, name, url, events, enabled, created_at, updated_at";

webhooksRouter.get("/webhooks/events", (_req, res) => {
  res.json({ events: EVENTS });
});

webhooksRouter.get("/webhooks", async (req, res) => {
  const items = await db.query(
    `SELECT e.id, e.name, e.url, e.events, e.enabled, e.created_at, e.updated_at,
            d.status AS last_status, d.http_status AS last_http_status, d.error AS last_error, d.created_at AS last_at, d.event AS last_event
       FROM webhook_endpoints e
       LEFT JOIN LATERAL (SELECT status, http_status, error, created_at, event FROM webhook_deliveries WHERE endpoint_id = e.id ORDER BY id DESC LIMIT 1) d ON true
      WHERE e.organization_id = $1 ORDER BY e.id`,
    [req.auth!.organization.id],
  );
  res.json({ items, secrets_ready: secretsReady() });
});

webhooksRouter.post("/webhooks", async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name || name.length > 100) {
    res.status(400).json({ error: "Dê um nome ao endereço (até 100 caracteres)." });
    return;
  }
  const events = parseEvents(req.body?.events);
  if ("error" in events) {
    res.status(400).json(events);
    return;
  }
  const count = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM webhook_endpoints WHERE organization_id = $1", [req.auth!.organization.id]);
  if (Number(count[0]!.n) >= 10) {
    res.status(409).json({ error: "Limite de 10 endereços por organização." });
    return;
  }
  try {
    const url = await assertPublicUrl(String(req.body?.url ?? ""));
    const secret = newSecret();
    const [row] = await db.query(
      `INSERT INTO webhook_endpoints (organization_id, name, url, secret_enc, events) VALUES ($1,$2,$3,$4,$5) RETURNING ${PUBLIC}`,
      [req.auth!.organization.id, name, url.toString(), encryptSecret(secret), events],
    );
    res.status(201).json({ item: row, secret }); // o segredo aparece UMA vez
  } catch (err) {
    if (err instanceof SecretsNotConfigured) {
      res.status(409).json({ error: err.message });
      return;
    }
    res.status(400).json({ error: err instanceof Error ? err.message : "Endereço inválido." });
  }
});

webhooksRouter.patch("/webhooks/:id", async (req, res) => {
  const id = parseId(req.params.id);
  const orgId = req.auth!.organization.id;
  const [current] = id ? await db.query<{ name: string; url: string; events: string[]; enabled: boolean }>("SELECT name, url, events, enabled FROM webhook_endpoints WHERE id = $1 AND organization_id = $2", [id, orgId]) : [];
  if (!current) {
    res.status(404).json({ error: "Não encontrado" });
    return;
  }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const name = b.name === undefined ? current.name : String(b.name).trim();
  if (!name || name.length > 100) {
    res.status(400).json({ error: "Dê um nome ao endereço (até 100 caracteres)." });
    return;
  }
  let events = current.events;
  if (b.events !== undefined) {
    const parsed = parseEvents(b.events);
    if ("error" in parsed) {
      res.status(400).json(parsed);
      return;
    }
    events = parsed;
  }
  try {
    const url = b.url === undefined ? current.url : (await assertPublicUrl(String(b.url))).toString();
    const enabled = b.enabled === undefined ? current.enabled : b.enabled === true;
    const [row] = await db.query(
      `UPDATE webhook_endpoints SET name = $1, url = $2, events = $3, enabled = $4, updated_at = now() WHERE id = $5 AND organization_id = $6 RETURNING ${PUBLIC}`,
      [name, url, events, enabled, id, orgId],
    );
    res.json({ item: row });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : "Endereço inválido." });
  }
});

webhooksRouter.delete("/webhooks/:id", async (req, res) => {
  const id = parseId(req.params.id);
  const rows = id ? await db.query("DELETE FROM webhook_endpoints WHERE id = $1 AND organization_id = $2 RETURNING id", [id, req.auth!.organization.id]) : [];
  if (rows.length === 0) {
    res.status(404).json({ error: "Não encontrado" });
    return;
  }
  res.status(204).end();
});

webhooksRouter.post("/webhooks/:id/rotate-secret", async (req, res) => {
  const id = parseId(req.params.id);
  try {
    const secret = newSecret();
    const rows = id ? await db.query("UPDATE webhook_endpoints SET secret_enc = $1, updated_at = now() WHERE id = $2 AND organization_id = $3 RETURNING id", [encryptSecret(secret), id, req.auth!.organization.id]) : [];
    if (rows.length === 0) {
      res.status(404).json({ error: "Não encontrado" });
      return;
    }
    res.json({ secret });
  } catch (err) {
    if (err instanceof SecretsNotConfigured) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});

/** Envia um evento `ping` agora e devolve o resultado (síncrono, para a tela mostrar o que houve). */
webhooksRouter.post("/webhooks/:id/test", async (req, res) => {
  const id = parseId(req.params.id);
  const orgId = req.auth!.organization.id;
  if (!testLimiter.allow(`wh-test:${orgId}`)) {
    res.status(429).json({ error: "Muitos testes seguidos. Aguarde um instante." });
    return;
  }
  const [ep] = id ? await db.query<Endpoint>("SELECT id, organization_id, url, secret_enc FROM webhook_endpoints WHERE id = $1 AND organization_id = $2", [id, orgId]) : [];
  if (!ep) {
    res.status(404).json({ error: "Não encontrado" });
    return;
  }
  const result = await deliver(ep, "ping", {
    event: "ping",
    created_at: new Date().toISOString(),
    organization_id: orgId,
    actor: { id: req.auth!.user.id, name: req.auth!.user.name, role: req.auth!.role },
    entity: null,
    entity_id: null,
    summary: "Teste de conexão do Ethos",
    data: { message: "Se você recebeu isto, o endereço está funcionando." },
  });
  res.json(result);
});

webhooksRouter.get("/webhooks/:id/deliveries", async (req, res) => {
  const id = parseId(req.params.id);
  const items = id
    ? await db.query(
        `SELECT d.id, d.event, d.status, d.http_status, d.error, d.attempts, d.duration_ms, d.created_at
           FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
          WHERE d.endpoint_id = $1 AND e.organization_id = $2 ORDER BY d.id DESC LIMIT 50`,
        [id, req.auth!.organization.id],
      )
    : [];
  res.json({ items: items.map((r) => ({ ...r, id: Number((r as { id: string | number }).id) })) });
});
