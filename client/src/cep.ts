import { request } from './api'

export interface Address {
  zip: string
  street: string
  neighborhood: string
  city: string
  state: string
  complement: string
}

export { maskCep } from './masks'

export const cepDigits = (value: string) => value.replace(/\D/g, '')

/** Consulta o servidor (que consulta ViaCEP/BrasilAPI). Lança Error com mensagem pronta para o usuário. */
export const lookupCep = (cep: string) => request<Address>(`/api/cep/${cepDigits(cep)}`)
