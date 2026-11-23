import crypto from "node:crypto";
import { Router } from "express";
import { db } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";
import { isRealDate, parseId } from "./crud.js";
import { CHARGE_SELECT, brToday, monthRange } from "./finance.js";
import { ASAAS_URLS, orgAsaas, type AsaasConfig } from "./integrations.js";
import { emitWebhook } from "./webhooks.js";

/**
 * Boletos pelo Asaas, individuais ou em lote, a partir das cobranças.
 * - O boleto não substitui cobrança nem pagamento: quando o Asaas informa que foi pago, o boleto fica "paga" e a
 *   equipe registra o recebimento em Financeiro (que emite o recibo e dá a baixa). Nada é baixado automaticamente.
 * - Um boleto em aberto por cobrança (índice único). A linha é reservada ANTES de falar com o Asaas, então
 *   dois cliques seguidos não geram dois boletos.
 * - Dados enviados ao Asaas: nome, CPF/CNPJ e e-mail do locatário principal, valor, vencimento e descrição.
 */

const BULK_MAX = 100;

export class BoletoError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** Falha que vale para o lote inteiro (chave recusada, Asaas fora do ar): para de tentar as próximas. */
    public readonly fatal = false,
  ) {
    super(message);
  }
}

type FetchLike = typeof fetch;
let fetchImpl: FetchLike = (...args) => fetch(...args);
/** Para testes: troca a chamada HTTP ao Asaas. */
export function setAsaasFetch(f: FetchLike | null) {
  fetchImpl = f ?? ((...args) => fetch(...args));
}

async function asaas<T>(cfg: AsaasConfig, method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(`${ASAAS_URLS[cfg.env]}${path}`, {
      method,
      headers: { access_token: cfg.apiKey, "User-Agent": "Ethos", Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new BoletoError(502, "Não consegui falar com o Asaas agora. Tente novamente em instantes.", true);
  }
  const json = (await res.json().catch(() => ({}))) as { errors?: { description?: string }[] } & Record<string, unknown>;
  if (res.ok) return json as T;
  if (res.status === 401 || res.status === 403) {
    throw new BoletoError(502, `O Asaas recusou a chave. Confira em Integrações se ela é do ambiente ${cfg.env === "production" ? "de produção" : "sandbox"}.`, true);
  }
  if (res.status === 429) throw new BoletoError(429, "O Asaas pediu para diminuir o ritmo. Espere um pouco e tente de novo.", true);
  const detail = json.errors?.[0]?.description;
  if (res.status >= 500) throw new BoletoError(502, "O Asaas está instável agora. Tente novamente em instantes.", true);
  throw new BoletoError(422, detail ? `Asaas: ${detail}` : `O Asaas recusou o pedido (HTTP ${res.status}).`);
}

const STATUS_MAP: Record<string, "pendente" | "vencida" | "paga" | "cancelada"> = {
  PENDING: "pendente",
  AWAITING_RISK_ANALYSIS: "pendente",
  OVERDUE: "vencida",
  RECEIVED: "paga",
  CONFIRMED: "paga",
  RECEIVED_IN_CASH: "paga",
  REFUNDED: "cancelada",
  REFUND_REQUESTED: "cancelada",
  REFUND_IN_PROGRESS: "cancelada",
  CHARGEBACK_REQUESTED: "cancelada",
  DELETED: "cancelada",
};

interface AsaasPayment {
  id: string;
  status: string;
  invoiceUrl?: string;
  bankSlipUrl?: string;
  paymentDate?: string | null;
  clientPaymentDate?: string | null;
  confirmedDate?: string | null;
}

const BOLETO_SELECT = `
  SELECT b.id, b.charge_id, b.status, b.amount_cents, b.due_date, b.invoice_url, b.bank_slip_url, b.identification_field,
         b.paid_at, b.environment, b.created_at, b.updated_at,
         c.description, c.kind, u.identifier AS unit_identifier, pr.name AS property_name,
         (SELECT string_agg(t.name, ', ' ORDER BY lt.position) FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id WHERE lt.lease_id = c.lease_id) AS tenant_names
  FROM boletos b
  JOIN charges c ON c.id = b.charge_id
  JOIN leases l ON l.id = c.lease_id
  JOIN units u ON u.id = l.unit_id
  JOIN properties pr ON pr.id = u.property_id`;

interface Cfg {
  orgId: number;
  asaas: AsaasConfig;
}
async function configFor(orgId: number): Promise<Cfg> {
  const a = await orgAsaas(orgId);
  if (!a) throw new BoletoError(409, "Conecte o Asaas em Administração › Integrações antes de emitir boletos.");
  return { orgId, asaas: a };
}

/** Emite um boleto para a cobrança. Lança BoletoError com mensagem pronta para o usuário. */
export async function issueBoleto(cfg: Cfg, userId: number, chargeId: number, dueOverride?: string): Promise<Record<string, unknown>> {
  const { orgId, asaas: a } = cfg;
  const [charge] = await db.query<{ id: number; lease_id: number; description: string; due_date: string; amount_cents: number; paid_cents: number; status: string }>(
    `${CHARGE_SELECT} WHERE c.id = $1 AND c.organization_id = $2`,
    [chargeId, orgId],
  );
  if (!charge) throw new BoletoError(404, "Cobrança não encontrada.");
  if (charge.status === "cancelada") throw new BoletoError(409, "Esta cobrança está cancelada.");
  if (charge.status === "paga") throw new BoletoError(409, "Esta cobrança já está paga.");
  const balance = charge.amount_cents - charge.paid_cents;
  if (balance < 1) throw new BoletoError(409, "Esta cobrança não tem saldo a receber.");

  const [tenant] = await db.query<{ id: number; name: string; document: string; email: string | null }>(
    `SELECT t.id, t.name, t.document, t.email FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id
     WHERE lt.lease_id = $1 ORDER BY lt.position LIMIT 1`,
    [charge.lease_id],
  );
  if (!tenant) throw new BoletoError(409, "O contrato desta cobrança não tem locatário.");
  const doc = tenant.document.replace(/\D/g, "");
  if (doc.length !== 11 && doc.length !== 14) {
    throw new BoletoError(422, `${tenant.name}: o CPF/CNPJ cadastrado não é válido para emitir boleto. Corrija o cadastro do inquilino.`);
  }

  const today = brToday();
  let due = charge.due_date < today ? today : charge.due_date; // o Asaas não aceita vencimento no passado
  if (dueOverride !== undefined) {
    const max = new Date(Date.parse(`${today}T00:00:00Z`) + 365 * 86_400_000).toISOString().slice(0, 10);
    if (!isRealDate(dueOverride) || dueOverride < today || dueOverride > max) {
      throw new BoletoError(400, "O vencimento do boleto deve ser uma data entre hoje e 1 ano à frente.");
    }
    due = dueOverride;
  }

  // Reserva a vaga ANTES de chamar o Asaas: o índice único barra o segundo clique.
  const placeholder = `pending:${crypto.randomUUID()}`;
  let boletoId: number;
  try {
    const [row] = await db.query<{ id: number }>(
      `INSERT INTO boletos (organization_id, charge_id, environment, external_id, amount_cents, due_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [orgId, chargeId, a.env, placeholder, balance, due, userId],
    );
    boletoId = row!.id;
  } catch (err) {
    if (typeof err === "object" && err && (err as { code?: string }).code === "23505") throw new BoletoError(409, "Esta cobrança já tem um boleto em aberto.");
    throw err;
  }

  try {
    // Cliente no Asaas (um por inquilino e ambiente).
    let [customer] = await db.query<{ external_id: string }>("SELECT external_id FROM asaas_customers WHERE organization_id = $1 AND tenant_id = $2 AND environment = $3", [orgId, tenant.id, a.env]);
    if (!customer) {
      const created = await asaas<{ id: string }>(a, "POST", "/customers", {
        name: tenant.name,
        cpfCnpj: doc,
        ...(tenant.email ? { email: tenant.email } : {}),
        externalReference: `ethos-tenant-${tenant.id}`,
      });
      await db.query("INSERT INTO asaas_customers (organization_id, tenant_id, environment, external_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [orgId, tenant.id, a.env, created.id]);
      customer = { external_id: created.id };
    }
    const payment = await asaas<AsaasPayment>(a, "POST", "/payments", {
      customer: customer.external_id,
      billingType: "BOLETO",
      value: balance / 100,
      dueDate: due,
      description: charge.description.slice(0, 500),
      externalReference: `ethos-charge-${chargeId}`,
      ...(a.fine > 0 ? { fine: { value: a.fine } } : {}),
      ...(a.interest > 0 ? { interest: { value: a.interest } } : {}),
    });
    // Linha digitável: se falhar, o boleto continua válido (o link do Asaas mostra tudo).
    const field = await asaas<{ identificationField?: string; barCode?: string }>(a, "GET", `/payments/${payment.id}/identificationField`).catch(() => ({}) as { identificationField?: string; barCode?: string });
    await db.query(
      `UPDATE boletos SET external_id = $1, invoice_url = $2, bank_slip_url = $3, identification_field = $4, bar_code = $5, updated_at = now() WHERE id = $6`,
      [payment.id, payment.invoiceUrl ?? null, payment.bankSlipUrl ?? null, field.identificationField ?? null, field.barCode ?? null, boletoId],
    );
  } catch (err) {
    await db.query("DELETE FROM boletos WHERE id = $1", [boletoId]); // libera a vaga
    throw err;
  }
  const [item] = await db.query(`${BOLETO_SELECT} WHERE b.id = $1`, [boletoId]);
  return item!;
}

/** Consulta o Asaas e atualiza a situação do boleto. Devolve true se acabou de ser pago. */
async function syncOne(cfg: Cfg, b: { id: number; external_id: string; status: string; charge_id: number }, actorId: number | null): Promise<{ changed: boolean; paid: boolean }> {
  const p = await asaas<AsaasPayment>(cfg.asaas, "GET", `/payments/${b.external_id}`);
  const next = STATUS_MAP[p.status] ?? b.status;
  if (next === b.status) return { changed: false, paid: false };
  const paidAt = next === "paga" ? (p.clientPaymentDate ?? p.paymentDate ?? p.confirmedDate ?? brToday()).slice(0, 10) : null;
  await db.query("UPDATE boletos SET status = $1, paid_at = $2, updated_at = now() WHERE id = $3", [next, paidAt, b.id]);
  if (next === "paga") {
    emitWebhook({
      organizationId: cfg.orgId,
      event: "boleto.paid",
      actor: actorId ? { id: actorId, name: null, role: null } : null,
      entity: "boletos",
      entityId: b.id,
      summary: "Boleto pago",
      data: { boleto_id: b.id, charge_id: b.charge_id, paid_at: paidAt },
    });
  }
  return { changed: true, paid: next === "paga" };
}

export const boletosRouter = Router();
boletosRouter.use("/boletos", requireAuth, requireRole("admin", "colaborador"));

boletosRouter.get("/boletos/status", async (req, res) => {
  const a = await orgAsaas(req.auth!.organization.id);
  res.json({ connected: Boolean(a), environment: a?.env ?? null, fine_percent: a?.fine ?? 0, interest_percent: a?.interest ?? 0 });
});

boletosRouter.get("/boletos", async (req, res) => {
  const params: unknown[] = [req.auth!.organization.id];
  let where = "b.organization_id = $1";
  if (req.query.charge_id !== undefined) {
    const id = parseId(req.query.charge_id);
    if (!id) return void res.status(400).json({ error: "charge_id inválido" });
    params.push(id);
    where += ` AND b.charge_id = $${params.length}`;
  }
  if (req.query.status !== undefined) {
    if (!["pendente", "vencida", "paga", "cancelada"].includes(String(req.query.status))) return void res.status(400).json({ error: "status inválido" });
    params.push(req.query.status);
    where += ` AND b.status = $${params.length}`;
  }
  if (req.query.month !== undefined) {
    const r = monthRange(req.query.month);
    if (!r) return void res.status(400).json({ error: "month deve ser AAAA-MM" });
    params.push(r.start, r.next);
    where += ` AND b.due_date >= $${params.length - 1} AND b.due_date < $${params.length}`;
  }
  const items = await db.query(`${BOLETO_SELECT} WHERE ${where} ORDER BY b.due_date DESC, b.id DESC LIMIT 500`, params);
  res.json({ items });
});

function fail(res: import("express").Response, err: unknown) {
  if (err instanceof BoletoError) return void res.status(err.status).json({ error: err.message });
  throw err;
}

/** Individual: um boleto para uma cobrança (vencimento opcional). */
boletosRouter.post("/boletos", async (req, res) => {
  const chargeId = parseId(req.body?.charge_id);
  if (!chargeId) return void res.status(400).json({ error: "Informe charge_id" });
  const due = req.body?.due_date === undefined || req.body.due_date === null || req.body.due_date === "" ? undefined : String(req.body.due_date);
  try {
    const cfg = await configFor(req.auth!.organization.id);
    res.status(201).json({ item: await issueBoleto(cfg, req.auth!.user.id, chargeId, due) });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * Em lote: todas as cobranças em aberto de um mês (`month`), ou as indicadas em `charge_ids`, que ainda não têm boleto.
 * Até 100 por chamada; se houver mais, `remaining` diz quantas faltam (basta repetir).
 */
boletosRouter.post("/boletos/bulk", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const body = (req.body ?? {}) as { month?: unknown; charge_ids?: unknown; kinds?: unknown };
  const params: unknown[] = [orgId];
  let where = "c.organization_id = $1";
  if (Array.isArray(body.charge_ids)) {
    const ids = [...new Set(body.charge_ids.map(parseId).filter((n): n is number => n !== undefined))];
    if (ids.length === 0) return void res.status(400).json({ error: "charge_ids vazio ou inválido" });
    if (ids.length > 500) return void res.status(400).json({ error: "Máximo de 500 cobranças por pedido" });
    params.push(ids);
    where += ` AND c.id = ANY($${params.length}::int[])`;
  } else {
    const r = monthRange(body.month);
    if (!r) return void res.status(400).json({ error: "Informe month (AAAA-MM) ou charge_ids" });
    params.push(r.start, r.next);
    where += ` AND c.due_date >= $${params.length - 1} AND c.due_date < $${params.length}`;
  }
  if (Array.isArray(body.kinds) && body.kinds.length > 0) {
    params.push(body.kinds.map(String));
    where += ` AND c.kind = ANY($${params.length}::text[])`;
  }
  try {
    const cfg = await configFor(orgId);
    const todo = await db.query<{ id: number; description: string; unit_identifier: string }>(
      `SELECT x.id, x.description, x.unit_identifier FROM (${CHARGE_SELECT} WHERE ${where}) x
       WHERE x.status IN ('aberta','parcial','vencida')
         AND NOT EXISTS (SELECT 1 FROM boletos b WHERE b.charge_id = x.id AND b.status IN ('pendente','vencida'))
       ORDER BY x.due_date, x.id`,
      params,
    );
    const batch = todo.slice(0, BULK_MAX);
    const created: number[] = [];
    const failed: { charge_id: number; label: string; error: string }[] = [];
    let stoppedBy: string | null = null;
    for (const c of batch) {
      try {
        await issueBoleto(cfg, req.auth!.user.id, c.id);
        created.push(c.id);
      } catch (err) {
        if (!(err instanceof BoletoError)) throw err;
        failed.push({ charge_id: c.id, label: `${c.description} · ${c.unit_identifier}`, error: err.message });
        if (err.fatal) {
          stoppedBy = err.message;
          break; // chave recusada / Asaas fora do ar: não adianta insistir nas próximas
        }
      }
    }
    const attempted = created.length + failed.length;
    res.json({ eligible: todo.length, created: created.length, failed, remaining: todo.length - attempted, stopped_by: stoppedBy });
  } catch (err) {
    fail(res, err);
  }
});

/** Atualiza a situação de TODOS os boletos em aberto da organização (até 100 por vez, os menos recentes primeiro). */
boletosRouter.post("/boletos/sync", async (req, res) => {
  const orgId = req.auth!.organization.id;
  try {
    const cfg = await configFor(orgId);
    const open = await db.query<{ id: number; external_id: string; status: string; charge_id: number }>(
      `SELECT id, external_id, status, charge_id FROM boletos
        WHERE organization_id = $1 AND status IN ('pendente','vencida') AND environment = $2 AND external_id NOT LIKE 'pending:%'
        ORDER BY updated_at LIMIT $3`,
      [orgId, cfg.asaas.env, BULK_MAX],
    );
    let changed = 0;
    let paid = 0;
    let errors = 0;
    for (const b of open) {
      try {
        const r = await syncOne(cfg, b, req.auth!.user.id);
        if (r.changed) changed++;
        if (r.paid) paid++;
        else await db.query("UPDATE boletos SET updated_at = now() WHERE id = $1", [b.id]);
      } catch (err) {
        if (!(err instanceof BoletoError)) throw err;
        errors++;
        if (err.fatal) return void res.status(err.status).json({ error: err.message });
      }
    }
    res.json({ checked: open.length, changed, paid, errors });
  } catch (err) {
    fail(res, err);
  }
});

boletosRouter.post("/boletos/:id/sync", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const id = parseId(req.params.id);
  try {
    const cfg = await configFor(orgId);
    const [b] = id ? await db.query<{ id: number; external_id: string; status: string; charge_id: number }>("SELECT id, external_id, status, charge_id FROM boletos WHERE id = $1 AND organization_id = $2", [id, orgId]) : [];
    if (!b) return void res.status(404).json({ error: "Não encontrado" });
    if (b.external_id.startsWith("pending:")) return void res.status(409).json({ error: "Este boleto ainda está sendo emitido." });
    await syncOne(cfg, b, req.auth!.user.id);
    const [item] = await db.query(`${BOLETO_SELECT} WHERE b.id = $1`, [b.id]);
    res.json({ item });
  } catch (err) {
    fail(res, err);
  }
});

/** Cancela o boleto no Asaas (só se ainda não foi pago). A cobrança continua em aberto. */
boletosRouter.post("/boletos/:id/cancel", requireRole("admin"), async (req, res) => {
  const orgId = req.auth!.organization.id;
  const id = parseId(req.params.id);
  try {
    const cfg = await configFor(orgId);
    const [b] = id ? await db.query<{ id: number; external_id: string; status: string }>("SELECT id, external_id, status FROM boletos WHERE id = $1 AND organization_id = $2", [id, orgId]) : [];
    if (!b) return void res.status(404).json({ error: "Não encontrado" });
    if (b.status === "paga") return void res.status(409).json({ error: "Este boleto já foi pago e não pode ser cancelado." });
    if (b.status === "cancelada") return void res.status(409).json({ error: "Este boleto já está cancelado." });
    if (b.external_id.startsWith("pending:")) return void res.status(409).json({ error: "Este boleto ainda está sendo emitido." });
    try {
      await asaas(cfg.asaas, "DELETE", `/payments/${b.external_id}`);
    } catch (err) {
      // 422 do Asaas = não pode excluir (ex.: já recebido). Reconsulta para refletir a verdade.
      if (err instanceof BoletoError && !err.fatal) {
        await syncOne(cfg, { ...b, charge_id: 0 }, req.auth!.user.id).catch(() => undefined);
        const [now] = await db.query<{ status: string }>("SELECT status FROM boletos WHERE id = $1", [b.id]);
        if (now?.status === "paga") return void res.status(409).json({ error: "O Asaas informa que este boleto já foi pago; ele não pode ser cancelado." });
      }
      throw err;
    }
    await db.query("UPDATE boletos SET status = 'cancelada', updated_at = now() WHERE id = $1", [b.id]);
    res.status(204).end();
  } catch (err) {
    fail(res, err);
  }
});
