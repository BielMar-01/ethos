import ContractDocument, { type DocLayout } from './ContractDocument'
import { useEffect, useState } from 'react'
import {
  api,
  type ChargeStatus,
  type DocSummary,
  type PortalCharge,
  type PortalLease,
  type PortalMe,
  type PortalPayment,
  type PortalProperty,
  type PortalUnit,
  type Role,
  type Transfer,
} from './api'
import { brl, date, dateTime } from './format'
import { ClientAnnouncements, ClientInspections, OwnerMaintenance, TenantMaintenance } from './PortalWork'
import { HouseholdTab } from './PortalHousehold'
import { TenantParcels } from './AccessExtras'
import { ClientPolls, OwnerIncome, OwnerSummary, TenantBoletos, TenantIncidents } from './PortalExtras'
import { Alert, Loading } from './feedback'
import Modal from './Modal'

const message = (e: unknown) => (e instanceof Error ? e.message : 'Erro inesperado')

const STATUS_LABEL: Record<ChargeStatus, string> = {
  aberta: 'Em aberto',
  parcial: 'Parcial',
  vencida: 'Em atraso',
  paga: 'Paga',
  cancelada: 'Cancelada',
}
const METHOD_LABEL: Record<string, string> = {
  pix: 'Pix', boleto: 'Boleto', transferencia: 'Transferência', dinheiro: 'Dinheiro', cartao: 'Cartão', outro: 'Outro',
}

/** Área do cliente: inquilino e proprietário veem apenas o que está ligado ao cadastro deles. */
export default function PortalPage({ role, initialTab }: { role: Role; initialTab?: string }) {
  const [me, setMe] = useState<PortalMe | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api.portalMe().then(setMe).catch((e) => setError(message(e)))
  }, [])

  if (error) return <Alert>{error}</Alert>
  if (!me) return <Loading label="Carregando…" />
  if (!me.linked) {
    return (
      <p className="empty">
        Seu acesso ainda não está vinculado a um cadastro. Fale com a sua administradora para concluir a liberação.
      </p>
    )
  }
  return (
    <section>
      <div className="page-head">
        <h2>Olá, {me.name?.split(' ')[0]}</h2>
        <span className="muted">Área do {role === 'inquilino' ? 'inquilino' : 'proprietário'}</span>
      </div>
      {role === 'inquilino' ? <TenantArea initialTab={initialTab} /> : <OwnerArea initialTab={initialTab} />}
    </section>
  )
}

// ------------------------------------------------------------------ Inquilino

const TENANT_TABS = ['finance', 'contract', 'maintenance', 'inspections', 'household', 'visitors', 'parcels', 'incidents', 'polls', 'announcements'] as const
type TenantTab = (typeof TENANT_TABS)[number]
const OWNER_TABS = ['properties', 'transfers', 'income', 'summary', 'maintenance', 'inspections', 'polls', 'announcements'] as const
type OwnerTab = (typeof OWNER_TABS)[number]

function TenantArea({ initialTab }: { initialTab?: string }) {
  const [tab, setTab] = useState<TenantTab>(TENANT_TABS.find((t) => t === initialTab) ?? 'finance')
  const [leases, setLeases] = useState<PortalLease[]>([])
  const [charges, setCharges] = useState<PortalCharge[]>([])
  const [payments, setPayments] = useState<PortalPayment[]>([])
  const [docs, setDocs] = useState<DocSummary[]>([])
  const [paper, setPaper] = useState<{ title: string; content: string; doc?: { format?: number; layout?: DocLayout | null; number?: string | null } } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([api.portalLeases(), api.portalCharges(), api.portalPayments(), api.portalDocuments()])
      .then(([l, c, p, d]) => {
        setLeases(l.items)
        setCharges(c.items)
        setPayments(p.items)
        setDocs(d.items)
      })
      .catch((e) => setError(message(e)))
  }, [])

  const open = charges.filter((c) => ['aberta', 'parcial', 'vencida'].includes(c.status))
  const owed = open.reduce((s, c) => s + c.amount_cents - c.paid_cents, 0)
  const overdue = open.filter((c) => c.status === 'vencida')
  const next = [...open].sort((a, b) => a.due_date.localeCompare(b.due_date))[0]

  async function openReceipt(id: number) {
    try {
      const r = (await api.portalReceipt(id)).payment
      setPaper({
        title: `Recibo nº ${r.receipt_number}`,
        content: r.voided_at ? `*** PAGAMENTO ESTORNADO (${r.void_reason}) ***\n\n${r.receipt_content}` : r.receipt_content,
      })
    } catch (e) {
      setError(message(e))
    }
  }

  async function openDoc(id: number) {
    try {
      const d = (await api.portalDocument(id)).document
      setPaper({ title: `${d.number ? `${d.number} · ` : ''}${d.template_name} (v${d.template_version})`, content: d.content, doc: { format: d.format, layout: d.layout, number: d.number } })
    } catch (e) {
      setError(message(e))
    }
  }

  return (
    <>
      {error && <Alert className="no-print">{error}</Alert>}

      {paper && (
        <Modal size="md" onClose={() => setPaper(null)}>
        <div className="print-area">
          <div className="paper-head no-print">
            <strong>{paper.title}</strong>
            <div className="actions">
              <button onClick={() => setPaper(null)}>Fechar</button>
              <button className="primary" onClick={() => window.print()}>Imprimir / salvar PDF</button>
            </div>
          </div>
          {paper.doc ? <ContractDocument content={paper.content} {...paper.doc} /> : <article className="paper">{paper.content}</article>}
        </div>
        </Modal>
      )}

      <div className="cards no-print">
        <div className={owed > 0 && overdue.length > 0 ? 'stat danger-stat' : 'stat'}>
          <span>Valor em aberto</span>
          <strong>{brl(owed)}</strong>
          {overdue.length > 0 && <small>{overdue.length} cobrança(s) em atraso</small>}
        </div>
        <div className="stat">
          <span>Próximo vencimento</span>
          <strong>{next ? date(next.due_date) : '—'}</strong>
          {next && <small>{next.description} · {brl(next.amount_cents - next.paid_cents)}</small>}
        </div>
        <div className="stat">
          <span>Contrato</span>
          <strong>{leases.find((l) => l.status === 'vigente') ? 'Vigente' : 'Sem contrato vigente'}</strong>
        </div>
      </div>

      <div className="tabs no-print" role="tablist">
        <button role="tab" aria-selected={tab === 'finance'} className={tab === 'finance' ? 'tab active' : 'tab'} onClick={() => setTab('finance')}>Cobranças e pagamentos</button>
        <button role="tab" aria-selected={tab === 'contract'} className={tab === 'contract' ? 'tab active' : 'tab'} onClick={() => setTab('contract')}>Meu contrato</button>
        <button role="tab" aria-selected={tab === 'maintenance'} className={tab === 'maintenance' ? 'tab active' : 'tab'} onClick={() => setTab('maintenance')}>Manutenção</button>
        <button role="tab" aria-selected={tab === 'inspections'} className={tab === 'inspections' ? 'tab active' : 'tab'} onClick={() => setTab('inspections')}>Vistorias</button>
        <button role="tab" aria-selected={tab === 'household'} className={tab === 'household' ? 'tab active' : 'tab'} onClick={() => setTab('household')}>Moradores</button>
        <button role="tab" aria-selected={tab === 'visitors'} className={tab === 'visitors' ? 'tab active' : 'tab'} onClick={() => setTab('visitors')}>Visitantes</button>
        <button role="tab" aria-selected={tab === 'parcels'} className={tab === 'parcels' ? 'tab active' : 'tab'} onClick={() => setTab('parcels')}>Encomendas</button>
        <button role="tab" aria-selected={tab === 'incidents'} className={tab === 'incidents' ? 'tab active' : 'tab'} onClick={() => setTab('incidents')}>Ocorrências</button>
        <button role="tab" aria-selected={tab === 'polls'} className={tab === 'polls' ? 'tab active' : 'tab'} onClick={() => setTab('polls')}>Enquetes</button>
        <button role="tab" aria-selected={tab === 'announcements'} className={tab === 'announcements' ? 'tab active' : 'tab'} onClick={() => setTab('announcements')}>Comunicados</button>
      </div>

      <div className="no-print">
        {tab === 'parcels' ? (
          <TenantParcels />
        ) : tab === 'incidents' ? (
          <TenantIncidents />
        ) : tab === 'polls' ? (
          <ClientPolls />
        ) : tab === 'household' ? (
          <HouseholdTab kind="residents" />
        ) : tab === 'visitors' ? (
          <HouseholdTab kind="visitors" />
        ) : tab === 'announcements' ? (
          <ClientAnnouncements />
        ) : tab === 'maintenance' ? (
          <TenantMaintenance leases={leases} />
        ) : tab === 'inspections' ? (
          <ClientInspections who="tenant" />
        ) : tab === 'finance' ? (
          <>
            <TenantBoletos />
            <h3>Cobranças</h3>
            {charges.length === 0 ? (
              <p className="empty">Nenhuma cobrança por enquanto.</p>
            ) : (
              <div className="panel table-wrap">
                <table>
                  <thead><tr><th>Vencimento</th><th>Descrição</th><th>Valor</th><th>Pago</th><th>Situação</th></tr></thead>
                  <tbody>
                    {charges.map((c) => (
                      <tr key={c.id}>
                        <td>{date(c.due_date)}</td>
                        <td>{c.description}</td>
                        <td>{brl(c.amount_cents)}</td>
                        <td>{brl(c.paid_cents)}</td>
                        <td><span className={`badge badge-c-${c.status}`}>{STATUS_LABEL[c.status]}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <h3>Pagamentos e recibos</h3>
            {payments.length === 0 ? (
              <p className="empty">Nenhum pagamento registrado.</p>
            ) : (
              <div className="panel table-wrap">
                <table>
                  <thead><tr><th>Recebido em</th><th>Forma</th><th>Valor</th><th /></tr></thead>
                  <tbody>
                    {payments.map((p) => (
                      <tr key={p.id} className={p.voided_at ? 'voided' : ''}>
                        <td>{date(p.received_at)}{p.voided_at && <span className="badge badge-c-cancelada"> estornado</span>}</td>
                        <td>{METHOD_LABEL[p.method] ?? p.method}</td>
                        <td>{brl(p.amount_cents)}</td>
                        <td className="row-actions"><button onClick={() => openReceipt(p.id)}>Recibo nº {p.receipt_number}</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <>
            {leases.length === 0 && <p className="empty">Nenhum contrato encontrado.</p>}
            {leases.map((l) => (
              <div key={l.id} className="panel">
                <dl className="facts">
                  <div><dt>Imóvel</dt><dd>{l.property_name} · {l.unit_identifier}</dd></div>
                  <div className="span-all"><dt>Endereço</dt><dd>{[l.street, l.number, l.neighborhood, [l.city, l.state].filter(Boolean).join('/')].filter(Boolean).join(', ') || '—'}</dd></div>
                  <div><dt>Período</dt><dd>{date(l.start_date)} a {date(l.end_date)}</dd></div>
                  <div><dt>Aluguel</dt><dd>{brl(l.rent_cents)} · vence dia {l.due_day}</dd></div>
                  <div><dt>Garantia</dt><dd>{l.guarantee ?? '—'}</dd></div>
                  <div><dt>Situação</dt><dd>{l.status}</dd></div>
                </dl>
              </div>
            ))}
            <h3>Documentos do contrato</h3>
            {docs.length === 0 ? (
              <p className="empty">Nenhum documento disponível.</p>
            ) : (
              <div className="panel table-wrap">
                <table>
                  <tbody>
                    {docs.map((d) => (
                      <tr key={d.id}>
                        <td>{d.template_name} (v{d.template_version})</td>
                        <td>{dateTime(d.created_at)}</td>
                        <td className="row-actions"><button onClick={() => openDoc(d.id)}>Abrir</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}

// ---------------------------------------------------------------- Proprietário

function OwnerArea({ initialTab }: { initialTab?: string }) {
  const [tab, setTab] = useState<OwnerTab>(OWNER_TABS.find((t) => t === initialTab) ?? 'properties')
  const [properties, setProperties] = useState<PortalProperty[]>([])
  const [units, setUnits] = useState<PortalUnit[]>([])
  const [transfers, setTransfers] = useState<Omit<Transfer, 'owner_id' | 'owner_name'>[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([api.ownerProperties(), api.ownerUnits(), api.ownerTransfers()])
      .then(([p, u, t]) => {
        setProperties(p.items)
        setUnits(u.items)
        setTransfers(t.items)
      })
      .catch((e) => setError(message(e)))
  }, [])

  const occupied = units.filter((u) => u.status === 'ocupada').length
  const monthlyRent = units.reduce((s, u) => s + (u.rent_cents ?? 0), 0)
  const pending = transfers.filter((t) => t.status === 'pendente').reduce((s, t) => s + t.net_cents, 0)

  return (
    <>
      {error && <Alert>{error}</Alert>}
      <div className="cards">
        <div className="stat"><span>Imóveis</span><strong>{properties.length}</strong></div>
        <div className="stat"><span>Unidades ocupadas</span><strong>{occupied} / {units.length}</strong></div>
        <div className="stat"><span>Aluguéis contratados / mês</span><strong>{brl(monthlyRent)}</strong></div>
        <div className="stat"><span>Repasses pendentes</span><strong>{brl(pending)}</strong></div>
      </div>

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'properties'} className={tab === 'properties' ? 'tab active' : 'tab'} onClick={() => setTab('properties')}>Meus imóveis</button>
        <button role="tab" aria-selected={tab === 'transfers'} className={tab === 'transfers' ? 'tab active' : 'tab'} onClick={() => setTab('transfers')}>Repasses</button>
        <button role="tab" aria-selected={tab === 'income'} className={tab === 'income' ? 'tab active' : 'tab'} onClick={() => setTab('income')}>Informe de rendimentos</button>
        <button role="tab" aria-selected={tab === 'summary'} className={tab === 'summary' ? 'tab active' : 'tab'} onClick={() => setTab('summary')}>Resumo dos imóveis</button>
        <button role="tab" aria-selected={tab === 'maintenance'} className={tab === 'maintenance' ? 'tab active' : 'tab'} onClick={() => setTab('maintenance')}>Manutenção</button>
        <button role="tab" aria-selected={tab === 'inspections'} className={tab === 'inspections' ? 'tab active' : 'tab'} onClick={() => setTab('inspections')}>Vistorias</button>
        <button role="tab" aria-selected={tab === 'polls'} className={tab === 'polls' ? 'tab active' : 'tab'} onClick={() => setTab('polls')}>Enquetes</button>
        <button role="tab" aria-selected={tab === 'announcements'} className={tab === 'announcements' ? 'tab active' : 'tab'} onClick={() => setTab('announcements')}>Comunicados</button>
      </div>

      {tab === 'income' ? (
        <OwnerIncome />
      ) : tab === 'summary' ? (
        <OwnerSummary />
      ) : tab === 'polls' ? (
        <ClientPolls />
      ) : tab === 'announcements' ? (
        <ClientAnnouncements />
      ) : tab === 'maintenance' ? (
        <OwnerMaintenance />
      ) : tab === 'inspections' ? (
        <ClientInspections who="owner" />
      ) : tab === 'properties' ? (
        units.length === 0 ? (
          <p className="empty">Nenhum imóvel vinculado ao seu cadastro.</p>
        ) : (
          <div className="panel table-wrap">
            <table>
              <thead><tr><th>Imóvel</th><th>Unidade</th><th>Situação</th><th>Locatário</th><th>Aluguel</th><th>Contrato até</th></tr></thead>
              <tbody>
                {units.map((u) => (
                  <tr key={u.id}>
                    <td>{u.property_name}</td>
                    <td>{u.identifier}</td>
                    <td><span className={`badge ${u.status === 'ocupada' ? 'badge-vigente' : 'badge-rascunho'}`}>{u.status === 'ocupada' ? 'Ocupada' : u.status === 'disponivel' ? 'Disponível' : 'Manutenção'}</span></td>
                    <td>{u.tenant_names ?? '—'}</td>
                    <td>{u.rent_cents ? brl(u.rent_cents) : '—'}</td>
                    <td>{u.end_date ? date(u.end_date) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : transfers.length === 0 ? (
        <p className="empty">Nenhum repasse calculado ainda.</p>
      ) : (
        <div className="panel table-wrap">
          <table>
            <thead><tr><th>Competência</th><th>Recebido</th><th>Taxa de administração</th><th>Repasse</th><th>Situação</th></tr></thead>
            <tbody>
              {transfers.map((t) => (
                <tr key={t.id}>
                  <td>{t.period.slice(5, 7)}/{t.period.slice(0, 4)}</td>
                  <td>{brl(t.gross_cents)}</td>
                  <td>{brl(t.fee_cents)} <span className="muted small">({t.fee_bps / 100}%)</span></td>
                  <td><strong>{brl(t.net_cents)}</strong></td>
                  <td>{t.status === 'pago' ? <span className="badge badge-c-paga">Pago em {date(t.paid_at!)}</span> : <span className="badge badge-c-aberta">Pendente</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
