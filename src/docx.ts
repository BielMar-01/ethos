/** Leitura mínima de .docx (um ZIP com XML), sem dependência: o suficiente para transformar um modelo em texto. */
import zlib from "node:zlib";

const MAX_XML = 6 * 1024 * 1024; // limite do conteúdo descompactado (protege contra "bomba" de compressão)

/** Devolve o conteúdo de um arquivo de dentro do ZIP, ou undefined se não existir ou o ZIP for inválido. */
export function zipEntry(buf: Buffer, name: string): Buffer | undefined {
  try {
    let end = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) {
        end = i;
        break;
      }
    }
    if (end < 0) return undefined;
    const count = buf.readUInt16LE(end + 10);
    let p = buf.readUInt32LE(end + 16);
    for (let n = 0; n < count && buf.readUInt32LE(p) === 0x02014b50; n++) {
      const method = buf.readUInt16LE(p + 10);
      const packed = buf.readUInt32LE(p + 20);
      const nameLen = buf.readUInt16LE(p + 28);
      const skip = buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
      const local = buf.readUInt32LE(p + 42);
      if (buf.subarray(p + 46, p + 46 + nameLen).toString("utf8") === name) {
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const data = buf.subarray(start, start + packed);
        if (method === 0) return data.length <= MAX_XML ? data : undefined;
        return method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: MAX_XML }) : undefined;
      }
      p += 46 + nameLen + skip;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export const isDocx = (buf: Buffer) => buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50 && zipEntry(buf, "word/document.xml") !== undefined;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, e: string) => {
    if (e[0] !== "#") return ENTITIES[e] ?? m;
    const code = e[1] === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });

export interface DocxParagraph {
  text: string;
  /** 1 = título, 2 = seção, 0 = parágrafo comum. */
  heading: 0 | 1 | 2;
}

export function readDocx(buf: Buffer): { paragraphs: DocxParagraph[]; autoNumbering: boolean; tables: boolean } | undefined {
  const xml = zipEntry(buf, "word/document.xml")?.toString("utf8");
  if (!xml) return undefined;
  const paragraphs: DocxParagraph[] = [];
  for (const [, inner] of xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)) {
    const style = /<w:pStyle w:val="([^"]+)"/.exec(inner!)?.[1] ?? "";
    // Trechos com o mesmo negrito são unidos: o Word costuma partir uma palavra (ou uma {{variável}}) em vários pedaços.
    const parts: { bold: boolean; text: string }[] = [];
    for (const [, run] of inner!.matchAll(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g)) {
      const props = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(run!)?.[1] ?? "";
      const bold = /<w:b(?:\s+w:val="(?!0|false)[^"]*")?\s*\/>/.test(props);
      let text = "";
      for (const m of run!.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g)) text += m[1] !== undefined ? decode(m[1]) : m[0].startsWith("<w:br") ? "\n" : " ";
      if (!text) continue;
      const last = parts.at(-1);
      if (last && (last.bold === bold || !text.trim())) last.text += text;
      else parts.push({ bold, text });
    }
    const heading = /^(Title|T[íi]?tulo1?|Heading1|Ttulo1?)$/i.test(style) ? 1 : /^(Heading[2-9]|T[íi]?tulo[2-9]|Ttulo[2-9])$/i.test(style) ? 2 : 0;
    const text = parts
      .map((part) => {
        if (!part.bold || heading || !part.text.trim()) return part.text;
        const [, lead, core, tail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(part.text)!;
        return `${lead}**${core}**${tail}`;
      })
      .join("")
      .replace(/\{\{[^{}]*\}\}/g, (v) => v.replace(/\*\*/g, ""));
    paragraphs.push({ text: text.trim(), heading });
  }
  return { paragraphs, autoNumbering: /<w:numPr>/.test(xml), tables: /<w:tbl>/.test(xml) };
}
