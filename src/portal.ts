import { Router, type NextFunction, type Request, type Response } from "express";
import { db } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";
import { parseId } from "./crud.js";
import { CHARGE_SELECT } from "./finance.js";

/**
 * Área do cliente. Cada rota deriva TUDO do vínculo do acesso (tenantId/ownerId vindos da sessão):
 * nenhum identificador de pessoa é aceito do cliente.
 */
export const portalRouter = Router();
portalRouter.use("/portal", requireAuth);

/** Garante que o acesso do inquilino está vinculado a um cadastro. */
function tenantOnly(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth?.tenantId) {
    res.status(409).json({ error: "Seu acesso ainda não está vinculado a um cadastro de inquilino. Fale com a administradora." });
    return;
  }
  next();
}

function ownerOnly(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth?.ownerId) {
    res.status(409).json({ error: "Seu acesso ainda não está vinculado a um cadastro de proprietário. Fale com a administradora." });
    return;
  }
  next();
}

portalRouter.get("/portal/me", requireRole("inquilino", "proprietario"), async (req, res) => {
  const a = req.auth!;
  if (a.role === "inquilino") {
    const [t] = a.tenantId ? await db.query<{ name: string }>("SELECT name FROM tenants WHERE id = $1", [a.tenantId]) : [];
    res.json({ kind: "tenant", linked: Boolean(t), name: t?.name ?? null });
    return;
  }
  const [o] = a.ownerId ? await db.query<{ name: string }>("SELECT name FROM owners WHERE id = $1", [a.ownerId]) : [];
  res.json({ kind: "owner", linked: Boolean(o), name: o?.name ?? null });
});

// ------------------------------------------------------------------ Inquilino

export const tenantGuard = [requireRole("inquilino"), tenantOnly];
export const MY_LEASES = "SELECT lease_id FROM lease_tenants WHERE tenant_id = $2";

portalRouter.get("/portal/tenant/leases", ...tenantGuard, async (req, res) => {
  const items = await db.query(
    `SELECT l.id, l.status, l.start_date, l.end_date, l.rent_cents, l.due_day, l.guarantee,
            u.identifier AS unit_identifier, p.name AS property_name,
            p.street, p.number, p.complement, p.neighborhood, p.city, p.state, p.zip
     FROM leases l
     JOIN units u ON u.id = l.unit_id
     JOIN properties p ON p.id = u.property_id
     WHERE l.organization_id = $1 AND l.status <> 'rascunho' AND l.id IN (${MY_LEASES})
     ORDER BY l.start_date DESC`,
    [req.auth!.organization.id, req.auth!.tenantId],
  );
  res.json({ items });
});

portalRouter.get("/portal/tenant/charges", ...tenantGuard, async (req, res) => {
  const params: unknown[] = [req.auth!.organization.id, req.auth!.tenantId];
  let outer = "";
  if (req.query.status !== undefined) {
    if (!["aberta", "parcial", "vencida", "paga"].includes(String(req.query.status))) {
      res.status(400).json({ error: "status inválido" });
      return;
    }
    params.push(req.query.status);
    outer = " WHERE x.status = $3";
  }
  const items = await db.query(
    `SELECT x.id, x.kind, x.description, x.competence, x.due_date, x.amount_cents, x.paid_cents, x.status,
            x.unit_identifier, x.property_name
     FROM (${CHARGE_SELECT}
           WHERE c.organization_id = $1 AND c.cancelled_at IS NULL AND c.lease_id IN (${MY_LEASES})) x${outer}
     ORDER BY x.due_date DESC, x.id DESC`,
    params,
  );
  res.json({ items });
});

portalRouter.get("/portal/tenant/payments", ...tenantGuard, async (req, res) => {
  const items = await db.query(
    `SELECT p.id, p.received_at, p.amount_cents, p.method, p.receipt_number, p.voided_at,
            u.identifier AS unit_identifier, pr.name AS property_name
     FROM payments p
     JOIN leases l ON l.id = p.lease_id
     JOIN units u ON u.id = l.unit_id
     JOIN properties pr ON pr.id = u.property_id
     WHERE p.organization_id = $1 AND p.lease_id IN (${MY_LEASES})
     ORDER BY p.received_at DESC, p.id DESC`,
    [req.auth!.organization.id, req.auth!.tenantId],
  );
  res.json({ items });
});

portalRouter.get("/portal/tenant/payments/:id", ...tenantGuard, async (req, res) => {
  const id = parseId(req.params.id);
  const [payment] = id
    ? await db.query(
        `SELECT p.id, p.received_at, p.amount_cents, p.method, p.receipt_number, p.receipt_content, p.voided_at, p.void_reason
         FROM payments p
         WHERE p.id = $3 AND p.organization_id = $1 AND p.lease_id IN (${MY_LEASES})`,
        [req.auth!.organization.id, req.auth!.tenantId, id],
      )
    : [];
  if (!payment) {
    res.status(404).json({ error: "Não encontrado" });
    return;
  }
  res.json({ payment });
});

portalRouter.get("/portal/tenant/documents", ...tenantGuard, async (req, res) => {
  const items = await db.query(
    `SELECT d.id, d.lease_id, d.template_name, d.template_version, d.created_at
     FROM contract_documents d
     WHERE d.organization_id = $1 AND d.lease_id IN (${MY_LEASES}) ORDER BY d.id DESC`,
    [req.auth!.organization.id, req.auth!.tenantId],
  );
  res.json({ items });
});

portalRouter.get("/portal/tenant/documents/:id", ...tenantGuard, async (req, res) => {
  const id = parseId(req.params.id);
  const [document] = id
    ? await db.query(
        `SELECT d.id, d.lease_id, d.template_name, d.template_version, d.content, d.created_at
         FROM contract_documents d
         WHERE d.id = $3 AND d.organization_id = $1 AND d.lease_id IN (${MY_LEASES})`,
        [req.auth!.organization.id, req.auth!.tenantId, id],
      )
    : [];
  if (!document) {
    res.status(404).json({ error: "Não encontrado" });
    return;
  }
  res.json({ document });
});

// --------------------------------------------------------------- Proprietário

export const ownerGuard = [requireRole("proprietario"), ownerOnly];
export const MY_PROPERTIES = "SELECT property_id FROM property_owners WHERE owner_id = $2";

portalRouter.get("/portal/owner/properties", ...ownerGuard, async (req, res) => {
  const items = await db.query(
    `SELECT p.id, p.name, p.type, p.street, p.number, p.neighborhood, p.city, p.state,
            (SELECT count(*)::int FROM units u WHERE u.property_id = p.id) AS units_total,
            (SELECT count(*)::int FROM units u WHERE u.property_id = p.id AND u.status = 'ocupada') AS units_occupied
     FROM properties p
     WHERE p.organization_id = $1 AND p.id IN (${MY_PROPERTIES}) ORDER BY p.name`,
    [req.auth!.organization.id, req.auth!.ownerId],
  );
  res.json({ items });
});

/** Unidades dos meus imóveis, com o contrato vigente (sem documentos pessoais do inquilino). */
portalRouter.get("/portal/owner/units", ...ownerGuard, async (req, res) => {
  const items = await db.query(
    `SELECT u.id, u.identifier, u.status, p.id AS property_id, p.name AS property_name,
            l.id AS lease_id, l.rent_cents, l.start_date, l.end_date,
            (SELECT string_agg(t.name, ', ' ORDER BY lt.position)
               FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id WHERE lt.lease_id = l.id) AS tenant_names
     FROM units u
     JOIN properties p ON p.id = u.property_id
     LEFT JOIN leases l ON l.unit_id = u.id AND l.status = 'vigente'
     WHERE u.organization_id = $1 AND u.property_id IN (${MY_PROPERTIES})
     ORDER BY p.name, u.identifier`,
    [req.auth!.organization.id, req.auth!.ownerId],
  );
  res.json({ items });
});

portalRouter.get("/portal/owner/transfers", ...ownerGuard, async (req, res) => {
  const items = await db.query(
    `SELECT id, period, gross_cents, fee_cents, net_cents, fee_bps, status, paid_at
     FROM owner_transfers WHERE organization_id = $1 AND owner_id = $2 ORDER BY period DESC`,
    [req.auth!.organization.id, req.auth!.ownerId],
  );
  res.json({ items });
});
