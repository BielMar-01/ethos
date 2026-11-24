import { request } from './api'
import { Alert, Loading } from './feedback'
import { money, useLoad } from './kit'

/** Indicadores do painel: arrecadação, ocupação e manutenção dos últimos meses. */
interface Kpis {
  items: { month: string; expected_cents: number; received_cents: number; collection_ratio: number | null; occupancy_ratio: number | null; new_leases: number; maintenance_opened: number; maintenance_done: number }[]
  overdue_cents: number
  avg_maintenance_hours: number | null
  received_change_ratio: number | null
}

const pct = (v: number | null) => (v === null ? '—' : `${v.toString().replace('.', ',')}%`)

export default function KpiPanel() {
  const s = useLoad(() => request<Kpis>('/api/reports/kpis?months=6'))
  if (s.error) return <Alert>{s.error}</Alert>
  if (!s.data) return <Loading label="Carregando indicadores…" />
  const d = s.data
  const max = Math.max(1, ...d.items.flatMap((i) => [i.expected_cents, i.received_cents]))
  const last = d.items[d.items.length - 1]!
  return (
    <div className="panel stack" aria-labelledby="kpi-title" style={{ marginTop: '1rem' }}>
      <h3 id="kpi-title" style={{ margin: 0 }}>Indicadores dos últimos 6 meses</h3>
      <div className="dash-grid">
        <div className="stat"><span>Arrecadação do mês</span><strong>{pct(last.collection_ratio)}</strong><small className="muted">{money(last.received_cents)} de {money(last.expected_cents)} previstos</small></div>
        <div className="stat"><span>Recebido vs. mês anterior</span><strong>{d.received_change_ratio === null ? '—' : `${d.received_change_ratio > 0 ? '+' : ''}${pct(d.received_change_ratio)}`}</strong></div>
        <div className="stat"><span>Ocupação</span><strong>{pct(last.occupancy_ratio)}</strong><small className="muted">{last.new_leases} contrato(s) novo(s) no mês</small></div>
        <div className="stat"><span>Tempo médio de manutenção</span><strong>{d.avg_maintenance_hours === null ? '—' : d.avg_maintenance_hours >= 48 ? `${Math.round(d.avg_maintenance_hours / 24)} dias` : `${d.avg_maintenance_hours} h`}</strong><small className="muted">{last.maintenance_opened} aberto(s), {last.maintenance_done} concluído(s) no mês</small></div>
      </div>
      <div className="bars" role="img" aria-label="Previsto e recebido nos últimos 6 meses">
        {d.items.map((i) => (
          <div key={i.month} className="bar-col" title={`${i.month}: previsto ${money(i.expected_cents)}, recebido ${money(i.received_cents)}`}>
            <span className="bar expected" style={{ height: `${(i.expected_cents / max) * 100}%` }} />
            <span className="bar received" style={{ height: `${(i.received_cents / max) * 100}%` }} />
            <small>{i.month.slice(5)}/{i.month.slice(2, 4)}</small>
          </div>
        ))}
      </div>
      <p className="muted small"><span className="legend expected" /> previsto · <span className="legend received" /> recebido · em atraso hoje: <strong>{money(d.overdue_cents)}</strong></p>
    </div>
  )
}
