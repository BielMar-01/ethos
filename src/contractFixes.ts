/**
 * "Completar na própria tela": traduz o que falta para gerar um contrato em campos preenchíveis, cada um ligado ao
 * cadastro onde mora (proprietário, inquilino, fiador, unidade, imóvel, empresa, contrato ou garantia).
 * Só entram campos que estão VAZIOS e que o modelo pede; a gravação recusa qualquer id fora dessa lista, então esta tela
 * nunca sobrescreve um dado existente.
 */
import { db, transaction, type Queryable } from "./db.js";
import { formatCep, formatDocument, formatPhone } from "./brFormat.js";
import { BLOCKS, type BlockName, type PersonValues } from "./contractTemplate.js";
import { MARITAL_STATUS, type ContractData, type LeaseData } from "./contractData.js";

type Input = "text" | "email" | "number" | "money" | "select" | "multi";

export interface Fix {
  /** Identifica o destino (ex.: "tenant:5:rg", "company:cnpj"). */
  id: string;
  section: string;
  label: string;
  input: Input;
  options?: { value: string; label: string }[];
  hint?: string;
  adminOnly?: boolean;
  /** Não impede o documento: se ficar vazio, sai como linha em branco. */
  optional?: boolean;
}

export interface FixPlan {
  fixes: Fix[];
  /** O que não dá para preencher aqui, com a explicação de onde resolver. */
  unresolved: string[];
}

/** Coluna e rótulo de cada dado de pessoa usado nas variáveis. */
const PERSON: Record<string, { column: string; label: string; max: number; input?: Input }> = {
  nome: { column: "name", label: "Nome", max: 200 },
  documento: { column: "document", label: "CPF/CNPJ", max: 20 },
  cpf: { column: "document", label: "CPF/CNPJ", max: 20 },
  rg: { column: "rg", label: "RG e órgão emissor", max: 40 },
  nacionalidade: { column: "nationality", label: "Nacionalidade", max: 60 },
  estado_civil: { column: "marital_status", label: "Estado civil", max: 40, input: "select" },
  profissao: { column: "profession", label: "Profissão", max: 100 },
  endereco: { column: "address", label: "Endereço residencial ou sede", max: 300 },
  email: { column: "email", label: "E-mail", max: 200, input: "email" },
  telefone: { column: "phone", label: "Telefone", max: 30 },
  representante_legal: { column: "representative_name", label: "Representante legal", max: 200 },
};
const ROLE: Record<BlockName, { label: string; table: "owner" | "tenant" | "fiador" }> = {
  locadores: { label: "Locador", table: "owner" },
  locatarios: { label: "Locatário", table: "tenant" },
  fiadores: { label: "Fiador", table: "fiador" },
};
const COMPANY: Record<string, [string, string]> = {
  "administradora.razao_social": ["legal_name", "Razão social"],
  "administradora.cnpj": ["cnpj", "CNPJ"],
  "administradora.creci": ["creci", "CRECI"],
  "administradora.endereco": ["company_address", "Endereço da empresa"],
  "administradora.cidade": ["company_city", "Cidade/UF da empresa"],
  "administradora.telefone": ["company_phone", "Telefone da empresa"],
  "administradora.whatsapp": ["company_whatsapp", "WhatsApp da empresa"],
  "administradora.email": ["company_email", "E-mail da empresa"],
};
const UNIT: Record<string, [string, string, Input]> = {
  "unidade.area": ["area_m2", "Área (m²)", "number"],
  "unidade.quartos": ["bedrooms", "Quartos", "number"],
  "unidade.matricula": ["registration_number", "Matrícula no cartório", "text"],
  "unidade.iptu": ["iptu_number", "Inscrição do IPTU", "text"],
  "energia.instalacao": ["energy_installation", "Nº da instalação de energia", "text"],
  "agua.fornecimento": ["water_supply", "Nº do fornecimento de água", "text"],
};
const LEASE: Record<string, [string, string, number]> = {
  "contrato.indice_reajuste": ["adjust_index", "Índice de reajuste", 60],
  "contrato.garantia": ["guarantee", "Garantia (descrição)", 500],
  "contrato.cidade": ["signing_city", "Cidade da assinatura", 100],
};
const ADDRESS: [string, string, number][] = [
  ["street", "Rua", 200],
  ["number", "Número", 20],
  ["neighborhood", "Bairro", 200],
  ["city", "Cidade", 200],
  ["state", "UF", 2],
  ["zip", "CEP", 10],
];

export async function planFixes(orgId: number, missing: string[], data: ContractData, lease: LeaseData): Promise<FixPlan> {
  const fixes = new Map<string, Fix>();
  const unresolved = new Set<string>();
  const add = (f: Fix) => {
    if (!fixes.has(f.id)) fixes.set(f.id, f);
  };
  const names = [...new Set(missing.map((m) => m.replace(/ \(.*\)$/, "")))];
  const src = data.source;

  const ownersFix = async () => {
    const owners = await db.query<{ id: number; name: string }>("SELECT id, name FROM owners WHERE organization_id = $1 ORDER BY name", [orgId]);
    if (owners.length === 0) unresolved.add("Cadastre o proprietário em Cadastros > Proprietários e volte aqui.");
    else add({ id: "property:owners", section: "Imóvel", label: "Proprietários do imóvel (locadores)", input: "multi", options: owners.map((o) => ({ value: String(o.id), label: o.name })) });
  };
  const emptyGroup = async (block: BlockName) => {
    if (block === "locadores") await ownersFix();
    else if (block === "locatarios") unresolved.add("O contrato não tem locatário. Edite o contrato (em rascunho) e marque ao menos um.");
    else unresolved.add("O modelo usa dados de fiador. Cadastre um fiador em Garantias, neste contrato.");
  };

  for (const name of names) {
    if (name in BLOCKS) {
      await emptyGroup(name as BlockName);
      continue;
    }
    const [prefix, field] = name.split(".") as [string, string];
    const block = (Object.keys(BLOCKS) as BlockName[]).find((b) => BLOCKS[b].prefix === prefix);
    if (block) {
      const people: PersonValues[] = data.groups[block] ?? [];
      if (people.length === 0) {
        await emptyGroup(block);
        continue;
      }
      people.forEach((p, index) => {
        const wanted = field === "qualificacao" ? p.incomplete : p.values[name] ? [] : [field];
        for (const key of wanted) {
          const def = PERSON[key];
          if (!def) continue;
          const role = ROLE[block];
          const rowId = block === "locadores" ? src.owners[index]!.id : block === "locatarios" ? src.tenants[index]!.id : src.fiadores[index]!.id;
          add({
            id: `${role.table}:${rowId}:${def.column}`,
            section: `${role.label}: ${p.name}`,
            label: def.label,
            input: def.input ?? "text",
            ...(def.input === "select" ? { options: Object.entries(MARITAL_STATUS).map(([value, label]) => ({ value, label })) } : {}),
          });
        }
      });
      continue;
    }
    if (COMPANY[name]) {
      const [column, label] = COMPANY[name];
      add({ id: `company:${column}`, section: "Dados da empresa (opcional)", label, input: column === "company_email" ? "email" : "text", adminOnly: true, optional: true });
    } else if (UNIT[name]) {
      const [column, label, input] = UNIT[name];
      add({ id: `unit:${column}`, section: `Unidade ${src.unit.identifier}`, label, input });
    } else if (name === "imovel.endereco") {
      for (const [column, label] of ADDRESS) if (!src.unit[column]) add({ id: `property:${column}`, section: "Endereço do imóvel", label, input: "text" });
    } else if (LEASE[name]) {
      const [column, label] = LEASE[name];
      add({ id: `lease:${column}`, section: "Contrato", label, input: "text" });
    } else if (name.startsWith("garantia.")) {
      const main = src.guarantee;
      if (main?.kind === "fiador" && name !== "garantia.meses") {
        unresolved.add("A garantia ativa é fiança, e este modelo pede o valor de uma caução. Troque a garantia ou use outro modelo.");
        continue;
      }
      if (!main?.amount_cents) {
        add({ id: "guarantee:amount", section: "Garantia", label: main ? "Valor da garantia" : "Valor da caução", input: "money", ...(main ? {} : { hint: "Cadastra uma caução neste contrato." }) });
      }
      if (name === "garantia.meses") add({ id: "guarantee:months", section: "Garantia", label: "Equivale a quantos aluguéis", input: "number" });
    } else if (name === "contrato.multa_atraso" || name === "contrato.juros_mes") {
      unresolved.add("Multa e juros vêm da configuração financeira: Financeiro > Configurações (muda também a cobrança, por isso não é editado aqui).");
    } else if (name.startsWith("contrato.prazo")) {
      unresolved.add("O prazo é calculado pelas datas do contrato. Confira o início e o término.");
    } else {
      unresolved.add(`Complete no cadastro: {{${name}}}.`);
    }
  }
  return { fixes: [...fixes.values()], unresolved: [...unresolved] };
}

export class FixError extends Error {
  constructor(
    message: string,
    public status = 400,
    /** A lista de pendências mudou desde que a tela foi aberta: é só atualizar. */
    public stale = false,
  ) {
    super(message);
  }
}

/** Converte e valida o que foi digitado para um campo. */
function clean(fix: Fix, raw: unknown): string | number | number[] {
  const bad = (why: string) => new FixError(`${fix.section}, ${fix.label}: ${why}`);
  if (fix.input === "multi") {
    const ids = Array.isArray(raw) ? raw.map(Number) : [];
    if (ids.length === 0 || ids.some((n) => !fix.options!.some((o) => o.value === String(n)))) throw bad("escolha uma opção válida");
    return [...new Set(ids)];
  }
  if (fix.input === "money" || fix.input === "number") {
    const n = Number(raw);
    const max = fix.input === "money" ? 2_000_000_000 : fix.id === "guarantee:months" ? 36 : 1_000_000;
    const min = fix.id === "unit:bedrooms" ? 0 : 1;
    if (!Number.isInteger(n) || n < min || n > max) throw bad("número inválido");
    return n;
  }
  if (typeof raw !== "string") throw bad("valor inválido");
  const value = raw.trim();
  const column = fix.id.split(":").at(-1)!;
  const max = Object.values(PERSON).find((p) => p.column === column)?.max ?? ADDRESS.find((a) => a[0] === column)?.[2] ?? Object.values(LEASE).find((l) => l[0] === column)?.[2] ?? 300;
  if (value.length > max) throw bad("texto longo demais");
  if (fix.input === "email" && !/^\S+@\S+\.\S+$/.test(value)) throw bad("e-mail inválido");
  if (fix.input === "select" && !fix.options!.some((o) => o.value === value)) throw bad("opção inválida");
  if (column === "document") return formatDocument(value);
  if (column === "phone") return formatPhone(value);
  if (column === "zip") return formatCep(value);
  return column === "state" ? value.toUpperCase() : value;
}

/** Nomes de tabela e coluna vêm só do código (o id do campo é conferido contra o plano); valores vão como parâmetros. */
const setColumn = (tx: Queryable, table: string, column: string, value: unknown, id: number, orgId: number) =>
  tx.query(`UPDATE ${table} SET ${column} = $1 WHERE id = $2 AND organization_id = $3`, [value, id, orgId]);

export async function applyFixes(orgId: number, userId: number, isAdmin: boolean, plan: FixPlan, data: ContractData, lease: LeaseData, input: Record<string, unknown>): Promise<{ saved: number; skipped: number }> {
  const filled = Object.entries(input).filter(([, v]) => !(v === undefined || v === null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && v.length === 0)));
  if (filled.length === 0) throw new FixError("Preencha ao menos um campo.");
  // O que não está mais pendente (alguém preencheu enquanto a tela estava aberta) é ignorado, nunca sobrescrito.
  const entries = filled.filter(([id]) => plan.fixes.some((f) => f.id === id));
  const skipped = filled.length - entries.length;
  if (entries.length === 0) throw new FixError("Esses dados já foram preenchidos. Atualizamos a lista.", 409, true);
  const values = entries.map(([id, raw]) => {
    const fix = plan.fixes.find((f) => f.id === id)!;
    if (fix.adminOnly && !isAdmin) throw new FixError("Só o administrador altera os dados da empresa.", 403);
    return { fix, value: clean(fix, raw) };
  });
  const src = data.source;
  const guaranteeAmount = values.find((v) => v.fix.id === "guarantee:amount")?.value as number | undefined;
  const guaranteeMonths = values.find((v) => v.fix.id === "guarantee:months")?.value as number | undefined;
  if (guaranteeMonths !== undefined && !src.guarantee && guaranteeAmount === undefined) throw new FixError("Para cadastrar a caução, informe também o valor.");

  await transaction(async (tx) => {
    const fiadorDetails = new Map<number, Record<string, string>>();
    for (const { fix, value } of values) {
      const parts = fix.id.split(":");
      const kind = parts[0]!;
      if (kind === "owner" || kind === "tenant") await setColumn(tx, `${kind}s`, parts[2]!, value, Number(parts[1]), orgId);
      else if (kind === "fiador") {
        const id = Number(parts[1]);
        const details = fiadorDetails.get(id) ?? { ...src.fiadores.find((f) => f.id === id)!.details };
        details[parts[2]!] = String(value);
        fiadorDetails.set(id, details);
      } else if (kind === "company") await tx.query(`UPDATE organizations SET ${parts[1]} = $1 WHERE id = $2`, [value, orgId]);
      else if (kind === "unit") await setColumn(tx, "units", parts[1]!, value, lease.unit_id, orgId);
      else if (fix.id === "property:owners") {
        for (const ownerId of value as number[]) await tx.query("INSERT INTO property_owners (property_id, owner_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [src.unit.property_id, ownerId]);
      } else if (kind === "property") await setColumn(tx, "properties", parts[1]!, value, Number(src.unit.property_id), orgId);
      else if (kind === "lease") await setColumn(tx, "leases", parts[1]!, value, lease.id, orgId);
    }
    for (const [id, details] of fiadorDetails) await setColumn(tx, "lease_guarantees", "details", JSON.stringify(details), id, orgId);

    if (guaranteeAmount !== undefined || guaranteeMonths !== undefined) {
      const main = src.guarantee;
      const details = { ...(main?.details ?? {}), ...(guaranteeMonths !== undefined ? { months: String(guaranteeMonths) } : {}) };
      if (main) {
        await tx.query("UPDATE lease_guarantees SET amount_cents = COALESCE($1, amount_cents), details = $2, updated_at = now() WHERE id = $3 AND organization_id = $4", [guaranteeAmount ?? null, JSON.stringify(details), main.id, orgId]);
      } else {
        await tx.query("INSERT INTO lease_guarantees (organization_id, lease_id, kind, amount_cents, details, created_by) VALUES ($1, $2, 'caucao', $3, $4, $5)", [orgId, lease.id, guaranteeAmount, JSON.stringify(details), userId]);
      }
    }
  });
  return { saved: values.length, skipped };
}
