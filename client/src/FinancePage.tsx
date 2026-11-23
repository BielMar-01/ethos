import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  api,
  type Charge,
  type ChargeStatus,
  type FinanceSummary,
  type LeaseSummary,
  type Payment,
  type Transfer,
} from './api'
import { brl, date, parseReais, reaisInput } from './format'
import { Alert, Toast, Loading, ask } from './feedback'
import Modal from './Modal'

const message = (e: unknown) => (e instanceof Error ? e.message : 'Erro inesperado')
const today = () => new Date().toLocaleDateString('sv-SE') // AAAA-MM-DD no fuso local
const thisMonth = () => today().slice(0, 7)

const STATUS_LABEL: Record<ChargeStatus, string> = {
  aberta: 'Em aberto',
  parcial: 'Parcial',
  vencida: 'Em atraso',
  paga: 'Paga',
  cancelada: 'Cancelada',
}
const METHODS = [
  ['pix', 'Pix'],
  ['boleto', 'Boleto'],
  ['transferencia', 'Transferência'],
  ['dinheiro', 'Dinheiro'],
  ['cartao', 'Cartão'],
  ['outro', 'Outro'],
] as const
const KINDS = [
  ['multa', 'Multa'],
  ['juros', 'Juros'],
  ['taxa', 'Taxa'],
  ['outro', 'Outro'],
  ['aluguel', 'Aluguel (avulso)'],
] as const

type Tab = 'charges' | 'payments' | 'transfers'

export default function FinancePage({ isAdmin }: { isAdmin: boolean }) {
  const [tab, setTab] = useState<Tab>('charges')
  const [month, setMonth] = useState(thisMonth())
  const [summary, setSummary] = useState<FinanceSummary | null>(null)
  const [version, setVersion] = useState(0) // incrementa para recarregar abas e resumo
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [receipt, setReceipt] = useState<{ title: string; content: string } | null>(null)

  useEffect(() => {
    api
      .financeSummary(month)
      .then(setSummary)
      .catch((e) => setError(message(e)))
  }, [month, version])
  // (o resumo não depende de `fail`, evitando refazer a busca a cada mensagem)

  // Identidade estável: estas funções entram nas dependências dos efeitos das abas.
  const reload = useCallback(() => setVersion((v) => v + 1), [])
  const fail = useCallback((e: unknown) => {
    setNotice('')
    setError(message(e))
  }, [])
  const ok = useCallback((text: string) => {
    setError('')
    setNotice(text)
  }, [])

  async function openReceipt(id: number) {
    try {
      const r = await api.payment(id)
      const p = r.payment
      setReceipt({
        title: `Recibo nº ${p.receipt_number}${p.voided_at ? ' — ESTORNADO' : ''}`,
        content: p.voided_at ? `*** PAGAMENTO ESTORNADO (${p.void_reason}) ***\n\n${p.receipt_content}` : p.receipt_content,
      })
    } catch (e) {
      fail(e)
    }
  }

  return (
    <section>
      <div className="page-head no-print">
        <h2>Financeiro</h2>
        <label className="inline-label">
          Mês
          <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        </label>
      </div>

      {summary && (
        <div className="cards no-print">
          <div className="stat"><span>Previsto</span><strong>{brl(summary.expected_cents)}</strong></div>
          <div className="stat">
            <span>Recebido (das cobranças do mês)</span>
            <strong>{brl(summary.received_cents)}</strong>
            {summary.received_ratio !== null && <small>{summary.received_ratio.toLocaleString('pt-BR')}%</small>}
          </div>
          <div className="stat danger-stat">
            <span>Em atraso (total)</span>
            <strong>{brl(summary.overdue_cents)}</strong>
            <small>{summary.overdue_count} cobrança(s)</small>
          </div>
          <div className="stat"><span>Entrou em caixa no mês</span><strong>{brl(summary.cash_received_cents)}</strong></div>
        </div>
      )}

      {error && <Alert className="no-print">{error}</Alert>}
      {notice && <Toast>{notice}</Toast>}

      {receipt && (
        <Modal size="md" onClose={() => setReceipt(null)}>
        <div className="print-area">
          <div className="paper-head no-print">
            <strong>{receipt.title}</strong>
            <div className="actions">
              <button onClick={() => setReceipt(null)}>Fechar</button>
              <button className="primary" onClick={() => window.print()}>Imprimir / salvar PDF</button>
            </div>
          </div>
          <article className="paper">{receipt.content}</article>
        </div>
        </Modal>
      )}

      <div className="tabs no-print" role="tablist">
        {([['charges', 'Cobranças'], ['payments', 'Pagamentos'], ['transfers', 'Repasses']] as const).map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'tab active' : 'tab'} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      <div className="no-print">
        {tab === 'charges' && <ChargesTab month={month} version={version} isAdmin={isAdmin} onChange={reload} onError={fail} onOk={ok} onReceipt={openReceipt} />}
        {tab === 'payments' && <PaymentsTab month={month} version={version} isAdmin={isAdmin} onChange={reload} onError={fail} onOk={ok} onReceipt={openReceipt} />}
        {tab === 'transfers' && <TransfersTab month={month} version={version} isAdmin={isAdmin} onChange={reload} onError={fail} onOk={ok} />}
      </div>
    </section>
  )
}

interface TabProps {
  month: string
  version: number
  isAdmin: boolean
  onChange: () => void
  onError: (e: unknown) => void
  onOk: (text: string) => void
}

// ------------------------------------------------------------------- Cobranças

function ChargesTab({ month, version, isAdmin, onChange, onError, onOk, onReceipt }: TabProps & { onReceipt: (id: number) => void }) {
  const [items, setItems] = useState<Charge[]>([])
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<'' | ChargeStatus>('')
  const [paying, setPaying] = useState<Charge | null>(null)
  const [adding, setAdding] = useState(false)
  const [viewing, setViewing] = useState<Charge | null>(null)

  useEffect(() => {
    api
      .charges(`month=${month}${status ? `&status=${status}` : ''}`)
      .then((r) => setItems(r.items))
      .catch(onError)
      .finally(() => setLoading(false))
  }, [month, status, version, onError])

  async function generate() {
    try {
      const r = await api.generateCharges(month)
      onOk(`${r.created} cobrança(s) gerada(s); ${r.skipped} já existia(m). Contratos elegíveis: ${r.eligible}.`)
      onChange()
    } catch (e) {
      onError(e)
    }
  }

  async function cancel(c: Charge) {
    if (!(await ask(`Cancelar a cobrança "${c.description}" de ${c.tenant_names}?`))) return
    try {
      await api.cancelCharge(c.id)
      onChange()
    } catch (e) {
      onError(e)
    }
  }

  return (
    <>
      <div className="toolbar">
        <select aria-label="Filtrar por situação" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="">Todas as situações</option>
          {(Object.keys(STATUS_LABEL) as ChargeStatus[]).map((s) => (
            <option key={s} value={s}>{STATUS_LABEL[s]}</option>
          ))}
        </select>
        <span className="spacer" />
        <button onClick={() => setAdding(true)}>Nova cobrança avulsa</button>
        <button className="primary" onClick={generate}>Gerar aluguéis do mês</button>
      </div>

      {adding && (
        <Modal title="Nova cobrança avulsa" onClose={() => setAdding(false)}>
          <NewCharge onDone={() => { setAdding(false); onChange() }} onCancel={() => setAdding(false)} onError={onError} />
        </Modal>
      )}
      {paying && (
        <Modal title="Receber pagamento" subtitle={`${paying.description} · ${paying.tenant_names}`} onClose={() => setPaying(null)}>
          <ReceivePayment
            charge={paying}
            onCancel={() => setPaying(null)}
            onDone={(id) => { setPaying(null); onOk('Pagamento registrado e baixa efetuada.'); onChange(); onReceipt(id) }}
            onError={onError}
          />
        </Modal>
      )}
      {viewing && (
        <Modal
          title={viewing.description}
          subtitle={`${viewing.property_name} · ${viewing.unit_identifier}`}
          size="sm"
          onClose={() => setViewing(null)}
          footer={
            <>
              <button onClick={() => setViewing(null)}>Fechar</button>
              {isAdmin && viewing.status !== 'cancelada' && viewing.paid_cents === 0 && (
                <button
                  className="danger"
                  onClick={() => {
                    const c = viewing
                    setViewing(null)
                    void cancel(c)
                  }}
                >
                  Cancelar cobrança
                </button>
              )}
              {(viewing.status === 'aberta' || viewing.status === 'parcial' || viewing.status === 'vencida') && (
                <button
                  className="primary"
                  onClick={() => {
                    const c = viewing
                    setViewing(null)
                    setPaying(c)
                  }}
                >
                  Receber
                </button>
              )}
            </>
          }
        >
          <dl className="view-grid">
            <div className="wide"><dt>Locatário</dt><dd>{viewing.tenant_names}</dd></div>
            <div><dt>Vencimento</dt><dd>{date(viewing.due_date)}</dd></div>
            <div><dt>Situação</dt><dd><span className={`badge badge-c-${viewing.status}`}>{STATUS_LABEL[viewing.status]}</span></dd></div>
            <div><dt>Valor</dt><dd>{brl(viewing.amount_cents)}</dd></div>
            <div><dt>Pago</dt><dd>{brl(viewing.paid_cents)}</dd></div>
            <div><dt>Saldo</dt><dd>{brl(Math.max(0, viewing.amount_cents - viewing.paid_cents))}</dd></div>
          </dl>
        </Modal>
      )}

      {loading ? (
        <Loading label="Carregando…" />
      ) : items.length === 0 ? (
        <p className="empty">Nenhuma cobrança neste mês. Use “Gerar aluguéis do mês” para criá-las a partir dos contratos vigentes.</p>
      ) : (
        <div className="panel table-wrap">
          <table>
            <thead>
              <tr><th>Vencimento</th><th>Imóvel / locatário</th><th>Descrição</th><th>Valor</th><th>Pago</th><th>Situação</th><th /></tr>
            </thead>
            <tbody>
              {items.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => setViewing(c)}>
                  <td>{date(c.due_date)}</td>
                  <td>{c.property_name} · {c.unit_identifier}<div className="muted small">{c.tenant_names}</div></td>
                  <td>{c.description}</td>
                  <td>{brl(c.amount_cents)}</td>
                  <td>{brl(c.paid_cents)}</td>
                  <td><span className={`badge badge-c-${c.status}`}>{STATUS_LABEL[c.status]}</span></td>
                  <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                    {(c.status === 'aberta' || c.status === 'parcial' || c.status === 'vencida') && (
                      <button onClick={() => setPaying(c)}>Receber</button>
                    )}
                    {isAdmin && c.status !== 'cancelada' && c.paid_cents === 0 && (
                      <button className="danger" onClick={() => cancel(c)}>Cancelar</button>
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

function NewCharge({ onDone, onCancel, onError }: { onDone: () => void; onCancel: () => void; onError: (e: unknown) => void }) {
  const [leases, setLeases] = useState<LeaseSummary[]>([])
  const [leaseId, setLeaseId] = useState('')
  const [kind, setKind] = useState('multa')
  const [description, setDescription] = useState('')
  const [due, setDue] = useState(today())
  const [amount, setAmount] = useState('')
  const [formError, setFormError] = useState('')

  useEffect(() => {
    api.leases().then((r) => setLeases(r.items.filter((l) => l.status !== 'rascunho'))).catch(onError)
  }, [onError])

  async function submit(e: FormEvent) {
    e.preventDefault()
    const cents = parseReais(amount)
    if (cents === null) return setFormError('Informe um valor válido (ex.: 150,00).')
    try {
      await api.createCharge({ lease_id: Number(leaseId), kind, description, due_date: due, amount_cents: cents })
      onDone()
    } catch (err) {
      setFormError(message(err))
    }
  }

  return (
    <form className="panel form-grid" onSubmit={submit}>
      <h3>Nova cobrança avulsa</h3>
      <label>Contrato
        <select value={leaseId} onChange={(e) => setLeaseId(e.target.value)} required>
          <option value="">Selecione</option>
          {leases.map((l) => <option key={l.id} value={l.id}>{l.property_name} · {l.unit_identifier} — {l.tenant_names}</option>)}
        </select>
      </label>
      <label>Tipo
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          {KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      <label>Descrição<input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} required /></label>
      <label>Vencimento<input type="date" value={due} onChange={(e) => setDue(e.target.value)} required /></label>
      <label>Valor (R$)<input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="150,00" required /></label>
      {formError && <Alert className="span-all">{formError}</Alert>}
      <div className="actions">
        <button type="button" onClick={onCancel}>Cancelar</button>
        <button type="submit" className="primary">Criar cobrança</button>
      </div>
    </form>
  )
}

/** Registra o pagamento e dá baixa nas cobranças em aberto do mesmo contrato. */
function ReceivePayment({ charge, onDone, onCancel, onError }: { charge: Charge; onDone: (paymentId: number) => void; onCancel: () => void; onError: (e: unknown) => void }) {
  const [open, setOpen] = useState<Charge[]>([])
  const [amounts, setAmounts] = useState<Record<number, string>>({})
  const [received, setReceived] = useState(today())
  const [method, setMethod] = useState('pix')
  const [reference, setReference] = useState('')
  const [formError, setFormError] = useState('')

  useEffect(() => {
    api
      .charges(`lease_id=${charge.lease_id}`)
      .then((r) => {
        const list = r.items.filter((c) => ['aberta', 'parcial', 'vencida'].includes(c.status))
        setOpen(list)
        // Pré-seleciona a cobrança clicada com o saldo em aberto.
        const target = list.find((c) => c.id === charge.id)
        if (target) setAmounts({ [target.id]: reaisInput(target.amount_cents - target.paid_cents) })
      })
      .catch(onError)
  }, [charge, onError])

  const allocations = open
    .map((c) => ({ charge_id: c.id, cents: amounts[c.id] ? parseReais(amounts[c.id]!) : 0 }))
    .filter((a) => amounts[a.charge_id] !== undefined && amounts[a.charge_id] !== '')
  const total = allocations.reduce((s, a) => s + (a.cents ?? 0), 0)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (allocations.length === 0 || allocations.some((a) => a.cents === null)) return setFormError('Informe valores válidos nas cobranças selecionadas.')
    try {
      const r = await api.createPayment({
        lease_id: charge.lease_id,
        received_at: received,
        amount_cents: total,
        method,
        reference: reference.trim() || null,
        allocations: allocations.map((a) => ({ charge_id: a.charge_id, amount_cents: a.cents })),
      })
      onDone(r.payment.id)
    } catch (err) {
      setFormError(message(err))
    }
  }

  return (
    <form className="panel stack" onSubmit={submit}>
      <h3>Registrar pagamento — {charge.tenant_names}</h3>
      <p className="muted small">Marque as cobranças quitadas por este pagamento; o total recebido é a soma das baixas.</p>
      <div className="checks">
        {open.map((c) => (
          <label key={c.id} className="alloc">
            <span>{c.description} <span className="muted">(venc. {date(c.due_date)}, saldo {brl(c.amount_cents - c.paid_cents)})</span></span>
            <input
              aria-label={`Valor para ${c.description}`}
              value={amounts[c.id] ?? ''}
              placeholder="0,00"
              inputMode="decimal"
              onChange={(e) => setAmounts({ ...amounts, [c.id]: e.target.value })}
            />
          </label>
        ))}
      </div>
      <div className="form-grid">
        <label>Recebido em<input type="date" max={today()} value={received} onChange={(e) => setReceived(e.target.value)} required /></label>
        <label>Forma
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            {METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label>Referência (opcional)<input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={200} /></label>
      </div>
      <strong>Total recebido: {brl(total)}</strong>
      {formError && <Alert>{formError}</Alert>}
      <div className="actions">
        <button type="button" onClick={onCancel}>Cancelar</button>
        <button type="submit" className="primary" disabled={total <= 0}>Registrar e emitir recibo</button>
      </div>
    </form>
  )
}

// ------------------------------------------------------------------ Pagamentos

function PaymentsTab({ month, version, isAdmin, onChange, onError, onOk, onReceipt }: TabProps & { onReceipt: (id: number) => void }) {
  const [items, setItems] = useState<Payment[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.payments(month).then((r) => setItems(r.items)).catch(onError).finally(() => setLoading(false))
  }, [month, version, onError])

  async function voidIt(p: Payment) {
    const reason = window.prompt(`Estornar o recibo nº ${p.receipt_number} (${brl(p.amount_cents)})?\nInforme o motivo:`)
    if (!reason?.trim()) return
    try {
      await api.voidPayment(p.id, reason.trim())
      onOk('Pagamento estornado; as cobranças voltaram a ficar em aberto.')
      onChange()
    } catch (e) {
      onError(e)
    }
  }

  if (loading) return <Loading label="Carregando…" />
  if (items.length === 0) return <p className="empty">Nenhum pagamento recebido neste mês.</p>
  return (
    <div className="panel table-wrap">
      <table>
        <thead><tr><th>Recibo</th><th>Recebido em</th><th>Imóvel / locatário</th><th>Forma</th><th>Valor</th><th /></tr></thead>
        <tbody>
          {items.map((p) => (
            <tr key={p.id} className={p.voided_at ? 'voided' : ''}>
              <td>nº {p.receipt_number}{p.voided_at && <span className="badge badge-c-cancelada"> estornado</span>}</td>
              <td>{date(p.received_at)}</td>
              <td>{p.property_name} · {p.unit_identifier}<div className="muted small">{p.tenant_names}</div></td>
              <td>{METHODS.find(([v]) => v === p.method)?.[1] ?? p.method}</td>
              <td>{brl(p.amount_cents)}</td>
              <td className="row-actions">
                <button onClick={() => onReceipt(p.id)}>Recibo</button>
                {isAdmin && !p.voided_at && <button className="danger" onClick={() => voidIt(p)}>Estornar</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// -------------------------------------------------------------------- Repasses

function TransfersTab({ month, version, isAdmin, onChange, onError, onOk }: TabProps) {
  const [items, setItems] = useState<Transfer[]>([])
  const [loading, setLoading] = useState(true)
  const [fee, setFee] = useState('')

  const loadFee = useCallback(() => {
    api.financeSettings().then((r) => setFee(String(r.admin_fee_bps / 100).replace('.', ','))).catch(onError)
  }, [onError])

  useEffect(() => {
    api.transfers(month).then((r) => setItems(r.items)).catch(onError).finally(() => setLoading(false))
  }, [month, version, onError])
  useEffect(() => loadFee(), [loadFee])

  async function generate() {
    try {
      const r = await api.generateTransfers(month)
      const extra = r.withoutOwnerCents > 0 ? ` Atenção: ${brl(r.withoutOwnerCents)} de aluguéis são de imóveis sem proprietário vinculado.` : ''
      onOk(`${r.generated} repasse(s) calculado(s); ${r.alreadyPaid} já pago(s) mantido(s).${extra}`)
      onChange()
    } catch (e) {
      onError(e)
    }
  }

  async function pay(t: Transfer) {
    if (!(await ask(`Marcar como pago o repasse de ${brl(t.net_cents)} para ${t.owner_name}?`))) return
    try {
      await api.payTransfer(t.id)
      onChange()
    } catch (e) {
      onError(e)
    }
  }

  async function saveFee(e: FormEvent) {
    e.preventDefault()
    const pct = Number(fee.replace(',', '.'))
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return onError(new Error('Informe uma taxa entre 0 e 100%.'))
    try {
      await api.saveFinanceSettings(Math.round(pct * 100))
      onOk('Taxa de administração salva. Vale para os próximos repasses gerados.')
    } catch (err) {
      onError(err)
    }
  }

  return (
    <>
      <div className="toolbar">
        {isAdmin && (
          <form className="inline" onSubmit={saveFee}>
            <label className="inline-label">Taxa de administração (%)
              <input className="narrow" value={fee} onChange={(e) => setFee(e.target.value)} inputMode="decimal" />
            </label>
            <button type="submit">Salvar taxa</button>
          </form>
        )}
        <span className="spacer" />
        <button className="primary" onClick={generate}>Calcular repasses do mês</button>
      </div>
      <p className="muted small">
        Considera só aluguéis efetivamente recebidos no mês (baixas de pagamentos não estornados), divididos em partes iguais entre os proprietários do imóvel.
      </p>
      {loading ? (
        <Loading label="Carregando…" />
      ) : items.length === 0 ? (
        <p className="empty">Nenhum repasse calculado para este mês.</p>
      ) : (
        <div className="panel table-wrap">
          <table>
            <thead><tr><th>Proprietário</th><th>Recebido</th><th>Taxa</th><th>A repassar</th><th>Situação</th><th /></tr></thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id}>
                  <td>{t.owner_name}</td>
                  <td>{brl(t.gross_cents)}</td>
                  <td>{brl(t.fee_cents)} <span className="muted small">({t.fee_bps / 100}%)</span></td>
                  <td><strong>{brl(t.net_cents)}</strong></td>
                  <td>{t.status === 'pago' ? <span className="badge badge-c-paga">Pago em {date(t.paid_at!)}</span> : <span className="badge badge-c-aberta">Pendente</span>}</td>
                  <td className="row-actions">{isAdmin && t.status === 'pendente' && <button onClick={() => pay(t)}>Marcar como pago</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
