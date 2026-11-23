import { useEffect, useState } from 'react'
import { comm, type DashboardData } from './commApi'
import { brl } from './format'
import Icon from './Icon'

const message = (e: unknown) => (e instanceof Error ? e.message : 'Erro inesperado')

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
const monthName = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} de ${ym.slice(0, 4)}`

const KIND_NAV: Record<string, string> = { maintenance: 'maintenance', inspection: 'inspections' }

/** Painel inicial da equipe: números do mês, o que pede atenção agora e atalhos. */
export default function Dashboard({ name, onNavigate }: { name: string; onNavigate: (key: string) => void }) {
  const [d, setD] = useState<DashboardData | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    comm.dashboard().then(setD).catch((e) => setError(message(e)))
  }, [])

  if (error) return <p className="error" role="alert">{error}</p>
  if (!d) return <p className="muted">Carregando…</p>

  const { counts: c, finance: f } = d
  const occupancy = c.units.total > 0 ? Math.round((c.units.occupied / c.units.total) * 100) : null
  const empty = c.properties === 0

  return (
    <section>
      <div className="page-head">
        <h2>Olá, {name.split(' ')[0]}</h2>
        <span className="muted">Visão geral · {monthName(d.month)}</span>
      </div>

      {empty && (
        <div className="panel stack" style={{ marginBottom: '1rem' }}>
          <h3 style={{ margin: 0 }}>Vamos começar</h3>
          <p className="muted" style={{ margin: 0 }}>
            Cadastre o primeiro imóvel e as unidades, depois os inquilinos. Com isso você já gera contratos e cobranças.
          </p>
          <div className="quick">
            <button className="primary" onClick={() => onNavigate('properties')}>Cadastrar imóvel</button>
            <button onClick={() => onNavigate('owners')}>Cadastrar proprietário</button>
            <button onClick={() => onNavigate('tenants')}>Cadastrar inquilino</button>
          </div>
        </div>
      )}

      <div className="dash-grid">
        <div className="stat">
          <span>Ocupação</span>
          <strong>{occupancy === null ? '—' : `${occupancy}%`}</strong>
          <small className="muted">{c.units.occupied} de {c.units.total} unidades · {c.units.available} disponível(is)</small>
        </div>
        <div className="stat">
          <span>Contratos vigentes</span>
          <strong>{c.leases.active}</strong>
          <small className="muted">{c.leases.ending_60d > 0 ? `${c.leases.ending_60d} terminam em até 60 dias` : 'Nenhum termina em 60 dias'}</small>
        </div>
        <div className="stat">
          <span>Recebido no mês</span>
          <strong>{brl(f.received_cents)}</strong>
          <small className="muted">de {brl(f.expected_cents)} previstos{f.received_ratio !== null ? ` · ${f.received_ratio.toLocaleString('pt-BR')}%` : ''}</small>
        </div>
        <div className={f.overdue_cents > 0 ? 'stat danger-stat' : 'stat'}>
          <span>Em atraso</span>
          <strong>{brl(f.overdue_cents)}</strong>
          <small className="muted">{f.overdue_count} cobrança(s)</small>
        </div>
        <div className="stat">
          <span>Chamados abertos</span>
          <strong>{c.maintenance.open}</strong>
          <small className="muted">{c.maintenance.urgent} urgente(s) · {c.maintenance.waiting_approval} aguardando aprovação</small>
        </div>
        <div className="stat">
          <span>Vistorias pendentes</span>
          <strong>{c.inspections_pending}</strong>
          <small className="muted">agendadas ou em andamento</small>
        </div>
      </div>

      <div className="dash-cols">
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Pede atenção agora</h3>
          {d.attention.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>Nada urgente. Tudo em dia por aqui.</p>
          ) : (
            <ul className="attention">
              {d.attention.map((a, i) => (
                <li key={`${a.link_kind}-${a.link_id}-${i}`}>
                  <span className="feature-icon" style={{ width: 36, height: 36 }}>
                    <Icon name={a.kind === 'maintenance' ? 'wrench' : 'camera'} size={18} />
                  </span>
                  <span className="grow">
                    <strong>{a.title}</strong>
                    <span className="muted small">{a.detail}</span>
                  </span>
                  <button onClick={() => onNavigate(KIND_NAV[a.link_kind] ?? 'home')}>Abrir</button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Atalhos</h3>
          <div className="quick">
            <button onClick={() => onNavigate('finance')}>Gerar cobranças</button>
            <button onClick={() => onNavigate('leases')}>Novo contrato</button>
            <button onClick={() => onNavigate('maintenance')}>Novo chamado</button>
            <button onClick={() => onNavigate('inspections')}>Nova vistoria</button>
            <button onClick={() => onNavigate('announcements')}>Novo comunicado</button>
          </div>
        </div>
      </div>
    </section>
  )
}
