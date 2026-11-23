import { Router } from "express";
import { db, isUniqueViolation, transaction, type Queryable } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";
import { isRealDate, parseId } from "./crud.js";
import { formatDate, joinNames } from "./contractTemplate.js";
import { rawImage, storePhoto } from "./photos.js";

export const TYPES = ["entrada", "saida", "periodica"] as const;
export const CONDITIONS = ["novo", "bom", "regular", "ruim", "danificado"] as const;
export type Condition = (typeof CONDITIONS)[number];
type InspStatus = "agendada" | "em_andamento" | "concluida" | "cancelada";

export const TYPE_LABEL: Record<string, string> = { entrada: "ENTRADA", saida: "SAÍDA", periodica: "PERIÓDICA" };
export const CONDITION_LABEL: Record<Condition, string> = { novo: "Novo", bom: "Bom", regular: "Regular", ruim: "Ruim", danificado: "Danificado" };
const RANK: Record<Condition, number> = { novo: 0, bom: 1, regular: 2, ruim: 3, danificado: 4 };

const DEFAULT_CHECKLIST: Record<string, string[]> = {
  Sala: ["Paredes", "Piso", "Teto", "Portas", "Janelas", "Iluminação e tomadas"],
  Cozinha: ["Paredes", "Piso", "Pia e torneira", "Armários", "Iluminação e tomadas"],
  Banheiro: ["Paredes", "Piso", "Vaso sanitário", "Chuveiro", "Pia e torneira", "Box"],
  Quarto: ["Paredes", "Piso", "Teto", "Portas", "Janelas", "Iluminação e tomadas"],
  "Área de serviço": ["Piso", "Tanque", "Torneira"],
  Geral: ["Chaves e fechaduras", "Medidores (água/luz/gás)", "Pintura geral"],
};

const isOpen = (s: InspStatus) => s === "agendada" || s === "em_andamento";
const brToday = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date());
/** Data (AAAA-MM-DD) no fuso de Brasília de um timestamp vindo do banco. */
const brDate = (ts: Date | string) => new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date(ts));
const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : undefined);

interface InspectionRow {
  id: number;
  unit_id: number;
  lease_id: number | null;
  type: string;
  status: InspStatus;
  scheduled_for: string;
  performed_at: string | null;
}

// ------------------------------------------------------------- Montagem de dados

/** Itens da vistoria com a lista de fotos de cada um (sem os bytes). */
export async function loadItems(q: Queryable, inspectionId: number) {
  const items = await q.query<{ id: number; room: string; item: string; condition: Condition | null; notes: string | null; position: number }>(
    "SELECT id, room, item, condition, notes, position FROM inspection_items WHERE inspection_id = $1 ORDER BY position, id",
    [inspectionId],
  );
  const photos = await q.query<{ id: number; inspection_item_id: number }>(
    `SELECT p.id, p.inspection_item_id FROM photos p JOIN inspection_items ii ON ii.id = p.inspection_item_id
     WHERE ii.inspection_id = $1 ORDER BY p.id`,
    [inspectionId],
  );
  return items.map((i) => ({ ...i, photos: photos.filter((p) => p.inspection_item_id === i.id).map((p) => p.id) }));
}

export async function loadSignatures(q: Queryable, inspectionId: number) {
  return q.query<{ role: string; signer_name: string; signed_at: string }>(
    "SELECT role, signer_name, signed_at FROM inspection_signatures WHERE inspection_id = $1 ORDER BY id",
    [inspectionId],
  );
}

const SIGNATURE_LABEL: Record<string, string> = { vistoriador: "Vistoriador", locatario: "Locatário", proprietario: "Proprietário" };

/** Laudo em texto, montado do que está gravado (a vistoria concluída é imutável, então o laudo é estável). */
export async function buildReport(q: Queryable, inspectionId: number): Promise<string | undefined> {
  const [i] = await q.query<{
    id: number; type: string; status: string; performed_at: string | null; scheduled_for: string; notes: string | null; lease_id: number | null;
    unit_identifier: string; property_name: string; street: string | null; number: string | null; city: string | null; state: string | null;
    inspector_name: string | null; organization_name: string;
  }>(
    `SELECT i.id, i.type, i.status, i.performed_at, i.scheduled_for, i.notes, i.lease_id,
            u.identifier AS unit_identifier, p.name AS property_name, p.street, p.number, p.city, p.state,
            ins.name AS inspector_name, o.name AS organization_name
     FROM inspections i JOIN units u ON u.id = i.unit_id JOIN properties p ON p.id = u.property_id
     JOIN organizations o ON o.id = i.organization_id LEFT JOIN users ins ON ins.id = i.inspector_id
     WHERE i.id = $1`,
    [inspectionId],
  );
  if (!i) return undefined;
  const tenants = i.lease_id
    ? await q.query<{ name: string }>(
        "SELECT t.name FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id WHERE lt.lease_id = $1 ORDER BY lt.position",
        [i.lease_id],
      )
    : [];
  const items = await loadItems(q, inspectionId);
  const signatures = await loadSignatures(q, inspectionId);

  const lines: string[] = [
    `LAUDO DE VISTORIA DE ${TYPE_LABEL[i.type]}`,
    "",
    `Imóvel: ${i.property_name} — unidade ${i.unit_identifier}`,
    `Endereço: ${[i.street, i.number, [i.city, i.state].filter(Boolean).join("/")].filter(Boolean).join(", ") || "não informado"}`,
    `Data da vistoria: ${formatDate(i.performed_at ?? i.scheduled_for)}`,
    `Responsável: ${i.inspector_name ?? "não informado"}`,
  ];
  if (tenants.length) lines.push(`Locatário(s): ${joinNames(tenants.map((t) => t.name))}`);
  if (i.notes) lines.push("", `Observações gerais: ${i.notes}`);

  let room = "";
  for (const it of items) {
    if (it.room !== room) {
      room = it.room;
      lines.push("", room.toUpperCase());
    }
    const cond = it.condition ? CONDITION_LABEL[it.condition] : "não avaliado";
    lines.push(`  • ${it.item}: ${cond}${it.notes ? ` — ${it.notes}` : ""}${it.photos.length ? ` [${it.photos.length} foto(s)]` : ""}`);
  }
  lines.push("", "REGISTRO DE CIÊNCIA");
  if (signatures.length === 0) lines.push("  (sem assinaturas registradas)");
  for (const s of signatures) lines.push(`  ${SIGNATURE_LABEL[s.role]}: ${s.signer_name} — ${formatDate(brDate(s.signed_at))}`);
  lines.push("", i.organization_name);
  return lines.join("\n");
}

// -------------------------------------------------------------------- Equipe

export const inspectionsRouter = Router();
inspectionsRouter.use("/inspections", requireAuth, requireRole("admin", "colaborador"));

async function findInspection(orgId: number, id: number | undefined, q: Queryable = db): Promise<InspectionRow | undefined> {
  if (!id) return undefined;
  const [row] = await q.query<InspectionRow>(
    "SELECT id, unit_id, lease_id, type, status, scheduled_for, performed_at FROM inspections WHERE id = $1 AND organization_id = $2",
    [id, orgId],
  );
  return row;
}

inspectionsRouter.get("/inspections", async (req, res) => {
  const params: unknown[] = [req.auth!.organization.id];
  let where = "i.organization_id = $1";
  for (const [key, col] of [["unit_id", "i.unit_id"], ["type", "i.type"], ["status", "i.status"]] as const) {
    const v = req.query[key];
    if (v === undefined) continue;
    const value = key === "unit_id" ? parseId(v) : String(v);
    if (!value) return void res.status(400).json({ error: `${key} inválido` });
    params.push(value);
    where += ` AND ${col} = $${params.length}`;
  }
  const items = await db.query(
    `SELECT i.id, i.type, i.status, i.scheduled_for, i.performed_at, i.unit_id, u.identifier AS unit_identifier,
            p.name AS property_name, ins.name AS inspector_name,
            (SELECT count(*)::int FROM inspection_items x WHERE x.inspection_id = i.id) AS items_total,
            (SELECT count(*)::int FROM inspection_items x WHERE x.inspection_id = i.id AND x.condition IS NOT NULL) AS items_done
     FROM inspections i JOIN units u ON u.id = i.unit_id JOIN properties p ON p.id = u.property_id
     LEFT JOIN users ins ON ins.id = i.inspector_id
     WHERE ${where} ORDER BY i.scheduled_for DESC, i.id DESC`,
    params,
  );
  res.json({ items });
});

async function validInspector(orgId: number, v: unknown): Promise<number | null | undefined> {
  if (v === undefined || v === null) return null;
  const id = parseId(v);
  if (!id) return undefined;
  const ok = await db.query("SELECT 1 FROM organization_members WHERE organization_id = $1 AND user_id = $2 AND role IN ('admin','colaborador')", [orgId, id]);
  return ok.length ? id : undefined;
}

inspectionsRouter.post("/inspections", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const { type, scheduled_for } = req.body ?? {};
  const unitId = parseId(req.body?.unit_id);
  if (!unitId || !TYPES.includes(type) || typeof scheduled_for !== "string" || !isRealDate(scheduled_for)) {
    return void res.status(400).json({ error: "Informe unit_id, type (entrada|saida|periodica) e scheduled_for (AAAA-MM-DD)" });
  }
  const notes = req.body?.notes === undefined || req.body.notes === null ? null : text(req.body.notes, 2000);
  if (notes === undefined) return void res.status(400).json({ error: "notes inválido" });
  const [unit] = await db.query("SELECT 1 FROM units WHERE id = $1 AND organization_id = $2", [unitId, orgId]);
  if (!unit) return void res.status(400).json({ error: "Unidade inexistente" });

  let leaseId: number | null = null;
  if (req.body?.lease_id !== undefined && req.body.lease_id !== null) {
    leaseId = parseId(req.body.lease_id) ?? null;
    const [lease] = leaseId
      ? await db.query("SELECT 1 FROM leases WHERE id = $1 AND organization_id = $2 AND unit_id = $3", [leaseId, orgId, unitId])
      : [];
    if (!lease) return void res.status(400).json({ error: "Contrato inexistente ou de outra unidade" });
  } else {
    // Sem contrato informado: usa o vigente da unidade (se houver), para o cliente poder ver o laudo.
    const [lease] = await db.query<{ id: number }>("SELECT id FROM leases WHERE unit_id = $1 AND status = 'vigente' LIMIT 1", [unitId]);
    leaseId = lease?.id ?? null;
  }
  const inspector = await validInspector(orgId, req.body?.inspector_id ?? req.auth!.user.id);
  if (inspector === undefined) return void res.status(400).json({ error: "Responsável deve ser da equipe da organização" });

  const created = await transaction(async (tx) => {
    const [row] = await tx.query<{ id: number }>(
      `INSERT INTO inspections (organization_id, unit_id, lease_id, type, scheduled_for, inspector_id, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [orgId, unitId, leaseId, type, scheduled_for, inspector, notes, req.auth!.user.id],
    );
    if (req.body?.useDefaultChecklist !== false) {
      let position = 0;
      for (const [room, items] of Object.entries(DEFAULT_CHECKLIST)) {
        for (const item of items) {
          await tx.query("INSERT INTO inspection_items (organization_id, inspection_id, room, item, position) VALUES ($1, $2, $3, $4, $5)", [orgId, row!.id, room, item, position++]);
        }
      }
    }
    return row!;
  });
  res.status(201).json({ id: created.id });
});

inspectionsRouter.get("/inspections/:id", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const id = parseId(req.params.id);
  const [inspection] = id
    ? await db.query(
        `SELECT i.id, i.type, i.status, i.scheduled_for, i.performed_at, i.completed_at, i.notes, i.unit_id, i.lease_id, i.inspector_id,
                u.identifier AS unit_identifier, p.name AS property_name, ins.name AS inspector_name
         FROM inspections i JOIN units u ON u.id = i.unit_id JOIN properties p ON p.id = u.property_id
         LEFT JOIN users ins ON ins.id = i.inspector_id
         WHERE i.id = $1 AND i.organization_id = $2`,
        [id, orgId],
      )
    : [];
  if (!inspection) return void res.status(404).json({ error: "Não encontrado" });
  res.json({ inspection, items: await loadItems(db, id!), signatures: await loadSignatures(db, id!) });
});

inspectionsRouter.patch("/inspections/:id", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const insp = await findInspection(orgId, parseId(req.params.id));
  if (!insp) return void res.status(404).json({ error: "Não encontrado" });
  if (!isOpen(insp.status)) return void res.status(409).json({ error: "Vistoria fechada não pode ser editada" });
  const sets: string[] = [];
  const vals: unknown[] = [];
  const b = req.body ?? {};
  if (b.scheduled_for !== undefined) {
    if (typeof b.scheduled_for !== "string" || !isRealDate(b.scheduled_for)) return void res.status(400).json({ error: "scheduled_for inválida" });
    vals.push(b.scheduled_for);
    sets.push(`scheduled_for = $${vals.length}`);
  }
  if (b.notes !== undefined) {
    const v = b.notes === null ? null : text(b.notes, 2000);
    if (v === undefined) return void res.status(400).json({ error: "notes inválido" });
    vals.push(v);
    sets.push(`notes = $${vals.length}`);
  }
  if (b.inspector_id !== undefined) {
    const v = await validInspector(orgId, b.inspector_id);
    if (v === undefined) return void res.status(400).json({ error: "Responsável deve ser da equipe da organização" });
    vals.push(v);
    sets.push(`inspector_id = $${vals.length}`);
  }
  if (!sets.length) return void res.status(400).json({ error: "Nenhum campo para atualizar" });
  await db.query(`UPDATE inspections SET ${sets.join(", ")} WHERE id = $${vals.length + 1}`, [...vals, insp.id]);
  res.status(204).end();
});

// ---- Itens do checklist (só enquanto a vistoria está aberta)

inspectionsRouter.post("/inspections/:id/items", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const insp = await findInspection(orgId, parseId(req.params.id));
  if (!insp) return void res.status(404).json({ error: "Não encontrado" });
  if (!isOpen(insp.status)) return void res.status(409).json({ error: "Vistoria fechada não aceita novos itens" });
  const room = text(req.body?.room, 100);
  const item = text(req.body?.item, 150);
  if (!room || !item) return void res.status(400).json({ error: "Informe room e item" });
  try {
    const [row] = await db.query<{ id: number }>(
      `INSERT INTO inspection_items (organization_id, inspection_id, room, item, position)
       VALUES ($1, $2, $3, $4, (SELECT COALESCE(max(position), -1) + 1 FROM inspection_items WHERE inspection_id = $2)) RETURNING id`,
      [orgId, insp.id, room, item],
    );
    res.status(201).json({ id: row!.id });
  } catch (err) {
    if (isUniqueViolation(err)) return void res.status(409).json({ error: "Este item já existe neste ambiente" });
    throw err;
  }
});

async function findItem(orgId: number, inspectionId: number, itemId: number | undefined) {
  if (!itemId) return undefined;
  const [row] = await db.query<{ id: number }>(
    "SELECT id FROM inspection_items WHERE id = $1 AND inspection_id = $2 AND organization_id = $3",
    [itemId, inspectionId, orgId],
  );
  return row;
}

inspectionsRouter.patch("/inspections/:id/items/:itemId", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const insp = await findInspection(orgId, parseId(req.params.id));
  if (!insp) return void res.status(404).json({ error: "Não encontrado" });
  const item = await findItem(orgId, insp.id, parseId(req.params.itemId));
  if (!item) return void res.status(404).json({ error: "Item não encontrado" });
  if (!isOpen(insp.status)) return void res.status(409).json({ error: "Vistoria fechada não pode ser editada" });
  const sets: string[] = [];
  const vals: unknown[] = [];
  const b = req.body ?? {};
  if (b.condition !== undefined) {
    if (b.condition !== null && !CONDITIONS.includes(b.condition)) return void res.status(400).json({ error: "condition inválida" });
    vals.push(b.condition);
    sets.push(`condition = $${vals.length}`);
  }
  if (b.notes !== undefined) {
    const v = b.notes === null || b.notes === "" ? null : text(b.notes, 1000);
    if (v === undefined) return void res.status(400).json({ error: "notes inválido (até 1000 caracteres)" });
    vals.push(v);
    sets.push(`notes = $${vals.length}`);
  }
  if (!sets.length) return void res.status(400).json({ error: "Nenhum campo para atualizar" });
  await db.query(`UPDATE inspection_items SET ${sets.join(", ")} WHERE id = $${vals.length + 1}`, [...vals, item.id]);
  res.status(204).end();
});

inspectionsRouter.delete("/inspections/:id/items/:itemId", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const insp = await findInspection(orgId, parseId(req.params.id));
  if (!insp) return void res.status(404).json({ error: "Não encontrado" });
  const item = await findItem(orgId, insp.id, parseId(req.params.itemId));
  if (!item) return void res.status(404).json({ error: "Item não encontrado" });
  if (!isOpen(insp.status)) return void res.status(409).json({ error: "Vistoria fechada não pode ser editada" });
  await db.query("DELETE FROM inspection_items WHERE id = $1", [item.id]);
  res.status(204).end();
});

inspectionsRouter.post("/inspections/:id/items/:itemId/photos", rawImage, async (req, res) => {
  const orgId = req.auth!.organization.id;
  const insp = await findInspection(orgId, parseId(req.params.id));
  if (!insp) return void res.status(404).json({ error: "Não encontrado" });
  const item = await findItem(orgId, insp.id, parseId(req.params.itemId));
  if (!item) return void res.status(404).json({ error: "Item não encontrado" });
  if (!isOpen(insp.status)) return void res.status(409).json({ error: "Vistoria fechada não aceita novas fotos" });
  const r = await storePhoto(orgId, req.auth!.user.id, { inspectionItemId: item.id }, req.body);
  if (!r.ok) return void res.status(r.code).json({ error: r.error });
  res.status(201).json({ id: r.id });
});

// ---- Status, assinaturas, laudo e comparação

const INSP_FLOW: Record<InspStatus, InspStatus[]> = {
  agendada: ["em_andamento", "cancelada"],
  em_andamento: ["concluida", "cancelada"],
  concluida: [],
  cancelada: [],
};

inspectionsRouter.post("/inspections/:id/status", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const target = req.body?.status as InspStatus;
  if (!["em_andamento", "concluida", "cancelada"].includes(target)) {
    return void res.status(400).json({ error: "status deve ser em_andamento, concluida ou cancelada" });
  }
  let performedAt: string = brToday();
  if (target === "concluida" && req.body?.performed_at !== undefined) {
    const p = req.body.performed_at;
    if (typeof p !== "string" || !isRealDate(p) || p > brToday()) {
      return void res.status(400).json({ error: "performed_at inválida (AAAA-MM-DD, não pode ser futura)" });
    }
    performedAt = p;
  }
  const out = await transaction(async (tx) => {
    const [cur] = await tx.query<{ status: InspStatus }>(
      "SELECT status FROM inspections WHERE id = $1 AND organization_id = $2 FOR UPDATE",
      [parseId(req.params.id) ?? 0, orgId],
    );
    if (!cur) return { code: 404, error: "Não encontrado" };
    if (!INSP_FLOW[cur.status].includes(target)) return { code: 409, error: `Não é possível passar de ${cur.status} para ${target}` };
    if (target === "concluida") {
      const [c] = await tx.query<{ total: number; pending: number }>(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE condition IS NULL)::int AS pending
         FROM inspection_items WHERE inspection_id = $1`,
        [req.params.id],
      );
      if (c!.total === 0) return { code: 409, error: "A vistoria não tem itens no checklist" };
      if (c!.pending > 0) return { code: 409, error: `Avalie todos os itens antes de concluir (${c!.pending} sem avaliação)` };
    }
    await tx.query(
      `UPDATE inspections SET status = $1,
              performed_at = CASE WHEN $1 = 'concluida' THEN $2::date ELSE performed_at END,
              completed_at = CASE WHEN $1 = 'concluida' THEN now() ELSE completed_at END
       WHERE id = $3`,
      [target, performedAt, req.params.id],
    );
    return { code: 200 };
  });
  if (out.code !== 200) return void res.status(out.code).json({ error: out.error });
  res.json({ status: target });
});

/** Registro de ciência (nome digitado + data): não é assinatura eletrônica qualificada. */
export async function recordSignature(
  orgId: number,
  inspectionId: number,
  role: "vistoriador" | "locatario" | "proprietario",
  signerName: string,
  userId: number | null,
): Promise<{ ok: true } | { ok: false; code: number; error: string }> {
  const insp = await findInspection(orgId, inspectionId);
  if (!insp) return { ok: false, code: 404, error: "Não encontrado" };
  if (insp.status !== "concluida") return { ok: false, code: 409, error: "Só é possível assinar uma vistoria concluída" };
  try {
    await db.query(
      "INSERT INTO inspection_signatures (organization_id, inspection_id, role, signer_name, signed_by) VALUES ($1, $2, $3, $4, $5)",
      [orgId, inspectionId, role, signerName, userId],
    );
    return { ok: true };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, code: 409, error: "Esta vistoria já tem registro de ciência deste papel" };
    throw err;
  }
}

inspectionsRouter.post("/inspections/:id/signatures", async (req, res) => {
  const role = req.body?.role;
  const name = text(req.body?.signer_name, 200);
  if (!["vistoriador", "locatario", "proprietario"].includes(role) || !name) {
    return void res.status(400).json({ error: "Informe role (vistoriador|locatario|proprietario) e signer_name" });
  }
  const r = await recordSignature(req.auth!.organization.id, parseId(req.params.id) ?? 0, role, name, req.auth!.user.id);
  if (!r.ok) return void res.status(r.code).json({ error: r.error });
  res.status(201).json({ ok: true });
});

inspectionsRouter.get("/inspections/:id/report", async (req, res) => {
  const insp = await findInspection(req.auth!.organization.id, parseId(req.params.id));
  if (!insp) return void res.status(404).json({ error: "Não encontrado" });
  res.json({ report: await buildReport(db, insp.id), status: insp.status });
});

/** Compara duas vistorias concluídas da MESMA unidade (típico: entrada × saída). */
inspectionsRouter.get("/inspections/:id/compare/:otherId", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const a = await findInspection(orgId, parseId(req.params.id));
  const b = await findInspection(orgId, parseId(req.params.otherId));
  if (!a || !b) return void res.status(404).json({ error: "Não encontrado" });
  if (a.unit_id !== b.unit_id) return void res.status(409).json({ error: "As vistorias são de unidades diferentes" });
  if (a.status !== "concluida" || b.status !== "concluida") return void res.status(409).json({ error: "Compare apenas vistorias concluídas" });

  const [ia, ib] = [await loadItems(db, a.id), await loadItems(db, b.id)];
  const key = (i: { room: string; item: string }) => `${i.room}\u0000${i.item}`;
  const mapA = new Map(ia.map((i) => [key(i), i]));
  const mapB = new Map(ib.map((i) => [key(i), i]));
  const rows = [...new Set([...mapA.keys(), ...mapB.keys()])].map((k) => {
    const x = mapA.get(k);
    const y = mapB.get(k);
    const base = x ?? y!;
    let change: "igual" | "piorou" | "melhorou" | "so_na_primeira" | "so_na_segunda" = "igual";
    if (!y) change = "so_na_primeira";
    else if (!x) change = "so_na_segunda";
    else if (x.condition && y.condition && RANK[y.condition] > RANK[x.condition]) change = "piorou";
    else if (x.condition && y.condition && RANK[y.condition] < RANK[x.condition]) change = "melhorou";
    return {
      room: base.room, item: base.item, change,
      first: x ? { condition: x.condition, notes: x.notes, photos: x.photos } : null,
      second: y ? { condition: y.condition, notes: y.notes, photos: y.photos } : null,
    };
  });
  const count = (c: string) => rows.filter((r) => r.change === c).length;
  res.json({
    first: { id: a.id, type: a.type, performed_at: a.performed_at },
    second: { id: b.id, type: b.type, performed_at: b.performed_at },
    summary: { piorou: count("piorou"), melhorou: count("melhorou"), igual: count("igual"), so_na_primeira: count("so_na_primeira"), so_na_segunda: count("so_na_segunda") },
    items: rows,
  });
});
