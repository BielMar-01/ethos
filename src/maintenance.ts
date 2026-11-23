import { Router } from "express";
import { db, transaction, type Queryable } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";
import { parseId } from "./crud.js";
import { rawImage, storePhoto } from "./photos.js";
import { notify, staffUsers, tenantUsersOfLease } from "./notifications.js";

export const CATEGORIES = ["hidraulica", "eletrica", "estrutural", "pintura", "fechaduras", "eletrodomesticos", "pragas", "outro"] as const;
export const PRIORITIES = ["baixa", "media", "alta", "urgente"] as const;
export type MaintStatus = "aberta" | "em_analise" | "aguardando_aprovacao" | "aprovada" | "em_execucao" | "concluida" | "cancelada";

export const STATUS_LABEL: Record<MaintStatus, string> = {
  aberta: "Aberta",
  em_analise: "Em análise",
  aguardando_aprovacao: "Aguardando aprovação",
  aprovada: "Aprovada",
  em_execucao: "Em execução",
  concluida: "Concluída",
  cancelada: "Cancelada",
};

/** Transições permitidas pelo endpoint de status ("aprovada" só ocorre ao aprovar um orçamento). */
const FLOW: Record<MaintStatus, MaintStatus[]> = {
  aberta: ["em_analise", "cancelada"],
  em_analise: ["aguardando_aprovacao", "em_execucao", "cancelada"],
  aguardando_aprovacao: ["em_analise", "cancelada"],
  aprovada: ["em_execucao", "cancelada"],
  em_execucao: ["concluida", "cancelada"],
  concluida: [],
  cancelada: [],
};

export const isTerminal = (s: MaintStatus) => s === "concluida" || s === "cancelada";

export interface Author {
  id: number | null;
  name: string;
}

/** Registra um evento na linha do tempo do chamado. */
export async function addUpdate(
  q: Queryable,
  orgId: number,
  requestId: number,
  author: Author,
  kind: "status" | "comentario" | "orcamento",
  message: string,
  clientVisible = true,
): Promise<void> {
  await q.query(
    `INSERT INTO maintenance_updates (organization_id, request_id, author_user_id, author_name, kind, message, client_visible)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [orgId, requestId, author.id, author.name, kind, message, clientVisible],
  );
  await q.query("UPDATE maintenance_requests SET updated_at = now() WHERE id = $1", [requestId]);
}

/** Avisa os inquilinos do contrato sobre o chamado (só eventos visíveis ao cliente). */
export async function notifyRequestTenants(orgId: number, requestId: number, kind: string, body: string): Promise<void> {
  const [r] = await db.query<{ title: string; lease_id: number | null }>("SELECT title, lease_id FROM maintenance_requests WHERE id = $1", [requestId]);
  if (!r) return;
  await notify(orgId, await tenantUsersOfLease(r.lease_id), { category: "manutencao", kind, title: `Chamado: ${r.title}`, body, linkKind: "maintenance", linkId: requestId });
}

/** Avisa a equipe (o responsável, ou os administradores) sobre algo que o cliente fez no chamado. */
export async function notifyRequestStaff(orgId: number, requestId: number, kind: string, body: string): Promise<void> {
  const [r] = await db.query<{ title: string; assigned_to: number | null }>("SELECT title, assigned_to FROM maintenance_requests WHERE id = $1", [requestId]);
  if (!r) return;
  await notify(orgId, await staffUsers(orgId, r.assigned_to), { category: "manutencao", kind, title: `Chamado: ${r.title}`, body, linkKind: "maintenance", linkId: requestId });
}

export const maintenanceRouter = Router();
maintenanceRouter.use("/maintenance", requireAuth, requireRole("admin", "colaborador"));

const text = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : undefined;

const authorOf = (req: { auth?: { user: { id: number; name: string } } }): Author => ({ id: req.auth!.user.id, name: req.auth!.user.name });

const LIST_SQL = `
  SELECT m.id, m.title, m.category, m.priority, m.status, m.created_at, m.updated_at, m.completed_at, m.cost_cents,
         m.unit_id, u.identifier AS unit_identifier, p.name AS property_name,
         m.assigned_to, au.name AS assigned_name, t.name AS opened_by_name,
         (SELECT count(*)::int FROM maintenance_quotes q WHERE q.request_id = m.id) AS quotes_count
  FROM maintenance_requests m
  JOIN units u ON u.id = m.unit_id
  JOIN properties p ON p.id = u.property_id
  LEFT JOIN users au ON au.id = m.assigned_to
  LEFT JOIN tenants t ON t.id = m.opened_by_tenant_id`;

maintenanceRouter.get("/maintenance", async (req, res) => {
  const params: unknown[] = [req.auth!.organization.id];
  let where = "m.organization_id = $1";
  const status = req.query.status;
  if (status !== undefined) {
    if (!Object.keys(STATUS_LABEL).includes(String(status))) {
      res.status(400).json({ error: "status inválido" });
      return;
    }
    params.push(status);
    where += ` AND m.status = $${params.length}`;
  }
  if (req.query.unit_id !== undefined) {
    const unitId = parseId(req.query.unit_id);
    if (!unitId) {
      res.status(400).json({ error: "unit_id inválido" });
      return;
    }
    params.push(unitId);
    where += ` AND m.unit_id = $${params.length}`;
  }
  const items = await db.query(
    `${LIST_SQL} WHERE ${where}
     ORDER BY (m.status IN ('concluida','cancelada')),
              CASE m.priority WHEN 'urgente' THEN 0 WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END,
              m.created_at DESC`,
    params,
  );
  res.json({ items });
});

/** O responsável precisa ser da equipe (admin/colaborador) da própria organização. */
async function validAssignee(orgId: number, userId: unknown): Promise<number | null | undefined> {
  if (userId === null) return null;
  const id = parseId(userId);
  if (!id) return undefined;
  const found = await db.query(
    "SELECT 1 FROM organization_members WHERE organization_id = $1 AND user_id = $2 AND role IN ('admin','colaborador')",
    [orgId, id],
  );
  return found.length ? id : undefined;
}

maintenanceRouter.post("/maintenance", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const { category, priority = "media" } = req.body ?? {};
  const title = text(req.body?.title, 200);
  const description = text(req.body?.description, 4000);
  const unitId = parseId(req.body?.unit_id);
  if (!unitId || !title || !description || !CATEGORIES.includes(category) || !PRIORITIES.includes(priority)) {
    res.status(400).json({ error: "Informe unit_id, category, title, description e priority válidos" });
    return;
  }
  const [unit] = await db.query("SELECT 1 FROM units WHERE id = $1 AND organization_id = $2", [unitId, orgId]);
  if (!unit) {
    res.status(400).json({ error: "Unidade inexistente" });
    return;
  }
  const created = await transaction(async (tx) => {
    // Se há contrato vigente na unidade, o chamado fica ligado a ele (o inquilino passa a acompanhá-lo).
    const [lease] = await tx.query<{ id: number }>(
      "SELECT id FROM leases WHERE unit_id = $1 AND status = 'vigente' ORDER BY start_date DESC LIMIT 1",
      [unitId],
    );
    const [row] = await tx.query<{ id: number }>(
      `INSERT INTO maintenance_requests (organization_id, unit_id, lease_id, created_by, category, title, description, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [orgId, unitId, lease?.id ?? null, req.auth!.user.id, category, title, description, priority],
    );
    await addUpdate(tx, orgId, row!.id, authorOf(req), "status", "Solicitação aberta pela administradora");
    return row!;
  });
  res.status(201).json({ id: created.id });
});

maintenanceRouter.get("/maintenance/:id", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const id = parseId(req.params.id);
  const [item] = id ? await db.query(`${LIST_SQL} WHERE m.organization_id = $1 AND m.id = $2`, [orgId, id]) : [];
  if (!item) {
    res.status(404).json({ error: "Não encontrado" });
    return;
  }
  const [detail] = await db.query("SELECT description, cancelled_reason, lease_id FROM maintenance_requests WHERE id = $1", [id]);
  const quotes = await db.query(
    `SELECT q.id, q.supplier, q.amount_cents, q.notes, q.status, q.created_at, q.decided_at, d.name AS decided_by_name
     FROM maintenance_quotes q LEFT JOIN users d ON d.id = q.decided_by
     WHERE q.request_id = $1 ORDER BY q.id`,
    [id],
  );
  const updates = await db.query(
    "SELECT id, author_name, kind, message, client_visible, created_at FROM maintenance_updates WHERE request_id = $1 ORDER BY id",
    [id],
  );
  const photos = await db.query("SELECT id, content_type, size_bytes FROM photos WHERE maintenance_request_id = $1 ORDER BY id", [id]);
  res.json({ item: { ...item, ...detail }, quotes, updates, photos });
});

maintenanceRouter.patch("/maintenance/:id", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const id = parseId(req.params.id);
  const [current] = id
    ? await db.query<{ status: MaintStatus; assigned_to: number | null }>(
        "SELECT status, assigned_to FROM maintenance_requests WHERE id = $1 AND organization_id = $2",
        [id, orgId],
      )
    : [];
  if (!current) {
    res.status(404).json({ error: "Não encontrado" });
    return;
  }
  if (isTerminal(current.status)) {
    res.status(409).json({ error: "Chamado encerrado não pode ser editado" });
    return;
  }
  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  const b = req.body ?? {};
  if (b.title !== undefined) {
    const v = text(b.title, 200);
    if (!v) return void res.status(400).json({ error: "title inválido" });
    set("title", v);
  }
  if (b.description !== undefined) {
    const v = text(b.description, 4000);
    if (!v) return void res.status(400).json({ error: "description inválida" });
    set("description", v);
  }
  if (b.category !== undefined) {
    if (!CATEGORIES.includes(b.category)) return void res.status(400).json({ error: "category inválida" });
    set("category", b.category);
  }
  if (b.priority !== undefined) {
    if (!PRIORITIES.includes(b.priority)) return void res.status(400).json({ error: "priority inválida" });
    set("priority", b.priority);
  }
  let newAssignee: number | null | undefined;
  if (b.assigned_to !== undefined) {
    newAssignee = await validAssignee(orgId, b.assigned_to);
    if (newAssignee === undefined) return void res.status(400).json({ error: "Responsável deve ser da equipe da organização" });
    set("assigned_to", newAssignee);
  }
  if (sets.length === 0) return void res.status(400).json({ error: "Nenhum campo para atualizar" });
  await transaction(async (tx) => {
    await tx.query(`UPDATE maintenance_requests SET ${sets.join(", ")}, updated_at = now() WHERE id = $${vals.length + 1}`, [...vals, id]);
    if (newAssignee !== undefined && newAssignee !== current.assigned_to) {
      const [who] = newAssignee ? await tx.query<{ name: string }>("SELECT name FROM users WHERE id = $1", [newAssignee]) : [];
      await addUpdate(tx, orgId, id!, authorOf(req), "comentario", who ? `Responsável: ${who.name}` : "Responsável removido", false);
    }
  });
  res.status(204).end();
});

maintenanceRouter.post("/maintenance/:id/status", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const id = parseId(req.params.id);
  const target = req.body?.status as MaintStatus;
  if (!Object.keys(STATUS_LABEL).includes(target)) {
    res.status(400).json({ error: "status inválido" });
    return;
  }
  if (target === "aprovada") {
    res.status(409).json({ error: "O chamado passa a 'aprovada' ao aprovar um orçamento" });
    return;
  }
  const reason = target === "cancelada" ? text(req.body?.reason, 300) : undefined;
  if (target === "cancelada" && !reason) {
    res.status(400).json({ error: "Informe o motivo do cancelamento" });
    return;
  }
  let cost: number | null = null;
  if (target === "concluida" && req.body?.cost_cents !== undefined && req.body.cost_cents !== null) {
    cost = req.body.cost_cents;
    if (!Number.isInteger(cost) || cost! < 0 || cost! > 2_147_483_647) {
      res.status(400).json({ error: "cost_cents deve ser inteiro (centavos) >= 0" });
      return;
    }
  }
  const out = await transaction(async (tx) => {
    const [cur] = id
      ? await tx.query<{ status: MaintStatus }>("SELECT status FROM maintenance_requests WHERE id = $1 AND organization_id = $2 FOR UPDATE", [id, orgId])
      : [];
    if (!cur) return { code: 404, error: "Não encontrado" };
    if (!FLOW[cur.status].includes(target)) {
      return { code: 409, error: `Não é possível passar de "${STATUS_LABEL[cur.status]}" para "${STATUS_LABEL[target]}"` };
    }
    if (target === "aguardando_aprovacao") {
      const [pending] = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM maintenance_quotes WHERE request_id = $1 AND status = 'pendente'", [id]);
      if (pending!.n === 0) return { code: 409, error: "Registre ao menos um orçamento antes de enviar para aprovação" };
    }
    await tx.query(
      `UPDATE maintenance_requests
       SET status = $1, cancelled_reason = $2, cost_cents = COALESCE($3, cost_cents),
           completed_at = CASE WHEN $1 = 'concluida' THEN now() ELSE completed_at END
       WHERE id = $4`,
      [target, reason ?? null, cost, id],
    );
    const note = target === "cancelada" ? ` — ${reason}` : "";
    await addUpdate(tx, orgId, id!, authorOf(req), "status", `Status: ${STATUS_LABEL[target]}${note}`);
    return { code: 200 };
  });
  if (out.code !== 200) return void res.status(out.code).json({ error: out.error });
  await notifyRequestTenants(orgId, id!, "maintenance_status", `Status: ${STATUS_LABEL[target]}`);
  res.json({ status: target });
});

maintenanceRouter.post("/maintenance/:id/comments", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const id = parseId(req.params.id);
  const message = text(req.body?.message, 2000);
  if (!message) return void res.status(400).json({ error: "Informe a mensagem (até 2000 caracteres)" });
  const [row] = id ? await db.query("SELECT 1 FROM maintenance_requests WHERE id = $1 AND organization_id = $2", [id, orgId]) : [];
  if (!row) return void res.status(404).json({ error: "Não encontrado" });
  // Por padrão a nota é INTERNA; só vira visível ao cliente se a equipe marcar.
  const visible = req.body?.client_visible === true;
  await addUpdate(db, orgId, id!, authorOf(req), "comentario", message, visible);
  if (visible) await notifyRequestTenants(orgId, id!, "maintenance_comment", message.slice(0, 200));
  res.status(201).json({ ok: true });
});

// ------------------------------------------------------------------ Orçamentos

maintenanceRouter.post("/maintenance/:id/quotes", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const id = parseId(req.params.id);
  const supplier = text(req.body?.supplier, 200);
  const amount = req.body?.amount_cents;
  const notes = req.body?.notes === undefined || req.body.notes === null ? null : text(req.body.notes, 1000);
  if (!supplier || !Number.isInteger(amount) || amount < 1 || amount > 2_147_483_647 || notes === undefined) {
    return void res.status(400).json({ error: "Informe supplier e amount_cents (inteiro positivo, em centavos)" });
  }
  const out = await transaction(async (tx) => {
    const [cur] = id
      ? await tx.query<{ status: MaintStatus }>("SELECT status FROM maintenance_requests WHERE id = $1 AND organization_id = $2 FOR UPDATE", [id, orgId])
      : [];
    if (!cur) return { code: 404, error: "Não encontrado" };
    if (!["em_analise", "aguardando_aprovacao"].includes(cur.status)) {
      return { code: 409, error: "Orçamentos só podem ser registrados com o chamado em análise ou aguardando aprovação" };
    }
    const [q] = await tx.query<{ id: number }>(
      "INSERT INTO maintenance_quotes (organization_id, request_id, supplier, amount_cents, notes, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [orgId, id, supplier, amount, notes, req.auth!.user.id],
    );
    // Valores de orçamento são internos: não aparecem na linha do tempo do cliente.
    await addUpdate(tx, orgId, id!, authorOf(req), "orcamento", `Orçamento de ${supplier} registrado`, false);
    if (cur.status === "em_analise") {
      await tx.query("UPDATE maintenance_requests SET status = 'aguardando_aprovacao' WHERE id = $1", [id]);
      await addUpdate(tx, orgId, id!, authorOf(req), "status", `Status: ${STATUS_LABEL.aguardando_aprovacao}`);
    }
    return { code: 201, id: q!.id };
  });
  if (out.code !== 201) return void res.status(out.code).json({ error: out.error });
  res.status(201).json({ id: out.id });
});

/** Aprovar/recusar orçamento é decisão de administrador. */
async function decideQuote(req: import("express").Request, res: import("express").Response, decision: "aprovado" | "recusado") {
  const orgId = req.auth!.organization.id;
  const id = parseId(req.params.id);
  const quoteId = parseId(req.params.quoteId);
  const out = await transaction(async (tx) => {
    const [cur] = id
      ? await tx.query<{ status: MaintStatus }>("SELECT status FROM maintenance_requests WHERE id = $1 AND organization_id = $2 FOR UPDATE", [id, orgId])
      : [];
    if (!cur) return { code: 404, error: "Não encontrado" };
    if (cur.status !== "aguardando_aprovacao") return { code: 409, error: "O chamado não está aguardando aprovação" };
    const [quote] = quoteId
      ? await tx.query<{ supplier: string; amount_cents: number; status: string }>(
          "SELECT supplier, amount_cents, status FROM maintenance_quotes WHERE id = $1 AND request_id = $2",
          [quoteId, id],
        )
      : [];
    if (!quote) return { code: 404, error: "Orçamento não encontrado" };
    if (quote.status !== "pendente") return { code: 409, error: "Orçamento já decidido" };
    await tx.query("UPDATE maintenance_quotes SET status = $1, decided_by = $2, decided_at = now() WHERE id = $3", [decision, req.auth!.user.id, quoteId]);
    if (decision === "aprovado") {
      await tx.query("UPDATE maintenance_quotes SET status = 'recusado', decided_by = $1, decided_at = now() WHERE request_id = $2 AND status = 'pendente'", [req.auth!.user.id, id]);
      await tx.query("UPDATE maintenance_requests SET status = 'aprovada' WHERE id = $1", [id]);
      await addUpdate(tx, orgId, id!, authorOf(req), "orcamento", `Orçamento de ${quote.supplier} aprovado`, false);
      await addUpdate(tx, orgId, id!, authorOf(req), "status", `Status: ${STATUS_LABEL.aprovada}`);
    } else {
      await addUpdate(tx, orgId, id!, authorOf(req), "orcamento", `Orçamento de ${quote.supplier} recusado`, false);
    }
    return { code: 200 };
  });
  if (out.code !== 200) return void res.status(out.code).json({ error: out.error });
  res.json({ status: decision });
}

maintenanceRouter.post("/maintenance/:id/quotes/:quoteId/approve", requireRole("admin"), (req, res) => decideQuote(req, res, "aprovado"));
maintenanceRouter.post("/maintenance/:id/quotes/:quoteId/reject", requireRole("admin"), (req, res) => decideQuote(req, res, "recusado"));

// ----------------------------------------------------------------------- Fotos

maintenanceRouter.post("/maintenance/:id/photos", rawImage, async (req, res) => {
  const orgId = req.auth!.organization.id;
  const id = parseId(req.params.id);
  const [row] = id ? await db.query<{ status: MaintStatus }>("SELECT status FROM maintenance_requests WHERE id = $1 AND organization_id = $2", [id, orgId]) : [];
  if (!row) return void res.status(404).json({ error: "Não encontrado" });
  if (isTerminal(row.status)) return void res.status(409).json({ error: "Chamado encerrado não aceita novas fotos" });
  const r = await storePhoto(orgId, req.auth!.user.id, { maintenanceRequestId: id! }, req.body);
  if (!r.ok) return void res.status(r.code).json({ error: r.error });
  await db.query("UPDATE maintenance_requests SET updated_at = now() WHERE id = $1", [id]);
  res.status(201).json({ id: r.id });
});
