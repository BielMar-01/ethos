import type { InputHTMLAttributes } from 'react'
import { maskCep, maskDocument, maskMoney, maskPhone, validCpfCnpj, validPhone } from './masks'

export type MaskKind = 'phone' | 'document' | 'cep' | 'money'

const MASKS: Record<MaskKind, (v: string) => string> = { phone: maskPhone, document: maskDocument, cep: maskCep, money: maskMoney }

const PROPS: Record<MaskKind, InputHTMLAttributes<HTMLInputElement>> = {
  phone: { inputMode: 'tel', autoComplete: 'tel-national', placeholder: '(11) 91234-5678', maxLength: 15 },
  document: { inputMode: 'numeric', placeholder: '000.000.000-00', maxLength: 18 },
  cep: { inputMode: 'numeric', autoComplete: 'postal-code', placeholder: '00000-000', maxLength: 9 },
  money: { inputMode: 'numeric', placeholder: '0,00', maxLength: 14 },
}

/** Aviso (não bloqueia) para CPF/CNPJ e telefone incompletos ou inválidos. Vazio = sem aviso. */
export function maskWarning(kind: MaskKind, value: string): string {
  if (!value) return ''
  if (kind === 'document') return validCpfCnpj(value) ? '' : 'CPF/CNPJ parece inválido. Confira os números.'
  if (kind === 'phone') return validPhone(value) ? '' : 'Telefone incompleto. Use DDD + número.'
  return ''
}

interface Props extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type'> {
  kind: MaskKind
  value: string
  onValue: (masked: string) => void
}

/** Campo com máscara. `value` é sempre o texto já mascarado; `onValue` recebe o novo texto mascarado. */
export default function MaskedInput({ kind, value, onValue, ...rest }: Props) {
  const input = (
    <input
      {...PROPS[kind]}
      {...rest}
      type="text"
      value={value}
      onChange={(e) => onValue(MASKS[kind](e.target.value))}
    />
  )
  return kind === 'money' ? (
    <span className="money-field">
      <span aria-hidden="true">R$</span>
      {input}
    </span>
  ) : (
    input
  )
}
