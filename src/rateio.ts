import { Router } from "express";
import { db, transaction } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";
import { isRealDate, parseId } from "./crud.js";
import { CHARGE_SELECT, monthRange } from "./finance.js";
import { notify, tenantUsersOfLease } from "./notifications.js";
import { formatBRL } from "./contractTemplate.js";

/**
 * Rateio de despesas do imóvel (água, luz da área comum, condomínio…): divide o total entre as unidades COM CONTRATO VIGENTE
 * no mês e gera uma cobrança ("taxa") por unidade, com o fluxo normal de boleto/pagamento/recibo.
 * Métodos: "igual" (partes iguais) ou "area" (proporcional à área em m² da unidade). Centavos que sobram vão às primeiras unidades.
 */
export const rateioRouter = Router();
rateioRouter.use("/shared-expenses", requireAuth, requireRole("admin", "colaborador"));

const INT4_MAX = 2_147_483_647;

/** Divide `total` em partes proporcionais a `weights` (inteiros > 0); a soma é exatamente `total`. */
export function splitProportional(total: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  const base = weights.map((w) => Math.floor((total * w) / sum));
  let rest = total - base.reduce((s, v) => s + v, 0);
  for (let i = 0; rest > 0; i = (i + 1) % base.length, rest--) base[i]!++;
  return base;
}

rateioRouter.post("/shared-expenses", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const b = req.body ?? {};
  const propertyId = parseId(b.property_id);
  const range = monthRange(b.month);
  const description = typeof b.description === "string" ? b.description.trim() : "";
  const method = b.method === "area" ? "area" : b.method === "igual" || b.method === undefined ? "igual" : null;
  if (!propertyId || !range || !description || description.length > 120 || !method) return void res.status(400).json({ error: "Informe property_id, month (AAAA-MM), description (até 120) e method (igual|area)." });
  if (!Number.isInteger(b.total_cents) || b.total_cents < 1 || b.total_cents > INT4_MAX) return void res.status(400).json({ error: "total_cents deve ser um inteiro positivo (centavos)." });
  const due = b.due_date === undefined ? `${range.start.slice(0, 8)}10` : String(b.due_date);
  if (!isRealDate(due)) return void res.status(400).json({ error: "due_date inválida (AAAA-MM-DD)." });

  const out = await transaction(async (tx) => {
    const [prop] = await tx.query<{ name: string }>("SELECT name FROM properties WHERE id = $1 AND organization_id = $2", [propertyId, orgId]);
    if (!prop) return { code: 404, error: "Imóvel não encontrado." };
    const units = await tx.query<{ unit_id: number; lease_id: number; identifier: string; area_m2: number | null }>(
      `SELECT u.id AS unit_id, l.id AS lease_id, u.identifier, u.area_m2 FROM units u
       JOIN leases l ON l.unit_id = u.id AND l.status = 'vigente' AND l.start_date < $3 AND l.end_date >= $2
       WHERE u.property_id = $1 AND u.organization_id = $4 ORDER BY u.identifier`,
      [propertyId, range.start, range.next, orgId],
    );
    if (units.length === 0) return { code: 422, error: "Nenhuma unidade deste imóvel tem contrato vigente nesse mês." };
    let weights = units.map(() => 1);
    if (method === "area") {
      const missing = units.filter((u) => !u.area_m2 || u.area_m2 < 1).map((u) => u.identifier);
      if (missing.length > 0) return { code: 422, error: `Cadastre a área (m²) das unidades para ratear por área: ${missing.join(", ")}.` };
      weights = units.map((u) => u.area_m2!);
    }
    const shares = splitProportional(b.total_cents, weights);
    if (shares.some((s) => s < 1)) return { code: 422, error: "O valor é pequeno demais para dividir entre as unidades." };
    const [exp] = await tx.query<{ id: number }>(
      "INSERT INTO shared_expenses (organization_id, property_id, description, total_cents, competence, due_date, method, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
      [orgId, propertyId, description, b.total_cents, range.start, due, method, req.auth!.user.id],
    );
    const label = `${range.start.slice(5, 7)}/${range.start.slice(0, 4)}`;
    const leaseIds: number[] = [];
    for (let i = 0; i < units.length; i++) {
      const u = units[i]!;
      const [ch] = await tx.query<{ id: number }>(
        `INSERT INTO charges (organization_id, lease_id, kind, description, competence, due_date, amount_cents, created_by)
         VALUES ($1, $2, 'taxa', $3, $4, $5, $6, $7) RETURNING id`,
        [orgId, u.lease_id, `Rateio: ${description} (${label})`, range.start, due, shares[i], req.auth!.user.id],
      );
      await tx.query("INSERT INTO shared_expense_shares (expense_id, unit_id, lease_id, charge_id, amount_cents) VALUES ($1, $2, $3, $4, $5)", [exp!.id, u.unit_id, u.lease_id, ch!.id, shares[i]]);
      leaseIds.push(u.lease_id);
    }
    return { code: 201, id: exp!.id, units: units.length, shares, leaseIds };
  });
  if (out.code !== 201) return void res.status(out.code).json({ error: out.error });
  for (let i = 0; i < out.leaseIds!.length; i++) {
    await notify(orgId, await tenantUsersOfLease(out.leaseIds![i]!), { category: "financeiro", kind: "shared_expense", title: "Nova cobrança de rateio", body: `${description}: ${formatBRL(out.shares![i]!)} com vencimento em ${due.split("-").reverse().join("/")}.` });
  }
  res.status(201).json({ id: out.id, units: out.units, shares_cents: out.shares });
});

rateioRouter.get("/shared-expenses", async (req, res) => {
  const items = await db.query(
    `SELECT e.id, e.description, e.total_cents, e.competence, e.due_date, e.method, e.cancelled_at, e.created_at, p.name AS property_name,
            (SELECT count(*)::int FROM shared_expense_shares s WHERE s.expense_id = e.id) AS units
     FROM shared_expenses e JOIN properties p ON p.id = e.property_id WHERE e.organization_id = $1 ORDER BY e.id DESC LIMIT 200`,
    [req.auth!.organization.id],
  );
  res.json({ items });
});

rateioRouter.get("/shared-expenses/:id", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const id = parseId(req.params.id);
  const [item] = id ? await db.query("SELECT e.*, p.name AS property_name FROM shared_expenses e JOIN properties p ON p.id = e.property_id WHERE e.id = $1 AND e.organization_id = $2", [id, orgId]) : [];
  if (!item) return void res.status(404).json({ error: "Não encontrado" });
  const shares = await db.query(
    `SELECT s.unit_id, s.lease_id, s.charge_id, s.amount_cents, x.status, x.paid_cents, x.unit_identifier, x.tenant_names
     FROM shared_expense_shares s
     LEFT JOIN LATERAL (SELECT * FROM (${CHARGE_SELECT} WHERE c.organization_id = $2 AND c.id = s.charge_id) q) x ON true
     WHERE s.expense_id = $1 ORDER BY x.unit_identifier`,
    [id, orgId],
  );
  res.json({ item, shares });
});

/** Cancela o rateio inteiro; só se nenhuma cobrança dele recebeu pagamento (estorne antes, se for o caso). */
rateioRouter.post("/shared-expenses/:id/cancel", requireRole("admin"), async (req, res) => {
  const orgId = req.auth!.organization.id;
  const id = parseId(req.params.id);
  const out = await transaction(async (tx) => {
    const [e] = id ? await tx.query<{ cancelled_at: string | null }>("SELECT cancelled_at FROM shared_expenses WHERE id = $1 AND organization_id = $2 FOR UPDATE", [id, orgId]) : [];
    if (!e) return { code: 404, error: "Não encontrado" };
    if (e.cancelled_at) return { code: 409, error: "Este rateio já foi cancelado." };
    const paid = await tx.query(
      `SELECT 1 FROM shared_expense_shares s JOIN payment_allocations pa ON pa.charge_id = s.charge_id JOIN payments p ON p.id = pa.payment_id
       WHERE s.expense_id = $1 AND p.voided_at IS NULL LIMIT 1`,
      [id],
    );
    if (paid.length > 0) return { code: 409, error: "Há cobranças deste rateio com pagamento. Estorne os pagamentos antes de cancelar." };
    await tx.query("UPDATE charges SET cancelled_at = now() WHERE id IN (SELECT charge_id FROM shared_expense_shares WHERE expense_id = $1) AND cancelled_at IS NULL", [id]);
    await tx.query("UPDATE shared_expenses SET cancelled_at = now() WHERE id = $1", [id]);
    return { code: 200 };
  });
  if (out.code !== 200) return void res.status(out.code).json({ error: out.error });
  res.json({ cancelled: true });
});
