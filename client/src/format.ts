/** 150000 → "R$ 1.500,00" */
export function brl(cents: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100)
}

/** "1.500,00", "1500,5" ou "R$ 1500" → centavos; null se inválido ou não positivo. */
export function parseReais(input: string): number | null {
  let s = input.replace(/[^\d,.]/g, '')
  if (!s) return null
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.')
  const n = Number(s)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n * 100)
}

/** 150000 → "1500,00" (para preencher campos de edição). */
export function reaisInput(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',')
}

/** "2026-11-23" ou ISO completo → "23/11/2026" */
export function date(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-')
  return `${d}/${m}/${y}`
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}
