import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, type Item } from './api'
import { work, type Condition, type InspCompare, type InspDetail, type InspSignature, type InspStatus, type InspSummary, type InspType } from './workApi'
import { CONDITION, CONDITIONS, INSP_STATUS, INSP_TYPE, ROLE_NAME, SIGN_NOTE, groupByRoom } from './labels'
import { date } from './format'
import PhotoStrip from './PhotoStrip'
import { ReadOnlyChecklist, ReportPaper, Signatures } from './InspectionView'

const message = (e: unknown) => (e instanceof Error ? e.message : 'Erro inesperado')
const today = () => new Date().toLocaleDateString('sv-SE')

type View = { kind: 'list' } | { kind: 'new' } | { kind: 'detail'; id: number }

export default function InspectionsPage() {
  const [view, setView] = useState<View>({ kind: 'list' })
  if (view.kind === 'new') return <NewInspection onDone={(id) => setView({ kind: 'detail', id })} onCancel={() => setView({ kind: 'list' })} />
  if (view.kind === 'detail') return <InspectionDetail id={view.id} onBack={() => setView({ kind: 'list' })} />
  return <List onOpen={(id) => setView({ kind: 'detail', id })} onNew={() => setView({ kind: 'new' })} />
}

// ----------------------------------------------------------------------- Lista

function List({ onOpen, onNew }: { onOpen: (id: number) => void; onNew: () => void }) {
  const [items, setItems] = useState<InspSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [type, setType] = useState('')
  const [status, setStatus] = useState('')

  useEffect(() => {
    const q = [type && `type=${type}`, status && `status=${status}`].filter(Boolean).join('&')
    work
      .inspections(q)
      .then((r) => setItems(r.items))
      .catch((e) => setError(message(e)))
      .finally(() => setLoading(false))
  }, [type, status])

  return (
    <section>
      <div className="page-head">
        <h2>Vistorias</h2>
        <select aria-label="Tipo" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">Todos os tipos</option>
          {(Object.keys(INSP_TYPE) as InspType[]).map((t) => <option key={t} value={t}>{INSP_TYPE[t]}</option>)}
        </select>
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todos os status</option>
          {(Object.keys(INSP_STATUS) as InspStatus[]).map((s) => <option key={s} value={s}>{INSP_STATUS[s]}</option>)}
        </select>
        <button className="primary" onClick={onNew}>Nova vistoria</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {loading ? (
        <p className="muted">Carregando…</p>
      ) : items.length === 0 ? (
        <p className="empty">Nenhuma vistoria encontrada.</p>
      ) : (
        <div className="panel table-wrap">
          <table>
            <thead><tr><th>Tipo</th><th>Imóvel / unidade</th><th>Data</th><th>Checklist</th><th>Status</th><th /></tr></thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td>{INSP_TYPE[i.type]}</td>
                  <td>{i.property_name} · {i.unit_identifier}</td>
                  <td>{date(i.performed_at ?? i.scheduled_for)}</td>
                  <td>{i.items_done}/{i.items_total}</td>
                  <td><span className={`badge badge-i-${i.status}`}>{INSP_STATUS[i.status]}</span></td>
                  <td className="row-actions"><button onClick={() => onOpen(i.id)}>Abrir</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------- Nova vistoria

function NewInspection({ onDone, onCancel }: { onDone: (id: number) => void; onCancel: () => void }) {
  const [units, setUnits] = useState<Item[]>([])
  const [properties, setProperties] = useState<Item[]>([])
  const [form, setForm] = useState({ unit_id: '', type: 'entrada', scheduled_for: today(), notes: '' })
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
      const r = await work.createInspection({ ...form, unit_id: Number(form.unit_id), notes: form.notes.trim() || null })
      onDone(r.id)
    } catch (err) {
      setError(message(err))
    }
  }

  return (
    <section>
      <div className="page-head"><h2>Nova vistoria</h2></div>
      <form className="panel form-grid" onSubmit={submit}>
        <label>Unidade
          <select value={form.unit_id} onChange={(e) => setForm({ ...form, unit_id: e.target.value })} required>
            <option value="">Selecione</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>{String(properties.find((p) => p.id === u.property_id)?.name ?? '?')} · {String(u.identifier)}</option>
            ))}
          </select>
        </label>
        <label>Tipo
          <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            {(Object.keys(INSP_TYPE) as InspType[]).map((t) => <option key={t} value={t}>{INSP_TYPE[t]}</option>)}
          </select>
        </label>
        <label>Data prevista<input type="date" value={form.scheduled_for} onChange={(e) => setForm({ ...form, scheduled_for: e.target.value })} required /></label>
        <label className="span-all">Observações gerais (opcional)
          <textarea rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} maxLength={2000} />
        </label>
        <p className="muted small span-all">
          O checklist padrão (sala, cozinha, banheiro, quarto, área de serviço e geral) é criado automaticamente; você pode ajustar os itens depois.
        </p>
        {error && <p className="error span-all" role="alert">{error}</p>}
        <div className="actions">
          <button type="button" onClick={onCancel}>Cancelar</button>
          <button type="submit" className="primary">Criar vistoria</button>
        </div>
      </form>
    </section>
  )
}

// ---------------------------------------------------------------------- Detalhe

function InspectionDetail({ id, onBack }: { id: number; onBack: () => void }) {
  const [d, setD] = useState<InspDetail | null>(null)
  const [error, setError] = useState('')
  const [report, setReport] = useState<string | null>(null)
  const [newRoom, setNewRoom] = useState('')
  const [newItem, setNewItem] = useState('')
  const [others, setOthers] = useState<InspSummary[]>([])
  const [compare, setCompare] = useState<InspCompare | null>(null)

  const load = useCallback(async () => {
    try {
      setD(await work.inspection(id))
    } catch (e) {
      setError(message(e))
    }
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  const unitId = d?.inspection.unit_id
  const isDone = d?.inspection.status === 'concluida'
  useEffect(() => {
    if (unitId && isDone) {
      work
        .inspections(`unit_id=${unitId}&status=concluida`)
        .then((r) => setOthers(r.items.filter((i) => i.id !== id)))
        .catch(() => {})
    }
  }, [unitId, isDone, id])

  async function run(action: () => Promise<unknown>) {
    setError('')
    try {
      await action()
      await load()
    } catch (e) {
      setError(message(e))
    }
  }

  if (!d) return error ? <p className="error" role="alert">{error}</p> : <p className="muted">Carregando…</p>
  const { inspection: insp, items, signatures } = d
  const open = insp.status === 'agendada' || insp.status === 'em_andamento'
  const done = items.filter((i) => i.condition).length
  const pct = items.length ? Math.round((done / items.length) * 100) : 0
  const signed = new Set(signatures.map((s) => s.role))

  function conclude() {
    const performed = window.prompt('Data em que a vistoria foi realizada (AAAA-MM-DD):', today())
    if (performed === null) return
    return run(() => work.setInspectionStatus(id, 'concluida', performed.trim() || undefined))
  }

  function sign(role: InspSignature['role']) {
    const name = window.prompt(`Nome completo de quem registra a ciência (${ROLE_NAME[role]}):`)
    if (!name?.trim()) return
    return run(() => work.signInspection(id, role, name.trim()))
  }

  async function showReport() {
    try {
      setReport((await work.inspectionReport(id)).report)
    } catch (e) {
      setError(message(e))
    }
  }

  async function runCompare(otherId: string) {
    if (!otherId) return setCompare(null)
    try {
      // Sempre da mais antiga para a mais recente (ex.: entrada → saída).
      const other = others.find((o) => o.id === Number(otherId))!
      const a = (other.performed_at ?? '') < (insp.performed_at ?? '') ? other.id : id
      const b = a === id ? other.id : id
      setCompare(await work.compareInspections(a, b))
    } catch (e) {
      setError(message(e))
    }
  }

  const rooms = [...new Set(items.map((i) => i.room))]

  return (
    <section>
      <div className="page-head no-print">
        <button onClick={onBack}>← Vistorias</button>
        <h2>Vistoria de {INSP_TYPE[insp.type].toLowerCase()} — {insp.property_name} · {insp.unit_identifier}</h2>
        <span className={`badge badge-i-${insp.status}`}>{INSP_STATUS[insp.status]}</span>
      </div>
      {error && <p className="error no-print" role="alert">{error}</p>}

      {report !== null && <ReportPaper report={report} onClose={() => setReport(null)} />}

      <div className="panel no-print">
        <dl className="facts">
          <div><dt>Data</dt><dd>{date(insp.performed_at ?? insp.scheduled_for)}{!insp.performed_at && ' (prevista)'}</dd></div>
          <div><dt>Responsável</dt><dd>{insp.inspector_name ?? '—'}</dd></div>
          {insp.notes && <div className="span-all"><dt>Observações</dt><dd>{insp.notes}</dd></div>}
          <div className="span-all">
            <dt>Checklist: {done}/{items.length} itens avaliados</dt>
            <dd><div className="progress" aria-label={`${pct}% avaliado`}><span style={{ width: `${pct}%` }} /></div></dd>
          </div>
        </dl>
        <div className="actions left">
          {insp.status === 'agendada' && <button className="primary" onClick={() => run(() => work.setInspectionStatus(id, 'em_andamento'))}>Iniciar vistoria</button>}
          {insp.status === 'em_andamento' && <button className="primary" onClick={conclude}>Concluir vistoria</button>}
          {open && <button className="danger" onClick={() => window.confirm('Cancelar esta vistoria?') && run(() => work.setInspectionStatus(id, 'cancelada'))}>Cancelar</button>}
          {isDone && <button onClick={showReport}>Ver laudo</button>}
        </div>
        {open && <p className="muted small">Depois de concluída, a vistoria não pode mais ser alterada.</p>}
      </div>

      <div className="panel no-print">
        {open ? (
          <>
            {groupByRoom(items).map(([room, list]) => (
              <div key={room}>
                <h4 className="room">{room}</h4>
                {list.map((it) => (
                  <div key={it.id} className="check-row">
                    <span>{it.item}</span>
                    <select
                      aria-label={`Condição de ${room} — ${it.item}`}
                      value={it.condition ?? ''}
                      onChange={(e) => run(() => work.patchItem(id, it.id, { condition: (e.target.value || null) as Condition | null }))}
                    >
                      <option value="">Avaliar…</option>
                      {CONDITIONS.map((c) => <option key={c} value={c}>{CONDITION[c]}</option>)}
                    </select>
                    <input
                      aria-label={`Observação de ${room} — ${it.item}`}
                      placeholder="Observação"
                      defaultValue={it.notes ?? ''}
                      maxLength={1000}
                      onBlur={(e) => e.target.value !== (it.notes ?? '') && run(() => work.patchItem(id, it.id, { notes: e.target.value || null }))}
                    />
                    <PhotoStrip
                      ids={it.photos}
                      label="Foto"
                      onUpload={async (blob) => { await work.uploadPhoto(`/api/inspections/${id}/items/${it.id}/photos`, blob); await load() }}
                      onDelete={async (pid) => { await work.deletePhoto(pid); await load() }}
                    />
                    <button type="button" className="danger" style={{ gridColumn: '1 / -1', justifySelf: 'start' }} onClick={() => run(() => work.removeItem(id, it.id))}>Remover item</button>
                  </div>
                ))}
              </div>
            ))}
            <form
              className="inline"
              style={{ marginTop: '1rem' }}
              onSubmit={(e) => { e.preventDefault(); run(() => work.addItem(id, newRoom, newItem)).then(() => setNewItem('')) }}
            >
              <input list="rooms" aria-label="Ambiente" placeholder="Ambiente" value={newRoom} onChange={(e) => setNewRoom(e.target.value)} required />
              <datalist id="rooms">{rooms.map((r) => <option key={r} value={r} />)}</datalist>
              <input aria-label="Item" placeholder="Novo item" value={newItem} onChange={(e) => setNewItem(e.target.value)} required />
              <button type="submit">Adicionar item</button>
            </form>
          </>
        ) : (
          <ReadOnlyChecklist items={items} />
        )}
      </div>

      {isDone && (
        <>
          <h3 className="no-print">Registro de ciência</h3>
          <div className="panel no-print stack">
            <Signatures list={signatures} />
            <div className="inline">
              {(['vistoriador', 'locatario', 'proprietario'] as const).filter((r) => !signed.has(r)).map((r) => (
                <button key={r} onClick={() => sign(r)}>Registrar ciência: {ROLE_NAME[r]}</button>
              ))}
            </div>
            <p className="muted small">{SIGN_NOTE} O locatário e o proprietário também podem registrar pela área do cliente.</p>
          </div>

          <h3 className="no-print">Comparar com outra vistoria</h3>
          <div className="panel no-print stack">
            {others.length === 0 ? (
              <p className="muted">Não há outra vistoria concluída para esta unidade.</p>
            ) : (
              <select aria-label="Comparar com" defaultValue="" onChange={(e) => runCompare(e.target.value)}>
                <option value="">Escolha a vistoria…</option>
                {others.map((o) => <option key={o.id} value={o.id}>{INSP_TYPE[o.type]} — {date(o.performed_at ?? o.scheduled_for)}</option>)}
              </select>
            )}
            {compare && <CompareTable cmp={compare} />}
          </div>
        </>
      )}
    </section>
  )
}

function CompareTable({ cmp }: { cmp: InspCompare }) {
  const cond = (c: Condition | null | undefined) => (c ? CONDITION[c] : '—')
  const changed = cmp.items.filter((i) => i.change !== 'igual')
  return (
    <>
      <p>
        {INSP_TYPE[cmp.first.type]} ({date(cmp.first.performed_at ?? '')}) → {INSP_TYPE[cmp.second.type]} ({date(cmp.second.performed_at ?? '')}):{' '}
        <strong className="cond-ruim">{cmp.summary.piorou} piorou</strong> · <strong className="cond-bom">{cmp.summary.melhorou} melhorou</strong> · {cmp.summary.igual} igual
      </p>
      {changed.length === 0 ? (
        <p className="muted">Nenhuma diferença entre as vistorias.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Ambiente</th><th>Item</th><th>Antes</th><th>Depois</th></tr></thead>
            <tbody>
              {changed.map((i) => (
                <tr key={`${i.room}-${i.item}`} className={`change-${i.change}`}>
                  <td>{i.room}</td><td>{i.item}</td><td>{cond(i.first?.condition)}</td><td>{cond(i.second?.condition)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
