import { useState } from 'react'
import { request } from './api'
import { ask, errorText, toast } from './feedback'
import { FormModal, Loaded, Stat, Table, download, json, useLoad } from './kit'

/** Portaria: encomendas e relatório de acessos. */

interface Parcel { id: number; unit_id: number; description: string; carrier: string | null; recipient_name: string | null; status: string; received_at: string; picked_up_at: string | null; picked_up_by_name: string | null; unit_identifier: string; property_name: string; tenant_names: string | null }
const STATUS: Record<string, string> = { recebida: 'Aguardando retirada', retirada: 'Retirada', devolvida: 'Devolvida' }
const when = (s: string) => new Date(s).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })

export function ParcelsPanel() {
  const [status, setStatus] = useState('recebida')
  const s = useLoad(() => request<{ items: Parcel[] }>(`/api/parcels?status=${status}`), [status])
  const units = useLoad(() => request<{ items: { id: number; identifier: string }[] }>('/api/units'))
  const [creating, setCreating] = useState(false)
  const [picking, setPicking] = useState<Parcel | null>(null)

  async function giveBack(p: Parcel) {
    if (!(await ask(`Registrar "${p.description}" como devolvida ao transportador?`, { confirmLabel: 'Devolvida' }))) return
    try {
      await request(`/api/parcels/${p.id}/return`, json('POST'))
      await s.reload()
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  return (
    <div className="stack">
      <div className="inline">
        <select aria-label="Situação" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="recebida">Aguardando retirada</option>
          <option value="retirada">Retiradas</option>
          <option value="devolvida">Devolvidas</option>
          <option value="all">Todas</option>
        </select>
        <button className="primary" onClick={() => setCreating(true)}>Registrar encomenda</button>
      </div>
      <Loaded state={s}>
        {(d) => (
          <Table rows={d.items} empty="Nenhuma encomenda aqui." cols={[
            { head: 'Chegou', cell: (p) => when(p.received_at) },
            { head: 'Unidade', cell: (p) => `${p.property_name} · ${p.unit_identifier}` },
            { head: 'Encomenda', cell: (p) => `${p.description}${p.carrier ? ` (${p.carrier})` : ''}` },
            { head: 'Morador', cell: (p) => p.recipient_name ?? p.tenant_names ?? '—' },
            { head: 'Situação', cell: (p) => (p.status === 'retirada' ? `Retirada por ${p.picked_up_by_name} em ${when(p.picked_up_at!)}` : STATUS[p.status]) },
            { head: '', cell: (p) => p.status === 'recebida' ? <span className="row-actions"><button className="primary" onClick={() => setPicking(p)}>Entregar</button><button onClick={() => giveBack(p)}>Devolver</button></span> : null },
          ]} />
        )}
      </Loaded>
      {creating && (
        <FormModal
          title="Registrar encomenda"
          fields={[
            { name: 'unit_id', label: 'Unidade', type: 'select', required: true, options: (units.data?.items ?? []).map((u) => ({ value: String(u.id), label: u.identifier })) },
            { name: 'description', label: 'O que é', required: true, placeholder: 'Caixa média' },
            { name: 'carrier', label: 'Transportadora' },
            { name: 'recipient_name', label: 'Em nome de' },
            { name: 'notes', label: 'Observações', type: 'textarea' },
          ]}
          intro={<p className="muted small">O morador é avisado na hora (sino, e-mail e push, conforme as preferências dele).</p>}
          onSubmit={async (b) => {
            await request('/api/parcels', json('POST', { ...b, unit_id: Number(b.unit_id) }))
            toast.success('Encomenda registrada e morador avisado.')
            await s.reload()
          }}
          onClose={() => setCreating(false)}
        />
      )}
      {picking && (
        <FormModal
          title={`Entregar — ${picking.description}`}
          submitLabel="Registrar entrega"
          fields={[{ name: 'picked_up_by_name', label: 'Quem retirou', required: true }]}
          onSubmit={async (b) => {
            await request(`/api/parcels/${picking.id}/pickup`, json('POST', b))
            toast.success('Entrega registrada.')
            await s.reload()
          }}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  )
}

/** Inquilino: encomendas da própria unidade. */
export function TenantParcels() {
  const s = useLoad(() => request<{ items: Parcel[] }>('/api/portal/tenant/parcels'))
  return (
    <Loaded state={s}>
      {(d) => (
        <div className="stack">
          <p className="muted small">Encomendas recebidas na portaria para a sua unidade.</p>
          <Table rows={d.items} empty="Nenhuma encomenda." cols={[
            { head: 'Chegou', cell: (p) => when(p.received_at) },
            { head: 'Encomenda', cell: (p) => `${p.description}${p.carrier ? ` (${p.carrier})` : ''}` },
            { head: 'Situação', cell: (p) => (p.status === 'retirada' ? `Retirada por ${p.picked_up_by_name}` : STATUS[p.status]) },
          ]} />
        </div>
      )}
    </Loaded>
  )
}

// ------------------------------------------------------------------ Relatório de acessos

interface Report { from: string; to: string; total: number; still_inside: number; by_category: Record<string, number>; items: { entry_at: string; exit_at: string | null; minutes: number | null; name: string; category: string; unit: string; property: string }[] }
const CAT: Record<string, string> = { visitante: 'Visitante', familiar: 'Familiar', prestador: 'Prestador', entregador: 'Entregador', outro: 'Outro' }

export function AccessReport() {
  const today = new Date().toLocaleDateString('sv-SE')
  const monthStart = `${today.slice(0, 8)}01`
  const [from, setFrom] = useState(monthStart)
  const [to, setTo] = useState(today)
  const s = useLoad(() => request<Report>(`/api/access/report?from=${from}&to=${to}`), [from, to])
  return (
    <div className="stack">
      <div className="form-grid" style={{ maxWidth: 420 }}>
        <label>De<input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>Até<input type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <Loaded state={s}>
        {(d) => (
          <>
            <div className="dash-grid">
              <Stat label="Entradas no período" value={d.total} />
              <Stat label="Ainda dentro" value={d.still_inside} />
              {Object.entries(d.by_category).map(([k, v]) => <Stat key={k} label={CAT[k] ?? k} value={v} />)}
            </div>
            <div className="actions"><button onClick={() => download(`/api/access/report?from=${from}&to=${to}&format=csv`, 'acessos.csv')}>Baixar CSV</button></div>
            <Table rows={d.items.map((i, n) => ({ ...i, id: n }))} empty="Nenhum acesso no período." cols={[
              { head: 'Entrada', cell: (i) => when(i.entry_at) },
              { head: 'Saída', cell: (i) => (i.exit_at ? when(i.exit_at) : 'dentro') },
              { head: 'Tempo', cell: (i) => (i.minutes === null ? '—' : `${i.minutes} min`), className: 'num' },
              { head: 'Visitante', cell: (i) => `${i.name} (${CAT[i.category] ?? i.category})` },
              { head: 'Unidade', cell: (i) => `${i.property} · ${i.unit}` },
            ]} />
          </>
        )}
      </Loaded>
    </div>
  )
}
