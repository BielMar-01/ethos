import { Router } from "express";
import { db, transaction } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";
import { isRealDate, parseId } from "./crud.js";
import { brToday } from "./finance.js";
import { formatBRL, formatDate } from "./contractTemplate.js";
import { notify, tenantUsersOfLease } from "./notifications.js";
import { periodicJobs } from "./reminders.js";

/**
 * Contratos, parte 2: aditivos (renovação, reajuste), rescisão guiada e garantias.
 * Os textos emitidos NÃO têm validade jurídica própria: são minutas objetivas para a administradora revisar.
 */
export const contracts2Router = Router();
contracts2Router.use(["/leases", "/guarantees", "/indices"], requireAuth, requireRole("admin", "colaborador"));

const INT4_MAX = 2_147_483_647;

interface Lease {
  id: number;
  unit_id: number;
  start_date: string;
  end_date: string;
  rent_cents: number;
  status: string;
}
const LEASE_COLS = "id, unit_id, to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(end_date,'YYYY-MM-DD') AS end_date, rent_cents, status";
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const addDays = (d: string, n: number) => new Date(dayMs(d) + n * 86_400_000).toISOString().slice(0, 10);

// ------------------------------------------------------------------ Índices (IGP-M / IPCA)

type FetchLike = typeof fetch;
let indexFetch: FetchLike = (...a) => fetch(...a);
/** Só para testes. */
export const setIndexFetch = (f: FetchLike | null) => (indexFetch = f ?? ((...a) => fetch(...a)));
const SERIES: Record<string, { code: number; label: string }> = { igpm: { code: 189, label: "IGP-M" }, ipca: { code: 433, label: "IPCA" } };

/** Variação acumulada dos últimos N meses (padrão 12) pelas séries do Banco Central (SGS). Público e gratuito. */
contracts2Router.get("/indices/accumulated", async (req, res) => {
  const s = SERIES[String(req.query.index)];
  const months = Math.min(Math.max(Number(req.query.months) || 12, 1), 36);
  if (!s) return void res.status(400).json({ error: "index deve ser igpm ou ipca" });
  try {
    const r = await indexFetch(`https://api.bcb.gov.br/dados/serie/bcdata.sgs.${s.code}/dados/ultimos/${months}?formato=json`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const rows = (await r.json()) as { data: string; valor: string }[];
    if (!Array.isArray(rows) || rows.length === 0) throw new Error("sem dados");
    const factor = rows.reduce((f, x) => f * (1 + Number(x.valor.replace(",", ".")) / 100), 1);
    res.json({ index: s.label, months: rows.length, from: rows[0]!.data, to: rows[rows.length - 1]!.data, accumulated_percent: Math.round((factor - 1) * 100 * 10000) / 10000, source: "Banco Central do Brasil (SGS)" });
  } catch {
    res.status(502).json({ error: "Não consegui consultar o Banco Central agora. Informe o percentual manualmente." });
  }
});

// ------------------------------------------------------------------ Aditivos

const KINDS = ["renovacao", "reajuste", "aditivo"] as const;
const KIND_LABEL: Record<string, string> = { renovacao: "RENOVAÇÃO", reajuste: "REAJUSTE", aditivo: "ADITIVO" };

function addendumText(l: Lease, a: { kind: string; effective_from: string; new_end: string | null; new_rent: number | null; index_name: string | null; index_percent: number | null; notes: string | null }): string {
  const lines = [`TERMO DE ${KIND_LABEL[a.kind]} DO CONTRATO DE LOCAÇÃO Nº ${l.id}`, ""];
  if (a.new_end) lines.push(`O prazo do contrato, que terminava em ${formatDate(l.end_date)}, passa a terminar em ${formatDate(a.new_end)}.`);
  if (a.new_rent !== null) {
    lines.push(`O aluguel mensal, de ${formatBRL(l.rent_cents)}, passa a ser de ${formatBRL(a.new_rent)}${a.index_percent !== null ? `, correspondente ao reajuste de ${a.index_percent.toString().replace(".", ",")}%${a.index_name ? ` (${a.index_name})` : ""}` : ""}.`);
  }
  lines.push(`As alterações valem a partir de ${formatDate(a.effective_from)}. As demais cláusulas do contrato permanecem inalteradas.`);
  if (a.notes) lines.push("", `Observações: ${a.notes}`);
  lines.push("", "Minuta gerada pelo Ethos. Revise e colha as assinaturas das partes.");
  return lines.join("\n");
}

async function applyAddendum(id: number): Promise<boolean> {
  return transaction(async (tx) => {
    const [a] = await tx.query<{ id: number; lease_id: number; organization_id: number; new_end: string | null; new_rent_cents: number | null; applied_at: string | null }>(
      "SELECT id, lease_id, organization_id, to_char(new_end,'YYYY-MM-DD') AS new_end, new_rent_cents, applied_at FROM lease_addenda WHERE id = $1 FOR UPDATE",
      [id],
    );
    if (!a || a.applied_at) return false;
    const [l] = await tx.query<Lease>(`SELECT ${LEASE_COLS} FROM leases WHERE id = $1 FOR UPDATE`, [a.lease_id]);
    if (!l || l.status !== "vigente") return false;
    await tx.query("UPDATE leases SET end_date = COALESCE($2::date, end_date), rent_cents = COALESCE($3, rent_cents) WHERE id = $1", [l.id, a.new_end, a.new_rent_cents]);
    await tx.query("UPDATE lease_addenda SET applied_at = now() WHERE id = $1", [id]);
    return true;
  });
}

contracts2Router.get("/leases/:id/addenda", async (req, res) => {
  const id = parseId(req.params.id);
  const items = id
    ? await db.query(
        `SELECT id, kind, to_char(effective_from,'YYYY-MM-DD') AS effective_from, to_char(previous_end,'YYYY-MM-DD') AS previous_end, to_char(new_end,'YYYY-MM-DD') AS new_end,
                previous_rent_cents, new_rent_cents, index_name, index_percent::float8 AS index_percent, notes, content, applied_at, created_at
         FROM lease_addenda WHERE lease_id = $1 AND organization_id = $2 ORDER BY id DESC`,
        [id, req.auth!.organization.id],
      )
    : [];
  res.json({ items });
});

contracts2Router.post("/leases/:id/addenda", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const id = parseId(req.params.id);
  const b = req.body ?? {};
  if (!KINDS.includes(b.kind)) return void res.status(400).json({ error: "kind deve ser renovacao, reajuste ou aditivo." });
  const [l] = id ? await db.query<Lease>(`SELECT ${LEASE_COLS} FROM leases WHERE id = $1 AND organization_id = $2`, [id, orgId]) : [];
  if (!l) return void res.status(404).json({ error: "Contrato não encontrado." });
  if (l.status !== "vigente") return void res.status(409).json({ error: "Só contratos vigentes recebem aditivo." });
  const today = brToday();
  const effective = b.effective_from === undefined ? today : String(b.effective_from);
  if (!isRealDate(effective)) return void res.status(400).json({ error: "effective_from inválida (AAAA-MM-DD)." });

  let newEnd: string | null = null;
  let newRent: number | null = null;
  let percent: number | null = null;
  if (b.new_end_date !== undefined && b.new_end_date !== null) {
    newEnd = String(b.new_end_date);
    if (!isRealDate(newEnd) || newEnd <= l.end_date) return void res.status(400).json({ error: "O novo fim deve ser uma data depois do fim atual." });
    if ((dayMs(newEnd) - dayMs(l.end_date)) / 86_400_000 > 365 * 5) return void res.status(400).json({ error: "A prorrogação não pode passar de 5 anos." });
  }
  if (b.index_percent !== undefined && b.index_percent !== null) {
    percent = Number(b.index_percent);
    if (!Number.isFinite(percent) || percent < -50 || percent > 100) return void res.status(400).json({ error: "index_percent deve estar entre -50 e 100." });
    newRent = Math.max(1, Math.round(l.rent_cents * (1 + percent / 100)));
  }
  if (b.new_rent_cents !== undefined && b.new_rent_cents !== null) {
    if (!Number.isInteger(b.new_rent_cents) || b.new_rent_cents < 1 || b.new_rent_cents > INT4_MAX) return void res.status(400).json({ error: "new_rent_cents inválido (centavos)." });
    newRent = b.new_rent_cents;
  }
  if (b.kind === "renovacao" && !newEnd) return void res.status(400).json({ error: "Renovação precisa de new_end_date." });
  if (b.kind === "reajuste" && newRent === null) return void res.status(400).json({ error: "Reajuste precisa de index_percent ou new_rent_cents." });
  if (!newEnd && newRent === null) return void res.status(400).json({ error: "Informe o novo prazo e/ou o novo aluguel." });
  const indexName = typeof b.index_name === "string" && b.index_name.trim() ? b.index_name.trim().slice(0, 40) : null;
  const notes = typeof b.notes === "string" && b.notes.trim() ? b.notes.trim().slice(0, 500) : null;

  if (newEnd) {
    // Estender o prazo não pode invadir outro contrato vigente da mesma unidade.
    const clash = await db.query("SELECT 1 FROM leases WHERE unit_id = $1 AND status = 'vigente' AND id <> $2 AND start_date <= $4 AND end_date >= $3", [l.unit_id, l.id, l.end_date, newEnd]);
    if (clash.length > 0) return void res.status(409).json({ error: "Outro contrato vigente da unidade ocupa esse período." });
  }
  const content = addendumText(l, { kind: b.kind, effective_from: effective, new_end: newEnd, new_rent: newRent, index_name: indexName, index_percent: percent, notes });
  const [row] = await db.query<{ id: number }>(
    `INSERT INTO lease_addenda (organization_id, lease_id, kind, effective_from, previous_end, new_end, previous_rent_cents, new_rent_cents, index_name, index_percent, notes, content, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [orgId, l.id, b.kind, effective, l.end_date, newEnd, l.rent_cents, newRent, indexName, percent, notes, content, req.auth!.user.id],
  );
  const applied = effective <= today ? await applyAddendum(row!.id) : false;
  if (applied) {
    await notify(orgId, await tenantUsersOfLease(l.id), {
      category: "contrato", kind: "lease_addendum", title: b.kind === "reajuste" ? "Reajuste do aluguel" : b.kind === "renovacao" ? "Contrato renovado" : "Aditivo ao contrato",
      body: [newEnd ? `Novo fim: ${formatDate(newEnd)}.` : null, newRent !== null ? `Novo aluguel: ${formatBRL(newRent)}.` : null].filter(Boolean).join(" "), linkKind: "lease", linkId: l.id,
    });
  }
  res.status(201).json({ id: row!.id, applied, content });
});

/** Aplica os aditivos agendados cuja data chegou (roda junto com os lembretes). */
export async function applyDueAddenda(): Promise<number> {
  const due = await db.query<{ id: number; lease_id: number; organization_id: number }>("SELECT id, lease_id, organization_id FROM lease_addenda WHERE applied_at IS NULL AND effective_from <= $1::date", [brToday()]);
  let n = 0;
  for (const a of due) {
    if (await applyAddendum(a.id)) {
      n++;
      await notify(a.organization_id, await tenantUsersOfLease(a.lease_id), { category: "contrato", kind: "lease_addendum", title: "Aditivo do contrato em vigor", body: "Um aditivo (prazo e/ou aluguel) entrou em vigor hoje.", linkKind: "lease", linkId: a.lease_id });
    }
  }
  return n;
}

// ------------------------------------------------------------------ Rescisão guiada

interface Breakdown {
  lease_id: number;
  terminated_on: string;
  total_days: number;
  remaining_days: number;
  rent_cents: number;
  fine_months: number;
  fine_base_cents: number;
  fine_cents: number;
  open_future_charges: number;
  notes: string[];
}

async function breakdown(orgId: number, leaseId: number | undefined, body: Record<string, unknown>): Promise<{ b: Breakdown; lease: Lease } | { code: number; error: string }> {
  const [l] = leaseId ? await db.query<Lease>(`SELECT ${LEASE_COLS} FROM leases WHERE id = $1 AND organization_id = $2`, [leaseId, orgId]) : [];
  if (!l) return { code: 404, error: "Contrato não encontrado." };
  if (l.status !== "vigente") return { code: 409, error: "Só contratos vigentes podem ser rescindidos." };
  const date = body.date === undefined ? brToday() : String(body.date);
  if (!isRealDate(date) || date < l.start_date || date > l.end_date) return { code: 400, error: `A data da rescisão deve estar entre ${formatDate(l.start_date)} e ${formatDate(l.end_date)}.` };
  const months = body.fine_months === undefined ? 3 : Number(body.fine_months);
  if (!Number.isFinite(months) || months < 0 || months > 12) return { code: 400, error: "fine_months deve ficar entre 0 e 12 (aluguéis de multa prevista no contrato)." };
  const total = Math.round((dayMs(l.end_date) - dayMs(l.start_date)) / 86_400_000) + 1;
  const remaining = Math.max(0, Math.round((dayMs(l.end_date) - dayMs(date)) / 86_400_000));
  const base = Math.round(l.rent_cents * months);
  const fine = Math.round((base * remaining) / total);
  const [fut] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM charges WHERE lease_id = $1 AND cancelled_at IS NULL AND kind = 'aluguel' AND due_date > $2::date", [l.id, date]);
  const notes = [
    "Multa proporcional ao tempo que faltava (Lei do Inquilinato, art. 4º): multa prevista × dias restantes ÷ dias do contrato.",
    "Confira se o contrato prevê a multa e se há isenção (transferência de emprego, aviso prévio, culpa do locador etc.).",
  ];
  if (fut!.n > 0) notes.push(`Há ${fut!.n} aluguel(éis) com vencimento depois da rescisão; você pode cancelá-los ao rescindir.`);
  return { lease: l, b: { lease_id: l.id, terminated_on: date, total_days: total, remaining_days: remaining, rent_cents: l.rent_cents, fine_months: months, fine_base_cents: base, fine_cents: fine, open_future_charges: fut!.n, notes } };
}

contracts2Router.post("/leases/:id/terminate/preview", async (req, res) => {
  const r = await breakdown(req.auth!.organization.id, parseId(req.params.id), req.body ?? {});
  if ("error" in r) return void res.status(r.code).json({ error: r.error });
  res.json(r.b);
});

contracts2Router.post("/leases/:id/terminate", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const r = await breakdown(orgId, parseId(req.params.id), req.body ?? {});
  if ("error" in r) return void res.status(r.code).json({ error: r.error });
  const { b, lease } = r;
  const waive = req.body?.waive_fine === true;
  const chargeFine = req.body?.charge_fine !== false && !waive && b.fine_cents > 0;
  const cancelFuture = req.body?.cancel_future_charges === true;
  const reason = typeof req.body?.reason === "string" && req.body.reason.trim() ? req.body.reason.trim().slice(0, 300) : null;
  const out = await transaction(async (tx) => {
    await tx.query("SELECT id FROM units WHERE id = $1 FOR UPDATE", [lease.unit_id]);
    const [cur] = await tx.query<{ status: string }>("SELECT status FROM leases WHERE id = $1 FOR UPDATE", [lease.id]);
    if (cur?.status !== "vigente") return { code: 409, error: "O contrato não está mais vigente." };
    await tx.query("UPDATE leases SET status = 'rescindido' WHERE id = $1", [lease.id]);
    const others = await tx.query("SELECT 1 FROM leases WHERE unit_id = $1 AND status = 'vigente' AND id <> $2", [lease.unit_id, lease.id]);
    if (others.length === 0) await tx.query("UPDATE units SET status = 'disponivel' WHERE id = $1", [lease.unit_id]);
    let chargeId: number | null = null;
    if (chargeFine) {
      const [c] = await tx.query<{ id: number }>(
        `INSERT INTO charges (organization_id, lease_id, kind, description, competence, due_date, amount_cents, created_by)
         VALUES ($1, $2, 'multa', $3, date_trunc('month', $4::date), $4, $5, $6) RETURNING id`,
        [orgId, lease.id, `Multa rescisória — contrato nº ${lease.id}`, b.terminated_on, b.fine_cents, req.auth!.user.id],
      );
      chargeId = c!.id;
    }
    let cancelled = 0;
    if (cancelFuture) {
      const rows = await tx.query(
        `UPDATE charges c SET cancelled_at = now() WHERE c.lease_id = $1 AND c.cancelled_at IS NULL AND c.kind = 'aluguel' AND c.due_date > $2::date
           AND NOT EXISTS (SELECT 1 FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id WHERE pa.charge_id = c.id AND p.voided_at IS NULL) RETURNING c.id`,
        [lease.id, b.terminated_on],
      );
      cancelled = rows.length;
    }
    await tx.query(
      `INSERT INTO lease_terminations (lease_id, organization_id, terminated_on, reason, fine_months, fine_cents, fine_waived, fine_charge_id, cancelled_charges, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [lease.id, orgId, b.terminated_on, reason, b.fine_months, b.fine_cents, waive, chargeId, cancelled, req.auth!.user.id],
    );
    return { code: 200, chargeId, cancelled };
  });
  if (out.code !== 200) return void res.status(out.code).json({ error: out.error });
  await notify(orgId, await tenantUsersOfLease(lease.id), { category: "contrato", kind: "lease_terminated", title: "Contrato rescindido", body: `Rescisão em ${formatDate(b.terminated_on)}.${chargeFine ? ` Multa rescisória: ${formatBRL(b.fine_cents)}.` : ""}`, linkKind: "lease", linkId: lease.id });
  res.json({ status: "rescindido", fine_charge_id: out.chargeId, cancelled_charges: out.cancelled, ...b });
});

contracts2Router.get("/leases/:id/termination", async (req, res) => {
  const id = parseId(req.params.id);
  const [t] = id ? await db.query("SELECT *, to_char(terminated_on,'YYYY-MM-DD') AS terminated_on FROM lease_terminations WHERE lease_id = $1 AND organization_id = $2", [id, req.auth!.organization.id]) : [];
  if (!t) return void res.status(404).json({ error: "Sem rescisão registrada." });
  res.json({ item: t });
});

// ------------------------------------------------------------------ Garantias

const G_KINDS = ["fiador", "caucao", "seguro_fianca", "titulo_capitalizacao", "outro"] as const;
const G_STATUS = ["ativa", "liberada", "executada"] as const;
const REQUIRED: Record<string, string[]> = { fiador: ["name", "document"], caucao: [], seguro_fianca: ["insurer", "policy_number"], titulo_capitalizacao: ["issuer", "number"], outro: ["description"] };

function cleanGuarantee(b: Record<string, unknown>, kind: string): { amount: number | null; valid_until: string | null; details: Record<string, string>; notes: string | null } | string {
  let amount: number | null = null;
  if (b.amount_cents !== undefined && b.amount_cents !== null) {
    if (!Number.isInteger(b.amount_cents) || (b.amount_cents as number) < 0 || (b.amount_cents as number) > INT4_MAX) return "amount_cents inválido (centavos).";
    amount = b.amount_cents as number;
  }
  if (kind === "caucao" && !amount) return "Caução precisa do valor (amount_cents).";
  let validUntil: string | null = null;
  if (b.valid_until !== undefined && b.valid_until !== null && b.valid_until !== "") {
    validUntil = String(b.valid_until);
    if (!isRealDate(validUntil)) return "valid_until inválida (AAAA-MM-DD).";
  }
  if (kind === "seguro_fianca" && !validUntil) return "Seguro-fiança precisa da vigência (valid_until).";
  const raw = (b.details && typeof b.details === "object" ? b.details : {}) as Record<string, unknown>;
  const details: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (/^[a-z_]{1,30}$/.test(k) && (typeof v === "string" || typeof v === "number") && String(v).length <= 200) details[k] = String(v).trim();
  }
  for (const k of REQUIRED[kind]!) if (!details[k]) return `Informe ${k} nos detalhes da garantia.`;
  const notes = typeof b.notes === "string" && b.notes.trim() ? b.notes.trim().slice(0, 500) : null;
  return { amount, valid_until: validUntil, details, notes };
}

contracts2Router.get("/leases/:id/guarantees", async (req, res) => {
  const id = parseId(req.params.id);
  const items = id
    ? await db.query(
        "SELECT id, kind, status, amount_cents, to_char(valid_until,'YYYY-MM-DD') AS valid_until, details, notes, created_at FROM lease_guarantees WHERE lease_id = $1 AND organization_id = $2 ORDER BY id",
        [id, req.auth!.organization.id],
      )
    : [];
  res.json({ items });
});

contracts2Router.post("/leases/:id/guarantees", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const id = parseId(req.params.id);
  const kind = req.body?.kind;
  if (!G_KINDS.includes(kind)) return void res.status(400).json({ error: `kind deve ser: ${G_KINDS.join(", ")}.` });
  const [l] = id ? await db.query("SELECT id FROM leases WHERE id = $1 AND organization_id = $2", [id, orgId]) : [];
  if (!l) return void res.status(404).json({ error: "Contrato não encontrado." });
  const c = cleanGuarantee(req.body, kind);
  if (typeof c === "string") return void res.status(400).json({ error: c });
  const [row] = await db.query<{ id: number }>(
    "INSERT INTO lease_guarantees (organization_id, lease_id, kind, amount_cents, valid_until, details, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
    [orgId, id, kind, c.amount, c.valid_until, JSON.stringify(c.details), c.notes, req.auth!.user.id],
  );
  res.status(201).json({ id: row!.id });
});

contracts2Router.patch("/guarantees/:id", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const id = parseId(req.params.id);
  const [g] = id ? await db.query<{ kind: string; status: string; amount_cents: number | null; valid_until: string | null; details: Record<string, string>; notes: string | null }>(
    "SELECT kind, status, amount_cents, to_char(valid_until,'YYYY-MM-DD') AS valid_until, details, notes FROM lease_guarantees WHERE id = $1 AND organization_id = $2", [id, orgId]) : [];
  if (!g) return void res.status(404).json({ error: "Garantia não encontrada." });
  if (req.body?.status !== undefined && !G_STATUS.includes(req.body.status)) return void res.status(400).json({ error: `status deve ser: ${G_STATUS.join(", ")}.` });
  const merged = { amount_cents: g.amount_cents, valid_until: g.valid_until, details: g.details, notes: g.notes, ...req.body };
  const c = cleanGuarantee(merged, g.kind);
  if (typeof c === "string") return void res.status(400).json({ error: c });
  await db.query(
    "UPDATE lease_guarantees SET status = COALESCE($2, status), amount_cents = $3, valid_until = $4, details = $5, notes = $6, expiry_alerted_at = CASE WHEN $4::date IS DISTINCT FROM valid_until THEN NULL ELSE expiry_alerted_at END, updated_at = now() WHERE id = $1",
    [id, req.body?.status ?? null, c.amount, c.valid_until, JSON.stringify(c.details), c.notes],
  );
  res.json({ ok: true });
});

contracts2Router.delete("/guarantees/:id", requireRole("admin"), async (req, res) => {
  const id = parseId(req.params.id);
  const done = id ? await db.query("DELETE FROM lease_guarantees WHERE id = $1 AND organization_id = $2 RETURNING id", [id, req.auth!.organization.id]) : [];
  if (done.length === 0) return void res.status(404).json({ error: "Garantia não encontrada." });
  res.status(204).end();
});

/** Garantias ativas que vencem em até 30 dias (ou já venceram): um aviso à equipe por garantia. */
export async function runGuaranteeAlerts(): Promise<number> {
  const rows = await db.query<{ id: number; organization_id: number; lease_id: number; kind: string; valid_until: string }>(
    `UPDATE lease_guarantees SET expiry_alerted_at = now() WHERE status = 'ativa' AND expiry_alerted_at IS NULL AND valid_until IS NOT NULL AND valid_until <= $1::date + 30
     RETURNING id, organization_id, lease_id, kind, to_char(valid_until,'YYYY-MM-DD') AS valid_until`,
    [brToday()],
  );
  let n = 0;
  for (const g of rows) {
    const staff = (await db.query<{ user_id: number }>("SELECT user_id FROM organization_members WHERE organization_id = $1 AND role IN ('admin','colaborador')", [g.organization_id])).map((r) => r.user_id);
    n += await notify(g.organization_id, staff, { category: "contrato", kind: "guarantee_expiring", title: "Garantia do contrato perto de vencer", body: `${g.kind.replace(/_/g, " ")} do contrato nº ${g.lease_id} vence em ${formatDate(g.valid_until)}.`, linkKind: "lease", linkId: g.lease_id, dedupeKey: `guarantee:${g.id}` });
  }
  return n;
}

periodicJobs.push(
  { name: "aditivos agendados", run: () => applyDueAddenda() },
  { name: "garantias perto de vencer", run: () => runGuaranteeAlerts() },
);
