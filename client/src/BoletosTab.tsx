import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { request } from './api'
import type { Charge } from './api'
import { Alert, Loading, ask, errorText, toast } from './feedback'
import { brl, date } from './format'
import { centsFromMoney, moneyFromCents } from './masks'
import MaskedInput from './MaskedInput'
import Modal from './Modal'

/** Boletos: pelo Asaas (integrado) ou manuais (sem integração), individual e em lote; acompanhamento e cancelamento. */

export type BoletoStatus = 'pendente' | 'vencida' | 'paga' | 'cancelada'
export interface Boleto {
  id: number
  charge_id: number
  status: BoletoStatus
  amount_cents: number
  due_date: string
  invoice_url: string | null
  bank_slip_url: string | null
  identification_field: string | null
  paid_at: string | null
  environment: 'sandbox' | 'production' | 'manual'
  provider: 'asaas' | 'manual'
  our_number: string | null
  notes: string | null
  description: string
  unit_identifier: string
  property_name: string
  tenant_names: string
}
interface BoletoInfo {
  manual?: boolean
  connected: boolean
  environment: 'sandbox' | 'production' | null
  fine_percent: number
  interest_percent: number
}

const LABEL: Record<BoletoStatus, string> = { pendente: 'Aguardando pagamento', vencida: 'Vencido', paga: 'Pago', cancelada: 'Cancelado' }
const json = (method: string, body?: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
const today = () => new Date().toLocaleDateString('sv-SE')
const isOpen = (b: Boleto) => b.status === 'pendente' || b.status === 'vencida'
export const chargeAcceptsBoleto = (c: Pick<Charge, 'status'>) => c.status === 'aberta' || c.status === 'parcial' || c.status === 'vencida'

/** Estado do Asaas + boletos recentes indexados por cobrança (o mais relevante: em aberto > pago > cancelado). */
export function useBoletos(version: number) {
  const [info, setInfo] = useState<BoletoInfo | null>(null)
  const [items, setItems] = useState<Boleto[]>([])
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    Promise.all([request<BoletoInfo>('/api/boletos/status'), request<{ items: Boleto[] }>('/api/boletos')])
      .then(([i, l]) => {
        if (!alive) return
        setInfo(i)
        setItems(l.items)
      })
      .catch(() => alive && setInfo({ connected: false, environment: null, fine_percent: 0, interest_percent: 0 }))
    return () => {
      alive = false
    }
  }, [version, tick])
  const byCharge = useMemo(() => {
    const rank = (b: Boleto) => (isOpen(b) ? 3 : b.status === 'paga' ? 2 : 1)
    const m = new Map<number, Boleto>()
    for (const b of items) {
      const cur = m.get(b.charge_id)
      if (!cur || rank(b) > rank(cur)) m.set(b.charge_id, b)
    }
    return m
  }, [items])
  return { info, byCharge, reload: useCallback(() => setTick((t) => t + 1), []) }
}

function copy(text: string, what: string) {
  navigator.clipboard.writeText(text).then(
    () => toast.success(`${what} copiado.`),
    () => toast.error('Não consegui copiar. Selecione o texto e copie manualmente.'),
  )
}

// ------------------------------------------------------------------------------------------ detalhe

export function BoletoDetail({ boleto, isAdmin, onClose, onChanged }: { boleto: Boleto; isAdmin: boolean; onClose: () => void; onChanged: () => void }) {
  const [b, setB] = useState(boleto)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)

  async function refresh() {
    setBusy(true)
    setError('')
    try {
      const r = await request<{ item: Boleto }>(`/api/boletos/${b.id}/sync`, json('POST'))
      setB(r.item)
      onChanged()
      toast.success(r.item.status === 'paga' ? 'Boleto pago! Registre o recebimento em Pagamentos.' : 'Situação atualizada.')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const manual = b.provider === 'manual'
  async function markPaid() {
    if (!(await ask('Marcar este boleto como pago? Isso só registra a informação no boleto. Para dar baixa na cobrança e emitir o recibo, registre o recebimento em Pagamentos.'))) return
    setBusy(true)
    setError('')
    try {
      const r = await request<{ item: Boleto }>(`/api/boletos/${b.id}/paid`, json('POST'))
      setB(r.item)
      onChanged()
      toast.success('Boleto marcado como pago. Registre o recebimento em Pagamentos.')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  async function cancel() {
    if (!(await ask(manual ? 'Cancelar este boleto? A cobrança continua em aberto e você pode emitir outro.' : 'Cancelar este boleto no Asaas? A cobrança continua em aberto e você pode emitir outro.'))) return
    setBusy(true)
    try {
      await request(`/api/boletos/${b.id}/cancel`, json('POST'))
      toast.success('Boleto cancelado.')
      onChanged()
      onClose()
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  if (editing) {
    return <ManualBoletoForm boleto={b} onClose={() => setEditing(false)} onDone={(item) => { setB(item); setEditing(false); onChanged() }} />
  }

  return (
    <Modal
      title={manual ? 'Boleto manual' : 'Boleto'}
      subtitle={`${b.property_name} · ${b.unit_identifier}`}
      size="md"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Fechar</button>
          {manual && b.status !== 'cancelada' && <button onClick={() => window.print()}>Imprimir guia</button>}
          {manual && isOpen(b) && <button onClick={() => setEditing(true)} disabled={busy}>Editar</button>}
          {manual && isOpen(b) && <button onClick={markPaid} disabled={busy}>Marcar como pago</button>}
          {!manual && isOpen(b) && <button onClick={refresh} disabled={busy}>Atualizar situação</button>}
          {isAdmin && isOpen(b) && <button className="danger" onClick={cancel} disabled={busy}>Cancelar boleto</button>}
          {(b.invoice_url ?? (manual ? b.bank_slip_url : null)) && b.status !== 'cancelada' && (
            <a className="btn primary" href={(b.invoice_url ?? b.bank_slip_url)!} target="_blank" rel="noopener noreferrer">Abrir boleto</a>
          )}
        </>
      }
    >
      {error && <Alert>{error}</Alert>}
      <dl className="view-grid">
        <div className="wide"><dt>Locatário</dt><dd>{b.tenant_names}</dd></div>
        <div className="wide"><dt>Cobrança</dt><dd>{b.description}</dd></div>
        <div><dt>Valor</dt><dd>{brl(b.amount_cents)}</dd></div>
        <div><dt>Vencimento</dt><dd>{date(b.due_date)}</dd></div>
        <div><dt>Situação</dt><dd><span className={`badge badge-b-${b.status}`}>{LABEL[b.status]}</span></dd></div>
        {b.paid_at && <div><dt>Pago em</dt><dd>{date(b.paid_at)}</dd></div>}
        <div><dt>Tipo</dt><dd>{manual ? 'Manual' : 'Asaas'}</dd></div>
        {manual && b.our_number && <div><dt>Nosso número</dt><dd>{b.our_number}</dd></div>}
        {manual && b.notes && <div className="wide"><dt>Observações</dt><dd>{b.notes}</dd></div>}
        {b.environment === 'sandbox' && <div className="wide"><dd className="muted small">Boleto de teste (sandbox): não tem valor real.</dd></div>}
        {b.identification_field && (
          <div className="wide">
            <dt>Linha digitável</dt>
            <dd className="copy-line">
              <code>{b.identification_field}</code>
              <button type="button" onClick={() => copy(b.identification_field!, 'Linha digitável')}>Copiar</button>
            </dd>
          </div>
        )}
      </dl>
      {b.status === 'paga' && <p className="muted small">{manual ? 'Marcado como pago pela equipe.' : 'O Asaas informou o pagamento.'} Para dar baixa na cobrança e emitir o recibo, registre o recebimento em <strong>Pagamentos</strong> (forma: boleto).</p>}
      {manual && !b.identification_field && !b.bank_slip_url && (
        <p className="muted small">Esta é uma <strong>guia de cobrança do Ethos</strong>: serve para informar o locatário (valor, vencimento e referência), mas <strong>não é um boleto bancário</strong> e não pode ser pago em banco.</p>
      )}
    </Modal>
  )
}

// ------------------------------------------------------------------------------------------ manual (formulário)

/** Campos do boleto manual: serve para registrar um boleto emitido fora (banco, outro sistema) ou só a guia do Ethos. */
function ManualBoletoForm({ charge, boleto, onClose, onDone, onSwitch }: { charge?: Charge; boleto?: Boleto; onClose: () => void; onDone: (item: Boleto) => void; onSwitch?: () => void }) {
  const balance = charge ? charge.amount_cents - charge.paid_cents : boleto!.amount_cents
  const [due, setDue] = useState(boleto?.due_date.slice(0, 10) ?? charge!.due_date.slice(0, 10))
  const [amount, setAmount] = useState(moneyFromCents(balance))
  const [field, setField] = useState(boleto?.identification_field ?? '')
  const [ourNumber, setOurNumber] = useState(boleto?.our_number ?? '')
  const [url, setUrl] = useState(boleto?.bank_slip_url ?? '')
  const [notes, setNotes] = useState(boleto?.notes ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const cents = centsFromMoney(amount)
      const body: Record<string, unknown> = { due_date: due, identification_field: field, our_number: ourNumber, url, notes }
      if (!boleto) {
        if (cents === null || cents < 1 || cents > balance) throw new Error(`O valor deve ser de R$ 0,01 até ${brl(balance)}.`)
        body.charge_id = charge!.id
        body.amount_cents = cents
      }
      const r = boleto
        ? await request<{ item: Boleto }>(`/api/boletos/${boleto.id}`, json('PATCH', body))
        : await request<{ item: Boleto }>('/api/boletos/manual', json('POST', body))
      toast.success(boleto ? 'Boleto atualizado.' : 'Boleto manual registrado.')
      onDone(r.item)
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <Modal title={boleto ? 'Editar boleto manual' : 'Boleto manual'} subtitle={charge ? `${charge.description} · ${charge.tenant_names}` : boleto!.description} size="md" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {!boleto && <p className="muted small">Sem integração com banco. Cole os dados de um boleto que você emitiu em outro lugar — ou deixe os campos em branco para gerar só uma <strong>guia de cobrança do Ethos</strong> (não é compensável em banco).</p>}
        <div className="form-grid">
          <label>
            Vencimento
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} required />
          </label>
          {!boleto && (
            <label>
              Valor
              <MaskedInput kind="money" value={amount} onValue={setAmount} aria-label="Valor do boleto R$" />
            </label>
          )}
          <label className="wide">
            Linha digitável (opcional)
            <input value={field} onChange={(e) => setField(e.target.value)} inputMode="numeric" maxLength={70} placeholder="00000.00000 00000.000000 00000.000000 0 00000000000000" />
          </label>
          <label>
            Nosso número (opcional)
            <input value={ourNumber} onChange={(e) => setOurNumber(e.target.value)} maxLength={40} />
          </label>
          <label>
            Link do boleto (opcional)
            <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} maxLength={500} placeholder="https://" />
          </label>
          <label className="wide">
            Observações (opcional)
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} rows={2} />
          </label>
        </div>
        {error && <Alert>{error}</Alert>}
        <div className="actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          {onSwitch && <button type="button" onClick={onSwitch}>Emitir pelo Asaas</button>}
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Salvando…' : boleto ? 'Salvar' : 'Registrar boleto'}</button>
        </div>
      </form>
    </Modal>
  )
}

// ------------------------------------------------------------------------------------------ emitir (individual)

export function IssueBoletoModal({ charge, asaas, onClose, onDone }: { charge: Charge; asaas: boolean; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<'asaas' | 'manual'>(asaas ? 'asaas' : 'manual')
  if (mode === 'manual') return <ManualBoletoForm charge={charge} onClose={onClose} onDone={() => onDone()} onSwitch={asaas ? () => setMode('asaas') : undefined} />
  return <AsaasIssue charge={charge} onClose={onClose} onDone={onDone} onSwitch={() => setMode('manual')} />
}

function AsaasIssue({ charge, onClose, onDone, onSwitch }: { charge: Charge; onClose: () => void; onDone: () => void; onSwitch: () => void }) {
  const balance = charge.amount_cents - charge.paid_cents
  const [due, setDue] = useState(charge.due_date < today() ? today() : charge.due_date)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await request('/api/boletos', json('POST', { charge_id: charge.id, due_date: due }))
      toast.success('Boleto emitido.')
      onDone()
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <Modal title="Emitir boleto" subtitle={`${charge.description} · ${charge.tenant_names}`} size="sm" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <dl className="view-grid">
          <div><dt>Valor do boleto</dt><dd>{brl(balance)}</dd></div>
          <div><dt>Vencimento da cobrança</dt><dd>{date(charge.due_date)}</dd></div>
        </dl>
        <label>
          Vencimento do boleto
          <input type="date" value={due} min={today()} onChange={(e) => setDue(e.target.value)} required />
        </label>
        {charge.due_date < today() && <p className="muted small">A cobrança já venceu: o Asaas não aceita data passada, então sugerimos hoje. Multa e juros (se configurados) são aplicados pelo Asaas.</p>}
        <p className="muted small">O boleto é emitido no Asaas em nome do locatário principal (nome, CPF/CNPJ e e-mail são enviados ao Asaas).</p>
        {error && <Alert>{error}</Alert>}
        <div className="actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="button" onClick={onSwitch}>Registrar manualmente</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Emitindo…' : 'Emitir pelo Asaas'}</button>
        </div>
      </form>
    </Modal>
  )
}

// ------------------------------------------------------------------------------------------ emitir (em lote)

interface BulkResult {
  eligible: number
  created: number
  failed: { charge_id: number; label: string; error: string }[]
  remaining: number
  stopped_by: string | null
}

export function BulkBoletoModal({ month, asaas, onClose, onDone }: { month: string; asaas: boolean; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<'asaas' | 'manual'>(asaas ? 'asaas' : 'manual')
  const [result, setResult] = useState<BulkResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [total, setTotal] = useState(0)

  async function run() {
    setBusy(true)
    setError('')
    try {
      const r = await request<BulkResult>(mode === 'manual' ? '/api/boletos/manual/bulk' : '/api/boletos/bulk', json('POST', { month }))
      setTotal((t) => t + r.created)
      setResult(r)
      onDone()
      if (r.created > 0) toast.success(`${r.created} boleto(s) emitido(s).`)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const [y, m] = month.split('-')
  return (
    <Modal title={mode === 'manual' ? 'Gerar guias em lote' : 'Emitir boletos em lote'} subtitle={`Vencimentos de ${m}/${y}`} size="md" onClose={onClose} locked={busy}>
      {!result ? (
        <div className="stack">
          {asaas && (
            <fieldset className="mode-pick">
              <legend>Como emitir</legend>
              <label><input type="radio" name="bulk-mode" checked={mode === 'asaas'} onChange={() => setMode('asaas')} /> Pelo Asaas (boleto bancário real)</label>
              <label><input type="radio" name="bulk-mode" checked={mode === 'manual'} onChange={() => setMode('manual')} /> Manual (guia de cobrança do Ethos)</label>
            </fieldset>
          )}
          {mode === 'asaas' ? (
            <>
              <p>
                Vamos emitir no Asaas um boleto para <strong>cada cobrança em aberto, parcial ou vencida</strong> de {m}/{y} que ainda não tem boleto. O valor de cada boleto é o saldo da cobrança.
              </p>
              <ul className="muted small">
                <li>Cobranças vencidas recebem vencimento de hoje (o Asaas não aceita data passada).</li>
                <li>Até 100 por vez; se houver mais, basta repetir.</li>
                <li>Quem falhar (ex.: inquilino sem CPF/CNPJ válido) aparece na lista, sem impedir os demais.</li>
              </ul>
            </>
          ) : (
            <>
              <p>
                Vamos criar uma <strong>guia de cobrança manual</strong> para cada cobrança em aberto, parcial ou vencida de {m}/{y} que ainda não tem boleto, com o saldo e o vencimento da cobrança.
              </p>
              <ul className="muted small">
                <li>Não fala com nenhum banco: a guia serve para controle e para informar o locatário; não é um boleto bancário.</li>
                <li>Depois você pode abrir cada uma e acrescentar linha digitável, nosso número ou link de um boleto emitido fora.</li>
                <li>Até 100 por vez; se houver mais, basta repetir.</li>
              </ul>
            </>
          )}
          {error && <Alert>{error}</Alert>}
          <div className="actions">
            <button onClick={onClose}>Cancelar</button>
            <button className="primary" disabled={busy} onClick={run}>{busy ? 'Emitindo… (pode levar um pouco)' : mode === 'manual' ? 'Gerar guias' : 'Emitir boletos'}</button>
          </div>
        </div>
      ) : (
        <div className="stack">
          <p>
            {result.eligible === 0 ? 'Não há cobranças pendentes de boleto neste mês.' : <><strong>{result.created}</strong> boleto(s) emitido(s) agora{total !== result.created ? ` (${total} no total nesta janela)` : ''}.</>}
          </p>
          {result.stopped_by && <Alert>Parei antes do fim: {result.stopped_by}</Alert>}
          {result.failed.length > 0 && (
            <>
              <h4>{result.failed.length} não puderam ser emitidos</h4>
              <ul className="error-list">
                {result.failed.map((f) => (
                  <li key={f.charge_id}>
                    <span className="where">{f.label}</span>
                    {f.error}
                  </li>
                ))}
              </ul>
            </>
          )}
          {result.remaining > 0 && !result.stopped_by && <p className="muted">Ainda faltam {result.remaining}. Clique em “Continuar”.</p>}
          <div className="actions">
            <button onClick={onClose}>Fechar</button>
            {result.remaining > 0 && !result.stopped_by && <button className="primary" disabled={busy} onClick={run}>{busy ? 'Emitindo…' : 'Continuar'}</button>}
          </div>
        </div>
      )}
    </Modal>
  )
}

// ------------------------------------------------------------------------------------------ aba "Boletos"

export default function BoletosTab({ month, version, isAdmin, onChange, onError }: { month: string; version: number; isAdmin: boolean; onChange: () => void; onError: (e: unknown) => void }) {
  const [items, setItems] = useState<Boleto[]>([])
  const [status, setStatus] = useState<'' | BoletoStatus>('')
  const [loading, setLoading] = useState(true)
  const [viewing, setViewing] = useState<Boleto | null>(null)
  const [bulk, setBulk] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [tick, setTick] = useState(0)
  const { info } = useBoletos(version + tick)

  useEffect(() => {
    setLoading(true)
    request<{ items: Boleto[] }>(`/api/boletos?month=${month}${status ? `&status=${status}` : ''}`)
      .then((r) => setItems(r.items))
      .catch(onError)
      .finally(() => setLoading(false))
  }, [month, status, version, tick, onError])

  const reload = () => {
    setTick((t) => t + 1)
    onChange()
  }

  async function syncAll() {
    setSyncing(true)
    try {
      const r = await request<{ checked: number; changed: number; paid: number }>('/api/boletos/sync', json('POST'))
      toast.success(r.checked === 0 ? 'Nenhum boleto em aberto para atualizar.' : `${r.checked} conferido(s): ${r.paid} pago(s), ${r.changed} com mudança.`)
      reload()
    } catch (e) {
      onError(e)
    } finally {
      setSyncing(false)
    }
  }

  return (
    <>
      <div className="toolbar">
        <select aria-label="Filtrar boletos por situação" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="">Todas as situações</option>
          {(Object.keys(LABEL) as BoletoStatus[]).map((s) => (
            <option key={s} value={s}>{LABEL[s]}</option>
          ))}
        </select>
        {info?.environment === 'sandbox' && <span className="badge">Ambiente de testes</span>}
        <span className="spacer" />
        {info?.connected && <button onClick={syncAll} disabled={syncing}>{syncing ? 'Atualizando…' : 'Atualizar situações'}</button>}
        <button className="primary" onClick={() => setBulk(true)}>Emitir boletos do mês</button>
      </div>

      {bulk && <BulkBoletoModal month={month} asaas={Boolean(info?.connected)} onClose={() => setBulk(false)} onDone={reload} />}
      {viewing && <BoletoDetail boleto={viewing} isAdmin={isAdmin} onClose={() => setViewing(null)} onChanged={reload} />}

      {loading ? (
        <Loading label="Carregando…" />
      ) : items.length === 0 ? (
        <p className="empty">Nenhum boleto com vencimento neste mês. Use “Emitir boletos do mês” ou o botão “Emitir boleto” em uma cobrança (funciona com o Asaas ou manualmente).</p>
      ) : (
        <div className="panel table-wrap">
          <table>
            <thead>
              <tr><th>Vencimento</th><th>Imóvel / locatário</th><th>Cobrança</th><th>Valor</th><th>Tipo</th><th>Situação</th><th /></tr>
            </thead>
            <tbody>
              {items.map((b) => (
                <tr key={b.id} className="clickable" onClick={() => setViewing(b)}>
                  <td>{date(b.due_date)}</td>
                  <td>{b.property_name} · {b.unit_identifier}<div className="muted small">{b.tenant_names}</div></td>
                  <td>{b.description}</td>
                  <td>{brl(b.amount_cents)}</td>
                  <td>{b.provider === 'manual' ? 'Manual' : 'Asaas'}</td>
                  <td><span className={`badge badge-b-${b.status}`}>{LABEL[b.status]}</span></td>
                  <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                    {(b.invoice_url ?? b.bank_slip_url) && b.status !== 'cancelada' && (
                      <a className="btn" href={(b.invoice_url ?? b.bank_slip_url)!} target="_blank" rel="noopener noreferrer">Abrir</a>
                    )}
                    <button onClick={() => setViewing(b)}>Ver</button>
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
