import { Router, type Request } from "express";
import { db, transaction } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";
import { isRealDate, parseId } from "./crud.js";
import { brToday } from "./finance.js";
import { formatPhone } from "./brFormat.js";
import { formatBRL } from "./contractTemplate.js";
import { notify, tenantUsersOfLease } from "./notifications.js";
import { periodicJobs } from "./reminders.js";
import { tenantGuard, MY_LEASES } from "./portal.js";

/**
 * Operação 2: prestadores (com avaliação e comparativo de orçamentos), manutenção preventiva recorrente, enquetes e
 * ocorrências com notificação, contestação e multa opcional.
 */
export const opsRouter = Router();
const staff = [requireAuth, requireRole("admin", "colaborador")];
const MAINT_CATEGORIES = ["hidraulica", "eletrica", "estrutural", "pintura", "fechaduras", "eletrodomesticos", "pragas", "outro"] as const;
const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, max) : null);
const INT4_MAX = 2_147_483_647;

// ================================================================= Prestadores

const PROVIDER_SELECT = `SELECT p.id, p.name, p.document, p.phone, p.email, p.categories, p.notes, p.active, p.created_at,
  (SELECT round(avg(r.rating)::numeric, 1)::float8 FROM provider_reviews r WHERE r.provider_id = p.id) AS rating,
  (SELECT count(*)::int FROM provider_reviews r WHERE r.provider_id = p.id) AS reviews,
  (SELECT count(*)::int FROM maintenance_quotes q WHERE q.provider_id = p.id AND q.status = 'aprovado') AS jobs_approved
  FROM providers p`;

function providerValues(b: Record<string, unknown>, partial: boolean): Record<string, unknown> | string {
  const out: Record<string, unknown> = {};
  if (!partial || b.name !== undefined) { const n = text(b.name, 120); if (!n || n.length < 2) return "Informe o nome."; out.name = n; }
  if (b.document !== undefined) { const d = typeof b.document === "string" ? b.document.replace(/\D/g, "") : ""; if (d && d.length !== 11 && d.length !== 14) return "CPF/CNPJ inválido."; out.document = d || null; }
  if (b.phone !== undefined) {
    const raw = text(b.phone, 30);
    let d = raw ? raw.replace(/\D/g, "") : "";
    if (d.length > 11 && d.startsWith("55")) d = d.slice(2);
    if (raw && d.length !== 10 && d.length !== 11) return "Telefone inválido.";
    out.phone = raw ? formatPhone(d) : null;
  }
  if (b.email !== undefined) { const e = text(b.email, 200); if (e && !/^\S+@\S+\.\S+$/.test(e)) return "E-mail inválido."; out.email = e?.toLowerCase() ?? null; }
  if (b.categories !== undefined) {
    const list = (Array.isArray(b.categories) ? b.categories : String(b.categories).split(",")).map((c) => String(c).trim()).filter(Boolean);
    if (list.some((c) => !MAINT_CATEGORIES.includes(c as never))) return `Categorias válidas: ${MAINT_CATEGORIES.join(", ")}.`;
    out.categories = [...new Set(list)].join(",");
  }
  if (b.notes !== undefined) out.notes = text(b.notes, 500);
  if (b.active !== undefined) { if (typeof b.active !== "boolean") return "active deve ser true/false."; out.active = b.active; }
  return out;
}

opsRouter.get("/providers", ...staff, async (req, res) => {
  const category = MAINT_CATEGORIES.includes(req.query.category as never) ? String(req.query.category) : null;
  const items = await db.query(`${PROVIDER_SELECT} WHERE p.organization_id = $1 AND ($2::text IS NULL OR p.categories LIKE '%' || $2 || '%') ${req.query.all === "1" ? "" : "AND p.active"} ORDER BY p.name`, [req.auth!.organization.id, category]);
  res.json({ items });
});

opsRouter.post("/providers", ...staff, async (req, res) => {
  const v = providerValues(req.body ?? {}, false);
  if (typeof v === "string") return void res.status(400).json({ error: v });
  const [row] = await db.query<{ id: number }>("INSERT INTO providers (organization_id, name, document, phone, email, categories, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id", [req.auth!.organization.id, v.name, v.document ?? null, v.phone ?? null, v.email ?? null, v.categories ?? "", v.notes ?? null]);
  res.status(201).json({ item: (await db.query(`${PROVIDER_SELECT} WHERE p.id = $1`, [row!.id]))[0] });
});

opsRouter.patch("/providers/:id", ...staff, async (req, res) => {
  const id = parseId(req.params.id);
  const v = providerValues(req.body ?? {}, true);
  if (typeof v === "string") return void res.status(400).json({ error: v });
  const keys = Object.keys(v);
  if (keys.length === 0) return void res.status(400).json({ error: "Nada para alterar." });
  const done = id ? await db.query(`UPDATE providers SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(", ")} WHERE id = $1 AND organization_id = $2 RETURNING id`, [id, req.auth!.organization.id, ...keys.map((k) => v[k])]) : [];
  if (done.length === 0) return void res.status(404).json({ error: "Prestador não encontrado." });
  res.json({ item: (await db.query(`${PROVIDER_SELECT} WHERE p.id = $1`, [id]))[0] });
});

opsRouter.delete("/providers/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = parseId(req.params.id);
  const done = id ? await db.query("DELETE FROM providers WHERE id = $1 AND organization_id = $2 RETURNING id", [id, req.auth!.organization.id]) : [];
  if (done.length === 0) return void res.status(404).json({ error: "Prestador não encontrado." });
  res.status(204).end();
});

/** Liga o orçamento a um prestador cadastrado (e usa o nome dele como fornecedor, se `supplier` não vier). */
opsRouter.post("/maintenance/:id/quotes/:quoteId/provider", ...staff, async (req, res) => {
  const orgId = req.auth!.organization.id;
  const quoteId = parseId(req.params.quoteId);
  const providerId = parseId(req.body?.provider_id);
  const [p] = providerId ? await db.query("SELECT 1 FROM providers WHERE id = $1 AND organization_id = $2", [providerId, orgId]) : [];
  if (!p) return void res.status(400).json({ error: "Prestador inválido." });
  const done = quoteId ? await db.query("UPDATE maintenance_quotes SET provider_id = $3 WHERE id = $1 AND organization_id = $2 AND request_id = $4 RETURNING id", [quoteId, orgId, providerId, parseId(req.params.id)]) : [];
  if (done.length === 0) return void res.status(404).json({ error: "Orçamento não encontrado." });
  res.status(204).end();
});

/** Comparativo de orçamentos do chamado: menor valor primeiro, com nota do prestador e serviços já aprovados com ele. */
opsRouter.get("/maintenance/:id/quotes/compare", ...staff, async (req, res) => {
  const id = parseId(req.params.id);
  const items = id
    ? await db.query(
        `SELECT q.id, q.supplier, q.amount_cents, q.status, q.notes, q.provider_id, p.name AS provider_name,
                (SELECT round(avg(r.rating)::numeric, 1)::float8 FROM provider_reviews r WHERE r.provider_id = q.provider_id) AS rating,
                (SELECT count(*)::int FROM maintenance_quotes x WHERE x.provider_id = q.provider_id AND x.status = 'aprovado') AS jobs_approved
         FROM maintenance_quotes q LEFT JOIN providers p ON p.id = q.provider_id
         WHERE q.request_id = $1 AND q.organization_id = $2 ORDER BY q.amount_cents, q.id`,
        [id, req.auth!.organization.id],
      )
    : [];
  const amounts = (items as { amount_cents: number }[]).map((i) => i.amount_cents);
  res.json({ items, cheapest_cents: amounts[0] ?? null, spread_cents: amounts.length > 1 ? amounts[amounts.length - 1]! - amounts[0]! : 0 });
});

opsRouter.post("/providers/:id/reviews", ...staff, async (req, res) => {
  const orgId = req.auth!.organization.id;
  const id = parseId(req.params.id);
  const rating = req.body?.rating;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return void res.status(400).json({ error: "rating deve ser de 1 a 5." });
  const [p] = id ? await db.query("SELECT 1 FROM providers WHERE id = $1 AND organization_id = $2", [id, orgId]) : [];
  if (!p) return void res.status(404).json({ error: "Prestador não encontrado." });
  const requestId = req.body?.request_id ? parseId(req.body.request_id) : null;
  if (req.body?.request_id) {
    const [m] = requestId ? await db.query("SELECT 1 FROM maintenance_requests WHERE id = $1 AND organization_id = $2 AND status = 'concluida'", [requestId, orgId]) : [];
    if (!m) return void res.status(400).json({ error: "Só se avalia o serviço de um chamado concluído." });
  }
  try {
    await db.query("INSERT INTO provider_reviews (organization_id, provider_id, request_id, rating, comment, created_by) VALUES ($1,$2,$3,$4,$5,$6)", [orgId, id, requestId, rating, text(req.body?.comment, 500), req.auth!.user.id]);
  } catch {
    return void res.status(409).json({ error: "Este chamado já foi avaliado para este prestador." });
  }
  res.status(201).json({ item: (await db.query(`${PROVIDER_SELECT} WHERE p.id = $1`, [id]))[0] });
});

opsRouter.get("/providers/:id/reviews", ...staff, async (req, res) => {
  const id = parseId(req.params.id);
  const items = id ? await db.query("SELECT r.id, r.rating, r.comment, r.created_at, r.request_id, u.name AS by_name FROM provider_reviews r LEFT JOIN users u ON u.id = r.created_by WHERE r.provider_id = $1 AND r.organization_id = $2 ORDER BY r.id DESC LIMIT 100", [id, req.auth!.organization.id]) : [];
  res.json({ items });
});

// ================================================================= Manutenção preventiva recorrente

const PLAN_SELECT = `SELECT mp.id, mp.unit_id, mp.title, mp.category, mp.description, mp.priority, mp.interval_months, to_char(mp.next_due,'YYYY-MM-DD') AS next_due, mp.lead_days, mp.active,
  mp.assigned_to, to_char(mp.last_generated_for,'YYYY-MM-DD') AS last_generated_for, u.identifier AS unit_identifier, pr.name AS property_name, au.name AS assigned_name
  FROM maintenance_plans mp JOIN units u ON u.id = mp.unit_id JOIN properties pr ON pr.id = u.property_id LEFT JOIN users au ON au.id = mp.assigned_to`;

async function planValues(orgId: number, b: Record<string, unknown>, partial: boolean): Promise<Record<string, unknown> | string> {
  const out: Record<string, unknown> = {};
  if (!partial || b.unit_id !== undefined) { const u = parseId(b.unit_id); const [ok] = u ? await db.query("SELECT 1 FROM units WHERE id = $1 AND organization_id = $2", [u, orgId]) : []; if (!ok) return "Unidade inválida."; out.unit_id = u; }
  if (!partial || b.title !== undefined) { const t = text(b.title, 150); if (!t || t.length < 3) return "Informe o título (3+ letras)."; out.title = t; }
  if (!partial || b.category !== undefined) { if (!MAINT_CATEGORIES.includes(b.category as never)) return "Categoria inválida."; out.category = b.category; }
  if (!partial || b.description !== undefined) { const d = text(b.description, 1000); if (!d) return "Informe a descrição do serviço."; out.description = d; }
  if (b.priority !== undefined) { if (!["baixa", "media", "alta", "urgente"].includes(b.priority as string)) return "Prioridade inválida."; out.priority = b.priority; }
  if (!partial || b.interval_months !== undefined) { if (!Number.isInteger(b.interval_months) || (b.interval_months as number) < 1 || (b.interval_months as number) > 60) return "interval_months deve ser de 1 a 60."; out.interval_months = b.interval_months; }
  if (!partial || b.next_due !== undefined) { if (typeof b.next_due !== "string" || !isRealDate(b.next_due)) return "next_due inválida (AAAA-MM-DD)."; out.next_due = b.next_due; }
  if (b.lead_days !== undefined) { if (!Number.isInteger(b.lead_days) || (b.lead_days as number) < 0 || (b.lead_days as number) > 60) return "lead_days deve ser de 0 a 60."; out.lead_days = b.lead_days; }
  if (b.active !== undefined) { if (typeof b.active !== "boolean") return "active deve ser true/false."; out.active = b.active; }
  if (b.assigned_to !== undefined) {
    if (b.assigned_to === null) out.assigned_to = null;
    else { const a = parseId(b.assigned_to); const [ok] = a ? await db.query("SELECT 1 FROM organization_members WHERE user_id = $1 AND organization_id = $2 AND role IN ('admin','colaborador')", [a, orgId]) : []; if (!ok) return "Responsável inválido."; out.assigned_to = a; }
  }
  return out;
}

opsRouter.get("/maintenance-plans", ...staff, async (req, res) => {
  res.json({ items: await db.query(`${PLAN_SELECT} WHERE mp.organization_id = $1 ORDER BY mp.active DESC, mp.next_due LIMIT 300`, [req.auth!.organization.id]) });
});

opsRouter.post("/maintenance-plans", ...staff, async (req, res) => {
  const orgId = req.auth!.organization.id;
  const v = await planValues(orgId, req.body ?? {}, false);
  if (typeof v === "string") return void res.status(400).json({ error: v });
  const [row] = await db.query<{ id: number }>(
    `INSERT INTO maintenance_plans (organization_id, unit_id, title, category, description, priority, interval_months, next_due, lead_days, assigned_to, created_by)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6,'media'),$7,$8,COALESCE($9,7),$10,$11) RETURNING id`,
    [orgId, v.unit_id, v.title, v.category, v.description, v.priority ?? null, v.interval_months, v.next_due, v.lead_days ?? null, v.assigned_to ?? null, req.auth!.user.id],
  );
  res.status(201).json({ item: (await db.query(`${PLAN_SELECT} WHERE mp.id = $1`, [row!.id]))[0] });
});

opsRouter.patch("/maintenance-plans/:id", ...staff, async (req, res) => {
  const orgId = req.auth!.organization.id;
  const id = parseId(req.params.id);
  const v = await planValues(orgId, req.body ?? {}, true);
  if (typeof v === "string") return void res.status(400).json({ error: v });
  const keys = Object.keys(v);
  if (keys.length === 0) return void res.status(400).json({ error: "Nada para alterar." });
  const done = id ? await db.query(`UPDATE maintenance_plans SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(", ")} WHERE id = $1 AND organization_id = $2 RETURNING id`, [id, orgId, ...keys.map((k) => v[k])]) : [];
  if (done.length === 0) return void res.status(404).json({ error: "Plano não encontrado." });
  res.json({ item: (await db.query(`${PLAN_SELECT} WHERE mp.id = $1`, [id]))[0] });
});

opsRouter.delete("/maintenance-plans/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = parseId(req.params.id);
  const done = id ? await db.query("DELETE FROM maintenance_plans WHERE id = $1 AND organization_id = $2 RETURNING id", [id, req.auth!.organization.id]) : [];
  if (done.length === 0) return void res.status(404).json({ error: "Plano não encontrado." });
  res.status(204).end();
});

const addMonths = (date: string, n: number): string => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
};

/** Abre os chamados preventivos que já entraram na antecedência e agenda a próxima data. Idempotente por (plano, vencimento). */
export async function runMaintenancePlans(today = brToday()): Promise<number> {
  const due = await db.query<{ id: number }>(
    "SELECT id FROM maintenance_plans WHERE active AND next_due - lead_days <= $1::date AND last_generated_for IS DISTINCT FROM next_due ORDER BY id",
    [today],
  );
  let created = 0;
  for (const p of due) {
    const ok = await transaction(async (tx) => {
      const [plan] = await tx.query<{ organization_id: number; unit_id: number; title: string; category: string; description: string; priority: string; interval_months: number; next_due: string; assigned_to: number | null; last_generated_for: string | null; lead_days: number }>(
        "SELECT organization_id, unit_id, title, category, description, priority, interval_months, to_char(next_due,'YYYY-MM-DD') AS next_due, assigned_to, to_char(last_generated_for,'YYYY-MM-DD') AS last_generated_for, lead_days FROM maintenance_plans WHERE id = $1 FOR UPDATE",
        [p.id],
      );
      if (!plan || plan.last_generated_for === plan.next_due) return false;
      const [lease] = await tx.query<{ id: number }>("SELECT id FROM leases WHERE unit_id = $1 AND status = 'vigente' LIMIT 1", [plan.unit_id]);
      await tx.query(
        `INSERT INTO maintenance_requests (organization_id, unit_id, lease_id, category, title, description, priority, assigned_to, plan_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [plan.organization_id, plan.unit_id, lease?.id ?? null, plan.category, `[Preventiva] ${plan.title}`, `${plan.description}\n\nPrevisto para ${plan.next_due.split("-").reverse().join("/")}.`, plan.priority, plan.assigned_to, p.id],
      );
      // Avança para a próxima data futura (se o sistema ficou parado, não gera vários de uma vez).
      let next = addMonths(plan.next_due, plan.interval_months);
      while (next <= today) next = addMonths(next, plan.interval_months);
      await tx.query("UPDATE maintenance_plans SET last_generated_for = next_due, next_due = $2 WHERE id = $1", [p.id, next]);
      if (plan.assigned_to) await notify(plan.organization_id, [plan.assigned_to], { category: "manutencao", kind: "preventive", title: "Manutenção preventiva a executar", body: `${plan.title} — previsto para ${plan.next_due.split("-").reverse().join("/")}.` }, tx);
      return true;
    });
    if (ok) created++;
  }
  return created;
}
periodicJobs.push({ name: "manutenção preventiva", run: () => runMaintenancePlans() });

// ================================================================= Enquetes

async function audienceUsers(orgId: number, audience: string, propertyId: number | null): Promise<number[]> {
  const rows = await db.query<{ user_id: number }>(
    `SELECT DISTINCT m.user_id FROM organization_members m
     WHERE m.organization_id = $1 AND (
       ($2 IN ('todos','inquilinos') AND m.role = 'inquilino' AND ($3::int IS NULL OR EXISTS (
          SELECT 1 FROM lease_tenants lt JOIN leases l ON l.id = lt.lease_id JOIN units u ON u.id = l.unit_id
          WHERE lt.tenant_id = m.tenant_id AND l.status = 'vigente' AND u.property_id = $3)))
       OR ($2 IN ('todos','proprietarios') AND m.role = 'proprietario' AND ($3::int IS NULL OR EXISTS (
          SELECT 1 FROM property_owners po WHERE po.owner_id = m.owner_id AND po.property_id = $3))))`,
    [orgId, audience, propertyId],
  );
  return rows.map((r) => r.user_id);
}

async function pollResults(pollId: number, showVoters: boolean) {
  const options = await db.query<{ id: number; label: string; votes: number }>(
    "SELECT o.id, o.label, (SELECT count(*)::int FROM poll_votes v WHERE v.option_id = o.id) AS votes FROM poll_options o WHERE o.poll_id = $1 ORDER BY o.position",
    [pollId],
  );
  const total = options.reduce((s, o) => s + o.votes, 0);
  const voters = showVoters ? await db.query("SELECT v.option_id, u.name, v.voted_at FROM poll_votes v JOIN users u ON u.id = v.user_id WHERE v.poll_id = $1 ORDER BY v.voted_at", [pollId]) : undefined;
  return { total_votes: total, options: options.map((o) => ({ ...o, percent: total > 0 ? Math.round((o.votes / total) * 1000) / 10 : 0 })), voters };
}

/** Encerra as enquetes cujo prazo passou. */
export async function closeExpiredPolls(): Promise<number> {
  return (await db.query("UPDATE polls SET status = 'encerrada' WHERE status = 'aberta' AND closes_at IS NOT NULL AND closes_at <= now() RETURNING id")).length;
}
periodicJobs.push({ name: "encerrar enquetes vencidas", run: () => closeExpiredPolls() });

opsRouter.post("/polls", ...staff, async (req, res) => {
  const orgId = req.auth!.organization.id;
  const b = req.body ?? {};
  const question = text(b.question, 200);
  const options = (Array.isArray(b.options) ? b.options : []).map((o: unknown) => text(o, 100)).filter(Boolean) as string[];
  if (!question || question.length < 5) return void res.status(400).json({ error: "Informe a pergunta (5+ letras)." });
  if (options.length < 2 || options.length > 10 || new Set(options.map((o) => o.toLowerCase())).size !== options.length) return void res.status(400).json({ error: "Informe de 2 a 10 opções diferentes." });
  if (!["todos", "inquilinos", "proprietarios"].includes(b.audience)) return void res.status(400).json({ error: "audience deve ser todos, inquilinos ou proprietarios." });
  let propertyId: number | null = null;
  if (b.property_id !== undefined && b.property_id !== null) {
    propertyId = parseId(b.property_id) ?? null;
    const [p] = propertyId ? await db.query("SELECT 1 FROM properties WHERE id = $1 AND organization_id = $2", [propertyId, orgId]) : [];
    if (!p) return void res.status(400).json({ error: "Imóvel inválido." });
  }
  let closes: string | null = null;
  if (b.closes_at !== undefined && b.closes_at !== null) {
    const d = new Date(String(b.closes_at));
    if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now() || d.getTime() > Date.now() + 366 * 86_400_000) return void res.status(400).json({ error: "closes_at deve ser uma data futura (até 1 ano)." });
    closes = d.toISOString();
  }
  const poll = await transaction(async (tx) => {
    const [p] = await tx.query<{ id: number }>("INSERT INTO polls (organization_id, question, description, audience, property_id, anonymous, closes_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id", [orgId, question, text(b.description, 500), b.audience, propertyId, b.anonymous === true, closes, req.auth!.user.id]);
    for (let i = 0; i < options.length; i++) await tx.query("INSERT INTO poll_options (poll_id, label, position) VALUES ($1,$2,$3)", [p!.id, options[i], i]);
    return p!;
  });
  const users = await audienceUsers(orgId, b.audience, propertyId);
  await notify(orgId, users, { category: "comunicado", kind: "poll", title: "Nova enquete", body: question, linkKind: "poll", linkId: poll.id });
  res.status(201).json({ id: poll.id, recipients: users.length });
});

opsRouter.get("/polls", ...staff, async (req, res) => {
  const items = await db.query(
    `SELECT p.id, p.question, p.audience, p.anonymous, p.closes_at, p.status, p.created_at, pr.name AS property_name,
            (SELECT count(*)::int FROM poll_votes v WHERE v.poll_id = p.id) AS votes
     FROM polls p LEFT JOIN properties pr ON pr.id = p.property_id WHERE p.organization_id = $1 ORDER BY p.id DESC LIMIT 100`,
    [req.auth!.organization.id],
  );
  res.json({ items });
});

opsRouter.get("/polls/:id", ...staff, async (req, res) => {
  const id = parseId(req.params.id);
  const [p] = id ? await db.query<{ anonymous: boolean }>("SELECT * FROM polls WHERE id = $1 AND organization_id = $2", [id, req.auth!.organization.id]) : [];
  if (!p) return void res.status(404).json({ error: "Enquete não encontrada." });
  res.json({ item: p, ...(await pollResults(id!, !p.anonymous)) });
});

opsRouter.post("/polls/:id/close", ...staff, async (req, res) => {
  const id = parseId(req.params.id);
  const done = id ? await db.query("UPDATE polls SET status = 'encerrada' WHERE id = $1 AND organization_id = $2 AND status = 'aberta' RETURNING id", [id, req.auth!.organization.id]) : [];
  if (done.length === 0) return void res.status(409).json({ error: "Enquete não encontrada ou já encerrada." });
  res.json({ ok: true });
});

opsRouter.delete("/polls/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = parseId(req.params.id);
  const done = id ? await db.query("DELETE FROM polls WHERE id = $1 AND organization_id = $2 RETURNING id", [id, req.auth!.organization.id]) : [];
  if (done.length === 0) return void res.status(404).json({ error: "Enquete não encontrada." });
  res.status(204).end();
});

/** Enquetes em que a pessoa pode votar (inquilino ou proprietário do público-alvo). */
async function clientPolls(req: Request) {
  const a = req.auth!;
  if (!["inquilino", "proprietario"].includes(a.role)) return null;
  await closeExpiredPolls();
  const all = await db.query<{ id: number; question: string; description: string | null; audience: string; anonymous: boolean; closes_at: string | null; status: string; property_id: number | null }>(
    "SELECT id, question, description, audience, anonymous, closes_at, status, property_id FROM polls WHERE organization_id = $1 ORDER BY id DESC LIMIT 100",
    [a.organization.id],
  );
  const mine = new Set((await audienceUsersCached(a.organization.id, all)).filter(([, users]) => users.includes(a.user.id)).map(([id]) => id));
  return all.filter((p) => mine.has(p.id));
}
async function audienceUsersCached(orgId: number, polls: { id: number; audience: string; property_id: number | null }[]): Promise<[number, number[]][]> {
  const out: [number, number[]][] = [];
  for (const p of polls) out.push([p.id, await audienceUsers(orgId, p.audience, p.property_id)]);
  return out;
}

opsRouter.get("/portal/polls", requireAuth, async (req, res) => {
  const polls = await clientPolls(req);
  if (!polls) return void res.status(403).json({ error: "Sem permissão" });
  const items = [];
  for (const p of polls) {
    const [vote] = await db.query<{ option_id: number }>("SELECT option_id FROM poll_votes WHERE poll_id = $1 AND user_id = $2", [p.id, req.auth!.user.id]);
    const open = p.status === "aberta";
    const options = await db.query<{ id: number; label: string }>("SELECT id, label FROM poll_options WHERE poll_id = $1 ORDER BY position", [p.id]);
    // Resultado só depois de votar ou quando a enquete encerra; votantes nunca aparecem para clientes.
    const results = vote || !open ? await pollResults(p.id, false) : null;
    items.push({ id: p.id, question: p.question, description: p.description, anonymous: p.anonymous, closes_at: p.closes_at, status: p.status, my_vote: vote?.option_id ?? null, options, results });
  }
  res.json({ items });
});

opsRouter.post("/portal/polls/:id/vote", requireAuth, async (req, res) => {
  const polls = await clientPolls(req);
  if (!polls) return void res.status(403).json({ error: "Sem permissão" });
  const id = parseId(req.params.id);
  const poll = polls.find((p) => p.id === id);
  if (!poll) return void res.status(404).json({ error: "Enquete não encontrada." });
  if (poll.status !== "aberta") return void res.status(409).json({ error: "Esta enquete já foi encerrada." });
  const optionId = parseId(req.body?.option_id);
  const [opt] = optionId ? await db.query("SELECT 1 FROM poll_options WHERE id = $1 AND poll_id = $2", [optionId, id]) : [];
  if (!opt) return void res.status(400).json({ error: "Opção inválida." });
  const ins = await db.query("INSERT INTO poll_votes (poll_id, user_id, option_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING poll_id", [id, req.auth!.user.id, optionId]);
  if (ins.length === 0) return void res.status(409).json({ error: "Você já votou nesta enquete." });
  res.status(201).json(await pollResults(id!, false));
});

// ================================================================= Ocorrências e multas

const INCIDENT_CATEGORIES = ["barulho", "animais", "dano", "lixo", "estacionamento", "outro"] as const;
const INCIDENT_SELECT = `SELECT i.id, i.unit_id, i.lease_id, i.category, i.description, i.occurred_at, i.status, i.fine_cents, i.fine_charge_id, i.contestation, i.contested_at, i.resolution_note, i.created_at,
  u.identifier AS unit_identifier, p.name AS property_name,
  (SELECT string_agg(t.name, ', ' ORDER BY lt.position) FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id WHERE lt.lease_id = i.lease_id) AS tenant_names
  FROM incidents i JOIN units u ON u.id = i.unit_id JOIN properties p ON p.id = u.property_id`;

opsRouter.get("/incidents", ...staff, async (req, res) => {
  const status = ["registrada", "notificada", "multada", "arquivada"].includes(String(req.query.status)) ? String(req.query.status) : null;
  res.json({ items: await db.query(`${INCIDENT_SELECT} WHERE i.organization_id = $1 AND ($2::text IS NULL OR i.status = $2) ORDER BY i.occurred_at DESC LIMIT 300`, [req.auth!.organization.id, status]) });
});

opsRouter.post("/incidents", ...staff, async (req, res) => {
  const orgId = req.auth!.organization.id;
  const b = req.body ?? {};
  const unitId = parseId(b.unit_id);
  const [unit] = unitId ? await db.query("SELECT 1 FROM units WHERE id = $1 AND organization_id = $2", [unitId, orgId]) : [];
  const description = text(b.description, 1000);
  const when = new Date(String(b.occurred_at ?? new Date().toISOString()));
  if (!unit || !INCIDENT_CATEGORIES.includes(b.category) || !description || description.length < 5 || Number.isNaN(when.getTime()) || when.getTime() > Date.now() + 60_000) {
    return void res.status(400).json({ error: "Informe unit_id, category, description (5+ letras) e occurred_at (não pode ser futuro)." });
  }
  const [lease] = await db.query<{ id: number }>("SELECT id FROM leases WHERE unit_id = $1 AND organization_id = $2 AND status = 'vigente' LIMIT 1", [unitId, orgId]);
  const [row] = await db.query<{ id: number }>("INSERT INTO incidents (organization_id, unit_id, lease_id, category, description, occurred_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id", [orgId, unitId, lease?.id ?? null, b.category, description, when.toISOString(), req.auth!.user.id]);
  res.status(201).json({ item: (await db.query(`${INCIDENT_SELECT} WHERE i.id = $1`, [row!.id]))[0] });
});

async function incidentTransition(req: Request, from: string[], to: string, note: string | null = null): Promise<{ code: number; error?: string; item?: unknown; leaseId?: number | null }> {
  const id = parseId(req.params.id);
  const rows = id ? await db.query<{ lease_id: number | null }>("UPDATE incidents SET status = $3, resolution_note = COALESCE($5, resolution_note), updated_at = now() WHERE id = $1 AND organization_id = $2 AND status = ANY($4::text[]) RETURNING lease_id", [id, req.auth!.organization.id, to, from, note]) : [];
  if (rows.length === 0) return { code: 409, error: "Ocorrência não encontrada ou não está na etapa certa." };
  return { code: 200, item: (await db.query(`${INCIDENT_SELECT} WHERE i.id = $1`, [id]))[0], leaseId: rows[0]!.lease_id };
}

/** Notifica o morador: a partir daqui ele vê a ocorrência e pode contestar. */
opsRouter.post("/incidents/:id/notify", ...staff, async (req, res) => {
  const r = await incidentTransition(req, ["registrada"], "notificada");
  if (r.code !== 200) return void res.status(r.code).json({ error: r.error });
  const item = r.item as { id: number; category: string; description: string };
  await notify(req.auth!.organization.id, await tenantUsersOfLease(r.leaseId ?? null), { category: "ocorrencia", kind: "incident", title: `Ocorrência registrada (${item.category})`, body: item.description.slice(0, 300), linkKind: "incident", linkId: item.id });
  res.json({ item });
});

opsRouter.post("/incidents/:id/fine", ...staff, async (req, res) => {
  const orgId = req.auth!.organization.id;
  const id = parseId(req.params.id);
  const amount = req.body?.amount_cents;
  if (!Number.isInteger(amount) || amount < 1 || amount > INT4_MAX) return void res.status(400).json({ error: "amount_cents inválido (centavos)." });
  const due = req.body?.due_date === undefined ? brToday() : String(req.body.due_date);
  if (!isRealDate(due)) return void res.status(400).json({ error: "due_date inválida (AAAA-MM-DD)." });
  const out = await transaction(async (tx) => {
    const [i] = id ? await tx.query<{ status: string; lease_id: number | null; category: string }>("SELECT status, lease_id, category FROM incidents WHERE id = $1 AND organization_id = $2 FOR UPDATE", [id, orgId]) : [];
    if (!i) return { code: 404, error: "Ocorrência não encontrada." };
    if (i.status !== "notificada") return { code: 409, error: "Só se aplica multa depois de notificar o morador." };
    if (!i.lease_id) return { code: 409, error: "A unidade não tem contrato vigente para cobrar a multa." };
    const [c] = await tx.query<{ id: number }>(
      "INSERT INTO charges (organization_id, lease_id, kind, description, competence, due_date, amount_cents, created_by) VALUES ($1,$2,'multa',$3,date_trunc('month', $4::date),$4,$5,$6) RETURNING id",
      [orgId, i.lease_id, `Multa — ocorrência nº ${id} (${i.category})`, due, amount, req.auth!.user.id],
    );
    await tx.query("UPDATE incidents SET status = 'multada', fine_cents = $2, fine_charge_id = $3, updated_at = now() WHERE id = $1", [id, amount, c!.id]);
    return { code: 200, leaseId: i.lease_id, chargeId: c!.id };
  });
  if (out.code !== 200) return void res.status(out.code).json({ error: out.error });
  await notify(orgId, await tenantUsersOfLease(out.leaseId!), { category: "ocorrencia", kind: "incident_fine", title: "Multa por ocorrência", body: `${formatBRL(amount)} (vencimento ${due.split("-").reverse().join("/")}). Você pode contestar na área da ocorrência.`, linkKind: "incident", linkId: id! });
  res.json({ item: (await db.query(`${INCIDENT_SELECT} WHERE i.id = $1`, [id]))[0], charge_id: out.chargeId });
});

opsRouter.post("/incidents/:id/archive", ...staff, async (req, res) => {
  const note = text(req.body?.note, 500);
  const r = await incidentTransition(req, ["registrada", "notificada", "multada"], "arquivada", note);
  if (r.code !== 200) return void res.status(r.code).json({ error: r.error });
  res.json({ item: r.item });
});

opsRouter.get("/portal/tenant/incidents", ...tenantGuard, async (req, res) => {
  const items = await db.query(
    `${INCIDENT_SELECT} WHERE i.organization_id = $1 AND i.status <> 'registrada' AND i.lease_id IN (${MY_LEASES}) ORDER BY i.occurred_at DESC LIMIT 100`,
    [req.auth!.organization.id, req.auth!.tenantId],
  );
  res.json({ items });
});

/** O morador contesta (uma vez): o texto fica ao lado da ocorrência para a equipe decidir. */
opsRouter.post("/portal/tenant/incidents/:id/contest", ...tenantGuard, async (req, res) => {
  const id = parseId(req.params.id);
  const message = text(req.body?.text, 1000);
  if (!message || message.length < 5) return void res.status(400).json({ error: "Explique a sua contestação (5+ letras)." });
  const rows = id
    ? await db.query<{ organization_id: number }>(
        `UPDATE incidents SET contestation = $3, contested_at = now(), updated_at = now()
         WHERE id = $1 AND organization_id = $2 AND status IN ('notificada','multada') AND contestation IS NULL AND lease_id IN (SELECT lease_id FROM lease_tenants WHERE tenant_id = $4) RETURNING organization_id`,
        [id, req.auth!.organization.id, message, req.auth!.tenantId],
      )
    : [];
  if (rows.length === 0) return void res.status(409).json({ error: "Ocorrência não encontrada ou já contestada." });
  const staffIds = (await db.query<{ user_id: number }>("SELECT user_id FROM organization_members WHERE organization_id = $1 AND role IN ('admin','colaborador')", [req.auth!.organization.id])).map((r) => r.user_id);
  await notify(req.auth!.organization.id, staffIds, { category: "ocorrencia", kind: "incident_contested", title: "Ocorrência contestada", body: message.slice(0, 200), linkKind: "incident", linkId: id! });
  res.status(201).json({ ok: true });
});
