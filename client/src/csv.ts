/** CSV simples e tolerante: aspas, vírgula OU ponto e vírgula (Excel em português), BOM e quebras de linha do Windows. */

export interface ParsedCsv {
  headers: string[]
  rows: Record<string, string>[]
}

function detectDelimiter(firstLine: string): string {
  const count = (c: string) => firstLine.split(c).length - 1
  const best = [';', ',', '\t'].map((d) => [d, count(d)] as const).sort((a, b) => b[1] - a[1])[0]!
  return best[1] > 0 ? best[0] : ','
}

export function parseCsv(text: string): ParsedCsv {
  const src = text.replace(/^﻿/, '')
  const delimiter = detectDelimiter(src.split(/\r?\n/, 1)[0] ?? '')
  const table: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += ch
    } else if (ch === '"' && cell === '') {
      quoted = true
    } else if (ch === delimiter) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(cell)
      cell = ''
      table.push(row)
      row = []
    } else cell += ch
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    table.push(row)
  }

  const nonEmpty = table.filter((r) => r.some((c) => c.trim() !== ''))
  const headers = (nonEmpty[0] ?? []).map((h) => h.trim())
  const rows = nonEmpty.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()]).filter(([h]) => h)))
  return { headers: headers.filter(Boolean), rows }
}

/** Lê o arquivo como UTF-8 e, se não for válido (CSV antigo do Excel), como Windows-1252. */
export async function readCsvFile(file: File): Promise<ParsedCsv> {
  const buffer = await file.arrayBuffer()
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    text = new TextDecoder('windows-1252').decode(buffer)
  }
  return parseCsv(text)
}

/** Baixa um CSV (com BOM, para o Excel abrir os acentos certos) com separador ";" (padrão do Excel em português). */
export function downloadCsv(filename: string, headers: string[], example: string[]) {
  const esc = (v: string) => (/[;"\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v)
  const body = [headers, example].map((r) => r.map(esc).join(';')).join('\r\n')
  const url = URL.createObjectURL(new Blob(['﻿' + body + '\r\n'], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
