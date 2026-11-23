/** Variáveis disponíveis nos modelos de contrato e o motor de substituição. */

export const VARIABLES = [
  { key: "locador.nome", label: "Nome do(s) proprietário(s)" },
  { key: "locador.documento", label: "CPF/CNPJ do(s) proprietário(s)" },
  { key: "locatario.nome", label: "Nome do(s) locatário(s)" },
  { key: "locatario.cpf", label: "CPF/CNPJ do(s) locatário(s)" },
  { key: "imovel.endereco", label: "Endereço do imóvel" },
  { key: "unidade.identificacao", label: "Identificação da unidade" },
  { key: "contrato.valor_aluguel", label: "Valor do aluguel" },
  { key: "contrato.data_inicio", label: "Data de início" },
  { key: "contrato.data_fim", label: "Data de término" },
  { key: "contrato.dia_vencimento", label: "Dia de vencimento" },
  { key: "contrato.garantia", label: "Garantia" },
] as const;

const KNOWN = new Set<string>(VARIABLES.map((v) => v.key));
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** Nomes das variáveis usadas no texto, sem repetição, na ordem de aparição. */
export function findVariables(body: string): string[] {
  const found: string[] = [];
  for (const m of body.matchAll(PLACEHOLDER)) {
    if (!found.includes(m[1]!)) found.push(m[1]!);
  }
  return found;
}

/** Variáveis do texto que não existem na lista suportada (ex.: erros de digitação). */
export function unknownVariables(body: string): string[] {
  return findVariables(body).filter((v) => !KNOWN.has(v));
}

export type RenderResult = { text: string } | { missing: string[] };

/**
 * Substitui as variáveis. Se alguma usada no texto estiver sem valor, NÃO gera o
 * documento: devolve a lista do que falta para ser corrigido no cadastro.
 */
export function render(body: string, values: Record<string, string | undefined>): RenderResult {
  const missing = findVariables(body).filter((v) => !values[v]?.trim());
  if (missing.length > 0) return { missing };
  return { text: body.replace(PLACEHOLDER, (_m, name: string) => values[name]!.trim()) };
}

// ------------------------------------------------------------------ Formatação

/** "2026-11-23" → "23/11/2026". */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

/** 150000 → "R$ 1.500,00" (espaço comum, para saída previsível). */
export function formatBRL(cents: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100).replace(/ /g, " ");
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
