import { useState } from 'react'
import { request } from './api'
import { Alert, ask, errorText, toast } from './feedback'
import { FormModal, Loaded, Table, Tabs, json, money, useLoad } from './kit'
import MaskedInput from './MaskedInput'

/** Captação: funil de interessados, agenda de visitas, análise de crédito e vitrine pública. */

type Tab = 'leads' | 'visits' | 'credit' | 'listing'
const STATUS: Record<string, string> = { novo: 'Novo', contato: 'Em contato', visita_agendada: 'Visita agendada', proposta: 'Proposta', ganho: 'Fechou', perdido: 'Perdido' }
const SOURCE: Record<string, string> = { manual: 'Cadastro manual', site: 'Site', indicacao: 'Indicação', portal: 'Portal', outro: 'Outro' }
const statusOpts = Object.entries(STATUS).map(([value, label]) => ({ value, label }))

export default function CapturePage({ isAdmin }: { isAdmin: boolean }) {
  const [tab, setTab] = useState<Tab>('leads')
  return (
    <section>
      <div className="page-head"><h2>Captação</h2><span className="muted">Interessados, visitas e análise de crédito</span></div>
      <Tabs tabs={[['leads', 'Interessados'], ['visits', 'Agenda de visitas'], ['credit', 'Análise de crédito'], ['listing', 'Vitrine pública']] as const} value={tab} onChange={setTab} />
      {tab === 'leads' && <Leads />}
      {tab === 'visits' && <Visits />}
      {tab === 'credit' && <Credit isAdmin={isAdmin} />}
      {tab === 'listing' && <Listing isAdmin={isAdmin} />}
    </section>
  )
}

interface Lead { id: number; name: string; phone: string | null; email: string | null; source: string; status: string; message: string | null; notes: string | null; unit_id: number | null; unit_identifier: string | null; property_name: string | null; visits_scheduled: number }
interface Unit { id: number; identifier: string }

function Leads() {
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const s = useLoad(() => request<{ items: Lead[]; counts: Record<string, number> }>(`/api/leads?${status ? `status=${status}&` : ''}${q ? `q=${encodeURIComponent(q)}` : ''}`), [status, q])
  const units = useLoad(() => request<{ items: Unit[] }>('/api/units'))
  const [editing, setEditing] = useState<Lead | 'new' | null>(null)
  const [scheduling, setScheduling] = useState<Lead | null>(null)
  const unitOpts = (units.data?.items ?? []).map((u) => ({ value: String(u.id), label: u.identifier }))

  return (
    <div className="stack">
      <div className="inline">
        <input type="search" placeholder="Buscar por nome, telefone ou e-mail" aria-label="Buscar interessado" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
        <select aria-label="Filtrar por situação" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todas as situações</option>
          {statusOpts.map((o) => <option key={o.value} value={o.value}>{o.label}{s.data?.counts[o.value] ? ` (${s.data.counts[o.value]})` : ''}</option>)}
        </select>
        <button className="primary" onClick={() => setEditing('new')}>Novo interessado</button>
      </div>
      <Loaded state={s}>
        {(d) => (
          <Table rows={d.items} empty="Nenhum interessado." onRow={setEditing} cols={[
            { head: 'Nome', cell: (l) => l.name },
            { head: 'Contato', cell: (l) => [l.phone, l.email].filter(Boolean).join(' · ') },
            { head: 'Interesse', cell: (l) => (l.unit_identifier ? `${l.property_name} · ${l.unit_identifier}` : '—') },
            { head: 'Origem', cell: (l) => SOURCE[l.source] },
            { head: 'Situação', cell: (l) => <span className="badge">{STATUS[l.status]}</span> },
            { head: '', cell: (l) => <button onClick={(e) => { e.stopPropagation(); setScheduling(l) }}>Agendar visita</button> },
          ]} />
        )}
      </Loaded>
      {editing && <LeadForm lead={editing === 'new' ? null : editing} unitOpts={unitOpts} onClose={() => setEditing(null)} onDone={() => void s.reload()} />}
      {scheduling && (
        <FormModal
          title={`Agendar visita — ${scheduling.name}`}
          submitLabel="Agendar"
          fields={[
            { name: 'scheduled_at', label: 'Data e hora', type: 'datetime', required: true },
            { name: 'unit_id', label: 'Unidade', type: 'select', options: unitOpts },
            { name: 'notes', label: 'Observações', type: 'textarea' },
          ]}
          initial={{ unit_id: scheduling.unit_id }}
          onSubmit={async (b) => {
            await request(`/api/leads/${scheduling.id}/visits`, json('POST', { ...b, unit_id: b.unit_id ? Number(b.unit_id) : undefined }))
            toast.success('Visita agendada.')
            await s.reload()
          }}
          onClose={() => setScheduling(null)}
        />
      )}
    </div>
  )
}

function LeadForm({ lead, unitOpts, onClose, onDone }: { lead: Lead | null; unitOpts: { value: string; label: string }[]; onClose: () => void; onDone: () => void }) {
  const [phone, setPhone] = useState(lead?.phone ?? '')
  return (
    <FormModal
      title={lead ? lead.name : 'Novo interessado'}
      keepEmpty
      initial={{ ...lead, unit_id: lead?.unit_id, status: lead?.status ?? 'novo', source: lead?.source ?? 'manual' }}
      fields={[
        { name: 'name', label: 'Nome', required: true },
        { name: 'email', label: 'E-mail', type: 'email' },
        { name: 'source', label: 'Origem', type: 'select', required: true, options: Object.entries(SOURCE).map(([value, label]) => ({ value, label })) },
        { name: 'status', label: 'Situação', type: 'select', required: true, options: statusOpts },
        { name: 'unit_id', label: 'Unidade de interesse', type: 'select', options: unitOpts },
        { name: 'notes', label: 'Anotações', type: 'textarea' },
      ]}
      intro={<label>Telefone<MaskedInput kind="phone" value={phone} onValue={setPhone} /></label>}
      onSubmit={async (b) => {
        const body = { ...b, phone, unit_id: b.unit_id ? Number(b.unit_id) : null }
        if (lead) await request(`/api/leads/${lead.id}`, json('PATCH', body))
        else await request('/api/leads', json('POST', body))
        onDone()
      }}
      onClose={onClose}
    />
  )
}

interface Visit { id: number; lead_name: string; lead_phone: string | null; scheduled_at: string; status: string; unit_identifier: string | null; property_name: string | null; assigned_name: string | null; notes: string | null }
function Visits() {
  const s = useLoad(() => request<{ items: Visit[] }>(`/api/lead-visits?from=${new Date().toLocaleDateString('sv-SE')}`))
  async function mark(v: Visit, status: string) {
    try {
      await request(`/api/lead-visits/${v.id}`, json('PATCH', { status }))
      await s.reload()
    } catch (e) {
      toast.error(errorText(e))
    }
  }
  return (
    <Loaded state={s}>
      {(d) => (
        <Table rows={d.items} empty="Nenhuma visita agendada a partir de hoje." cols={[
          { head: 'Quando', cell: (v) => new Date(v.scheduled_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) },
          { head: 'Interessado', cell: (v) => `${v.lead_name}${v.lead_phone ? ` · ${v.lead_phone}` : ''}` },
          { head: 'Unidade', cell: (v) => (v.unit_identifier ? `${v.property_name} · ${v.unit_identifier}` : '—') },
          { head: 'Responsável', cell: (v) => v.assigned_name ?? '—' },
          { head: 'Situação', cell: (v) => v.status },
          { head: '', cell: (v) => v.status === 'agendada' ? <span className="row-actions"><button onClick={() => mark(v, 'realizada')}>Realizada</button><button onClick={() => mark(v, 'faltou')}>Faltou</button><button onClick={() => mark(v, 'cancelada')}>Cancelar</button></span> : null },
        ]} />
      )}
    </Loaded>
  )
}

interface Credit { id: number; name: string; income_cents: number; rent_cents: number; ratio: number; negative_records: boolean; recommendation: string; status: string }
const REC: Record<string, string> = { aprovar: 'Aprovar', revisar: 'Revisar', reprovar: 'Reprovar' }
function Credit({ isAdmin }: { isAdmin: boolean }) {
  const s = useLoad(() => request<{ items: Credit[] }>('/api/credit-checks'))
  const [creating, setCreating] = useState(false)
  const [result, setResult] = useState<{ id: number; recommendation: string; ratio: number; rule: string } | null>(null)
  async function decide(c: Credit, status: 'aprovado' | 'reprovado') {
    try {
      await request(`/api/credit-checks/${c.id}/decision`, json('PATCH', { status }))
      await s.reload()
    } catch (e) {
      toast.error(errorText(e))
    }
  }
  async function remove(c: Credit) {
    if (!(await ask(`Excluir a análise de ${c.name}? Os dados pessoais do candidato serão apagados.`, { confirmLabel: 'Excluir', danger: true }))) return
    await request(`/api/credit-checks/${c.id}`, { method: 'DELETE' })
    await s.reload()
  }
  return (
    <div className="stack">
      <p className="muted small">Regra simples e transparente: renda ≥ 3× o aluguel aprova; de 2,5× a 3× pede revisão; abaixo disso ou com restrição no nome reprova. <strong>A decisão é sua.</strong> Não consulta Serasa/SPC: informe aqui o que você apurou. Exige o consentimento do candidato (LGPD).</p>
      <div className="actions"><button className="primary" onClick={() => setCreating(true)}>Nova análise</button></div>
      {result && <p className="notice" role="status">Resultado: <strong>{REC[result.recommendation]}</strong> (renda = {result.ratio}× o aluguel). {result.rule}</p>}
      <Loaded state={s}>
        {(d) => (
          <Table rows={d.items} empty="Nenhuma análise." cols={[
            { head: 'Candidato', cell: (c) => c.name },
            { head: 'Renda', cell: (c) => money(c.income_cents), className: 'num' },
            { head: 'Aluguel', cell: (c) => money(c.rent_cents), className: 'num' },
            { head: 'Renda ÷ aluguel', cell: (c) => `${c.ratio}×${c.negative_records ? ' · restrição' : ''}`, className: 'num' },
            { head: 'Sugestão', cell: (c) => REC[c.recommendation] },
            { head: 'Decisão', cell: (c) => (c.status === 'pendente' ? <span className="row-actions"><button onClick={() => decide(c, 'aprovado')}>Aprovar</button><button onClick={() => decide(c, 'reprovado')}>Reprovar</button></span> : c.status) },
            { head: '', cell: (c) => (isAdmin ? <button onClick={() => remove(c)}>Excluir</button> : null) },
          ]} />
        )}
      </Loaded>
      {creating && (
        <FormModal
          title="Análise de crédito"
          submitLabel="Analisar"
          fields={[
            { name: 'name', label: 'Nome do candidato', required: true },
            { name: 'document', label: 'CPF/CNPJ', required: true },
            { name: 'income_cents', label: 'Renda mensal comprovada', type: 'money', required: true },
            { name: 'rent_cents', label: 'Aluguel pretendido', type: 'money', required: true },
            { name: 'score', label: 'Score (0–1000, se tiver)', type: 'number', min: 0, max: 1000 },
            { name: 'negative_records', label: 'Há restrição no nome (apurada fora do sistema)', type: 'check' },
            { name: 'consent', label: 'O candidato autorizou esta análise de crédito (LGPD)', type: 'check' },
            { name: 'notes', label: 'Observações', type: 'textarea' },
          ]}
          onSubmit={async (b) => {
            setResult(await request(`/api/credit-checks`, json('POST', b)))
            await s.reload()
          }}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  )
}

function Listing({ isAdmin }: { isAdmin: boolean }) {
  const s = useLoad(() => request<{ enabled: boolean; link: string | null }>('/api/settings/public-listing'))
  const [error, setError] = useState('')
  async function set(enabled: boolean, regenerate = false) {
    try {
      await request('/api/settings/public-listing', json('PUT', { enabled, regenerate }))
      await s.reload()
    } catch (e) {
      setError(errorText(e))
    }
  }
  return (
    <Loaded state={s}>
      {(d) => (
        <div className="panel stack">
          <h3>Vitrine pública</h3>
          <p className="muted small">Uma página aberta (sem login) com as unidades <strong>disponíveis</strong> (só bairro e cidade, nunca o endereço completo) e um formulário de interesse. Cada envio vira um interessado e avisa a equipe. Tem proteção contra robôs e limite de envios.</p>
          {error && <Alert>{error}</Alert>}
          {d.enabled && d.link ? (
            <>
              <div className="inline"><input readOnly value={d.link} aria-label="Link da vitrine" style={{ flex: 1 }} onFocus={(e) => e.currentTarget.select()} /><button onClick={() => navigator.clipboard.writeText(d.link!).then(() => toast.success('Link copiado.'))}>Copiar</button></div>
              {isAdmin && <div className="actions"><button onClick={() => set(true, true)}>Gerar novo link (o antigo para)</button><button className="danger" onClick={() => set(false)}>Desligar</button></div>}
            </>
          ) : isAdmin ? <div className="actions"><button className="primary" onClick={() => set(true)}>Ligar a vitrine</button></div> : <p className="muted">Desligada. Peça a um administrador para ligar.</p>}
        </div>
      )}
    </Loaded>
  )
}

