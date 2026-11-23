import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, type Item } from './api'
import { comm, type Announcement, type Audience } from './commApi'
import { dateTime } from './format'

const message = (e: unknown) => (e instanceof Error ? e.message : 'Erro inesperado')

const AUDIENCE: Record<Audience, string> = {
  todos: 'Todos os clientes',
  inquilinos: 'Todos os inquilinos',
  proprietarios: 'Todos os proprietários',
  imovel: 'Um imóvel específico',
}

const STATUS_CLASS: Record<string, string> = { rascunho: 'badge-rascunho', publicado: 'badge-vigente', arquivado: 'badge-c-cancelada' }
const STATUS_LABEL: Record<string, string> = { rascunho: 'Rascunho', publicado: 'Publicado', arquivado: 'Arquivado' }

/** Comunicados da administradora: escreve, escolhe o público, publica (notifica) e arquiva. */
export default function AnnouncementsPage() {
  const [items, setItems] = useState<Announcement[]>([])
  const [properties, setProperties] = useState<Item[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState<Announcement | 'new' | null>(null)
  const [form, setForm] = useState({ title: '', body: '', audience: 'todos' as Audience, property_id: '' })

  const load = useCallback(async () => {
    try {
      const [a, p] = await Promise.all([comm.announcements(), api.list('properties')])
      setItems(a.items)
      setProperties(p.items)
    } catch (e) {
      setError(message(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  function open(a: Announcement | 'new') {
    setError('')
    setNotice('')
    setForm(
      a === 'new'
        ? { title: '', body: '', audience: 'todos', property_id: '' }
        : { title: a.title, body: a.body, audience: a.audience, property_id: a.property_id ? String(a.property_id) : '' },
    )
    setEditing(a)
  }

  async function run(action: () => Promise<unknown>) {
    setError('')
    setNotice('')
    try {
      await action()
      await load()
    } catch (e) {
      setError(message(e))
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    const body = { title: form.title, body: form.body, audience: form.audience, ...(form.audience === 'imovel' ? { property_id: Number(form.property_id) } : {}) }
    await run(async () => {
      if (editing === 'new') await comm.createAnnouncement(body)
      else if (editing) await comm.updateAnnouncement(editing.id, body)
      setEditing(null)
    })
  }

  function publish(a: Announcement) {
    if (!window.confirm(`Publicar "${a.title}" para ${AUDIENCE[a.audience].toLowerCase()}? Depois de publicado, o texto não pode ser alterado.`)) return
    return run(async () => {
      const r = await comm.publishAnnouncement(a.id)
      setNotice(`Publicado. ${r.recipients} pessoa(s) no público; ${r.notified} notificada(s) (quem desligou os comunicados não recebe o aviso, mas vê na área do cliente).`)
    })
  }

  return (
    <section>
      <div className="page-head">
        <h2>Comunicados</h2>
        <button className="primary" onClick={() => open('new')}>Novo comunicado</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}

      {editing && (
        <form className="panel form-grid" onSubmit={save}>
          <h3>{editing === 'new' ? 'Novo comunicado' : 'Editar rascunho'}</h3>
          <label className="span-all">Título<input value={form.title} maxLength={150} required onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
          <label>Quem vai receber
            <select value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value as Audience })}>
              {(Object.keys(AUDIENCE) as Audience[]).map((a) => <option key={a} value={a}>{AUDIENCE[a]}</option>)}
            </select>
          </label>
          {form.audience === 'imovel' && (
            <label>Imóvel
              <select value={form.property_id} required onChange={(e) => setForm({ ...form, property_id: e.target.value })}>
                <option value="">Selecione</option>
                {properties.map((p) => <option key={p.id} value={p.id}>{String(p.name)}</option>)}
              </select>
            </label>
          )}
          <label className="span-all">Mensagem
            <textarea rows={6} value={form.body} maxLength={5000} required onChange={(e) => setForm({ ...form, body: e.target.value })} />
          </label>
          <p className="muted small span-all">
            Salvar cria um rascunho: nada é enviado até você publicar. Só clientes já vinculados a um cadastro recebem o aviso.
          </p>
          <div className="actions">
            <button type="button" onClick={() => setEditing(null)}>Cancelar</button>
            <button type="submit" className="primary">Salvar rascunho</button>
          </div>
        </form>
      )}

      {loading ? (
        <p className="muted">Carregando…</p>
      ) : items.length === 0 ? (
        <p className="empty">Nenhum comunicado ainda. Use-os para avisar obras, mudanças de regras ou lembretes gerais.</p>
      ) : (
        items.map((a) => (
          <article key={a.id} className="panel ann">
            <div className="meta">
              <span className={`badge ${STATUS_CLASS[a.status ?? 'rascunho']}`}>{STATUS_LABEL[a.status ?? 'rascunho']}</span>
              <span>Para: {a.audience === 'imovel' ? a.property_name : AUDIENCE[a.audience]}</span>
              <span>{a.published_at ? `Publicado em ${dateTime(a.published_at)}` : `Criado em ${dateTime(a.created_at ?? '')}`}</span>
              {a.created_by_name && <span>por {a.created_by_name}</span>}
            </div>
            <h3>{a.title}</h3>
            <p>{a.body}</p>
            <div className="actions left" style={{ marginTop: '0.6rem' }}>
              {a.status === 'rascunho' && (
                <>
                  <button className="primary" onClick={() => publish(a)}>Publicar</button>
                  <button onClick={() => open(a)}>Editar</button>
                  <button className="danger" onClick={() => window.confirm('Excluir este rascunho?') && run(() => comm.deleteAnnouncement(a.id))}>Excluir</button>
                </>
              )}
              {a.status === 'publicado' && (
                <button onClick={() => window.confirm('Arquivar? O comunicado deixa de aparecer na área do cliente.') && run(() => comm.archiveAnnouncement(a.id))}>Arquivar</button>
              )}
            </div>
          </article>
        ))
      )}
    </section>
  )
}
