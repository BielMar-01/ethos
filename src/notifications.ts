import { Router, type NextFunction, type Request, type Response } from "express";
import { db, transaction, type Queryable } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";
import { parseId } from "./crud.js";

export const CATEGORIES = ["financeiro", "manutencao", "vistoria", "contrato", "comunicado"] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABEL: Record<Category, string> = {
  financeiro: "Financeiro",
  manutencao: "Manutenção",
  vistoria: "Vistorias",
  contrato: "Contratos",
  comunicado: "Comunicados",
};

export interface NotifyInput {
  category: Category;
  kind: string;
  title: string;
  body?: string;
  linkKind?: string;
  linkId?: number;
  /** Mesma chave = no máximo uma notificação por pessoa (lembretes). */
  dedupeKey?: string;
}

/**
 * Cria a notificação interna para cada usuário, respeitando a preferência da categoria.
 * Devolve quantas foram criadas. NUNCA lança: uma falha de notificação não pode derrubar a ação principal.
 */
export async function notify(orgId: number, userIds: number[], n: NotifyInput, q: Queryable = db): Promise<number> {
  try {
    const ids = [...new Set(userIds)].filter((id) => Number.isInteger(id) && id > 0);
    if (ids.length === 0) return 0;
    const muted = await q.query<{ user_id: number }>(
      "SELECT user_id FROM notification_preferences WHERE organization_id = $1 AND category = $2 AND in_app = false AND user_id = ANY($3::int[])",
      [orgId, n.category, ids],
    );
    const off = new Set(muted.map((m) => m.user_id));
    let created = 0;
    for (const userId of ids) {
      if (off.has(userId)) continue;
      const rows = await q.query(
        `INSERT INTO notifications (organization_id, user_id, category, kind, title, body, link_kind, link_id, dedupe_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (organization_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
         RETURNING id`,
        [orgId, userId, n.category, n.kind, n.title.slice(0, 200), n.body?.slice(0, 500) ?? null, n.linkKind ?? null, n.linkId ?? null, n.dedupeKey ?? null],
      );
      created += rows.length;
    }
    return created;
  } catch (err) {
    console.error("Falha ao criar notificação:", err instanceof Error ? err.message : err);
    return 0;
  }
}

// ----------------------------------------------------------------- Destinatários

/** Usuários inquilinos ligados a um contrato. */
export async function tenantUsersOfLease(leaseId: number | null, q: Queryable = db): Promise<number[]> {
  if (!leaseId) return [];
  const rows = await q.query<{ user_id: number }>(
    `SELECT m.user_id FROM organization_members m JOIN lease_tenants lt ON lt.tenant_id = m.tenant_id
     WHERE lt.lease_id = $1 AND m.role = 'inquilino'`,
    [leaseId],
  );
  return rows.map((r) => r.user_id);
}

/** Usuários proprietários de um imóvel. */
export async function ownerUsersOfProperty(propertyId: number, q: Queryable = db): Promise<number[]> {
  const rows = await q.query<{ user_id: number }>(
    `SELECT m.user_id FROM organization_members m JOIN property_owners po ON po.owner_id = m.owner_id
     WHERE po.property_id = $1 AND m.role = 'proprietario'`,
    [propertyId],
  );
  return rows.map((r) => r.user_id);
}

/** Equipe: o responsável, se houver; senão todos os administradores. */
export async function staffUsers(orgId: number, assignedTo: number | null = null, q: Queryable = db): Promise<number[]> {
  if (assignedTo) return [assignedTo];
  const rows = await q.query<{ user_id: number }>(
    "SELECT user_id FROM organization_members WHERE organization_id = $1 AND role = 'admin'",
    [orgId],
  );
  return rows.map((r) => r.user_id);
}

// ------------------------------------------------------------------ Caixa de entrada

/** Notificações são pessoais: chaves de API (sem usuário) não têm caixa de entrada. */
function notForApiKey(req: Request, res: Response, next: NextFunction): void {
  if (req.auth?.viaApiKey) {
    res.status(403).json({ error: "Chaves de API não têm notificações" });
    return;
  }
  next();
}

export const notificationsRouter = Router();
notificationsRouter.use("/notifications", requireAuth, notForApiKey);

notificationsRouter.get("/notifications", async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const unreadOnly = req.query.unread === "1";
  const where = `organization_id = $1 AND user_id = $2${unreadOnly ? " AND read_at IS NULL" : ""}`;
  const params = [req.auth!.organization.id, req.auth!.user.id];
  const items = await db.query(
    `SELECT id, category, kind, title, body, link_kind, link_id, read_at, created_at
     FROM notifications WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
    params,
  );
  const [count] = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM notifications WHERE organization_id = $1 AND user_id = $2 AND read_at IS NULL",
    params,
  );
  res.json({ items, unread: count!.n });
});

notificationsRouter.get("/notifications/count", async (req, res) => {
  const [count] = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM notifications WHERE organization_id = $1 AND user_id = $2 AND read_at IS NULL",
    [req.auth!.organization.id, req.auth!.user.id],
  );
  res.json({ unread: count!.n });
});

notificationsRouter.post("/notifications/read-all", async (req, res) => {
  await db.query(
    "UPDATE notifications SET read_at = now() WHERE organization_id = $1 AND user_id = $2 AND read_at IS NULL",
    [req.auth!.organization.id, req.auth!.user.id],
  );
  res.status(204).end();
});

// Rotas fixas acima de "/:id" para não serem capturadas por ele.
notificationsRouter.get("/notifications/preferences", async (req, res) => {
  const rows = await db.query<{ category: Category; in_app: boolean }>(
    "SELECT category, in_app FROM notification_preferences WHERE organization_id = $1 AND user_id = $2",
    [req.auth!.organization.id, req.auth!.user.id],
  );
  const set = new Map(rows.map((r) => [r.category, r.in_app]));
  res.json({
    items: CATEGORIES.map((category) => ({ category, label: CATEGORY_LABEL[category], in_app: set.get(category) ?? true })),
    // Canais externos dependem de consentimento e de um provedor de envio: ainda não existem.
    channels: { in_app: true, email: false, whatsapp: false, push: false },
  });
});

notificationsRouter.put("/notifications/preferences", async (req, res) => {
  const { category, in_app } = req.body ?? {};
  if (!CATEGORIES.includes(category) || typeof in_app !== "boolean") {
    return void res.status(400).json({ error: "Informe category válida e in_app (true/false)" });
  }
  await db.query(
    `INSERT INTO notification_preferences (user_id, organization_id, category, in_app) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, organization_id, category) DO UPDATE SET in_app = EXCLUDED.in_app`,
    [req.auth!.user.id, req.auth!.organization.id, category, in_app],
  );
  res.status(204).end();
});

notificationsRouter.post("/notifications/:id/read", async (req, res) => {
  const id = parseId(req.params.id);
  const done = id
    ? await db.query(
        "UPDATE notifications SET read_at = COALESCE(read_at, now()) WHERE id = $1 AND organization_id = $2 AND user_id = $3 RETURNING id",
        [id, req.auth!.organization.id, req.auth!.user.id],
      )
    : [];
  if (done.length === 0) return void res.status(404).json({ error: "Não encontrado" });
  res.status(204).end();
});

// -------------------------------------------------------------------- Comunicados

export const announcementsRouter = Router();
const AUDIENCES = ["todos", "inquilinos", "proprietarios", "imovel"] as const;
type Audience = (typeof AUDIENCES)[number];
const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : undefined);

announcementsRouter.use("/announcements", requireAuth, requireRole("admin", "colaborador"));

announcementsRouter.get("/announcements", async (req, res) => {
  const items = await db.query(
    `SELECT a.id, a.title, a.body, a.audience, a.property_id, p.name AS property_name, a.status, a.published_at, a.created_at,
            u.name AS created_by_name
     FROM announcements a LEFT JOIN properties p ON p.id = a.property_id LEFT JOIN users u ON u.id = a.created_by
     WHERE a.organization_id = $1 ORDER BY COALESCE(a.published_at, a.created_at) DESC, a.id DESC`,
    [req.auth!.organization.id],
  );
  res.json({ items });
});

/** Valida título, texto e público; devolve os campos limpos ou a mensagem de erro. */
async function parseAnnouncement(orgId: number, body: Record<string, unknown>) {
  const title = text(body.title, 150);
  const content = text(body.body, 5000);
  const audience = body.audience as Audience;
  if (!title || !content || !AUDIENCES.includes(audience)) {
    return { error: "Informe title (até 150), body (até 5000) e audience (todos, inquilinos, proprietarios ou imovel)" };
  }
  let propertyId: number | null = null;
  if (audience === "imovel") {
    propertyId = parseId(body.property_id) ?? null;
    const found = propertyId ? await db.query("SELECT 1 FROM properties WHERE id = $1 AND organization_id = $2", [propertyId, orgId]) : [];
    if (found.length === 0) return { error: "Para o público 'imovel', informe property_id de um imóvel da organização" };
  }
  return { title, body: content, audience, propertyId };
}

announcementsRouter.post("/announcements", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const a = await parseAnnouncement(orgId, req.body ?? {});
  if ("error" in a) return void res.status(400).json({ error: a.error });
  const [row] = await db.query<{ id: number }>(
    "INSERT INTO announcements (organization_id, title, body, audience, property_id, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    [orgId, a.title, a.body, a.audience, a.propertyId, req.auth!.user.id],
  );
  res.status(201).json({ id: row!.id });
});

async function findAnnouncement(orgId: number, id: number | undefined, q: Queryable = db) {
  if (!id) return undefined;
  const [row] = await q.query<{ id: number; title: string; audience: Audience; property_id: number | null; status: string }>(
    "SELECT id, title, audience, property_id, status FROM announcements WHERE id = $1 AND organization_id = $2",
    [id, orgId],
  );
  return row;
}

announcementsRouter.patch("/announcements/:id", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const cur = await findAnnouncement(orgId, parseId(req.params.id));
  if (!cur) return void res.status(404).json({ error: "Não encontrado" });
  if (cur.status !== "rascunho") return void res.status(409).json({ error: "Comunicado publicado não pode ser editado; arquive e crie outro" });
  const a = await parseAnnouncement(orgId, req.body ?? {});
  if ("error" in a) return void res.status(400).json({ error: a.error });
  await db.query("UPDATE announcements SET title = $1, body = $2, audience = $3, property_id = $4 WHERE id = $5", [a.title, a.body, a.audience, a.propertyId, cur.id]);
  res.status(204).end();
});

announcementsRouter.delete("/announcements/:id", async (req, res) => {
  const cur = await findAnnouncement(req.auth!.organization.id, parseId(req.params.id));
  if (!cur) return void res.status(404).json({ error: "Não encontrado" });
  if (cur.status !== "rascunho") return void res.status(409).json({ error: "Só rascunhos podem ser excluídos; arquive os publicados" });
  await db.query("DELETE FROM announcements WHERE id = $1", [cur.id]);
  res.status(204).end();
});

/** Quem recebe um comunicado: só clientes JÁ vinculados a um cadastro. */
export async function announcementRecipients(orgId: number, audience: Audience, propertyId: number | null, q: Queryable = db): Promise<number[]> {
  let rows: { user_id: number }[];
  if (audience === "imovel") {
    rows = await q.query(
      `SELECT m.user_id FROM organization_members m
       WHERE m.organization_id = $1 AND (
         (m.role = 'inquilino' AND m.tenant_id IN (
            SELECT lt.tenant_id FROM lease_tenants lt JOIN leases l ON l.id = lt.lease_id AND l.status = 'vigente'
            JOIN units u ON u.id = l.unit_id WHERE u.property_id = $2))
         OR (m.role = 'proprietario' AND m.owner_id IN (SELECT owner_id FROM property_owners WHERE property_id = $2)))`,
      [orgId, propertyId],
    );
  } else {
    const roles = audience === "todos" ? ["inquilino", "proprietario"] : audience === "inquilinos" ? ["inquilino"] : ["proprietario"];
    rows = await q.query(
      "SELECT user_id FROM organization_members WHERE organization_id = $1 AND role = ANY($2::text[]) AND (tenant_id IS NOT NULL OR owner_id IS NOT NULL)",
      [orgId, roles],
    );
  }
  return rows.map((r) => r.user_id);
}

announcementsRouter.post("/announcements/:id/publish", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const cur = await findAnnouncement(orgId, parseId(req.params.id));
  if (!cur) return void res.status(404).json({ error: "Não encontrado" });
  // O UPDATE condicional garante publicação única mesmo com cliques simultâneos.
  const done = await transaction(async (tx) =>
    tx.query("UPDATE announcements SET status = 'publicado', published_at = now() WHERE id = $1 AND status = 'rascunho' RETURNING id", [cur.id]),
  );
  if (done.length === 0) return void res.status(409).json({ error: "Este comunicado já foi publicado" });
  const recipients = await announcementRecipients(orgId, cur.audience, cur.property_id);
  const notified = await notify(orgId, recipients, {
    category: "comunicado",
    kind: "announcement",
    title: cur.title,
    body: "Novo comunicado da administradora",
    linkKind: "announcement",
    linkId: cur.id,
  });
  res.json({ recipients: recipients.length, notified });
});

announcementsRouter.post("/announcements/:id/archive", async (req, res) => {
  const done = parseId(req.params.id)
    ? await db.query(
        "UPDATE announcements SET status = 'arquivado' WHERE id = $1 AND organization_id = $2 AND status = 'publicado' RETURNING id",
        [parseId(req.params.id), req.auth!.organization.id],
      )
    : [];
  if (done.length === 0) return void res.status(404).json({ error: "Comunicado publicado não encontrado" });
  res.status(204).end();
});

/** Comunicados publicados que se aplicam ao cliente logado (pelo papel e pelo vínculo). */
export const clientAnnouncementsRouter = Router();
clientAnnouncementsRouter.get("/portal/announcements", requireAuth, requireRole("inquilino", "proprietario"), async (req, res) => {
  const a = req.auth!;
  const personId = a.role === "inquilino" ? a.tenantId : a.ownerId;
  if (!personId) return void res.json({ items: [] });
  const items = await db.query(
    `SELECT a.id, a.title, a.body, a.audience, a.published_at, p.name AS property_name
     FROM announcements a LEFT JOIN properties p ON p.id = a.property_id
     WHERE a.organization_id = $1 AND a.status = 'publicado' AND (
       a.audience = 'todos'
       OR (a.audience = 'inquilinos' AND $2 = 'inquilino')
       OR (a.audience = 'proprietarios' AND $2 = 'proprietario')
       OR (a.audience = 'imovel' AND (
            ($2 = 'inquilino' AND a.property_id IN (
               SELECT u.property_id FROM units u JOIN leases l ON l.unit_id = u.id AND l.status = 'vigente'
               JOIN lease_tenants lt ON lt.lease_id = l.id WHERE lt.tenant_id = $3))
            OR ($2 = 'proprietario' AND a.property_id IN (SELECT property_id FROM property_owners WHERE owner_id = $3)))))
     ORDER BY a.published_at DESC, a.id DESC`,
    [a.organization.id, a.role, personId],
  );
  res.json({ items });
});
