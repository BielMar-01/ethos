import { useRef, useState } from 'react'
import { request } from './api'
import { Alert, ask, errorText, toast } from './feedback'
import { FormModal, Loaded, Table, Tabs, dateOnly, download, json, money, useLoad } from './kit'
import Modal from './Modal'

/** Operação: documentos dos imóveis, prestadores e manutenção preventiva, enquetes e ocorrências (equipe). */

interface Opt { value: string; label: string }
const MAINT_CATS: Opt[] = [['hidraulica', 'Hidráulica'], ['eletrica', 'Elétrica'], ['estrutural', 'Estrutural'], ['pintura', 'Pintura'], ['fechaduras', 'Fechaduras'], ['eletrodomesticos', 'Eletrodomésticos'], ['pragas', 'Pragas'], ['outro', 'Outro']].map(([value, label]) => ({ value: value!, label: label! }))
const useUnits = () => useLoad(() => request<{ items: { id: number; identifier: string; property_id: number }[] }>('/api/units'))
const useProps = () => useLoad(() => request<{ items: { id: number; name: string }[] }>('/api/properties'))

// ================================================================= Documentos dos imóveis

interface PDoc { id: number; property_id: number; property_name: string; kind: string; title: string; expires_at: string | null; days_left?: number; content_type: string; size_bytes: number }
const DOC_KINDS: Opt[] = [['matricula', 'Matrícula'], ['iptu', 'IPTU'], ['seguro', 'Seguro'], ['habitese', 'Habite-se'], ['laudo', 'Laudo'], ['contrato', 'Contrato'], ['outro', 'Outro']].map(([value, label]) => ({ value: value!, label: label! }))

export function PropertyDocsPage({ isAdmin }: { isAdmin: boolean }) {
  const props = useProps()
  const [propertyId, setPropertyId] = useState('')
  const expiring = useLoad(() => request<{ items: PDoc[] }>('/api/property-documents/expiring?days=60'))
  const docs = useLoad(() => (propertyId ? request<{ items: PDoc[] }>(`/api/properties/${propertyId}/documents`) : Promise.resolve({ items: [] as PDoc[] })), [propertyId])
  const file = useRef<HTMLInputElement>(null)
  const [meta, setMeta] = useState<{ file: File } | null>(null)
  const refresh = () => { void docs.reload(); void expiring.reload() }

  async function remove(d: PDoc) {
    if (!(await ask(`Excluir "${d.title}"?`, { confirmLabel: 'Excluir', danger: true }))) return
    await request(`/api/property-documents/${d.id}`, { method: 'DELETE' })
    refresh()
  }
  const when = (d: PDoc) => (d.expires_at ? <span className={d.days_left !== undefined && d.days_left < 0 ? 'neg' : ''}>{dateOnly(d.expires_at)}{d.days_left !== undefined ? ` (${d.days_left < 0 ? `venceu há ${-d.days_left} d` : `em ${d.days_left} d`})` : ''}</span> : '—')

  return (
    <section>
      <div className="page-head"><h2>Documentos dos imóveis</h2><span className="muted">Matrícula, IPTU, seguro, habite-se… com aviso de vencimento</span></div>
      <h3>Vencendo nos próximos 60 dias</h3>
      <Loaded state={expiring}>
        {(d) => <Table rows={d.items} empty="Nada vencendo. 👍" cols={[
          { head: 'Documento', cell: (x) => x.title }, { head: 'Imóvel', cell: (x) => x.property_name }, { head: 'Vence', cell: when },
        ]} />}
      </Loaded>
      <h3>Por imóvel</h3>
      <div className="inline">
        <select aria-label="Imóvel" value={propertyId} onChange={(e) => setPropertyId(e.target.value)} style={{ flex: 1 }}>
          <option value="">Escolha um imóvel…</option>
          {props.data?.items.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <input ref={file} type="file" hidden accept="application/pdf,image/jpeg,image/png" aria-label="Escolher arquivo" onChange={(e) => { const f = e.target.files?.[0]; if (f) setMeta({ file: f }); e.target.value = '' }} />
        <button className="primary" disabled={!propertyId} onClick={() => file.current?.click()}>Anexar documento</button>
      </div>
      {propertyId && (
        <Loaded state={docs}>
          {(d) => <Table rows={d.items} empty="Nenhum documento neste imóvel." cols={[
            { head: 'Tipo', cell: (x) => DOC_KINDS.find((k) => k.value === x.kind)?.label ?? x.kind },
            { head: 'Título', cell: (x) => x.title },
            { head: 'Vence', cell: when },
            { head: 'Tamanho', cell: (x) => `${(x.size_bytes / 1024).toFixed(0)} KB`, className: 'num' },
            { head: '', cell: (x) => <span className="row-actions"><button onClick={() => download(`/api/property-documents/${x.id}/file`, `${x.title}`)}>Baixar</button>{isAdmin && <button onClick={() => remove(x)}>Excluir</button>}</span> },
          ]} />}
        </Loaded>
      )}
      {meta && (
        <FormModal
          title={`Anexar ${meta.file.name}`}
          submitLabel="Anexar"
          fields={[
            { name: 'kind', label: 'Tipo', type: 'select', required: true, options: DOC_KINDS },
            { name: 'title', label: 'Título', required: true },
            { name: 'expires_at', label: 'Vencimento', type: 'date', hint: 'Deixe vazio se não vence. Avisamos 30 dias antes.' },
          ]}
          initial={{ kind: 'outro', title: meta.file.name.replace(/\.[^.]+$/, '') }}
          onSubmit={async (b) => {
            const q = new URLSearchParams({ kind: String(b.kind), title: String(b.title), ...(b.expires_at ? { expires_at: String(b.expires_at) } : {}) })
            const res = await fetch(`/api/properties/${propertyId}/documents?${q}`, { method: 'POST', headers: { 'Content-Type': meta.file.type }, body: meta.file })
            if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Não foi possível anexar.')
            toast.success('Documento anexado.')
            refresh()
          }}
          onClose={() => setMeta(null)}
        />
      )}
    </section>
  )
}

// ================================================================= Prestadores e manutenção preventiva

interface Provider { id: number; name: string; phone: string | null; email: string | null; categories: string; active: boolean; rating: number | null; reviews: number; jobs_approved: number; notes: string | null; document: string | null }
interface Plan { id: number; unit_id: number; title: string; category: string; description: string; interval_months: number; next_due: string; lead_days: number; active: boolean; unit_identifier: string; property_name: string; priority: string }

export function ProvidersPage() {
  const [tab, setTab] = useState<'providers' | 'plans'>('providers')
  return (
    <section>
      <div className="page-head"><h2>Prestadores e preventiva</h2></div>
      <Tabs tabs={[['providers', 'Prestadores'], ['plans', 'Manutenção preventiva']] as const} value={tab} onChange={setTab} />
      {tab === 'providers' ? <Providers /> : <Plans />}
    </section>
  )
}

function Providers() {
  const s = useLoad(() => request<{ items: Provider[] }>('/api/providers?all=1'))
  const [editing, setEditing] = useState<Provider | 'new' | null>(null)
  const [rating, setRating] = useState<Provider | null>(null)
  const p = editing && editing !== 'new' ? editing : null
  return (
    <div className="stack">
      <div className="actions"><button className="primary" onClick={() => setEditing('new')}>Novo prestador</button></div>
      <Loaded state={s}>
        {(d) => <Table rows={d.items} empty="Nenhum prestador cadastrado." onRow={setEditing} cols={[
          { head: 'Nome', cell: (x) => <>{x.name}{!x.active && <span className="badge"> inativo</span>}</> },
          { head: 'Contato', cell: (x) => [x.phone, x.email].filter(Boolean).join(' · ') },
          { head: 'Atende', cell: (x) => x.categories.split(',').filter(Boolean).map((c) => MAINT_CATS.find((m) => m.value === c)?.label ?? c).join(', ') },
          { head: 'Nota', cell: (x) => (x.rating ? `★ ${x.rating} (${x.reviews})` : '—') },
          { head: 'Serviços aprovados', cell: (x) => x.jobs_approved, className: 'num' },
          { head: '', cell: (x) => <button onClick={(e) => { e.stopPropagation(); setRating(x) }}>Avaliar</button> },
        ]} />}
      </Loaded>
      {editing && (
        <FormModal
          title={p ? p.name : 'Novo prestador'}
          keepEmpty
          initial={{ ...p }}
          fields={[
            { name: 'name', label: 'Nome', required: true },
            { name: 'phone', label: 'Telefone' },
            { name: 'email', label: 'E-mail', type: 'email' },
            { name: 'document', label: 'CPF/CNPJ' },
            { name: 'categories', label: 'Categorias que atende', type: 'multi', options: MAINT_CATS },
            { name: 'notes', label: 'Observações', type: 'textarea' },
            ...(p ? [{ name: 'active', label: 'Ativo', type: 'check' as const }] : []),
          ]}
          onSubmit={async (b) => {
            if (p) await request(`/api/providers/${p.id}`, json('PATCH', b))
            else await request('/api/providers', json('POST', b))
            await s.reload()
          }}
          onClose={() => setEditing(null)}
        />
      )}
      {rating && (
        <FormModal
          title={`Avaliar ${rating.name}`}
          fields={[
            { name: 'rating', label: 'Nota (1 a 5)', type: 'number', required: true, min: 1, max: 5 },
            { name: 'comment', label: 'Comentário', type: 'textarea' },
          ]}
          onSubmit={async (b) => {
            await request(`/api/providers/${rating.id}/reviews`, json('POST', b))
            toast.success('Avaliação registrada.')
            await s.reload()
          }}
          onClose={() => setRating(null)}
        />
      )}
    </div>
  )
}

function Plans() {
  const s = useLoad(() => request<{ items: Plan[] }>('/api/maintenance-plans'))
  const units = useUnits()
  const [editing, setEditing] = useState<Plan | 'new' | null>(null)
  const p = editing && editing !== 'new' ? editing : null
  async function toggle(x: Plan) {
    await request(`/api/maintenance-plans/${x.id}`, json('PATCH', { active: !x.active }))
    await s.reload()
  }
  return (
    <div className="stack">
      <p className="muted small">Abre sozinho um chamado de manutenção a cada N meses (limpeza de caixa d'água, dedetização, revisão elétrica…), alguns dias antes do vencimento.</p>
      <div className="actions"><button className="primary" onClick={() => setEditing('new')}>Novo plano</button></div>
      <Loaded state={s}>
        {(d) => <Table rows={d.items} empty="Nenhum plano." onRow={setEditing} cols={[
          { head: 'Serviço', cell: (x) => <>{x.title}{!x.active && <span className="badge"> pausado</span>}</> },
          { head: 'Unidade', cell: (x) => `${x.property_name} · ${x.unit_identifier}` },
          { head: 'A cada', cell: (x) => `${x.interval_months} mês(es)` },
          { head: 'Próximo', cell: (x) => dateOnly(x.next_due) },
          { head: '', cell: (x) => <button onClick={(e) => { e.stopPropagation(); void toggle(x) }}>{x.active ? 'Pausar' : 'Retomar'}</button> },
        ]} />}
      </Loaded>
      {editing && (
        <FormModal
          title={p ? p.title : 'Novo plano de manutenção preventiva'}
          initial={{ ...p, priority: p?.priority ?? 'media', lead_days: p?.lead_days ?? 7 }}
          fields={[
            { name: 'unit_id', label: 'Unidade', type: 'select', required: true, options: (units.data?.items ?? []).map((u) => ({ value: String(u.id), label: u.identifier })) },
            { name: 'title', label: 'Serviço', required: true },
            { name: 'category', label: 'Categoria', type: 'select', required: true, options: MAINT_CATS },
            { name: 'description', label: 'O que fazer', type: 'textarea', required: true },
            { name: 'interval_months', label: 'Repetir a cada (meses)', type: 'number', required: true, min: 1, max: 60 },
            { name: 'next_due', label: 'Próxima data', type: 'date', required: true },
            { name: 'lead_days', label: 'Abrir o chamado com (dias de antecedência)', type: 'number', min: 0, max: 60 },
            { name: 'priority', label: 'Prioridade', type: 'select', required: true, options: [['baixa', 'Baixa'], ['media', 'Média'], ['alta', 'Alta'], ['urgente', 'Urgente']].map(([value, label]) => ({ value: value!, label: label! })) },
          ]}
          onSubmit={async (b) => {
            const body = { ...b, unit_id: Number(b.unit_id) }
            if (p) await request(`/api/maintenance-plans/${p.id}`, json('PATCH', body))
            else await request('/api/maintenance-plans', json('POST', body))
            await s.reload()
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

// ================================================================= Enquetes

interface Poll { id: number; question: string; audience: string; anonymous: boolean; closes_at: string | null; status: string; votes: number; property_name: string | null }
interface PollDetail { item: Poll; total_votes: number; options: { id: number; label: string; votes: number; percent: number }[]; voters?: { option_id: number; name: string }[] }

export function PollsPage({ isAdmin }: { isAdmin: boolean }) {
  const s = useLoad(() => request<{ items: Poll[] }>('/api/polls'))
  const props = useProps()
  const [creating, setCreating] = useState(false)
  const [viewing, setViewing] = useState<Poll | null>(null)
  return (
    <section>
      <div className="page-head"><h2>Enquetes</h2><span className="muted">Pergunte aos inquilinos e proprietários</span></div>
      <div className="actions"><button className="primary" onClick={() => setCreating(true)}>Nova enquete</button></div>
      <Loaded state={s}>
        {(d) => <Table rows={d.items} empty="Nenhuma enquete criada." onRow={setViewing} cols={[
          { head: 'Pergunta', cell: (p) => p.question },
          { head: 'Público', cell: (p) => `${p.audience}${p.property_name ? ` · ${p.property_name}` : ''}` },
          { head: 'Votos', cell: (p) => p.votes, className: 'num' },
          { head: 'Situação', cell: (p) => <span className={p.status === 'aberta' ? 'badge badge-ok' : 'badge'}>{p.status}</span> },
        ]} />}
      </Loaded>
      {creating && (
        <FormModal
          title="Nova enquete"
          submitLabel="Publicar"
          fields={[
            { name: 'question', label: 'Pergunta', required: true, wide: true },
            { name: 'options_text', label: 'Opções (uma por linha, de 2 a 10)', type: 'textarea', required: true },
            { name: 'audience', label: 'Quem responde', type: 'select', required: true, options: [{ value: 'todos', label: 'Inquilinos e proprietários' }, { value: 'inquilinos', label: 'Só inquilinos' }, { value: 'proprietarios', label: 'Só proprietários' }] },
            { name: 'property_id', label: 'Só deste imóvel (opcional)', type: 'select', options: (props.data?.items ?? []).map((p) => ({ value: String(p.id), label: p.name })) },
            { name: 'closes_at', label: 'Encerra em (opcional)', type: 'datetime' },
            { name: 'anonymous', label: 'Voto anônimo (nem a equipe vê quem votou)', type: 'check' },
          ]}
          initial={{ audience: 'inquilinos' }}
          onSubmit={async (b) => {
            const options = String(b.options_text).split('\n').map((x) => x.trim()).filter(Boolean)
            const { options_text: _o, ...rest } = b
            const r = await request<{ recipients: number }>('/api/polls', json('POST', { ...rest, options, property_id: b.property_id ? Number(b.property_id) : undefined }))
            toast.success(`Enquete publicada para ${r.recipients} pessoa(s).`)
            await s.reload()
          }}
          onClose={() => setCreating(false)}
        />
      )}
      {viewing && <PollModal poll={viewing} isAdmin={isAdmin} onClose={() => setViewing(null)} onChanged={() => { setViewing(null); void s.reload() }} />}
    </section>
  )
}

function PollModal({ poll, isAdmin, onClose, onChanged }: { poll: Poll; isAdmin: boolean; onClose: () => void; onChanged: () => void }) {
  const s = useLoad(() => request<PollDetail>(`/api/polls/${poll.id}`))
  const [error, setError] = useState('')
  async function act(kind: 'close' | 'delete') {
    if (!(await ask(kind === 'close' ? 'Encerrar a enquete agora?' : 'Excluir a enquete e os votos?', { confirmLabel: kind === 'close' ? 'Encerrar' : 'Excluir', danger: kind === 'delete' }))) return
    try {
      await request(`/api/polls/${poll.id}${kind === 'close' ? '/close' : ''}`, kind === 'close' ? json('POST') : { method: 'DELETE' })
      onChanged()
    } catch (e) {
      setError(errorText(e))
    }
  }
  return (
    <Modal title={poll.question} subtitle={`${poll.votes} voto(s)${poll.anonymous ? ' · anônima' : ''}`} size="md" onClose={onClose}
      footer={<>{poll.status === 'aberta' && <button onClick={() => act('close')}>Encerrar</button>}{isAdmin && <button className="danger" onClick={() => act('delete')}>Excluir</button>}</>}>
      {error && <Alert>{error}</Alert>}
      <Loaded state={s}>
        {(d) => (
          <div className="stack">
            {d.options.map((o) => (
              <div key={o.id}>
                <div className="inline"><strong style={{ flex: 1 }}>{o.label}</strong><span>{o.votes} · {o.percent}%</span></div>
                <div className="meter" role="progressbar" aria-valuenow={o.percent} aria-valuemin={0} aria-valuemax={100} aria-label={o.label}><span style={{ width: `${o.percent}%` }} /></div>
                {d.voters && <p className="muted small">{d.voters.filter((v) => v.option_id === o.id).map((v) => v.name).join(', ') || '—'}</p>}
              </div>
            ))}
          </div>
        )}
      </Loaded>
    </Modal>
  )
}

// ================================================================= Ocorrências

interface Incident { id: number; unit_id: number; category: string; description: string; occurred_at: string; status: string; fine_cents: number | null; contestation: string | null; unit_identifier: string; property_name: string; tenant_names: string | null; resolution_note: string | null }
const INC_CATS: Opt[] = [['barulho', 'Barulho'], ['animais', 'Animais'], ['dano', 'Dano ao imóvel'], ['lixo', 'Lixo/limpeza'], ['estacionamento', 'Estacionamento'], ['outro', 'Outro']].map(([value, label]) => ({ value: value!, label: label! }))
const INC_STATUS: Record<string, string> = { registrada: 'Registrada (interna)', notificada: 'Morador notificado', multada: 'Multada', arquivada: 'Arquivada' }

export function IncidentsPage() {
  const [status, setStatus] = useState('')
  const s = useLoad(() => request<{ items: Incident[] }>(`/api/incidents${status ? `?status=${status}` : ''}`), [status])
  const units = useUnits()
  const [creating, setCreating] = useState(false)
  const [viewing, setViewing] = useState<Incident | null>(null)
  return (
    <section>
      <div className="page-head"><h2>Ocorrências</h2><span className="muted">Registro, notificação ao morador, contestação e multa</span></div>
      <div className="inline">
        <select aria-label="Situação" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todas</option>
          {Object.entries(INC_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button className="primary" onClick={() => setCreating(true)}>Registrar ocorrência</button>
      </div>
      <Loaded state={s}>
        {(d) => <Table rows={d.items} empty="Nenhuma ocorrência." onRow={setViewing} cols={[
          { head: 'Quando', cell: (i) => new Date(i.occurred_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) },
          { head: 'Unidade', cell: (i) => `${i.property_name} · ${i.unit_identifier}` },
          { head: 'Tipo', cell: (i) => INC_CATS.find((c) => c.value === i.category)?.label },
          { head: 'Situação', cell: (i) => <>{INC_STATUS[i.status]}{i.contestation && <span className="badge badge-v-bloqueado"> contestada</span>}</> },
          { head: 'Multa', cell: (i) => money(i.fine_cents), className: 'num' },
        ]} />}
      </Loaded>
      {creating && (
        <FormModal
          title="Registrar ocorrência"
          fields={[
            { name: 'unit_id', label: 'Unidade', type: 'select', required: true, options: (units.data?.items ?? []).map((u) => ({ value: String(u.id), label: u.identifier })) },
            { name: 'category', label: 'Tipo', type: 'select', required: true, options: INC_CATS },
            { name: 'occurred_at', label: 'Quando aconteceu', type: 'datetime', required: true },
            { name: 'description', label: 'O que aconteceu', type: 'textarea', required: true },
          ]}
          onSubmit={async (b) => {
            await request('/api/incidents', json('POST', { ...b, unit_id: Number(b.unit_id) }))
            toast.success('Ocorrência registrada (só a equipe vê até você notificar o morador).')
            await s.reload()
          }}
          onClose={() => setCreating(false)}
        />
      )}
      {viewing && <IncidentModal i={viewing} onClose={() => setViewing(null)} onChanged={() => { setViewing(null); void s.reload() }} />}
    </section>
  )
}

function IncidentModal({ i, onClose, onChanged }: { i: Incident; onClose: () => void; onChanged: () => void }) {
  const [error, setError] = useState('')
  const [fining, setFining] = useState(false)
  async function act(path: string, body?: unknown, confirm?: string) {
    if (confirm && !(await ask(confirm))) return
    try {
      await request(`/api/incidents/${i.id}/${path}`, json('POST', body))
      onChanged()
    } catch (e) {
      setError(errorText(e))
    }
  }
  return (
    <Modal title={`Ocorrência — ${INC_CATS.find((c) => c.value === i.category)?.label}`} subtitle={`${i.property_name} · ${i.unit_identifier} · ${i.tenant_names ?? 'sem contrato vigente'}`} size="md" onClose={onClose}
      footer={<>
        {i.status === 'registrada' && <button className="primary" onClick={() => act('notify', undefined, 'Notificar o morador? Ele passa a ver a ocorrência e pode contestar.')}>Notificar o morador</button>}
        {i.status === 'notificada' && <button className="danger" onClick={() => setFining(true)}>Aplicar multa</button>}
        {i.status !== 'arquivada' && <button onClick={() => act('archive', {}, 'Arquivar esta ocorrência?')}>Arquivar</button>}
      </>}>
      {error && <Alert>{error}</Alert>}
      <dl className="view-grid">
        <div><dt>Quando</dt><dd>{new Date(i.occurred_at).toLocaleString('pt-BR')}</dd></div>
        <div><dt>Situação</dt><dd>{INC_STATUS[i.status]}</dd></div>
        <div className="wide"><dt>Descrição</dt><dd>{i.description}</dd></div>
        {i.fine_cents && <div><dt>Multa</dt><dd>{money(i.fine_cents)}</dd></div>}
        {i.contestation && <div className="wide"><dt>Contestação do morador</dt><dd>{i.contestation}</dd></div>}
        {i.resolution_note && <div className="wide"><dt>Resolução</dt><dd>{i.resolution_note}</dd></div>}
      </dl>
      {fining && (
        <FormModal title="Aplicar multa" submitLabel="Aplicar multa" fields={[{ name: 'amount_cents', label: 'Valor', type: 'money', required: true }, { name: 'due_date', label: 'Vencimento', type: 'date', hint: 'Vazio = hoje' }]}
          intro={<p className="muted small">Vira uma cobrança do contrato (com boleto e recibo) e o morador é avisado. Confirme se o contrato ou o regulamento prevê a multa.</p>}
          onSubmit={async (b) => { await request(`/api/incidents/${i.id}/fine`, json('POST', b)); onChanged() }} onClose={() => setFining(false)} />
      )}
    </Modal>
  )
}
