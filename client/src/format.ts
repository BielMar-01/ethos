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

/** "há 5 min", "há 3 h", "ontem" ou a data, para carimbos de tempo curtos. */
export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'agora'
  if (min < 60) return `há ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `há ${h} h`
  const d = Math.floor(h / 24)
  if (d === 1) return 'ontem'
  if (d < 7) return `há ${d} dias`
  return new Date(iso).toLocaleDateString('pt-BR')
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}
