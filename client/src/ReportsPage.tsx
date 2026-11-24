import { useState } from 'react'
import { request } from './api'
import { download, Loaded, Stat, Table, Tabs, dateOnly, money, useLoad } from './kit'

/** Relatórios gerenciais: inadimplência, DRE por imóvel, fluxo de caixa, informe de rendimentos e planilha de apoio da DIMOB. */

type Tab = 'delinquency' | 'dre' | 'cashflow' | 'owner' | 'dimob'
const thisMonth = () => new Date().toLocaleDateString('sv-SE').slice(0, 7)
const monthsAgo = (n: number) => {
  const d = new Date()
  d.setMonth(d.getMonth() - n)
  return d.toLocaleDateString('sv-SE').slice(0, 7)
}

interface Delinquency {
  as_of: string
  total_cents: number
  count: number
  delinquency_ratio: number | null
  aging_cents: Record<string, number>
  by_tenant: { tenant: string; count: number; cents: number; oldest: number }[]
  items: { id: number; description: string; due_date: string; open_cents: number; days: number; tenant_names: string | null; property_name: string; unit_identifier: string }[]
}
interface Dre {
  note: string
  totals: Record<string, number>
  items: { property_id: number; property_name: string; rent_cents: number; late_fees_cents: number; other_cents: number; admin_fee_cents: number; maintenance_cents: number; maintenance_owner_cents: number; owner_net_cents: number }[]
}
interface Cash {
  note: string
  items: { month: string; expected_cents: number; still_open_cents: number; received_cents: number; transfers_paid_cents: number; maintenance_paid_cents: number; net_cents: number; accumulated_cents: number }[]
}

export default function ReportsPage() {
  const [tab, setTab] = useState<Tab>('delinquency')
  return (
    <section>
      <div className="page-head">
        <h2>Relatórios</h2>
        <span className="muted">Regime de caixa: o que foi recebido e pago no período.</span>
      </div>
      <Tabs
        tabs={[['delinquency', 'Inadimplência'], ['dre', 'DRE por imóvel'], ['cashflow', 'Fluxo de caixa'], ['owner', 'Informe do proprietário'], ['dimob', 'DIMOB (apoio)']] as const}
        value={tab}
        onChange={setTab}
      />
      {tab === 'delinquency' && <DelinquencyTab />}
      {tab === 'dre' && <DreTab />}
      {tab === 'cashflow' && <CashTab />}
      {tab === 'owner' && <OwnerTab />}
      {tab === 'dimob' && <DimobTab />}
    </section>
  )
}

function DelinquencyTab() {
  const s = useLoad(() => request<Delinquency>('/api/reports/delinquency'))
  return (
    <Loaded state={s}>
      {(d) => (
        <div className="stack">
          <div className="dash-grid">
            <Stat label="Total em atraso" value={money(d.total_cents)} tone={d.total_cents > 0 ? 'danger' : undefined} hint={`${d.count} cobrança(s)${d.delinquency_ratio !== null ? ` · ${d.delinquency_ratio}% do vencido em 12 meses` : ''}`} />
            {Object.entries(d.aging_cents).map(([k, v]) => <Stat key={k} label={`${k} dias`} value={money(v)} />)}
          </div>
          <div className="actions"><button onClick={() => download('/api/reports/delinquency?format=csv', 'inadimplencia.csv')}>Baixar CSV</button></div>
          <h3>Por locatário</h3>
          <Table rows={d.by_tenant.map((t, i) => ({ ...t, id: i }))} empty="Ninguém em atraso. 🎉" cols={[
            { head: 'Locatário', cell: (t) => t.tenant },
            { head: 'Cobranças', cell: (t) => t.count, className: 'num' },
            { head: 'Maior atraso', cell: (t) => `${t.oldest} dias`, className: 'num' },
            { head: 'Em aberto', cell: (t) => money(t.cents), className: 'num' },
          ]} />
          <h3>Cobranças vencidas</h3>
          <Table rows={d.items} empty="Nada vencido." cols={[
            { head: 'Locatário', cell: (r) => r.tenant_names },
            { head: 'Imóvel', cell: (r) => `${r.property_name} · ${r.unit_identifier}` },
            { head: 'Cobrança', cell: (r) => r.description },
            { head: 'Vencimento', cell: (r) => dateOnly(r.due_date) },
            { head: 'Atraso', cell: (r) => `${r.days} d`, className: 'num' },
            { head: 'Em aberto', cell: (r) => money(r.open_cents), className: 'num' },
          ]} />
        </div>
      )}
    </Loaded>
  )
}

function Range({ from, to, onFrom, onTo }: { from: string; to: string; onFrom: (v: string) => void; onTo: (v: string) => void }) {
  return (
    <div className="form-grid" style={{ maxWidth: 420 }}>
      <label>De<input type="month" value={from} onChange={(e) => onFrom(e.target.value)} /></label>
      <label>Até<input type="month" value={to} onChange={(e) => onTo(e.target.value)} /></label>
    </div>
  )
}

function DreTab() {
  const [from, setFrom] = useState(monthsAgo(11))
  const [to, setTo] = useState(thisMonth())
  const s = useLoad(() => request<Dre>(`/api/reports/dre?from=${from}&to=${to}`), [from, to])
  return (
    <div className="stack">
      <Range from={from} to={to} onFrom={setFrom} onTo={setTo} />
      <Loaded state={s}>
        {(d) => (
          <>
            <div className="dash-grid">
              <Stat label="Aluguéis recebidos" value={money(d.totals.rent_cents)} />
              <Stat label="Taxa de administração" value={money(d.totals.admin_fee_cents)} hint="estimada" />
              <Stat label="Manutenção (total)" value={money(d.totals.maintenance_cents)} hint={`${money(d.totals.maintenance_owner_cents)} cobrados do proprietário`} />
              <Stat label="Líquido dos proprietários" value={money(d.totals.owner_net_cents)} />
            </div>
            <div className="actions"><button onClick={() => download(`/api/reports/dre?from=${from}&to=${to}&format=csv`, 'dre-por-imovel.csv')}>Baixar CSV</button></div>
            <Table rows={d.items.map((i) => ({ ...i, id: i.property_id }))} empty="Nenhum recebimento no período." cols={[
              { head: 'Imóvel', cell: (r) => r.property_name },
              { head: 'Aluguéis', cell: (r) => money(r.rent_cents), className: 'num' },
              { head: 'Multa/juros', cell: (r) => money(r.late_fees_cents), className: 'num' },
              { head: 'Outras taxas', cell: (r) => money(r.other_cents), className: 'num' },
              { head: 'Taxa adm.', cell: (r) => money(r.admin_fee_cents), className: 'num' },
              { head: 'Manutenção', cell: (r) => money(r.maintenance_cents), className: 'num' },
              { head: 'Líquido do prop.', cell: (r) => money(r.owner_net_cents), className: 'num' },
            ]} />
            <p className="muted small">{d.note}</p>
          </>
        )}
      </Loaded>
    </div>
  )
}

function CashTab() {
  const [from, setFrom] = useState(monthsAgo(5))
  const [to, setTo] = useState(thisMonth())
  const s = useLoad(() => request<Cash>(`/api/reports/cashflow?from=${from}&to=${to}`), [from, to])
  return (
    <div className="stack">
      <Range from={from} to={to} onFrom={setFrom} onTo={setTo} />
      <Loaded state={s}>
        {(d) => {
          const max = Math.max(1, ...d.items.flatMap((i) => [i.expected_cents, i.received_cents]))
          return (
            <>
              <div className="bars" role="img" aria-label="Previsto e recebido por mês">
                {d.items.map((i) => (
                  <div key={i.month} className="bar-col" title={`${i.month}: previsto ${money(i.expected_cents)}, recebido ${money(i.received_cents)}`}>
                    <span className="bar expected" style={{ height: `${(i.expected_cents / max) * 100}%` }} />
                    <span className="bar received" style={{ height: `${(i.received_cents / max) * 100}%` }} />
                    <small>{i.month.slice(5)}/{i.month.slice(2, 4)}</small>
                  </div>
                ))}
              </div>
              <p className="muted small"><span className="legend expected" /> previsto (vencimentos) · <span className="legend received" /> recebido</p>
              <div className="actions"><button onClick={() => download(`/api/reports/cashflow?from=${from}&to=${to}&format=csv`, 'fluxo-de-caixa.csv')}>Baixar CSV</button></div>
              <Table rows={d.items.map((i) => ({ ...i, id: i.month }))} cols={[
                { head: 'Mês', cell: (r) => r.month },
                { head: 'Previsto', cell: (r) => money(r.expected_cents), className: 'num' },
                { head: 'Em aberto', cell: (r) => money(r.still_open_cents), className: 'num' },
                { head: 'Recebido', cell: (r) => money(r.received_cents), className: 'num' },
                { head: 'Repasses pagos', cell: (r) => money(r.transfers_paid_cents), className: 'num' },
                { head: 'Manutenção paga', cell: (r) => money(r.maintenance_paid_cents), className: 'num' },
                { head: 'Resultado', cell: (r) => money(r.net_cents), className: 'num' },
                { head: 'Acumulado', cell: (r) => money(r.accumulated_cents), className: 'num' },
              ]} />
              <p className="muted small">{d.note}</p>
            </>
          )
        }}
      </Loaded>
    </div>
  )
}

interface Owner { id: number; name: string }
function OwnerTab() {
  const owners = useLoad(() => request<{ items: Owner[] }>('/api/owners'))
  const [ownerId, setOwnerId] = useState('')
  const [year, setYear] = useState(String(new Date().getFullYear() - 1))
  return (
    <div className="stack">
      <div className="form-grid" style={{ maxWidth: 520 }}>
        <label>Proprietário
          <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            <option value="">Escolha…</option>
            {owners.data?.items.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
        <label>Ano<input type="number" min={2000} max={2100} value={year} onChange={(e) => setYear(e.target.value)} /></label>
      </div>
      {ownerId && <OwnerIncome ownerId={ownerId} year={year} />}
    </div>
  )
}

interface Income { totals: Record<string, number>; note: string; owner: { name: string; document: string }; items: { month: string; gross: number; fee: number; maintenance: number; net: number; status: string; paid_at: string | null }[] }
function OwnerIncome({ ownerId, year }: { ownerId: string; year: string }) {
  const s = useLoad(() => request<Income>(`/api/reports/owner-income?owner_id=${ownerId}&year=${year}`), [ownerId, year])
  return (
    <Loaded state={s}>
      {(d) => (
        <>
          <div className="dash-grid">
            <Stat label="Aluguéis recebidos" value={money(d.totals.gross_cents)} />
            <Stat label="Taxa de administração" value={money(d.totals.fee_cents)} />
            <Stat label="Manutenção descontada" value={money(d.totals.maintenance_cents)} />
            <Stat label="Repasse líquido" value={money(d.totals.net_cents)} hint={`${money(d.totals.net_paid_cents)} já pago`} />
          </div>
          <div className="actions no-print">
            <button onClick={() => download(`/api/reports/owner-income?owner_id=${ownerId}&year=${year}&format=csv`, `informe-${year}.csv`)}>Baixar CSV</button>
            <button onClick={() => window.print()}>Imprimir / salvar PDF</button>
          </div>
          <Table rows={d.items.map((i) => ({ ...i, id: i.month }))} empty="Sem repasses neste ano." cols={[
            { head: 'Mês', cell: (r) => r.month },
            { head: 'Recebido', cell: (r) => money(r.gross), className: 'num' },
            { head: 'Taxa', cell: (r) => money(r.fee), className: 'num' },
            { head: 'Manutenção', cell: (r) => money(r.maintenance), className: 'num' },
            { head: 'Líquido', cell: (r) => money(r.net), className: 'num' },
            { head: 'Situação', cell: (r) => (r.status === 'pago' ? `Pago em ${dateOnly(r.paid_at)}` : 'Pendente') },
          ]} />
          <p className="muted small">{d.owner.name} · {d.owner.document}. {d.note}</p>
        </>
      )}
    </Loaded>
  )
}

interface Dimob { note: string; items: { id: number; owners: string | null; tenants: string | null; property: string; start_date: string; end_date: string; total_cents: number }[] }
function DimobTab() {
  const [year, setYear] = useState(String(new Date().getFullYear() - 1))
  const s = useLoad(() => request<Dimob>(`/api/reports/dimob?year=${year}`), [year])
  return (
    <div className="stack">
      <label style={{ maxWidth: 160 }}>Ano<input type="number" min={2000} max={2100} value={year} onChange={(e) => setYear(e.target.value)} /></label>
      <Loaded state={s}>
        {(d) => (
          <>
            <div className="actions"><button onClick={() => download(`/api/reports/dimob?year=${year}&format=csv`, `dimob-apoio-${year}.csv`)}>Baixar planilha (CSV)</button></div>
            <Table rows={d.items} empty="Nenhum contrato no ano." cols={[
              { head: 'Contrato', cell: (r) => `nº ${r.id}` },
              { head: 'Locador(es)', cell: (r) => r.owners },
              { head: 'Locatário(s)', cell: (r) => r.tenants },
              { head: 'Imóvel', cell: (r) => r.property },
              { head: 'Recebido no ano', cell: (r) => money(r.total_cents), className: 'num' },
            ]} />
            <p className="muted small">{d.note}</p>
          </>
        )}
      </Loaded>
    </div>
  )
}
