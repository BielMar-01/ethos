import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import { db, isUniqueViolation, transaction } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";
import { isRealDate, parseId } from "./crud.js";
import { brToday } from "./finance.js";
import { formatDocument, formatPhone } from "./brFormat.js";
import { notify, tenantUsersOfLease } from "./notifications.js";
import { RateLimiter } from "./ratelimit.js";
import { MY_LEASES, tenantGuard } from "./portal.js";

/**
 * Moradores e controle de acesso.
 * - Moradores: quem mora na unidade além dos locatários do contrato (cônjuge, filhos, parentes, funcionários…), por contrato.
 * - Visitantes: autorização de uma visita (ou recorrente, com validade) cadastrada pela equipe ou pelo inquilino; a portaria
 *   (equipe) registra entrada e saída. O código de acesso (6 caracteres) serve para localizar a autorização na portaria.
 * Não é controle de acesso físico (catraca/biometria): é o registro e a autorização, conferidos por uma pessoa.
 */
export const householdRouter = Router();
householdRouter.use(["/residents", "/visitors", "/access"], requireAuth, requireRole("admin", "colaborador"));
householdRouter.use("/portal", requireAuth);

export const RELATIONSHIPS = ["conjuge", "filho", "pai_mae", "irmao", "parente", "agregado", "empregado", "outro"] as const;
export const VISITOR_CATEGORIES = ["visitante", "familiar", "prestador", "entregador", "outro"] as const;
const MAX_RESIDENTS_PER_LEASE = 30;
const MAX_ACTIVE_VISITORS_PER_UNIT = 100;
const MAX_WINDOW_DAYS = 365;
const tenantVisitorLimiter = new RateLimiter(30, 60 * 60 * 1000); // 30 autorizações/hora por inquilino

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
function send(res: Response, err: unknown) {
  if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message });
  throw err;
}

const text = (v: unknown, max: number, label: string, required = false): string | null => {
  if (v === undefined || v === null || (typeof v === "string" && !v.trim())) {
    if (required) throw new HttpError(400, `Informe ${label}.`);
    return null;
  }
  if (typeof v !== "string" || v.trim().length > max) throw new HttpError(400, `${label}: texto inválido ou longo demais (máx. ${max}).`);
  return v.trim().replace(/\s+/g, " ");
};
const phoneOf = (v: unknown): string | null => {
  const raw = text(v, 30, "Telefone");
  if (!raw) return null;
  let d = raw.replace(/\D/g, "");
  if (d.length > 11 && d.startsWith("55")) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) throw new HttpError(400, "Telefone inválido. Use DDD + número, por exemplo (11) 91234-5678.");
  return formatPhone(d);
};
const emailOf = (v: unknown): string | null => {
  const raw = text(v, 200, "E-mail");
  if (raw && !/^\S+@\S+\.\S+$/.test(raw)) throw new HttpError(400, "E-mail inválido.");
  return raw ? raw.toLowerCase() : null;
};
/** CPF/CNPJ formatado; RG e outros documentos ficam como digitados. */
const documentOf = (v: unknown): string | null => {
  const raw = text(v, 30, "Documento");
  return raw ? formatDocument(raw) : null;
};
const dateOf = (v: unknown, label: string): string | null => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !isRealDate(v)) throw new HttpError(400, `${label}: data inválida (use AAAA-MM-DD).`);
  return v;
};
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);

// ================================================================= Moradores

const RESIDENT_SELECT = `
  SELECT r.id, r.lease_id, r.name, r.relationship, r.document, r.birth_date, r.phone, r.email, r.notes,
         r.moved_in_at, r.moved_out_at, r.created_at, l.status AS lease_status,
         u.identifier AS unit_identifier, u.id AS unit_id, p.name AS property_name
  FROM residents r JOIN leases l ON l.id = r.lease_id JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id`;

interface ResidentValues {
  name: string;
  relationship: string;
  document: string | null;
  birth_date: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
  moved_in_at: string | null;
}

function cleanResident(b: Record<string, unknown>, base?: ResidentValues): ResidentValues {
  const pick = <K extends keyof ResidentValues>(k: K, make: (v: unknown) => ResidentValues[K]): ResidentValues[K] => (b[k] === undefined && base ? base[k] : make(b[k]));
  const relationship = pick("relationship", (v) => {
    if (typeof v !== "string" || !(RELATIONSHIPS as readonly string[]).includes(v)) throw new HttpError(400, "Escolha o parentesco ou relação com o locatário.");
    return v;
  });
  const birth = pick("birth_date", (v) => {
    const d = dateOf(v, "Nascimento");
    if (d && (d < "1900-01-01" || d > brToday())) throw new HttpError(400, "Nascimento: data inválida.");
    return d;
  });
  return {
    name: pick("name", (v) => text(v, 120, "o nome", true)!),
    relationship,
    document: pick("document", documentOf),
    birth_date: birth,
    phone: pick("phone", phoneOf),
    email: pick("email", emailOf),
    notes: pick("notes", (v) => text(v, 500, "Observações")),
    moved_in_at: pick("moved_in_at", (v) => dateOf(v, "Data de entrada")),
  };
}

/** Filtros de moradores e locatários do contrato. `leaseIds` restringe (área do cliente); sem ele vale a organização toda. */
function householdFilters(orgId: number, q: Request["query"], leaseIds?: number[]) {
  const params: unknown[] = [orgId];
  let where = "r.organization_id = $1";
  let holderWhere = "l.organization_id = $1 AND l.status = 'vigente'";
  const both = (sqlR: string, sqlH: string, value: unknown) => {
    params.push(value);
    where += ` AND ${sqlR.replace("$$", `$${params.length}`)}`;
    holderWhere += ` AND ${sqlH.replace("$$", `$${params.length}`)}`;
  };
  if (leaseIds) both("r.lease_id = ANY($$::int[])", "l.id = ANY($$::int[])", leaseIds);
  const leaseId = q.lease_id === undefined ? undefined : parseId(q.lease_id);
  if (q.lease_id !== undefined) {
    if (!leaseId) throw new HttpError(400, "lease_id inválido");
    both("r.lease_id = $$", "l.id = $$", leaseId);
  }
  const unitId = q.unit_id === undefined ? undefined : parseId(q.unit_id);
  if (q.unit_id !== undefined) {
    if (!unitId) throw new HttpError(400, "unit_id inválido");
    both("l.unit_id = $$", "l.unit_id = $$", unitId);
  }
  if (q.scope !== "todos") where += " AND r.moved_out_at IS NULL AND l.status IN ('rascunho','vigente')";
  return { params, where, holderWhere };
}

/** Moradores cadastrados + locatários (titulares) dos contratos vigentes. */
async function residents(orgId: number, q: Request["query"], leaseIds?: number[], hideContact = false) {
  const { params, where, holderWhere } = householdFilters(orgId, q, leaseIds);
  const items = await db.query(`${RESIDENT_SELECT} WHERE ${where} ORDER BY p.name, u.identifier, r.name LIMIT 1000`, params);
  const holders = await db.query(
    `SELECT l.id AS lease_id, t.id AS tenant_id, t.name, ${hideContact ? "NULL::text" : "t.document"} AS document, ${hideContact ? "NULL::text" : "t.phone"} AS phone,
            ${hideContact ? "NULL::text" : "t.email"} AS email, u.identifier AS unit_identifier, u.id AS unit_id, p.name AS property_name
     FROM leases l JOIN lease_tenants lt ON lt.lease_id = l.id JOIN tenants t ON t.id = lt.tenant_id
     JOIN units u ON u.id = l.unit_id JOIN properties p ON p.id = u.property_id
     WHERE ${holderWhere} ORDER BY p.name, u.identifier, lt.position`,
    params,
  );
  return { items, holders };
}

async function leaseForResident(orgId: number, leaseId: unknown, mine?: { tenantId: number }): Promise<number> {
  const id = parseId(leaseId);
  if (!id) throw new HttpError(400, "Informe o contrato (lease_id).");
  const [l] = await db.query<{ id: number; status: string }>(
    `SELECT l.id, l.status FROM leases l WHERE l.id = $1 AND l.organization_id = $2
       ${mine ? `AND l.id IN (SELECT lease_id FROM lease_tenants WHERE tenant_id = ${Number(mine.tenantId)})` : ""}`,
    [id, orgId],
  );
  if (!l) throw new HttpError(400, "Contrato inexistente.");
  if (mine ? l.status !== "vigente" : !["rascunho", "vigente"].includes(l.status)) throw new HttpError(409, "Só é possível cadastrar moradores em contrato vigente (ou em rascunho, pela equipe).");
  return id;
}

async function createResident(orgId: number, userId: number, body: Record<string, unknown>, leaseId: number) {
  const v = cleanResident(body);
  const [{ n }] = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM residents WHERE lease_id = $1 AND moved_out_at IS NULL", [leaseId]) as [{ n: string }];
  if (Number(n) >= MAX_RESIDENTS_PER_LEASE) throw new HttpError(409, `Limite de ${MAX_RESIDENTS_PER_LEASE} moradores por contrato.`);
  const [row] = await db.query<{ id: number }>(
    `INSERT INTO residents (organization_id, lease_id, name, relationship, document, birth_date, phone, email, notes, moved_in_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [orgId, leaseId, v.name, v.relationship, v.document, v.birth_date, v.phone, v.email, v.notes, v.moved_in_at, userId],
  );
  return (await db.query(`${RESIDENT_SELECT} WHERE r.id = $1`, [row!.id]))[0]!;
}

async function updateResident(orgId: number, id: number, body: Record<string, unknown>, mine?: { tenantId: number }) {
  const [cur] = await db.query<ResidentValues & { moved_out_at: string | null }>(
    `SELECT r.name, r.relationship, r.document, r.birth_date, r.phone, r.email, r.notes, r.moved_in_at, r.moved_out_at FROM residents r
      WHERE r.id = $1 AND r.organization_id = $2
        ${mine ? `AND r.lease_id IN (SELECT lease_id FROM lease_tenants WHERE tenant_id = ${Number(mine.tenantId)})` : ""}`,
    [id, orgId],
  );
  if (!cur) throw new HttpError(404, "Não encontrado");
  if (cur.moved_out_at) throw new HttpError(409, "Este morador já saiu; o cadastro não pode mais ser alterado.");
  const v = cleanResident(body, cur);
  await db.query(
    `UPDATE residents SET name=$1, relationship=$2, document=$3, birth_date=$4, phone=$5, email=$6, notes=$7, moved_in_at=$8, updated_at=now() WHERE id=$9`,
    [v.name, v.relationship, v.document, v.birth_date, v.phone, v.email, v.notes, v.moved_in_at, id],
  );
  return (await db.query(`${RESIDENT_SELECT} WHERE r.id = $1`, [id]))[0]!;
}

async function moveOut(orgId: number, id: number, rawDate: unknown, mine?: { tenantId: number }) {
  const [cur] = await db.query<{ moved_in_at: string | null; moved_out_at: string | null }>(
    `SELECT moved_in_at, moved_out_at FROM residents WHERE id = $1 AND organization_id = $2
       ${mine ? `AND lease_id IN (SELECT lease_id FROM lease_tenants WHERE tenant_id = ${Number(mine.tenantId)})` : ""}`,
    [id, orgId],
  );
  if (!cur) throw new HttpError(404, "Não encontrado");
  if (cur.moved_out_at) throw new HttpError(409, "Este morador já está marcado como saído.");
  const date = dateOf(rawDate, "Data de saída") ?? brToday();
  if (cur.moved_in_at && date < cur.moved_in_at) throw new HttpError(400, "A saída não pode ser antes da entrada.");
  if (date > brToday()) throw new HttpError(400, "A data de saída não pode estar no futuro.");
  await db.query("UPDATE residents SET moved_out_at = $1, updated_at = now() WHERE id = $2", [date, id]);
  return (await db.query(`${RESIDENT_SELECT} WHERE r.id = $1`, [id]))[0]!;
}

householdRouter.get("/residents", async (req, res) => {
  try {
    res.json(await residents(req.auth!.organization.id, req.query));
  } catch (e) {
    send(res, e);
  }
});
householdRouter.post("/residents", async (req, res) => {
  try {
    const orgId = req.auth!.organization.id;
    const leaseId = await leaseForResident(orgId, req.body?.lease_id);
    res.status(201).json({ item: await createResident(orgId, req.auth!.user.id, req.body ?? {}, leaseId) });
  } catch (e) {
    send(res, e);
  }
});
householdRouter.put("/residents/:id", async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return void res.status(404).json({ error: "Não encontrado" });
    res.json({ item: await updateResident(req.auth!.organization.id, id, req.body ?? {}) });
  } catch (e) {
    send(res, e);
  }
});
householdRouter.post("/residents/:id/move-out", async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return void res.status(404).json({ error: "Não encontrado" });
    res.json({ item: await moveOut(req.auth!.organization.id, id, req.body?.date) });
  } catch (e) {
    send(res, e);
  }
});
householdRouter.delete("/residents/:id", requireRole("admin"), async (req, res) => {
  const id = parseId(req.params.id);
  const rows = id ? await db.query("DELETE FROM residents WHERE id = $1 AND organization_id = $2 RETURNING id", [id, req.auth!.organization.id]) : [];
  if (rows.length === 0) return void res.status(404).json({ error: "Não encontrado" });
  res.status(204).end();
});

// ---- Área do inquilino: o próprio contrato vigente.
const myVigenteLeases = async (req: Request): Promise<number[]> =>
  (
    await db.query<{ id: number }>(`SELECT l.id FROM leases l WHERE l.organization_id = $1 AND l.status = 'vigente' AND l.id IN (${MY_LEASES})`, [req.auth!.organization.id, req.auth!.tenantId])
  ).map((r) => r.id);

householdRouter.get("/portal/tenant/residents", ...tenantGuard, async (req, res) => {
  try {
    const ids = await myVigenteLeases(req);
    if (ids.length === 0) return void res.json({ items: [], holders: [] });
    res.json(await residents(req.auth!.organization.id, { ...req.query, scope: "ativos" }, ids, true));
  } catch (e) {
    send(res, e);
  }
});
householdRouter.post("/portal/tenant/residents", ...tenantGuard, async (req, res) => {
  try {
    const orgId = req.auth!.organization.id;
    const leaseId = await leaseForResident(orgId, req.body?.lease_id, { tenantId: req.auth!.tenantId! });
    res.status(201).json({ item: await createResident(orgId, req.auth!.user.id, req.body ?? {}, leaseId) });
  } catch (e) {
    send(res, e);
  }
});
householdRouter.put("/portal/tenant/residents/:id", ...tenantGuard, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return void res.status(404).json({ error: "Não encontrado" });
    res.json({ item: await updateResident(req.auth!.organization.id, id, req.body ?? {}, { tenantId: req.auth!.tenantId! }) });
  } catch (e) {
    send(res, e);
  }
});
householdRouter.post("/portal/tenant/residents/:id/move-out", ...tenantGuard, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return void res.status(404).json({ error: "Não encontrado" });
    res.json({ item: await moveOut(req.auth!.organization.id, id, req.body?.date, { tenantId: req.auth!.tenantId! }) });
  } catch (e) {
    send(res, e);
  }
});

// ================================================================= Visitantes

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sem 0/O/1/I
const newCode = () => Array.from(crypto.randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");

const VISITOR_SELECT = (today: string) => `
  SELECT v.id, v.unit_id, v.lease_id, v.name, v.document, v.phone, v.category, v.vehicle_plate, v.valid_from, v.valid_until,
         v.weekdays, to_char(v.time_from, 'HH24:MI') AS time_from, to_char(v.time_to, 'HH24:MI') AS time_to,
         to_char(v.expected_time, 'HH24:MI') AS expected_time, v.max_stay_minutes, v.photo_consent_at,
         EXISTS (SELECT 1 FROM visitor_photos vp WHERE vp.visitor_id = v.id) AS has_photo,
         v.access_code, v.status, v.notes, v.created_by_role, v.created_at,
         u.identifier AS unit_identifier, p.name AS property_name, cb.name AS created_by_name,
         CASE WHEN v.status <> 'autorizado' THEN v.status
              WHEN v.valid_until < '${today}' THEN 'expirado'
              WHEN v.valid_from > '${today}' THEN 'agendado'
              ELSE 'valido' END AS phase,
         COALESCE((SELECT e.event = 'entrada' FROM access_events e WHERE e.visitor_id = v.id ORDER BY e.id DESC LIMIT 1), false) AS inside,
         (SELECT e.at FROM access_events e WHERE e.visitor_id = v.id ORDER BY e.id DESC LIMIT 1) AS last_event_at,
         (SELECT string_agg(t.name, ', ' ORDER BY lt.position) FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id WHERE lt.lease_id = v.lease_id) AS tenant_names
  FROM visitors v JOIN units u ON u.id = v.unit_id JOIN properties p ON p.id = u.property_id LEFT JOIN users cb ON cb.id = v.created_by`;

interface VisitorValues {
  name: string;
  document: string | null;
  phone: string | null;
  category: string;
  vehicle_plate: string | null;
  valid_from: string;
  valid_until: string;
  notes: string | null;
  weekdays: string | null;
  time_from: string | null;
  time_to: string | null;
  expected_time: string | null;
  max_stay_minutes: number | null;
}

const hhmm = (v: unknown, label: string): string | null => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new HttpError(400, `${label} deve ser HH:MM.`);
  return v;
};
const weekdaysOf = (v: unknown): string | null => {
  if (v === undefined || v === null || v === "") return null;
  const list = (Array.isArray(v) ? v : String(v).split(",")).map((x) => Number(x));
  if (list.some((n) => !Number.isInteger(n) || n < 0 || n > 6)) throw new HttpError(400, "Dias da semana inválidos (0=domingo … 6=sábado).");
  const uniq = [...new Set(list)].sort();
  return uniq.length === 0 || uniq.length === 7 ? null : uniq.join(",");
};

function cleanVisitor(b: Record<string, unknown>, base?: VisitorValues): VisitorValues {
  const today = brToday();
  const pick = <K extends keyof VisitorValues>(k: K, make: (v: unknown) => VisitorValues[K]): VisitorValues[K] => (b[k] === undefined && base ? base[k] : make(b[k]));
  const from = pick("valid_from", (v) => dateOf(v, "Início") ?? today);
  const until = b.valid_until === undefined && base ? base.valid_until : (dateOf(b.valid_until, "Fim") ?? from);
  if (from < today && !(base && base.valid_from === from)) throw new HttpError(400, "O início da autorização não pode ser no passado.");
  if (until < from) throw new HttpError(400, "O fim da autorização não pode ser antes do início.");
  if ((dayMs(until) - dayMs(from)) / 86_400_000 > MAX_WINDOW_DAYS) throw new HttpError(400, `A autorização pode durar no máximo ${MAX_WINDOW_DAYS} dias.`);
  if (until < today) throw new HttpError(400, "A autorização já estaria vencida.");
  const tf = b.time_from === undefined && base ? base.time_from : hhmm(b.time_from, "Horário inicial");
  const tt = b.time_to === undefined && base ? base.time_to : hhmm(b.time_to, "Horário final");
  if ((tf === null) !== (tt === null)) throw new HttpError(400, "Informe o horário inicial e o final, ou nenhum dos dois.");
  if (tf && tt && tf >= tt) throw new HttpError(400, "O horário final deve ser depois do inicial.");
  return {
    name: pick("name", (v) => text(v, 120, "o nome do visitante", true)!),
    document: pick("document", documentOf),
    phone: pick("phone", phoneOf),
    category: pick("category", (v) => {
      if (v === undefined || v === null || v === "") return "visitante";
      if (typeof v !== "string" || !(VISITOR_CATEGORIES as readonly string[]).includes(v)) throw new HttpError(400, "Categoria inválida.");
      return v;
    }),
    vehicle_plate: pick("vehicle_plate", (v) => {
      const raw = text(v, 10, "Placa");
      if (!raw) return null;
      const plate = raw.toUpperCase().replace(/[\s-]/g, "");
      if (!/^[A-Z0-9]{5,8}$/.test(plate)) throw new HttpError(400, "Placa inválida.");
      return plate;
    }),
    valid_from: from,
    valid_until: until,
    notes: pick("notes", (v) => text(v, 500, "Observações")),
    weekdays: pick("weekdays", weekdaysOf),
    time_from: pick("time_from", (v) => hhmm(v, "Horário inicial")),
    time_to: pick("time_to", (v) => hhmm(v, "Horário final")),
    expected_time: pick("expected_time", (v) => hhmm(v, "Hora prevista")),
    max_stay_minutes: pick("max_stay_minutes", (v) => {
      if (v === undefined || v === null || v === "") return null;
      if (!Number.isInteger(v) || (v as number) < 10 || (v as number) > 1440) throw new HttpError(400, "Permanência máxima: de 10 a 1440 minutos.");
      return v as number;
    }),
  };
}

async function visitorById(orgId: number, id: number) {
  return (await db.query<Record<string, unknown>>(`${VISITOR_SELECT(brToday())} WHERE v.id = $1 AND v.organization_id = $2`, [id, orgId]))[0];
}

async function createVisitor(orgId: number, user: { id: number }, role: string, unitId: number, body: Record<string, unknown>) {
  const v = cleanVisitor(body);
  const [{ n }] = (await db.query<{ n: string }>("SELECT count(*)::text AS n FROM visitors WHERE unit_id = $1 AND status = 'autorizado' AND valid_until >= $2", [unitId, brToday()])) as [{ n: string }];
  if (Number(n) >= MAX_ACTIVE_VISITORS_PER_UNIT) throw new HttpError(409, `Esta unidade já tem ${MAX_ACTIVE_VISITORS_PER_UNIT} autorizações ativas. Cancele as que não servem mais.`);
  const [lease] = await db.query<{ id: number }>("SELECT id FROM leases WHERE unit_id = $1 AND organization_id = $2 AND status = 'vigente' LIMIT 1", [unitId, orgId]);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const [row] = await db.query<{ id: number }>(
        `INSERT INTO visitors (organization_id, unit_id, lease_id, name, document, phone, category, vehicle_plate, valid_from, valid_until, access_code, notes, created_by, created_by_role,
                               weekdays, time_from, time_to, expected_time, max_stay_minutes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
        [orgId, unitId, lease?.id ?? null, v.name, v.document, v.phone, v.category, v.vehicle_plate, v.valid_from, v.valid_until, newCode(), v.notes, user.id, role, v.weekdays, v.time_from, v.time_to, v.expected_time, v.max_stay_minutes],
      );
      return (await visitorById(orgId, row!.id))!;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err; // colisão do código: tenta outro
    }
  }
  throw new HttpError(500, "Não consegui gerar o código de acesso. Tente de novo.");
}

/** Edição: só enquanto autorizado. `mine` restringe às unidades do inquilino. */
async function updateVisitor(orgId: number, id: number, body: Record<string, unknown>, unitFilter?: number[]) {
  const [cur] = await db.query<VisitorValues & { status: string; unit_id: number }>(
    `SELECT name, document, phone, category, vehicle_plate, valid_from, valid_until, notes, status, unit_id, weekdays,
            to_char(time_from, 'HH24:MI') AS time_from, to_char(time_to, 'HH24:MI') AS time_to, to_char(expected_time, 'HH24:MI') AS expected_time, max_stay_minutes
     FROM visitors WHERE id = $1 AND organization_id = $2`,
    [id, orgId],
  );
  if (!cur || (unitFilter && !unitFilter.includes(cur.unit_id))) throw new HttpError(404, "Não encontrado");
  if (cur.status !== "autorizado") throw new HttpError(409, "Só é possível alterar uma autorização ativa.");
  const v = cleanVisitor(body, cur);
  await db.query(
    `UPDATE visitors SET name=$1, document=$2, phone=$3, category=$4, vehicle_plate=$5, valid_from=$6, valid_until=$7, notes=$8,
            weekdays=$10, time_from=$11, time_to=$12, expected_time=$13, max_stay_minutes=$14, not_arrived_alert_date=NULL, updated_at=now() WHERE id=$9`,
    [v.name, v.document, v.phone, v.category, v.vehicle_plate, v.valid_from, v.valid_until, v.notes, id, v.weekdays, v.time_from, v.time_to, v.expected_time, v.max_stay_minutes],
  );
  return (await visitorById(orgId, id))!;
}

async function cancelVisitor(orgId: number, id: number, unitFilter?: number[]) {
  return transaction(async (tx) => {
    const [cur] = await tx.query<{ status: string; unit_id: number }>("SELECT status, unit_id FROM visitors WHERE id = $1 AND organization_id = $2 FOR UPDATE", [id, orgId]);
    if (!cur || (unitFilter && !unitFilter.includes(cur.unit_id))) throw new HttpError(404, "Não encontrado");
    if (cur.status !== "autorizado") throw new HttpError(409, cur.status === "bloqueado" ? "Esta autorização foi bloqueada pela portaria." : "Esta autorização já foi cancelada.");
    const [last] = await tx.query<{ event: string }>("SELECT event FROM access_events WHERE visitor_id = $1 ORDER BY id DESC LIMIT 1", [id]);
    if (last?.event === "entrada") throw new HttpError(409, "O visitante está dentro. Registre a saída antes de cancelar.");
    await tx.query("UPDATE visitors SET status = 'cancelado', updated_at = now() WHERE id = $1", [id]);
  });
}

function visitorFilters(q: Request["query"], orgId: number, units?: number[]) {
  const params: unknown[] = [orgId];
  let where = "v.organization_id = $1";
  const today = brToday();
  if (units) {
    params.push(units);
    where += ` AND v.unit_id = ANY($${params.length}::int[])`;
  }
  if (typeof q.q === "string" && q.q.trim()) {
    params.push(`%${q.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const n = params.length;
    where += ` AND (v.name ILIKE $${n} OR v.document ILIKE $${n} OR v.access_code ILIKE $${n} OR v.vehicle_plate ILIKE $${n})`;
  }
  if (q.unit_id !== undefined) {
    const id = parseId(q.unit_id);
    if (!id) throw new HttpError(400, "unit_id inválido");
    params.push(id);
    where += ` AND v.unit_id = $${params.length}`;
  }
  const phase = typeof q.phase === "string" ? q.phase : "";
  if (phase === "valido") where += ` AND v.status = 'autorizado' AND v.valid_from <= '${today}' AND v.valid_until >= '${today}'`;
  else if (phase === "agendado") where += ` AND v.status = 'autorizado' AND v.valid_from > '${today}'`;
  else if (phase === "ativos") where += ` AND v.status = 'autorizado' AND v.valid_until >= '${today}'`;
  else if (phase === "encerrados") where += ` AND (v.status <> 'autorizado' OR v.valid_until < '${today}')`;
  else if (phase) throw new HttpError(400, "phase inválido");
  if (q.inside === "1") where += " AND COALESCE((SELECT e.event = 'entrada' FROM access_events e WHERE e.visitor_id = v.id ORDER BY e.id DESC LIMIT 1), false)";
  return { params, where };
}

householdRouter.get("/visitors", async (req, res) => {
  try {
    const { params, where } = visitorFilters(req.query, req.auth!.organization.id);
    res.json({ items: await db.query(`${VISITOR_SELECT(brToday())} WHERE ${where} ORDER BY v.valid_from, v.id DESC LIMIT 300`, params) });
  } catch (e) {
    send(res, e);
  }
});

householdRouter.post("/visitors", async (req, res) => {
  try {
    const orgId = req.auth!.organization.id;
    const unitId = parseId(req.body?.unit_id);
    const [unit] = unitId ? await db.query("SELECT 1 FROM units WHERE id = $1 AND organization_id = $2", [unitId, orgId]) : [];
    if (!unitId || !unit) throw new HttpError(400, "Escolha a unidade que o visitante vai visitar.");
    res.status(201).json({ item: await createVisitor(orgId, req.auth!.user, req.auth!.role, unitId, req.body ?? {}) });
  } catch (e) {
    send(res, e);
  }
});

householdRouter.put("/visitors/:id", async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return void res.status(404).json({ error: "Não encontrado" });
    res.json({ item: await updateVisitor(req.auth!.organization.id, id, req.body ?? {}) });
  } catch (e) {
    send(res, e);
  }
});

householdRouter.post("/visitors/:id/cancel", async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return void res.status(404).json({ error: "Não encontrado" });
    await cancelVisitor(req.auth!.organization.id, id);
    res.json({ item: await visitorById(req.auth!.organization.id, id) });
  } catch (e) {
    send(res, e);
  }
});

/** Portaria: bloqueia (ex.: pessoa não bem-vinda). Só a equipe desbloqueia. */
/** Renova uma autorização ativa por mais dias (até 365 a partir de hoje). `valid_until` opcional; padrão: +30 dias. */
async function renewVisitor(orgId: number, id: number, body: Record<string, unknown>, unitFilter?: number[]) {
  const [cur] = await db.query<{ status: string; unit_id: number; valid_until: string }>("SELECT status, unit_id, valid_until FROM visitors WHERE id = $1 AND organization_id = $2", [id, orgId]);
  if (!cur || (unitFilter && !unitFilter.includes(cur.unit_id))) throw new HttpError(404, "Não encontrado");
  if (cur.status !== "autorizado") throw new HttpError(409, "Só é possível renovar uma autorização ativa.");
  const today = brToday();
  const base = cur.valid_until > today ? cur.valid_until : today;
  const until = body.valid_until === undefined ? new Date(dayMs(base) + 30 * 86_400_000).toISOString().slice(0, 10) : dateOf(body.valid_until, "Novo fim")!;
  if (until <= cur.valid_until) throw new HttpError(400, "O novo fim deve ser depois do atual.");
  if ((dayMs(until) - dayMs(today)) / 86_400_000 > MAX_WINDOW_DAYS) throw new HttpError(400, `A autorização pode ir no máximo ${MAX_WINDOW_DAYS} dias à frente.`);
  await db.query("UPDATE visitors SET valid_until = $1, not_arrived_alert_date = NULL, updated_at = now() WHERE id = $2", [until, id]);
  return (await visitorById(orgId, id))!;
}
householdRouter.post("/visitors/:id/renew", async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return void res.status(404).json({ error: "Não encontrado" });
    res.json({ item: await renewVisitor(req.auth!.organization.id, id, req.body ?? {}) });
  } catch (e) {
    send(res, e);
  }
});
householdRouter.post("/portal/tenant/visitors/:id/renew", ...tenantGuard, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return void res.status(404).json({ error: "Não encontrado" });
    res.json({ item: await renewVisitor(req.auth!.organization.id, id, req.body ?? {}, await myUnits(req)) });
  } catch (e) {
    send(res, e);
  }
});

householdRouter.post("/visitors/:id/block", async (req, res) => {
  try {
    const orgId = req.auth!.organization.id;
    const id = parseId(req.params.id);
    const note = text(req.body?.note, 300, "Motivo");
    const row = await transaction(async (tx) => {
      const [cur] = id ? await tx.query<{ status: string }>("SELECT status FROM visitors WHERE id = $1 AND organization_id = $2 FOR UPDATE", [id, orgId]) : [];
      if (!cur) throw new HttpError(404, "Não encontrado");
      if (cur.status === "bloqueado") throw new HttpError(409, "Já está bloqueado.");
      const [last] = await tx.query<{ event: string }>("SELECT event FROM access_events WHERE visitor_id = $1 ORDER BY id DESC LIMIT 1", [id]);
      if (last?.event === "entrada") throw new HttpError(409, "O visitante está dentro. Registre a saída antes de bloquear.");
      await tx.query("UPDATE visitors SET status = 'bloqueado', notes = COALESCE($2, notes), updated_at = now() WHERE id = $1", [id, note]);
      return id!;
    });
    res.json({ item: await visitorById(orgId, row) });
  } catch (e) {
    send(res, e);
  }
});
householdRouter.post("/visitors/:id/unblock", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const id = parseId(req.params.id);
  const rows = id ? await db.query("UPDATE visitors SET status = 'autorizado', updated_at = now() WHERE id = $1 AND organization_id = $2 AND status = 'bloqueado' RETURNING id", [id, orgId]) : [];
  if (rows.length === 0) return void res.status(404).json({ error: "Não encontrado ou não está bloqueado." });
  res.json({ item: await visitorById(orgId, id!) });
});

/** Entrada e saída: sempre conferidas no servidor, com a linha da autorização travada para duas portarias não registrarem juntas. */
async function registerAccess(req: Request, res: Response, event: "entrada" | "saida") {
  try {
    const orgId = req.auth!.organization.id;
    const id = parseId(req.params.id);
    const note = text(req.body?.note, 300, "Observação");
    const today = brToday();
    const leaseId = await transaction(async (tx) => {
      const [v] = id
        ? await tx.query<{ status: string; valid_from: string; valid_until: string; lease_id: number | null; weekdays: string | null; time_from: string | null; time_to: string | null }>(
            "SELECT status, valid_from, valid_until, lease_id, weekdays, to_char(time_from,'HH24:MI') AS time_from, to_char(time_to,'HH24:MI') AS time_to FROM visitors WHERE id = $1 AND organization_id = $2 FOR UPDATE",
            [id, orgId],
          )
        : [];
      if (!v) throw new HttpError(404, "Não encontrado");
      const [last] = await tx.query<{ event: string }>("SELECT event FROM access_events WHERE visitor_id = $1 ORDER BY id DESC LIMIT 1", [id]);
      const inside = last?.event === "entrada";
      if (event === "entrada") {
        if (v.status === "bloqueado") throw new HttpError(409, "Visitante BLOQUEADO. Não libere a entrada.");
        if (v.status === "cancelado") throw new HttpError(409, "Autorização cancelada.");
        if (today < v.valid_from || today > v.valid_until) throw new HttpError(409, `Fora da validade: a autorização vale de ${v.valid_from.split("-").reverse().join("/")} a ${v.valid_until.split("-").reverse().join("/")}.`);
        if (inside) throw new HttpError(409, "Este visitante já está dentro. Registre a saída primeiro.");
        if (v.weekdays && !v.weekdays.split(",").includes(String(new Date(`${today}T12:00:00Z`).getUTCDay()))) {
          const names = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
          throw new HttpError(409, `Hoje não é um dia autorizado (vale: ${v.weekdays.split(",").map((d) => names[Number(d)]).join(", ")}).`);
        }
        if (v.time_from && v.time_to) {
          const now = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
          if (now < v.time_from || now > v.time_to) throw new HttpError(409, `Fora do horário autorizado (${v.time_from} às ${v.time_to}). Agora são ${now}.`);
        }
      } else if (!inside) {
        throw new HttpError(409, "Este visitante não está registrado como dentro.");
      }
      await tx.query("INSERT INTO access_events (organization_id, visitor_id, event, recorded_by, note) VALUES ($1,$2,$3,$4,$5)", [orgId, id, event, req.auth!.user.id, note]);
      return v.lease_id;
    });
    const item = (await visitorById(orgId, id!))!;
    if (event === "entrada") {
      await notify(orgId, await tenantUsersOfLease(leaseId), {
        category: "acesso", kind: "visitor_arrived", title: `${String(item.name)} chegou`, body: `Entrada registrada na portaria (${String(item.unit_identifier)}).`, linkKind: "visitor", linkId: id!,
      });
    }
    res.json({ item });
  } catch (e) {
    send(res, e);
  }
}
householdRouter.post("/visitors/:id/entry", (req, res) => registerAccess(req, res, "entrada"));
householdRouter.post("/visitors/:id/exit", (req, res) => registerAccess(req, res, "saida"));

const EVENTS_SQL = `SELECT e.id, e.event, e.at, e.note, u.name AS recorded_by_name FROM access_events e LEFT JOIN users u ON u.id = e.recorded_by
  WHERE e.visitor_id = $1 AND e.organization_id = $2 ORDER BY e.id DESC LIMIT 100`;
householdRouter.get("/visitors/:id/events", async (req, res) => {
  const id = parseId(req.params.id);
  res.json({ items: id ? await db.query(EVENTS_SQL, [id, req.auth!.organization.id]) : [] });
});

/** Movimento do dia (ou de `date`): todas as entradas e saídas, da mais recente para a mais antiga. */
householdRouter.get("/access/log", async (req, res) => {
  const date = req.query.date === undefined ? brToday() : String(req.query.date);
  if (!isRealDate(date)) return void res.status(400).json({ error: "date deve ser AAAA-MM-DD" });
  const items = await db.query(
    `SELECT e.id, e.event, e.at, e.note, v.id AS visitor_id, v.name, v.category, v.access_code, un.identifier AS unit_identifier, p.name AS property_name, rb.name AS recorded_by_name
     FROM access_events e JOIN visitors v ON v.id = e.visitor_id JOIN units un ON un.id = v.unit_id JOIN properties p ON p.id = un.property_id
     LEFT JOIN users rb ON rb.id = e.recorded_by
     WHERE e.organization_id = $1 AND (e.at AT TIME ZONE 'America/Sao_Paulo')::date = $2 ORDER BY e.id DESC LIMIT 500`,
    [req.auth!.organization.id, date],
  );
  res.json({ date, items });
});

// ---- Área do inquilino: visitantes da própria unidade.
const myUnits = async (req: Request): Promise<number[]> =>
  (
    await db.query<{ unit_id: number }>(`SELECT l.unit_id FROM leases l WHERE l.organization_id = $1 AND l.status = 'vigente' AND l.id IN (${MY_LEASES})`, [req.auth!.organization.id, req.auth!.tenantId])
  ).map((r) => r.unit_id);

householdRouter.get("/portal/tenant/visitors", ...tenantGuard, async (req, res) => {
  try {
    const units = await myUnits(req);
    if (units.length === 0) return void res.json({ items: [] });
    const { params, where } = visitorFilters({ phase: req.query.phase, q: req.query.q }, req.auth!.organization.id, units);
    res.json({ items: await db.query(`${VISITOR_SELECT(brToday())} WHERE ${where} ORDER BY v.valid_from, v.id DESC LIMIT 300`, params) });
  } catch (e) {
    send(res, e);
  }
});
householdRouter.post("/portal/tenant/visitors", ...tenantGuard, async (req, res) => {
  try {
    const orgId = req.auth!.organization.id;
    const leaseId = parseId(req.body?.lease_id);
    const [lease] = leaseId ? await db.query<{ unit_id: number }>(`SELECT l.unit_id FROM leases l WHERE l.id = $3 AND l.organization_id = $1 AND l.status = 'vigente' AND l.id IN (${MY_LEASES})`, [orgId, req.auth!.tenantId, leaseId]) : [];
    if (!lease) throw new HttpError(400, "Escolha um contrato vigente seu.");
    if (!tenantVisitorLimiter.allow(`tenant:${req.auth!.tenantId}`)) throw new HttpError(429, "Muitas autorizações em pouco tempo. Tente novamente mais tarde.");
    res.status(201).json({ item: await createVisitor(orgId, req.auth!.user, req.auth!.role, lease.unit_id, req.body ?? {}) });
  } catch (e) {
    send(res, e);
  }
});
householdRouter.put("/portal/tenant/visitors/:id", ...tenantGuard, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return void res.status(404).json({ error: "Não encontrado" });
    res.json({ item: await updateVisitor(req.auth!.organization.id, id, req.body ?? {}, await myUnits(req)) });
  } catch (e) {
    send(res, e);
  }
});
householdRouter.post("/portal/tenant/visitors/:id/cancel", ...tenantGuard, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return void res.status(404).json({ error: "Não encontrado" });
    await cancelVisitor(req.auth!.organization.id, id, await myUnits(req));
    res.json({ item: await visitorById(req.auth!.organization.id, id) });
  } catch (e) {
    send(res, e);
  }
});
householdRouter.get("/portal/tenant/visitors/:id/events", ...tenantGuard, async (req, res) => {
  const id = parseId(req.params.id);
  const units = await myUnits(req);
  const [v] = id ? await db.query<{ unit_id: number }>("SELECT unit_id FROM visitors WHERE id = $1 AND organization_id = $2", [id, req.auth!.organization.id]) : [];
  if (!v || !units.includes(v.unit_id)) return void res.status(404).json({ error: "Não encontrado" });
  res.json({ items: await db.query(EVENTS_SQL, [id, req.auth!.organization.id]) });
});
