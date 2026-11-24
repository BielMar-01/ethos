import { ResidentsPanel, VisitorsPanel, useLeaseOptions } from './HouseholdPanels'

/** Abas "Moradores" e "Visitantes" da área do inquilino (só o próprio contrato vigente). */
export function HouseholdTab({ kind }: { kind: 'residents' | 'visitors' }) {
  const options = useLeaseOptions('tenant')
  if (options.length === 0) {
    return <p className="empty">Você precisa ter um contrato vigente para cadastrar moradores e autorizar visitantes.</p>
  }
  return kind === 'residents' ? (
    <>
      <p className="muted">Informe quem mora com você além dos locatários do contrato (cônjuge, filhos, parentes, funcionários). A administradora também enxerga esta lista.</p>
      <ResidentsPanel mode="tenant" options={options} />
    </>
  ) : (
    <>
      <p className="muted">Autorize quem vai visitar. Na chegada, a portaria confere o nome ou o <strong>código de acesso</strong> e avisa você. Você pode cancelar a qualquer momento.</p>
      <VisitorsPanel mode="tenant" options={options} />
    </>
  )
}
