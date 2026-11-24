import { Router } from "express";
import { db, transaction, isUniqueViolation } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";
import { isRealDate, parseId } from "./crud.js";
import { formatBRL, formatDate, joinNames } from "./contractTemplate.js";
import { notify, tenantUsersOfLease } from "./notifications.js";
import { PAGE_ERROR, pageInfo, pageParams } from "./paginate.js";

export const financeRouter = Router();
financeRouter.use(
  ["/charges", "/payments", "/transfers", "/finance", "/settings"],
  requireAuth,
  requireRole("admin", "colaborador"),
);

const INT4_MAX = 2_147_483_647;
const KINDS = ["aluguel", "multa", "juros", "taxa", "outro"] as const;
const METHODS = ["pix", "boleto", "dinheiro", "transferencia", "cartao", "outro"] as const;

// ------------------------------------------------------------------- SQL base

/** "Hoje" no fuso de Brasília (o banco roda em UTC). */
const TODAY = "(now() AT TIME ZONE 'America/Sao_Paulo')::date";

/** Quanto já foi baixado na cobrança `c` por pagamentos não estornados. */
const PAID = `(SELECT COALESCE(sum(pa.amount_cents), 0)::int FROM payment_allocations pa
               JOIN payments p ON p.id = pa.payment_id
               WHERE pa.charge_id = c.id AND p.voided_at IS NULL)`;

/** Status derivado — nunca é gravado. */
const STATUS = `CASE
  WHEN c.cancelled_at IS NOT NULL THEN 'cancelada'
  WHEN ${PAID} >= c.amount_cents THEN 'paga'
  WHEN c.due_date < ${TODAY} THEN 'vencida'
  WHEN ${PAID} > 0 THEN 'parcial'
  ELSE 'aberta' END`;

const TENANT_NAMES = `(SELECT string_agg(t.name, ', ' ORDER BY lt.position)
                       FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id WHERE lt.lease_id = c.lease_id)`;

// --------------------------------------------------------------- Datas (mês)

/** "2026-11" → limites do mês; undefined se inválido. */
export function monthRange(month: unknown): { start: string; next: string; days: number } | undefined {
  if (typeof month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return undefined;
  const [y, m] = month.split("-").map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { start: `${month}-01`, next, days: new Date(Date.UTC(y, m, 0)).getUTCDate() };
}

export const brToday = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date());

// ------------------------------------------------------------------ Cobranças

interface ChargeRow {
  id: number;
  lease_id: number;
  kind: string;
  description: string;
  competence: string;
  due_date: string;
  amount_cents: number;
  paid_cents: number;
  status: string;
}

export const CHARGE_SELECT = `
  SELECT c.id, c.lease_id, c.kind, c.description, c.competence, c.due_date, c.amount_cents, c.cancelled_at,
         ${PAID} AS paid_cents, ${STATUS} AS status,
         u.identifier AS unit_identifier, pr.name AS property_name, ${TENANT_NAMES} AS tenant_names
  FROM charges c
  JOIN leases l ON l.id = c.lease_id
  JOIN units u ON u.id = l.unit_id
  JOIN properties pr ON pr.id = u.property_id`;

financeRouter.get("/charges", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const params: unknown[] = [orgId];
  let where = "c.organization_id = $1";
  if (req.query.month !== undefined) {
    const r = monthRange(req.query.month);
    if (!r) {
      res.status(400).json({ error: "month deve ser AAAA-MM" });
      return;
    }
    params.push(r.start, r.next);
    where += ` AND c.due_date >= $2 AND c.due_date < $3`;
  }
  const leaseId = req.query.lease_id === undefined ? undefined : parseId(req.query.lease_id);
  if (req.query.lease_id !== undefined) {
    if (!leaseId) {
      res.status(400).json({ error: "lease_id inválido" });
      return;
    }
    params.push(leaseId);
    where += ` AND c.lease_id = $${params.length}`;
  }
  let outer = "";
  if (req.query.status !== undefined) {
    if (!["aberta", "parcial", "vencida", "paga", "cancelada"].includes(String(req.query.status))) {
      res.status(400).json({ error: "status inválido" });
      return;
    }
    params.push(req.query.status);
    outer = ` WHERE x.status = $${params.length}`;
  }
  const pg = pageParams(req.query);
  if (pg === "invalid") return void res.status(400).json({ error: PAGE_ERROR });
  const base = `SELECT x.* FROM (${CHARGE_SELECT} WHERE ${where}) x${outer} ORDER BY x.due_date, x.id`;
  if (!pg) return void res.json({ items: await db.query(base, params) });
  const [count] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM (SELECT x.id FROM (${CHARGE_SELECT} WHERE ${where}) x${outer}) y`, params);
  res.json({ items: await db.query(`${base} LIMIT ${pg.perPage} OFFSET ${pg.offset}`, params), ...pageInfo(pg, count!.n) });
});

/** Gera o aluguel do mês para todos os contratos vigentes no período (idempotente). */
/** Gera o aluguel do mês (opcionalmente de um só contrato). Idempotente. Devolve null se o mês é inválido. */
export async function generateRent(orgId: number, userId: number, month: unknown, leaseId?: number): Promise<{ eligible: number; created: number; skipped: number } | null> {
  const range = monthRange(month);
  if (!range) return null;
  const leases = await db.query<{ id: number; rent_cents: number; due_day: number; start_date: string; end_date: string }>(
    `SELECT id, rent_cents, due_day, to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date FROM leases
     WHERE organization_id = $1 AND status = 'vigente' AND start_date < $3 AND end_date >= $2 AND ($4::int IS NULL OR id = $4)`,
    [orgId, range.start, range.next, leaseId ?? null],
  );
  const [cfg] = await db.query<{ prorata_enabled: boolean }>("SELECT prorata_enabled FROM organizations WHERE id = $1", [orgId]);
  const label = `${range.start.slice(5, 7)}/${range.start.slice(0, 4)}`;
  let created = 0;
  await transaction(async (tx) => {
    for (const l of leases) {
      const day = Math.min(l.due_day, range.days);
      const due = `${range.start.slice(0, 8)}${String(day).padStart(2, "0")}`;
      // Pro rata (opcional): primeiro mês (contrato começa depois do dia 1) e último (termina antes do fim do mês).
      let amount = l.rent_cents;
      let description = `Aluguel ${label}`;
      if (cfg?.prorata_enabled) {
        const first = l.start_date > range.start ? Number(l.start_date.slice(8, 10)) : 1;
        const lastDay = l.end_date < range.next && l.end_date >= range.start ? Number(l.end_date.slice(8, 10)) : range.days;
        const used = Math.min(lastDay, range.days) - first + 1;
        if (used > 0 && used < range.days) {
          amount = Math.max(1, Math.round((l.rent_cents * used) / range.days));
          description = `Aluguel ${label} (proporcional: ${used}/${range.days} dias)`;
        }
      }
      const r = await tx.query(
        `INSERT INTO charges (organization_id, lease_id, kind, description, competence, due_date, amount_cents, created_by)
         VALUES ($1, $2, 'aluguel', $3, $4, $5, $6, $7)
         ON CONFLICT (lease_id, competence) WHERE kind = 'aluguel' AND cancelled_at IS NULL DO NOTHING
         RETURNING id`,
        [orgId, l.id, description, range.start, due, amount, userId],
      );
      created += r.length;
    }
  });
  return { eligible: leases.length, created, skipped: leases.length - created };
}

financeRouter.post("/charges/generate", async (req, res) => {
  const out = await generateRent(req.auth!.organization.id, req.auth!.user.id, req.body?.month);
  if (!out) {
    res.status(400).json({ error: "month deve ser AAAA-MM" });
    return;
  }
  res.json({ month: req.body.month, ...out });
});

/** Cobrança avulsa (multa, juros, taxa…). */
financeRouter.post("/charges", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const { kind, description, due_date, amount_cents } = req.body ?? {};
  const leaseId = parseId(req.body?.lease_id);
  if (!leaseId) {
    res.status(400).json({ error: "lease_id inválido" });
    return;
  }
  if (!KINDS.includes(kind)) {
    res.status(400).json({ error: "kind inválido" });
    return;
  }
  if (typeof description !== "string" || !description.trim() || description.length > 300) {
    res.status(400).json({ error: "Informe a descrição (até 300 caracteres)" });
    return;
  }
  if (typeof due_date !== "string" || !isRealDate(due_date)) {
    res.status(400).json({ error: "due_date inválida (AAAA-MM-DD)" });
    return;
  }
  if (!Number.isInteger(amount_cents) || amount_cents < 1 || amount_cents > INT4_MAX) {
    res.status(400).json({ error: "amount_cents deve ser um inteiro positivo (centavos)" });
    return;
  }
  const [lease] = await db.query<{ status: string }>("SELECT status FROM leases WHERE id = $1 AND organization_id = $2", [
    leaseId,
    orgId,
  ]);
  if (!lease) {
    res.status(400).json({ error: "Contrato inexistente" });
    return;
  }
  if (lease.status === "rascunho") {
    res.status(409).json({ error: "Contrato em rascunho não gera cobranças" });
    return;
  }
  try {
    const [row] = await db.query<{ id: number }>(
      `INSERT INTO charges (organization_id, lease_id, kind, description, competence, due_date, amount_cents, created_by)
       VALUES ($1, $2, $3, $4, date_trunc('month', $5::date)::date, $5::date, $6, $7) RETURNING id`,
      [orgId, leaseId, kind, description.trim(), due_date, amount_cents, req.auth!.user.id],
    );
    const [item] = await db.query(`${CHARGE_SELECT} WHERE c.id = $1`, [row!.id]);
    res.status(201).json({ item });
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: "Já existe aluguel para este contrato nesta competência" });
      return;
    }
    throw err;
  }
});

financeRouter.post("/charges/:id/cancel", requireRole("admin"), async (req, res) => {
  const orgId = req.auth!.organization.id;
  const id = parseId(req.params.id);
  const outcome = await transaction(async (tx) => {
    const [charge] = id
      ? await tx.query<{ cancelled_at: string | null }>(
          "SELECT cancelled_at FROM charges WHERE id = $1 AND organization_id = $2 FOR UPDATE",
          [id, orgId],
        )
      : [];
    if (!charge) return { code: 404, error: "Não encontrado" };
    if (charge.cancelled_at) return { code: 409, error: "Cobrança já cancelada" };
    const [paid] = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
       WHERE pa.charge_id = $1 AND p.voided_at IS NULL`,
      [id],
    );
    if (paid!.n > 0) return { code: 409, error: "A cobrança tem pagamentos; estorne-os antes de cancelar" };
    await tx.query("UPDATE charges SET cancelled_at = now() WHERE id = $1", [id]);
    return { code: 200 };
  });
  if (outcome.code !== 200) {
    res.status(outcome.code).json({ error: outcome.error });
    return;
  }
  res.status(204).end();
});

// ----------------------------------------------------------------- Pagamentos

function buildReceipt(p: {
  number: number;
  orgName: string;
  payers: string[];
  amountCents: number;
  receivedAt: string;
  method: string;
  reference: string | null;
  property: string;
  unit: string;
  lines: { description: string; amount: number }[];
}): string {
  const lines = p.lines.map((l) => `  • ${l.description}: ${formatBRL(l.amount)}`).join("\n");
  return [
    `RECIBO Nº ${p.number}`,
    "",
    `Recebemos de ${joinNames(p.payers)} a quantia de ${formatBRL(p.amountCents)}, em ${formatDate(p.receivedAt)}, ` +
      `via ${p.method}${p.reference ? ` (ref.: ${p.reference})` : ""}, referente ao imóvel ${p.property}, unidade ${p.unit}:`,
    "",
    lines,
    "",
    `Pelo que damos plena quitação dos valores acima discriminados.`,
    "",
    p.orgName,
  ].join("\n");
}

financeRouter.get("/payments", async (req, res) => {
  const params: unknown[] = [req.auth!.organization.id];
  let where = "p.organization_id = $1";
  if (req.query.month !== undefined) {
    const r = monthRange(req.query.month);
    if (!r) {
      res.status(400).json({ error: "month deve ser AAAA-MM" });
      return;
    }
    params.push(r.start, r.next);
    where += " AND p.received_at >= $2 AND p.received_at < $3";
  }
  const pg = pageParams(req.query);
  if (pg === "invalid") return void res.status(400).json({ error: PAGE_ERROR });
  const paymentRows = (limit: string) => db.query(
    `SELECT p.id, p.lease_id, p.received_at, p.amount_cents, p.method, p.reference, p.receipt_number,
            p.voided_at, p.void_reason, p.created_at,
            u.identifier AS unit_identifier, pr.name AS property_name,
            (SELECT string_agg(t.name, ', ' ORDER BY lt.position)
               FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id WHERE lt.lease_id = p.lease_id) AS tenant_names
     FROM payments p
     JOIN leases l ON l.id = p.lease_id
     JOIN units u ON u.id = l.unit_id
     JOIN properties pr ON pr.id = u.property_id
     WHERE ${where} ORDER BY p.received_at DESC, p.id DESC${limit}`,
    params,
  );
  if (!pg) return void res.json({ items: await paymentRows("") });
  const [count] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM payments p WHERE ${where}`, params);
  res.json({ items: await paymentRows(` LIMIT ${pg.perPage} OFFSET ${pg.offset}`), ...pageInfo(pg, count!.n) });
});

financeRouter.get("/payments/:id", async (req, res) => {
  const id = parseId(req.params.id);
  const [payment] = id
    ? await db.query(
        `SELECT id, lease_id, received_at, amount_cents, method, reference, receipt_number, receipt_content,
                voided_at, void_reason, created_at
         FROM payments WHERE id = $1 AND organization_id = $2`,
        [id, req.auth!.organization.id],
      )
    : [];
  if (!payment) {
    res.status(404).json({ error: "Não encontrado" });
    return;
  }
  const allocations = await db.query(
    `SELECT pa.charge_id, pa.amount_cents, c.description, c.due_date
     FROM payment_allocations pa JOIN charges c ON c.id = pa.charge_id
     WHERE pa.payment_id = $1 ORDER BY c.due_date, c.id`,
    [id],
  );
  res.json({ payment, allocations });
});

/**
 * Registra um pagamento e dá baixa nas cobranças indicadas (tudo em uma transação).
 * O total das baixas deve ser igual ao valor recebido: não há saldo "solto".
 */
export interface PaymentInput {
  leaseId: number;
  receivedAt: string;
  amountCents: number;
  method: (typeof METHODS)[number];
  reference: string | null;
  allocations: { chargeId: number; amount: number }[];
}
export type PaymentOutcome = { code: 201; payment: { id: number; receipt_number: number } } | { code: 400 | 409; error: string };

/**
 * Registra um pagamento com baixas e recibo numerado, numa transação (usada pela tela de Pagamentos, pelo boleto marcado
 * como pago e pela conciliação bancária). As validações de valor e de data ficam em quem chama.
 */
export async function recordPayment(orgId: number, userId: number | null, p: PaymentInput): Promise<PaymentOutcome> {
  const { leaseId, receivedAt, amountCents, method, reference, allocations: parsed } = p;
  return transaction(async (tx) => {
    const [lease] = await tx.query<{ unit_id: number }>("SELECT unit_id FROM leases WHERE id = $1 AND organization_id = $2", [
      leaseId,
      orgId,
    ]);
    if (!lease) return { code: 400, error: "Contrato inexistente" };

    // Trava as cobranças para que dois pagamentos simultâneos não estourem o saldo.
    const chargeIds = parsed.map((p) => p.chargeId);
    const charges = await tx.query<{ id: number; lease_id: number; amount_cents: number; cancelled_at: string | null; description: string }>(
      `SELECT id, lease_id, amount_cents, cancelled_at, description FROM charges
       WHERE organization_id = $1 AND id = ANY($2::int[]) ORDER BY id FOR UPDATE`,
      [orgId, chargeIds],
    );
    if (charges.length !== chargeIds.length) return { code: 400, error: "Cobrança inexistente" };
    for (const c of charges) {
      if (c.lease_id !== leaseId) return { code: 400, error: "As cobranças devem ser do mesmo contrato do pagamento" };
      if (c.cancelled_at) return { code: 409, error: `Cobrança cancelada: ${c.description}` };
    }
    const lines: { description: string; amount: number }[] = [];
    for (const a of parsed) {
      const c = charges.find((x) => x.id === a.chargeId)!;
      const [paid] = await tx.query<{ n: number }>(
        `SELECT COALESCE(sum(pa.amount_cents), 0)::int AS n FROM payment_allocations pa
         JOIN payments p ON p.id = pa.payment_id WHERE pa.charge_id = $1 AND p.voided_at IS NULL`,
        [a.chargeId],
      );
      const open = c.amount_cents - paid!.n;
      if (a.amount > open) {
        return { code: 409, error: `Valor excede o saldo em aberto de "${c.description}" (${formatBRL(open)})` };
      }
      lines.push({ description: c.description, amount: a.amount });
    }

    // Numeração sequencial do recibo por organização, serializada pela trava na organização.
    const [org] = await tx.query<{ name: string }>("SELECT name FROM organizations WHERE id = $1 FOR UPDATE", [orgId]);
    const [next] = await tx.query<{ n: number }>(
      "SELECT COALESCE(max(receipt_number), 0)::int + 1 AS n FROM payments WHERE organization_id = $1",
      [orgId],
    );
    const [ctx] = await tx.query<{ property: string; unit: string }>(
      `SELECT pr.name AS property, u.identifier AS unit FROM units u JOIN properties pr ON pr.id = u.property_id WHERE u.id = $1`,
      [lease.unit_id],
    );
    const payers = await tx.query<{ name: string }>(
      `SELECT t.name FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id WHERE lt.lease_id = $1 ORDER BY lt.position`,
      [leaseId],
    );
    const receipt = buildReceipt({
      number: next!.n,
      orgName: org!.name,
      payers: payers.map((p) => p.name),
      amountCents: amountCents,
      receivedAt: receivedAt,
      method,
      reference: reference ?? null,
      property: ctx!.property,
      unit: ctx!.unit,
      lines,
    });
    const [payment] = await tx.query<{ id: number; receipt_number: number }>(
      `INSERT INTO payments (organization_id, lease_id, received_at, amount_cents, method, reference,
                             receipt_number, receipt_content, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, receipt_number`,
      [orgId, leaseId, receivedAt, amountCents, method, reference ?? null, next!.n, receipt, userId],
    );
    for (const a of parsed) {
      await tx.query("INSERT INTO payment_allocations (payment_id, charge_id, amount_cents) VALUES ($1, $2, $3)", [
        payment!.id,
        a.chargeId,
        a.amount,
      ]);
    }
    return { code: 201, payment: payment! };
  }) as Promise<PaymentOutcome>;
}

financeRouter.post("/payments", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const { received_at, amount_cents, method, reference, allocations } = req.body ?? {};
  const leaseId = parseId(req.body?.lease_id);
  if (!leaseId) {
    res.status(400).json({ error: "lease_id inválido" });
    return;
  }
  if (typeof received_at !== "string" || !isRealDate(received_at) || received_at > brToday()) {
    res.status(400).json({ error: "received_at inválida (AAAA-MM-DD, não pode ser futura)" });
    return;
  }
  if (!Number.isInteger(amount_cents) || amount_cents < 1 || amount_cents > INT4_MAX) {
    res.status(400).json({ error: "amount_cents deve ser um inteiro positivo (centavos)" });
    return;
  }
  if (!METHODS.includes(method)) {
    res.status(400).json({ error: "method inválido" });
    return;
  }
  if (reference !== undefined && reference !== null && (typeof reference !== "string" || reference.length > 200)) {
    res.status(400).json({ error: "reference inválida" });
    return;
  }
  if (!Array.isArray(allocations) || allocations.length === 0 || allocations.length > 100) {
    res.status(400).json({ error: "Informe as cobranças a baixar (allocations)" });
    return;
  }
  const parsed: { chargeId: number; amount: number }[] = [];
  for (const a of allocations) {
    const chargeId = parseId(a?.charge_id);
    if (!chargeId || !Number.isInteger(a?.amount_cents) || a.amount_cents < 1) {
      res.status(400).json({ error: "Baixa inválida: informe charge_id e amount_cents positivo" });
      return;
    }
    if (parsed.some((p) => p.chargeId === chargeId)) {
      res.status(400).json({ error: "Cobrança repetida nas baixas" });
      return;
    }
    parsed.push({ chargeId, amount: a.amount_cents });
  }
  if (parsed.reduce((s, a) => s + a.amount, 0) !== amount_cents) {
    res.status(400).json({ error: "A soma das baixas deve ser igual ao valor do pagamento" });
    return;
  }

  const outcome = await recordPayment(orgId, req.auth!.user.id, {
    leaseId: leaseId!,
    receivedAt: received_at,
    amountCents: amount_cents,
    method,
    reference: reference ?? null,
    allocations: parsed,
  });
  if (outcome.code !== 201) {
    res.status(outcome.code).json({ error: outcome.error });
    return;
  }
  const created = outcome.payment;
  await notify(orgId, await tenantUsersOfLease(leaseId!), {
    category: "financeiro",
    kind: "payment_received",
    title: "Pagamento identificado",
    body: `${formatBRL(amount_cents)} · recibo nº ${created.receipt_number}`,
    linkKind: "payment",
    linkId: created.id,
  });
  res.status(201).json({ payment: created });
});

/** Estorno: o pagamento é marcado como anulado (histórico preservado) e as cobranças voltam a ficar em aberto. */
financeRouter.post("/payments/:id/void", requireRole("admin"), async (req, res) => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!reason || reason.length > 300) {
    res.status(400).json({ error: "Informe o motivo do estorno (até 300 caracteres)" });
    return;
  }
  const id = parseId(req.params.id);
  const done = id
    ? await db.query<{ id: number; lease_id: number; amount_cents: number; receipt_number: number }>(
        `UPDATE payments SET voided_at = now(), void_reason = $1
         WHERE id = $2 AND organization_id = $3 AND voided_at IS NULL RETURNING id, lease_id, amount_cents, receipt_number`,
        [reason, id, req.auth!.organization.id],
      )
    : [];
  if (done.length === 0) {
    res.status(404).json({ error: "Pagamento não encontrado ou já estornado" });
    return;
  }
  const p = done[0]!;
  await notify(req.auth!.organization.id, await tenantUsersOfLease(p.lease_id), {
    category: "financeiro",
    kind: "payment_voided",
    title: "Pagamento estornado",
    body: `Recibo nº ${p.receipt_number} (${formatBRL(p.amount_cents)}) foi estornado: ${reason}`,
    linkKind: "payment",
    linkId: p.id,
  });
  res.status(204).end();
});

// ------------------------------------------------------------------- Repasses

financeRouter.get("/transfers", async (req, res) => {
  const params: unknown[] = [req.auth!.organization.id];
  let where = "t.organization_id = $1";
  if (req.query.period !== undefined) {
    const r = monthRange(req.query.period);
    if (!r) {
      res.status(400).json({ error: "period deve ser AAAA-MM" });
      return;
    }
    params.push(r.start);
    where += " AND t.period = $2";
  }
  const items = await db.query(
    `SELECT t.id, t.owner_id, o.name AS owner_name, t.period, t.gross_cents, t.fee_cents, t.net_cents,
            t.fee_bps, t.maintenance_cents, t.status, t.paid_at, t.generated_at
     FROM owner_transfers t JOIN owners o ON o.id = t.owner_id
     WHERE ${where} ORDER BY t.period DESC, o.name`,
    params,
  );
  res.json({ items });
});

/**
 * Calcula os repasses do mês: aluguéis RECEBIDOS (baixas de pagamentos não estornados, com data de
 * recebimento no mês) divididos em partes iguais entre os proprietários do imóvel, menos a taxa de
 * administração. Repasses já pagos não são recalculados; os pendentes são refeitos.
 */
financeRouter.post("/transfers/generate", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const range = monthRange(req.body?.period);
  if (!range) {
    res.status(400).json({ error: "period deve ser AAAA-MM" });
    return;
  }
  const result = await transaction(async (tx) => {
    const [org] = await tx.query<{ admin_fee_bps: number }>("SELECT admin_fee_bps FROM organizations WHERE id = $1 FOR UPDATE", [orgId]);
    const feeBps = org!.admin_fee_bps;

    const rows = await tx.query<{ property_id: number; amount_cents: number }>(
      `SELECT u.property_id, pa.amount_cents
       FROM payment_allocations pa
       JOIN payments p ON p.id = pa.payment_id
       JOIN charges c ON c.id = pa.charge_id
       JOIN leases l ON l.id = c.lease_id
       JOIN units u ON u.id = l.unit_id
       WHERE p.organization_id = $1 AND p.voided_at IS NULL AND c.cancelled_at IS NULL
         AND c.kind = 'aluguel' AND p.received_at >= $2 AND p.received_at < $3
       ORDER BY pa.payment_id, pa.charge_id`,
      [orgId, range.start, range.next],
    );
    const ownerRows = await tx.query<{ property_id: number; owner_id: number }>(
      `SELECT po.property_id, po.owner_id FROM property_owners po
       JOIN properties p ON p.id = po.property_id
       WHERE p.organization_id = $1 ORDER BY po.property_id, po.owner_id`,
      [orgId],
    );
    const ownersOf = new Map<number, number[]>();
    for (const r of ownerRows) ownersOf.set(r.property_id, [...(ownersOf.get(r.property_id) ?? []), r.owner_id]);

    const gross = new Map<number, number>();
    let withoutOwner = 0;
    for (const r of rows) {
      const owners = ownersOf.get(r.property_id);
      if (!owners || owners.length === 0) {
        withoutOwner += r.amount_cents;
        continue;
      }
      // Divisão em partes iguais; os centavos que sobram vão para os primeiros proprietários.
      const share = Math.floor(r.amount_cents / owners.length);
      let rest = r.amount_cents - share * owners.length;
      for (const ownerId of owners) {
        const extra = rest > 0 ? 1 : 0;
        rest -= extra;
        gross.set(ownerId, (gross.get(ownerId) ?? 0) + share + extra);
      }
    }

    const existing = await tx.query<{ owner_id: number; status: string }>(
      "SELECT owner_id, status FROM owner_transfers WHERE organization_id = $1 AND period = $2",
      [orgId, range.start],
    );
    const paidOwners = new Set(existing.filter((e) => e.status === "pago").map((e) => e.owner_id));

    // Custos de manutenção cobrados do proprietário: entram como desconto no repasse deste mês, em partes iguais,
    // desde que caibam no líquido de TODOS os donos do imóvel (o que não couber fica para o mês seguinte).
    const feeOf = (g: number) => Math.round((g * feeBps) / 10000);
    const paidProps = [...ownersOf].filter(([, owners]) => owners.some((o) => paidOwners.has(o))).map(([p]) => p);
    await tx.query(
      `UPDATE maintenance_requests SET owner_deduct_period = NULL
       WHERE organization_id = $1 AND owner_deduct_period = $2 AND unit_id IN (SELECT id FROM units WHERE property_id <> ALL($3::int[]))`,
      [orgId, range.start, paidProps],
    );
    const maint = await tx.query<{ id: number; property_id: number; cost_cents: number }>(
      `SELECT m.id, u.property_id, m.cost_cents FROM maintenance_requests m JOIN units u ON u.id = m.unit_id
       WHERE m.organization_id = $1 AND m.status = 'concluida' AND m.charge_owner AND m.cost_cents > 0
         AND m.completed_at < $2::date AND m.owner_deduct_period IS NULL
       ORDER BY m.completed_at, m.id`,
      [orgId, range.next],
    );
    const maintOf = new Map<number, number>();
    const assigned: number[] = [];
    // Itens já atribuídos a este mês em imóveis com algum repasse PAGO continuam valendo para os donos que ainda estão pendentes.
    const kept = await tx.query<{ property_id: number; cost_cents: number }>(
      `SELECT u.property_id, m.cost_cents FROM maintenance_requests m JOIN units u ON u.id = m.unit_id
       WHERE m.organization_id = $1 AND m.owner_deduct_period = $2::date ORDER BY m.id`,
      [orgId, range.start],
    );
    for (const k of kept) {
      const owners = ownersOf.get(k.property_id) ?? [];
      const share = owners.length ? Math.floor(k.cost_cents / owners.length) : 0;
      let rest = owners.length ? k.cost_cents - share * owners.length : 0;
      for (const o of owners) {
        const extra = rest > 0 ? 1 : 0;
        rest -= extra;
        if (!paidOwners.has(o)) maintOf.set(o, (maintOf.get(o) ?? 0) + share + extra);
      }
    }
    for (const m of maint) {
      const owners = ownersOf.get(m.property_id);
      if (!owners || owners.length === 0 || owners.some((o) => paidOwners.has(o))) continue;
      const share = Math.floor(m.cost_cents / owners.length);
      let rest = m.cost_cents - share * owners.length;
      const parts = owners.map((o) => {
        const extra = rest > 0 ? 1 : 0;
        rest -= extra;
        return { o, v: share + extra };
      });
      const fits = parts.every(({ o, v }) => {
        const g = gross.get(o) ?? 0;
        return g - feeOf(g) - (maintOf.get(o) ?? 0) >= v;
      });
      if (!fits) continue;
      for (const { o, v } of parts) maintOf.set(o, (maintOf.get(o) ?? 0) + v);
      assigned.push(m.id);
    }
    if (assigned.length > 0) await tx.query("UPDATE maintenance_requests SET owner_deduct_period = $2::date WHERE id = ANY($1::int[])", [assigned, range.start]);
    // Atualiza no lugar (o id do repasse pendente é estável); repasses pagos nunca são tocados.
    let generated = 0;
    const keep: number[] = [];
    for (const [ownerId, g] of gross) {
      if (paidOwners.has(ownerId) || g <= 0) continue;
      const fee = feeOf(g);
      const m = maintOf.get(ownerId) ?? 0;
      await tx.query(
        `INSERT INTO owner_transfers (organization_id, owner_id, period, gross_cents, fee_cents, maintenance_cents, net_cents, fee_bps)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (organization_id, owner_id, period) DO UPDATE
           SET gross_cents = EXCLUDED.gross_cents, fee_cents = EXCLUDED.fee_cents, maintenance_cents = EXCLUDED.maintenance_cents,
               net_cents = EXCLUDED.net_cents, fee_bps = EXCLUDED.fee_bps, generated_at = now()
           WHERE owner_transfers.status = 'pendente'`,
        [orgId, ownerId, range.start, g, fee, m, g - fee - m, feeBps],
      );
      keep.push(ownerId);
      generated += 1;
    }
    // Pendentes que perderam a base (ex.: pagamento estornado) deixam de existir.
    await tx.query(
      `DELETE FROM owner_transfers
       WHERE organization_id = $1 AND period = $2 AND status = 'pendente' AND NOT (owner_id = ANY($3::int[]))`,
      [orgId, range.start, keep],
    );
    return { generated, alreadyPaid: paidOwners.size, withoutOwnerCents: withoutOwner };
  });
  res.json(result);
});

financeRouter.post("/transfers/:id/pay", requireRole("admin"), async (req, res) => {
  const paidAt = req.body?.paid_at ?? brToday();
  if (typeof paidAt !== "string" || !isRealDate(paidAt) || paidAt > brToday()) {
    res.status(400).json({ error: "paid_at inválida (AAAA-MM-DD, não pode ser futura)" });
    return;
  }
  const id = parseId(req.params.id);
  const done = id
    ? await db.query(
        `UPDATE owner_transfers SET status = 'pago', paid_at = $1
         WHERE id = $2 AND organization_id = $3 AND status = 'pendente' RETURNING id`,
        [paidAt, id, req.auth!.organization.id],
      )
    : [];
  if (done.length === 0) {
    res.status(404).json({ error: "Repasse não encontrado ou já pago" });
    return;
  }
  res.status(204).end();
});

// ----------------------------------------------------- Resumo e configurações

/** Resumo financeiro do mês (AAAA-MM já validado): previsto, recebido, em atraso e caixa. */
export async function financeSummary(orgId: number, month: string) {
  const range = monthRange(month)!;
  const [row] = await db.query<Record<string, string>>(
    `SELECT
       COALESCE(sum(x.amount_cents) FILTER (WHERE x.due_date >= $2 AND x.due_date < $3), 0)::text AS expected,
       COALESCE(sum(x.paid_cents)   FILTER (WHERE x.due_date >= $2 AND x.due_date < $3), 0)::text AS received,
       COALESCE(sum(x.amount_cents - x.paid_cents) FILTER (WHERE x.status = 'vencida'), 0)::text AS overdue,
       count(*) FILTER (WHERE x.status = 'vencida')::text AS overdue_count
     FROM (SELECT c.amount_cents, c.due_date, ${PAID} AS paid_cents, ${STATUS} AS status
           FROM charges c WHERE c.organization_id = $1 AND c.cancelled_at IS NULL) x`,
    [orgId, range.start, range.next],
  );
  const [cash] = await db.query<{ n: string }>(
    `SELECT COALESCE(sum(amount_cents), 0)::text AS n FROM payments
     WHERE organization_id = $1 AND voided_at IS NULL AND received_at >= $2 AND received_at < $3`,
    [orgId, range.start, range.next],
  );
  const expected = Number(row!.expected);
  const received = Number(row!.received);
  return {
    month,
    expected_cents: expected,
    received_cents: received,
    received_ratio: expected > 0 ? Math.round((received / expected) * 1000) / 10 : null,
    overdue_cents: Number(row!.overdue),
    overdue_count: Number(row!.overdue_count),
    cash_received_cents: Number(cash!.n),
  };
}

financeRouter.get("/finance/summary", async (req, res) => {
  if (!monthRange(req.query.month)) {
    res.status(400).json({ error: "month deve ser AAAA-MM" });
    return;
  }
  res.json(await financeSummary(req.auth!.organization.id, String(req.query.month)));
});

const SETTINGS_COLS = "admin_fee_bps, late_fee_bps, late_interest_bps, late_grace_days, prorata_enabled";

financeRouter.get("/settings/finance", async (req, res) => {
  const [row] = await db.query(`SELECT ${SETTINGS_COLS} FROM organizations WHERE id = $1`, [req.auth!.organization.id]);
  res.json(row);
});

/** Taxa de administração, multa e juros por atraso, carência e pro rata. Aceita qualquer subconjunto dos campos. */
financeRouter.put("/settings/finance", requireRole("admin"), async (req, res) => {
  const b = req.body ?? {};
  const int = (k: string, max: number) => (b[k] === undefined ? undefined : Number.isInteger(b[k]) && b[k] >= 0 && b[k] <= max ? (b[k] as number) : null);
  const vals = {
    admin_fee_bps: int("admin_fee_bps", 10000),
    late_fee_bps: int("late_fee_bps", 1000),
    late_interest_bps: int("late_interest_bps", 1000),
    late_grace_days: int("late_grace_days", 30),
    prorata_enabled: b.prorata_enabled === undefined ? undefined : typeof b.prorata_enabled === "boolean" ? b.prorata_enabled : null,
  };
  if (Object.values(vals).some((v) => v === null) || Object.values(vals).every((v) => v === undefined)) {
    return void res.status(400).json({ error: "Valores inválidos. admin_fee_bps 0–10000; late_fee_bps e late_interest_bps 0–1000 (100 = 1%); late_grace_days 0–30; prorata_enabled true/false." });
  }
  await db.query(
    `UPDATE organizations SET admin_fee_bps = COALESCE($2, admin_fee_bps), late_fee_bps = COALESCE($3, late_fee_bps),
            late_interest_bps = COALESCE($4, late_interest_bps), late_grace_days = COALESCE($5, late_grace_days),
            prorata_enabled = COALESCE($6, prorata_enabled) WHERE id = $1`,
    [req.auth!.organization.id, vals.admin_fee_bps ?? null, vals.late_fee_bps ?? null, vals.late_interest_bps ?? null, vals.late_grace_days ?? null, vals.prorata_enabled ?? null],
  );
  const [row] = await db.query(`SELECT ${SETTINGS_COLS} FROM organizations WHERE id = $1`, [req.auth!.organization.id]);
  res.json(row);
});
