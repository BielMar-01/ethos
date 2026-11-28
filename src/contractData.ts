/** Junta os dados do contrato (partes, imóvel, valores, garantia e administradora) para preencher um modelo. */
import { db, type Queryable } from "./db.js";
import { formatDocument } from "./brFormat.js";
import { formatAddress, formatBRL, formatDate, joinNames, type Groups, type PersonValues, type Values } from "./contractTemplate.js";
import { centsToWords, dateToWords, monthsBetween, numberToWords } from "./extenso.js";

export const MARITAL_STATUS: Record<string, string> = {
  solteiro: "solteiro(a)",
  casado: "casado(a)",
  uniao_estavel: "em união estável",
  divorciado: "divorciado(a)",
  separado: "separado(a) judicialmente",
  viuvo: "viúvo(a)",
};
const GUARANTEE_LABEL: Record<string, string> = {
  fiador: "fiança",
  caucao: "caução em dinheiro",
  seguro_fianca: "seguro-fiança",
  titulo_capitalizacao: "título de capitalização",
  outro: "outra garantia",
};
const PROPERTY_TYPE: Record<string, string> = { casa: "casa", apartamento: "apartamento", terreno: "terreno", comercial: "imóvel comercial", outro: "imóvel" };

export interface Person {
  name: string;
  document?: string | null;
  rg?: string | null;
  nationality?: string | null;
  marital_status?: string | null;
  profession?: string | null;
  address?: string | null;
  email?: string | null;
  phone?: string | null;
  spouse_name?: string | null;
  spouse_document?: string | null;
  representative_name?: string | null;
  representative_document?: string | null;
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * Valores de uma pessoa e o parágrafo de qualificação. A qualificação EXIGE os dados (nunca omite em silêncio):
 * pessoa física: nacionalidade, estado civil, profissão, RG, CPF e endereço; jurídica (CNPJ): endereço e representante legal.
 */
export function personValues(prefix: string, p: Person, opts: { simple?: boolean } = {}): PersonValues {
  const digits = text(p.document).replace(/\D/g, "");
  const company = digits.length === 14;
  const document = formatDocument(text(p.document));
  const marital = MARITAL_STATUS[text(p.marital_status)] ?? text(p.marital_status);
  const f = {
    nome: text(p.name),
    documento: document,
    cpf: document,
    rg: text(p.rg),
    nacionalidade: text(p.nationality),
    estado_civil: marital,
    profissao: text(p.profession),
    endereco: text(p.address),
    email: text(p.email),
    telefone: text(p.phone),
  };
  const required: (keyof typeof f)[] = opts.simple ? ["nome", "documento"] : company ? ["nome", "documento", "endereco"] : ["nome", "documento", "nacionalidade", "estado_civil", "profissao", "rg", "endereco"];
  const incomplete: string[] = required.filter((k) => !f[k]);
  if (company && !text(p.representative_name)) incomplete.push("representante_legal");

  let qualificacao = "";
  if (incomplete.length === 0) {
    if (company) {
      const rep = `${text(p.representative_name)}${text(p.representative_document) ? `, inscrito(a) no CPF/MF sob o n.º ${formatDocument(text(p.representative_document))}` : ""}`;
      qualificacao = `${f.nome}, pessoa jurídica inscrita no CNPJ/MF sob o n.º ${f.documento}, com sede em ${f.endereco}, neste ato representada por ${rep}`;
    } else {
      const spouse =
        ["casado", "uniao_estavel"].includes(text(p.marital_status)) && text(p.spouse_name)
          ? ` com ${text(p.spouse_name)}${text(p.spouse_document) ? ` (CPF ${formatDocument(text(p.spouse_document))})` : ""}`
          : "";
      qualificacao = [
        f.nome,
        f.nacionalidade,
        f.estado_civil ? `${f.estado_civil}${spouse}` : "",
        f.profissao,
        f.rg ? `portador(a) do RG n.º ${f.rg}` : "",
        `inscrito(a) no CPF/MF sob o n.º ${f.documento}`,
        f.endereco ? `residente e domiciliado(a) em ${f.endereco}` : "",
      ].filter(Boolean).join(", ");
    }
  }
  const values: Values = {};
  for (const [k, v] of Object.entries({ ...f, qualificacao })) values[`${prefix}.${k}`] = v;
  return { name: f.nome || "sem nome", values, incomplete };
}

/** Valores fora de bloco: nomes "A, B e C", qualificações separadas por "; e " e os demais dados separados por vírgula. */
function joined(prefix: string, people: PersonValues[]): Values {
  const out: Values = {};
  if (people.length === 0) return out;
  for (const key of Object.keys(people[0]!.values)) {
    const all = people.map((p) => p.values[key] ?? "");
    const field = key.split(".")[1];
    // Se faltar o dado de alguém, o conjunto fica vazio: o documento não sai com uma pessoa sem o dado.
    if (all.some((v) => !v)) out[key] = "";
    else out[key] = field === "nome" ? joinNames(all) : field === "qualificacao" ? all.join("; e ") : all.join(", ");
  }
  return out;
}

export interface Company {
  name: string;
  legal_name: string | null;
  cnpj: string | null;
  creci: string | null;
  company_address: string | null;
  company_city: string | null;
  company_phone: string | null;
  company_whatsapp: string | null;
  company_email: string | null;
  logo_data: string | null;
}

export async function loadCompany(orgId: number, q: Queryable = db): Promise<Company> {
  const [row] = await q.query<Company>(
    "SELECT name, legal_name, cnpj, creci, company_address, company_city, company_phone, company_whatsapp, company_email, logo_data FROM organizations WHERE id = $1",
    [orgId],
  );
  return row!;
}

export interface LeaseData {
  id: number;
  unit_id: number;
  start_date: string;
  end_date: string;
  rent_cents: number;
  due_day: number;
  guarantee: string | null;
  adjust_index: string | null;
  signing_city: string | null;
  witness1_name: string | null;
  witness1_document: string | null;
  witness2_name: string | null;
  witness2_document: string | null;
}

export interface Signer {
  role: string;
  name: string;
  document: string | null;
}

export interface ContractData {
  values: Values;
  groups: Groups;
  signers: Signer[];
  witnesses: { name: string | null; document: string | null }[];
  company: Company;
}

const percent = (bps: number) => (bps > 0 ? `${(bps / 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%` : "");
export const todayIso = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date());

export async function loadContractData(orgId: number, lease: LeaseData): Promise<ContractData> {
  const [unit] = await db.query<Record<string, string | number | null>>(
    `SELECT u.identifier, u.property_id, u.area_m2, u.bedrooms, u.registration_number, u.iptu_number, u.energy_installation, u.water_supply,
            p.name AS property_name, p.type AS property_type, p.street, p.number, p.complement, p.neighborhood, p.city, p.state, p.zip
     FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = $1 AND u.organization_id = $2`,
    [lease.unit_id, orgId],
  );
  const cols = "name, document, email, phone, rg, nationality, marital_status, profession, address, spouse_name, spouse_document, representative_name, representative_document";
  const owners = await db.query<Person>(
    `SELECT ${cols.split(", ").map((c) => `o.${c}`).join(", ")} FROM property_owners po JOIN owners o ON o.id = po.owner_id
     WHERE po.property_id = $1 AND o.organization_id = $2 ORDER BY o.name`,
    [unit!.property_id, orgId],
  );
  const tenants = await db.query<Person>(
    `SELECT ${cols.split(", ").map((c) => `t.${c}`).join(", ")} FROM lease_tenants lt JOIN tenants t ON t.id = lt.tenant_id
     WHERE lt.lease_id = $1 AND t.organization_id = $2 ORDER BY lt.position`,
    [lease.id, orgId],
  );
  const guarantees = await db.query<{ kind: string; amount_cents: number | null; details: Record<string, string> }>(
    "SELECT kind, amount_cents, details FROM lease_guarantees WHERE lease_id = $1 AND organization_id = $2 AND status = 'ativa' ORDER BY id",
    [lease.id, orgId],
  );
  const [fin] = await db.query<{ late_fee_bps: number; late_interest_bps: number }>("SELECT late_fee_bps, late_interest_bps FROM organizations WHERE id = $1", [orgId]);
  const company = await loadCompany(orgId);

  const locadores = owners.map((o) => personValues("locador", o));
  const locatarios = tenants.map((t) => personValues("locatario", t));
  const fiadores = guarantees
    .filter((g) => g.kind === "fiador")
    .map((g) => personValues("fiador", { ...(g.details as unknown as Person), name: g.details.name!, spouse_document: g.details.spouse_document }));
  const groups: Groups = { locadores, locatarios, fiadores };

  const main = guarantees.find((g) => g.kind !== "fiador") ?? guarantees[0];
  let guaranteeMonths = text(main?.details.months);
  if (!guaranteeMonths && main?.kind === "caucao" && main.amount_cents && main.amount_cents % lease.rent_cents === 0) guaranteeMonths = String(main.amount_cents / lease.rent_cents);

  const months = monthsBetween(lease.start_date, lease.end_date);
  const propertyAddress = formatAddress(unit as never);
  const city = [unit!.city, unit!.state].filter(Boolean).join("/");
  const values: Values = {
    ...joined("locador", locadores),
    ...joined("locatario", locatarios),
    ...joined("fiador", fiadores),
    "administradora.razao_social": company.legal_name ?? "",
    "administradora.cnpj": company.cnpj ?? "",
    "administradora.creci": company.creci ?? "",
    "administradora.endereco": company.company_address ?? "",
    "administradora.cidade": company.company_city ?? "",
    "administradora.telefone": company.company_phone ?? "",
    "administradora.whatsapp": company.company_whatsapp ?? "",
    "administradora.email": company.company_email ?? "",
    "imovel.nome": String(unit!.property_name ?? ""),
    "imovel.tipo": PROPERTY_TYPE[String(unit!.property_type)] ?? "",
    "imovel.endereco": propertyAddress,
    "unidade.identificacao": String(unit!.identifier ?? ""),
    "unidade.area": unit!.area_m2 ? `${unit!.area_m2} m²` : "",
    "unidade.quartos": unit!.bedrooms === null ? "" : String(unit!.bedrooms),
    "unidade.matricula": String(unit!.registration_number ?? ""),
    "unidade.iptu": String(unit!.iptu_number ?? ""),
    "energia.instalacao": String(unit!.energy_installation ?? ""),
    "agua.fornecimento": String(unit!.water_supply ?? ""),
    "contrato.valor_aluguel": formatBRL(lease.rent_cents),
    "contrato.valor_aluguel_extenso": centsToWords(lease.rent_cents),
    "contrato.dia_vencimento": String(lease.due_day),
    "contrato.data_inicio": formatDate(lease.start_date),
    "contrato.data_inicio_extenso": dateToWords(lease.start_date),
    "contrato.data_fim": formatDate(lease.end_date),
    "contrato.data_fim_extenso": dateToWords(lease.end_date),
    "contrato.prazo_meses": months > 0 ? String(months) : "",
    "contrato.prazo_extenso": months > 0 ? `${numberToWords(months)} ${months === 1 ? "mês" : "meses"}` : "",
    "contrato.indice_reajuste": lease.adjust_index ?? "",
    "contrato.multa_atraso": percent(fin!.late_fee_bps),
    "contrato.juros_mes": percent(fin!.late_interest_bps),
    "contrato.garantia": lease.guarantee ?? "",
    "contrato.cidade": lease.signing_city || company.company_city || city,
    "contrato.data_assinatura": dateToWords(todayIso()),
    "garantia.tipo": main ? GUARANTEE_LABEL[main.kind]! : "",
    "garantia.valor": main?.amount_cents ? formatBRL(main.amount_cents) : "",
    "garantia.valor_extenso": main?.amount_cents ? centsToWords(main.amount_cents) : "",
    "garantia.meses": guaranteeMonths,
  };

  const signers: Signer[] = [
    ...locadores.map((p) => ({ role: "LOCADOR(A)", name: p.values["locador.nome"]!, document: p.values["locador.documento"] || null })),
    ...locatarios.map((p) => ({ role: "LOCATÁRIO(A)", name: p.values["locatario.nome"]!, document: p.values["locatario.documento"] || null })),
    ...fiadores.map((f) => ({ role: "FIADOR(A)", name: f.values["fiador.nome"]!, document: f.values["fiador.documento"] || null })),
    ...(company.legal_name ? [{ role: "ADMINISTRADORA (interveniente)", name: company.legal_name, document: company.cnpj }] : []),
  ];
  const witnesses = [
    { name: lease.witness1_name, document: lease.witness1_document },
    { name: lease.witness2_name, document: lease.witness2_document },
  ];
  return { values, groups, signers, witnesses, company };
}

/** Identidade e partes gravadas junto do documento: mudanças posteriores no cadastro não alteram o que foi emitido. */
export function buildLayout(data: ContractData, typeLabel: string) {
  const c = data.company;
  return {
    type_label: typeLabel,
    company: {
      name: c.name,
      legal_name: c.legal_name,
      cnpj: c.cnpj,
      creci: c.creci,
      address: c.company_address,
      city: c.company_city,
      phone: c.company_phone,
      email: c.company_email,
    },
    logo: c.logo_data,
    signers: data.signers,
    witnesses: data.witnesses,
  };
}
