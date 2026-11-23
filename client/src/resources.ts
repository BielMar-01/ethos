export interface FieldDef {
  name: string
  label: string
  type?: 'text' | 'email' | 'number' | 'select' | 'ref'
  required?: boolean
  options?: { value: string; label: string }[]
  /** Para type 'ref': recurso cujos itens preenchem o select. */
  ref?: string
  /** Exibir na tabela. */
  column?: boolean
}

export interface ResourceDef {
  key: string
  path: string
  title: string
  singular: string
  fields: FieldDef[]
}

const personFields: FieldDef[] = [
  { name: 'name', label: 'Nome', required: true, column: true },
  { name: 'document', label: 'CPF/CNPJ', required: true, column: true },
  { name: 'email', label: 'E-mail', type: 'email', column: true },
  { name: 'phone', label: 'Telefone', column: true },
]

export const RESOURCES: ResourceDef[] = [
  {
    key: 'properties',
    path: 'imoveis',
    title: 'Imóveis',
    singular: 'imóvel',
    fields: [
      { name: 'name', label: 'Nome', required: true, column: true },
      {
        name: 'type',
        label: 'Tipo',
        type: 'select',
        required: true,
        column: true,
        options: [
          { value: 'casa', label: 'Casa' },
          { value: 'apartamento', label: 'Apartamento' },
          { value: 'terreno', label: 'Terreno' },
          { value: 'comercial', label: 'Comercial' },
          { value: 'outro', label: 'Outro' },
        ],
      },
      { name: 'street', label: 'Rua' },
      { name: 'number', label: 'Número' },
      { name: 'neighborhood', label: 'Bairro' },
      { name: 'city', label: 'Cidade', column: true },
      { name: 'state', label: 'UF' },
      { name: 'zip', label: 'CEP' },
    ],
  },
  {
    key: 'units',
    path: 'unidades',
    title: 'Unidades',
    singular: 'unidade',
    fields: [
      { name: 'property_id', label: 'Imóvel', type: 'ref', ref: 'properties', required: true, column: true },
      { name: 'identifier', label: 'Identificação', required: true, column: true },
      { name: 'area_m2', label: 'Área (m²)', type: 'number', column: true },
      { name: 'bedrooms', label: 'Quartos', type: 'number' },
      { name: 'rent_reference_cents', label: 'Aluguel de referência (centavos)', type: 'number' },
      {
        name: 'status',
        label: 'Situação',
        type: 'select',
        column: true,
        options: [
          { value: 'disponivel', label: 'Disponível' },
          { value: 'ocupada', label: 'Ocupada' },
          { value: 'manutencao', label: 'Em manutenção' },
        ],
      },
    ],
  },
  { key: 'owners', path: 'proprietarios', title: 'Proprietários', singular: 'proprietário', fields: personFields },
  { key: 'tenants', path: 'inquilinos', title: 'Inquilinos', singular: 'inquilino', fields: personFields },
]
