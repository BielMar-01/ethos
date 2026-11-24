import crypto from "node:crypto";
import { Router } from "express";
import { db } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";
import { appUrl } from "./authProvider.js";
import { isRealDate, parseId } from "./crud.js";
import { formatPhone } from "./brFormat.js";
import { notify } from "./notifications.js";
import { SharedRateLimiter } from "./ratelimit.js";
import { periodicJobs } from "./reminders.js";

/**
 * Captação: vitrine pública das unidades disponíveis, formulário de interesse, funil de interessados (leads),
 * agenda de visitas e análise de crédito do candidato (manual, com consentimento).
 */
export const crmRouter = Router();
const staff = [requireAuth, requireRole("admin", "colaborador")];
crmRouter.use(["/leads", "/lead-visits", "/credit-checks"], requireAuth, requireRole("admin", "colaborador"));

const STATUSES = ["novo", "contato", "visita_agendada", "proposta", "ganho", "perdido"] as const;
const SOURCES = ["manual", "site", "indicacao", "portal", "outro"] as const;
const interestLimiter = new SharedRateLimiter("interest", 5, 60 * 60 * 1000);
const listingLimiter = new SharedRateLimiter("listing", 120, 15 * 60 * 1000);
const INT4_MAX = 2_147_483_647;

const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
function phoneOf(v: unknown): string | null | "invalid" {
  const raw = text(v, 30);
  if (!raw) return null;
  let d = raw.replace(/\D/g, "");
  if (d.length > 11 && d.startsWith("55")) d = d.slice(2);
  return d.length === 10 || d.length === 11 ? formatPhone(d) : "invalid";
}
const emailOf = (v: unknown): string | null | "invalid" => {
  const raw = text(v, 200);
  if (!raw) return null;
  return /^\S+@\S+\.\S+$/.test(raw) ? raw.toLowerCase() : "invalid";
};

// ------------------------------------------------------------------ Vitrine pública

crmRouter.get("/settings/public-listing", ...staff, async (req, res) => {
  const [o] = await db.query<{ public_token: string | null }>("SELECT public_token FROM organizations WHERE id = $1", [req.auth!.organization.id]);
  res.json({ enabled: !!o?.public_token, link: o?.public_token ? `${appUrl()}/#/imoveis/${o.public_token}` : null });
});

crmRouter.put("/settings/public-listing", requireAuth, requireRole("admin"), async (req, res) => {
  const on = req.body?.enabled;
  if (typeof on !== "boolean") return void res.status(400).json({ error: "Informe enabled (true/false)." });
  // regenerate = true troca o link (o antigo para de funcionar).
  const token = on ? crypto.randomBytes(18).toString("base64url") : null;
  const [cur] = await db.query<{ public_token: string | null }>("SELECT public_token FROM organizations WHERE id = $1", [req.auth!.organization.id]);
  const keep = on && cur?.public_token && req.body?.regenerate !== true ? cur.public_token : token;
  await db.query("UPDATE organizations SET public_token = $2 WHERE id = $1", [req.auth!.organization.id, keep]);
  res.json({ enabled: !!keep, link: keep ? `${appUrl()}/#/imoveis/${keep}` : null });
});

async function orgOfToken(token: unknown): Promise<{ id: number; name: string } | undefined> {
  if (typeof token !== "string" || token.length < 10 || token.length > 80) return undefined;
  return (await db.query<{ id: number; name: string }>("SELECT id, name FROM organizations WHERE public_token = $1", [token]))[0];
}

/** Unidades disponíveis (sem endereço completo: só bairro e cidade) e dados de contato da administradora. */
crmRouter.get("/public/listings/:token", async (req, res) => {
  if (!(await listingLimiter.allow(`ip:${req.ip}`))) return void res.status(429).json({ error: "Muitas consultas. Tente mais tarde." });
  const org = await orgOfToken(req.params.token);
  if (!org) return void res.status(404).json({ error: "Vitrine indisponível." });
  const items = await db.query(
    `SELECT u.id, u.identifier, u.bedrooms, u.area_m2, u.rent_reference_cents, p.name AS property_name, p.type, p.neighborhood, p.city, p.state
     FROM units u JOIN properties p ON p.id = u.property_id WHERE u.organization_id = $1 AND u.status = 'disponivel' ORDER BY p.name, u.identifier LIMIT 200`,
    [org.id],
  );
  res.json({ organization: org.name, items });
});

crmRouter.post("/public/interest", async (req, res) => {
  const b = req.body ?? {};
  if (typeof b.website === "string" && b.website.trim()) return void res.status(204).end(); // armadilha para robôs: finge sucesso
  if (!(await interestLimiter.allow(`ip:${req.ip}`))) return void res.status(429).json({ error: "Muitas solicitações. Tente novamente mais tarde." });
  const org = await orgOfToken(b.token);
  if (!org) return void res.status(404).json({ error: "Vitrine indisponível." });
  const name = text(b.name, 120);
  const phone = phoneOf(b.phone);
  const email = emailOf(b.email);
  if (!name || name.length < 3 || phone === "invalid" || email === "invalid" || (!phone && !email)) return void res.status(400).json({ error: "Informe seu nome e um telefone (com DDD) ou e-mail válido." });
  if (b.consent !== true) return void res.status(400).json({ error: "Aceite o uso dos seus dados para o retorno da administradora." });
  let unitId: number | null = null;
  if (b.unit_id !== undefined && b.unit_id !== null) {
    unitId = parseId(b.unit_id) ?? null;
    const [u] = unitId ? await db.query("SELECT 1 FROM units WHERE id = $1 AND organization_id = $2 AND status = 'disponivel'", [unitId, org.id]) : [];
    if (!u) unitId = null;
  }
  const [lead] = await db.query<{ id: number }>(
    "INSERT INTO leads (organization_id, name, phone, email, source, unit_id, message, consent_at) VALUES ($1,$2,$3,$4,'site',$5,$6,now()) RETURNING id",
    [org.id, name, phone, email, unitId, text(b.message, 500)],
  );
  const staffIds = (await db.query<{ user_id: number }>("SELECT user_id FROM organization_members WHERE organization_id = $1 AND role IN ('admin','colaborador')", [org.id])).map((r) => r.user_id);
  await notify(org.id, staffIds, { category: "contrato", kind: "lead", title: "Novo interessado pelo site", body: `${name}${phone ? ` · ${phone}` : ""}`, linkKind: "lead", linkId: lead!.id });
  res.status(201).json({ ok: true });
});

// ------------------------------------------------------------------ Interessados

const LEAD_SELECT = `SELECT l.id, l.name, l.phone, l.email, l.source, l.unit_id, l.status, l.message, l.notes, l.assigned_to, l.created_at, l.updated_at,
  u.identifier AS unit_identifier, p.name AS property_name, au.name AS assigned_name,
  (SELECT count(*)::int FROM lead_visits v WHERE v.lead_id = l.id AND v.status = 'agendada') AS visits_scheduled
  FROM leads l LEFT JOIN units u ON u.id = l.unit_id LEFT JOIN properties p ON p.id = u.property_id LEFT JOIN users au ON au.id = l.assigned_to`;

crmRouter.get("/leads", async (req, res) => {
  const status = STATUSES.includes(req.query.status as never) ? String(req.query.status) : null;
  const q = typeof req.query.q === "string" && req.query.q.trim() ? `%${req.query.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const items = await db.query(`${LEAD_SELECT} WHERE l.organization_id = $1 AND ($2::text IS NULL OR l.status = $2) AND ($3::text IS NULL OR l.name ILIKE $3 OR l.phone ILIKE $3 OR l.email ILIKE $3) ORDER BY l.updated_at DESC LIMIT 300`, [req.auth!.organization.id, status, q]);
  const counts = await db.query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM leads WHERE organization_id = $1 GROUP BY status", [req.auth!.organization.id]);
  res.json({ items, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) });
});

async function leadValues(orgId: number, b: Record<string, unknown>, partial: boolean) {
  const out: Record<string, unknown> = {};
  if (!partial || b.name !== undefined) { const n = text(b.name, 120); if (!n || n.length < 2) return "Informe o nome."; out.name = n; }
  if (b.phone !== undefined) { const p = phoneOf(b.phone); if (p === "invalid") return "Telefone inválido."; out.phone = p; }
  if (b.email !== undefined) { const e = emailOf(b.email); if (e === "invalid") return "E-mail inválido."; out.email = e; }
  if (b.source !== undefined) { if (!SOURCES.includes(b.source as never)) return "Origem inválida."; out.source = b.source; }
  if (b.status !== undefined) { if (!STATUSES.includes(b.status as never)) return "Situação inválida."; out.status = b.status; }
  if (b.notes !== undefined) out.notes = text(b.notes, 1000);
  if (b.unit_id !== undefined) {
    if (b.unit_id === null || b.unit_id === "") out.unit_id = null;
    else { const u = parseId(b.unit_id); const [ok] = u ? await db.query("SELECT 1 FROM units WHERE id = $1 AND organization_id = $2", [u, orgId]) : []; if (!ok) return "Unidade inválida."; out.unit_id = u; }
  }
  if (b.assigned_to !== undefined) {
    if (b.assigned_to === null || b.assigned_to === "") out.assigned_to = null;
    else { const a = parseId(b.assigned_to); const [ok] = a ? await db.query("SELECT 1 FROM organization_members WHERE user_id = $1 AND organization_id = $2 AND role IN ('admin','colaborador')", [a, orgId]) : []; if (!ok) return "Responsável inválido."; out.assigned_to = a; }
  }
  return out;
}

crmRouter.post("/leads", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const v = await leadValues(orgId, req.body ?? {}, false);
  if (typeof v === "string") return void res.status(400).json({ error: v });
  if (!v.phone && !v.email) return void res.status(400).json({ error: "Informe telefone ou e-mail." });
  const [row] = await db.query<{ id: number }>(
    "INSERT INTO leads (organization_id, name, phone, email, source, unit_id, status, notes, assigned_to) VALUES ($1,$2,$3,$4,COALESCE($5,'manual'),$6,COALESCE($7,'novo'),$8,$9) RETURNING id",
    [orgId, v.name, v.phone ?? null, v.email ?? null, v.source ?? null, v.unit_id ?? null, v.status ?? null, v.notes ?? null, v.assigned_to ?? null],
  );
  res.status(201).json({ item: (await db.query(`${LEAD_SELECT} WHERE l.id = $1`, [row!.id]))[0] });
});

crmRouter.patch("/leads/:id", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const id = parseId(req.params.id);
  const v = await leadValues(orgId, req.body ?? {}, true);
  if (typeof v === "string") return void res.status(400).json({ error: v });
  const keys = Object.keys(v);
  if (keys.length === 0) return void res.status(400).json({ error: "Nada para alterar." });
  const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(", ");
  const done = id ? await db.query(`UPDATE leads SET ${sets}, updated_at = now() WHERE id = $1 AND organization_id = $2 RETURNING id`, [id, orgId, ...keys.map((k) => v[k])]) : [];
  if (done.length === 0) return void res.status(404).json({ error: "Interessado não encontrado." });
  res.json({ item: (await db.query(`${LEAD_SELECT} WHERE l.id = $1`, [id]))[0] });
});

crmRouter.delete("/leads/:id", requireRole("admin"), async (req, res) => {
  const id = parseId(req.params.id);
  const done = id ? await db.query("DELETE FROM leads WHERE id = $1 AND organization_id = $2 RETURNING id", [id, req.auth!.organization.id]) : [];
  if (done.length === 0) return void res.status(404).json({ error: "Interessado não encontrado." });
  res.status(204).end();
});

// ------------------------------------------------------------------ Agenda de visitas

const VISIT_SELECT = `SELECT v.id, v.lead_id, v.unit_id, v.scheduled_at, v.status, v.assigned_to, v.notes, l.name AS lead_name, l.phone AS lead_phone,
  u.identifier AS unit_identifier, p.name AS property_name, au.name AS assigned_name
  FROM lead_visits v JOIN leads l ON l.id = v.lead_id LEFT JOIN units u ON u.id = v.unit_id LEFT JOIN properties p ON p.id = u.property_id LEFT JOIN users au ON au.id = v.assigned_to`;

crmRouter.get("/lead-visits", async (req, res) => {
  const from = isRealDate(String(req.query.from)) ? String(req.query.from) : null;
  const to = isRealDate(String(req.query.to)) ? String(req.query.to) : null;
  const items = await db.query(
    `${VISIT_SELECT} WHERE v.organization_id = $1 AND ($2::date IS NULL OR (v.scheduled_at AT TIME ZONE 'America/Sao_Paulo')::date >= $2) AND ($3::date IS NULL OR (v.scheduled_at AT TIME ZONE 'America/Sao_Paulo')::date <= $3)
     ORDER BY v.scheduled_at LIMIT 500`,
    [req.auth!.organization.id, from, to],
  );
  res.json({ items });
});

crmRouter.post("/leads/:id/visits", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const leadId = parseId(req.params.id);
  const [lead] = leadId ? await db.query<{ status: string }>("SELECT status FROM leads WHERE id = $1 AND organization_id = $2", [leadId, orgId]) : [];
  if (!lead) return void res.status(404).json({ error: "Interessado não encontrado." });
  const when = new Date(String(req.body?.scheduled_at));
  if (Number.isNaN(when.getTime()) || when.getTime() < Date.now() - 60_000) return void res.status(400).json({ error: "Informe a data e a hora da visita (scheduled_at), no futuro." });
  if (when.getTime() > Date.now() + 365 * 86_400_000) return void res.status(400).json({ error: "A visita não pode ser a mais de 1 ano." });
  const unitId = req.body?.unit_id ? parseId(req.body.unit_id) : null;
  if (req.body?.unit_id && !unitId) return void res.status(400).json({ error: "Unidade inválida." });
  if (unitId && !(await db.query("SELECT 1 FROM units WHERE id = $1 AND organization_id = $2", [unitId, orgId])).length) return void res.status(400).json({ error: "Unidade inválida." });
  const assignee = req.body?.assigned_to ? parseId(req.body.assigned_to) : req.auth!.user.id;
  if (assignee) {
    const clash = await db.query("SELECT 1 FROM lead_visits WHERE organization_id = $1 AND assigned_to = $2 AND status = 'agendada' AND scheduled_at BETWEEN $3::timestamptz - interval '29 minutes' AND $3::timestamptz + interval '29 minutes'", [orgId, assignee, when.toISOString()]);
    if (clash.length > 0) return void res.status(409).json({ error: "Este responsável já tem uma visita marcada nesse horário (±30 min)." });
  }
  const [row] = await db.query<{ id: number }>("INSERT INTO lead_visits (organization_id, lead_id, unit_id, scheduled_at, assigned_to, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id", [orgId, leadId, unitId, when.toISOString(), assignee ?? null, text(req.body?.notes, 300)]);
  if (["novo", "contato"].includes(lead.status)) await db.query("UPDATE leads SET status = 'visita_agendada', updated_at = now() WHERE id = $1", [leadId]);
  res.status(201).json({ item: (await db.query(`${VISIT_SELECT} WHERE v.id = $1`, [row!.id]))[0] });
});

crmRouter.patch("/lead-visits/:id", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const id = parseId(req.params.id);
  const status = req.body?.status;
  if (status !== undefined && !["agendada", "realizada", "cancelada", "faltou"].includes(status)) return void res.status(400).json({ error: "Situação inválida." });
  let when: string | null = null;
  if (req.body?.scheduled_at !== undefined) {
    const d = new Date(String(req.body.scheduled_at));
    if (Number.isNaN(d.getTime())) return void res.status(400).json({ error: "scheduled_at inválida." });
    when = d.toISOString();
  }
  const done = id ? await db.query("UPDATE lead_visits SET status = COALESCE($3, status), scheduled_at = COALESCE($4::timestamptz, scheduled_at), notes = COALESCE($5, notes), reminder_sent_at = CASE WHEN $4::timestamptz IS NOT NULL THEN NULL ELSE reminder_sent_at END WHERE id = $1 AND organization_id = $2 RETURNING id", [id, orgId, status ?? null, when, req.body?.notes === undefined ? null : text(req.body.notes, 300)]) : [];
  if (done.length === 0) return void res.status(404).json({ error: "Visita não encontrada." });
  res.json({ item: (await db.query(`${VISIT_SELECT} WHERE v.id = $1`, [id]))[0] });
});

/** Lembrete ao responsável das visitas das próximas 24 horas (uma vez). */
export async function runVisitReminders(): Promise<number> {
  const rows = await db.query<{ id: number; organization_id: number; assigned_to: number | null; lead_name: string; scheduled_at: string }>(
    `UPDATE lead_visits v SET reminder_sent_at = now() FROM leads l
     WHERE l.id = v.lead_id AND v.status = 'agendada' AND v.reminder_sent_at IS NULL AND v.scheduled_at > now() AND v.scheduled_at < now() + interval '24 hours'
     RETURNING v.id, v.organization_id, v.assigned_to, l.name AS lead_name, v.scheduled_at`,
  );
  let n = 0;
  for (const v of rows) {
    const to = v.assigned_to ? [v.assigned_to] : (await db.query<{ user_id: number }>("SELECT user_id FROM organization_members WHERE organization_id = $1 AND role = 'admin'", [v.organization_id])).map((r) => r.user_id);
    n += await notify(v.organization_id, to, { category: "contrato", kind: "lead_visit", title: "Visita agendada para amanhã", body: `${v.lead_name} em ${new Date(v.scheduled_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" })}.`, linkKind: "lead", linkId: v.id });
  }
  return n;
}
periodicJobs.push({ name: "lembrete de visitas a interessados", run: () => runVisitReminders() });

// ------------------------------------------------------------------ Análise de crédito

crmRouter.get("/credit-checks", async (req, res) => {
  res.json({ items: await db.query("SELECT id, lead_id, name, document, income_cents, rent_cents, negative_records, score, ratio::float8 AS ratio, recommendation, status, notes, created_at FROM credit_checks WHERE organization_id = $1 ORDER BY id DESC LIMIT 200", [req.auth!.organization.id]) });
});

/**
 * Regras (editáveis só no código, de propósito): renda ≥ 3× o aluguel → aprovar; entre 2,5× e 3× → revisar; abaixo disso ou com
 * restrição no nome → reprovar. A decisão final é sempre humana. Não consulta bureau (Serasa/SPC): o resultado dessa consulta, se
 * você a fizer fora, entra como `negative_records` e `score`.
 */
export function creditRecommendation(income: number, rent: number, negative: boolean): { ratio: number; recommendation: "aprovar" | "revisar" | "reprovar" } {
  const ratio = Math.round((income / rent) * 100) / 100;
  if (negative || ratio < 2.5) return { ratio, recommendation: "reprovar" };
  return { ratio, recommendation: ratio >= 3 ? "aprovar" : "revisar" };
}

crmRouter.post("/credit-checks", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const b = req.body ?? {};
  const name = text(b.name, 120);
  const document = typeof b.document === "string" ? b.document.replace(/\D/g, "") : "";
  if (!name || (document.length !== 11 && document.length !== 14)) return void res.status(400).json({ error: "Informe nome e CPF/CNPJ válidos." });
  if (b.consent !== true) return void res.status(400).json({ error: "É preciso o consentimento do candidato (consent: true) para analisar o crédito." });
  for (const k of ["income_cents", "rent_cents"] as const) if (!Number.isInteger(b[k]) || b[k] < (k === "rent_cents" ? 1 : 0) || b[k] > INT4_MAX) return void res.status(400).json({ error: `${k} inválido (centavos).` });
  if (b.score !== undefined && b.score !== null && (!Number.isInteger(b.score) || b.score < 0 || b.score > 1000)) return void res.status(400).json({ error: "score deve ser de 0 a 1000." });
  const leadId = b.lead_id ? parseId(b.lead_id) : null;
  if (b.lead_id && !(leadId && (await db.query("SELECT 1 FROM leads WHERE id = $1 AND organization_id = $2", [leadId, orgId])).length)) return void res.status(400).json({ error: "Interessado inválido." });
  const r = creditRecommendation(b.income_cents, b.rent_cents, b.negative_records === true);
  const [row] = await db.query<{ id: number }>(
    `INSERT INTO credit_checks (organization_id, lead_id, name, document, income_cents, rent_cents, negative_records, score, ratio, recommendation, notes, consent_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),$12) RETURNING id`,
    [orgId, leadId, name, document, b.income_cents, b.rent_cents, b.negative_records === true, b.score ?? null, r.ratio, r.recommendation, text(b.notes, 500), req.auth!.user.id],
  );
  res.status(201).json({ id: row!.id, ...r, rule: "Renda ≥ 3× o aluguel aprova; de 2,5× a 3× pede revisão; abaixo disso ou com restrição reprova. A decisão final é sua." });
});

crmRouter.patch("/credit-checks/:id/decision", async (req, res) => {
  const id = parseId(req.params.id);
  if (!["aprovado", "reprovado"].includes(req.body?.status)) return void res.status(400).json({ error: "status deve ser aprovado ou reprovado." });
  const done = id ? await db.query("UPDATE credit_checks SET status = $3, decided_by = $4, notes = COALESCE($5, notes) WHERE id = $1 AND organization_id = $2 RETURNING id", [id, req.auth!.organization.id, req.body.status, req.auth!.user.id, text(req.body?.notes, 500)]) : [];
  if (done.length === 0) return void res.status(404).json({ error: "Análise não encontrada." });
  res.json({ ok: true });
});

crmRouter.delete("/credit-checks/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const id = parseId(req.params.id);
  const done = id ? await db.query("DELETE FROM credit_checks WHERE id = $1 AND organization_id = $2 RETURNING id", [id, req.auth!.organization.id]) : [];
  if (done.length === 0) return void res.status(404).json({ error: "Análise não encontrada." });
  res.status(204).end();
});
