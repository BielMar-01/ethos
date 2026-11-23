import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { PortalLease } from './api'
import { comm, type Announcement } from './commApi'
import { work, type ClientInspection, type InspDetail, type MaintFull, type MaintItem, type TimelineUpdate } from './workApi'
import { CATEGORY, INSP_TYPE, MAINT_STATUS, PRIORITY, SIGN_NOTE } from './labels'
import { brl, date, dateTime } from './format'
import PhotoStrip from './PhotoStrip'
import { ReadOnlyChecklist, ReportPaper, Signatures } from './InspectionView'
import { Alert, Loading, toast } from './feedback'
import Modal from './Modal'

const message = (e: unknown) => (e instanceof Error ? e.message : 'Erro inesperado')

// ------------------------------------------------------------------- Comunicados

/** Comunicados publicados que se aplicam ao cliente (pelo papel e pelo imóvel). */
export function ClientAnnouncements() {
  const [items, setItems] = useState<Announcement[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    comm
      .clientAnnouncements()
      .then((r) => setItems(r.items))
      .catch((e) => setError(message(e)))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <Loading label="Carregando…" />
  return (
    <>
      {error && <Alert>{error}</Alert>}
      {items.length === 0 ? (
        <p className="empty">Nenhum comunicado por enquanto.</p>
      ) : (
        items.map((a) => (
          <article key={a.id} className="panel ann">
            <div className="meta">
              <span>{a.published_at ? dateTime(a.published_at) : ''}</span>
              {a.property_name && <span className="badge badge-rascunho">{a.property_name}</span>}
            </div>
            <h3>{a.title}</h3>
            <p>{a.body}</p>
          </article>
        ))
      )}
    </>
  )
}

// -------------------------------------------------------- Manutenção (inquilino)

export function TenantMaintenance({ leases }: { leases: PortalLease[] }) {
  const [items, setItems] = useState<MaintItem[]>([])
  const [openId, setOpenId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setItems((await work.tenantMaintenance()).items)
    } catch (e) {
      setError(message(e))
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const active = leases.filter((l) => l.status === 'vigente')

  return (
    <>
      {error && <Alert>{error}</Alert>}
      <div className="toolbar">
        <span className="spacer" />
        <button className="primary" disabled={active.length === 0} onClick={() => setCreating(true)}>Nova solicitação</button>
      </div>
      {active.length === 0 && <p className="muted small">Você precisa de um contrato vigente para abrir solicitações.</p>}
      {creating && (
        <Modal title="Nova solicitação de manutenção" onClose={() => setCreating(false)}>
          <NewTenantRequest leases={active} onCancel={() => setCreating(false)} onDone={(id) => { setCreating(false); setOpenId(id) }} />
        </Modal>
      )}
      {openId !== null && (
        <Modal size="lg" onClose={() => { setOpenId(null); load() }}>
          <TenantRequest id={openId} onBack={() => { setOpenId(null); load() }} />
        </Modal>
      )}
      {items.length === 0 ? (
        <p className="empty">Nenhuma solicitação aberta. Precisa de um reparo? Abra uma solicitação.</p>
      ) : (
        <div className="panel table-wrap">
          <table>
            <thead><tr><th>Solicitação</th><th>Categoria</th><th>Situação</th><th>Atualizada</th><th /></tr></thead>
            <tbody>
              {items.map((m) => (
                <tr key={m.id}>
                  <td>{m.title}</td>
                  <td>{CATEGORY[m.category]}</td>
                  <td><span className={`badge badge-m-${m.status}`}>{MAINT_STATUS[m.status]}</span></td>
                  <td>{dateTime(m.updated_at)}</td>
                  <td className="row-actions" onClick={(e) => e.stopPropagation()}><button onClick={() => setOpenId(m.id)}>Acompanhar</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

function NewTenantRequest({ leases, onDone, onCancel }: { leases: PortalLease[]; onDone: (id: number) => void; onCancel: () => void }) {
  const [form, setForm] = useState({ lease_id: String(leases[0]?.id ?? ''), category: 'hidraulica', priority: 'media', title: '', description: '' })
  const [error, setError] = useState('')
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value })

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    try {
      onDone((await work.tenantOpenMaintenance({ ...form, lease_id: Number(form.lease_id) })).id)
    } catch (err) {
      setError(message(err))
    }
  }

  return (
    <form className="panel form-grid" onSubmit={submit}>
      <h3>Nova solicitação de manutenção</h3>
      {leases.length > 1 && (
        <label>Imóvel
          <select value={form.lease_id} onChange={set('lease_id')}>
            {leases.map((l) => <option key={l.id} value={l.id}>{l.property_name} · {l.unit_identifier}</option>)}
          </select>
        </label>
      )}
      <label>Tipo de problema
        <select value={form.category} onChange={set('category')}>
          {Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      <label>Urgência
        <select value={form.priority} onChange={set('priority')}>
          <option value="baixa">Baixa</option><option value="media">Média</option><option value="alta">Alta</option>
        </select>
      </label>
      <label className="span-all">Resumo<input value={form.title} onChange={set('title')} maxLength={200} required /></label>
      <label className="span-all">O que está acontecendo?
        <textarea rows={4} value={form.description} onChange={set('description')} maxLength={4000} required />
      </label>
      <p className="muted small span-all">Depois de enviar, você poderá anexar fotos e acompanhar cada etapa.</p>
      {error && <Alert className="span-all">{error}</Alert>}
      <div className="actions">
        <button type="button" onClick={onCancel}>Cancelar</button>
        <button type="submit" className="primary">Enviar solicitação</button>
      </div>
    </form>
  )
}

function TenantRequest({ id, onBack }: { id: number; onBack: () => void }) {
  const [d, setD] = useState<{ item: MaintFull; updates: TimelineUpdate[]; photos: number[] } | null>(null)
  const [comment, setComment] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setD(await work.tenantMaintenanceItem(id))
    } catch (e) {
      setError(message(e))
    }
  }, [id])

  useEffect(() => {
    load()
  }, [load])

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
  const { item, updates, photos } = d
  const closed = item.status === 'concluida' || item.status === 'cancelada'

  return (
    <>
      <div className="page-head">
        <button className="back-btn" onClick={onBack}>← Solicitações</button>
        <h3 style={{ margin: 0 }}>{item.title}</h3>
        <span className={`badge badge-m-${item.status}`}>{MAINT_STATUS[item.status]}</span>
      </div>
      {error && <Alert>{error}</Alert>}
      <div className="panel stack">
        <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{item.description}</p>
        <div className="muted small">{CATEGORY[item.category]} · urgência {PRIORITY[item.priority].toLowerCase()} · aberta em {dateTime(item.created_at)}</div>
        {item.cancelled_reason && <div className="muted">Motivo do cancelamento: {item.cancelled_reason}</div>}
        <PhotoStrip
          ids={photos}
          label="Foto"
          onUpload={closed ? undefined : async (blob) => { await work.uploadPhoto(`/api/portal/tenant/maintenance/${id}/photos`, blob); await load() }}
        />
        {item.status === 'aberta' && (
          <div className="actions left">
            <button
              className="danger"
              onClick={() => {
                const reason = window.prompt('Por que deseja cancelar? (opcional)', '')
                if (reason !== null) run(() => work.tenantCancelMaintenance(id, reason))
              }}
            >
              Cancelar solicitação
            </button>
          </div>
        )}
      </div>
      <h3>Acompanhamento</h3>
      <div className="panel stack">
        <ul className="timeline">
          {[...updates].reverse().map((u) => (
            <li key={u.id}>
              <div>{u.message}</div>
              <div className="meta">{u.author_name} · {dateTime(u.created_at)}</div>
            </li>
          ))}
        </ul>
        {!closed && (
          <form
            className="stack"
            onSubmit={(e) => { e.preventDefault(); run(() => work.tenantComment(id, comment)).then(() => setComment('')) }}
          >
            <textarea aria-label="Mensagem" rows={2} placeholder="Escreva uma mensagem para a administradora…" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} required />
            <div><button type="submit">Enviar mensagem</button></div>
          </form>
        )}
      </div>
    </>
  )
}

// ----------------------------------------------------- Manutenção (proprietário)

export function OwnerMaintenance() {
  const [items, setItems] = useState<MaintItem[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    work.ownerMaintenance().then((r) => setItems(r.items)).catch((e) => setError(message(e)))
  }, [])

  return (
    <>
      {error && <Alert>{error}</Alert>}
      {items.length === 0 ? (
        <p className="empty">Nenhum chamado de manutenção nos seus imóveis.</p>
      ) : (
        <div className="panel table-wrap">
          <table>
            <thead><tr><th>Chamado</th><th>Imóvel / unidade</th><th>Prioridade</th><th>Situação</th><th>Custo</th></tr></thead>
            <tbody>
              {items.map((m) => (
                <tr key={m.id}>
                  <td>{m.title}<div className="muted small">{CATEGORY[m.category]} · aberto em {date(m.created_at)}</div></td>
                  <td>{m.property_name} · {m.unit_identifier}</td>
                  <td><span className={`badge badge-p-${m.priority}`}>{PRIORITY[m.priority]}</span></td>
                  <td><span className={`badge badge-m-${m.status}`}>{MAINT_STATUS[m.status]}</span></td>
                  <td>{m.cost_cents !== null ? brl(m.cost_cents) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------- Vistorias

/** Vistorias concluídas: laudo, checklist com fotos e registro de ciência do próprio cliente. */
export function ClientInspections({ who }: { who: 'tenant' | 'owner' }) {
  const [items, setItems] = useState<ClientInspection[]>([])
  const [openId, setOpenId] = useState<number | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    work.clientInspections(who).then((r) => setItems(r.items)).catch((e) => setError(message(e)))
  }, [who])

  return (
    <>
      {error && <Alert>{error}</Alert>}
      {items.length === 0 ? (
        <p className="empty">Nenhuma vistoria concluída por enquanto.</p>
      ) : (
        <div className="panel table-wrap">
          <table>
            <thead><tr><th>Tipo</th><th>Imóvel / unidade</th><th>Realizada em</th><th /></tr></thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id} className="clickable" onClick={() => setOpenId(i.id)}>
                  <td>Vistoria de {INSP_TYPE[i.type].toLowerCase()}</td>
                  <td>{i.property_name} · {i.unit_identifier}</td>
                  <td>{date(i.performed_at)}</td>
                  <td className="row-actions"><button onClick={() => setOpenId(i.id)}>Ver</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {openId !== null && (
        <Modal size="xl" onClose={() => setOpenId(null)}>
          <ClientInspection who={who} id={openId} onBack={() => setOpenId(null)} />
        </Modal>
      )}
    </>
  )
}

function ClientInspection({ who, id, onBack }: { who: 'tenant' | 'owner'; id: number; onBack: () => void }) {
  const [d, setD] = useState<(InspDetail & { report: string }) | null>(null)
  const [report, setReport] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const role = who === 'tenant' ? 'locatario' : 'proprietario'

  const load = useCallback(async () => {
    try {
      setD(await work.clientInspection(who, id))
    } catch (e) {
      setError(message(e))
    }
  }, [who, id])

  useEffect(() => {
    load()
  }, [load])

  async function sign(e: FormEvent) {
    e.preventDefault()
    setError('')
    try {
      await work.clientSign(who, id, name)
      await load()
    } catch (err) {
      setError(message(err))
    }
  }

  if (!d) return error ? <Alert>{error}</Alert> : <Loading label="Carregando…" />
  const alreadySigned = d.signatures.some((s) => s.role === role)

  return (
    <>
      <div className="page-head no-print">
        <button className="back-btn" onClick={onBack}>← Vistorias</button>
        <h3 style={{ margin: 0 }}>Vistoria de {INSP_TYPE[d.inspection.type].toLowerCase()} — {d.inspection.property_name} · {d.inspection.unit_identifier}</h3>
        <button onClick={() => setReport(true)}>Ver laudo</button>
      </div>
      {error && <Alert className="no-print">{error}</Alert>}
      {report && <ReportPaper report={d.report} onClose={() => setReport(false)} />}
      <div className="panel no-print">
        <p className="muted small">Realizada em {date(d.inspection.performed_at ?? '')}.</p>
        <ReadOnlyChecklist items={d.items} />
      </div>
      <h3 className="no-print">Registro de ciência</h3>
      <div className="panel no-print stack">
        <Signatures list={d.signatures} />
        {alreadySigned ? (
          <p className="muted small">Você já registrou ciência desta vistoria.</p>
        ) : (
          <form className="inline" onSubmit={sign}>
            <input aria-label="Seu nome completo" placeholder="Seu nome completo" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required />
            <button type="submit" className="primary">Confirmar que li o laudo</button>
          </form>
        )}
        <p className="muted small">{SIGN_NOTE}</p>
      </div>
    </>
  )
}
