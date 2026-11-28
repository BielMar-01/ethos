import { Router } from "express";
import { db, transaction, isUniqueViolation, type Queryable } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";
import { parseId, validate, type Field } from "./crud.js";
import { BLOCKS, TEMPLATE_TYPES, VARIABLES, blockError, findVariables, multiPersonWarnings, render, unknownVariables, type TemplateType } from "./contractTemplate.js";
import { buildLayout, loadCompany, loadContractData, todayIso, type ContractData, type LeaseData } from "./contractData.js";
import { STARTERS } from "./contractStarters.js";
import { FixError, applyFixes, planFixes, type FixPlan } from "./contractFixes.js";

export const contractsRouter = Router();
contractsRouter.use(
  ["/contract-variables", "/contract-templates", "/contract-starters", "/leases", "/documents", "/settings/company"],
  requireAuth,
  requireRole("admin", "colaborador"),
);

const BODY_MAX = 90_000;
const isType = (t: unknown): t is TemplateType => typeof t === "string" && Object.hasOwn(TEMPLATE_TYPES, t);

// -------------------------------------------------- Dados da administradora (cabeçalho, rodapé, logo e variáveis)

const COMPANY_FIELDS = ["legal_name", "cnpj", "creci", "company_address", "company_city", "company_phone", "company_whatsapp", "company_email"] as const;
const LOGO_RE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+=*)$/;
const LOGO_MAX = 90_000;

/** O logo precisa ser mesmo uma imagem (assinatura do arquivo), pequena e sem SVG. */
function logoError(v: string): string | undefined {
  if (v.length > LOGO_MAX) return "Logo grande demais: use uma imagem menor (até cerca de 60 KB).";
  const m = LOGO_RE.exec(v);
  if (!m) return "Envie o logo em PNG, JPEG ou WebP.";
  const head = Buffer.from(m[2]!.slice(0, 24), "base64");
  const ok = m[1] === "png" ? head.subarray(0, 4).toString("hex") === "89504e47" : m[1] === "jpeg" ? head.subarray(0, 3).toString("hex") === "ffd8ff" : head.subarray(8, 12).toString("ascii") === "WEBP";
  return ok ? undefined : "O arquivo não é uma imagem válida.";
}

contractsRouter.get("/settings/company", async (req, res) => {
  res.json({ company: await loadCompany(req.auth!.organization.id) });
});

contractsRouter.put("/settings/company", requireRole("admin"), async (req, res) => {
  const orgId = req.auth!.organization.id;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const sets: string[] = [];
  const params: unknown[] = [orgId];
  for (const f of [...COMPANY_FIELDS, "logo_data"] as const) {
    const v = body[f];
    if (v === undefined) continue;
    if (v !== null && typeof v !== "string") return void res.status(400).json({ error: `Valor inválido: ${f}` });
    const value = typeof v === "string" ? v.trim() : "";
    if (f === "logo_data") {
      const error = value ? logoError(value) : undefined;
      if (error) return void res.status(400).json({ error });
    } else if (value.length > 300) return void res.status(400).json({ error: `Valor muito longo: ${f}` });
    if (f === "company_email" && value && !/^\S+@\S+\.\S+$/.test(value)) return void res.status(400).json({ error: "E-mail inválido" });
    params.push(value || null);
    sets.push(`${f} = $${params.length}`);
  }
  if (sets.length === 0) return void res.status(400).json({ error: "Nenhum campo para atualizar" });
  await db.query(`UPDATE organizations SET ${sets.join(", ")} WHERE id = $1`, params);
  res.json({ company: await loadCompany(orgId) });
});

// -------------------------------------------------------------------- Modelos

contractsRouter.get("/contract-variables", (_req, res) => {
  res.json({
    variables: VARIABLES,
    blocks: Object.entries(BLOCKS).map(([key, b]) => ({ key, label: b.label })),
    types: Object.entries(TEMPLATE_TYPES).map(([value, label]) => ({ value, label })),
  });
});

/** Modelos de partida (o texto vem do servidor para ser validado pelos testes). */
contractsRouter.get("/contract-starters", (_req, res) => {
  res.json({ items: STARTERS });
});

contractsRouter.get("/contract-templates", async (req, res) => {
  const items = await db.query(
    "SELECT id, name, type, body, version, created_at, updated_at FROM contract_templates WHERE organization_id = $1 ORDER BY name",
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
    const block = blockError(body);
    if (block) return block;
    if (unknown.length > 0) return `Variáveis desconhecidas no modelo: ${unknown.map((v) => `{{${v}}}`).join(", ")}`;
  }
  return undefined;
}

contractsRouter.post("/contract-templates", async (req, res) => {
  const { name, body } = req.body ?? {};
  const type = req.body?.type ?? "locacao_residencial";
  const error = isType(type) ? templateError(name, body, false) : "Tipo de contrato inválido";
  if (error) {
    res.status(400).json({ error });
    return;
  }
  try {
    const [item] = await db.query(
      "INSERT INTO contract_templates (organization_id, name, body, type) VALUES ($1, $2, $3, $4) RETURNING *",
      [req.auth!.organization.id, name.trim(), body, type],
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
  const { name, body, type } = req.body ?? {};
  const error = type !== undefined && !isType(type) ? "Tipo de contrato inválido" : templateError(name, body, true);
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
       SET name = $1, body = $2, version = version + $3, type = COALESCE($6, type), updated_at = now()
       WHERE id = $4 AND organization_id = $5 RETURNING *`,
      [newName, newBody, bodyChanged ? 1 : 0, id, orgId, type ?? null],
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
  { name: "adjust_index", kind: "string", max: 60 },
  { name: "signing_city", kind: "string", max: 100 },
  { name: "witness1_name", kind: "string", max: 200 },
  { name: "witness1_document", kind: "string", max: 40 },
  { name: "witness2_name", kind: "string", max: 200 },
  { name: "witness2_document", kind: "string", max: 40 },
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

interface Rendered {
  content: string;
  variables: Record<string, string | undefined>;
  layout: ReturnType<typeof buildLayout>;
  warnings: string[];
}
type Prepared =
  | { ok: true; template: { id: number; name: string; version: number; type: TemplateType }; renderWith: (number: string) => Rendered }
  | { ok: false; code: number; error: string; missing?: string[]; plan?: FixPlan; data?: ContractData; lease?: LeaseData };

/** Os dados da empresa são opcionais: o que estiver vazio sai como linha em branco, sem impedir o documento. */
const BLANK = "______________";

/** "locatario.rg (Maria)" → "{{locatario.rg}} (Maria)". */
const missingMessage = (missing: string[]) => `Faltam dados para gerar o contrato: ${missing.map((v) => v.replace(/^([^ ]+)/, "{{$1}}")).join(", ")}`;

/**
 * Carrega o cadastro atual e confere se o modelo pode ser preenchido. A função devolvida monta o texto para um número de
 * documento sem consultar o banco, então pode rodar dentro da transação que reserva o número.
 */
async function prepareDocument(orgId: number, leaseId: number | undefined, templateId: unknown): Promise<Prepared> {
  const lease = await findLease(orgId, leaseId);
  if (!lease) return { ok: false, code: 404, error: "Contrato não encontrado" };
  const tid = parseId(templateId);
  const [template] = tid
    ? await db.query<{ id: number; name: string; body: string; version: number; type: TemplateType }>(
        "SELECT id, name, body, version, type FROM contract_templates WHERE id = $1 AND organization_id = $2",
        [tid, orgId],
      )
    : [];
  if (!template) return { ok: false, code: 400, error: "Modelo inexistente (templateId)" };

  const data = await loadContractData(orgId, lease as unknown as LeaseData);
  const blanks = findVariables(template.body).filter((v) => v.startsWith("administradora.") && !data.values[v]?.trim());
  for (const v of blanks) data.values[v] = BLANK;
  // O quadro de assinaturas acompanha o texto: se o modelo cita a administradora, ela tem onde assinar mesmo sem a razão social.
  if (blanks.includes("administradora.razao_social")) {
    data.signers.push({ role: "ADMINISTRADORA (interveniente)", name: BLANK, document: data.company.cnpj });
  }
  const check = render(template.body, { ...data.values, "documento.numero": "MINUTA" }, data.groups);
  if ("missing" in check) {
    // Os opcionais entram na tela de preenchimento junto com os obrigatórios, para quem quiser aproveitar.
    const plan = await planFixes(orgId, [...check.missing, ...blanks], data, lease as unknown as LeaseData);
    return { ok: false, code: 422, error: missingMessage(check.missing), missing: check.missing, plan, data, lease: lease as unknown as LeaseData };
  }

  return {
    ok: true,
    template: { id: template.id, name: template.name, version: template.version, type: template.type },
    renderWith: (number) => {
      const variables = { ...data.values, "documento.numero": number };
      const out = render(template.body, variables, data.groups) as { text: string };
      const warnings = multiPersonWarnings(template.body, data.groups);
      if (blanks.length) {
        const labels = blanks.map((v) => VARIABLES.find((x) => x.key === v)!.label);
        warnings.push(`Dados da empresa em branco (${labels.join(", ")}): saem como linha em branco no documento. Se quiser, preencha em Modelos > Dados da empresa antes de emitir.`);
      }
      return { content: out.text, variables, layout: buildLayout(data, TEMPLATE_TYPES[template.type]), warnings };
    },
  };
}

contractsRouter.post("/leases/:id/preview", async (req, res) => {
  const p = await prepareDocument(req.auth!.organization.id, parseId(req.params.id), req.body?.templateId);
  if (!p.ok) {
    res.status(p.code).json({ error: p.error, missing: p.missing, ...p.plan });
    return;
  }
  const r = p.renderWith("MINUTA");
  res.json({ content: r.content, layout: r.layout, warnings: r.warnings, number: null, format: 2, template: p.template });
});

/**
 * Completa, sem sair do contrato, o que falta para o modelo escolhido. Aceita só os campos que o próprio servidor apontou
 * como pendentes (todos vazios), então nada é sobrescrito. Vale também para contrato vigente: só preenche lacunas.
 */
contractsRouter.post("/leases/:id/document-data", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const values = req.body?.values;
  if (!values || typeof values !== "object" || Array.isArray(values)) return void res.status(400).json({ error: "Informe os campos (values)" });
  const p = await prepareDocument(orgId, parseId(req.params.id), req.body?.templateId);
  if (p.ok) return void res.status(409).json({ error: "Não falta mais nada para este modelo. Pré-visualize de novo.", stale: true });
  if (!p.plan) return void res.status(p.code).json({ error: p.error });
  try {
    res.json(await applyFixes(orgId, req.auth!.user.id, req.auth!.role === "admin", p.plan, p.data!, p.lease!, values as Record<string, unknown>));
  } catch (err) {
    if (err instanceof FixError) return void res.status(err.status).json({ error: err.message, ...(err.stale ? { stale: true } : {}) });
    if (isUniqueViolation(err)) return void res.status(409).json({ error: "Esse CPF/CNPJ já está em outro cadastro." });
    throw err;
  }
});

contractsRouter.post("/leases/:id/documents", async (req, res) => {
  const orgId = req.auth!.organization.id;
  const leaseId = parseId(req.params.id);
  const p = await prepareDocument(orgId, leaseId, req.body?.templateId);
  if (!p.ok) {
    res.status(p.code).json({ error: p.error, missing: p.missing, ...p.plan });
    return;
  }
  const year = Number(todayIso().slice(0, 4));
  // Número e documento nascem na mesma transação: uma falha não deixa buraco e emissões simultâneas não repetem.
  const document = await transaction(async (tx) => {
    const [counter] = await tx.query<{ last_number: number }>(
      `INSERT INTO document_counters (organization_id, year, last_number) VALUES ($1, $2, 1)
       ON CONFLICT (organization_id, year) DO UPDATE SET last_number = document_counters.last_number + 1 RETURNING last_number`,
      [orgId, year],
    );
    const number = `ETH-${year}-${String(counter!.last_number).padStart(4, "0")}`;
    const r = p.renderWith(number);
    const [row] = await tx.query(
      `INSERT INTO contract_documents
         (organization_id, lease_id, template_id, template_name, template_version, content, variables, generated_by, doc_type, number, format, layout)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 2, $11)
       RETURNING id, lease_id, template_name, template_version, doc_type, number, created_at`,
      [orgId, leaseId, p.template.id, p.template.name, p.template.version, r.content, JSON.stringify(r.variables), req.auth!.user.id, p.template.type, number, JSON.stringify(r.layout)],
    );
    return row;
  });
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
    `SELECT d.id, d.template_name, d.template_version, d.doc_type, d.number, d.created_at, u.name AS generated_by_name
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
        `SELECT d.id, d.lease_id, d.template_name, d.template_version, d.content, d.variables, d.created_at, d.doc_type, d.number, d.format, d.layout,
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
