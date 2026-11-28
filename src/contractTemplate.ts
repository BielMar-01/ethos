/** Variáveis disponíveis nos modelos de contrato e o motor de substituição. */

export const TEMPLATE_TYPES = {
  locacao_residencial: "Locação residencial",
  locacao_comercial: "Locação comercial",
  temporada: "Locação por temporada",
  garagem: "Vaga de garagem",
  aditivo: "Aditivo contratual",
  distrato: "Distrato",
  entrega_chaves: "Termo de entrega de chaves",
  outro: "Outro documento",
} as const;
export type TemplateType = keyof typeof TEMPLATE_TYPES;

/** Grupos de pessoas que podem ser repetidos com {{#grupo}} … {{/grupo}}. */
export const BLOCKS = {
  locadores: { prefix: "locador", label: "Repetir para cada locador" },
  locatarios: { prefix: "locatario", label: "Repetir para cada locatário" },
  fiadores: { prefix: "fiador", label: "Repetir para cada fiador (some se não houver)" },
} as const;
export type BlockName = keyof typeof BLOCKS;

const PERSON_FIELDS: [string, string][] = [
  ["qualificacao", "Qualificação completa"],
  ["nome", "Nome"],
  ["documento", "CPF/CNPJ"],
  ["cpf", "CPF/CNPJ (mesmo que documento)"],
  ["rg", "RG"],
  ["nacionalidade", "Nacionalidade"],
  ["estado_civil", "Estado civil"],
  ["profissao", "Profissão"],
  ["endereco", "Endereço residencial"],
  ["email", "E-mail"],
  ["telefone", "Telefone"],
];

const person = (prefix: string, group: string) => PERSON_FIELDS.map(([f, label]) => ({ key: `${prefix}.${f}`, label, group }));
const of = (group: string, items: [string, string][]) => items.map(([key, label]) => ({ key, label, group }));

export const VARIABLES: { key: string; label: string; group: string }[] = [
  ...person("locador", "Locador"),
  ...person("locatario", "Locatário"),
  ...person("fiador", "Fiador"),
  ...of("Administradora", [
    ["administradora.razao_social", "Razão social"],
    ["administradora.cnpj", "CNPJ"],
    ["administradora.creci", "CRECI"],
    ["administradora.endereco", "Endereço"],
    ["administradora.cidade", "Cidade/UF"],
    ["administradora.telefone", "Telefone"],
    ["administradora.whatsapp", "WhatsApp"],
    ["administradora.email", "E-mail"],
  ]),
  ...of("Imóvel e unidade", [
    ["imovel.nome", "Nome do imóvel"],
    ["imovel.tipo", "Tipo do imóvel"],
    ["imovel.endereco", "Endereço do imóvel"],
    ["unidade.identificacao", "Identificação da unidade"],
    ["unidade.area", "Área (m²)"],
    ["unidade.quartos", "Quartos"],
    ["unidade.matricula", "Matrícula do imóvel"],
    ["unidade.iptu", "Inscrição do IPTU"],
    ["energia.instalacao", "Nº da instalação de energia"],
    ["agua.fornecimento", "Nº do fornecimento de água"],
  ]),
  ...of("Contrato", [
    ["contrato.valor_aluguel", "Valor do aluguel"],
    ["contrato.valor_aluguel_extenso", "Aluguel por extenso"],
    ["contrato.dia_vencimento", "Dia de vencimento"],
    ["contrato.data_inicio", "Data de início"],
    ["contrato.data_inicio_extenso", "Início por extenso"],
    ["contrato.data_fim", "Data de término"],
    ["contrato.data_fim_extenso", "Término por extenso"],
    ["contrato.prazo_meses", "Prazo em meses"],
    ["contrato.prazo_extenso", "Prazo por extenso"],
    ["contrato.indice_reajuste", "Índice de reajuste"],
    ["contrato.multa_atraso", "Multa por atraso (configuração)"],
    ["contrato.juros_mes", "Juros ao mês (configuração)"],
    ["contrato.garantia", "Garantia (descrição)"],
    ["contrato.cidade", "Cidade da assinatura"],
    ["contrato.data_assinatura", "Data de hoje por extenso"],
  ]),
  ...of("Garantia", [
    ["garantia.tipo", "Tipo da garantia"],
    ["garantia.valor", "Valor da garantia"],
    ["garantia.valor_extenso", "Valor por extenso"],
    ["garantia.meses", "Equivale a quantos aluguéis"],
  ]),
  ...of("Documento", [["documento.numero", "Número do documento"]]),
];

const KNOWN = new Set<string>(VARIABLES.map((v) => v.key));
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;
const BLOCK = /\{\{\s*#\s*([a-z]+)\s*\}\}([\s\S]*?)\{\{\s*\/\s*\1\s*\}\}[ \t]*(\r?\n)?/g;
const BLOCK_MARK = /\{\{\s*[#/][^{}]*\}\}/;

/** Nomes das variáveis usadas no texto (sem as marcas de bloco), sem repetição, na ordem de aparição. */
export function findVariables(body: string): string[] {
  const found: string[] = [];
  for (const m of body.matchAll(PLACEHOLDER)) {
    const name = m[1]!;
    if (name.startsWith("#") || name.startsWith("/")) continue;
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/** Variáveis do texto que não existem na lista suportada (ex.: erros de digitação). */
export function unknownVariables(body: string): string[] {
  return findVariables(body).filter((v) => !KNOWN.has(v));
}

/** Erro de blocos (desconhecido, sem fechamento ou um dentro do outro) ou undefined. */
export function blockError(body: string): string | undefined {
  for (const m of body.matchAll(BLOCK)) {
    if (!(m[1]! in BLOCKS)) return `Bloco desconhecido: {{#${m[1]}}}. Use ${Object.keys(BLOCKS).map((b) => `{{#${b}}}`).join(", ")}.`;
    if (BLOCK_MARK.test(m[2]!)) return `Não coloque um bloco dentro de outro (em {{#${m[1]}}}).`;
  }
  return BLOCK_MARK.test(body.replace(BLOCK, "")) ? "Há um bloco sem abertura ou sem fechamento: use {{#locatarios}} … {{/locatarios}}." : undefined;
}

/** Um valor de cadastro nunca cria formatação nem novas variáveis no documento. */
export function cleanValue(v: string | undefined): string {
  return (v ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\*{2,}/g, "*")
    .replace(/\{\{|\}\}|\[\[|\]\]/g, "")
    .replace(/^[\s#>]+/, "")
    .trim();
}

export type Values = Record<string, string | undefined>;
export interface PersonValues {
  /** Nome usado para dizer de quem falta o dado. */
  name: string;
  values: Values;
  /** Campos exigidos pela qualificação e ainda vazios (ex.: "rg"). */
  incomplete: string[];
}
export type Groups = Partial<Record<BlockName, PersonValues[]>>;

export type RenderResult = { text: string } | { missing: string[] };

/**
 * Substitui os blocos e as variáveis. Se alguma usada no texto estiver sem valor, NÃO gera o documento: devolve a lista do
 * que falta para ser corrigido no cadastro. Um bloco sem ninguém some, exceto locadores e locatários (nunca se emite sem eles).
 */
export function render(body: string, values: Values, groups: Groups = {}): RenderResult {
  const missing: string[] = [];
  const add = (m: string) => {
    if (!missing.includes(m)) missing.push(m);
  };
  const fill = (text: string, lookup: (name: string) => string | undefined, who: (name: string) => string[]) =>
    text.replace(PLACEHOLDER, (_m, name: string) => {
      const v = cleanValue(lookup(name));
      if (!v) for (const label of who(name)) add(label);
      return v;
    });

  /** "locador.qualificacao" de quem está incompleto vira a lista dos campos que faltam. */
  const personGaps = (name: string, p: PersonValues): string[] => {
    const [prefix, field] = name.split(".") as [string, string];
    const gaps = field === "qualificacao" && p.incomplete.length ? p.incomplete.map((f) => `${prefix}.${f}`) : [name];
    return gaps.map((g) => `${g} (${p.name})`);
  };

  let text = body.replace(BLOCK, (_m, block: string, inner: string, eol: string | undefined) => {
    const def = BLOCKS[block as BlockName];
    const people = groups[block as BlockName] ?? [];
    if (people.length === 0) {
      if (block !== "fiadores") add(block);
      return "";
    }
    const template = inner.replace(/^\r?\n/, "").replace(/\r?\n[ \t]*$/, "");
    const out = people.map((p) =>
      fill(
        template,
        (name) => (name.startsWith(`${def.prefix}.`) ? p.values[name] : values[name]),
        (name) => (name.startsWith(`${def.prefix}.`) ? personGaps(name, p) : [name]),
      ),
    );
    return out.join("\n\n") + (eol ? "\n" : "");
  });

  text = fill(text, (name) => values[name], (name) => {
    const [prefix, field] = name.split(".");
    const block = (Object.keys(BLOCKS) as BlockName[]).find((b) => BLOCKS[b].prefix === prefix);
    const incomplete = block && field === "qualificacao" ? (groups[block] ?? []).filter((p) => p.incomplete.length) : [];
    return incomplete.length ? incomplete.flatMap((p) => personGaps(name, p)) : [name];
  });

  return missing.length > 0 ? { missing } : { text };
}

/** Avisa quando um dado individual é usado fora de bloco havendo mais de uma pessoa (o texto sai juntando os valores). */
export function multiPersonWarnings(body: string, groups: Groups): string[] {
  const outside = findVariables(body.replace(BLOCK, ""));
  const warnings: string[] = [];
  for (const [block, def] of Object.entries(BLOCKS) as [BlockName, (typeof BLOCKS)[BlockName]][]) {
    if ((groups[block]?.length ?? 0) < 2) continue;
    const used = outside.filter((v) => v.startsWith(`${def.prefix}.`) && !["nome", "qualificacao"].includes(v.split(".")[1]!));
    if (used.length) warnings.push(`Há mais de uma pessoa em "${block}": ${used.map((v) => `{{${v}}}`).join(", ")} fora de um bloco junta os dados de todos. Envolva o parágrafo em {{#${block}}} … {{/${block}}}.`);
  }
  return warnings;
}

// ------------------------------------------------------------------ Formatação

/** "2026-11-23" → "23/11/2026". */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

/** 150000 → "R$ 1.500,00" (espaço comum, para saída previsível). */
export function formatBRL(cents: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100).replace(/\u00a0/g, " ");
}

/** ["A","B","C"] → "A, B e C". */
export function joinNames(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} e ${items.at(-1)}`;
}

export function formatAddress(p: {
  street: string | null;
  number: string | null;
  complement: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}): string {
  if (!p.street) return "";
  const line1 = [p.street, p.number, p.complement].filter(Boolean).join(", ");
  const cityState = [p.city, p.state].filter(Boolean).join("/");
  return [line1, p.neighborhood, cityState, p.zip ? `CEP ${p.zip}` : ""].filter(Boolean).join(", ");
}
