import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  api,
  type DocFull,
  type DocSummary,
  type Item,
  type LeaseDetail,
  type LeaseStatus,
  type LeaseSummary,
  type Template,
} from './api'
import { brl, date, dateTime, parseReais } from './format'
import MaskedInput from './MaskedInput'
import { moneyFromCents } from './masks'
import { Alert, Toast, Loading, ask } from './feedback'
import Modal from './Modal'

const message = (e: unknown) => (e instanceof Error ? e.message : 'Erro inesperado')

const STATUS_LABEL: Record<LeaseStatus, string> = {
  rascunho: 'Rascunho',
  vigente: 'Vigente',
  encerrado: 'Encerrado',
  rescindido: 'Rescindido',
}

function Badge({ status }: { status: LeaseStatus }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABEL[status]}</span>
}

type View = { kind: 'list' } | { kind: 'form'; id?: number } | { kind: 'detail'; id: number }

export default function LeasesPage({ isAdmin }: { isAdmin: boolean }) {
  const [view, setView] = useState<View>({ kind: 'list' })
  const [version, setVersion] = useState(0)
  /** Fecha o modal e recarrega a lista (o contrato pode ter mudado de situação). */
  const close = () => {
    setView({ kind: 'list' })
    setVersion((v) => v + 1)
  }
  return (
    <>
      <LeaseList key={version} onOpen={(id) => setView({ kind: 'detail', id })} onNew={() => setView({ kind: 'form' })} />
      {view.kind === 'form' && (
        <Modal size="lg" onClose={() => (view.id ? setView({ kind: 'detail', id: view.id }) : close())}>
          <LeaseForm id={view.id} onDone={(id) => setView({ kind: 'detail', id })} onCancel={() => (view.id ? setView({ kind: 'detail', id: view.id }) : close())} />
        </Modal>
      )}
      {view.kind === 'detail' && (
        <Modal size="xl" onClose={close}>
          <LeaseDetailView id={view.id} isAdmin={isAdmin} onBack={close} onEdit={() => setView({ kind: 'form', id: view.id })} />
        </Modal>
      )}
    </>
  )
}

// ------------------------------------------------------------------ Lista

function LeaseList({ onOpen, onNew }: { onOpen: (id: number) => void; onNew: () => void }) {
  const [items, setItems] = useState<LeaseSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<'todos' | LeaseStatus>('todos')

  useEffect(() => {
    api
      .leases()
      .then((r) => setItems(r.items))
      .catch((e) => setError(message(e)))
      .finally(() => setLoading(false))
  }, [])

  const visible = filter === 'todos' ? items : items.filter((i) => i.status === filter)

  return (
    <section>
      <div className="page-head">
        <h2>Contratos</h2>
        <select aria-label="Filtrar por situação" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="todos">Todos</option>
          {(Object.keys(STATUS_LABEL) as LeaseStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <button className="primary" onClick={onNew}>
          Novo contrato
        </button>
      </div>
      {error && <Alert>{error}</Alert>}
      {loading ? (
        <Loading label="Carregando…" />
      ) : visible.length === 0 ? (
        <p className="empty">{items.length === 0 ? 'Nenhum contrato cadastrado ainda.' : 'Nenhum contrato nesta situação.'}</p>
      ) : (
        <div className="panel table-wrap">
          <table>
            <thead>
              <tr>
                <th>Imóvel / unidade</th>
                <th>Locatários</th>
                <th>Período</th>
                <th>Aluguel</th>
                <th>Situação</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((l) => (
                <tr key={l.id} className="clickable" onClick={() => onOpen(l.id)}>
                  <td>
                    {l.property_name} · {l.unit_identifier}
                  </td>
                  <td>{l.tenant_names ?? '—'}</td>
                  <td>
                    {date(l.start_date)} a {date(l.end_date)}
                  </td>
                  <td>{brl(l.rent_cents)}</td>
                  <td>
                    <Badge status={l.status} />
                  </td>
                  <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => onOpen(l.id)}>Abrir</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// ------------------------------------------------------------------ Formulário

function LeaseForm({ id, onDone, onCancel }: { id?: number; onDone: (id: number) => void; onCancel: () => void }) {
  const [units, setUnits] = useState<Item[]>([])
  const [properties, setProperties] = useState<Item[]>([])
  const [tenants, setTenants] = useState<Item[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [unitId, setUnitId] = useState('')
  const [tenantIds, setTenantIds] = useState<number[]>([])
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [rent, setRent] = useState('')
  const [dueDay, setDueDay] = useState('5')
  const [guarantee, setGuarantee] = useState('')
  const [notes, setNotes] = useState('')

  useEffect(() => {
    async function load() {
      try {
        const [u, p, t] = await Promise.all([api.list('units'), api.list('properties'), api.list('tenants')])
        setUnits(u.items)
        setProperties(p.items)
        setTenants(t.items)
        if (id) {
          const d = await api.lease(id)
          setUnitId(String(d.lease.unit_id))
          setTenantIds(d.tenants.map((x) => x.id))
          setStart(d.lease.start_date)
          setEnd(d.lease.end_date)
          setRent(moneyFromCents(d.lease.rent_cents))
          setDueDay(String(d.lease.due_day))
          setGuarantee(d.lease.guarantee ?? '')
          setNotes(d.lease.notes ?? '')
        }
      } catch (e) {
        setError(message(e))
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [id])

  const propertyName = (pid: unknown) => String(properties.find((p) => p.id === pid)?.name ?? '?')

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    const cents = parseReais(rent)
    if (cents === null) {
      setError('Informe um valor de aluguel válido (ex.: 1.500,00).')
      return
    }
    if (tenantIds.length === 0) {
      setError('Selecione ao menos um locatário.')
      return
    }
    const input = {
      unit_id: Number(unitId),
      start_date: start,
      end_date: end,
      rent_cents: cents,
      due_day: Number(dueDay),
      guarantee: guarantee.trim() || null,
      notes: notes.trim() || null,
      tenantIds,
    }
    try {
      const r = id ? await api.updateLease(id, input) : await api.createLease(input)
      onDone(r.lease.id)
    } catch (err) {
      setError(message(err))
    }
  }

  const toggleTenant = (tid: number) =>
    setTenantIds((cur) => (cur.includes(tid) ? cur.filter((x) => x !== tid) : [...cur, tid]))

  if (loading) return <Loading label="Carregando…" />

  return (
    <section>
      <div className="page-head">
        <h2>{id ? 'Editar contrato' : 'Novo contrato'}</h2>
      </div>
      {units.length === 0 || tenants.length === 0 ? (
        <div className="panel">
          <p className="empty">
            Para criar um contrato é preciso ter ao menos uma <strong>unidade</strong> e um <strong>inquilino</strong> cadastrados.
          </p>
          <div className="actions">
            <button onClick={onCancel}>Voltar</button>
          </div>
        </div>
      ) : (
        <form className="panel form-grid" onSubmit={submit}>
          <label>
            Unidade
            <select value={unitId} onChange={(e) => setUnitId(e.target.value)} required>
              <option value="">Selecione</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {propertyName(u.property_id)} · {String(u.identifier)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Aluguel (R$)
            <MaskedInput kind="money" value={rent} onValue={setRent} placeholder="1.500,00" required />
          </label>
          <label>
            Início
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} required />
          </label>
          <label>
            Término
            <input type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} required />
          </label>
          <label>
            Dia do vencimento
            <input type="number" min={1} max={31} value={dueDay} onChange={(e) => setDueDay(e.target.value)} required />
          </label>
          <label>
            Garantia
            <input value={guarantee} onChange={(e) => setGuarantee(e.target.value)} maxLength={500} placeholder="Ex.: caução de três aluguéis" />
          </label>
          <fieldset className="span-all">
            <legend>Locatários (o primeiro marcado é o principal)</legend>
            <div className="checks">
              {tenants.map((t) => (
                <label key={t.id} className="check">
                  <input type="checkbox" checked={tenantIds.includes(t.id)} onChange={() => toggleTenant(t.id)} />
                  {String(t.name)} <span className="muted">({String(t.document)})</span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className="span-all">
            Observações
            <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
          </label>
          {error && <Alert className="span-all">{error}</Alert>}
          <div className="actions">
            <button type="button" onClick={onCancel}>
              Cancelar
            </button>
            <button type="submit" className="primary">
              Salvar
            </button>
          </div>
        </form>
      )}
      {error && (units.length === 0 || tenants.length === 0) && <Alert>{error}</Alert>}
    </section>
  )
}

// --------------------------------------------------------------------- Detalhe

function LeaseDetailView({ id, isAdmin, onBack, onEdit }: { id: number; isAdmin: boolean; onBack: () => void; onEdit: () => void }) {
  const [detail, setDetail] = useState<LeaseDetail | null>(null)
  const [templates, setTemplates] = useState<Template[]>([])
  const [docs, setDocs] = useState<DocSummary[]>([])
  const [templateId, setTemplateId] = useState('')
  const [preview, setPreview] = useState<{ content: string; title: string; saved?: boolean } | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    try {
      const [d, t, dc] = await Promise.all([api.lease(id), api.templates(), api.documents(id)])
      setDetail(d)
      setTemplates(t.items)
      setDocs(dc.items)
    } catch (e) {
      setError(message(e))
    }
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  async function run(action: () => Promise<void>) {
    setError('')
    setNotice('')
    try {
      await action()
    } catch (e) {
      setError(message(e))
    }
  }

  const changeStatus = async (status: LeaseStatus, confirmText?: string) => {
    if (confirmText && !(await ask(confirmText))) return
    return run(async () => {
      await api.setLeaseStatus(id, status)
      await load()
    })
  }

  const remove = async () => {
    if (!(await ask('Excluir este rascunho? Esta ação não pode ser desfeita.'))) return
    return run(async () => {
      await api.removeLease(id)
      onBack()
    })
  }

  const doPreview = () =>
    run(async () => {
      const r = await api.previewDocument(id, Number(templateId))
      setPreview({ content: r.content, title: `${r.template.name} (v${r.template.version}) — pré-visualização` })
    })

  const doGenerate = () =>
    run(async () => {
      await api.generateDocument(id, Number(templateId))
      setPreview(null)
      setNotice('Documento emitido e guardado no histórico.')
      await load()
    })

  const openDoc = (docId: number) =>
    run(async () => {
      const r = await api.document(docId)
      const d: DocFull = r.document
      setPreview({ content: d.content, title: `${d.template_name} (v${d.template_version}) — emitido em ${dateTime(d.created_at)}`, saved: true })
    })

  if (!detail) return error ? <Alert>{error}</Alert> : <Loading label="Carregando…" />
  const { lease, tenants, unit } = detail

  return (
    <section>
      <div className="page-head no-print">
        <button className="back-btn" onClick={onBack}>← Contratos</button>
        <h2>
          {unit.property_name} · {unit.identifier}
        </h2>
        <Badge status={lease.status} />
      </div>
      {error && <Alert className="no-print">{error}</Alert>}
      {notice && <Toast>{notice}</Toast>}

      <div className="panel no-print">
        <dl className="facts">
          <div><dt>Período</dt><dd>{date(lease.start_date)} a {date(lease.end_date)}</dd></div>
          <div><dt>Aluguel</dt><dd>{brl(lease.rent_cents)}</dd></div>
          <div><dt>Vencimento</dt><dd>dia {lease.due_day}</dd></div>
          <div><dt>Garantia</dt><dd>{lease.guarantee ?? '—'}</dd></div>
          <div className="span-all"><dt>Locatários</dt><dd>{tenants.map((t) => `${t.name} (${t.document})`).join('; ')}</dd></div>
          {lease.notes && <div className="span-all"><dt>Observações</dt><dd>{lease.notes}</dd></div>}
        </dl>
        <div className="actions left">
          {lease.status === 'rascunho' && (
            <>
              <button onClick={onEdit}>Editar</button>
              <button className="primary" onClick={() => changeStatus('vigente')}>Ativar contrato</button>
              {isAdmin && <button className="danger" onClick={remove}>Excluir rascunho</button>}
            </>
          )}
          {lease.status === 'vigente' && (
            <>
              <button onClick={() => changeStatus('encerrado', 'Encerrar este contrato ao término normal do prazo?')}>Encerrar</button>
              <button className="danger" onClick={() => changeStatus('rescindido', 'Rescindir este contrato? A unidade ficará disponível.')}>Rescindir</button>
            </>
          )}
        </div>
      </div>

      <div className="panel no-print stack">
        <h3>Gerar documento</h3>
        {templates.length === 0 ? (
          <p className="muted">Cadastre um modelo de contrato em “Modelos” para gerar o documento.</p>
        ) : (
          <div className="inline">
            <select aria-label="Modelo" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">Escolha um modelo</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} (v{t.version})
                </option>
              ))}
            </select>
            <button disabled={!templateId} onClick={doPreview}>Pré-visualizar</button>
          </div>
        )}
        <p className="muted small">
          O documento emitido guarda o texto e os dados deste momento; alterações posteriores no cadastro não o modificam. O sistema não presume a validade jurídica das cláusulas.
        </p>
      </div>

      {preview && (
        <div className="panel print-area">
          <div className="paper-head no-print">
            <strong>{preview.title}</strong>
            <div className="actions">
              <button onClick={() => setPreview(null)}>Fechar</button>
              <button onClick={() => window.print()}>Imprimir / salvar PDF</button>
              {!preview.saved && <button className="primary" onClick={doGenerate}>Emitir e guardar</button>}
            </div>
          </div>
          <article className="paper">{preview.content}</article>
        </div>
      )}

      <div className="no-print">
        <h3>Documentos emitidos</h3>
        {docs.length === 0 ? (
          <p className="empty">Nenhum documento emitido para este contrato.</p>
        ) : (
          <div className="panel table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Modelo</th>
                  <th>Emitido em</th>
                  <th>Por</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id}>
                    <td>{d.template_name} (v{d.template_version})</td>
                    <td>{dateTime(d.created_at)}</td>
                    <td>{d.generated_by_name ?? '—'}</td>
                    <td className="row-actions">
                      <button onClick={() => openDoc(d.id)}>Abrir</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}
