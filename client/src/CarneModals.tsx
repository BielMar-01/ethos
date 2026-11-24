import { useState } from 'react'
import { request } from './api'
import { Alert, ask, errorText, toast } from './feedback'
import { Loaded, Table, dateOnly, json, money, useLoad } from './kit'
import Modal from './Modal'

/** Boleto manual em lote: carnê do contrato (gera vários meses de uma vez) e baixa em lote (marca vários como pagos, com recibo). */

interface LeaseOpt { id: number; unit_identifier: string; property_name: string; tenant_names: string | null; status: string; start_date: string; end_date: string }
const thisMonth = () => new Date().toLocaleDateString('sv-SE').slice(0, 7)
const addMonths = (ym: string, n: number) => {
  const d = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + n, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function useLeases() {
  return useLoad(() => request<{ items: LeaseOpt[] }>('/api/leases'))
}
const label = (l: LeaseOpt) => `${l.property_name} · ${l.unit_identifier} — ${l.tenant_names ?? 'sem locatário'}`

export function CarneModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const leases = useLeases()
  const [leaseId, setLeaseId] = useState('')
  const [from, setFrom] = useState(thisMonth())
  const [to, setTo] = useState(addMonths(thisMonth(), 11))
  const [gen, setGen] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<null | { months: number; charges_created: number; boletos_created: number; failed: { label: string; error: string }[]; remaining: number }>(null)

  async function run() {
    if (!(await ask('Gerar o carnê? Serão criadas as cobranças de aluguel dos meses escolhidos (as que já existem são mantidas) e um boleto manual para cada uma.', { title: 'Carnê do contrato', confirmLabel: 'Gerar carnê' }))) return
    setBusy(true)
    setError('')
    try {
      setDone(await request(`/api/leases/${leaseId}/carne`, json('POST', { from, to, generate_charges: gen })))
      onDone()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Carnê do contrato" subtitle="Boletos manuais de vários meses, de uma vez" size="md" onClose={onClose} locked={busy}>
      <div className="stack">
        <p className="muted small">Escolha o contrato e o período. Não precisa de Asaas nem de banco: são <strong>guias de cobrança do Ethos</strong> (ou, depois, você edita cada uma para colocar a linha digitável do banco). Pode repetir sem medo: nada é duplicado.</p>
        <Loaded state={leases}>
          {(d) => (
            <label>Contrato
              <select value={leaseId} onChange={(e) => setLeaseId(e.target.value)}>
                <option value="">Escolha…</option>
                {d.items.filter((l) => l.status === 'vigente').map((l) => <option key={l.id} value={l.id}>{label(l)}</option>)}
              </select>
            </label>
          )}
        </Loaded>
        <div className="form-grid">
          <label>Do mês<input type="month" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>Até o mês<input type="month" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
        <label className="check"><input type="checkbox" checked={gen} onChange={(e) => setGen(e.target.checked)} /> Gerar também as cobranças de aluguel que ainda não existem nesses meses</label>
        {error && <Alert>{error}</Alert>}
        {done && (
          <div className="notice stack" role="status">
            <strong>Pronto: {done.boletos_created} boleto(s) criado(s)</strong>
            <span>{done.months} mês(es) no período · {done.charges_created} cobrança(s) nova(s).{done.remaining > 0 ? ` Ainda faltam ${done.remaining}: rode de novo.` : ''}</span>
            {done.failed.length > 0 && <ul className="plain-list">{done.failed.map((f) => <li key={f.label}>{f.label}: {f.error}</li>)}</ul>}
          </div>
        )}
        <div className="actions">
          <button onClick={onClose}>{done ? 'Fechar' : 'Cancelar'}</button>
          <button className="primary" disabled={busy || !leaseId || from > to} onClick={run}>{busy ? 'Gerando…' : 'Gerar carnê'}</button>
        </div>
      </div>
    </Modal>
  )
}

interface Open { id: number; description: string; due_date: string; amount_cents: number; status: string; unit_identifier: string; tenant_names: string | null }

export function BulkPayModal({ month, onClose, onDone }: { month: string; onClose: () => void; onDone: () => void }) {
  const leases = useLeases()
  const [scope, setScope] = useState<'month' | 'lease'>('month')
  const [leaseId, setLeaseId] = useState('')
  const [mode, setMode] = useState<'due' | 'date'>('due')
  const [paidAt, setPaidAt] = useState(new Date().toLocaleDateString('sv-SE'))
  const [register, setRegister] = useState(true)
  const target = scope === 'month' ? { month } : { lease_id: Number(leaseId) }
  const ready = scope === 'month' || Boolean(leaseId)
  const preview = useLoad(() => (ready ? request<{ eligible: number; items: Open[]; remaining: number }>('/api/boletos/paid-bulk', json('POST', { ...target, dry_run: true })) : Promise.resolve({ eligible: 0, items: [] as Open[], remaining: 0 })), [scope, leaseId, month])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<null | { paid: number; payments: number; failed: { boleto_id: number; error: string }[]; notes: { note: string }[]; remaining: number }>(null)

  async function run() {
    const n = preview.data?.eligible ?? 0
    const msg = `Dar baixa em ${n} boleto(s)?${register ? ' Será emitido um recibo e dada a baixa em cada cobrança.' : ' Só os boletos serão marcados como pagos; as cobranças continuam em aberto até você registrar o recebimento.'} Isso não pode ser desfeito em lote (estorne pelo pagamento, se precisar).`
    if (!(await ask(msg, { title: 'Baixa em lote', confirmLabel: 'Dar baixa' }))) return
    setBusy(true)
    setError('')
    try {
      setResult(await request('/api/boletos/paid-bulk', json('POST', { ...target, use_due_date: mode === 'due', paid_at: mode === 'date' ? paidAt : undefined, register_payment: register })))
      toast.success('Baixa em lote concluída.')
      onDone()
      await preview.reload()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Dar baixa em lote" subtitle="Boletos manuais em aberto" size="lg" onClose={onClose} locked={busy}>
      <div className="stack">
        <div className="form-grid">
          <label>O que baixar
            <select value={scope} onChange={(e) => setScope(e.target.value as 'month' | 'lease')}>
              <option value="month">Todos os boletos manuais que vencem em {month.slice(5)}/{month.slice(0, 4)}</option>
              <option value="lease">Todos os boletos manuais em aberto de um contrato</option>
            </select>
          </label>
          {scope === 'lease' && (
            <Loaded state={leases}>
              {(d) => (
                <label>Contrato
                  <select value={leaseId} onChange={(e) => setLeaseId(e.target.value)}>
                    <option value="">Escolha…</option>
                    {d.items.map((l) => <option key={l.id} value={l.id}>{label(l)}</option>)}
                  </select>
                </label>
              )}
            </Loaded>
          )}
          <label>Data do pagamento
            <select value={mode} onChange={(e) => setMode(e.target.value as 'due' | 'date')}>
              <option value="due">Cada um no próprio vencimento (pagou em dia)</option>
              <option value="date">Uma data única para todos</option>
            </select>
          </label>
          {mode === 'date' && <label>Pago em<input type="date" value={paidAt} max={new Date().toLocaleDateString('sv-SE')} onChange={(e) => setPaidAt(e.target.value)} /></label>}
        </div>
        <label className="check"><input type="checkbox" checked={register} onChange={(e) => setRegister(e.target.checked)} /> Registrar o recebimento (emite o recibo e dá a baixa nas cobranças)</label>
        {error && <Alert>{error}</Alert>}
        {ready && (
          <Loaded state={preview}>
            {(d) => (
              <>
                <p><strong>{d.eligible}</strong> boleto(s) serão baixados{d.remaining > 0 ? ` (mais ${d.remaining} ficam para a próxima rodada; máx. 100 por vez)` : ''}.</p>
                <Table rows={d.items} empty="Nenhum boleto manual em aberto neste filtro." cols={[
                  { head: 'Locatário', cell: (b) => b.tenant_names },
                  { head: 'Unidade', cell: (b) => b.unit_identifier },
                  { head: 'Cobrança', cell: (b) => b.description },
                  { head: 'Vence', cell: (b) => dateOnly(b.due_date) },
                  { head: 'Valor', cell: (b) => money(b.amount_cents), className: 'num' },
                ]} />
              </>
            )}
          </Loaded>
        )}
        {result && (
          <div className="notice stack" role="status">
            <strong>{result.paid} baixado(s){result.payments ? `, ${result.payments} recibo(s) emitido(s)` : ''}.</strong>
            {result.notes.length > 0 && <span>{result.notes.length} sem recibo: {result.notes[0]!.note}</span>}
            {result.failed.length > 0 && <span>{result.failed.length} falharam: {result.failed[0]!.error}</span>}
            {result.remaining > 0 && <span>Faltam {result.remaining}: rode de novo.</span>}
          </div>
        )}
        <div className="actions">
          <button onClick={onClose}>Fechar</button>
          <button className="primary" disabled={busy || !ready || !(preview.data?.eligible ?? 0)} onClick={run}>{busy ? 'Baixando…' : 'Dar baixa'}</button>
        </div>
      </div>
    </Modal>
  )
}
