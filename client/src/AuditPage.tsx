import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { request } from './api'
import { Alert, Empty, Loading, errorText, toast } from './feedback'
import { dateTime, timeAgo } from './format'

/** Registro de atividade: só o administrador vê. Somente leitura (o servidor não oferece edição nem exclusão). */

interface Row {
  id: number
  user_id: number | null
  user_name: string | null
  user_email: string | null
  role: string | null
  kind: string
  entity: string | null
  entity_id: number | null
  summary: string
  status: number | null
  metadata: Record<string, unknown>
  ip: string | null
  user_agent: string | null
  created_at: string
}
interface Actor { user_id: number; user_name: string | null; user_email: string | null }

const KIND: Record<string, { label: string; tone: string }> = {
  create: { label: 'Cadastro', tone: 'ok' },
  update: { label: 'Alteração', tone: 'info' },
  delete: { label: 'Exclusão', tone: 'danger' },
  action: { label: 'Ação', tone: 'warn' },
  auth: { label: 'Acesso', tone: 'muted' },
  denied: { label: 'Negado', tone: 'danger' },
  system: { label: 'Sistema', tone: 'muted' },
}

const ENTITY: Record<string, string> = {
  owners: 'Proprietários', tenants: 'Inquilinos', properties: 'Imóveis', units: 'Unidades', leases: 'Contratos',
  'contract-templates': 'Modelos', charges: 'Cobranças', payments: 'Pagamentos', transfers: 'Repasses',
  settings: 'Configurações', maintenance: 'Manutenção', inspections: 'Vistorias', photos: 'Fotos',
  announcements: 'Comunicados', members: 'Equipe', invitations: 'Convites', 'api-keys': 'Chaves de API',
  reminders: 'Lembretes', portal: 'Área do cliente', auth: 'Acesso',
}

const META_LABEL: Record<string, string> = { status: 'Status', role: 'Papel', mode: 'Modo', month: 'Mês', audience: 'Público', reason: 'Motivo', type: 'Tipo', label: 'Alvo', path: 'Rota', method: 'Método' }

const ROLE: Record<string, string> = { admin: 'Administrador', colaborador: 'Colaborador', proprietario: 'Proprietário', inquilino: 'Inquilino' }

interface Filters { q: string; kind: string; entity: string; user_id: string; from: string; to: string }
const EMPTY: Filters = { q: '', kind: '', entity: '', user_id: '', from: '', to: '' }

const toQuery = (f: Filters, extra: Record<string, string> = {}) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries({ ...f, ...extra })) if (v) p.set(k, v)
  const s = p.toString()
  return s ? `?${s}` : ''
}

export default function AuditPage() {
  const [filters, setFilters] = useState<Filters>(EMPTY)
  const [debouncedQ, setDebouncedQ] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [next, setNext] = useState<number | null>(null)
  const [actors, setActors] = useState<Actor[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<number | null>(null)
  const seq = useRef(0)

  // A busca por texto espera o usuário parar de digitar.
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(filters.q), 300)
    return () => window.clearTimeout(t)
  }, [filters.q])

  const effective: Filters = { ...filters, q: debouncedQ }
  const key = JSON.stringify(effective)

  const load = useCallback(async () => {
    const mine = ++seq.current // ignora respostas antigas se os filtros mudaram no meio do caminho
    setLoading(true)
    try {
      const r = await request<{ items: Row[]; next_before: number | null }>(`/api/audit${toQuery(JSON.parse(key) as Filters)}`)
      if (mine !== seq.current) return
      setRows(r.items)
      setNext(r.next_before)
      setError('')
    } catch (e) {
      if (mine === seq.current) setError(errorText(e))
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }, [key])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    request<{ items: Actor[] }>('/api/audit/actors').then((r) => setActors(r.items)).catch(() => setActors([]))
  }, [])

  async function more() {
    if (!next) return
    setLoadingMore(true)
    try {
      const r = await request<{ items: Row[]; next_before: number | null }>(`/api/audit${toQuery(effective, { before: String(next) })}`)
      setRows((old) => [...old, ...r.items])
      setNext(r.next_before)
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setLoadingMore(false)
    }
  }

  async function exportCsv() {
    try {
      const res = await fetch(`/api/audit/export${toQuery(effective)}`)
      if (!res.ok) throw new Error('Não foi possível exportar. Tente novamente.')
      const url = URL.createObjectURL(await res.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = 'auditoria-ethos.csv'
      a.click()
      URL.revokeObjectURL(url)
      toast.success('Exportação pronta (até 5.000 registros mais recentes do filtro).')
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }))
  const filtered = JSON.stringify(filters) !== JSON.stringify(EMPTY)

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Registros de atividade</h2>
          <p className="muted page-sub">Quem fez o quê, quando e de onde. Só administradores veem esta tela e os registros não podem ser alterados nem apagados.</p>
        </div>
        <button onClick={exportCsv}>Exportar CSV</button>
      </div>

      <div className="panel filters" role="search">
        <label className="grow">
          Buscar
          <input type="search" placeholder="Ação, pessoa, e-mail ou IP" value={filters.q} onChange={(e) => set({ q: e.target.value })} />
        </label>
        <label>
          Tipo
          <select value={filters.kind} onChange={(e) => set({ kind: e.target.value })}>
            <option value="">Todos</option>
            {Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
        <label>
          Onde
          <select value={filters.entity} onChange={(e) => set({ entity: e.target.value })}>
            <option value="">Tudo</option>
            {Object.entries(ENTITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label>
          Pessoa
          <select value={filters.user_id} onChange={(e) => set({ user_id: e.target.value })}>
            <option value="">Todas</option>
            {actors.map((a) => <option key={a.user_id} value={a.user_id}>{a.user_name ?? a.user_email}</option>)}
          </select>
        </label>
        <label>
          De
          <input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => set({ from: e.target.value })} />
        </label>
        <label>
          Até
          <input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => set({ to: e.target.value })} />
        </label>
        {filtered && <button className="link" onClick={() => setFilters(EMPTY)}>Limpar filtros</button>}
      </div>

      {error && <Alert>{error}</Alert>}

      {loading ? (
        <Loading label="Carregando registros…" />
      ) : rows.length === 0 ? (
        <Empty title={filtered ? 'Nenhum registro com esses filtros' : 'Ainda não há registros'}>
          {filtered ? 'Tente ampliar o período ou limpar os filtros.' : 'As ações feitas no sistema passam a aparecer aqui.'}
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="audit-table">
            <thead>
              <tr><th>Quando</th><th>Pessoa</th><th>O que aconteceu</th><th>Origem</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const k = KIND[r.kind] ?? { label: r.kind, tone: 'muted' }
                const isOpen = open === r.id
                return (
                  <Fragment key={r.id}>
                    <tr className={`audit-row${isOpen ? ' open' : ''}`} onClick={() => setOpen(isOpen ? null : r.id)}>
                      <td title={dateTime(r.created_at)}>
                        <strong>{timeAgo(r.created_at)}</strong>
                        <small className="muted block">{dateTime(r.created_at)}</small>
                      </td>
                      <td>
                        {r.user_name ?? 'Sistema'}
                        <small className="muted block">{r.role ? (ROLE[r.role] ?? r.role) : ''}</small>
                      </td>
                      <td>
                        <span className={`audit-kind tone-${k.tone}`}>{k.label}</span> {r.summary}
                      </td>
                      <td className="muted">{r.ip ?? '—'}</td>
                    </tr>
                    {isOpen && (
                      <tr className="audit-detail">
                        <td colSpan={4}>
                          <dl>
                            <div><dt>E-mail</dt><dd>{r.user_email ?? '—'}</dd></div>
                            <div><dt>Onde</dt><dd>{(r.entity && ENTITY[r.entity]) || r.entity || '—'}{r.entity_id ? ` #${r.entity_id}` : ''}</dd></div>
                            <div><dt>Resposta</dt><dd>{r.status ?? '—'}</dd></div>
                            {Object.entries(r.metadata).map(([mk, mv]) => (
                              <div key={mk}><dt>{META_LABEL[mk] ?? mk}</dt><dd>{String(mv)}</dd></div>
                            ))}
                            <div className="wide"><dt>Aparelho</dt><dd>{r.user_agent ?? '—'}</dd></div>
                          </dl>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {!loading && next && (
        <div className="center-row">
          <button onClick={more} disabled={loadingMore}>{loadingMore ? 'Carregando…' : 'Carregar mais'}</button>
        </div>
      )}
    </>
  )
}
