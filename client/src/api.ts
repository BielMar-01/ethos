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
  list: (resource: string) => request<{ items: Item[] }>(`/api/${resource}`),
  create: (resource: string, body: Record<string, unknown>) =>
    request<{ item: Item }>(`/api/${resource}`, json('POST', body)),
  update: (resource: string, id: number, body: Record<string, unknown>) =>
    request<{ item: Item }>(`/api/${resource}/${id}`, json('PATCH', body)),
  remove: (resource: string, id: number) =>
    request<void>(`/api/${resource}/${id}`, { method: 'DELETE' }),
}
