import { Router } from "express";
import { db, transaction, isUniqueViolation, type Queryable } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";
import { parseId, validate, type Field } from "./crud.js";
import {
  VARIABLES,
  formatAddress,
  formatBRL,
  formatDate,
  joinNames,
  render,
  unknownVariables,
} from "./contractTemplate.js";

export const contractsRouter = Router();
contractsRouter.use(
  ["/contract-variables", "/contract-templates", "/leases", "/documents"],
  requireAuth,
  requireRole("admin", "colaborador"),
);

const BODY_MAX = 100_000;

// -------------------------------------------------------------------- Modelos

contractsRouter.get("/contract-variables", (_req, res) => {
  res.json({ variables: VARIABLES });
});

contractsRouter.get("/contract-templates", async (req, res) => {
  const items = await db.query(
    "SELECT id, name, body, version, created_at, updated_at FROM contract_templates WHERE organization_id = $1 ORDER BY name",
    [req.auth!.organization.id],
  );
  res.json({ items });
});

/** Valida nome e texto de um modelo; devolve mensagem de erro ou undefined. */
function templateError(name: unknown, body: unknown, partial: boolean): string | undefined {
  if (name !== undefined || !partial) {
    if (typeof name !== "string" || !name.trim() || name.trim().length > 200) return "Informe o nome do modelo (até 200 caracteres)";
  }
  if (body !== undefined || !partial) {
    if (typeof body !== "string" || !body.trim() || body.length > BODY_MAX) return "Informe o texto do modelo";
    const unknown = unknownVariables(body);
    if (unknown.length > 0) return `Variáveis desconhecidas no modelo: ${unknown.map((v) => `{{${v}}}`).join(", ")}`;
  }
  return undefined;
}

contractsRouter.post("/contract-templates", async (req, res) => {
  const { name, body } = req.body ?? {};
  const error = templateError(name, body, false);
  if (error) {
    res.status(400).json({ error });
    return;
  }
  try {
    const [item] = await db.query(
      "INSERT INTO contract_templates (organization_id, name, body) VALUES ($1, $2, $3) RETURNING *",
      [req.auth!.organization.id, name.trim(), body],
    );
    res.status(201).json({ item });
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: "Já existe um modelo com este nome" });
      return;
    }
    throw err;
  }
});

contractsRouter.patch("/contract-templates/:id", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const id = parseId(req.params.id);
  const [current] = id
    ? await db.query<{ name: string; body: string }>(
        "SELECT name, body FROM contract_templates WHERE id = $1 AND organization_id = $2",
        [id, orgId],
      )
    : [];
  if (!current) {
    res.status(404).json({ error: "Não encontrado" });
    return;
  }
  const { name, body } = req.body ?? {};
  const error = templateError(name, body, true);
  if (error) {
    res.status(400).json({ error });
    return;
  }
  const newName = name === undefined ? current.name : name.trim();
  const newBody = body === undefined ? current.body : body;
  const bodyChanged = newBody !== current.body;
  try {
    const [item] = await db.query(
      `UPDATE contract_templates
       SET name = $1, body = $2, version = version + $3, updated_at = now()
       WHERE id = $4 AND organization_id = $5 RETURNING *`,
      [newName, newBody, bodyChanged ? 1 : 0, id, orgId],
    );
    res.json({ item });
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: "Já existe um modelo com este nome" });
      return;
    }
    throw err;
  }
});

// Documentos já emitidos guardam o texto próprio; apagar o modelo não os afeta.
contractsRouter.delete("/contract-templates/:id", requireRole("admin"), async (req, res) => {
  const id = parseId(req.params.id);
  const deleted = id
    ? await db.query("DELETE FROM contract_templates WHERE id = $1 AND organization_id = $2 RETURNING id", [
        id,
        req.auth!.organization.id,
      ])
    : [];
  if (deleted.length === 0) {
    res.status(404).json({ error: "Não encontrado" });
    return;
  }
  res.status(204).end();
});

// ------------------------------------------------------------------ Contratos

const STATUSES = ["rascunho", "vigente", "encerrado", "rescindido"] as const;
type LeaseStatus = (typeof STATUSES)[number];

/** Transições permitidas: o status não é editável livremente. */
const TRANSITIONS: Record<LeaseStatus, LeaseStatus[]> = {
  rascunho: ["vigente"],
  vigente: ["encerrado", "rescindido"],
  encerrado: [],
  rescindido: [],
};

const leaseFields: Field[] = [
  { name: "unit_id", kind: "ref", table: "units", required: true },
  { name: "start_date", kind: "date", required: true },
  { name: "end_date", kind: "date", required: true },
  { name: "rent_cents", kind: "int", min: 1, required: true },
  { name: "due_day", kind: "int", min: 1, maxValue: 31, required: true },
  { name: "guarantee", kind: "string", max: 500 },
  { name: "notes", kind: "string", max: 2000 },
];

interface LeaseRow {
  id: number;
  unit_id: number;
  start_date: string;
  end_date: string;
  rent_cents: number;
  due_day: number;
  guarantee: string | null;
  notes: string | null;
  status: LeaseStatus;
}

async function findLease(orgId: number, id: number | undefined, q: Queryable = db): Promise<LeaseRow | undefined> {
  if (!id) return undefined;
  const [row] = await q.query<LeaseRow>("SELECT * FROM leases WHERE id = $1 AND organization_id = $2", [id, orgId]);
  return row;
}

/** Valida tenantIds (lista não vazia, todos da organização). Devolve ids únicos ou mensagem de erro. */
async function checkTenantIds(orgId: number, raw: unknown): Promise<{ ids: number[] } | { error: string }> {
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((n) => parseId(n) !== undefined)) {
    return { error: "Informe ao menos um locatário (tenantIds)" };
  }
  const ids = [...new Set(raw as number[])];
  const found = await db.query("SELECT id FROM tenants WHERE organization_id = $1 AND id = ANY($2::int[])", [orgId, ids]);
  if (found.length !== ids.length) return { error: "Locatário inexistente" };
  return { ids };
}

async function setLeaseTenants(tx: Queryable, leaseId: number, tenantIds: number[]) {
  await tx.query("DELETE FROM lease_tenants WHERE lease_id = $1", [leaseId]);
  for (const [position, tenantId] of tenantIds.entries()) {
    await tx.query("INSERT INTO lease_tenants (lease_id, tenant_id, position) VALUES ($1, $2, $3)", [leaseId, tenantId, position]);
  }
}

contractsRouter.get("/leases", async (req, res) => {
  const items = await db.query(
    `SELECT l.id, l.status, l.start_date, l.end_date, l.rent_cents, l.due_day, l.unit_id,
            u.identifier AS unit_identifier, p.name AS property_name,
            (SELECT string_agg(t.name, ', ' ORDER BY lt.position)
               FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id WHERE lt.lease_id = l.id) AS tenant_names
     FROM leases l
     JOIN units u ON u.id = l.unit_id
     JOIN properties p ON p.id = u.property_id
     WHERE l.organization_id = $1
     ORDER BY l.start_date DESC, l.id DESC`,
    [req.auth!.organization.id],
  );
  res.json({ items });
});

contractsRouter.get("/leases/:id", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const lease = await findLease(orgId, parseId(req.params.id));
  if (!lease) {
    res.status(404).json({ error: "Não encontrado" });
    return;
  }
  const tenants = await db.query(
    `SELECT t.id, t.name, t.document FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id
     WHERE lt.lease_id = $1 ORDER BY lt.position`,
    [lease.id],
  );
  const [unit] = await db.query(
    `SELECT u.id, u.identifier, p.id AS property_id, p.name AS property_name
     FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = $1`,
    [lease.unit_id],
  );
  res.json({ lease, tenants, unit });
});

/** Regras entre campos que a validação individual não cobre. */
function leaseConsistencyError(l: { start_date: string; end_date: string }): string | undefined {
  return l.end_date < l.start_date ? "A data de término não pode ser anterior à de início" : undefined;
}

contractsRouter.post("/leases", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const result = await validate(req.body ?? {}, leaseFields, orgId, false);
  if ("error" in result) {
    res.status(400).json({ error: result.error });
    return;
  }
  const v = result.values as unknown as LeaseRow;
  const consistency = leaseConsistencyError(v);
  if (consistency) {
    res.status(400).json({ error: consistency });
    return;
  }
  const tenants = await checkTenantIds(orgId, req.body?.tenantIds);
  if ("error" in tenants) {
    res.status(400).json({ error: tenants.error });
    return;
  }
  const cols = ["organization_id", ...Object.keys(result.values)];
  const lease = await transaction(async (tx) => {
    const [row] = await tx.query<LeaseRow>(
      `INSERT INTO leases (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
      [orgId, ...Object.values(result.values)],
    );
    await setLeaseTenants(tx, row!.id, tenants.ids);
    return row!;
  });
  res.status(201).json({ lease });
});

contractsRouter.patch("/leases/:id", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const current = await findLease(orgId, parseId(req.params.id));
  if (!current) {
    res.status(404).json({ error: "Não encontrado" });
    return;
  }
  if (current.status !== "rascunho") {
    res.status(409).json({ error: "Só contratos em rascunho podem ser editados" });
    return;
  }
  const result = await validate(req.body ?? {}, leaseFields, orgId, true);
  if ("error" in result) {
    res.status(400).json({ error: result.error });
    return;
  }
  const merged = { ...current, ...result.values } as LeaseRow;
  const consistency = leaseConsistencyError(merged);
  if (consistency) {
    res.status(400).json({ error: consistency });
    return;
  }
  let tenantIds: number[] | undefined;
  if (req.body?.tenantIds !== undefined) {
    const tenants = await checkTenantIds(orgId, req.body.tenantIds);
    if ("error" in tenants) {
      res.status(400).json({ error: tenants.error });
      return;
    }
    tenantIds = tenants.ids;
  }
  const cols = Object.keys(result.values);
  if (cols.length === 0 && !tenantIds) {
    res.status(400).json({ error: "Nenhum campo para atualizar" });
    return;
  }
  const lease = await transaction(async (tx) => {
    let row = current;
    if (cols.length > 0) {
      const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(", ");
      [row] = await tx.query<LeaseRow>(
        `UPDATE leases SET ${sets} WHERE id = $${cols.length + 1} AND organization_id = $${cols.length + 2} RETURNING *`,
        [...Object.values(result.values), current.id, orgId],
      );
    }
    if (tenantIds) await setLeaseTenants(tx, current.id, tenantIds);
    return row;
  });
  res.json({ lease });
});

contractsRouter.delete("/leases/:id", requireRole("admin"), async (req, res) => {
  const lease = await findLease(req.auth!.organization.id, parseId(req.params.id));
  if (!lease) {
    res.status(404).json({ error: "Não encontrado" });
    return;
  }
  if (lease.status !== "rascunho") {
    res.status(409).json({ error: "Só rascunhos podem ser excluídos; encerre ou rescinda o contrato" });
    return;
  }
  await db.query("DELETE FROM leases WHERE id = $1 AND organization_id = $2", [lease.id, req.auth!.organization.id]);
  res.status(204).end();
});

contractsRouter.post("/leases/:id/status", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const target = req.body?.status as LeaseStatus;
  if (!STATUSES.includes(target)) {
    res.status(400).json({ error: "Status inválido" });
    return;
  }
  const outcome = await transaction(async (tx) => {
    const lease = await findLease(orgId, parseId(req.params.id), tx);
    if (!lease) return { code: 404, error: "Não encontrado" };
    if (!TRANSITIONS[lease.status].includes(target)) {
      return { code: 409, error: `Não é possível passar de ${lease.status} para ${target}` };
    }
    // Trava a unidade para que duas ativações simultâneas não passem pela checagem de sobreposição.
    await tx.query("SELECT id FROM units WHERE id = $1 FOR UPDATE", [lease.unit_id]);

    if (target === "vigente") {
      const [count] = await tx.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM lease_tenants WHERE lease_id = $1",
        [lease.id],
      );
      if (Number(count!.n) === 0) return { code: 409, error: "O contrato precisa de ao menos um locatário" };
      const overlap = await tx.query(
        `SELECT 1 FROM leases
         WHERE unit_id = $1 AND status = 'vigente' AND id <> $2 AND start_date <= $4 AND end_date >= $3`,
        [lease.unit_id, lease.id, lease.start_date, lease.end_date],
      );
      if (overlap.length > 0) return { code: 409, error: "Já existe contrato vigente para esta unidade no período" };
    }

    await tx.query("UPDATE leases SET status = $1 WHERE id = $2", [target, lease.id]);
    if (target === "vigente") {
      await tx.query("UPDATE units SET status = 'ocupada' WHERE id = $1", [lease.unit_id]);
    } else {
      const others = await tx.query("SELECT 1 FROM leases WHERE unit_id = $1 AND status = 'vigente' AND id <> $2", [
        lease.unit_id,
        lease.id,
      ]);
      if (others.length === 0) await tx.query("UPDATE units SET status = 'disponivel' WHERE id = $1", [lease.unit_id]);
    }
    return { code: 200, status: target };
  });
  if (outcome.code !== 200) {
    res.status(outcome.code).json({ error: outcome.error });
    return;
  }
  res.json({ status: outcome.status });
});

// ------------------------------------------------------------------ Documentos

type Rendered =
  | { ok: true; content: string; variables: Record<string, string>; template: { id: number; name: string; version: number } }
  | { ok: false; code: number; error: string; missing?: string[] };

/** Monta as variáveis do contrato a partir do cadastro atual e renderiza o modelo. */
async function renderLease(orgId: number, leaseId: number | undefined, templateId: unknown): Promise<Rendered> {
  const lease = await findLease(orgId, leaseId);
  if (!lease) return { ok: false, code: 404, error: "Contrato não encontrado" };
  const tid = parseId(templateId);
  const [template] = tid
    ? await db.query<{ id: number; name: string; body: string; version: number }>(
        "SELECT id, name, body, version FROM contract_templates WHERE id = $1 AND organization_id = $2",
        [tid, orgId],
      )
    : [];
  if (!template) return { ok: false, code: 400, error: "Modelo inexistente (templateId)" };

  const [unit] = await db.query<Record<string, string | null>>(
    `SELECT u.identifier, u.property_id, p.street, p.number, p.complement, p.neighborhood, p.city, p.state, p.zip
     FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = $1`,
    [lease.unit_id],
  );
  const owners = await db.query<{ name: string; document: string }>(
    `SELECT o.name, o.document FROM property_owners po JOIN owners o ON o.id = po.owner_id
     WHERE po.property_id = $1 ORDER BY o.name`,
    [unit!.property_id],
  );
  const tenants = await db.query<{ name: string; document: string }>(
    `SELECT t.name, t.document FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id
     WHERE lt.lease_id = $1 ORDER BY lt.position`,
    [lease.id],
  );

  const values: Record<string, string> = {
    "locador.nome": joinNames(owners.map((o) => o.name)),
    "locador.documento": owners.map((o) => o.document).join(", "),
    "locatario.nome": joinNames(tenants.map((t) => t.name)),
    "locatario.cpf": tenants.map((t) => t.document).join(", "),
    "imovel.endereco": formatAddress(unit as never),
    "unidade.identificacao": unit!.identifier ?? "",
    "contrato.valor_aluguel": formatBRL(lease.rent_cents),
    "contrato.data_inicio": formatDate(lease.start_date),
    "contrato.data_fim": formatDate(lease.end_date),
    "contrato.dia_vencimento": String(lease.due_day),
    "contrato.garantia": lease.guarantee ?? "",
  };
  const out = render(template.body, values);
  if ("missing" in out) {
    return {
      ok: false,
      code: 422,
      error: `Faltam dados para gerar o contrato: ${out.missing.map((v) => `{{${v}}}`).join(", ")}`,
      missing: out.missing,
    };
  }
  return { ok: true, content: out.text, variables: values, template: { id: template.id, name: template.name, version: template.version } };
}

contractsRouter.post("/leases/:id/preview", async (req, res) => {
  const r = await renderLease(req.auth!.organization.id, parseId(req.params.id), req.body?.templateId);
  if (!r.ok) {
    res.status(r.code).json({ error: r.error, missing: r.missing });
    return;
  }
  res.json({ content: r.content, template: r.template });
});

contractsRouter.post("/leases/:id/documents", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const leaseId = parseId(req.params.id);
  const r = await renderLease(orgId, leaseId, req.body?.templateId);
  if (!r.ok) {
    res.status(r.code).json({ error: r.error, missing: r.missing });
    return;
  }
  const [document] = await db.query(
    `INSERT INTO contract_documents
       (organization_id, lease_id, template_id, template_name, template_version, content, variables, generated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, lease_id, template_name, template_version, created_at`,
    [orgId, leaseId, r.template.id, r.template.name, r.template.version, r.content, JSON.stringify(r.variables), req.auth!.user.id],
  );
  res.status(201).json({ document });
});

contractsRouter.get("/leases/:id/documents", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const lease = await findLease(orgId, parseId(req.params.id));
  if (!lease) {
    res.status(404).json({ error: "Não encontrado" });
    return;
  }
  const items = await db.query(
    `SELECT d.id, d.template_name, d.template_version, d.created_at, u.name AS generated_by_name
     FROM contract_documents d LEFT JOIN users u ON u.id = d.generated_by
     WHERE d.lease_id = $1 AND d.organization_id = $2 ORDER BY d.id DESC`,
    [lease.id, orgId],
  );
  res.json({ items });
});

contractsRouter.get("/documents/:id", async (req, res) => {
  const id = parseId(req.params.id);
  const [document] = id
    ? await db.query(
        `SELECT d.id, d.lease_id, d.template_name, d.template_version, d.content, d.variables, d.created_at,
                u.name AS generated_by_name
         FROM contract_documents d LEFT JOIN users u ON u.id = d.generated_by
         WHERE d.id = $1 AND d.organization_id = $2`,
        [id, req.auth!.organization.id],
      )
    : [];
  if (!document) {
    res.status(404).json({ error: "Não encontrado" });
    return;
  }
  res.json({ document });
});
