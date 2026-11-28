export interface FieldDef {
  name: string
  label: string
  type?: 'text' | 'email' | 'number' | 'select' | 'ref' | 'money'
  required?: boolean
  options?: { value: string; label: string }[]
  /** Para type 'ref': recurso cujos itens preenchem o select. */
  ref?: string
  /** Máscara de digitação/exibição (telefone, CPF/CNPJ). */
  mask?: 'phone' | 'document'
  /** Campo de CEP: aplica máscara e preenche rua, bairro, cidade e UF ao completar 8 números. */
  cep?: boolean
  /** Valor inicial ao criar (selects obrigatórios com padrão). */
  default?: string
  /** Exibir na tabela. */
  column?: boolean
  /** Subtítulo exibido antes deste campo no formulário. */
  section?: string
}

export interface ResourceDef {
  key: string
  path: string
  title: string
  singular: string
  /** Substantivo feminino ("Nova unidade", "salva"). */
  fem?: boolean
  fields: FieldDef[]
}

const personFields: FieldDef[] = [
  { name: 'name', label: 'Nome', required: true, column: true },
  { name: 'document', label: 'CPF/CNPJ', required: true, column: true, mask: 'document' },
  { name: 'email', label: 'E-mail', type: 'email', column: true },
  { name: 'phone', label: 'Telefone', column: true, mask: 'phone' },
  { name: 'nationality', label: 'Nacionalidade', section: 'Qualificação para contratos (necessária para emitir documentos)' },
  {
    name: 'marital_status',
    label: 'Estado civil',
    type: 'select',
    options: [
      { value: 'solteiro', label: 'Solteiro(a)' },
      { value: 'casado', label: 'Casado(a)' },
      { value: 'uniao_estavel', label: 'União estável' },
      { value: 'divorciado', label: 'Divorciado(a)' },
      { value: 'separado', label: 'Separado(a)' },
      { value: 'viuvo', label: 'Viúvo(a)' },
    ],
  },
  { name: 'profession', label: 'Profissão' },
  { name: 'rg', label: 'RG e órgão emissor' },
  { name: 'address', label: 'Endereço residencial ou sede' },
  { name: 'spouse_name', label: 'Cônjuge', section: 'Cônjuge (se casado ou em união estável)' },
  { name: 'spouse_document', label: 'Documento do cônjuge' },
  { name: 'representative_name', label: 'Representante legal', section: 'Pessoa jurídica (quando o documento é CNPJ)' },
  { name: 'representative_document', label: 'Documento do representante' },
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
      { name: 'zip', label: 'CEP', cep: true },
      { name: 'street', label: 'Rua' },
      { name: 'number', label: 'Número' },
      { name: 'complement', label: 'Complemento' },
      { name: 'neighborhood', label: 'Bairro' },
      { name: 'city', label: 'Cidade', column: true },
      { name: 'state', label: 'UF' },
    ],
  },
  {
    key: 'units',
    path: 'unidades',
    title: 'Unidades',
    singular: 'unidade',
    fem: true,
    fields: [
      { name: 'property_id', label: 'Imóvel', type: 'ref', ref: 'properties', required: true, column: true },
      { name: 'identifier', label: 'Identificação', required: true, column: true },
      { name: 'area_m2', label: 'Área (m²)', type: 'number', column: true },
      { name: 'bedrooms', label: 'Quartos', type: 'number' },
      { name: 'registration_number', label: 'Matrícula no cartório' },
      { name: 'iptu_number', label: 'Inscrição do IPTU' },
      { name: 'energy_installation', label: 'Nº da instalação de energia' },
      { name: 'water_supply', label: 'Nº do fornecimento de água' },
      { name: 'rent_reference_cents', label: 'Aluguel de referência', type: 'money' },
      {
        name: 'status',
        label: 'Situação',
        type: 'select',
        column: true,
        required: true,
        default: 'disponivel',
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
