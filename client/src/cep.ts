import { request } from './api'

export interface Address {
  zip: string
  street: string
  neighborhood: string
  city: string
  state: string
  complement: string
}

/** "01001000" → "01001-000" (aceita digitação parcial). */
export function maskCep(value: string): string {
  const d = value.replace(/\D/g, '').slice(0, 8)
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d
}

export const cepDigits = (value: string) => value.replace(/\D/g, '')

/** Consulta o servidor (que consulta ViaCEP/BrasilAPI). Lança Error com mensagem pronta para o usuário. */
export const lookupCep = (cep: string) => request<Address>(`/api/cep/${cepDigits(cep)}`)
