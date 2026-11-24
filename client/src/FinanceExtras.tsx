import { useState } from 'react'
import { request } from './api'
import { Alert, ask, errorText, toast } from './feedback'
import { FormModal, Loaded, Table, dateOnly, json, money, useLoad } from './kit'
import Modal from './Modal'

/** Abas extras do Financeiro: conciliação bancária, rateio de despesas e configurações (multa, juros, pro rata, taxa). */

// ------------------------------------------------------------------ Conciliação

interface Line { id: number; posted_at: string; amount_cents: number; memo: string; status: string; receipt_number: number | null }
interface Suggestion { id: number; lease_id: number; description: string; due_date: string; balance_cents: number; tenant_names: string | null; unit_identifier: string; property_name: string; score: number; why: string[] }

async function readText(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const utf8 = new TextDecoder('utf-8').decode(buf)
  // Extratos antigos vêm em Windows-1252: se o UTF-8 deu caracteres inválidos, relê assim.
  return utf8.includes('�') ? new TextDecoder('windows-1252').decode(buf) : utf8
}

export function BankTab({ onChange }: { onChange: () => void }) {
  const [status, setStatus] = useState<'pendente' | 'conciliada' | 'ignorada'>('pendente')
  const s = useLoad(() => request<{ items: Line[]; pending: number }>(`/api/bank/lines?status=${status}`), [status])
  const [picking, setPicking] = useState<Line | null>(null)
  const [busy, setBusy] = useState(false)

  async function upload(file: File | undefined) {
    if (!file) return
    setBusy(true)
    try {
      const r = await request<{ read: number; added: number; duplicated: number; credits: number; source: string }>('/api/bank/import', json('POST', { filename: file.name, content: await readText(file) }))
      toast.success(`${r.read} lançamento(s) lido(s) (${r.source.toUpperCase()}): ${r.added} novo(s), ${r.duplicated} já importado(s).`)
      await s.reload()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  async function setLine(l: Line, action: 'ignore' | 'restore') {
    try {
      await request(`/api/bank/lines/${l.id}/${action}`, json('POST'))
      await s.reload()
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  return (
    <div className="stack">
      <div className="panel stack">
        <h3>Importar extrato</h3>
        <p className="muted small">Envie o extrato do banco em <strong>OFX</strong> (recomendado) ou <strong>CSV</strong> (colunas de data, descrição e valor). Lançamentos repetidos são ignorados. Só os créditos viram sugestão de baixa. CNAB ainda não é lido.</p>
        <label className="file-pick">
          <input type="file" accept=".ofx,.csv,.txt" disabled={busy} aria-label="Escolher arquivo do extrato" onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = '' }} />
        </label>
      </div>
      <div className="tabs" role="tablist">
        {(['pendente', 'conciliada', 'ignorada'] as const).map((k) => (
          <button key={k} role="tab" aria-selected={status === k} className={status === k ? 'tab active' : 'tab'} onClick={() => setStatus(k)}>
            {k === 'pendente' ? `A conciliar${s.data ? ` (${s.data.pending})` : ''}` : k === 'conciliada' ? 'Conciliados' : 'Ignorados'}
          </button>
        ))}
      </div>
      <Loaded state={s}>
        {(d) => (
          <Table rows={d.items} empty="Nenhum lançamento aqui." cols={[
            { head: 'Data', cell: (l) => dateOnly(l.posted_at) },
            { head: 'Histórico', cell: (l) => l.memo || '—' },
            { head: 'Valor', cell: (l) => <span className={l.amount_cents < 0 ? 'neg' : ''}>{money(l.amount_cents)}</span>, className: 'num' },
            { head: '', cell: (l) => (
              <span className="row-actions">
                {l.status === 'pendente' && <button className="primary" onClick={() => setPicking(l)}>Conciliar</button>}
                {l.status === 'pendente' && <button onClick={() => setLine(l, 'ignore')}>Ignorar</button>}
                {l.status === 'ignorada' && l.amount_cents > 0 && <button onClick={() => setLine(l, 'restore')}>Voltar</button>}
                {l.status === 'conciliada' && l.receipt_number && <span className="muted small">recibo nº {l.receipt_number}</span>}
              </span>
            ) },
          ]} />
        )}
      </Loaded>
      {picking && <ReconcileModal line={picking} onClose={() => setPicking(null)} onDone={() => { setPicking(null); void s.reload(); onChange() }} />}
    </div>
  )
}

function ReconcileModal({ line, onClose, onDone }: { line: Line; onClose: () => void; onDone: () => void }) {
  const s = useLoad(() => request<{ items: Suggestion[] }>(`/api/bank/lines/${line.id}/suggestions`))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function confirm(c: Suggestion) {
    if (!(await ask(`Registrar ${money(Math.min(line.amount_cents, c.balance_cents))} como pago de "${c.description}" (${c.tenant_names ?? '—'})? Será emitido um recibo.`, { title: 'Conciliar', confirmLabel: 'Conciliar' }))) return
    setBusy(true)
    setError('')
    try {
      await request(`/api/bank/lines/${line.id}/reconcile`, json('POST', { lease_id: c.lease_id, charge_id: c.id }))
      toast.success('Pagamento registrado e recibo emitido.')
      onDone()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Conciliar lançamento" subtitle={`${dateOnly(line.posted_at)} · ${money(line.amount_cents)}`} size="lg" onClose={onClose} locked={busy}>
      <p className="muted">{line.memo}</p>
      {error && <Alert>{error}</Alert>}
      <Loaded state={s}>
        {(d) => (
          <Table rows={d.items} empty="Nenhuma cobrança parecida. Registre o pagamento manualmente em Pagamentos e ignore esta linha." cols={[
            { head: 'Locatário', cell: (c) => c.tenant_names },
            { head: 'Cobrança', cell: (c) => `${c.description} · ${c.property_name} ${c.unit_identifier}` },
            { head: 'Vence', cell: (c) => dateOnly(c.due_date) },
            { head: 'Saldo', cell: (c) => money(c.balance_cents), className: 'num' },
            { head: 'Por que', cell: (c) => c.why.join(', ') },
            { head: '', cell: (c) => <button className="primary" disabled={busy} onClick={() => confirm(c)}>Esta</button> },
          ]} />
        )}
      </Loaded>
    </Modal>
  )
}

// ------------------------------------------------------------------ Rateio

interface Expense { id: number; description: string; total_cents: number; competence: string; due_date: string; method: string; cancelled_at: string | null; property_name: string; units: number }
interface Prop { id: number; name: string }

export function RateioTab({ isAdmin, onChange }: { isAdmin: boolean; onChange: () => void }) {
  const s = useLoad(() => request<{ items: Expense[] }>('/api/shared-expenses'))
  const props = useLoad(() => request<{ items: Prop[] }>('/api/properties'))
  const [creating, setCreating] = useState(false)
  const [viewing, setViewing] = useState<Expense | null>(null)

  return (
    <div className="stack">
      <div className="actions"><button className="primary" onClick={() => setCreating(true)}>Novo rateio</button></div>
      <p className="muted small">Divide uma despesa (água, luz da área comum…) entre as unidades com contrato vigente no mês e gera uma cobrança por unidade.</p>
      <Loaded state={s}>
        {(d) => (
          <Table rows={d.items} onRow={setViewing} empty="Nenhum rateio lançado." cols={[
            { head: 'Despesa', cell: (e) => <>{e.description}{e.cancelled_at && <span className="badge"> cancelado</span>}</> },
            { head: 'Imóvel', cell: (e) => e.property_name },
            { head: 'Competência', cell: (e) => e.competence.slice(0, 7) },
            { head: 'Método', cell: (e) => (e.method === 'area' ? 'Por área' : 'Partes iguais') },
            { head: 'Unidades', cell: (e) => e.units, className: 'num' },
            { head: 'Total', cell: (e) => money(e.total_cents), className: 'num' },
          ]} />
        )}
      </Loaded>
      {creating && (
        <FormModal
          title="Novo rateio"
          submitLabel="Ratear"
          fields={[
            { name: 'property_id', label: 'Imóvel', type: 'select', required: true, options: (props.data?.items ?? []).map((p) => ({ value: String(p.id), label: p.name })) },
            { name: 'month', label: 'Mês de competência', type: 'text', required: true, placeholder: 'AAAA-MM', hint: 'Ex.: 2026-11' },
            { name: 'description', label: 'Descrição', required: true, placeholder: 'Conta de água' },
            { name: 'total_cents', label: 'Valor total', type: 'money', required: true },
            { name: 'method', label: 'Divisão', type: 'select', required: true, options: [{ value: 'igual', label: 'Partes iguais' }, { value: 'area', label: 'Proporcional à área (m²)' }] },
            { name: 'due_date', label: 'Vencimento', type: 'date', hint: 'Vazio = dia 10 do mês' },
          ]}
          initial={{ method: 'igual' }}
          onSubmit={async (b) => {
            const r = await request<{ units: number }>('/api/shared-expenses', json('POST', { ...b, property_id: Number(b.property_id) }))
            toast.success(`Rateio lançado em ${r.units} unidade(s).`)
            await s.reload()
            onChange()
          }}
          onClose={() => setCreating(false)}
        />
      )}
      {viewing && <ExpenseModal e={viewing} isAdmin={isAdmin} onClose={() => setViewing(null)} onChanged={() => { setViewing(null); void s.reload(); onChange() }} />}
    </div>
  )
}

interface Share { unit_id: number; amount_cents: number; status: string; paid_cents: number; unit_identifier: string; tenant_names: string }
function ExpenseModal({ e, isAdmin, onClose, onChanged }: { e: Expense; isAdmin: boolean; onClose: () => void; onChanged: () => void }) {
  const s = useLoad(() => request<{ shares: Share[] }>(`/api/shared-expenses/${e.id}`))
  const [error, setError] = useState('')
  async function cancel() {
    if (!(await ask(`Cancelar o rateio "${e.description}"? As cobranças geradas serão canceladas.`, { title: 'Cancelar rateio', confirmLabel: 'Cancelar rateio', danger: true }))) return
    try {
      await request(`/api/shared-expenses/${e.id}/cancel`, json('POST'))
      toast.success('Rateio cancelado.')
      onChanged()
    } catch (err) {
      setError(errorText(err))
    }
  }
  return (
    <Modal title={e.description} subtitle={`${e.property_name} · ${e.competence.slice(0, 7)} · ${money(e.total_cents)}`} size="md" onClose={onClose}
      footer={isAdmin && !e.cancelled_at ? <button className="danger" onClick={cancel}>Cancelar rateio</button> : undefined}>
      {error && <Alert>{error}</Alert>}
      <Loaded state={s}>
        {(d) => (
          <Table rows={d.shares.map((x) => ({ ...x, id: x.unit_id }))} cols={[
            { head: 'Unidade', cell: (x) => x.unit_identifier },
            { head: 'Locatário', cell: (x) => x.tenant_names },
            { head: 'Valor', cell: (x) => money(x.amount_cents), className: 'num' },
            { head: 'Situação', cell: (x) => x.status },
          ]} />
        )}
      </Loaded>
    </Modal>
  )
}

// ------------------------------------------------------------------ Configurações

interface Settings { admin_fee_bps: number; late_fee_bps: number; late_interest_bps: number; late_grace_days: number; prorata_enabled: boolean }

export function SettingsTab({ isAdmin }: { isAdmin: boolean }) {
  const s = useLoad(() => request<Settings>('/api/settings/finance'))
  const [editing, setEditing] = useState(false)
  const [preview, setPreview] = useState<{ fees: number; interests: number; amountCents: number } | null>(null)
  const [error, setError] = useState('')
  const pct = (bps: number) => `${(bps / 100).toString().replace('.', ',')}%`

  async function run(dry: boolean) {
    setError('')
    try {
      const r = await request<{ fees: number; interests: number; amountCents: number }>('/api/charges/late-fees/run', json('POST', { dry_run: dry }))
      if (dry) setPreview(r)
      else toast.success(`Gerado: ${r.fees} multa(s) e ${r.interests} juros (${money(r.amountCents)}).`)
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <div className="stack">
      <Loaded state={s}>
        {(d) => (
          <>
            <div className="panel stack">
              <h3>Regras financeiras</h3>
              <dl className="view-grid">
                <div><dt>Taxa de administração</dt><dd>{pct(d.admin_fee_bps)} dos aluguéis recebidos</dd></div>
                <div><dt>Multa por atraso</dt><dd>{d.late_fee_bps ? `${pct(d.late_fee_bps)} (uma vez)` : 'Desligada'}</dd></div>
                <div><dt>Juros de mora</dt><dd>{d.late_interest_bps ? `${pct(d.late_interest_bps)} a cada 30 dias de atraso` : 'Desligados'}</dd></div>
                <div><dt>Carência</dt><dd>{d.late_grace_days} dia(s) após o vencimento</dd></div>
                <div><dt>Pro rata (primeiro e último mês)</dt><dd>{d.prorata_enabled ? 'Ligado' : 'Desligado: mês cheio'}</dd></div>
              </dl>
              {isAdmin && <div className="actions"><button className="primary" onClick={() => setEditing(true)}>Alterar regras</button></div>}
              <p className="muted small">Multa e juros nascem como cobranças próprias (com boleto, pagamento e recibo). Rodam sozinhos junto com os lembretes. Confira se o percentual combina com o contrato: o sistema só calcula o que você configurou.</p>
            </div>
            {isAdmin && (
              <div className="panel stack">
                <h3>Aplicar multa e juros agora</h3>
                {error && <Alert>{error}</Alert>}
                {preview && <p role="status" className="notice">Seriam criados: {preview.fees} multa(s) e {preview.interests} juros, somando {money(preview.amountCents)}.</p>}
                <div className="actions">
                  <button onClick={() => run(true)}>Simular</button>
                  <button className="primary" onClick={async () => { if (await ask('Criar agora as multas e juros devidos?', { title: 'Aplicar encargos', confirmLabel: 'Aplicar' })) await run(false) }}>Aplicar</button>
                </div>
              </div>
            )}
            {editing && (
              <FormModal
                title="Regras financeiras"
                fields={[
                  { name: 'admin_fee_pct', label: 'Taxa de administração (%)', type: 'number', hint: 'Ex.: 10' },
                  { name: 'late_fee_pct', label: 'Multa por atraso (%)', type: 'number', hint: 'Ex.: 2. Zero desliga.' },
                  { name: 'late_interest_pct', label: 'Juros a cada 30 dias (%)', type: 'number', hint: 'Ex.: 1. Zero desliga.' },
                  { name: 'late_grace_days', label: 'Carência (dias)', type: 'number', min: 0, max: 30 },
                  { name: 'prorata_enabled', label: 'Proporcional no primeiro e no último mês do contrato', type: 'check' },
                ]}
                initial={{ admin_fee_pct: d.admin_fee_bps / 100, late_fee_pct: d.late_fee_bps / 100, late_interest_pct: d.late_interest_bps / 100, late_grace_days: d.late_grace_days, prorata_enabled: d.prorata_enabled }}
                onSubmit={async (b) => {
                  const bps = (v: unknown) => Math.round(Number(v ?? 0) * 100)
                  await request('/api/settings/finance', json('PUT', { admin_fee_bps: bps(b.admin_fee_pct), late_fee_bps: bps(b.late_fee_pct), late_interest_bps: bps(b.late_interest_pct), late_grace_days: Number(b.late_grace_days ?? 0), prorata_enabled: b.prorata_enabled }))
                  toast.success('Regras salvas.')
                  await s.reload()
                }}
                onClose={() => setEditing(false)}
              />
            )}
          </>
        )}
      </Loaded>
    </div>
  )
}
