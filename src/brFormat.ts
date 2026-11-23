/** Formatação de telefone, CPF/CNPJ e CEP no servidor (importação, leitura de documentos). Espelha client/src/masks.ts. */

const digits = (s: string) => s.replace(/\D/g, "");

/** "11912345678" → "(11) 91234-5678"; fixo → "(11) 3234-5678". Fora do padrão (exterior, ramal) devolve como veio. */
export function formatPhone(raw: string): string {
  let d = digits(raw);
  if (d.length > 11 && d.startsWith("55")) d = d.slice(2);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return raw.trim();
}

/** 11 dígitos → 000.000.000-00; 14 → 00.000.000/0000-00; outro tamanho devolve como veio. */
export function formatDocument(raw: string): string {
  const d = digits(raw);
  if (d.length === 11) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
  if (d.length === 14) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  return raw.trim();
}

/** 8 dígitos → 00000-000; senão como veio. */
export function formatCep(raw: string): string {
  const d = digits(raw);
  return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : raw.trim();
}

/** "23/11/2026", "23-11-26", "2026-11-23" → "2026-11-23"; null se não for data reconhecível. */
export function parseDateBr(raw: string): string | null {
  const s = raw.trim();
  let y: number, m: number, d: number;
  let hit = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (hit) [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])] as [number, number, number];
  else if ((hit = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s))) {
    d = Number(hit[1]);
    m = Number(hit[2]);
    y = Number(hit[3]);
    if (hit[3]!.length === 2) y += 2000;
  } else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
