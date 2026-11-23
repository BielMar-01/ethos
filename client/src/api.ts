export interface User {
  id: number
  name: string
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
}

export interface Invitation {
  id: number
  email: string
  role: Role
  expires_at: string
  created_at: string
}

export interface InviteInfo {
  email: string
  role: Role
  organizationName: string
  existingAccount: boolean
}

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Administrador',
  colaborador: 'Colaborador',
  proprietario: 'Proprietário',
  inquilino: 'Inquilino',
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? 'Erro inesperado')
  return data as T
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
})

export const api = {
  me: () => request<Session | { user: null }>('/api/auth/me'),
  login: (email: string, password: string) =>
    request<Session>('/api/auth/login', json('POST', { email, password })),
  register: (name: string, email: string, password: string, organizationName: string) =>
    request<Session>(
      '/api/auth/register',
      json('POST', { name, email, password, organizationName }),
    ),
  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),
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

  // Equipe (admin)
  members: () => request<{ members: Member[] }>('/api/members'),
  setMemberRole: (id: number, role: Role) => request<unknown>(`/api/members/${id}`, json('PATCH', { role })),
  removeMember: (id: number) => request<void>(`/api/members/${id}`, { method: 'DELETE' }),
  memberPasswordReset: (id: number, mode: 'email' | 'link') =>
    request<{ sent?: boolean; link?: string }>(`/api/members/${id}/password-reset`, json('POST', { mode })),
  invitations: () => request<{ invitations: Invitation[] }>('/api/invitations'),
  createInvitation: (email: string, role: Role) =>
    request<{ invitation: Invitation; link: string }>('/api/invitations', json('POST', { email, role })),
  revokeInvitation: (id: number) => request<void>(`/api/invitations/${id}`, { method: 'DELETE' }),
  list: (resource: string) => request<{ items: Item[] }>(`/api/${resource}`),
  create: (resource: string, body: Record<string, unknown>) =>
    request<{ item: Item }>(`/api/${resource}`, json('POST', body)),
  update: (resource: string, id: number, body: Record<string, unknown>) =>
    request<{ item: Item }>(`/api/${resource}/${id}`, json('PATCH', body)),
  remove: (resource: string, id: number) =>
    request<void>(`/api/${resource}/${id}`, { method: 'DELETE' }),
}
