/** Números e valores por extenso em português do Brasil (para cláusulas de contrato). */

const UNITS = ["", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze", "treze", "quatorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove"];
const TENS = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"];
const HUNDREDS = ["", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos"];

/** 1..999 */
function group(n: number): string {
  if (n === 100) return "cem";
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h) parts.push(HUNDREDS[h]!);
  if (rest >= 20) {
    parts.push(TENS[Math.floor(rest / 10)]!);
    if (rest % 10) parts.push(UNITS[rest % 10]!);
  } else if (rest) parts.push(UNITS[rest]!);
  return parts.join(" e ");
}

/** Inteiro de 0 a 999.999.999. */
export function numberToWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 999_999_999) return "";
  if (n === 0) return "zero";
  const millions = Math.floor(n / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1000);
  const units = n % 1000;
  const parts: { text: string; value: number }[] = [];
  if (millions) parts.push({ text: millions === 1 ? "um milhão" : `${group(millions)} milhões`, value: millions });
  if (thousands) parts.push({ text: thousands === 1 ? "mil" : `${group(thousands)} mil`, value: thousands });
  if (units) parts.push({ text: group(units), value: units });
  // "e" antes do último grupo quando ele é menor que 100 ou centena exata (mil e quinhentos); senão, espaço.
  return parts.map((p, i) => (i === 0 ? p.text : `${i === parts.length - 1 && (p.value < 100 || p.value % 100 === 0) ? " e" : ""} ${p.text}`)).join("");
}

/** 150050 → "mil e quinhentos reais e cinquenta centavos". */
export function centsToWords(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0 || cents > 99_999_999_999) return "";
  const reais = Math.floor(cents / 100);
  const centavos = cents % 100;
  const parts: string[] = [];
  if (reais) {
    const de = reais % 1_000_000 === 0 ? " de" : "";
    parts.push(`${numberToWords(reais)}${de} ${reais === 1 ? "real" : "reais"}`);
  }
  if (centavos) parts.push(`${numberToWords(centavos)} ${centavos === 1 ? "centavo" : "centavos"}`);
  return parts.length ? parts.join(" e ") : "zero reais";
}

const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

/** "2026-11-05" → "5 de novembro de 2026". */
export function dateToWords(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number) as [number, number, number];
  return `${d === 1 ? "1º" : d} de ${MONTHS[m - 1]} de ${y}`;
}

/** Prazo em meses entre início e término (o término conta como último dia da locação). */
export function monthsBetween(startIso: string, endIso: string): number {
  const s = new Date(`${startIso.slice(0, 10)}T12:00:00Z`);
  const e = new Date(`${endIso.slice(0, 10)}T12:00:00Z`);
  e.setUTCDate(e.getUTCDate() + 1);
  const whole = (e.getUTCFullYear() - s.getUTCFullYear()) * 12 + (e.getUTCMonth() - s.getUTCMonth());
  return Math.max(0, whole + Math.round((e.getUTCDate() - s.getUTCDate()) / 30));
}
