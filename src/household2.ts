import { Router, type Request, type Response } from "express";
import { db } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";
import { isRealDate, parseId } from "./crud.js";
import { brToday } from "./finance.js";
import { notify, tenantUsersOfLease } from "./notifications.js";
import { MY_LEASES, tenantGuard } from "./portal.js";
import { detectImage, rawImage } from "./photos.js";
import { reais, sendCsv } from "./reports.js";
import { periodicJobs } from "./reminders.js";

/**
 * Moradores e acessos, parte 2: foto do visitante (com consentimento), relatório de acessos, encomendas na portaria,
 * resumo para o proprietário e os avisos automáticos (visita que não chegou, permanência acima do limite, encomenda parada).
 */
export const household2Router = Router();
const staff = [requireAuth, requireRole("admin", "colaborador")];

const MAX_VISITOR_PHOTO = 1024 * 1024;
const PHOTO_RETENTION_DAYS = 30;
const OVERSTAY_DEFAULT_MIN = 720;
const NOT_ARRIVED_GRACE_MIN = 60;
const PARCEL_REMINDER_DAYS = 3;

const myUnits = async (req: Request): Promise<number[]> =>
  (await db.query<{ unit_id: number }>(`SELECT l.unit_id FROM leases l WHERE l.organization_id = $1 AND l.status = 'vigente' AND l.id IN (${MY_LEASES})`, [req.auth!.organization.id, req.auth!.tenantId])).map((r) => r.unit_id);

// ------------------------------------------------------------------ Foto do visitante

/** Envia a foto. Exige consent=1: a pessoa fotografada autorizou. Só enquanto a autorização está ativa. */
household2Router.put("/visitors/:id/photo", ...staff, rawImage, async (req, res) => {
  const id = parseId(req.params.id);
  if (req.query.consent !== "1") return void res.status(400).json({ error: "Confirme o consentimento do visitante para a foto (consent=1)." });
  const body = req.body as unknown;
  if (!Buffer.isBuffer(body) || body.length === 0) return void res.status(400).json({ error: "Envie a imagem (JPEG, PNG ou WebP) no corpo da requisição." });
  if (body.length > MAX_VISITOR_PHOTO) return void res.status(413).json({ error: "A foto deve ter até 1 MB." });
  const type = detectImage(body);
  if (!type) return void res.status(400).json({ error: "Arquivo não é uma imagem JPEG, PNG ou WebP válida." });
  const [v] = id ? await db.query<{ status: string }>("SELECT status FROM visitors WHERE id = $1 AND organization_id = $2", [id, req.auth!.organization.id]) : [];
  if (!v) return void res.status(404).json({ error: "Não encontrado" });
  if (v.status !== "autorizado") return void res.status(409).json({ error: "A autorização não está ativa." });
  await db.query(
    `INSERT INTO visitor_photos (visitor_id, content_type, data, taken_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (visitor_id) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data, taken_by = EXCLUDED.taken_by, taken_at = now()`,
    [id, type, body, req.auth!.user.id],
  );
  await db.query("UPDATE visitors SET photo_consent_at = now() WHERE id = $1", [id]);
  res.status(204).end();
});

async function sendPhoto(req: Request, res: Response, units?: number[]) {
  const id = parseId(req.params.id);
  const [p] = id
    ? await db.query<{ content_type: string; data: Uint8Array; unit_id: number }>(
        "SELECT vp.content_type, vp.data, v.unit_id FROM visitor_photos vp JOIN visitors v ON v.id = vp.visitor_id WHERE vp.visitor_id = $1 AND v.organization_id = $2",
        [id, req.auth!.organization.id],
      )
    : [];
  if (!p || (units && !units.includes(p.unit_id))) return void res.status(404).json({ error: "Não encontrado" });
  res.set({ "Content-Type": p.content_type, "Content-Disposition": "inline", "Cache-Control": "private, no-store" });
  res.send(Buffer.from(p.data));
}
household2Router.get("/visitors/:id/photo", ...staff, (req, res) => sendPhoto(req, res));
household2Router.get("/portal/tenant/visitors/:id/photo", ...tenantGuard, async (req, res) => sendPhoto(req, res, await myUnits(req)));

household2Router.delete("/visitors/:id/photo", ...staff, async (req, res) => {
  const id = parseId(req.params.id);
  const done = id ? await db.query("DELETE FROM visitor_photos vp USING visitors v WHERE vp.visitor_id = v.id AND v.id = $1 AND v.organization_id = $2 RETURNING vp.visitor_id", [id, req.auth!.organization.id]) : [];
  if (done.length === 0) return void res.status(404).json({ error: "Não encontrado" });
  await db.query("UPDATE visitors SET photo_consent_at = NULL WHERE id = $1", [id]);
  res.status(204).end();
});

// ------------------------------------------------------------------ Relatório de acessos

household2Router.get("/access/report", ...staff, async (req, res) => {
  const from = String(req.query.from ?? "");
  const to = String(req.query.to ?? "");
  if (!isRealDate(from) || !isRealDate(to) || to < from || (Date.parse(to) - Date.parse(from)) / 86_400_000 > 366) return void res.status(400).json({ error: "Informe from e to (AAAA-MM-DD), no máximo 366 dias." });
  const unitId = req.query.unit_id ? parseId(req.query.unit_id) : null;
  const rows = await db.query<{ entry_at: string; exit_at: string | null; minutes: number | null; name: string; document: string | null; category: string; vehicle_plate: string | null; unit: string; property: string; recorded_by: string | null }>(
    `SELECT e.at AS entry_at, x.at AS exit_at, (extract(epoch FROM x.at - e.at) / 60)::int AS minutes, v.name, v.document, v.category, v.vehicle_plate,
            un.identifier AS unit, p.name AS property, rb.name AS recorded_by
     FROM access_events e
     JOIN visitors v ON v.id = e.visitor_id JOIN units un ON un.id = v.unit_id JOIN properties p ON p.id = un.property_id
     LEFT JOIN users rb ON rb.id = e.recorded_by
     LEFT JOIN LATERAL (SELECT x.at FROM access_events x WHERE x.visitor_id = e.visitor_id AND x.event = 'saida' AND x.id > e.id ORDER BY x.id LIMIT 1) x ON true
     WHERE e.organization_id = $1 AND e.event = 'entrada' AND (e.at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN $2 AND $3 AND ($4::int IS NULL OR v.unit_id = $4)
     ORDER BY e.at DESC LIMIT 5000`,
    [req.auth!.organization.id, from, to, unitId],
  );
  if (req.query.format === "csv") {
    const fmt = (s: string | null) => (s ? new Date(s).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "");
    return sendCsv(res, "acessos.csv", ["Entrada", "Saída", "Minutos", "Visitante", "Documento", "Categoria", "Placa", "Imóvel", "Unidade", "Registrado por"],
      rows.map((r) => [fmt(r.entry_at), fmt(r.exit_at), r.minutes ?? "", r.name, r.document, r.category, r.vehicle_plate, r.property, r.unit, r.recorded_by]));
  }
  const byCategory: Record<string, number> = {};
  for (const r of rows) byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
  res.json({ from, to, total: rows.length, still_inside: rows.filter((r) => !r.exit_at).length, by_category: byCategory, items: rows });
});

// ------------------------------------------------------------------ Encomendas

const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : null);
const PARCEL_SELECT = `SELECT pc.id, pc.unit_id, pc.description, pc.carrier, pc.recipient_name, pc.status, pc.received_at, pc.picked_up_at, pc.picked_up_by_name, pc.notes,
  u.identifier AS unit_identifier, pr.name AS property_name, rb.name AS received_by_name,
  CASE WHEN pc.status = 'recebida' THEN (now() - pc.received_at) END AS waiting,
  (SELECT string_agg(t.name, ', ' ORDER BY lt.position) FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id WHERE lt.lease_id = pc.lease_id) AS tenant_names
  FROM parcels pc JOIN units u ON u.id = pc.unit_id JOIN properties pr ON pr.id = u.property_id LEFT JOIN users rb ON rb.id = pc.received_by`;

household2Router.post("/parcels", ...staff, async (req, res) => {
  const orgId = req.auth!.organization.id;
  const unitId = parseId(req.body?.unit_id);
  const description = str(req.body?.description, 200);
  if (!unitId || !description) return void res.status(400).json({ error: "Informe unit_id e a descrição da encomenda." });
  const [unit] = await db.query<{ identifier: string }>("SELECT identifier FROM units WHERE id = $1 AND organization_id = $2", [unitId, orgId]);
  if (!unit) return void res.status(404).json({ error: "Unidade não encontrada." });
  const [lease] = await db.query<{ id: number }>("SELECT id FROM leases WHERE unit_id = $1 AND organization_id = $2 AND status = 'vigente' LIMIT 1", [unitId, orgId]);
  const [row] = await db.query<{ id: number }>(
    "INSERT INTO parcels (organization_id, unit_id, lease_id, description, carrier, recipient_name, notes, received_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
    [orgId, unitId, lease?.id ?? null, description, str(req.body?.carrier, 80), str(req.body?.recipient_name, 120), str(req.body?.notes, 300), req.auth!.user.id],
  );
  if (lease) {
    await notify(orgId, await tenantUsersOfLease(lease.id), { category: "encomenda", kind: "parcel_received", title: "Chegou uma encomenda", body: `${description}${req.body?.carrier ? ` (${String(req.body.carrier)})` : ""} está na portaria (${unit.identifier}).`, linkKind: "parcel", linkId: row!.id });
  }
  res.status(201).json({ item: (await db.query(`${PARCEL_SELECT} WHERE pc.id = $1`, [row!.id]))[0] });
});

household2Router.get("/parcels", ...staff, async (req, res) => {
  const status = ["recebida", "retirada", "devolvida"].includes(String(req.query.status)) ? String(req.query.status) : req.query.status === "all" ? "" : "recebida";
  const unitId = req.query.unit_id ? parseId(req.query.unit_id) : null;
  const items = await db.query(
    `${PARCEL_SELECT} WHERE pc.organization_id = $1 AND ($2 = '' OR pc.status = $2) AND ($3::int IS NULL OR pc.unit_id = $3) ORDER BY pc.received_at DESC LIMIT 300`,
    [req.auth!.organization.id, status, unitId],
  );
  res.json({ items });
});

async function closeParcel(req: Request, res: Response, to: "retirada" | "devolvida") {
  const id = parseId(req.params.id);
  const who = str(req.body?.picked_up_by_name, 120);
  if (to === "retirada" && !who) return void res.status(400).json({ error: "Informe quem retirou a encomenda." });
  const done = id
    ? await db.query(
        "UPDATE parcels SET status = $3, picked_up_at = now(), picked_up_by_name = $4, handled_by = $5 WHERE id = $1 AND organization_id = $2 AND status = 'recebida' RETURNING id",
        [id, req.auth!.organization.id, to, who, req.auth!.user.id],
      )
    : [];
  if (done.length === 0) return void res.status(409).json({ error: "Encomenda não encontrada ou já encerrada." });
  res.json({ item: (await db.query(`${PARCEL_SELECT} WHERE pc.id = $1`, [id]))[0] });
}
household2Router.post("/parcels/:id/pickup", ...staff, (req, res) => closeParcel(req, res, "retirada"));
household2Router.post("/parcels/:id/return", ...staff, (req, res) => closeParcel(req, res, "devolvida"));

household2Router.get("/portal/tenant/parcels", ...tenantGuard, async (req, res) => {
  const units = await myUnits(req);
  if (units.length === 0) return void res.json({ items: [] });
  const items = await db.query(`${PARCEL_SELECT} WHERE pc.organization_id = $1 AND pc.unit_id = ANY($2::int[]) ORDER BY (pc.status = 'recebida') DESC, pc.received_at DESC LIMIT 100`, [req.auth!.organization.id, units]);
  res.json({ items });
});

// ------------------------------------------------------------------ Resumo para o proprietário (sem nomes de pessoas)

household2Router.get("/portal/owner/summary", requireAuth, async (req, res) => {
  const a = req.auth!;
  if (a.role !== "proprietario") return void res.status(403).json({ error: "Sem permissão" });
  if (!a.ownerId) return void res.status(409).json({ error: "Seu acesso ainda não está vinculado a um cadastro de proprietário." });
  const today = brToday();
  const items = await db.query(
    `SELECT pr.id AS property_id, pr.name AS property_name,
       (SELECT count(*)::int FROM units u WHERE u.property_id = pr.id) AS units,
       (SELECT count(*)::int FROM units u WHERE u.property_id = pr.id AND u.status = 'ocupada') AS occupied,
       (SELECT count(*)::int FROM leases l JOIN units u ON u.id = l.unit_id WHERE u.property_id = pr.id AND l.status = 'vigente' AND l.end_date <= $2::date + 60) AS leases_ending_60d,
       (SELECT count(*)::int FROM maintenance_requests m JOIN units u ON u.id = m.unit_id WHERE u.property_id = pr.id AND m.status NOT IN ('concluida','cancelada')) AS maintenance_open,
       (SELECT count(*)::int FROM residents r JOIN leases l ON l.id = r.lease_id JOIN units u ON u.id = l.unit_id WHERE u.property_id = pr.id AND r.moved_out_at IS NULL AND l.status = 'vigente') AS residents,
       (SELECT count(*)::int FROM access_events e JOIN visitors v ON v.id = e.visitor_id JOIN units u ON u.id = v.unit_id WHERE u.property_id = pr.id AND e.event = 'entrada' AND e.at >= now() - interval '30 days') AS visits_30d,
       (SELECT count(*)::int FROM parcels pc JOIN units u ON u.id = pc.unit_id WHERE u.property_id = pr.id AND pc.received_at >= now() - interval '30 days') AS parcels_30d
     FROM properties pr JOIN property_owners po ON po.property_id = pr.id WHERE po.owner_id = $1 AND pr.organization_id = $3 ORDER BY pr.name`,
    [a.ownerId, today, a.organization.id],
  );
  res.json({ as_of: today, note: "Números agregados: a administradora não compartilha nomes de moradores ou visitantes.", items });
});

// ------------------------------------------------------------------ Avisos automáticos

const nowHHMM = () => new Intl.DateTimeFormat("en-GB", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
const plusMinutes = (hhmm: string, add: number) => {
  const total = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) + add;
  return total >= 1440 ? "23:59" : `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

async function staffUsers(orgId: number): Promise<number[]> {
  return (await db.query<{ user_id: number }>("SELECT user_id FROM organization_members WHERE organization_id = $1 AND role IN ('admin','colaborador')", [orgId])).map((r) => r.user_id);
}

/** Visita com hora prevista que ainda não chegou (1 aviso por dia) e permanência acima do limite (1 aviso por entrada). */
export async function runAccessAlerts(): Promise<{ notArrived: number; overstay: number }> {
  const today = brToday();
  const dow = String(new Date(`${today}T12:00:00Z`).getUTCDay());
  const now = nowHHMM();
  let notArrived = 0;
  let overstay = 0;

  const late = await db.query<{ id: number; organization_id: number; lease_id: number | null; name: string; expected: string; weekdays: string | null; unit: string }>(
    `SELECT v.id, v.organization_id, v.lease_id, v.name, to_char(v.expected_time,'HH24:MI') AS expected, v.weekdays, u.identifier AS unit
     FROM visitors v JOIN units u ON u.id = v.unit_id
     WHERE v.status = 'autorizado' AND v.valid_from <= $1::date AND v.valid_until >= $1::date AND v.expected_time IS NOT NULL
       AND v.not_arrived_alert_date IS DISTINCT FROM $1::date
       AND NOT EXISTS (SELECT 1 FROM access_events e WHERE e.visitor_id = v.id AND e.event = 'entrada' AND (e.at AT TIME ZONE 'America/Sao_Paulo')::date = $1::date)`,
    [today],
  );
  for (const v of late) {
    if (v.weekdays && !v.weekdays.split(",").includes(dow)) continue;
    if (now < plusMinutes(v.expected, NOT_ARRIVED_GRACE_MIN)) continue;
    await db.query("UPDATE visitors SET not_arrived_alert_date = $2::date WHERE id = $1", [v.id, today]);
    notArrived += await notify(v.organization_id, await tenantUsersOfLease(v.lease_id), { category: "acesso", kind: "visitor_late", title: `${v.name} ainda não chegou`, body: `Era esperado(a) às ${v.expected} (${v.unit}).`, linkKind: "visitor", linkId: v.id });
  }

  const inside = await db.query<{ event_id: number; organization_id: number; lease_id: number | null; name: string; unit: string; minutes: number; limit_min: number; visitor_id: number }>(
    `SELECT e.id AS event_id, e.organization_id, v.lease_id, v.name, u.identifier AS unit, v.id AS visitor_id,
            (extract(epoch FROM now() - e.at) / 60)::int AS minutes, COALESCE(v.max_stay_minutes, $1) AS limit_min
     FROM access_events e JOIN visitors v ON v.id = e.visitor_id JOIN units u ON u.id = v.unit_id
     WHERE e.event = 'entrada' AND e.overstay_alerted_at IS NULL
       AND e.id = (SELECT max(x.id) FROM access_events x WHERE x.visitor_id = e.visitor_id)
       AND now() - e.at > make_interval(mins => COALESCE(v.max_stay_minutes, $1))`,
    [OVERSTAY_DEFAULT_MIN],
  );
  for (const r of inside) {
    await db.query("UPDATE access_events SET overstay_alerted_at = now() WHERE id = $1", [r.event_id]);
    const body = `${r.name} está dentro há ${Math.floor(r.minutes / 60)}h${String(r.minutes % 60).padStart(2, "0")} (limite ${Math.floor(r.limit_min / 60)}h${String(r.limit_min % 60).padStart(2, "0")}). Unidade ${r.unit}.`;
    overstay += await notify(r.organization_id, [...(await tenantUsersOfLease(r.lease_id)), ...(await staffUsers(r.organization_id))], { category: "acesso", kind: "visitor_overstay", title: "Visitante há muito tempo dentro", body, linkKind: "visitor", linkId: r.visitor_id });
  }
  return { notArrived, overstay };
}

/** Encomenda parada há dias: um lembrete ao morador. */
export async function runParcelReminders(): Promise<number> {
  const rows = await db.query<{ id: number; organization_id: number; lease_id: number | null; description: string }>(
    `UPDATE parcels SET reminder_sent_at = now() WHERE status = 'recebida' AND reminder_sent_at IS NULL AND received_at < now() - make_interval(days => $1) RETURNING id, organization_id, lease_id, description`,
    [PARCEL_REMINDER_DAYS],
  );
  let n = 0;
  for (const r of rows) n += await notify(r.organization_id, await tenantUsersOfLease(r.lease_id), { category: "encomenda", kind: "parcel_waiting", title: "Encomenda aguardando retirada", body: `${r.description} continua na portaria há mais de ${PARCEL_REMINDER_DAYS} dias.`, linkKind: "parcel", linkId: r.id });
  return n;
}

/** LGPD: apaga as fotos de visitantes 30 dias depois do fim da autorização. */
export async function purgeVisitorPhotos(): Promise<number> {
  const rows = await db.query(
    `DELETE FROM visitor_photos vp USING visitors v WHERE vp.visitor_id = v.id AND (v.valid_until < ($1::date - $2::int) OR v.status IN ('cancelado','bloqueado') AND v.updated_at < now() - make_interval(days => $2::int)) RETURNING vp.visitor_id`,
    [brToday(), PHOTO_RETENTION_DAYS],
  );
  return rows.length;
}

periodicJobs.push(
  { name: "avisos de acesso (visita atrasada e permanência)", run: () => runAccessAlerts() },
  { name: "lembrete de encomendas", run: () => runParcelReminders() },
  { name: "apagar fotos de visitantes vencidas", run: () => purgeVisitorPhotos() },
);

export { reais };
