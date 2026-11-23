// Manutenção e vistorias: tipos e chamadas à API.
import { json, request } from './api'

export type MaintStatus = 'aberta' | 'em_analise' | 'aguardando_aprovacao' | 'aprovada' | 'em_execucao' | 'concluida' | 'cancelada'
export type Priority = 'baixa' | 'media' | 'alta' | 'urgente'

export interface MaintItem {
  id: number
  title: string
  category: string
  priority: Priority
  status: MaintStatus
  created_at: string
  updated_at: string
  completed_at: string | null
  cost_cents: number | null
  unit_id: number
  unit_identifier: string
  property_name: string
  assigned_to: number | null
  assigned_name: string | null
  opened_by_name: string | null
  quotes_count: number
}

export interface Quote {
  id: number
  supplier: string
  amount_cents: number
  notes: string | null
  status: 'pendente' | 'aprovado' | 'recusado'
  decided_by_name: string | null
}

export interface TimelineUpdate {
  id: number
  author_name: string
  kind: 'status' | 'comentario' | 'orcamento'
  message: string
  client_visible?: boolean
  created_at: string
}

export type MaintFull = MaintItem & { description: string; cancelled_reason: string | null; lease_id: number | null }

export interface MaintDetail {
  item: MaintFull
  quotes: Quote[]
  updates: TimelineUpdate[]
  photos: { id: number }[]
}

export type Condition = 'novo' | 'bom' | 'regular' | 'ruim' | 'danificado'
export type InspStatus = 'agendada' | 'em_andamento' | 'concluida' | 'cancelada'
export type InspType = 'entrada' | 'saida' | 'periodica'

export interface InspSummary {
  id: number
  type: InspType
  status: InspStatus
  scheduled_for: string
  performed_at: string | null
  unit_id: number
  unit_identifier: string
  property_name: string
  inspector_name: string | null
  items_total: number
  items_done: number
}

export interface InspItem {
  id: number
  room: string
  item: string
  condition: Condition | null
  notes: string | null
  photos: number[]
}

export interface InspSignature {
  role: 'vistoriador' | 'locatario' | 'proprietario'
  signer_name: string
  signed_at: string
}

export interface InspDetail {
  inspection: {
    id: number
    type: InspType
    status: InspStatus
    scheduled_for: string
    performed_at: string | null
    notes: string | null
    unit_id: number
    unit_identifier: string
    property_name: string
    inspector_name?: string | null
  }
  items: InspItem[]
  signatures: InspSignature[]
  report?: string
}

export interface InspCompare {
  first: { id: number; type: InspType; performed_at: string | null }
  second: { id: number; type: InspType; performed_at: string | null }
  summary: Record<'piorou' | 'melhorou' | 'igual' | 'so_na_primeira' | 'so_na_segunda', number>
  items: {
    room: string
    item: string
    change: string
    first: { condition: Condition | null } | null
    second: { condition: Condition | null } | null
  }[]
}

export interface ClientInspection {
  id: number
  type: InspType
  performed_at: string
  unit_identifier: string
  property_name: string
}

/** Envia uma foto (corpo binário) e devolve o id. */
async function sendPhoto(path: string, blob: Blob): Promise<{ id: number }> {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? 'Não foi possível enviar a foto')
  return data
}

export const work = {
  uploadPhoto: sendPhoto,
  deletePhoto: (id: number) => request<void>(`/api/photos/${id}`, { method: 'DELETE' }),

  // Manutenção (equipe)
  maintenance: (query = '') => request<{ items: MaintItem[] }>(`/api/maintenance${query ? `?${query}` : ''}`),
  maintenanceItem: (id: number) => request<MaintDetail>(`/api/maintenance/${id}`),
  openMaintenance: (body: Record<string, unknown>) => request<{ id: number }>('/api/maintenance', json('POST', body)),
  assignMaintenance: (id: number, userId: number | null) =>
    request<void>(`/api/maintenance/${id}`, json('PATCH', { assigned_to: userId })),
  setMaintenanceStatus: (id: number, status: MaintStatus, extra: Record<string, unknown> = {}) =>
    request<{ status: MaintStatus }>(`/api/maintenance/${id}/status`, json('POST', { status, ...extra })),
  commentMaintenance: (id: number, message: string, clientVisible: boolean) =>
    request<unknown>(`/api/maintenance/${id}/comments`, json('POST', { message, client_visible: clientVisible })),
  addQuote: (id: number, supplier: string, amountCents: number, notes: string | null) =>
    request<{ id: number }>(`/api/maintenance/${id}/quotes`, json('POST', { supplier, amount_cents: amountCents, notes })),
  decideQuote: (id: number, quoteId: number, decision: 'approve' | 'reject') =>
    request<unknown>(`/api/maintenance/${id}/quotes/${quoteId}/${decision}`, { method: 'POST' }),

  // Vistorias (equipe)
  inspections: (query = '') => request<{ items: InspSummary[] }>(`/api/inspections${query ? `?${query}` : ''}`),
  inspection: (id: number) => request<InspDetail>(`/api/inspections/${id}`),
  createInspection: (body: Record<string, unknown>) => request<{ id: number }>('/api/inspections', json('POST', body)),
  setInspectionStatus: (id: number, status: InspStatus, performedAt?: string) =>
    request<unknown>(`/api/inspections/${id}/status`, json('POST', { status, performed_at: performedAt })),
  patchItem: (id: number, itemId: number, body: { condition?: Condition | null; notes?: string | null }) =>
    request<void>(`/api/inspections/${id}/items/${itemId}`, json('PATCH', body)),
  addItem: (id: number, room: string, item: string) => request<{ id: number }>(`/api/inspections/${id}/items`, json('POST', { room, item })),
  removeItem: (id: number, itemId: number) => request<void>(`/api/inspections/${id}/items/${itemId}`, { method: 'DELETE' }),
  signInspection: (id: number, role: InspSignature['role'], signerName: string) =>
    request<unknown>(`/api/inspections/${id}/signatures`, json('POST', { role, signer_name: signerName })),
  inspectionReport: (id: number) => request<{ report: string }>(`/api/inspections/${id}/report`),
  compareInspections: (id: number, otherId: number) => request<InspCompare>(`/api/inspections/${id}/compare/${otherId}`),

  // Área do cliente
  tenantMaintenance: () => request<{ items: MaintItem[] }>('/api/portal/tenant/maintenance'),
  tenantMaintenanceItem: (id: number) =>
    request<{ item: MaintFull; updates: TimelineUpdate[]; photos: number[] }>(`/api/portal/tenant/maintenance/${id}`),
  tenantOpenMaintenance: (body: Record<string, unknown>) => request<{ id: number }>('/api/portal/tenant/maintenance', json('POST', body)),
  tenantComment: (id: number, message: string) =>
    request<unknown>(`/api/portal/tenant/maintenance/${id}/comments`, json('POST', { message })),
  tenantCancelMaintenance: (id: number, reason: string) =>
    request<void>(`/api/portal/tenant/maintenance/${id}/cancel`, json('POST', { reason })),
  ownerMaintenance: () => request<{ items: MaintItem[] }>('/api/portal/owner/maintenance'),
  clientInspections: (who: 'tenant' | 'owner') => request<{ items: ClientInspection[] }>(`/api/portal/${who}/inspections`),
  clientInspection: (who: 'tenant' | 'owner', id: number) => request<InspDetail & { report: string }>(`/api/portal/${who}/inspections/${id}`),
  clientSign: (who: 'tenant' | 'owner', id: number, signerName: string) =>
    request<unknown>(`/api/portal/${who}/inspections/${id}/sign`, json('POST', { signer_name: signerName })),
}
