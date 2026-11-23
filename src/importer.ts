import express, { Router } from "express";
import { transaction } from "./db.js";
import { requireAuth, requireRole } from "./auth.js";
import { validate, type Field } from "./crud.js";
import { recordAudit, requestInfo } from "./audit.js";
import { formatCep, formatDocument, formatPhone, parseDateBr } from "./brFormat.js";
import { DEFAULT_CHECKLIST } from "./inspections.js";

/**
 * Importação em massa de cadastros (proprietários, inquilinos, imóveis e unidades) numa só chamada.
 * - Tudo ou nada: se QUALQUER linha tiver erro, nada é gravado e a resposta lista cada problema com a linha.
 * - `dryRun: true` valida de verdade (dentro de uma transação que é desfeita) e devolve o que seria criado.
 * - Quem já existe é PULADO, não duplicado: pessoas pelo documento, imóveis pelo nome, unidades por imóvel + identificador.
 * - A ordem é fixa (proprietários → inquilinos → imóveis → unidades), então um imóvel/unidade pode citar
 *   proprietários e imóveis que estão no mesmo envio.
 */

export const IMPORT_ORDER = ["owners", "tenants", "properties", "units", "leases", "charges", "inspections"] as const;
export type ImportResource = (typeof IMPORT_ORDER)[number];

const MAX_ROWS = 2000;
const MAX_REPORTED_ERRORS = 200;

const PROPERTY_TYPES = ["casa", "apartamento", "terreno", "comercial", "outro"] as const;
const UNIT_STATUS = ["disponivel", "ocupada", "manutencao"] as const;
const LEASE_STATUS = ["rascunho", "vigente", "encerrado", "rescindido"] as const;
const CHARGE_KINDS = ["aluguel", "multa", "juros", "taxa", "outro"] as const;
const INSPECTION_TYPES = ["entrada", "saida", "periodica"] as const;
const INT4_MAX = 2_147_483_647;

/** "Disponível " → "disponivel"; "Nº do Imóvel" → "n_do_imovel". */
export const canon = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

const digits = (s: string) => s.replace(/\D/g, "");
/** Chave de comparação de documentos: só os dígitos (CPF/CNPJ com ou sem máscara); sem dígitos, o texto. */
const docKey = (s: string) => digits(s) || canon(s);

type Aliases = Record<string, string[]>;
const PERSON_ALIASES: Aliases = {
  name: ["nome", "name", "razao_social", "nome_completo"],
  document: ["documento", "document", "cpf", "cnpj", "cpf_cnpj", "cnpj_cpf"],
  email: ["email", "e_mail"],
  phone: ["telefone", "phone", "celular", "fone", "whatsapp"],
};
const ALIASES: Record<ImportResource, Aliases> = {
  owners: PERSON_ALIASES,
  tenants: PERSON_ALIASES,
  properties: {
    name: ["nome", "name", "imovel", "nome_do_imovel"],
    type: ["tipo", "type"],
    street: ["rua", "street", "logradouro", "endereco"],
    number: ["numero", "number", "n", "num"],
    complement: ["complemento", "complement"],
    neighborhood: ["bairro", "neighborhood"],
    city: ["cidade", "city", "municipio"],
    state: ["estado", "uf", "state"],
    zip: ["cep", "zip"],
    owners: ["proprietarios", "proprietario", "owners", "documentos_proprietarios"],
  },
  units: {
    property: ["imovel", "property", "nome_do_imovel", "propriedade", "edificio"],
    identifier: ["identificador", "identifier", "unidade", "apto", "apartamento", "numero", "n"],
    area_m2: ["area", "area_m2", "m2", "metragem"],
    bedrooms: ["quartos", "bedrooms", "dormitorios"],
    rent: ["aluguel", "aluguel_referencia", "valor_aluguel", "rent", "valor"],
    status: ["situacao", "status"],
  },
  leases: {
    property: ["imovel", "property", "nome_do_imovel", "propriedade", "edificio"],
    unit: ["unidade", "identificador", "unit", "apto", "apartamento"],
    tenants: ["locatarios", "locatario", "inquilinos", "inquilino", "documentos_locatarios", "documentos_inquilinos", "tenants"],
    start: ["inicio", "data_inicio", "data_de_inicio", "start", "start_date"],
    end: ["fim", "termino", "data_fim", "data_termino", "data_de_termino", "end", "end_date"],
    rent: ["aluguel", "valor_aluguel", "valor", "rent"],
    due_day: ["dia_vencimento", "dia_do_vencimento", "dia_de_vencimento", "vencimento", "dia", "due_day"],
    guarantee: ["garantia", "guarantee"],
    notes: ["observacoes", "observacao", "obs", "notes"],
    status: ["situacao", "status"],
  },
  charges: {
    property: ["imovel", "property", "nome_do_imovel", "propriedade", "edificio"],
    unit: ["unidade", "identificador", "unit", "apto", "apartamento"],
    kind: ["tipo", "kind", "categoria"],
    description: ["descricao", "description", "historico"],
    due: ["vencimento", "data_vencimento", "data_de_vencimento", "due", "due_date"],
    amount: ["valor", "amount", "valor_cobrado"],
  },
  inspections: {
    property: ["imovel", "property", "nome_do_imovel", "propriedade", "edificio"],
    unit: ["unidade", "identificador", "unit", "apto", "apartamento"],
    type: ["tipo", "type"],
    date: ["data", "data_prevista", "data_agendada", "agendada_para", "date"],
    notes: ["observacoes", "observacao", "obs", "notes"],
  },
};

const FIELDS: Record<"owners" | "tenants" | "properties" | "units", Field[]> = {
  owners: [
    { name: "name", kind: "string", required: true },
    { name: "document", kind: "string", required: true, max: 20 },
    { name: "email", kind: "string", email: true },
    { name: "phone", kind: "string", max: 30 },
  ],
  tenants: [
    { name: "name", kind: "string", required: true },
    { name: "document", kind: "string", required: true, max: 20 },
    { name: "email", kind: "string", email: true },
    { name: "phone", kind: "string", max: 30 },
  ],
  properties: [
    { name: "name", kind: "string", required: true },
    { name: "type", kind: "enum", values: PROPERTY_TYPES, required: true },
    { name: "street", kind: "string" },
    { name: "number", kind: "string", max: 20 },
    { name: "complement", kind: "string" },
    { name: "neighborhood", kind: "string" },
    { name: "city", kind: "string" },
    { name: "state", kind: "string", max: 2 },
    { name: "zip", kind: "string", max: 10 },
  ],
  units: [
    { name: "identifier", kind: "string", required: true, max: 50 },
    { name: "area_m2", kind: "int" },
    { name: "bedrooms", kind: "int" },
    { name: "rent_reference_cents", kind: "int" },
    { name: "status", kind: "enum", values: UNIT_STATUS },
  ],
};

/** Nome do campo como o usuário vê na planilha (as mensagens de erro usam estes). */
const LABEL: Record<string, string> = {
  name: "nome", document: "documento", email: "e-mail", phone: "telefone", type: "tipo", street: "rua", number: "número",
  complement: "complemento", neighborhood: "bairro", city: "cidade", state: "estado", zip: "cep", identifier: "identificador",
  unit: "unidade", start: "início", end: "fim", rent: "aluguel", due_day: "dia de vencimento", guarantee: "garantia", notes: "observações", kind: "tipo", description: "descrição", due: "vencimento", amount: "valor", date: "data", tenants: "locatários",
  area_m2: "área", bedrooms: "quartos", rent_reference_cents: "aluguel", status: "situação", property: "imóvel", owners: "proprietários",
};

export interface ImportError { resource: ImportResource; line: number; message: string }
export interface ImportSkip { line: number; reason: string }
export interface ImportSummary { received: number; created: number; skipped: ImportSkip[] }
export interface ImportReport {
  dryRun: boolean;
  results: Record<ImportResource, ImportSummary>;
  errors: ImportError[];
  errorCount: number;
}

/** "1.500,00" | "1500,5" | "1500.50" | "R$ 1500" → centavos; null se inválido. */
export function parseMoney(input: string): number | null {
  let s = input.replace(/[^\d,.-]/g, "");
  if (!s || s.startsWith("-")) return null;
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
  else if ((s.match(/\./g) ?? []).length > 1) s = s.replace(/\./g, ""); // 1.500.000 sem decimais
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

function toInt(raw: string): number | null {
  const s = raw.trim().replace(/\s/g, "").replace(/m2|m²/i, "").replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s));
}

/** Converte uma linha (colunas livres) para os campos canônicos do recurso. */
function mapRow(resource: ImportResource, row: Record<string, unknown>): Record<string, string> {
  const byCanon = new Map<string, string>();
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) continue;
    const text = String(v).trim();
    if (text) byCanon.set(canon(k), text);
  }
  const out: Record<string, string> = {};
  for (const [field, aliases] of Object.entries(ALIASES[resource])) {
    for (const a of aliases) {
      const hit = byCanon.get(a);
      if (hit !== undefined) {
        out[field] = hit;
        break;
      }
    }
  }
  return out;
}

const friendly = (message: string) =>
  message.replace(/: ([a-z_0-9]+)/g, (_m, f: string) => `: ${LABEL[f] ?? f}`);

class Rollback extends Error {}

type Sets = Partial<Record<ImportResource, unknown>>;

export async function runImport(orgId: number, sets: Sets, dryRun: boolean, userId: number | null = null): Promise<ImportReport> {
  const report: ImportReport = {
    dryRun,
    results: {
      owners: { received: 0, created: 0, skipped: [] },
      tenants: { received: 0, created: 0, skipped: [] },
      properties: { received: 0, created: 0, skipped: [] },
      units: { received: 0, created: 0, skipped: [] },
      leases: { received: 0, created: 0, skipped: [] },
      charges: { received: 0, created: 0, skipped: [] },
      inspections: { received: 0, created: 0, skipped: [] },
    },
    errors: [],
    errorCount: 0,
  };
  const fail = (resource: ImportResource, line: number, message: string) => {
    report.errorCount++;
    if (report.errors.length < MAX_REPORTED_ERRORS) report.errors.push({ resource, line, message });
  };

  try {
    await transaction(async (tx) => {
      // ---- pessoas: proprietários e inquilinos
      const ownerIdByDoc = new Map<string, number>();
      const tenantIdByDoc = new Map<string, number>();
      for (const resource of ["owners", "tenants"] as const) {
        const rows = (sets[resource] as Record<string, unknown>[] | undefined) ?? [];
        report.results[resource].received = rows.length;
        const existing = await tx.query<{ id: number; document: string }>(`SELECT id, document FROM ${resource} WHERE organization_id = $1`, [orgId]);
        const seen = new Set(existing.map((e) => docKey(e.document)));
        const idByDoc = resource === "owners" ? ownerIdByDoc : tenantIdByDoc;
        for (const e of existing) idByDoc.set(docKey(e.document), e.id);

        const toInsert: { line: number; v: Record<string, string | number | null> }[] = [];
        for (const [i, raw] of rows.entries()) {
          const line = i + 2;
          const checked = await validate(mapRow(resource, raw), FIELDS[resource], orgId, false);
          if ("error" in checked) {
            fail(resource, line, friendly(checked.error));
            continue;
          }
          const key = docKey(String(checked.values.document));
          if (seen.has(key)) {
            report.results[resource].skipped.push({ line, reason: "documento já cadastrado" });
            continue;
          }
          seen.add(key);
          checked.values.document = formatDocument(String(checked.values.document));
          if (checked.values.phone) checked.values.phone = formatPhone(String(checked.values.phone));
          toInsert.push({ line, v: checked.values });
        }
        if (toInsert.length > 0) {
          const inserted = await tx.query<{ id: number; document: string }>(
            `INSERT INTO ${resource} (organization_id, name, document, email, phone)
             SELECT $1::int, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) RETURNING id, document`,
            [orgId, toInsert.map((x) => x.v.name), toInsert.map((x) => x.v.document), toInsert.map((x) => x.v.email ?? null), toInsert.map((x) => x.v.phone ?? null)],
          );
          report.results[resource].created = inserted.length;
          for (const r of inserted) idByDoc.set(docKey(r.document), r.id);
        }
      }

      // ---- imóveis
      const propertyIdByName = new Map<string, number>();
      {
        const rows = (sets.properties as Record<string, unknown>[] | undefined) ?? [];
        report.results.properties.received = rows.length;
        const existing = await tx.query<{ id: number; name: string }>("SELECT id, name FROM properties WHERE organization_id = $1 ORDER BY id", [orgId]);
        for (const e of existing) if (!propertyIdByName.has(canon(e.name))) propertyIdByName.set(canon(e.name), e.id);
        const seen = new Set(propertyIdByName.keys());

        const toInsert: { line: number; v: Record<string, string | number | null>; owners: number[] }[] = [];
        for (const [i, raw] of rows.entries()) {
          const line = i + 2;
          const mapped = mapRow("properties", raw);
          if (mapped.type) mapped.type = canon(mapped.type); // "Apartamento" → "apartamento"
          const checked = await validate(mapped, FIELDS.properties, orgId, false);
          if ("error" in checked) {
            fail("properties", line, friendly(checked.error));
            continue;
          }
          const owners: number[] = [];
          let bad = false;
          for (const doc of (mapped.owners ?? "").split(/[|;]/).map((d) => d.trim()).filter(Boolean)) {
            const id = ownerIdByDoc.get(docKey(doc));
            if (id === undefined) {
              fail("properties", line, `Proprietário não encontrado (documento ${doc}). Cadastre-o ou inclua-o no mesmo envio.`);
              bad = true;
            } else owners.push(id);
          }
          if (bad) continue;
          const key = canon(String(checked.values.name));
          if (seen.has(key)) {
            report.results.properties.skipped.push({ line, reason: "imóvel com este nome já existe" });
            continue;
          }
          seen.add(key);
          if (checked.values.zip) checked.values.zip = formatCep(String(checked.values.zip));
          toInsert.push({ line, v: checked.values, owners: [...new Set(owners)] });
        }
        if (toInsert.length > 0) {
          const col = (k: string) => toInsert.map((x) => (x.v[k] as string | null | undefined) ?? null);
          const inserted = await tx.query<{ id: number; name: string }>(
            `INSERT INTO properties (organization_id, name, type, street, number, complement, neighborhood, city, state, zip)
             SELECT $1::int, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[])
             RETURNING id, name`,
            [orgId, col("name"), col("type"), col("street"), col("number"), col("complement"), col("neighborhood"), col("city"), col("state"), col("zip")],
          );
          report.results.properties.created = inserted.length;
          const idByKey = new Map(inserted.map((r) => [canon(r.name), r.id]));
          const links: { p: number; o: number }[] = [];
          for (const x of toInsert) {
            const pid = idByKey.get(canon(String(x.v.name)));
            if (pid === undefined) continue;
            propertyIdByName.set(canon(String(x.v.name)), pid);
            for (const o of x.owners) links.push({ p: pid, o });
          }
          if (links.length > 0) {
            await tx.query("INSERT INTO property_owners (property_id, owner_id) SELECT * FROM unnest($1::int[], $2::int[]) ON CONFLICT DO NOTHING", [links.map((l) => l.p), links.map((l) => l.o)]);
          }
        }
      }

      // ---- unidades
      {
        const rows = (sets.units as Record<string, unknown>[] | undefined) ?? [];
        report.results.units.received = rows.length;
        const existing = await tx.query<{ property_id: number; identifier: string }>("SELECT property_id, identifier FROM units WHERE organization_id = $1", [orgId]);
        const seen = new Set(existing.map((e) => `${e.property_id}|${canon(e.identifier)}`));

        const toInsert: { property_id: number; v: Record<string, string | number | null> }[] = [];
        for (const [i, raw] of rows.entries()) {
          const line = i + 2;
          const mapped = mapRow("units", raw);
          const propertyId = mapped.property ? propertyIdByName.get(canon(mapped.property)) : undefined;
          if (!mapped.property) {
            fail("units", line, "Campo obrigatório: imóvel");
            continue;
          }
          if (propertyId === undefined) {
            fail("units", line, `Imóvel não encontrado: "${mapped.property}". Cadastre-o ou inclua-o no mesmo envio.`);
            continue;
          }
          const prepared: Record<string, unknown> = { identifier: mapped.identifier };
          let bad = false;
          for (const [src, dst, parse] of [["area_m2", "area_m2", toInt], ["bedrooms", "bedrooms", toInt], ["rent", "rent_reference_cents", parseMoney]] as const) {
            if (mapped[src] === undefined) continue;
            const n = parse(mapped[src]);
            if (n === null) {
              fail("units", line, `Valor inválido: ${LABEL[dst] ?? dst} ("${mapped[src]}")`);
              bad = true;
            } else prepared[dst] = n;
          }
          if (bad) continue;
          if (mapped.status) prepared.status = canon(mapped.status);
          const checked = await validate(prepared, FIELDS.units, orgId, false);
          if ("error" in checked) {
            fail("units", line, friendly(checked.error));
            continue;
          }
          const key = `${propertyId}|${canon(String(checked.values.identifier))}`;
          if (seen.has(key)) {
            report.results.units.skipped.push({ line, reason: "unidade já existe neste imóvel" });
            continue;
          }
          seen.add(key);
          toInsert.push({ property_id: propertyId, v: checked.values });
        }
        if (toInsert.length > 0) {
          const num = (k: string) => toInsert.map((x) => (x.v[k] as number | null | undefined) ?? null);
          await tx.query(
            `INSERT INTO units (organization_id, property_id, identifier, area_m2, bedrooms, rent_reference_cents, status)
             SELECT $1::int, p, i, a, b, r, COALESCE(s, 'disponivel')
             FROM unnest($2::int[], $3::text[], $4::int[], $5::int[], $6::int[], $7::text[]) AS t(p, i, a, b, r, s)`,
            [orgId, toInsert.map((x) => x.property_id), toInsert.map((x) => x.v.identifier), num("area_m2"), num("bedrooms"), num("rent_reference_cents"), toInsert.map((x) => (x.v.status as string | null | undefined) ?? null)],
          );
          report.results.units.created = toInsert.length;
        }
      }

      // ---- contratos, cobranças e vistorias: precisam de unidades e locatários (do cadastro ou deste envio)
      const listOf = (k: ImportResource) => (sets[k] as Record<string, unknown>[] | undefined) ?? [];
      report.results.leases.received = listOf("leases").length;
      report.results.charges.received = listOf("charges").length;
      report.results.inspections.received = listOf("inspections").length;
      if (report.results.leases.received + report.results.charges.received + report.results.inspections.received > 0) {
        const unitIdByKey = new Map<string, number>();
        for (const u of await tx.query<{ id: number; property_id: number; identifier: string }>("SELECT id, property_id, identifier FROM units WHERE organization_id = $1", [orgId])) {
          unitIdByKey.set(`${u.property_id}|${canon(u.identifier)}`, u.id);
        }
        /** Imóvel + unidade da linha → id da unidade, ou registra o erro e devolve undefined. */
        const unitOf = (resource: ImportResource, line: number, m: Record<string, string>): number | undefined => {
          if (!m.property) return void fail(resource, line, "Campo obrigatório: imóvel");
          if (!m.unit) return void fail(resource, line, "Campo obrigatório: unidade");
          const propertyId = propertyIdByName.get(canon(m.property));
          if (propertyId === undefined) return void fail(resource, line, `Imóvel não encontrado: "${m.property}".`);
          const id = unitIdByKey.get(`${propertyId}|${canon(m.unit)}`);
          if (id === undefined) return void fail(resource, line, `Unidade não encontrada: "${m.unit}" no imóvel "${m.property}". Cadastre-a ou inclua-a no mesmo envio.`);
          return id;
        };

        // ---- contratos de locação
        const leaseRows = listOf("leases");
        if (leaseRows.length > 0) {
          const existing = await tx.query<{ unit_id: number; s: string; e: string }>("SELECT unit_id, to_char(start_date, 'YYYY-MM-DD') AS s, to_char(end_date, 'YYYY-MM-DD') AS e FROM leases WHERE organization_id = $1", [orgId]);
          const seen = new Set(existing.map((l) => `${l.unit_id}|${l.s}|${l.e}`));
          for (const [i, raw] of leaseRows.entries()) {
            const line = i + 2;
            const m = mapRow("leases", raw);
            const unitId = unitOf("leases", line, m);
            if (unitId === undefined) continue;
            const start = m.start ? parseDateBr(m.start) : null;
            const end = m.end ? parseDateBr(m.end) : null;
            if (!start) { fail("leases", line, m.start ? `Data inválida: início ("${m.start}"). Use dd/mm/aaaa.` : "Campo obrigatório: início"); continue; }
            if (!end) { fail("leases", line, m.end ? `Data inválida: fim ("${m.end}"). Use dd/mm/aaaa.` : "Campo obrigatório: fim"); continue; }
            if (end < start) { fail("leases", line, "A data de fim é anterior à de início"); continue; }
            const rent = m.rent ? parseMoney(m.rent) : null;
            if (!rent || rent < 1 || rent > INT4_MAX) { fail("leases", line, m.rent ? `Valor inválido: aluguel ("${m.rent}")` : "Campo obrigatório: aluguel"); continue; }
            const dueDay = m.due_day ? toInt(m.due_day) : Number(start.slice(8));
            if (dueDay === null || dueDay < 1 || dueDay > 31) { fail("leases", line, `Valor inválido: dia de vencimento ("${m.due_day}"). Use de 1 a 31.`); continue; }
            const status = m.status ? canon(m.status) : "rascunho";
            if (!LEASE_STATUS.includes(status as (typeof LEASE_STATUS)[number])) { fail("leases", line, `Situação inválida: "${m.status}". Use rascunho, vigente, encerrado ou rescindido.`); continue; }
            if ((m.guarantee ?? "").length > 500) { fail("leases", line, "Garantia muito longa (máx. 500 caracteres)"); continue; }
            if ((m.notes ?? "").length > 2000) { fail("leases", line, "Observações muito longas (máx. 2000 caracteres)"); continue; }
            const tenantIds: number[] = [];
            let bad = false;
            for (const doc of (m.tenants ?? "").split(/[|;]/).map((d) => d.trim()).filter(Boolean)) {
              const id = tenantIdByDoc.get(docKey(doc));
              if (id === undefined) { fail("leases", line, `Locatário não encontrado (documento ${doc}). Cadastre-o ou inclua-o no mesmo envio.`); bad = true; } else if (!tenantIds.includes(id)) tenantIds.push(id);
            }
            if (bad) continue;
            const key = `${unitId}|${start}|${end}`;
            if (seen.has(key)) { report.results.leases.skipped.push({ line, reason: "já existe contrato desta unidade neste período" }); continue; }
            if (status === "vigente") {
              if (tenantIds.length === 0) { fail("leases", line, "Contrato vigente precisa de ao menos um locatário"); continue; }
              const overlap = await tx.query("SELECT 1 FROM leases WHERE unit_id = $1 AND status = 'vigente' AND start_date <= $3 AND end_date >= $2", [unitId, start, end]);
              if (overlap.length > 0) { fail("leases", line, "Já existe contrato vigente para esta unidade no período"); continue; }
            }
            seen.add(key);
            const [lease] = await tx.query<{ id: number }>(
              `INSERT INTO leases (organization_id, unit_id, start_date, end_date, rent_cents, due_day, guarantee, notes, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
              [orgId, unitId, start, end, rent, dueDay, m.guarantee ?? null, m.notes ?? null, status],
            );
            for (const [pos, tid] of tenantIds.entries()) await tx.query("INSERT INTO lease_tenants (lease_id, tenant_id, position) VALUES ($1, $2, $3)", [lease!.id, tid, pos]);
            if (status === "vigente") await tx.query("UPDATE units SET status = 'ocupada' WHERE id = $1", [unitId]);
            report.results.leases.created++;
          }
        }

        // ---- cobranças (cada uma vai para o contrato da unidade que cobre o vencimento)
        for (const [i, raw] of listOf("charges").entries()) {
          const line = i + 2;
          const m = mapRow("charges", raw);
          const unitId = unitOf("charges", line, m);
          if (unitId === undefined) continue;
          const kind = m.kind ? canon(m.kind) : "aluguel";
          if (!CHARGE_KINDS.includes(kind as (typeof CHARGE_KINDS)[number])) { fail("charges", line, `Tipo inválido: "${m.kind}". Use aluguel, multa, juros, taxa ou outro.`); continue; }
          const due = m.due ? parseDateBr(m.due) : null;
          if (!due) { fail("charges", line, m.due ? `Data inválida: vencimento ("${m.due}"). Use dd/mm/aaaa.` : "Campo obrigatório: vencimento"); continue; }
          const amount = m.amount ? parseMoney(m.amount) : null;
          if (!amount || amount < 1 || amount > INT4_MAX) { fail("charges", line, m.amount ? `Valor inválido: valor ("${m.amount}")` : "Campo obrigatório: valor"); continue; }
          const description = (m.description ?? (kind === "aluguel" ? `Aluguel ${due.slice(5, 7)}/${due.slice(0, 4)}` : "")).slice(0, 300);
          if (!description) { fail("charges", line, "Campo obrigatório: descrição (só o aluguel tem descrição automática)"); continue; }
          const [lease] = await tx.query<{ id: number }>(
            `SELECT id FROM leases WHERE unit_id = $1 AND organization_id = $3 AND status <> 'rascunho'
             ORDER BY (start_date <= $2 AND end_date >= $2) DESC, (status = 'vigente') DESC, start_date DESC LIMIT 1`,
            [unitId, due, orgId],
          );
          if (!lease) { fail("charges", line, "Esta unidade não tem contrato (vigente ou encerrado). Importe ou ative o contrato antes."); continue; }
          const inserted = await tx.query(
            kind === "aluguel"
              ? `INSERT INTO charges (organization_id, lease_id, kind, description, competence, due_date, amount_cents, created_by)
                 VALUES ($1, $2, $3, $4, date_trunc('month', $5::date)::date, $5::date, $6, $7)
                 ON CONFLICT (lease_id, competence) WHERE kind = 'aluguel' AND cancelled_at IS NULL DO NOTHING RETURNING id`
              : `INSERT INTO charges (organization_id, lease_id, kind, description, competence, due_date, amount_cents, created_by)
                 SELECT $1::int, $2::int, $3::text, $4::text, date_trunc('month', $5::date)::date, $5::date, $6::int, $7::int
                 WHERE NOT EXISTS (SELECT 1 FROM charges WHERE lease_id = $2 AND kind = $3 AND due_date = $5::date AND amount_cents = $6 AND description = $4 AND cancelled_at IS NULL)
                 RETURNING id`,
            [orgId, lease.id, kind, description, due, amount, userId],
          );
          if (inserted.length === 0) report.results.charges.skipped.push({ line, reason: kind === "aluguel" ? "já existe aluguel deste contrato nesta competência" : "cobrança idêntica já existe" });
          else report.results.charges.created++;
        }

        // ---- vistorias (entram como "agendada", já com o checklist padrão)
        const inspectionRows = listOf("inspections");
        if (inspectionRows.length > 0) {
          const existing = await tx.query<{ unit_id: number; type: string; d: string }>("SELECT unit_id, type, to_char(scheduled_for, 'YYYY-MM-DD') AS d FROM inspections WHERE organization_id = $1 AND status <> 'cancelada'", [orgId]);
          const seen = new Set(existing.map((x) => `${x.unit_id}|${x.type}|${x.d}`));
          const items = Object.entries(DEFAULT_CHECKLIST).flatMap(([room, list]) => list.map((item) => ({ room, item })));
          for (const [i, raw] of inspectionRows.entries()) {
            const line = i + 2;
            const m = mapRow("inspections", raw);
            const unitId = unitOf("inspections", line, m);
            if (unitId === undefined) continue;
            const type = m.type ? canon(m.type) : "";
            if (!INSPECTION_TYPES.includes(type as (typeof INSPECTION_TYPES)[number])) { fail("inspections", line, m.type ? `Tipo inválido: "${m.type}". Use entrada, saida ou periodica.` : "Campo obrigatório: tipo"); continue; }
            const when = m.date ? parseDateBr(m.date) : null;
            if (!when) { fail("inspections", line, m.date ? `Data inválida: data ("${m.date}"). Use dd/mm/aaaa.` : "Campo obrigatório: data"); continue; }
            if ((m.notes ?? "").length > 2000) { fail("inspections", line, "Observações muito longas (máx. 2000 caracteres)"); continue; }
            const key = `${unitId}|${type}|${when}`;
            if (seen.has(key)) { report.results.inspections.skipped.push({ line, reason: "vistoria igual já agendada" }); continue; }
            seen.add(key);
            const [lease] = await tx.query<{ id: number }>("SELECT id FROM leases WHERE unit_id = $1 AND status = 'vigente' LIMIT 1", [unitId]);
            const [insp] = await tx.query<{ id: number }>(
              `INSERT INTO inspections (organization_id, unit_id, lease_id, type, scheduled_for, inspector_id, notes, created_by)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $6) RETURNING id`,
              [orgId, unitId, lease?.id ?? null, type, when, userId, m.notes ?? null],
            );
            await tx.query(
              `INSERT INTO inspection_items (organization_id, inspection_id, room, item, position)
               SELECT $1::int, $2::int, r, it, p - 1 FROM unnest($3::text[], $4::text[]) WITH ORDINALITY AS t(r, it, p)`,
              [orgId, insp!.id, items.map((x) => x.room), items.map((x) => x.item)],
            );
            report.results.inspections.created++;
          }
        }
      }

      // Erro em qualquer linha ou simulação: desfaz tudo.
      if (report.errorCount > 0 || dryRun) throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return report;
}

export const importRouter = Router();

// Corpo maior que o padrão da API (planilhas), mas limitado; o teto de linhas também é checado abaixo.
importRouter.post("/import", express.json({ limit: "3mb" }), requireAuth, requireRole("admin", "colaborador"), async (req, res) => {
  const body = (req.body ?? {}) as { sets?: unknown; dryRun?: unknown };
  const sets = body.sets;
  if (!sets || typeof sets !== "object" || Array.isArray(sets)) {
    res.status(400).json({ error: "Envie { sets: { owners, tenants, properties, units, leases, charges, inspections } }" });
    return;
  }
  let total = 0;
  for (const [key, rows] of Object.entries(sets as Record<string, unknown>)) {
    if (!(IMPORT_ORDER as readonly string[]).includes(key)) {
      res.status(400).json({ error: `Tipo desconhecido: ${key}` });
      return;
    }
    if (!Array.isArray(rows) || !rows.every((r) => r && typeof r === "object" && !Array.isArray(r))) {
      res.status(400).json({ error: `${key} deve ser uma lista de linhas` });
      return;
    }
    total += rows.length;
  }
  if (total === 0) {
    res.status(400).json({ error: "Nenhuma linha para importar" });
    return;
  }
  if (total > MAX_ROWS) {
    res.status(413).json({ error: `Máximo de ${MAX_ROWS} linhas por importação (enviadas: ${total}). Divida o arquivo.` });
    return;
  }
  const dryRun = body.dryRun === true;
  const report = await runImport(req.auth!.organization.id, sets as Sets, dryRun, req.auth!.user.id);

  if (!dryRun && report.errorCount === 0) {
    const parts = IMPORT_ORDER.filter((r) => report.results[r].created > 0).map((r) => `${report.results[r].created} ${{ owners: "proprietário(s)", tenants: "inquilino(s)", properties: "imóvel(is)", units: "unidade(s)", leases: "contrato(s)", charges: "cobrança(s)", inspections: "vistoria(s)" }[r]}`);
    await recordAudit({
      organizationId: req.auth!.organization.id,
      userId: req.auth!.user.id,
      userName: req.auth!.user.name,
      userEmail: req.auth!.user.email,
      role: req.auth!.role,
      kind: "create",
      entity: "import",
      summary: `Importou em massa: ${parts.join(", ") || "nada novo (tudo já existia)"}`,
      status: 200,
      metadata: Object.fromEntries(IMPORT_ORDER.map((r) => [r, report.results[r].created])),
      ...requestInfo(req),
    });
  }
  res.status(report.errorCount > 0 ? 422 : 200).json(report);
});
