import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { prepareImage } from './photos'
import { request } from './api'
import { Alert, Empty, Loading, ask, errorText, toast } from './feedback'
import { date, dateTime } from './format'
import MaskedInput, { maskWarning } from './MaskedInput'
import Modal from './Modal'

/**
 * Moradores e controle de acesso (visitantes), usados pela equipe (`staff`) e pelo inquilino (`tenant`).
 * As rotas mudam só no prefixo: /api/... (equipe) e /api/portal/tenant/... (inquilino).
 */

export type Mode = 'staff' | 'tenant'
export interface LeaseOption { lease_id: number; unit_id: number; label: string }

const json = (method: string, body?: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
const prefix = (mode: Mode) => (mode === 'staff' ? '/api' : '/api/portal/tenant')
const todayIso = () => new Date().toLocaleDateString('sv-SE')
const d10 = (v: string | null | undefined) => (v ? v.slice(0, 10) : '')

export const RELATIONSHIPS: [string, string][] = [
  ['conjuge', 'Cônjuge / companheiro(a)'],
  ['filho', 'Filho(a)'],
  ['pai_mae', 'Pai / mãe'],
  ['irmao', 'Irmão(ã)'],
  ['parente', 'Outro parente'],
  ['agregado', 'Agregado / amigo(a)'],
  ['empregado', 'Funcionário(a) doméstico(a)'],
  ['outro', 'Outro'],
]
const REL_LABEL = Object.fromEntries(RELATIONSHIPS) as Record<string, string>
export const VISITOR_CATEGORIES: [string, string][] = [
  ['visitante', 'Visitante'],
  ['familiar', 'Familiar'],
  ['prestador', 'Prestador de serviço'],
  ['entregador', 'Entregador'],
  ['outro', 'Outro'],
]
const CAT_LABEL = Object.fromEntries(VISITOR_CATEGORIES) as Record<string, string>
const PHASE_LABEL: Record<string, string> = { valido: 'Válido hoje', agendado: 'Agendado', expirado: 'Vencido', cancelado: 'Cancelado', bloqueado: 'Bloqueado' }

/** Contratos vigentes que a pessoa pode usar (equipe: todos; inquilino: os seus). */
export function useLeaseOptions(mode: Mode): LeaseOption[] {
  const [opts, setOpts] = useState<LeaseOption[]>([])
  useEffect(() => {
    if (mode === 'staff') {
      request<{ items: { id: number; unit_id: number; status: string; unit_identifier: string; property_name: string; tenant_names: string }[] }>('/api/leases')
        .then((r) => setOpts(r.items.filter((l) => l.status === 'vigente').map((l) => ({ lease_id: l.id, unit_id: l.unit_id, label: `${l.property_name} · ${l.unit_identifier} — ${l.tenant_names}` }))))
        .catch(() => setOpts([]))
    } else {
      request<{ items: { id: number; status: string; unit_identifier: string; property_name: string }[] }>('/api/portal/tenant/leases')
        .then((r) => setOpts(r.items.filter((l) => l.status === 'vigente').map((l) => ({ lease_id: l.id, unit_id: 0, label: `${l.property_name} · ${l.unit_identifier}` }))))
        .catch(() => setOpts([]))
    }
  }, [mode])
  return opts
}

function LeaseSelect({ options, value, onChange }: { options: LeaseOption[]; value: number; onChange: (n: number) => void }) {
  if (options.length === 1) return null
  return (
    <label className="wide">
      Unidade / contrato
      <select value={value} onChange={(e) => onChange(Number(e.target.value))} required>
        {options.map((o) => (
          <option key={o.lease_id} value={o.lease_id}>{o.label}</option>
        ))}
      </select>
    </label>
  )
}

// ================================================================== Moradores

interface Resident {
  id: number
  lease_id: number
  name: string
  relationship: string
  document: string | null
  birth_date: string | null
  phone: string | null
  email: string | null
  notes: string | null
  moved_in_at: string | null
  moved_out_at: string | null
  unit_identifier: string
  property_name: string
}
interface Holder { lease_id: number; tenant_id: number; name: string; document: string | null; phone: string | null; email: string | null; unit_identifier: string; property_name: string }

function ageOf(birth: string | null): string {
  if (!birth) return ''
  const b = new Date(birth.slice(0, 10) + 'T00:00:00')
  const n = new Date()
  let years = n.getFullYear() - b.getFullYear()
  if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) years--
  return years >= 0 ? `${years} ano${years === 1 ? '' : 's'}` : ''
}

export function ResidentsPanel({ mode, options }: { mode: Mode; options: LeaseOption[] }) {
  const [items, setItems] = useState<Resident[]>([])
  const [holders, setHolders] = useState<Holder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Resident | 'new' | null>(null)
  const [showOut, setShowOut] = useState(false)
  const [q, setQ] = useState('')
  const [tick, setTick] = useState(0)
  const reload = () => setTick((t) => t + 1)

  useEffect(() => {
    setLoading(true)
    request<{ items: Resident[]; holders: Holder[] }>(`${prefix(mode)}/residents${showOut && mode === 'staff' ? '?scope=todos' : ''}`)
      .then((r) => {
        setItems(r.items)
        setHolders(r.holders)
        setError('')
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setLoading(false))
  }, [mode, showOut, tick])

  async function moveOut(r: Resident) {
    if (!(await ask(`Registrar a saída de ${r.name}? O cadastro fica no histórico, sem poder ser editado.`))) return
    try {
      await request(`${prefix(mode)}/residents/${r.id}/move-out`, json('POST', {}))
      toast.success('Saída registrada.')
      reload()
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  const needle = q.trim().toLowerCase()
  const match = (s: string) => !needle || s.toLowerCase().includes(needle)
  const shown = items.filter((r) => match(`${r.name} ${r.unit_identifier} ${r.property_name} ${r.document ?? ''}`))
  const shownHolders = holders.filter((h) => match(`${h.name} ${h.unit_identifier} ${h.property_name}`))

  return (
    <>
      <div className="toolbar">
        <input type="search" aria-label="Buscar morador" placeholder="Buscar por nome, unidade ou documento" value={q} onChange={(e) => setQ(e.target.value)} />
        {mode === 'staff' && <label className="check"><input type="checkbox" checked={showOut} onChange={(e) => setShowOut(e.target.checked)} /> Mostrar quem já saiu</label>}
        <span className="spacer" />
        <button className="primary" onClick={() => setEditing('new')} disabled={options.length === 0}>Cadastrar morador</button>
      </div>
      {error && <Alert>{error}</Alert>}
      {editing && (
        <ResidentForm
          mode={mode}
          options={options}
          resident={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null)
            reload()
          }}
        />
      )}
      {loading ? (
        <Loading label="Carregando…" />
      ) : shown.length === 0 && shownHolders.length === 0 ? (
        <Empty title="Nenhum morador">Cadastre quem mora na unidade além dos locatários: cônjuge, filhos, parentes e funcionários.</Empty>
      ) : (
        <div className="panel table-wrap">
          <table>
            <thead>
              <tr><th>Nome</th><th>Relação</th><th>Unidade</th><th>Contato</th><th /></tr>
            </thead>
            <tbody>
              {shownHolders.map((h) => (
                <tr key={`h${h.lease_id}-${h.tenant_id}`}>
                  <td>{h.name}</td>
                  <td><span className="badge">Locatário (titular)</span></td>
                  <td>{h.property_name} · {h.unit_identifier}</td>
                  <td className="muted small">{[h.phone, h.email].filter(Boolean).join(' · ') || '—'}</td>
                  <td />
                </tr>
              ))}
              {shown.map((r) => (
                <tr key={r.id} className={r.moved_out_at ? 'muted' : undefined}>
                  <td>
                    {r.name}
                    {r.birth_date && <div className="muted small">{ageOf(r.birth_date)}</div>}
                  </td>
                  <td>{REL_LABEL[r.relationship] ?? r.relationship}{r.moved_out_at && <div className="muted small">saiu em {date(r.moved_out_at)}</div>}</td>
                  <td>{r.property_name} · {r.unit_identifier}</td>
                  <td className="muted small">{[r.phone, r.email].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="row-actions">
                    {!r.moved_out_at && (
                      <>
                        <button onClick={() => setEditing(r)}>Editar</button>
                        <button onClick={() => moveOut(r)}>Registrar saída</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

function ResidentForm({ mode, options, resident, onClose, onDone }: { mode: Mode; options: LeaseOption[]; resident?: Resident; onClose: () => void; onDone: () => void }) {
  const [leaseId, setLeaseId] = useState(resident?.lease_id ?? options[0]?.lease_id ?? 0)
  const [name, setName] = useState(resident?.name ?? '')
  const [relationship, setRelationship] = useState(resident?.relationship ?? 'conjuge')
  const [phone, setPhone] = useState(resident?.phone ?? '')
  const [document, setDocument] = useState(resident?.document ?? '')
  const [email, setEmail] = useState(resident?.email ?? '')
  const [birth, setBirth] = useState(d10(resident?.birth_date))
  const [movedIn, setMovedIn] = useState(d10(resident?.moved_in_at))
  const [notes, setNotes] = useState(resident?.notes ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const body = { name, relationship, phone, document, email, birth_date: birth, moved_in_at: movedIn, notes }
    try {
      if (resident) await request(`${prefix(mode)}/residents/${resident.id}`, json('PUT', body))
      else await request(`${prefix(mode)}/residents`, json('POST', { ...body, lease_id: leaseId }))
      toast.success(resident ? 'Morador atualizado.' : 'Morador cadastrado.')
      onDone()
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <Modal title={resident ? 'Editar morador' : 'Cadastrar morador'} size="md" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="form-grid">
          {!resident && <LeaseSelect options={options} value={leaseId} onChange={setLeaseId} />}
          <label className="wide">
            Nome completo
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
          </label>
          <label>
            Relação com o locatário
            <select value={relationship} onChange={(e) => setRelationship(e.target.value)}>
              {RELATIONSHIPS.map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            Data de nascimento
            <input type="date" value={birth} onChange={(e) => setBirth(e.target.value)} max={todayIso()} />
          </label>
          <label>
            CPF / documento
            <MaskedInput kind="document" value={document} onValue={setDocument} />
            {maskWarning('document', document) && <span className="mask-hint">{maskWarning('document', document)}</span>}
          </label>
          <label>
            Telefone
            <MaskedInput kind="phone" value={phone} onValue={setPhone} />
            {maskWarning('phone', phone) && <span className="mask-hint">{maskWarning('phone', phone)}</span>}
          </label>
          <label>
            E-mail
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} />
          </label>
          <label>
            Mora desde
            <input type="date" value={movedIn} onChange={(e) => setMovedIn(e.target.value)} />
          </label>
          <label className="wide">
            Observações
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} rows={2} />
          </label>
        </div>
        {error && <Alert>{error}</Alert>}
        <div className="actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar'}</button>
        </div>
      </form>
    </Modal>
  )
}

// ================================================================== Visitantes

export interface Visitor {
  id: number
  unit_id: number
  lease_id: number | null
  name: string
  document: string | null
  phone: string | null
  category: string
  vehicle_plate: string | null
  valid_from: string
  valid_until: string
  weekdays: string | null
  time_from: string | null
  time_to: string | null
  expected_time: string | null
  max_stay_minutes: number | null
  has_photo: boolean
  photo_consent_at: string | null
  access_code: string
  status: string
  phase: string
  notes: string | null
  inside: boolean
  last_event_at: string | null
  unit_identifier: string
  property_name: string
  tenant_names: string | null
  created_by_name: string | null
  created_by_role: string | null
}
interface AccessEvent { id: number; event: 'entrada' | 'saida'; at: string; note: string | null; recorded_by_name: string | null }

const phaseBadge = (v: Visitor) => (v.inside ? <span className="badge badge-ok">Dentro agora</span> : <span className={`badge badge-v-${v.phase}`}>{PHASE_LABEL[v.phase] ?? v.phase}</span>)

export function VisitorsPanel({ mode, options }: { mode: Mode; options: LeaseOption[] }) {
  const [items, setItems] = useState<Visitor[]>([])
  const [phase, setPhase] = useState('ativos')
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [form, setForm] = useState<Visitor | 'new' | null>(null)
  const [viewing, setViewing] = useState<Visitor | null>(null)
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    setLoading(true)
    const params = new URLSearchParams()
    if (phase) params.set('phase', phase)
    if (q.trim()) params.set('q', q.trim())
    request<{ items: Visitor[] }>(`${prefix(mode)}/visitors?${params}`)
      .then((r) => {
        setItems(r.items)
        setError('')
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setLoading(false))
  }, [mode, phase, q, tick])

  return (
    <>
      <div className="toolbar">
        <input type="search" aria-label="Buscar visitante" placeholder="Nome, código, placa ou documento" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Filtrar visitantes" value={phase} onChange={(e) => setPhase(e.target.value)}>
          <option value="ativos">Autorizações ativas</option>
          <option value="valido">Válidas hoje</option>
          <option value="agendado">Agendadas</option>
          <option value="encerrados">Encerradas (vencidas, canceladas, bloqueadas)</option>
          <option value="">Todas</option>
        </select>
        <span className="spacer" />
        <button className="primary" onClick={() => setForm('new')} disabled={options.length === 0}>Autorizar visitante</button>
      </div>
      {error && <Alert>{error}</Alert>}
      {form && (
        <VisitorForm
          mode={mode}
          options={options}
          visitor={form === 'new' ? undefined : form}
          onClose={() => setForm(null)}
          onDone={(v) => {
            setForm(null)
            reload()
            if (form === 'new') setViewing(v)
          }}
        />
      )}
      {viewing && <VisitorDetail mode={mode} visitor={viewing} onClose={() => setViewing(null)} onChanged={reload} onEdit={(v) => { setViewing(null); setForm(v) }} />}
      {loading ? (
        <Loading label="Carregando…" />
      ) : items.length === 0 ? (
        <Empty title="Nenhum visitante">{mode === 'tenant' ? 'Autorize quem vai visitar você: a portaria confere o nome ou o código na chegada.' : 'Nenhuma autorização com esse filtro.'}</Empty>
      ) : (
        <div className="panel table-wrap">
          <table>
            <thead>
              <tr><th>Visitante</th><th>Unidade</th><th>Validade</th><th>Código</th><th>Situação</th></tr>
            </thead>
            <tbody>
              {items.map((v) => (
                <tr key={v.id} className="clickable" onClick={() => setViewing(v)}>
                  <td>{v.name}<div className="muted small">{CAT_LABEL[v.category] ?? v.category}{v.vehicle_plate ? ` · ${v.vehicle_plate}` : ''}</div></td>
                  <td>{v.property_name} · {v.unit_identifier}</td>
                  <td>{v.valid_from.slice(0, 10) === v.valid_until.slice(0, 10) ? date(v.valid_from) : `${date(v.valid_from)} a ${date(v.valid_until)}`}</td>
                  <td><code>{v.access_code}</code></td>
                  <td>{phaseBadge(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

function VisitorForm({ mode, options, visitor, onClose, onDone }: { mode: Mode; options: LeaseOption[]; visitor?: Visitor; onClose: () => void; onDone: (v: Visitor) => void }) {
  const [leaseId, setLeaseId] = useState(options[0]?.lease_id ?? 0)
  const [name, setName] = useState(visitor?.name ?? '')
  const [category, setCategory] = useState(visitor?.category ?? 'visitante')
  const [document, setDocument] = useState(visitor?.document ?? '')
  const [phone, setPhone] = useState(visitor?.phone ?? '')
  const [plate, setPlate] = useState(visitor?.vehicle_plate ?? '')
  const [from, setFrom] = useState(d10(visitor?.valid_from) || todayIso())
  const [until, setUntil] = useState(d10(visitor?.valid_until) || todayIso())
  const [notes, setNotes] = useState(visitor?.notes ?? '')
  const [days, setDays] = useState<string[]>(visitor?.weekdays ? visitor.weekdays.split(',') : [])
  const [tFrom, setTFrom] = useState(visitor?.time_from ?? '')
  const [tTo, setTTo] = useState(visitor?.time_to ?? '')
  const [expected, setExpected] = useState(visitor?.expected_time ?? '')
  const [maxStay, setMaxStay] = useState(visitor?.max_stay_minutes ? String(visitor.max_stay_minutes) : '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const body: Record<string, unknown> = {
      name, category, document, phone, vehicle_plate: plate, valid_from: from, valid_until: until, notes,
      weekdays: days, time_from: tFrom || null, time_to: tTo || null, expected_time: expected || null, max_stay_minutes: maxStay ? Number(maxStay) : null,
    }
    try {
      let r: { item: Visitor }
      if (visitor) r = await request(`${prefix(mode)}/visitors/${visitor.id}`, json('PUT', body))
      else if (mode === 'tenant') r = await request(`${prefix(mode)}/visitors`, json('POST', { ...body, lease_id: leaseId }))
      else r = await request(`${prefix(mode)}/visitors`, json('POST', { ...body, unit_id: options.find((o) => o.lease_id === leaseId)?.unit_id }))
      toast.success(visitor ? 'Autorização atualizada.' : 'Visitante autorizado.')
      onDone(r.item)
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <Modal title={visitor ? 'Editar autorização' : 'Autorizar visitante'} size="md" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="form-grid">
          {!visitor && <LeaseSelect options={options} value={leaseId} onChange={setLeaseId} />}
          <label className="wide">
            Nome do visitante
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
          </label>
          <label>
            Tipo
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {VISITOR_CATEGORIES.map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
          </label>
          <label>
            Documento (opcional)
            <MaskedInput kind="document" value={document} onValue={setDocument} />
          </label>
          <label>
            Telefone (opcional)
            <MaskedInput kind="phone" value={phone} onValue={setPhone} />
          </label>
          <label>
            Placa do veículo (opcional)
            <input value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} maxLength={10} placeholder="ABC1D23" />
          </label>
          <label>
            Válido a partir de
            <input
              type="date"
              value={from}
              min={visitor ? undefined : todayIso()}
              onChange={(e) => {
                setFrom(e.target.value)
                if (until < e.target.value) setUntil(e.target.value)
              }}
              required
            />
          </label>
          <label>
            Válido até
            <input type="date" value={until} min={from} onChange={(e) => setUntil(e.target.value)} required />
          </label>
          <label className="wide">
            Observações para a portaria
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} rows={2} />
          </label>
          <fieldset className="mode-pick wide">
            <legend>Visita recorrente (opcional)</legend>
            <div className="inline" role="group" aria-label="Dias da semana">
              {['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'].map((d, i) => (
                <label key={d} className="check">
                  <input type="checkbox" checked={days.includes(String(i))} onChange={(e) => setDays((cur) => (e.target.checked ? [...cur, String(i)] : cur.filter((x) => x !== String(i))))} /> {d}
                </label>
              ))}
            </div>
            <span className="muted small">Nenhum dia marcado = todos os dias do período.</span>
          </fieldset>
          <label>
            Pode entrar a partir de
            <input type="time" value={tFrom} onChange={(e) => setTFrom(e.target.value)} />
          </label>
          <label>
            Pode entrar até
            <input type="time" value={tTo} onChange={(e) => setTTo(e.target.value)} />
          </label>
          <label>
            Hora prevista da chegada
            <input type="time" value={expected} onChange={(e) => setExpected(e.target.value)} />
            <span className="muted small">Avisamos se não chegar até 1 h depois.</span>
          </label>
          <label>
            Permanência máxima (minutos)
            <input type="number" min={10} max={1440} value={maxStay} onChange={(e) => setMaxStay(e.target.value)} placeholder="720" />
            <span className="muted small">Avisamos se passar disso.</span>
          </label>
        </div>
        <p className="muted small">Para uma visita só, deixe as duas datas iguais. Para prestadores (diarista, obra), escolha o período — até 1 ano.</p>
        {error && <Alert>{error}</Alert>}
        <div className="actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar'}</button>
        </div>
      </form>
    </Modal>
  )
}

function VisitorDetail({ mode, visitor, onClose, onChanged, onEdit }: { mode: Mode; visitor: Visitor; onClose: () => void; onChanged: () => void; onEdit: (v: Visitor) => void }) {
  const [v, setV] = useState(visitor)
  const [events, setEvents] = useState<AccessEvent[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const staff = mode === 'staff'

  const loadEvents = useCallback(() => {
    request<{ items: AccessEvent[] }>(`${prefix(mode)}/visitors/${visitor.id}/events`).then((r) => setEvents(r.items)).catch(() => setEvents([]))
  }, [mode, visitor.id])
  useEffect(loadEvents, [loadEvents])

  async function act(path: string, body: unknown, ok: string, confirm?: string) {
    if (confirm && !(await ask(confirm))) return
    setBusy(true)
    setError('')
    try {
      const r = await request<{ item: Visitor }>(`${prefix(mode)}/visitors/${v.id}/${path}`, json('POST', body))
      setV(r.item)
      toast.success(ok)
      onChanged()
      loadEvents()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const active = v.status === 'autorizado'
  const photo = useRef<HTMLInputElement>(null)

  async function sendPhoto(file: File | undefined) {
    if (!file) return
    if (!(await ask('O visitante autorizou ser fotografado? A foto fica privada, só a equipe e o morador responsável a veem, e é apagada 30 dias depois do fim da autorização.', { title: 'Consentimento', confirmLabel: 'Sim, autorizou' }))) return
    setBusy(true)
    setError('')
    try {
      const small = await prepareImage(file, { maxBytes: 900 * 1024, maxSide: 1024 })
      const res = await fetch(`/api/visitors/${v.id}/photo?consent=1`, { method: 'PUT', headers: { 'Content-Type': small.type || 'image/jpeg' }, body: small })
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Não foi possível enviar a foto.')
      setV({ ...v, has_photo: true, photo_consent_at: new Date().toISOString() })
      toast.success('Foto registrada.')
      onChanged()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  async function removePhoto() {
    setBusy(true)
    try {
      await request(`/api/visitors/${v.id}/photo`, { method: 'DELETE' })
      setV({ ...v, has_photo: false, photo_consent_at: null })
      onChanged()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={v.name}
      subtitle={`${v.property_name} · ${v.unit_identifier}`}
      size="md"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Fechar</button>
          {active && !v.inside && <button onClick={() => onEdit(v)} disabled={busy}>Editar</button>}
          {active && !v.inside && <button className="danger" onClick={() => act('cancel', {}, 'Autorização cancelada.', 'Cancelar esta autorização? O visitante não poderá mais entrar.')} disabled={busy}>Cancelar autorização</button>}
          {active && <button onClick={() => act('renew', {}, 'Autorização renovada por mais 30 dias.')} disabled={busy}>Renovar +30 dias</button>}
          {staff && active && <button onClick={() => photo.current?.click()} disabled={busy}>{v.has_photo ? 'Trocar foto' : 'Tirar/enviar foto'}</button>}
          {staff && v.has_photo && <button onClick={removePhoto} disabled={busy}>Remover foto</button>}
          {staff && v.status === 'bloqueado' && <button onClick={() => act('unblock', {}, 'Visitante desbloqueado.')} disabled={busy}>Desbloquear</button>}
          {staff && v.status !== 'bloqueado' && !v.inside && <button className="danger" onClick={() => act('block', {}, 'Visitante bloqueado.', 'Bloquear este visitante? A portaria será impedida de liberar a entrada.')} disabled={busy}>Bloquear</button>}
          {staff && active && v.inside && <button className="primary" onClick={() => act('exit', {}, 'Saída registrada.')} disabled={busy}>Registrar saída</button>}
          {staff && active && !v.inside && v.phase === 'valido' && <button className="primary" onClick={() => act('entry', {}, 'Entrada registrada.')} disabled={busy}>Registrar entrada</button>}
        </>
      }
    >
      {error && <Alert>{error}</Alert>}
      <input ref={photo} type="file" accept="image/*" capture="environment" hidden aria-label="Foto do visitante" onChange={(e) => { void sendPhoto(e.target.files?.[0]); e.target.value = '' }} />
      <dl className="view-grid">
        <div><dt>Situação</dt><dd>{phaseBadge(v)}</dd></div>
        <div><dt>Código de acesso</dt><dd><code className="access-code">{v.access_code}</code></dd></div>
        <div><dt>Tipo</dt><dd>{CAT_LABEL[v.category] ?? v.category}</dd></div>
        <div><dt>Validade</dt><dd>{v.valid_from.slice(0, 10) === v.valid_until.slice(0, 10) ? date(v.valid_from) : `${date(v.valid_from)} a ${date(v.valid_until)}`}</dd></div>
        {v.document && <div><dt>Documento</dt><dd>{v.document}</dd></div>}
        {v.phone && <div><dt>Telefone</dt><dd>{v.phone}</dd></div>}
        {v.vehicle_plate && <div><dt>Placa</dt><dd>{v.vehicle_plate}</dd></div>}
        {(v.weekdays || v.time_from) && <div className="wide"><dt>Regra de acesso</dt><dd>{v.weekdays ? v.weekdays.split(',').map((d) => ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'][Number(d)]).join(', ') : 'Todos os dias'}{v.time_from ? ` · das ${v.time_from} às ${v.time_to}` : ''}</dd></div>}
        {v.expected_time && <div><dt>Hora prevista</dt><dd>{v.expected_time}</dd></div>}
        {v.max_stay_minutes && <div><dt>Permanência máxima</dt><dd>{v.max_stay_minutes} min</dd></div>}
        {v.has_photo && <div className="wide"><dt>Foto</dt><dd><img className="visitor-photo" alt={`Foto de ${v.name}`} src={`${prefix(mode)}/visitors/${v.id}/photo?${v.photo_consent_at ?? ''}`} /></dd></div>}
        {v.tenant_names && <div><dt>Morador responsável</dt><dd>{v.tenant_names}</dd></div>}
        {v.notes && <div className="wide"><dt>Observações</dt><dd>{v.notes}</dd></div>}
        {v.created_by_name && <div className="wide"><dt>Autorizado por</dt><dd>{v.created_by_name}{v.created_by_role === 'inquilino' ? ' (morador)' : ' (equipe)'}</dd></div>}
      </dl>
      <h4>Entradas e saídas</h4>
      {events.length === 0 ? (
        <p className="muted small">Ainda não houve entrada.</p>
      ) : (
        <ul className="plain-list">
          {events.map((e) => (
            <li key={e.id}>
              <strong>{e.event === 'entrada' ? 'Entrada' : 'Saída'}</strong> · {dateTime(e.at)}
              {e.recorded_by_name && <span className="muted"> · {e.recorded_by_name}</span>}
              {e.note && <div className="muted small">{e.note}</div>}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}

// ================================================================== Portaria (equipe)

interface LogItem { id: number; event: 'entrada' | 'saida'; at: string; name: string; unit_identifier: string; property_name: string; recorded_by_name: string | null; category: string }

/** Tela da portaria: localizar por nome/código/placa, registrar entrada e saída, ver quem está dentro e o movimento do dia. */
export function PortariaPanel() {
  const [q, setQ] = useState('')
  const [valid, setValid] = useState<Visitor[]>([])
  const [inside, setInside] = useState<Visitor[]>([])
  const [log, setLog] = useState<LogItem[]>([])
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState(0)
  const [viewing, setViewing] = useState<Visitor | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const qs = q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''
    Promise.all([
      request<{ items: Visitor[] }>(`/api/visitors?phase=valido${qs}`),
      request<{ items: Visitor[] }>(`/api/visitors?inside=1${qs}`),
      request<{ items: LogItem[] }>('/api/access/log'),
    ])
      .then(([a, b, c]) => {
        setValid(a.items.filter((v) => !v.inside))
        setInside(b.items)
        setLog(c.items)
        setError('')
      })
      .catch((e) => setError(errorText(e)))
  }, [q, tick])

  async function act(v: Visitor, what: 'entry' | 'exit') {
    setBusyId(v.id)
    try {
      await request(`/api/visitors/${v.id}/${what}`, json('POST', {}))
      toast.success(what === 'entry' ? `Entrada de ${v.name} registrada.` : `Saída de ${v.name} registrada.`)
      setTick((t) => t + 1)
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusyId(0)
    }
  }

  return (
    <>
      <div className="toolbar">
        <input type="search" aria-label="Localizar visitante" placeholder="Nome, código de acesso, placa ou documento" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && <Alert>{error}</Alert>}
      {viewing && <VisitorDetail mode="staff" visitor={viewing} onClose={() => setViewing(null)} onChanged={() => setTick((t) => t + 1)} onEdit={() => setViewing(null)} />}
      <div className="portaria-grid">
        <div className="panel">
          <h3>Esperados hoje</h3>
          {valid.length === 0 ? (
            <p className="muted">Nenhuma autorização válida hoje{q ? ' para essa busca' : ''}.</p>
          ) : (
            <ul className="visit-list">
              {valid.map((v) => (
                <li key={v.id}>
                  <button type="button" className="visit-name" onClick={() => setViewing(v)}>
                    <strong>{v.name}</strong>
                    <span className="muted small">{v.property_name} · {v.unit_identifier} · {CAT_LABEL[v.category] ?? v.category}{v.vehicle_plate ? ` · ${v.vehicle_plate}` : ''} · <code>{v.access_code}</code></span>
                  </button>
                  <button className="primary" disabled={busyId === v.id} onClick={() => act(v, 'entry')} aria-label={`Registrar entrada de ${v.name}`}>Entrada</button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="panel">
          <h3>Dentro agora ({inside.length})</h3>
          {inside.length === 0 ? (
            <p className="muted">Ninguém registrado dentro.</p>
          ) : (
            <ul className="visit-list">
              {inside.map((v) => (
                <li key={v.id}>
                  <button type="button" className="visit-name" onClick={() => setViewing(v)}>
                    <strong>{v.name}</strong>
                    <span className="muted small">{v.property_name} · {v.unit_identifier}{v.last_event_at ? ` · entrou ${dateTime(v.last_event_at)}` : ''}</span>
                  </button>
                  <button disabled={busyId === v.id} onClick={() => act(v, 'exit')} aria-label={`Registrar saída de ${v.name}`}>Saída</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="panel">
        <h3>Movimento de hoje</h3>
        {log.length === 0 ? (
          <p className="muted">Sem movimento até agora.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Hora</th><th>Evento</th><th>Visitante</th><th>Unidade</th><th>Registrado por</th></tr>
              </thead>
              <tbody>
                {log.map((l) => (
                  <tr key={l.id}>
                    <td>{dateTime(l.at)}</td>
                    <td>{l.event === 'entrada' ? 'Entrada' : 'Saída'}</td>
                    <td>{l.name}</td>
                    <td>{l.property_name} · {l.unit_identifier}</td>
                    <td className="muted">{l.recorded_by_name ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
