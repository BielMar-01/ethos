import { Router, type Response } from "express";
import { db } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";
import { CHARGE_SELECT, brToday, monthRange } from "./finance.js";

/**
 * Relatórios gerenciais (equipe): inadimplência, DRE por imóvel, fluxo de caixa, informe de rendimentos do proprietário,
 * planilha de apoio da DIMOB e indicadores (KPIs). Todos aceitam ?format=csv. Os valores saem em centavos no JSON e em reais no CSV.
 * A planilha da DIMOB NÃO é o arquivo oficial da Receita: serve para conferir/preencher o programa.
 */
export const reportsRouter = Router();
reportsRouter.use("/reports", requireAuth, requireRole("admin", "colaborador"));

const MAX_MONTHS = 36;

// ------------------------------------------------------------------ CSV

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  // Evita "injeção de fórmula" ao abrir no Excel (=, +, -, @ no começo).
  const safe = /^[=+\-@]/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s) ? `'${s}` : s;
  return /[;"\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
export const reais = (cents: number | string | null) => (cents === null ? "" : (Number(cents) / 100).toFixed(2).replace(".", ","));

export function sendCsv(res: Response, filename: string, header: string[], rows: unknown[][]) {
  res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "no-store" });
  res.send("﻿" + [header, ...rows].map((r) => r.map(cell).join(";")).join("\r\n"));
}

const wantsCsv = (q: unknown) => q === "csv";

/** Lista de meses AAAA-MM entre from e to (inclusive), no máximo MAX_MONTHS. */
function months(from: unknown, to: unknown): string[] | null {
  const a = monthRange(from);
  const b = monthRange(to);
  if (!a || !b || a.start > b.start) return null;
  const out: string[] = [];
  let y = Number(a.start.slice(0, 4));
  let m = Number(a.start.slice(5, 7));
  const end = String(to);
  for (;;) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    out.push(key);
    if (key >= end || out.length > MAX_MONTHS) break;
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out.length > MAX_MONTHS ? null : out;
}

// ------------------------------------------------------------------ Inadimplência

reportsRouter.get("/reports/delinquency", async (req, res) => {
  const today = brToday();
  const rows = await db.query<{ id: number; kind: string; description: string; due_date: string; open_cents: number; tenant_names: string | null; unit_identifier: string; property_name: string; days: number }>(
    `SELECT x.id, x.kind, x.description, to_char(x.due_date,'YYYY-MM-DD') AS due_date, (x.amount_cents - x.paid_cents) AS open_cents,
            x.tenant_names, x.unit_identifier, x.property_name, ($2::date - x.due_date)::int AS days
     FROM (${CHARGE_SELECT} WHERE c.organization_id = $1 AND c.cancelled_at IS NULL) x
     WHERE x.status = 'vencida' ORDER BY x.due_date, x.id`,
    [req.auth!.organization.id, today],
  );
  const buckets = { "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
  const byTenant = new Map<string, { tenant: string; count: number; cents: number; oldest: number }>();
  for (const r of rows) {
    buckets[r.days <= 30 ? "1-30" : r.days <= 60 ? "31-60" : r.days <= 90 ? "61-90" : "90+"] += r.open_cents;
    const key = r.tenant_names ?? "—";
    const cur = byTenant.get(key) ?? { tenant: key, count: 0, cents: 0, oldest: 0 };
    cur.count++; cur.cents += r.open_cents; cur.oldest = Math.max(cur.oldest, r.days);
    byTenant.set(key, cur);
  }
  const [exp] = await db.query<{ expected: string }>(
    "SELECT COALESCE(sum(amount_cents),0)::text AS expected FROM charges WHERE organization_id = $1 AND cancelled_at IS NULL AND due_date < $2::date AND due_date >= $2::date - 365",
    [req.auth!.organization.id, today],
  );
  const total = rows.reduce((s, r) => s + r.open_cents, 0);
  if (wantsCsv(req.query.format)) {
    return sendCsv(res, "inadimplencia.csv", ["Locatário", "Imóvel", "Unidade", "Cobrança", "Tipo", "Vencimento", "Dias de atraso", "Em aberto (R$)"],
      rows.map((r) => [r.tenant_names, r.property_name, r.unit_identifier, r.description, r.kind, r.due_date, r.days, reais(r.open_cents)]));
  }
  res.json({
    as_of: today,
    total_cents: total,
    count: rows.length,
    delinquency_ratio: Number(exp!.expected) > 0 ? Math.round((total / Number(exp!.expected)) * 1000) / 10 : null,
    aging_cents: buckets,
    by_tenant: [...byTenant.values()].sort((a, b) => b.cents - a.cents),
    items: rows,
  });
});

// ------------------------------------------------------------------ DRE por imóvel

reportsRouter.get("/reports/dre", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const list = months(req.query.from, req.query.to);
  if (!list) return void res.status(400).json({ error: `Informe from e to (AAAA-MM), no máximo ${MAX_MONTHS} meses.` });
  const start = `${list[0]}-01`;
  const next = monthRange(list[list.length - 1])!.next;
  const propertyId = req.query.property_id ? Number(req.query.property_id) : null;
  const [org] = await db.query<{ admin_fee_bps: number }>("SELECT admin_fee_bps FROM organizations WHERE id = $1", [orgId]);
  const recv = await db.query<{ property_id: number; property_name: string; kind: string; cents: string }>(
    `SELECT pr.id AS property_id, pr.name AS property_name, c.kind, sum(pa.amount_cents)::text AS cents
     FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id JOIN charges c ON c.id = pa.charge_id
     JOIN leases l ON l.id = c.lease_id JOIN units u ON u.id = l.unit_id JOIN properties pr ON pr.id = u.property_id
     WHERE p.organization_id = $1 AND p.voided_at IS NULL AND c.cancelled_at IS NULL AND p.received_at >= $2 AND p.received_at < $3
       AND ($4::int IS NULL OR pr.id = $4)
     GROUP BY pr.id, pr.name, c.kind`,
    [orgId, start, next, propertyId],
  );
  const maint = await db.query<{ property_id: number; property_name: string; cost: string; owner_cost: string }>(
    `SELECT pr.id AS property_id, pr.name AS property_name, sum(m.cost_cents)::text AS cost,
            COALESCE(sum(m.cost_cents) FILTER (WHERE m.charge_owner), 0)::text AS owner_cost
     FROM maintenance_requests m JOIN units u ON u.id = m.unit_id JOIN properties pr ON pr.id = u.property_id
     WHERE m.organization_id = $1 AND m.status = 'concluida' AND m.cost_cents > 0 AND m.completed_at >= $2 AND m.completed_at < $3 AND ($4::int IS NULL OR pr.id = $4)
     GROUP BY pr.id, pr.name`,
    [orgId, start, next, propertyId],
  );
  const map = new Map<number, Record<string, number | string>>();
  const row = (id: number, name: string) => {
    if (!map.has(id)) map.set(id, { property_id: id, property_name: name, rent_cents: 0, late_fees_cents: 0, other_cents: 0, admin_fee_cents: 0, maintenance_cents: 0, maintenance_owner_cents: 0, owner_net_cents: 0 });
    return map.get(id)!;
  };
  for (const r of recv) {
    const x = row(r.property_id, r.property_name);
    const k = r.kind === "aluguel" ? "rent_cents" : r.kind === "multa" || r.kind === "juros" ? "late_fees_cents" : "other_cents";
    x[k] = (x[k] as number) + Number(r.cents);
  }
  for (const r of maint) {
    const x = row(r.property_id, r.property_name);
    x.maintenance_cents = Number(r.cost);
    x.maintenance_owner_cents = Number(r.owner_cost);
  }
  const items = [...map.values()].map((x) => {
    x.admin_fee_cents = Math.round(((x.rent_cents as number) * org!.admin_fee_bps) / 10000);
    x.owner_net_cents = (x.rent_cents as number) - (x.admin_fee_cents as number) - (x.maintenance_owner_cents as number);
    return x;
  }).sort((a, b) => String(a.property_name).localeCompare(String(b.property_name)));
  const sum = (k: string) => items.reduce((s, x) => s + (x[k] as number), 0);
  if (wantsCsv(req.query.format)) {
    return sendCsv(res, "dre-por-imovel.csv", ["Imóvel", "Aluguéis recebidos", "Multa e juros", "Outras taxas", "Taxa de administração", "Manutenção (total)", "Manutenção cobrada do proprietário", "Líquido do proprietário"],
      items.map((x) => [x.property_name, reais(x.rent_cents as number), reais(x.late_fees_cents as number), reais(x.other_cents as number), reais(x.admin_fee_cents as number), reais(x.maintenance_cents as number), reais(x.maintenance_owner_cents as number), reais(x.owner_net_cents as number)]));
  }
  res.json({
    from: list[0], to: list[list.length - 1], admin_fee_bps: org!.admin_fee_bps,
    note: "Regime de caixa: considera o que foi RECEBIDO no período. A taxa de administração é estimada com a taxa atual da organização sobre os aluguéis recebidos.",
    totals: { rent_cents: sum("rent_cents"), late_fees_cents: sum("late_fees_cents"), other_cents: sum("other_cents"), admin_fee_cents: sum("admin_fee_cents"), maintenance_cents: sum("maintenance_cents"), maintenance_owner_cents: sum("maintenance_owner_cents"), owner_net_cents: sum("owner_net_cents") },
    items,
  });
});

// ------------------------------------------------------------------ Fluxo de caixa

reportsRouter.get("/reports/cashflow", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const list = months(req.query.from, req.query.to);
  if (!list) return void res.status(400).json({ error: `Informe from e to (AAAA-MM), no máximo ${MAX_MONTHS} meses.` });
  const start = `${list[0]}-01`;
  const next = monthRange(list[list.length - 1])!.next;
  const q = (sql: string) => db.query<{ m: string; v: string }>(sql, [orgId, start, next]);
  const [received, transfers, maint, expected, open] = await Promise.all([
    q(`SELECT to_char(received_at,'YYYY-MM') AS m, sum(amount_cents)::text AS v FROM payments WHERE organization_id = $1 AND voided_at IS NULL AND received_at >= $2 AND received_at < $3 GROUP BY 1`),
    q(`SELECT to_char(paid_at,'YYYY-MM') AS m, sum(net_cents)::text AS v FROM owner_transfers WHERE organization_id = $1 AND status = 'pago' AND paid_at >= $2 AND paid_at < $3 GROUP BY 1`),
    q(`SELECT to_char(completed_at AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') AS m, sum(cost_cents)::text AS v FROM maintenance_requests WHERE organization_id = $1 AND status = 'concluida' AND cost_cents > 0 AND NOT charge_owner AND completed_at >= $2 AND completed_at < $3 GROUP BY 1`),
    q(`SELECT to_char(due_date,'YYYY-MM') AS m, sum(amount_cents)::text AS v FROM charges WHERE organization_id = $1 AND cancelled_at IS NULL AND due_date >= $2 AND due_date < $3 GROUP BY 1`),
    q(`SELECT to_char(x.due_date,'YYYY-MM') AS m, sum(x.amount_cents - x.paid_cents)::text AS v FROM (${CHARGE_SELECT} WHERE c.organization_id = $1 AND c.cancelled_at IS NULL AND c.due_date >= $2 AND c.due_date < $3) x WHERE x.status <> 'paga' GROUP BY 1`),
  ]);
  const get = (rows: { m: string; v: string }[], m: string) => Number(rows.find((r) => r.m === m)?.v ?? 0);
  let balance = 0;
  const items = list.map((m) => {
    const inflow = get(received, m);
    const out_transfers = get(transfers, m);
    const out_maint = get(maint, m);
    const net = inflow - out_transfers - out_maint;
    balance += net;
    return { month: m, expected_cents: get(expected, m), still_open_cents: get(open, m), received_cents: inflow, transfers_paid_cents: out_transfers, maintenance_paid_cents: out_maint, net_cents: net, accumulated_cents: balance };
  });
  if (wantsCsv(req.query.format)) {
    return sendCsv(res, "fluxo-de-caixa.csv", ["Mês", "Previsto (vencimentos)", "Ainda em aberto", "Recebido", "Repasses pagos", "Manutenção paga", "Resultado", "Acumulado"],
      items.map((i) => [i.month, reais(i.expected_cents), reais(i.still_open_cents), reais(i.received_cents), reais(i.transfers_paid_cents), reais(i.maintenance_paid_cents), reais(i.net_cents), reais(i.accumulated_cents)]));
  }
  res.json({ from: list[0], to: list[list.length - 1], note: "Caixa: entradas = pagamentos recebidos; saídas = repasses pagos e manutenção paga pela administradora (a cobrada do proprietário já desconta do repasse).", items });
});

// ------------------------------------------------------------------ Informe de rendimentos (proprietário)

export async function ownerIncome(orgId: number, ownerId: number, year: number) {
  const [owner] = await db.query<{ name: string; document: string }>("SELECT name, document FROM owners WHERE id = $1 AND organization_id = $2", [ownerId, orgId]);
  if (!owner) return null;
  const rows = await db.query<{ month: string; gross: number; fee: number; maintenance: number; net: number; status: string; paid_at: string | null }>(
    `SELECT to_char(period,'YYYY-MM') AS month, gross_cents AS gross, fee_cents AS fee, maintenance_cents AS maintenance, net_cents AS net, status, to_char(paid_at,'YYYY-MM-DD') AS paid_at
     FROM owner_transfers WHERE organization_id = $1 AND owner_id = $2 AND period >= $3 AND period < $4 ORDER BY period`,
    [orgId, ownerId, `${year}-01-01`, `${year + 1}-01-01`],
  );
  const total = (k: "gross" | "fee" | "maintenance" | "net") => rows.reduce((s, r) => s + r[k], 0);
  return {
    year, owner, items: rows,
    totals: { gross_cents: total("gross"), fee_cents: total("fee"), maintenance_cents: total("maintenance"), net_cents: total("net"), net_paid_cents: rows.filter((r) => r.status === "pago").reduce((s, r) => s + r.net, 0) },
    note: "Resumo gerencial dos repasses do ano. Para a declaração de imposto, confira com o seu contador.",
  };
}

reportsRouter.get("/reports/owner-income", async (req, res) => {
  const year = Number(req.query.year ?? new Date().getFullYear());
  const ownerId = Number(req.query.owner_id);
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(ownerId)) return void res.status(400).json({ error: "Informe year (AAAA) e owner_id." });
  const data = await ownerIncome(req.auth!.organization.id, ownerId, year);
  if (!data) return void res.status(404).json({ error: "Proprietário não encontrado." });
  if (wantsCsv(req.query.format)) {
    return sendCsv(res, `informe-${year}.csv`, ["Mês", "Aluguéis recebidos", "Taxa de administração", "Manutenção", "Repasse líquido", "Situação", "Pago em"],
      data.items.map((r) => [r.month, reais(r.gross), reais(r.fee), reais(r.maintenance), reais(r.net), r.status, r.paid_at]));
  }
  res.json(data);
});

// ------------------------------------------------------------------ Planilha de apoio da DIMOB

reportsRouter.get("/reports/dimob", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const year = Number(req.query.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return void res.status(400).json({ error: "Informe year (AAAA)." });
  const leases = await db.query<{ id: number; start_date: string; end_date: string; property: string; address: string; owners: string | null; tenants: string | null }>(
    `SELECT l.id, to_char(l.start_date,'YYYY-MM-DD') AS start_date, to_char(l.end_date,'YYYY-MM-DD') AS end_date, pr.name AS property,
            concat_ws(', ', pr.street, pr.number, pr.complement, pr.neighborhood, pr.city || '/' || pr.state, pr.zip) AS address,
            (SELECT string_agg(o.name || ' (' || o.document || ')', '; ') FROM property_owners po JOIN owners o ON o.id = po.owner_id WHERE po.property_id = pr.id) AS owners,
            (SELECT string_agg(t.name || ' (' || t.document || ')', '; ' ORDER BY lt.position) FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id WHERE lt.lease_id = l.id) AS tenants
     FROM leases l JOIN units u ON u.id = l.unit_id JOIN properties pr ON pr.id = u.property_id
     WHERE l.organization_id = $1 AND l.status <> 'rascunho' AND l.start_date < $3 AND l.end_date >= $2 ORDER BY pr.name, l.id`,
    [orgId, `${year}-01-01`, `${year + 1}-01-01`],
  );
  const paid = await db.query<{ lease_id: number; m: string; v: string }>(
    `SELECT c.lease_id, to_char(p.received_at,'MM') AS m, sum(pa.amount_cents)::text AS v FROM payment_allocations pa
     JOIN payments p ON p.id = pa.payment_id JOIN charges c ON c.id = pa.charge_id
     WHERE p.organization_id = $1 AND p.voided_at IS NULL AND c.kind = 'aluguel' AND p.received_at >= $2 AND p.received_at < $3 GROUP BY 1, 2`,
    [orgId, `${year}-01-01`, `${year + 1}-01-01`],
  );
  const items = leases.map((l) => {
    const monthly = Array.from({ length: 12 }, (_, i) => Number(paid.find((p) => p.lease_id === l.id && p.m === String(i + 1).padStart(2, "0"))?.v ?? 0));
    return { ...l, monthly_cents: monthly, total_cents: monthly.reduce((s, v) => s + v, 0) };
  });
  if (wantsCsv(req.query.format)) {
    const mm = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
    return sendCsv(res, `dimob-apoio-${year}.csv`, ["Contrato", "Locador(es)", "Locatário(s)", "Imóvel", "Endereço", "Início", "Fim", ...mm, "Total"],
      items.map((i) => [i.id, i.owners, i.tenants, i.property, i.address, i.start_date, i.end_date, ...i.monthly_cents.map(reais), reais(i.total_cents)]));
  }
  res.json({ year, note: "Planilha de apoio com os aluguéis RECEBIDOS por contrato e mês. Não é o arquivo oficial da DIMOB.", items });
});

// ------------------------------------------------------------------ Indicadores (KPIs)

reportsRouter.get("/reports/kpis", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const n = Math.min(Math.max(Number(req.query.months) || 6, 2), 24);
  const [{ cur }] = (await db.query<{ cur: string }>("SELECT to_char((now() AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM') AS cur")) as [{ cur: string }];
  const list: string[] = [];
  let y = Number(cur.slice(0, 4));
  let m = Number(cur.slice(5, 7));
  for (let i = 0; i < n; i++) {
    list.unshift(`${y}-${String(m).padStart(2, "0")}`);
    m--;
    if (m < 1) { m = 12; y--; }
  }
  const start = `${list[0]}-01`;
  const next = monthRange(list[list.length - 1])!.next;
  const [units] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM units WHERE organization_id = $1", [orgId]);
  const series = await db.query<Record<string, string>>(
    `SELECT mo.m,
       (SELECT COALESCE(sum(amount_cents),0) FROM charges WHERE organization_id = $1 AND cancelled_at IS NULL AND to_char(due_date,'YYYY-MM') = mo.m)::text AS expected,
       (SELECT COALESCE(sum(amount_cents),0) FROM payments WHERE organization_id = $1 AND voided_at IS NULL AND to_char(received_at,'YYYY-MM') = mo.m)::text AS received,
       (SELECT count(*) FROM leases l WHERE l.organization_id = $1 AND l.status IN ('vigente','encerrado','rescindido') AND l.start_date < (to_date(mo.m || '-01','YYYY-MM-DD') + interval '1 month') AND l.end_date >= (to_date(mo.m || '-01','YYYY-MM-DD') + interval '1 month' - interval '1 day'))::text AS occupied,
       (SELECT count(*) FROM leases WHERE organization_id = $1 AND status <> 'rascunho' AND to_char(start_date,'YYYY-MM') = mo.m)::text AS new_leases,
       (SELECT count(*) FROM maintenance_requests WHERE organization_id = $1 AND to_char(created_at AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') = mo.m)::text AS maint_opened,
       (SELECT count(*) FROM maintenance_requests WHERE organization_id = $1 AND status = 'concluida' AND to_char(completed_at AT TIME ZONE 'America/Sao_Paulo','YYYY-MM') = mo.m)::text AS maint_done
     FROM unnest($2::text[]) AS mo(m) ORDER BY mo.m`,
    [orgId, list],
  );
  const [mttr] = await db.query<{ hours: string | null }>(
    "SELECT round(avg(extract(epoch FROM completed_at - created_at) / 3600))::text AS hours FROM maintenance_requests WHERE organization_id = $1 AND status = 'concluida' AND completed_at >= $2",
    [orgId, start],
  );
  const overdue = await db.query<{ v: string }>(`SELECT COALESCE(sum(x.amount_cents - x.paid_cents),0)::text AS v FROM (${CHARGE_SELECT} WHERE c.organization_id = $1 AND c.cancelled_at IS NULL) x WHERE x.status = 'vencida'`, [orgId]);
  const items = series.map((s) => {
    const expected = Number(s.expected);
    const received = Number(s.received);
    return {
      month: s.m, expected_cents: expected, received_cents: received,
      collection_ratio: expected > 0 ? Math.round((received / expected) * 1000) / 10 : null,
      occupancy_ratio: units!.n > 0 ? Math.round((Number(s.occupied) / units!.n) * 1000) / 10 : null,
      new_leases: Number(s.new_leases), maintenance_opened: Number(s.maint_opened), maintenance_done: Number(s.maint_done),
    };
  });
  const last = items[items.length - 1]!;
  const prev = items[items.length - 2]!;
  res.json({
    months: list, items, units_total: units!.n, overdue_cents: Number(overdue[0]!.v),
    avg_maintenance_hours: mttr!.hours === null ? null : Number(mttr!.hours),
    received_change_ratio: prev.received_cents > 0 ? Math.round(((last.received_cents - prev.received_cents) / prev.received_cents) * 1000) / 10 : null,
    since: start, until: next,
  });
});

// ------------------------------------------------------------------ Área do proprietário

export const ownerReportsRouter = Router();

/** O proprietário vê o próprio informe de rendimentos (repasses do ano). */
ownerReportsRouter.get("/portal/owner/income", requireAuth, async (req, res) => {
  const a = req.auth!;
  if (a.role !== "proprietario" || !a.ownerId) return void res.status(a.role === "proprietario" ? 409 : 403).json({ error: a.role === "proprietario" ? "Seu acesso ainda não está vinculado a um cadastro de proprietário." : "Sem permissão" });
  const year = Number(req.query.year ?? new Date().getFullYear());
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return void res.status(400).json({ error: "year inválido" });
  res.json(await ownerIncome(a.organization.id, a.ownerId, year));
});
