// Notificações, comunicados e painel: tipos e chamadas à API.
import { json, request } from './api'

export type NotifCategory = 'financeiro' | 'manutencao' | 'vistoria' | 'contrato' | 'comunicado'

export interface AppNotification {
  id: number
  category: NotifCategory
  kind: string
  title: string
  body: string | null
  link_kind: string | null
  link_id: number | null
  read_at: string | null
  created_at: string
}

export interface NotifPref {
  category: NotifCategory
  label: string
  in_app: boolean
}

export type Audience = 'todos' | 'inquilinos' | 'proprietarios' | 'imovel'

export interface Announcement {
  id: number
  title: string
  body: string
  audience: Audience
  property_id?: number | null
  property_name: string | null
  status?: 'rascunho' | 'publicado' | 'arquivado'
  published_at: string | null
  created_at?: string
  created_by_name?: string | null
}

export interface DashboardData {
  month: string
  counts: {
    properties: number
    owners: number
    tenants: number
    units: { total: number; occupied: number; available: number }
    leases: { active: number; ending_60d: number }
    maintenance: { open: number; urgent: number; waiting_approval: number }
    inspections_pending: number
  }
  finance: {
    expected_cents: number
    received_cents: number
    received_ratio: number | null
    overdue_cents: number
    overdue_count: number
    cash_received_cents: number
  }
  attention: { kind: string; title: string; detail: string; link_kind: string; link_id: number }[]
}

export const comm = {
  notifications: (query = '') =>
    request<{ items: AppNotification[]; unread: number }>(`/api/notifications${query ? `?${query}` : ''}`),
  unreadCount: () => request<{ unread: number }>('/api/notifications/count'),
  markRead: (id: number) => request<void>(`/api/notifications/${id}/read`, { method: 'POST' }),
  readAll: () => request<void>('/api/notifications/read-all', { method: 'POST' }),
  preferences: () =>
    request<{ items: NotifPref[]; channels: Record<'in_app' | 'email' | 'whatsapp' | 'push', boolean> }>('/api/notifications/preferences'),
  setPreference: (category: NotifCategory, inApp: boolean) =>
    request<void>('/api/notifications/preferences', json('PUT', { category, in_app: inApp })),
  runReminders: () =>
    request<{ dueSoon: number; overdue: number; overdueDigest: number; leasesEnding: number }>('/api/reminders/run', { method: 'POST' }),

  announcements: () => request<{ items: Announcement[] }>('/api/announcements'),
  createAnnouncement: (body: { title: string; body: string; audience: Audience; property_id?: number }) =>
    request<{ id: number }>('/api/announcements', json('POST', body)),
  updateAnnouncement: (id: number, body: { title: string; body: string; audience: Audience; property_id?: number }) =>
    request<void>(`/api/announcements/${id}`, json('PATCH', body)),
  publishAnnouncement: (id: number) => request<{ recipients: number; notified: number }>(`/api/announcements/${id}/publish`, { method: 'POST' }),
  archiveAnnouncement: (id: number) => request<void>(`/api/announcements/${id}/archive`, { method: 'POST' }),
  deleteAnnouncement: (id: number) => request<void>(`/api/announcements/${id}`, { method: 'DELETE' }),
  clientAnnouncements: () => request<{ items: Announcement[] }>('/api/portal/announcements'),

  dashboard: () => request<DashboardData>('/api/dashboard'),
}
