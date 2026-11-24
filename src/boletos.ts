import crypto from "node:crypto";
import { Router } from "express";
import { db } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";
import { isRealDate, parseId } from "./crud.js";
import { CHARGE_SELECT, brToday, generateRent, monthRange, recordPayment } from "./finance.js";
import { notify, tenantUsersOfLease } from "./notifications.js";
import { sendEmail } from "./mailer.js";
import { SharedRateLimiter } from "./ratelimit.js";
import { appUrl } from "./authProvider.js";
import { formatBRL } from "./contractTemplate.js";
import { ASAAS_URLS, orgAsaas, type AsaasConfig } from "./integrations.js";
import { emitWebhook } from "./webhooks.js";

/**
 * Boletos pelo Asaas, individuais ou em lote, a partir das cobranças.
 * - O boleto não substitui cobrança nem pagamento: quando o Asaas informa que foi pago, o boleto fica "paga" e a
 *   equipe registra o recebimento em Financeiro (que emite o recibo e dá a baixa). Nada é baixado automaticamente.
 * - Um boleto em aberto por cobrança (índice único). A linha é reservada ANTES de falar com o Asaas, então
 *   dois cliques seguidos não geram dois boletos.
 * - Dados enviados ao Asaas: nome, CPF/CNPJ e e-mail do locatário principal, valor, vencimento e descrição.
 * - Boleto MANUAL (provider 'manual'): não depende de nenhuma integração. A equipe registra um boleto emitido em
 *   outro lugar (linha digitável, nosso número, link) ou gera só a "guia de cobrança" do Ethos para imprimir.
 *   A guia NÃO é compensável em banco. A equipe também marca o boleto manual como pago; a baixa da cobrança continua em Pagamentos.
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
  SELECT b.id, b.charge_id, b.provider, b.our_number, b.notes, b.amount_cents, b.due_date, b.invoice_url, b.bank_slip_url, b.identification_field,
         CASE WHEN b.provider = 'manual' AND b.status = 'pendente' AND b.due_date < (now() AT TIME ZONE 'America/Sao_Paulo')::date THEN 'vencida' ELSE b.status END AS status,
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

interface ChargeRow { id: number; lease_id: number; description: string; due_date: string; amount_cents: number; paid_cents: number; status: string }

/** Cobrança que aceita boleto + saldo a receber. */
async function openCharge(orgId: number, chargeId: number): Promise<{ charge: ChargeRow; balance: number }> {
  const [charge] = await db.query<ChargeRow>(`${CHARGE_SELECT} WHERE c.id = $1 AND c.organization_id = $2`, [chargeId, orgId]);
  if (!charge) throw new BoletoError(404, "Cobrança não encontrada.");
  if (charge.status === "cancelada") throw new BoletoError(409, "Esta cobrança está cancelada.");
  if (charge.status === "paga") throw new BoletoError(409, "Esta cobrança já está paga.");
  const balance = charge.amount_cents - charge.paid_cents;
  if (balance < 1) throw new BoletoError(409, "Esta cobrança não tem saldo a receber.");
  return { charge, balance };
}

export interface ManualInput {
  due_date?: string;
  amount_cents?: number;
  identification_field?: string | null;
  our_number?: string | null;
  url?: string | null;
  notes?: string | null;
}

const optText = (v: unknown, max: number, label: string): string | null => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || v.trim().length > max) throw new BoletoError(400, `${label}: texto inválido ou longo demais (máx. ${max}).`);
  return v.trim() || null;
};

/** Valida os campos livres do boleto manual (devolve valores prontos para gravar). */
export function cleanManual(i: ManualInput): { identification_field: string | null; our_number: string | null; url: string | null; notes: string | null } {
  const field = optText(i.identification_field, 70, "Linha digitável");
  if (field && !/^[\d .-]{10,70}$/.test(field)) throw new BoletoError(400, "A linha digitável deve ter só números (pode ter pontos e espaços).");
  const url = optText(i.url, 500, "Link");
  if (url && !/^https?:\/\/\S+$/i.test(url)) throw new BoletoError(400, "O link do boleto deve começar com http:// ou https://.");
  return { identification_field: field, our_number: optText(i.our_number, 40, "Nosso número"), url, notes: optText(i.notes, 500, "Observações") };
}

function manualDue(chargeDue: string, requested: string | undefined): string {
  if (requested === undefined) return chargeDue;
  const max = new Date(Date.parse(`${brToday()}T00:00:00Z`) + 365 * 86_400_000).toISOString().slice(0, 10);
  if (!isRealDate(requested) || requested > max) throw new BoletoError(400, "O vencimento deve ser uma data válida de até 1 ano à frente.");
  return requested;
}

/** Cria um boleto manual (sem integração). Um em aberto por cobrança, como nos demais. */
export async function issueManual(orgId: number, userId: number, chargeId: number, input: ManualInput = {}): Promise<Record<string, unknown>> {
  const { charge, balance } = await openCharge(orgId, chargeId);
  const fields = cleanManual(input);
  let amount = balance;
  if (input.amount_cents !== undefined) {
    if (!Number.isInteger(input.amount_cents) || input.amount_cents < 1 || input.amount_cents > balance) {
      throw new BoletoError(400, "O valor do boleto deve ser de 1 centavo até o saldo da cobrança.");
    }
    amount = input.amount_cents;
  }
  const due = manualDue(charge.due_date, input.due_date);
  try {
    const [row] = await db.query<{ id: number }>(
      `INSERT INTO boletos (organization_id, charge_id, provider, environment, external_id, amount_cents, due_date, identification_field, our_number, bank_slip_url, notes, created_by)
       VALUES ($1,$2,'manual','manual',$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [orgId, chargeId, `manual:${crypto.randomUUID()}`, amount, due, fields.identification_field, fields.our_number, fields.url, fields.notes, userId],
    );
    const [item] = await db.query(`${BOLETO_SELECT} WHERE b.id = $1`, [row!.id]);
    return item!;
  } catch (err) {
    if (typeof err === "object" && err && (err as { code?: string }).code === "23505") throw new BoletoError(409, "Esta cobrança já tem um boleto em aberto.");
    throw err;
  }
}

/** Emite um boleto para a cobrança. Lança BoletoError com mensagem pronta para o usuário. */
export async function issueBoleto(cfg: Cfg, userId: number, chargeId: number, dueOverride?: string): Promise<Record<string, unknown>> {
  const { orgId, asaas: a } = cfg;
  const { charge, balance } = await openCharge(orgId, chargeId);

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
  res.json({ manual: true, connected: Boolean(a), environment: a?.env ?? null, fine_percent: a?.fine ?? 0, interest_percent: a?.interest ?? 0 });
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
/** Cobranças em aberto sem boleto aberto, escolhidas por `month` ou `charge_ids` (compartilhado pelo lote Asaas e manual). */
async function bulkTargets(orgId: number, body: { month?: unknown; charge_ids?: unknown; kinds?: unknown; lease_id?: unknown; from?: unknown; to?: unknown }): Promise<{ error: string } | { todo: { id: number; description: string; unit_identifier: string }[] }> {
  const params: unknown[] = [orgId];
  let where = "c.organization_id = $1";
  if (Array.isArray(body.charge_ids)) {
    const ids = [...new Set(body.charge_ids.map(parseId).filter((n): n is number => n !== undefined))];
    if (ids.length === 0) return { error: "charge_ids vazio ou inválido" };
    if (ids.length > 500) return { error: "Máximo de 500 cobranças por pedido" };
    params.push(ids);
    where += ` AND c.id = ANY($${params.length}::int[])`;
  } else if (body.lease_id !== undefined) {
    // Contrato inteiro (carnê): todas as cobranças em aberto do contrato, opcionalmente entre os meses from e to.
    const leaseId = parseId(body.lease_id);
    if (!leaseId) return { error: "lease_id inválido" };
    params.push(leaseId);
    where += ` AND c.lease_id = $${params.length}`;
    if (body.from !== undefined || body.to !== undefined) {
      const a = monthRange(body.from);
      const z = monthRange(body.to);
      if (!a || !z || a.start > z.start) return { error: "from e to devem ser meses (AAAA-MM), from até to" };
      params.push(a.start, z.next);
      where += ` AND c.due_date >= $${params.length - 1} AND c.due_date < $${params.length}`;
    }
  } else {
    const r = monthRange(body.month);
    if (!r) return { error: "Informe month (AAAA-MM), lease_id ou charge_ids" };
    params.push(r.start, r.next);
    where += ` AND c.due_date >= $${params.length - 1} AND c.due_date < $${params.length}`;
  }
  if (Array.isArray(body.kinds) && body.kinds.length > 0) {
    params.push(body.kinds.map(String));
    where += ` AND c.kind = ANY($${params.length}::text[])`;
  }
  const todo = await db.query<{ id: number; description: string; unit_identifier: string }>(
    `SELECT x.id, x.description, x.unit_identifier FROM (${CHARGE_SELECT} WHERE ${where}) x
     WHERE x.status IN ('aberta','parcial','vencida')
       AND NOT EXISTS (SELECT 1 FROM boletos b WHERE b.charge_id = x.id AND b.status IN ('pendente','vencida'))
     ORDER BY x.due_date, x.id`,
    params,
  );
  return { todo };
}

boletosRouter.post("/boletos/bulk", async (req, res) => {
  const orgId = req.auth!.organization.id;
  try {
    const cfg = await configFor(orgId);
    const t = await bulkTargets(orgId, (req.body ?? {}) as Record<string, unknown>);
    if ("error" in t) return void res.status(400).json({ error: t.error });
    const todo = t.todo;
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

/** Manual, individual: registra um boleto emitido fora (linha digitável, nosso número, link) ou só a guia de cobrança do Ethos. */
boletosRouter.post("/boletos/manual", async (req, res) => {
  const chargeId = parseId(req.body?.charge_id);
  if (!chargeId) return void res.status(400).json({ error: "Informe charge_id" });
  const b = req.body as Record<string, unknown>;
  try {
    const item = await issueManual(req.auth!.organization.id, req.auth!.user.id, chargeId, {
      due_date: b.due_date === undefined || b.due_date === null || b.due_date === "" ? undefined : String(b.due_date),
      amount_cents: b.amount_cents === undefined || b.amount_cents === null ? undefined : (b.amount_cents as number),
      identification_field: b.identification_field as string,
      our_number: b.our_number as string,
      url: b.url as string,
      notes: b.notes as string,
    });
    res.status(201).json({ item });
  } catch (err) {
    fail(res, err);
  }
});

/** Manual, em lote: uma guia para cada cobrança em aberto do mês (ou de `charge_ids`) que ainda não tem boleto. */
boletosRouter.post("/boletos/manual/bulk", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const t = await bulkTargets(orgId, (req.body ?? {}) as Record<string, unknown>);
  if ("error" in t) return void res.status(400).json({ error: t.error });
  const batch = t.todo.slice(0, BULK_MAX);
  let created = 0;
  const failed: { charge_id: number; label: string; error: string }[] = [];
  for (const c of batch) {
    try {
      await issueManual(orgId, req.auth!.user.id, c.id);
      created++;
    } catch (err) {
      if (!(err instanceof BoletoError)) throw err;
      failed.push({ charge_id: c.id, label: `${c.description} · ${c.unit_identifier}`, error: err.message });
    }
  }
  res.json({ eligible: t.todo.length, created, failed, remaining: t.todo.length - batch.length, stopped_by: null });
});

async function manualBoleto(orgId: number, rawId: unknown): Promise<{ id: number; status: string; charge_id: number } | undefined> {
  const id = parseId(rawId);
  if (!id) return undefined;
  const [b] = await db.query<{ id: number; status: string; charge_id: number; provider: string }>("SELECT id, status, charge_id, provider FROM boletos WHERE id = $1 AND organization_id = $2", [id, orgId]);
  if (!b) return undefined;
  if (b.provider !== "manual") throw new BoletoError(409, "Este boleto foi emitido pelo Asaas; use a atualização de situação.");
  return b;
}

/** Edita um boleto manual em aberto. */
boletosRouter.patch("/boletos/:id", async (req, res) => {
  const orgId = req.auth!.organization.id;
  try {
    const b = await manualBoleto(orgId, req.params.id);
    if (!b) return void res.status(404).json({ error: "Não encontrado" });
    if (b.status !== "pendente") return void res.status(409).json({ error: "Só é possível editar um boleto manual em aberto." });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const [cur] = await db.query<{ due_date: string; identification_field: string | null; our_number: string | null; bank_slip_url: string | null; notes: string | null }>(
      "SELECT due_date, identification_field, our_number, bank_slip_url, notes FROM boletos WHERE id = $1",
      [b.id],
    );
    const pick = (k: string, now: string | null) => (body[k] === undefined ? now : (body[k] as string));
    const fields = cleanManual({
      identification_field: pick("identification_field", cur!.identification_field),
      our_number: pick("our_number", cur!.our_number),
      url: pick("url", cur!.bank_slip_url),
      notes: pick("notes", cur!.notes),
    });
    const due = body.due_date === undefined ? cur!.due_date : manualDue(cur!.due_date, String(body.due_date));
    await db.query(
      "UPDATE boletos SET due_date = $1, identification_field = $2, our_number = $3, bank_slip_url = $4, notes = $5, updated_at = now() WHERE id = $6",
      [due, fields.identification_field, fields.our_number, fields.url, fields.notes, b.id],
    );
    const [item] = await db.query(`${BOLETO_SELECT} WHERE b.id = $1`, [b.id]);
    res.json({ item });
  } catch (err) {
    fail(res, err);
  }
});

/** Marca um boleto manual como pago (informação da equipe). A baixa da cobrança continua em Pagamentos. */
type Actor = { id: number; name: string; role: string };
interface Settled { code: number; error?: string; item?: unknown; payment?: { id: number; receipt_number: number } | null; payment_error?: string | null }

/** Marca UM boleto manual como pago e, se pedido, registra o pagamento (recibo + baixa). Usado pela baixa individual e pela em lote. */
async function settleManual(orgId: number, actor: Actor, rawId: unknown, opts: { paidAt?: unknown; useDueDate?: boolean; registerPayment?: boolean }): Promise<Settled> {
  const b = await manualBoleto(orgId, rawId);
  if (!b) return { code: 404, error: "Não encontrado" };
  if (b.status === "paga") return { code: 409, error: "Este boleto já está marcado como pago." };
  if (b.status === "cancelada") return { code: 409, error: "Este boleto está cancelado." };
  const today = brToday();
  let paidAt = opts.paidAt === undefined || opts.paidAt === null || opts.paidAt === "" ? today : String(opts.paidAt);
  if (opts.useDueDate) {
    // Cada boleto baixa na própria data de vencimento (nunca no futuro): útil para lançar um mês inteiro já recebido em dia.
    const [row] = await db.query<{ due: string }>("SELECT to_char(due_date, 'YYYY-MM-DD') AS due FROM boletos WHERE id = $1", [b.id]);
    paidAt = row!.due > today ? today : row!.due;
  }
  if (!isRealDate(paidAt) || paidAt > today) return { code: 400, error: "A data do pagamento deve ser uma data válida que não esteja no futuro." };
  await db.query("UPDATE boletos SET status = 'paga', paid_at = $1, updated_at = now() WHERE id = $2", [paidAt, b.id]);
  let payment: { id: number; receipt_number: number } | null = null;
  let paymentError: string | null = null;
  if (opts.registerPayment === true) {
    const [row] = await db.query<{ lease_id: number; left: number; amount_cents: number }>(
      `SELECT x.lease_id, (x.amount_cents - x.paid_cents) AS "left", b.amount_cents
       FROM boletos b JOIN (${CHARGE_SELECT} WHERE c.organization_id = $1) x ON x.id = b.charge_id WHERE b.id = $2`,
      [orgId, b.id],
    );
    const value = row ? Math.min(row.left, row.amount_cents) : 0;
    if (!row || value < 1) paymentError = "A cobrança já está quitada: nenhum pagamento foi registrado.";
    else {
      const out = await recordPayment(orgId, actor.id, {
        leaseId: row.lease_id, receivedAt: paidAt, amountCents: value, method: "boleto", reference: `Boleto #${b.id}`,
        allocations: [{ chargeId: b.charge_id, amount: value }],
      });
      if (out.code === 201) {
        payment = out.payment;
        await db.query("UPDATE boletos SET payment_id = $1 WHERE id = $2", [out.payment.id, b.id]);
      } else paymentError = out.error;
    }
  }
  emitWebhook({
    organizationId: orgId, event: "boleto.paid", actor: { id: actor.id, name: actor.name, role: actor.role },
    entity: "boletos", entityId: b.id, summary: "Boleto marcado como pago", data: { boleto_id: b.id, charge_id: b.charge_id, paid_at: paidAt },
  });
  const [item] = await db.query(`${BOLETO_SELECT} WHERE b.id = $1`, [b.id]);
  return { code: 200, item, payment, payment_error: paymentError };
}

/** Marca um boleto manual como pago (informação da equipe), com a opção de já registrar o pagamento. */
boletosRouter.post("/boletos/:id/paid", async (req, res) => {
  try {
    const r = await settleManual(req.auth!.organization.id, { id: req.auth!.user.id, name: req.auth!.user.name, role: req.auth!.role }, req.params.id, { paidAt: req.body?.paid_at, registerPayment: req.body?.register_payment === true });
    if (r.code !== 200) return void res.status(r.code).json({ error: r.error });
    res.json({ item: r.item, payment: r.payment, payment_error: r.payment_error });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * Baixa em LOTE de boletos manuais em aberto: por `boleto_ids`, por `month` (vencimento) ou por `lease_id` (contrato, com from/to opcionais).
 * `paid_at` único, ou `use_due_date` para cada um baixar no próprio vencimento. `register_payment` emite o recibo e dá a baixa na cobrança.
 * Até 100 por chamada; falha de um não impede os outros.
 */
boletosRouter.post("/boletos/paid-bulk", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const b = (req.body ?? {}) as Record<string, unknown>;
  let ids: number[];
  if (Array.isArray(b.boleto_ids)) {
    ids = [...new Set(b.boleto_ids.map(parseId).filter((n): n is number => n !== undefined))];
    if (ids.length === 0) return void res.status(400).json({ error: "boleto_ids vazio ou inválido" });
  } else {
    const params: unknown[] = [orgId];
    let where = "b.organization_id = $1";
    if (b.lease_id !== undefined) {
      const leaseId = parseId(b.lease_id);
      if (!leaseId) return void res.status(400).json({ error: "lease_id inválido" });
      params.push(leaseId);
      where += ` AND c.lease_id = $${params.length}`;
    }
    if (b.month !== undefined) {
      const r = monthRange(b.month);
      if (!r) return void res.status(400).json({ error: "month deve ser AAAA-MM" });
      params.push(r.start, r.next);
      where += ` AND b.due_date >= $${params.length - 1} AND b.due_date < $${params.length}`;
    }
    if (b.lease_id === undefined && b.month === undefined) return void res.status(400).json({ error: "Informe boleto_ids, month ou lease_id" });
    ids = (await db.query<{ id: number }>(
      `SELECT b.id FROM boletos b JOIN charges c ON c.id = b.charge_id
       WHERE ${where} AND b.provider = 'manual' AND b.status = 'pendente' ORDER BY b.due_date, b.id`,
      params,
    )).map((r) => r.id);
  }
  if (b.dry_run === true) {
    // Só mostra o que seria baixado (para a tela confirmar antes).
    const items = ids.length ? await db.query(`${BOLETO_SELECT} WHERE b.id = ANY($1::int[]) AND b.organization_id = $2 AND b.provider = 'manual' AND b.status IN ('pendente','vencida') ORDER BY b.due_date, b.id`, [ids.slice(0, BULK_MAX), orgId]) : [];
    return void res.json({ eligible: items.length, items, remaining: Math.max(0, ids.length - BULK_MAX) });
  }
  const batch = ids.slice(0, BULK_MAX);
  const actor = { id: req.auth!.user.id, name: req.auth!.user.name, role: req.auth!.role };
  let paid = 0;
  let payments = 0;
  const failed: { boleto_id: number; error: string }[] = [];
  const notes: { boleto_id: number; note: string }[] = [];
  for (const id of batch) {
    try {
      const r = await settleManual(orgId, actor, id, { paidAt: b.paid_at, useDueDate: b.use_due_date === true, registerPayment: b.register_payment === true });
      if (r.code !== 200) { failed.push({ boleto_id: id, error: r.error ?? "erro" }); continue; }
      paid++;
      if (r.payment) payments++;
      if (r.payment_error) notes.push({ boleto_id: id, note: r.payment_error });
    } catch (err) {
      if (!(err instanceof BoletoError)) throw err;
      failed.push({ boleto_id: id, error: err.message });
    }
  }
  res.json({ eligible: ids.length, paid, payments, failed, notes, remaining: ids.length - batch.length });
});

/**
 * Carnê do contrato: gera de uma vez os aluguéis dos meses de `from` a `to` (se `generate_charges` não for false) e um boleto
 * manual para cada cobrança em aberto desse contrato nesse período. Idempotente: não duplica cobrança nem boleto.
 */
export const carneRouter = Router();
carneRouter.post("/leases/:id/carne", requireAuth, requireRole("admin", "colaborador"), async (req, res) => {
  const orgId = req.auth!.organization.id;
  const leaseId = parseId(req.params.id);
  const a = monthRange(req.body?.from);
  const z = monthRange(req.body?.to);
  if (!leaseId || !a || !z || a.start > z.start) return void res.status(400).json({ error: "Informe from e to (AAAA-MM), do primeiro ao último mês do carnê." });
  const months: string[] = [];
  for (let y = Number(a.start.slice(0, 4)), m = Number(a.start.slice(5, 7)); ; ) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    months.push(key);
    if (key >= String(req.body.to) || months.length > 36) break;
    m++;
    if (m > 12) { m = 1; y++; }
  }
  if (months.length > 36) return void res.status(400).json({ error: "O carnê vai até 36 meses por vez." });
  const [lease] = await db.query<{ status: string }>("SELECT status FROM leases WHERE id = $1 AND organization_id = $2", [leaseId, orgId]);
  if (!lease) return void res.status(404).json({ error: "Contrato não encontrado." });
  if (lease.status !== "vigente") return void res.status(409).json({ error: "O carnê só é gerado para contrato vigente." });
  let chargesCreated = 0;
  if (req.body?.generate_charges !== false) {
    for (const m of months) chargesCreated += (await generateRent(orgId, req.auth!.user.id, m, leaseId))?.created ?? 0;
  }
  const t = await bulkTargets(orgId, { lease_id: leaseId, from: req.body.from, to: req.body.to });
  if ("error" in t) return void res.status(400).json({ error: t.error });
  let created = 0;
  const failed: { charge_id: number; label: string; error: string }[] = [];
  for (const c of t.todo.slice(0, BULK_MAX)) {
    try {
      await issueManual(orgId, req.auth!.user.id, c.id);
      created++;
    } catch (err) {
      if (!(err instanceof BoletoError)) throw err;
      failed.push({ charge_id: c.id, label: c.description, error: err.message });
    }
  }
  res.json({ months: months.length, charges_created: chargesCreated, boletos_created: created, failed, remaining: Math.max(0, t.todo.length - BULK_MAX) });
});

const resendLimiter = new SharedRateLimiter("boleto-resend", 5, 60 * 60 * 1000);

/** Texto da segunda via (e-mail, aviso e tela do inquilino). */
export function boletoText(b: { description: string; amount_cents: number; due_date: string; identification_field: string | null; bank_slip_url: string | null; invoice_url: string | null; our_number: string | null; provider: string }) {
  const due = String(b.due_date).slice(0, 10).split("-").reverse().join("/");
  return [
    `${b.description}`,
    `Valor: ${formatBRL(b.amount_cents)} · Vencimento: ${due}`,
    b.identification_field ? `Linha digitável: ${b.identification_field}` : null,
    b.our_number ? `Nosso número: ${b.our_number}` : null,
    b.bank_slip_url || b.invoice_url ? `Boleto: ${b.bank_slip_url ?? b.invoice_url}` : null,
    !b.identification_field && !b.bank_slip_url && !b.invoice_url && b.provider === "manual" ? "Guia de cobrança da administradora (peça os dados de pagamento a ela)." : null,
  ].filter(Boolean).join("\n");
}

/** Reenvia a segunda via do boleto em aberto ao(s) locatário(s): sino/e-mail/push dos que têm acesso e e-mail do cadastro dos demais. */
boletosRouter.post("/boletos/:id/resend", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const id = parseId(req.params.id);
  const [b] = id ? await db.query<any>(`${BOLETO_SELECT} WHERE b.id = $1 AND b.organization_id = $2`, [id, orgId]) : [];
  if (!b) return void res.status(404).json({ error: "Não encontrado" });
  if (!["pendente", "vencida"].includes(b.status)) return void res.status(409).json({ error: "Só boletos em aberto podem ser reenviados." });
  if (!(await resendLimiter.allow(`b:${b.id}`))) return void res.status(429).json({ error: "Este boleto já foi reenviado várias vezes. Tente mais tarde." });
  const [ch] = await db.query<{ lease_id: number }>("SELECT lease_id FROM charges WHERE id = $1", [b.charge_id]);
  const users = await tenantUsersOfLease(ch!.lease_id);
  const text = boletoText(b);
  await notify(orgId, users, { category: "financeiro", kind: "boleto_resend", title: "Segunda via do boleto", body: text.slice(0, 480), linkKind: "charge", linkId: b.charge_id });
  // Locatários SEM acesso ao app recebem direto no e-mail do cadastro.
  const emails = await db.query<{ email: string }>(
    `SELECT DISTINCT lower(t.email) AS email FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id
     WHERE lt.lease_id = $1 AND t.email IS NOT NULL AND t.email <> ''
       AND lower(t.email) NOT IN (SELECT lower(u.email) FROM users u WHERE u.id = ANY($2::int[]))`,
    [ch!.lease_id, users],
  );
  let direct = 0;
  for (const e of emails) {
    if (await sendEmail({ to: e.email, subject: "Segunda via do boleto", text: `${text}\n\nDúvidas? Fale com a sua administradora. ${appUrl()}` })) direct++;
  }
  res.json({ notified_users: users.length, direct_emails: direct });
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
    if (b.external_id.startsWith("manual:")) return void res.status(409).json({ error: "Boleto manual não é atualizado automaticamente. Marque como pago quando receber." });
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
    const [b] = id ? await db.query<{ id: number; external_id: string; status: string }>("SELECT id, external_id, status FROM boletos WHERE id = $1 AND organization_id = $2", [id, orgId]) : [];
    if (!b) return void res.status(404).json({ error: "Não encontrado" });
    if (b.external_id.startsWith("manual:")) {
      if (b.status === "paga") return void res.status(409).json({ error: "Este boleto já foi pago e não pode ser cancelado." });
      if (b.status === "cancelada") return void res.status(409).json({ error: "Este boleto já está cancelado." });
      await db.query("UPDATE boletos SET status = 'cancelada', updated_at = now() WHERE id = $1", [b.id]);
      return void res.status(204).end();
    }
    const cfg = await configFor(orgId);
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

/** Inquilino: boletos em aberto dos próprios contratos, com os dados para pagar ou imprimir a segunda via. */
export const tenantBoletosRouter = Router();
tenantBoletosRouter.get("/portal/tenant/boletos", requireAuth, async (req, res) => {
  const a = req.auth!;
  if (a.role !== "inquilino") return void res.status(403).json({ error: "Sem permissão" });
  if (!a.tenantId) return void res.status(409).json({ error: "Seu acesso ainda não está vinculado a um cadastro de inquilino." });
  const items = await db.query(
    `${BOLETO_SELECT} WHERE b.organization_id = $1 AND b.status IN ('pendente','vencida')
       AND c.lease_id IN (SELECT lease_id FROM lease_tenants WHERE tenant_id = $2) ORDER BY b.due_date`,
    [a.organization.id, a.tenantId],
  );
  res.json({
    items: (items as any[]).map((b) => ({
      id: b.id, description: b.description, amount_cents: b.amount_cents, due_date: b.due_date, status: b.status, provider: b.provider,
      identification_field: b.identification_field, our_number: b.our_number, url: b.bank_slip_url ?? b.invoice_url, text: boletoText(b),
    })),
  });
});
