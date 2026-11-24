import { useState } from 'react'
import { PortariaPanel, ResidentsPanel, VisitorsPanel, useLeaseOptions } from './HouseholdPanels'
import { AccessReport, ParcelsPanel } from './AccessExtras'

type Tab = 'portaria' | 'visitors' | 'parcels' | 'residents' | 'report'

/** Moradores e acessos (equipe): portaria do dia, autorizações de visitantes e cadastro de moradores. */
export default function AccessPage() {
  const [tab, setTab] = useState<Tab>('portaria')
  const options = useLeaseOptions('staff')
  const tabs: [Tab, string][] = [['portaria', 'Portaria'], ['visitors', 'Visitantes'], ['parcels', 'Encomendas'], ['residents', 'Moradores'], ['report', 'Relatório de acessos']]
  return (
    <section>
      <div className="page-head">
        <h2>Moradores e acessos</h2>
        <span className="muted">Controle de quem mora e de quem entra</span>
      </div>
      <div className="tabs" role="tablist" aria-label="Moradores e acessos">
        {tabs.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'tab active' : 'tab'} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {tab === 'portaria' && <PortariaPanel />}
      {tab === 'visitors' && <VisitorsPanel mode="staff" options={options} />}
      {tab === 'parcels' && <ParcelsPanel />}
      {tab === 'residents' && <ResidentsPanel mode="staff" options={options} />}
      {tab === 'report' && <AccessReport />}
    </section>
  )
}
