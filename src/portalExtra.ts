import { Router, type Request } from "express";
import { requireAuth } from "./auth.js";
import { db, transaction } from "./db.js";
import { parseId } from "./crud.js";
import { CATEGORIES, addUpdate, isTerminal, type MaintStatus } from "./maintenance.js";
import { buildReport, loadItems, loadSignatures, recordSignature } from "./inspections.js";
import { rawImage, storePhoto } from "./photos.js";
import { RateLimiter } from "./ratelimit.js";
import { tenantGuard, ownerGuard, MY_LEASES, MY_PROPERTIES } from "./portal.js";

// Manutenção e vistorias na área do cliente. Mesmas regras do portal: tudo deriva do vínculo da sessão.
export const portalExtraRouter = Router();
portalExtraRouter.use("/portal", requireAuth);

const openLimiter = new RateLimiter(10, 60 * 60 * 1000); // 10 chamados/hora por inquilino
const clientAuthor = (req: Request) => ({ id: req.auth!.user.id, name: req.auth!.user.name });
const clientText = (v: unknown, max: number) => (typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : undefined);
const TENANT_PRIORITIES = ["baixa", "media", "alta"]; // "urgente" é definido pela equipe

// ------------------------------------------------------- Manutenção (inquilino)

portalExtraRouter.get("/portal/tenant/maintenance", ...tenantGuard, async (req, res) => {
  const items = await db.query(
    `SELECT m.id, m.title, m.category, m.priority, m.status, m.created_at, m.updated_at, m.completed_at,
            u.identifier AS unit_identifier, p.name AS property_name
     FROM maintenance_requests m JOIN units u ON u.id = m.unit_id JOIN properties p ON p.id = u.property_id
     WHERE m.organization_id = $1 AND m.lease_id IN (${MY_LEASES})
     ORDER BY (m.status IN ('concluida','cancelada')), m.created_at DESC`,
    [req.auth!.organization.id, req.auth!.tenantId],
  );
  res.json({ items });
});

portalExtraRouter.post("/portal/tenant/maintenance", ...tenantGuard, async (req, res) => {
  const { category, priority = "media" } = req.body ?? {};
  const title = clientText(req.body?.title, 200);
  const description = clientText(req.body?.description, 4000);
  const leaseId = parseId(req.body?.lease_id);
  if (!leaseId || !title || !description || !CATEGORIES.includes(category) || !TENANT_PRIORITIES.includes(priority)) {
    return void res.status(400).json({ error: "Informe lease_id, category, title, description e priority (baixa, media ou alta)" });
  }
  if (!openLimiter.allow(`tenant:${req.auth!.tenantId}`)) {
    return void res.status(429).json({ error: "Muitas solicitações em pouco tempo. Tente novamente mais tarde." });
  }
  // Só abre chamado para contrato VIGENTE dele.
  const [lease] = await db.query<{ unit_id: number }>(
    `SELECT l.unit_id FROM leases l WHERE l.id = $3 AND l.organization_id = $1 AND l.status = 'vigente' AND l.id IN (${MY_LEASES})`,
    [req.auth!.organization.id, req.auth!.tenantId, leaseId],
  );
  if (!lease) return void res.status(400).json({ error: "Contrato inexistente ou não vigente" });
  const created = await transaction(async (tx) => {
    const [row] = await tx.query<{ id: number }>(
      `INSERT INTO maintenance_requests (organization_id, unit_id, lease_id, opened_by_tenant_id, created_by, category, title, description, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [req.auth!.organization.id, lease.unit_id, leaseId, req.auth!.tenantId, req.auth!.user.id, category, title, description, priority],
    );
    await addUpdate(tx, req.auth!.organization.id, row!.id, clientAuthor(req), "status", "Solicitação aberta pelo inquilino");
    return row!;
  });
  res.status(201).json({ id: created.id });
});

/** Chamado do contrato do inquilino. Não expõe orçamentos, custos nem notas internas. */
async function ownMaintenance(req: Request) {
  const id = parseId(req.params.id);
  if (!id) return undefined;
  const [row] = await db.query<{ id: number; status: MaintStatus }>(
    `SELECT m.id, m.status FROM maintenance_requests m
     WHERE m.id = $3 AND m.organization_id = $1 AND m.lease_id IN (${MY_LEASES})`,
    [req.auth!.organization.id, req.auth!.tenantId, id],
  );
  return row;
}

portalExtraRouter.get("/portal/tenant/maintenance/:id", ...tenantGuard, async (req, res) => {
  const own = await ownMaintenance(req);
  if (!own) return void res.status(404).json({ error: "Não encontrado" });
  const [item] = await db.query(
    `SELECT m.id, m.title, m.description, m.category, m.priority, m.status, m.cancelled_reason, m.created_at, m.completed_at,
            u.identifier AS unit_identifier, p.name AS property_name
     FROM maintenance_requests m JOIN units u ON u.id = m.unit_id JOIN properties p ON p.id = u.property_id WHERE m.id = $1`,
    [own.id],
  );
  const updates = await db.query(
    "SELECT id, author_name, kind, message, created_at FROM maintenance_updates WHERE request_id = $1 AND client_visible ORDER BY id",
    [own.id],
  );
  const photos = await db.query<{ id: number }>("SELECT id FROM photos WHERE maintenance_request_id = $1 ORDER BY id", [own.id]);
  res.json({ item, updates, photos: photos.map((p) => p.id) });
});

portalExtraRouter.post("/portal/tenant/maintenance/:id/comments", ...tenantGuard, async (req, res) => {
  const own = await ownMaintenance(req);
  if (!own) return void res.status(404).json({ error: "Não encontrado" });
  if (isTerminal(own.status)) return void res.status(409).json({ error: "Chamado encerrado" });
  const message = clientText(req.body?.message, 2000);
  if (!message) return void res.status(400).json({ error: "Informe a mensagem (até 2000 caracteres)" });
  await addUpdate(db, req.auth!.organization.id, own.id, clientAuthor(req), "comentario", message, true);
  res.status(201).json({ ok: true });
});

portalExtraRouter.post("/portal/tenant/maintenance/:id/cancel", ...tenantGuard, async (req, res) => {
  const own = await ownMaintenance(req);
  if (!own) return void res.status(404).json({ error: "Não encontrado" });
  if (own.status !== "aberta") {
    return void res.status(409).json({ error: "Só é possível cancelar enquanto a solicitação está aberta; fale com a administradora" });
  }
  const reason = clientText(req.body?.reason, 300) ?? "Cancelada pelo inquilino";
  await transaction(async (tx) => {
    await tx.query("UPDATE maintenance_requests SET status = 'cancelada', cancelled_reason = $1 WHERE id = $2", [reason, own.id]);
    await addUpdate(tx, req.auth!.organization.id, own.id, clientAuthor(req), "status", `Status: Cancelada — ${reason}`);
  });
  res.status(204).end();
});

portalExtraRouter.post("/portal/tenant/maintenance/:id/photos", ...tenantGuard, rawImage, async (req, res) => {
  const own = await ownMaintenance(req);
  if (!own) return void res.status(404).json({ error: "Não encontrado" });
  if (isTerminal(own.status)) return void res.status(409).json({ error: "Chamado encerrado não aceita novas fotos" });
  const r = await storePhoto(req.auth!.organization.id, req.auth!.user.id, { maintenanceRequestId: own.id }, req.body);
  if (!r.ok) return void res.status(r.code).json({ error: r.error });
  await db.query("UPDATE maintenance_requests SET updated_at = now() WHERE id = $1", [own.id]);
  res.status(201).json({ id: r.id });
});

// ----------------------------------------------------- Manutenção (proprietário)

portalExtraRouter.get("/portal/owner/maintenance", ...ownerGuard, async (req, res) => {
  const items = await db.query(
    `SELECT m.id, m.title, m.category, m.priority, m.status, m.created_at, m.completed_at,
            CASE WHEN m.status = 'concluida' THEN m.cost_cents END AS cost_cents,
            u.identifier AS unit_identifier, p.name AS property_name
     FROM maintenance_requests m JOIN units u ON u.id = m.unit_id JOIN properties p ON p.id = u.property_id
     WHERE m.organization_id = $1 AND u.property_id IN (${MY_PROPERTIES})
     ORDER BY (m.status IN ('concluida','cancelada')), m.created_at DESC`,
    [req.auth!.organization.id, req.auth!.ownerId],
  );
  res.json({ items });
});

// -------------------------------------------------------------------- Vistorias

/** Só vistorias CONCLUÍDAS: do contrato do inquilino ou dos imóveis do proprietário. */
const TENANT_INSP = `i.lease_id IN (${MY_LEASES})`;
const OWNER_INSP = `i.unit_id IN (SELECT u.id FROM units u WHERE u.property_id IN (${MY_PROPERTIES}))`;

async function listInspections(req: Request, scope: string, personId: number | null) {
  return db.query(
    `SELECT i.id, i.type, i.performed_at, i.unit_id, u.identifier AS unit_identifier, p.name AS property_name
     FROM inspections i JOIN units u ON u.id = i.unit_id JOIN properties p ON p.id = u.property_id
     WHERE i.organization_id = $1 AND i.status = 'concluida' AND ${scope}
     ORDER BY i.performed_at DESC, i.id DESC`,
    [req.auth!.organization.id, personId],
  );
}

async function inspectionDetail(req: Request, scope: string, personId: number | null) {
  const id = parseId(req.params.id);
  const [inspection] = id
    ? await db.query<{ id: number }>(
        `SELECT i.id, i.type, i.performed_at, u.identifier AS unit_identifier, p.name AS property_name, i.notes
         FROM inspections i JOIN units u ON u.id = i.unit_id JOIN properties p ON p.id = u.property_id
         WHERE i.id = $3 AND i.organization_id = $1 AND i.status = 'concluida' AND ${scope}`,
        [req.auth!.organization.id, personId, id],
      )
    : [];
  if (!inspection) return undefined;
  return {
    inspection,
    items: await loadItems(db, inspection.id),
    signatures: await loadSignatures(db, inspection.id),
    report: await buildReport(db, inspection.id),
  };
}

portalExtraRouter.get("/portal/tenant/inspections", ...tenantGuard, async (req, res) => {
  res.json({ items: await listInspections(req, TENANT_INSP, req.auth!.tenantId) });
});

portalExtraRouter.get("/portal/tenant/inspections/:id", ...tenantGuard, async (req, res) => {
  const d = await inspectionDetail(req, TENANT_INSP, req.auth!.tenantId);
  if (!d) return void res.status(404).json({ error: "Não encontrado" });
  res.json(d);
});

portalExtraRouter.post("/portal/tenant/inspections/:id/sign", ...tenantGuard, async (req, res) => {
  const d = await inspectionDetail(req, TENANT_INSP, req.auth!.tenantId);
  if (!d) return void res.status(404).json({ error: "Não encontrado" });
  const name = clientText(req.body?.signer_name, 200);
  if (!name) return void res.status(400).json({ error: "Informe seu nome completo" });
  const r = await recordSignature(req.auth!.organization.id, d.inspection.id, "locatario", name, req.auth!.user.id);
  if (!r.ok) return void res.status(r.code).json({ error: r.error });
  res.status(201).json({ ok: true });
});

portalExtraRouter.get("/portal/owner/inspections", ...ownerGuard, async (req, res) => {
  res.json({ items: await listInspections(req, OWNER_INSP, req.auth!.ownerId) });
});

portalExtraRouter.get("/portal/owner/inspections/:id", ...ownerGuard, async (req, res) => {
  const d = await inspectionDetail(req, OWNER_INSP, req.auth!.ownerId);
  if (!d) return void res.status(404).json({ error: "Não encontrado" });
  res.json(d);
});

portalExtraRouter.post("/portal/owner/inspections/:id/sign", ...ownerGuard, async (req, res) => {
  const d = await inspectionDetail(req, OWNER_INSP, req.auth!.ownerId);
  if (!d) return void res.status(404).json({ error: "Não encontrado" });
  const name = clientText(req.body?.signer_name, 200);
  if (!name) return void res.status(400).json({ error: "Informe seu nome completo" });
  const r = await recordSignature(req.auth!.organization.id, d.inspection.id, "proprietario", name, req.auth!.user.id);
  if (!r.ok) return void res.status(r.code).json({ error: r.error });
  res.status(201).json({ ok: true });
});
