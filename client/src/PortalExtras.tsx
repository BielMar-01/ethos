import { useState } from 'react'
import { request } from './api'
import { Alert, errorText, toast } from './feedback'
import { FormModal, Loaded, Stat, Table, dateOnly, json, money, useLoad } from './kit'
import { brl } from './format'

/** Área do cliente: segunda via de boletos, ocorrências, enquetes, informe do proprietário e resumo dos imóveis. */

interface TBoleto { id: number; description: string; amount_cents: number; due_date: string; status: string; provider: string; identification_field: string | null; our_number: string | null; url: string | null; text: string }

export function TenantBoletos() {
  const s = useLoad(() => request<{ items: TBoleto[] }>('/api/portal/tenant/boletos'))
  return (
    <Loaded state={s}>
      {(d) => d.items.length === 0 ? null : (
        <div className="stack">
          <h3>Boletos em aberto (2ª via)</h3>
          {d.items.map((b) => (
            <div key={b.id} className="panel stack">
              <strong>{b.description} · {brl(b.amount_cents)} · vence {dateOnly(b.due_date)} {b.status === 'vencida' && <span className="badge badge-c-vencida">vencido</span>}</strong>
              {b.identification_field && <div className="inline"><code style={{ flex: 1, overflowWrap: 'anywhere' }}>{b.identification_field}</code><button onClick={() => navigator.clipboard.writeText(b.identification_field!).then(() => toast.success('Linha digitável copiada.'))}>Copiar</button></div>}
              <div className="actions">
                {b.url && <a className="btn primary" href={b.url} target="_blank" rel="noopener noreferrer">Abrir boleto</a>}
                <button onClick={() => navigator.clipboard.writeText(b.text).then(() => toast.success('Dados copiados.'))}>Copiar dados</button>
              </div>
              {!b.identification_field && !b.url && <p className="muted small">Este documento é a guia de cobrança da administradora. Peça a ela os dados de pagamento.</p>}
            </div>
          ))}
        </div>
      )}
    </Loaded>
  )
}

interface Inc { id: number; category: string; description: string; occurred_at: string; status: string; fine_cents: number | null; contestation: string | null; unit_identifier: string }
const CAT: Record<string, string> = { barulho: 'Barulho', animais: 'Animais', dano: 'Dano ao imóvel', lixo: 'Lixo/limpeza', estacionamento: 'Estacionamento', outro: 'Outro' }

export function TenantIncidents() {
  const s = useLoad(() => request<{ items: Inc[] }>('/api/portal/tenant/incidents'))
  const [contesting, setContesting] = useState<Inc | null>(null)
  return (
    <Loaded state={s}>
      {(d) => (
        <div className="stack">
          <p className="muted small">Ocorrências registradas pela administradora sobre a sua unidade. Se discordar, você pode contestar uma vez.</p>
          <Table rows={d.items} empty="Nenhuma ocorrência. 👍" cols={[
            { head: 'Quando', cell: (i) => new Date(i.occurred_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) },
            { head: 'Tipo', cell: (i) => CAT[i.category] },
            { head: 'O que aconteceu', cell: (i) => i.description },
            { head: 'Multa', cell: (i) => money(i.fine_cents), className: 'num' },
            { head: '', cell: (i) => i.contestation ? <span className="badge">contestada</span> : i.status === 'notificada' || i.status === 'multada' ? <button onClick={() => setContesting(i)}>Contestar</button> : null },
          ]} />
          {contesting && (
            <FormModal
              title="Contestar ocorrência"
              submitLabel="Enviar contestação"
              fields={[{ name: 'text', label: 'Explique o seu lado', type: 'textarea', required: true }]}
              intro={<p className="muted small">{contesting.description}</p>}
              onSubmit={async (b) => {
                await request(`/api/portal/tenant/incidents/${contesting.id}/contest`, json('POST', b))
                toast.success('Contestação enviada à administradora.')
                await s.reload()
              }}
              onClose={() => setContesting(null)}
            />
          )}
        </div>
      )}
    </Loaded>
  )
}

interface CPoll { id: number; question: string; description: string | null; anonymous: boolean; closes_at: string | null; status: string; my_vote: number | null; options: { id: number; label: string }[]; results: { total_votes: number; options: { id: number; label: string; votes: number; percent: number }[] } | null }

export function ClientPolls() {
  const s = useLoad(() => request<{ items: CPoll[] }>('/api/portal/polls'))
  const [error, setError] = useState('')
  async function vote(p: CPoll, optionId: number) {
    setError('')
    try {
      await request(`/api/portal/polls/${p.id}/vote`, json('POST', { option_id: optionId }))
      toast.success('Voto registrado.')
      await s.reload()
    } catch (e) {
      setError(errorText(e))
    }
  }
  return (
    <Loaded state={s}>
      {(d) => (
        <div className="stack">
          {error && <Alert>{error}</Alert>}
          {d.items.length === 0 && <p className="empty">Nenhuma enquete para você agora.</p>}
          {d.items.map((p) => (
            <div key={p.id} className="panel stack">
              <strong>{p.question}</strong>
              {p.description && <p className="muted">{p.description}</p>}
              <p className="muted small">{p.status === 'aberta' ? `Aberta${p.closes_at ? ` até ${new Date(p.closes_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}` : ''}` : 'Encerrada'}{p.anonymous ? ' · voto anônimo' : ''}</p>
              {p.results ? p.results.options.map((o) => (
                <div key={o.id}>
                  <div className="inline"><span style={{ flex: 1 }}>{o.label}{p.my_vote === o.id && ' ✓ (seu voto)'}</span><span>{o.votes} · {o.percent}%</span></div>
                  <div className="meter" role="progressbar" aria-valuenow={o.percent} aria-valuemin={0} aria-valuemax={100} aria-label={o.label}><span style={{ width: `${o.percent}%` }} /></div>
                </div>
              )) : (
                <div className="actions left">{p.options.map((o) => <button key={o.id} onClick={() => vote(p, o.id)}>{o.label}</button>)}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </Loaded>
  )
}

interface Income { year: number; totals: Record<string, number>; note: string; items: { month: string; gross: number; fee: number; maintenance: number; net: number; status: string; paid_at: string | null }[] }

export function OwnerIncome() {
  const [year, setYear] = useState(String(new Date().getFullYear() - 1))
  const s = useLoad(() => request<Income>(`/api/portal/owner/income?year=${year}`), [year])
  return (
    <div className="stack">
      <label style={{ maxWidth: 160 }}>Ano<input type="number" min={2000} max={2100} value={year} onChange={(e) => setYear(e.target.value)} /></label>
      <Loaded state={s}>
        {(d) => (
          <>
            <div className="dash-grid">
              <Stat label="Aluguéis recebidos" value={money(d.totals.gross_cents)} />
              <Stat label="Taxa de administração" value={money(d.totals.fee_cents)} />
              <Stat label="Manutenção descontada" value={money(d.totals.maintenance_cents)} />
              <Stat label="Repasse líquido" value={money(d.totals.net_cents)} hint={`${money(d.totals.net_paid_cents)} já pago`} />
            </div>
            <div className="actions no-print"><button onClick={() => window.print()}>Imprimir / salvar PDF</button></div>
            <Table rows={d.items.map((i) => ({ ...i, id: i.month }))} empty="Sem repasses neste ano." cols={[
              { head: 'Mês', cell: (r) => r.month },
              { head: 'Recebido', cell: (r) => money(r.gross), className: 'num' },
              { head: 'Taxa', cell: (r) => money(r.fee), className: 'num' },
              { head: 'Manutenção', cell: (r) => money(r.maintenance), className: 'num' },
              { head: 'Líquido', cell: (r) => money(r.net), className: 'num' },
              { head: 'Situação', cell: (r) => (r.status === 'pago' ? `Pago em ${dateOnly(r.paid_at)}` : 'Pendente') },
            ]} />
            <p className="muted small">{d.note}</p>
          </>
        )}
      </Loaded>
    </div>
  )
}

interface Summary { note: string; items: { property_id: number; property_name: string; units: number; occupied: number; leases_ending_60d: number; maintenance_open: number; residents: number; visits_30d: number; parcels_30d: number }[] }

export function OwnerSummary() {
  const s = useLoad(() => request<Summary>('/api/portal/owner/summary'))
  return (
    <Loaded state={s}>
      {(d) => (
        <div className="stack">
          <Table rows={d.items.map((i) => ({ ...i, id: i.property_id }))} empty="Nenhum imóvel vinculado." cols={[
            { head: 'Imóvel', cell: (i) => i.property_name },
            { head: 'Ocupação', cell: (i) => `${i.occupied}/${i.units}`, className: 'num' },
            { head: 'Contratos terminando (60 d)', cell: (i) => i.leases_ending_60d, className: 'num' },
            { head: 'Chamados abertos', cell: (i) => i.maintenance_open, className: 'num' },
            { head: 'Moradores', cell: (i) => i.residents, className: 'num' },
            { head: 'Visitas (30 d)', cell: (i) => i.visits_30d, className: 'num' },
            { head: 'Encomendas (30 d)', cell: (i) => i.parcels_30d, className: 'num' },
          ]} />
          <p className="muted small">{d.note}</p>
        </div>
      )}
    </Loaded>
  )
}

