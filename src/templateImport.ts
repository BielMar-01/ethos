/**
 * Transforma o arquivo de um modelo (Word, PDF ou texto) na marcação do editor. Nada é gravado aqui: a pessoa revisa o
 * resultado e salva. O layout do arquivo original NÃO é mantido; o documento sai com a identidade da Ethos.
 */
import { blockError, findVariables, unknownVariables } from "./contractTemplate.js";
import { isDocx, readDocx } from "./docx.js";

export interface ImportedTemplate {
  format: "docx" | "pdf" | "texto";
  body: string;
  variables: string[];
  unknown: string[];
  warnings: string[];
}

export class ImportError extends Error {}

/** Linha curta toda em maiúsculas (ou "CLÁUSULA …"): em contratos, é título de seção. */
const looksHeading = (line: string) => {
  const letters = line.replace(/[^\p{L}]/gu, "");
  return line.length <= 90 && letters.length >= 4 && letters === letters.toLocaleUpperCase("pt-BR") && !/[.;,:]$/.test(line) && !line.includes("{{") && !line.includes("___");
};

/** Aplica "# " no primeiro título e "## " nos demais, quando o arquivo não trouxe essa informação. */
function markHeadings(blocks: string[]): string[] {
  if (blocks.some((b) => /^#{1,2} /.test(b))) return blocks;
  return blocks.map((b, i) => {
    const bare = b.replace(/^\*\*([\s\S]*)\*\*$/, "$1");
    if (!looksHeading(bare)) return b;
    return i === 0 ? `# ${bare}` : `## ${bare}`;
  });
}

function fromMarkdown(text: string): string {
  return text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/^---\n[\s\S]*?\n---\n/, "") // cabeçalho de metadados
    .replace(/^#{3,6} /gm, "## ")
    .replace(/`/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Junta as linhas quebradas pelo PDF em parágrafos e tira cabeçalhos/rodapés que se repetem nas páginas. */
export function reflowPdf(pages: string[]): string[] {
  const key = (line: string) => line.replace(/\d+/g, "#").trim();
  const seen = new Map<string, number>();
  for (const page of pages) for (const k of new Set(page.split("\n").map(key).filter(Boolean))) seen.set(k, (seen.get(k) ?? 0) + 1);
  const repeated = (line: string) => pages.length >= 3 && (seen.get(key(line)) ?? 0) > pages.length * 0.6;
  const blocks: string[] = [];
  let current = "";
  let afterHeading = false;
  const flush = () => {
    if (current) {
      blocks.push(current);
      afterHeading = false;
    }
    current = "";
  };
  for (const raw of pages.flatMap((p) => p.split("\n"))) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line || repeated(line)) continue;
    const startsClause = /^(\d+(\.\d+)*\s*[—–.)-]|[a-z]\)|CL[ÁA]USULA\b|PAR[ÁA]GRAFO\b)/.test(line);
    if (looksHeading(line)) {
      flush();
      // Título longo quebrado em duas linhas continua sendo um só.
      if (afterHeading && !startsClause) blocks[blocks.length - 1] += ` ${line}`;
      else blocks.push(line);
      afterHeading = true;
      continue;
    }
    if (startsClause) flush();
    current = current ? `${current} ${line}` : line;
    if (/[.:;!?]$/.test(line)) flush();
  }
  flush();
  return blocks;
}

export async function importTemplate(data: Buffer): Promise<ImportedTemplate> {
  const warnings: string[] = [];
  let format: ImportedTemplate["format"];
  let body: string;

  if (data.subarray(0, 5).toString("ascii") === "%PDF-") {
    format = "pdf";
    let pages: string[];
    try {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const out = await extractText(await getDocumentProxy(new Uint8Array(data)), { mergePages: false });
      pages = out.text as string[];
    } catch {
      throw new ImportError("Não foi possível ler este PDF. Se ele tiver senha, envie sem senha, ou envie o arquivo em Word.");
    }
    body = markHeadings(reflowPdf(pages)).join("\n\n");
    if (!body.trim()) throw new ImportError("Este PDF não tem texto (parece digitalizado). Envie o arquivo em Word ou texto.");
    warnings.push("PDF não guarda parágrafos nem negrito: revise as quebras, os títulos e a numeração. Se tiver o arquivo em Word, o resultado é bem melhor.");
  } else if (isDocx(data)) {
    format = "docx";
    const doc = readDocx(data)!;
    const blocks = doc.paragraphs.filter((p) => p.text).map((p) => (p.heading ? `${"#".repeat(p.heading)} ${p.text}` : p.text));
    body = markHeadings(blocks).join("\n\n");
    if (doc.autoNumbering) warnings.push("O arquivo usa numeração automática do Word, que não vem no texto: confira e digite os números das cláusulas.");
    if (doc.tables) warnings.push("O arquivo tem tabelas, que viraram parágrafos soltos: revise esses trechos.");
  } else {
    const text = data.toString("utf8");
    // Binário (ex.: .doc antigo) não vira modelo.
    if (data.includes(0) || text.includes("�")) {
      throw new ImportError("Formato não reconhecido. Envie Word (.docx), PDF ou texto em UTF-8 (.txt ou .md). O .doc antigo não é aceito: salve como .docx.");
    }
    format = "texto";
    body = fromMarkdown(text);
    if (!/^#{1,2} /m.test(body)) body = markHeadings(body.split(/\n\s*\n/)).join("\n\n");
  }

  // "{{...}}" escrito num texto explicativo não é variável.
  body = body.replace(/{{\s*(\.{3}|…)\s*}}/g, "(campos entre chaves)");
  if (!body.trim()) throw new ImportError("O arquivo está vazio.");
  const variables = findVariables(body);
  const unknown = unknownVariables(body);
  if (variables.length === 0) {
    warnings.push("O arquivo não tem {{variáveis}}. Troque os dados fixos (nomes, documentos, endereço, valores e datas) pelas variáveis; senão, todo contrato sairá com os dados deste arquivo.");
  }
  if (unknown.length) warnings.push(`Variáveis que o sistema não reconhece (troque antes de salvar): ${unknown.map((v) => `{{${v}}}`).join(", ")}.`);
  const blocks = blockError(body);
  if (blocks) warnings.push(blocks);
  if (/_{8,}/.test(body)) warnings.push("O sistema cria o quadro de assinaturas sozinho: apague as linhas de assinatura do texto e, se quiser, use [[assinaturas]] no lugar.");
  return { format, body, variables, unknown, warnings };
}
