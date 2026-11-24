export interface User {
  id: number
  name: string
  email: string
  /** Carimbo da foto de perfil (para renovar o cache); ausente = sem foto. */
  avatar_version?: number | null
}

/** Senha certa, mas há verificação em duas etapas: falta o código. */
export interface MfaChallenge {
  mfa_required: true
  mfa_token: string
}
/** Cadastro feito, mas o e-mail precisa ser confirmado pelo link antes do primeiro acesso. */
export interface VerificationNotice {
  verification_required: true
  email: string
}

export type Role = 'admin' | 'colaborador' | 'proprietario' | 'inquilino'

export interface Session {
  user: User
  organization: { id: number; name: string }
  role: Role
}

export type Item = Record<string, string | number | null> & { id: number }

export interface Member {
  id: number
  name: string
  email: string
  role: Role
  tenant_id: number | null
  owner_id: number | null
  linked_name: string | null
}

export interface Invitation {
  id: number
  email: string
  role: Role
  expires_at: string
  created_at: string
  tenant_id: number | null
  owner_id: number | null
}

export interface ApiKey {
  id: number
  name: string
  prefix: string
  created_at: string
  last_used_at: string | null
  revoked_at: string | null
}

export interface PortalMe {
  kind: 'tenant' | 'owner'
  linked: boolean
  name: string | null
}

export interface PortalLease {
  id: number
  status: LeaseStatus
  start_date: string
  end_date: string
  rent_cents: number
  due_day: number
  guarantee: string | null
  unit_identifier: string
  property_name: string
  street: string | null
  number: string | null
  neighborhood: string | null
  city: string | null
  state: string | null
}

export interface PortalCharge {
  id: number
  description: string
  due_date: string
  amount_cents: number
  paid_cents: number
  status: ChargeStatus
}

export interface PortalPayment {
  id: number
  received_at: string
  amount_cents: number
  method: string
  receipt_number: number
  voided_at: string | null
}

export interface PortalProperty {
  id: number
  name: string
  type: string
  city: string | null
  state: string | null
  units_total: number
  units_occupied: number
}

export interface PortalUnit {
  id: number
  identifier: string
  status: string
  property_name: string
  rent_cents: number | null
  tenant_names: string | null
  end_date: string | null
}

export interface OpenApiDoc {
  info: { title: string; version: string; description: string }
  servers: { url: string }[]
  paths: Record<string, Record<string, {
    tags: string[]
    summary: string
    description: string
    security: Record<string, string[]>[]
    parameters: { name: string; in: string; description?: string; example?: string | number }[]
    requestBody?: { content: { 'application/json': { example: unknown } } }
    responses: Record<string, { description: string; content?: { 'application/json': { example: unknown } } }>
  }>>
}

export interface InviteInfo {
  email: string
  role: Role
  organizationName: string
  existingAccount: boolean
}

export interface Template {
  id: number
  name: string
  body: string
  version: number
  updated_at: string
}

export type LeaseStatus = 'rascunho' | 'vigente' | 'encerrado' | 'rescindido'

export interface LeaseSummary {
  id: number
  status: LeaseStatus
  start_date: string
  end_date: string
  rent_cents: number
  due_day: number
  unit_id: number
  unit_identifier: string
  property_name: string
  tenant_names: string | null
}

export interface LeaseDetail {
  lease: {
    id: number
    unit_id: number
    start_date: string
    end_date: string
    rent_cents: number
    due_day: number
    guarantee: string | null
    notes: string | null
    status: LeaseStatus
  }
  tenants: { id: number; name: string; document: string }[]
  unit: { id: number; identifier: string; property_id: number; property_name: string }
}

export interface DocSummary {
  id: number
  template_name: string
  template_version: number
  created_at: string
  generated_by_name: string | null
}

export interface DocFull extends DocSummary {
  lease_id: number
  content: string
}

export type ChargeStatus = 'aberta' | 'parcial' | 'vencida' | 'paga' | 'cancelada'

export interface Charge {
  id: number
  lease_id: number
  kind: string
  description: string
  competence: string
  due_date: string
  amount_cents: number
  paid_cents: number
  status: ChargeStatus
  unit_identifier: string
  property_name: string
  tenant_names: string | null
}

export interface Payment {
  id: number
  lease_id: number
  received_at: string
  amount_cents: number
  method: string
  reference: string | null
  receipt_number: number
  voided_at: string | null
  void_reason: string | null
  unit_identifier: string
  property_name: string
  tenant_names: string | null
}

export interface Transfer {
  id: number
  owner_id: number
  owner_name: string
  period: string
  gross_cents: number
  fee_cents: number
  net_cents: number
  fee_bps: number
  status: 'pendente' | 'pago'
  paid_at: string | null
}

export interface FinanceSummary {
  month: string
  expected_cents: number
  received_cents: number
  received_ratio: number | null
  overdue_cents: number
  overdue_count: number
  cash_received_cents: number
}

export interface LeaseInput {
  unit_id: number
  start_date: string
  end_date: string
  rent_cents: number
  due_day: number
  guarantee: string | null
  notes: string | null
  tenantIds: number[]
}

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrador',
  colaborador: 'Colaborador',
  proprietario: 'Proprietário',
  inquilino: 'Inquilino',
}

import { clearOfflineCache, readOffline, saveForOffline } from './offlineCache'

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/** Texto padrão quando o servidor não explica o erro (ou quando é um erro técnico que o usuário não deve ver). */
const BY_STATUS: Record<number, string> = {
  401: 'Sua sessão expirou. Entre novamente para continuar.',
  403: 'Você não tem permissão para fazer isso.',
  404: 'Não encontramos o que você procurou. Pode ter sido removido.',
  408: 'A conexão demorou demais. Tente novamente.',
  413: 'O arquivo é grande demais.',
  429: 'Muitas tentativas em pouco tempo. Aguarde um momento e tente de novo.',
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  const isRead = !init?.method || init.method === 'GET'
  try {
    res = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
  } catch {
    // Sem internet: a área do cliente mostra a última leitura guardada neste aparelho (e avisa a hora dela).
    const cached = isRead ? readOffline<T>(path) : null
    if (cached) {
      window.dispatchEvent(new CustomEvent('ethos:offline-data', { detail: cached.at }))
      return cached.data
    }
    throw new ApiError('Sem conexão com o servidor. Verifique sua internet e tente novamente.', 0)
  }
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    // Sessão perdida fora das telas de login: avisa o app para voltar ao login.
    if (res.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new Event('ethos:unauthorized'))
    const own = typeof data.error === 'string' && res.status < 500 ? data.error : ''
    throw new ApiError(
      own || BY_STATUS[res.status] || (res.status >= 500 ? 'Algo deu errado do nosso lado. Tente novamente em instantes.' : 'Não foi possível concluir. Tente novamente.'),
      res.status,
    )
  }
  if (isRead) saveForOffline(path, data)
  return data as T
}

export const json = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
})

export const api = {
  me: () => request<Session | { user: null }>('/api/auth/me'),
  login: (email: string, password: string) =>
    request<Session | MfaChallenge>('/api/auth/login', json('POST', { email, password })),
  mfa: (mfaToken: string, code: string) =>
    request<Session>('/api/auth/mfa', json('POST', { mfa_token: mfaToken, code })),
  register: (name: string, email: string, password: string, organizationName: string) =>
    request<Session | VerificationNotice>(
      '/api/auth/register',
      json('POST', { name, email, password, organizationName }),
    ),
  oauth: (accessToken: string) => request<Session | MfaChallenge>('/api/auth/oauth', json('POST', { accessToken })),
  providers: () => request<{ providers: string[]; authorize_url: string | null; redirect_to: string }>('/api/auth/providers'),
  passkeyOptions: (email: string) => request<{ options: unknown; token: string }>('/api/auth/passkey/options', json('POST', { email: email || undefined })),
  passkeyVerify: (token: string, response: unknown) => request<Session | MfaChallenge>('/api/auth/passkey/verify', json('POST', { token, response })),
  resendVerification: (email: string) => request<void>('/api/auth/resend-verification', json('POST', { email })),
  emailConfirmed: (accessToken: string) => request<{ email: string }>('/api/auth/email-confirmed', json('POST', { accessToken })),
  logout: () => {
    clearOfflineCache()
    return request<void>('/api/auth/logout', { method: 'POST' })
  },
  forgot: (email: string) => request<void>('/api/auth/forgot', json('POST', { email })),
  reset: (accessToken: string, password: string) =>
    request<void>('/api/auth/reset', json('POST', { accessToken, password })),
  organizations: () =>
    request<{ organizations: { id: number; name: string; role: Role }[] }>('/api/auth/organizations'),
  switchOrganization: (organizationId: number) =>
    request<void>('/api/auth/switch', json('POST', { organizationId })),

  // Convites (público, via token do link)
  inviteInfo: (token: string) =>
    request<InviteInfo>(`/api/invitations/by-token/${encodeURIComponent(token)}`),
  acceptInvite: (token: string, name: string, password: string) =>
    request<Session>(
      `/api/invitations/by-token/${encodeURIComponent(token)}/accept`,
      json('POST', { name, password }),
    ),

  // Contratos
  variables: () => request<{ variables: { key: string; label: string }[] }>('/api/contract-variables'),
  templates: () => request<{ items: Template[] }>('/api/contract-templates'),
  createTemplate: (name: string, body: string) =>
    request<{ item: Template }>('/api/contract-templates', json('POST', { name, body })),
  updateTemplate: (id: number, name: string, body: string) =>
    request<{ item: Template }>(`/api/contract-templates/${id}`, json('PATCH', { name, body })),
  removeTemplate: (id: number) => request<void>(`/api/contract-templates/${id}`, { method: 'DELETE' }),
  leases: () => request<{ items: LeaseSummary[] }>('/api/leases'),
  lease: (id: number) => request<LeaseDetail>(`/api/leases/${id}`),
  createLease: (input: LeaseInput) => request<{ lease: { id: number } }>('/api/leases', json('POST', input)),
  updateLease: (id: number, input: LeaseInput) =>
    request<{ lease: { id: number } }>(`/api/leases/${id}`, json('PATCH', input)),
  removeLease: (id: number) => request<void>(`/api/leases/${id}`, { method: 'DELETE' }),
  setLeaseStatus: (id: number, status: LeaseStatus) =>
    request<{ status: LeaseStatus }>(`/api/leases/${id}/status`, json('POST', { status })),
  previewDocument: (leaseId: number, templateId: number) =>
    request<{ content: string; template: { name: string; version: number } }>(
      `/api/leases/${leaseId}/preview`,
      json('POST', { templateId }),
    ),
  generateDocument: (leaseId: number, templateId: number) =>
    request<{ document: { id: number } }>(`/api/leases/${leaseId}/documents`, json('POST', { templateId })),
  documents: (leaseId: number) => request<{ items: DocSummary[] }>(`/api/leases/${leaseId}/documents`),
  document: (id: number) => request<{ document: DocFull }>(`/api/documents/${id}`),

  // Financeiro
  financeSummary: (month: string) => request<FinanceSummary>(`/api/finance/summary?month=${month}`),
  charges: (query: string) => request<{ items: Charge[] }>(`/api/charges?${query}`),
  generateCharges: (month: string) =>
    request<{ eligible: number; created: number; skipped: number }>('/api/charges/generate', json('POST', { month })),
  createCharge: (body: Record<string, unknown>) => request<{ item: Charge }>('/api/charges', json('POST', body)),
  cancelCharge: (id: number) => request<void>(`/api/charges/${id}/cancel`, { method: 'POST' }),
  payments: (month: string) => request<{ items: Payment[] }>(`/api/payments?month=${month}`),
  payment: (id: number) =>
    request<{ payment: Payment & { receipt_content: string }; allocations: { charge_id: number; amount_cents: number; description: string }[] }>(
      `/api/payments/${id}`,
    ),
  createPayment: (body: Record<string, unknown>) =>
    request<{ payment: { id: number; receipt_number: number } }>('/api/payments', json('POST', body)),
  voidPayment: (id: number, reason: string) => request<void>(`/api/payments/${id}/void`, json('POST', { reason })),
  transfers: (period: string) => request<{ items: Transfer[] }>(`/api/transfers?period=${period}`),
  generateTransfers: (period: string) =>
    request<{ generated: number; alreadyPaid: number; withoutOwnerCents: number }>('/api/transfers/generate', json('POST', { period })),
  payTransfer: (id: number) => request<void>(`/api/transfers/${id}/pay`, json('POST', {})),
  financeSettings: () => request<{ admin_fee_bps: number }>('/api/settings/finance'),
  saveFinanceSettings: (admin_fee_bps: number) =>
    request<{ admin_fee_bps: number }>('/api/settings/finance', json('PUT', { admin_fee_bps })),

  // Área do cliente
  portalMe: () => request<PortalMe>('/api/portal/me'),
  portalLeases: () => request<{ items: PortalLease[] }>('/api/portal/tenant/leases'),
  portalCharges: () => request<{ items: PortalCharge[] }>('/api/portal/tenant/charges'),
  portalPayments: () => request<{ items: PortalPayment[] }>('/api/portal/tenant/payments'),
  portalReceipt: (id: number) =>
    request<{ payment: { receipt_number: number; receipt_content: string; voided_at: string | null; void_reason: string | null } }>(
      `/api/portal/tenant/payments/${id}`,
    ),
  portalDocuments: () => request<{ items: DocSummary[] }>('/api/portal/tenant/documents'),
  portalDocument: (id: number) => request<{ document: DocFull }>(`/api/portal/tenant/documents/${id}`),
  ownerProperties: () => request<{ items: PortalProperty[] }>('/api/portal/owner/properties'),
  ownerUnits: () => request<{ items: PortalUnit[] }>('/api/portal/owner/units'),
  ownerTransfers: () => request<{ items: Omit<Transfer, 'owner_id' | 'owner_name'>[] }>('/api/portal/owner/transfers'),

  // API pública e chaves
  openapi: () => request<OpenApiDoc>('/api/openapi.json'),
  apiKeys: () => request<{ items: ApiKey[] }>('/api/api-keys'),
  createApiKey: (name: string) => request<{ item: ApiKey; token: string }>('/api/api-keys', json('POST', { name })),
  revokeApiKey: (id: number) => request<void>(`/api/api-keys/${id}`, { method: 'DELETE' }),

  // Equipe (admin)
  members: () => request<{ members: Member[] }>('/api/members'),
  setMemberRole: (id: number, role: Role) => request<unknown>(`/api/members/${id}`, json('PATCH', { role })),
  removeMember: (id: number) => request<void>(`/api/members/${id}`, { method: 'DELETE' }),
  memberPasswordReset: (id: number, mode: 'email' | 'link' | 'password', password?: string) =>
    request<{ sent?: boolean; link?: string; changed?: boolean; password?: string }>(`/api/members/${id}/password-reset`, json('POST', { mode, password })),
  memberMfaReset: (id: number) => request<void>(`/api/members/${id}/mfa-reset`, { method: 'POST' }),
  invitations: () => request<{ invitations: Invitation[] }>('/api/invitations'),
  createInvitation: (email: string, role: Role, link?: { tenantId?: number; ownerId?: number }) =>
    request<{ invitation: Invitation; link: string }>('/api/invitations', json('POST', { email, role, ...link })),
  revokeInvitation: (id: number) => request<void>(`/api/invitations/${id}`, { method: 'DELETE' }),
  list: (resource: string) => request<{ items: Item[] }>(`/api/${resource}`),
  create: (resource: string, body: Record<string, unknown>) =>
    request<{ item: Item }>(`/api/${resource}`, json('POST', body)),
  update: (resource: string, id: number, body: Record<string, unknown>) =>
    request<{ item: Item }>(`/api/${resource}/${id}`, json('PATCH', body)),
  remove: (resource: string, id: number) =>
    request<void>(`/api/${resource}/${id}`, { method: 'DELETE' }),
}
