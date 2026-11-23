/** Máscaras de digitação (telefone, CPF/CNPJ, CEP, moeda). Todas aceitam digitação parcial e colagem com lixo. */

export const onlyDigits = (v: string) => v.replace(/\D/g, '')

/** "11912345678" → "(11) 91234-5678"; fixo "1132345678" → "(11) 3234-5678". Aceita +55 na frente. */
export function maskPhone(value: string): string {
  let d = onlyDigits(value)
  // Colou "+55 11 9…" ou "5511…": tira o código do país (só quando sobram 12-13 dígitos).
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2)
  d = d.slice(0, 11)
  if (d.length === 0) return ''
  if (d.length < 3) return `(${d}`
  const ddd = d.slice(0, 2)
  const rest = d.slice(2)
  if (rest.length <= 4) return `(${ddd}) ${rest}`
  // 9 dígitos (celular) separa 5-4; 8 dígitos (fixo) separa 4-4.
  const cut = rest.length > 8 ? 5 : 4
  return `(${ddd}) ${rest.slice(0, cut)}-${rest.slice(cut)}`
}

/** CPF (até 11 dígitos) ou CNPJ (até 14), conforme o tamanho. */
export function maskDocument(value: string): string {
  const d = onlyDigits(value).slice(0, 14)
  if (d.length <= 11) {
    return d
      .replace(/^(\d{3})(\d)/, '$1.$2')
      .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/\.(\d{3})(\d)/, '.$1-$2')
  }
  return d
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1/$2')
    .replace(/(\d{4})(\d)/, '$1-$2')
}

export function maskCep(value: string): string {
  const d = onlyDigits(value).slice(0, 8)
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d
}

/**
 * Moeda digitada "da direita para a esquerda", como em maquininha: digitar 1 → 0,01; 15 → 0,15; 150 → 1,50.
 * Devolve o texto "1.234,56" (sem o R$). Vazio permanece vazio.
 */
export function maskMoney(value: string): string {
  const d = onlyDigits(value).replace(/^0+(?=\d)/, '').slice(0, 11) // até R$ 999.999.999,99
  if (!d) return ''
  const padded = d.padStart(3, '0')
  const int = padded.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `${int},${padded.slice(-2)}`
}

/** Centavos → texto da máscara ("150000" → "1.500,00"). */
export const moneyFromCents = (cents: number | null | undefined) =>
  cents === null || cents === undefined ? '' : maskMoney(String(Math.round(cents)))

/** Texto da máscara → centavos (null se vazio). */
export function centsFromMoney(text: string): number | null {
  const d = onlyDigits(text)
  return d ? Number(d) : null
}

/** Validação leve (dígito verificador) para avisar na tela sem bloquear. */
export function validCpfCnpj(value: string): boolean {
  const d = onlyDigits(value)
  const calc = (base: string, weights: number[]) => {
    const sum = base.split('').reduce((s, ch, i) => s + Number(ch) * weights[i]!, 0)
    const r = (sum * 10) % 11
    return r === 10 ? 0 : r
  }
  if (/^(\d)\1+$/.test(d)) return false
  if (d.length === 11) {
    return calc(d.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(d[9]) && calc(d.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(d[10])
  }
  if (d.length === 14) {
    const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    const w2 = [6, ...w1]
    return calc(d.slice(0, 12), w1) === Number(d[12]) && calc(d.slice(0, 13), w2) === Number(d[13])
  }
  return false
}

export const validPhone = (value: string) => {
  const d = onlyDigits(value)
  return d.length === 10 || (d.length === 11 && d[2] === '9')
}
