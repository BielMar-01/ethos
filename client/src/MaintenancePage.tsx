import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, type Item, type Member } from './api'
import { work, type MaintDetail, type MaintItem, type MaintStatus } from './workApi'
import { CATEGORY, MAINT_STATUS, PRIORITY } from './labels'
import { brl, dateTime, parseReais } from './format'
import MaskedInput from './MaskedInput'
import PhotoStrip from './PhotoStrip'
import { Alert, Loading, toast } from './feedback'
import Modal from './Modal'

const message = (e: unknown) => (e instanceof Error ? e.message : 'Erro inesperado')

type View = { kind: 'list' } | { kind: 'new' } | { kind: 'detail'; id: number }

export default function MaintenancePage({ isAdmin, currentUserId }: { isAdmin: boolean; currentUserId: number }) {
  const [view, setView] = useState<View>({ kind: 'list' })
  const [version, setVersion] = useState(0)
  const close = () => {
    setView({ kind: 'list' })
    setVersion((v) => v + 1)
  }
  return (
    <>
      <List key={version} onOpen={(id) => setView({ kind: 'detail', id })} onNew={() => setView({ kind: 'new' })} />
      {view.kind === 'new' && (
        <Modal size="lg" onClose={close}>
          <NewRequest onDone={(id) => setView({ kind: 'detail', id })} onCancel={close} />
        </Modal>
      )}
      {view.kind === 'detail' && (
        <Modal size="xl" onClose={close}>
          <Detail id={view.id} isAdmin={isAdmin} currentUserId={currentUserId} onBack={close} />
        </Modal>
      )}
    </>
  )
}

// ----------------------------------------------------------------------- Lista

function List({ onOpen, onNew }: { onOpen: (id: number) => void; onNew: () => void }) {
  const [items, setItems] = useState<MaintItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')

  useEffect(() => {
    work
      .maintenance(status ? `status=${status}` : '')
      .then((r) => setItems(r.items))
      .catch((e) => setError(message(e)))
      .finally(() => setLoading(false))
  }, [status])

  const open = items.filter((i) => !['concluida', 'cancelada'].includes(i.status)).length

  return (
    <section>
      <div className="page-head">
        <h2>Manutenção</h2>
        <select aria-label="Filtrar por status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todos os status</option>
          {(Object.keys(MAINT_STATUS) as MaintStatus[]).map((s) => (
            <option key={s} value={s}>{MAINT_STATUS[s]}</option>
          ))}
        </select>
        <button className="primary" onClick={onNew}>Nova solicitação</button>
      </div>
      {error && <Alert>{error}</Alert>}
      {loading ? (
        <Loading label="Carregando…" />
      ) : items.length === 0 ? (
        <p className="empty">Nenhum chamado por aqui.</p>
      ) : (
        <>
          {!status && <p className="muted small">{open} chamado(s) em andamento.</p>}
          <div className="panel table-wrap">
            <table>
              <thead>
                <tr><th>Prioridade</th><th>Chamado</th><th>Imóvel / unidade</th><th>Responsável</th><th>Status</th><th>Atualizado</th><th /></tr>
              </thead>
              <tbody>
                {items.map((m) => (
                  <tr key={m.id} className="clickable" onClick={() => onOpen(m.id)}>
                    <td><span className={`badge badge-p-${m.priority}`}>{PRIORITY[m.priority]}</span></td>
                    <td>{m.title}<div className="muted small">{CATEGORY[m.category]}{m.opened_by_name ? ` · aberto por ${m.opened_by_name}` : ''}</div></td>
                    <td>{m.property_name} · {m.unit_identifier}</td>
                    <td>{m.assigned_name ?? <span className="muted">—</span>}</td>
                    <td><span className={`badge badge-m-${m.status}`}>{MAINT_STATUS[m.status]}</span></td>
                    <td>{dateTime(m.updated_at)}</td>
                    <td className="row-actions" onClick={(e) => e.stopPropagation()}><button onClick={() => onOpen(m.id)}>Abrir</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}

// ------------------------------------------------------------------- Nova solicitação

function NewRequest({ onDone, onCancel }: { onDone: (id: number) => void; onCancel: () => void }) {
  const [units, setUnits] = useState<Item[]>([])
  const [properties, setProperties] = useState<Item[]>([])
  const [form, setForm] = useState({ unit_id: '', category: 'hidraulica', priority: 'media', title: '', description: '' })
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([api.list('units'), api.list('properties')])
      .then(([u, p]) => {
        setUnits(u.items)
        setProperties(p.items)
      })
      .catch((e) => setError(message(e)))
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    try {
      const r = await work.openMaintenance({ ...form, unit_id: Number(form.unit_id) })
      onDone(r.id)
    } catch (err) {
      setError(message(err))
    }
  }

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value })

  return (
    <section>
      <div className="page-head"><h2>Nova solicitação</h2></div>
      <form className="panel form-grid" onSubmit={submit}>
        <label>Unidade
          <select value={form.unit_id} onChange={set('unit_id')} required>
            <option value="">Selecione</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>{String(properties.find((p) => p.id === u.property_id)?.name ?? '?')} · {String(u.identifier)}</option>
            ))}
          </select>
        </label>
        <label>Categoria
          <select value={form.category} onChange={set('category')}>
            {Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label>Prioridade
          <select value={form.priority} onChange={set('priority')}>
            {Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="span-all">Título<input value={form.title} onChange={set('title')} maxLength={200} required /></label>
        <label className="span-all">Descrição
          <textarea rows={4} value={form.description} onChange={set('description')} maxLength={4000} required />
        </label>
        <p className="muted small span-all">Você poderá anexar fotos logo após criar a solicitação.</p>
        {error && <Alert className="span-all">{error}</Alert>}
        <div className="actions">
          <button type="button" onClick={onCancel}>Cancelar</button>
          <button type="submit" className="primary">Criar solicitação</button>
        </div>
      </form>
    </section>
  )
}

// ------------------------------------------------------------------------ Detalhe

/** Próximos passos permitidos por status (espelha o fluxo do servidor). */
const NEXT: Record<MaintStatus, { to: MaintStatus; label: string; primary?: boolean }[]> = {
  aberta: [{ to: 'em_analise', label: 'Iniciar análise', primary: true }],
  em_analise: [
    { to: 'aguardando_aprovacao', label: 'Enviar para aprovação', primary: true },
    { to: 'em_execucao', label: 'Executar sem orçamento' },
  ],
  aguardando_aprovacao: [{ to: 'em_analise', label: 'Voltar para análise' }],
  aprovada: [{ to: 'em_execucao', label: 'Iniciar execução', primary: true }],
  em_execucao: [{ to: 'concluida', label: 'Concluir', primary: true }],
  concluida: [],
  cancelada: [],
}

function Detail({ id, isAdmin, currentUserId, onBack }: { id: number; isAdmin: boolean; currentUserId: number; onBack: () => void }) {
  const [d, setD] = useState<MaintDetail | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [error, setError] = useState('')
  const [comment, setComment] = useState('')
  const [visible, setVisible] = useState(false)
  const [quote, setQuote] = useState({ supplier: '', amount: '', notes: '' })

  const load = useCallback(async () => {
    try {
      setD(await work.maintenanceItem(id))
    } catch (e) {
      setError(message(e))
    }
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (isAdmin) api.members().then((r) => setMembers(r.members.filter((m) => m.role === 'admin' || m.role === 'colaborador'))).catch(() => {})
  }, [isAdmin])

  async function run(action: () => Promise<unknown>) {
    setError('')
    try {
      await action()
      await load()
      toast.success('Alteração salva.')
    } catch (e) {
      setError(message(e))
    }
  }

  if (!d) return error ? <Alert>{error}</Alert> : <Loading label="Carregando…" />
  const { item, quotes, updates, photos } = d
  const closed = item.status === 'concluida' || item.status === 'cancelada'

  function changeStatus(to: MaintStatus) {
    if (to === 'concluida') {
      const raw = window.prompt('Custo final do serviço em R$ (deixe em branco se não houver):', '')
      if (raw === null) return
      const cents = raw.trim() ? parseReais(raw) : null
      if (raw.trim() && cents === null) return setError('Valor inválido.')
      return run(() => work.setMaintenanceStatus(id, to, cents === null ? {} : { cost_cents: cents }))
    }
    return run(() => work.setMaintenanceStatus(id, to))
  }

  function cancel() {
    const reason = window.prompt('Motivo do cancelamento:')
    if (!reason?.trim()) return
    return run(() => work.setMaintenanceStatus(id, 'cancelada', { reason: reason.trim() }))
  }

  async function addQuote(e: FormEvent) {
    e.preventDefault()
    const cents = parseReais(quote.amount)
    if (cents === null) return setError('Valor do orçamento inválido.')
    await run(() => work.addQuote(id, quote.supplier, cents, quote.notes.trim() || null))
    setQuote({ supplier: '', amount: '', notes: '' })
  }

  async function sendComment(e: FormEvent) {
    e.preventDefault()
    await run(() => work.commentMaintenance(id, comment, visible))
    setComment('')
  }

  return (
    <section>
      <div className="page-head">
        <button className="back-btn" onClick={onBack}>← Chamados</button>
        <h2>{item.title}</h2>
        <span className={`badge badge-m-${item.status}`}>{MAINT_STATUS[item.status]}</span>
        <span className={`badge badge-p-${item.priority}`}>{PRIORITY[item.priority]}</span>
      </div>
      {error && <Alert>{error}</Alert>}

      <div className="panel">
        <dl className="facts">
          <div><dt>Imóvel / unidade</dt><dd>{item.property_name} · {item.unit_identifier}</dd></div>
          <div><dt>Categoria</dt><dd>{CATEGORY[item.category]}</dd></div>
          <div><dt>Aberto por</dt><dd>{item.opened_by_name ?? 'Administradora'}</dd></div>
          <div><dt>Custo final</dt><dd>{item.cost_cents !== null ? brl(item.cost_cents) : '—'}</dd></div>
          <div className="span-all"><dt>Descrição</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{item.description}</dd></div>
          {item.cancelled_reason && <div className="span-all"><dt>Motivo do cancelamento</dt><dd>{item.cancelled_reason}</dd></div>}
          <div>
            <dt>Responsável</dt>
            <dd>
              {closed ? (
                item.assigned_name ?? '—'
              ) : isAdmin ? (
                <select
                  aria-label="Responsável"
                  value={item.assigned_to ?? ''}
                  onChange={(e) => run(() => work.assignMaintenance(id, e.target.value ? Number(e.target.value) : null))}
                >
                  <option value="">— ninguém —</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              ) : (
                <>
                  {item.assigned_name ?? '—'}{' '}
                  {item.assigned_to !== currentUserId && (
                    <button onClick={() => run(() => work.assignMaintenance(id, currentUserId))}>Assumir</button>
                  )}
                </>
              )}
            </dd>
          </div>
        </dl>
        {!closed && (
          <div className="actions left">
            {NEXT[item.status].map((n) => (
              <button key={n.to} className={n.primary ? 'primary' : ''} onClick={() => changeStatus(n.to)}>{n.label}</button>
            ))}
            <button className="danger" onClick={cancel}>Cancelar chamado</button>
          </div>
        )}
      </div>

      <h3>Fotos</h3>
      <div className="panel">
        <PhotoStrip
          ids={photos.map((p) => p.id)}
          onUpload={closed ? undefined : async (blob) => { await work.uploadPhoto(`/api/maintenance/${id}/photos`, blob); await load() }}
          onDelete={async (pid) => { await work.deletePhoto(pid); await load() }}
        />
        {photos.length === 0 && closed && <p className="muted">Sem fotos.</p>}
      </div>

      <h3>Orçamentos</h3>
      <div className="panel stack">
        {quotes.length === 0 ? (
          <p className="muted">Nenhum orçamento registrado.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Fornecedor</th><th>Valor</th><th>Situação</th><th /></tr></thead>
              <tbody>
                {quotes.map((q) => (
                  <tr key={q.id}>
                    <td>{q.supplier}{q.notes && <div className="muted small">{q.notes}</div>}</td>
                    <td>{brl(q.amount_cents)}</td>
                    <td><span className={`badge ${q.status === 'aprovado' ? 'badge-vigente' : q.status === 'recusado' ? 'badge-c-cancelada' : 'badge-rascunho'}`}>{q.status}</span></td>
                    <td className="row-actions">
                      {isAdmin && item.status === 'aguardando_aprovacao' && q.status === 'pendente' && (
                        <>
                          <button className="primary" onClick={() => run(() => work.decideQuote(id, q.id, 'approve'))}>Aprovar</button>
                          <button className="danger" onClick={() => run(() => work.decideQuote(id, q.id, 'reject'))}>Recusar</button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {(item.status === 'em_analise' || item.status === 'aguardando_aprovacao') && (
          <form className="inline" onSubmit={addQuote}>
            <input aria-label="Fornecedor" placeholder="Fornecedor" value={quote.supplier} onChange={(e) => setQuote({ ...quote, supplier: e.target.value })} required />
            <MaskedInput kind="money" aria-label="Valor" className="narrow" value={quote.amount} onValue={(v) => setQuote({ ...quote, amount: v })} required />
            <input aria-label="Observações" placeholder="Observações (opcional)" value={quote.notes} onChange={(e) => setQuote({ ...quote, notes: e.target.value })} />
            <button type="submit">Registrar orçamento</button>
          </form>
        )}
        {!isAdmin && item.status === 'aguardando_aprovacao' && <p className="muted small">A aprovação do orçamento é feita por um administrador.</p>}
      </div>

      <h3>Linha do tempo</h3>
      <div className="panel stack">
        <ul className="timeline">
          {[...updates].reverse().map((u) => (
            <li key={u.id} className={u.client_visible ? '' : 'internal'}>
              <div>{u.message}</div>
              <div className="meta">
                {u.author_name} · {dateTime(u.created_at)}
                {u.client_visible === false && <span className="badge badge-rascunho" style={{ marginLeft: 8 }}>interno</span>}
              </div>
            </li>
          ))}
        </ul>
        {!closed && (
          <form className="stack" onSubmit={sendComment}>
            <textarea aria-label="Comentário" rows={2} placeholder="Escreva um comentário…" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} required />
            <div className="inline">
              <label className="check"><input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} /> Visível ao cliente</label>
              <button type="submit">Comentar</button>
            </div>
          </form>
        )}
      </div>
    </section>
  )
}
