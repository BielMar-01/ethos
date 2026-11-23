import { useCallback, useEffect, useState } from 'react'
import { api, type Role, type Session } from './api'
import type { AppNotification } from './commApi'
import AnnouncementsPage from './AnnouncementsPage'
import ApiPage from './ApiPage'
import Dashboard from './Dashboard'
import FinancePage from './FinancePage'
import Icon, { type IconName } from './Icon'
import InspectionsPage from './InspectionsPage'
import LeasesPage from './LeasesPage'
import MaintenancePage from './MaintenancePage'
import NotificationBell from './NotificationBell'
import NotificationsPage from './NotificationsPage'
import PortalPage from './PortalPage'
import ResourcePage from './ResourcePage'
import TeamPage from './TeamPage'
import TemplatesPage from './TemplatesPage'
import ThemeToggle from './ThemeToggle'
import { RESOURCES } from './resources'

interface NavItem {
  key: string
  label: string
  icon: IconName
  adminOnly?: boolean
}

/** Menu da equipe, agrupado por assunto. */
const STAFF_NAV: { label?: string; items: NavItem[] }[] = [
  { items: [{ key: 'home', label: 'Painel', icon: 'layout' }] },
  {
    label: 'Cadastros',
    items: [
      { key: 'properties', label: 'Imóveis', icon: 'building' },
      { key: 'units', label: 'Unidades', icon: 'door' },
      { key: 'owners', label: 'Proprietários', icon: 'user' },
      { key: 'tenants', label: 'Inquilinos', icon: 'users' },
    ],
  },
  {
    label: 'Operação',
    items: [
      { key: 'leases', label: 'Contratos', icon: 'file' },
      { key: 'finance', label: 'Financeiro', icon: 'wallet' },
      { key: 'maintenance', label: 'Manutenção', icon: 'wrench' },
      { key: 'inspections', label: 'Vistorias', icon: 'camera' },
      { key: 'announcements', label: 'Comunicados', icon: 'megaphone' },
    ],
  },
  {
    label: 'Administração',
    items: [
      { key: 'templates', label: 'Modelos', icon: 'tag' },
      { key: 'team', label: 'Equipe', icon: 'shield', adminOnly: true },
      { key: 'api', label: 'API', icon: 'code' },
    ],
  },
]

const CLIENT_NAV: { label?: string; items: NavItem[] }[] = [
  {
    items: [
      { key: 'portal', label: 'Minha área', icon: 'home' },
      { key: 'notifications', label: 'Notificações', icon: 'bell' },
    ],
  },
]

/** Para onde levar quem clicou numa notificação (equipe: página; cliente: aba da área do cliente). */
const STAFF_TARGET: Record<string, string> = {
  maintenance: 'maintenance',
  inspection: 'inspections',
  charge: 'finance',
  payment: 'finance',
  lease: 'leases',
  announcement: 'announcements',
}
const TENANT_TAB: Record<string, string> = { maintenance: 'maintenance', inspection: 'inspections', charge: 'finance', payment: 'finance', lease: 'contract', announcement: 'announcements' }
const OWNER_TAB: Record<string, string> = { maintenance: 'maintenance', inspection: 'inspections', lease: 'properties', announcement: 'announcements' }

const isStaffRole = (r: Role) => r === 'admin' || r === 'colaborador'
const initials = (name: string) => name.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('')

export default function Shell({ session, onLogout, onSession }: { session: Session; onLogout: () => void; onSession: (s: Session) => void }) {
  const staff = isStaffRole(session.role)
  const isAdmin = session.role === 'admin'
  const home = staff ? 'home' : 'portal'

  const [current, setCurrent] = useState(home)
  const [menuOpen, setMenuOpen] = useState(false)
  const [orgs, setOrgs] = useState<{ id: number; name: string }[]>([])
  const [portalTarget, setPortalTarget] = useState<{ tab: string; n: number } | null>(null)

  useEffect(() => {
    api.organizations().then((r) => setOrgs(r.organizations)).catch(() => setOrgs([]))
  }, [session.organization.id])

  // Gaveta (celular): Esc fecha e a rolagem do fundo trava enquanto está aberta.
  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false)
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [menuOpen])

  const navigate = useCallback((key: string) => {
    setCurrent(key)
    setMenuOpen(false)
    window.scrollTo({ top: 0 })
  }, [])

  const openNotification = useCallback(
    (n: AppNotification) => {
      const kind = n.link_kind ?? ''
      if (staff) {
        navigate(STAFF_TARGET[kind] ?? 'notifications')
        return
      }
      const tab = (session.role === 'inquilino' ? TENANT_TAB : OWNER_TAB)[kind]
      if (tab) setPortalTarget({ tab, n: Date.now() })
      navigate('portal')
    },
    [staff, session.role, navigate],
  )

  async function switchOrg(id: number) {
    await api.switchOrganization(id)
    const me = await api.me()
    if ('role' in me) {
      setCurrent(isStaffRole(me.role) ? 'home' : 'portal')
      onSession(me)
    }
  }

  const orgKey = session.organization.id
  const resource = RESOURCES.find((r) => r.key === current)
  const groups = staff ? STAFF_NAV : CLIENT_NAV

  let content
  if (current === 'notifications') content = <NotificationsPage key={`n-${orgKey}`} onOpenItem={openNotification} isStaff={staff} />
  else if (!staff) content = <PortalPage key={`p-${orgKey}-${portalTarget?.n ?? 0}`} role={session.role} initialTab={portalTarget?.tab} />
  else if (current === 'team' && isAdmin) content = <TeamPage key={`t-${orgKey}`} currentUserId={session.user.id} />
  else if (current === 'leases') content = <LeasesPage key={`l-${orgKey}`} isAdmin={isAdmin} />
  else if (current === 'finance') content = <FinancePage key={`f-${orgKey}`} isAdmin={isAdmin} />
  else if (current === 'maintenance') content = <MaintenancePage key={`m-${orgKey}`} isAdmin={isAdmin} currentUserId={session.user.id} />
  else if (current === 'inspections') content = <InspectionsPage key={`i-${orgKey}`} />
  else if (current === 'announcements') content = <AnnouncementsPage key={`a-${orgKey}`} />
  else if (current === 'templates') content = <TemplatesPage key={`tp-${orgKey}`} canDelete={isAdmin} />
  else if (current === 'api') content = <ApiPage key={`api-${orgKey}`} isAdmin={isAdmin} />
  else if (resource) content = <ResourcePage key={`${resource.key}-${orgKey}`} def={resource} canDelete={isAdmin} />
  else content = <Dashboard key={`d-${orgKey}`} name={session.user.name} onNavigate={navigate} />

  return (
    <div className="shell">
      <aside id="sidebar" className={menuOpen ? 'sidebar open' : 'sidebar'} aria-label="Menu principal">
        <div className="brand">Ethos</div>
        <nav>
          {groups.map((g, gi) => (
            <div key={gi}>
              {g.label && <div className="nav-label">{g.label}</div>}
              {g.items
                .filter((i) => !i.adminOnly || isAdmin)
                .map((i) => (
                  <button key={i.key} className={i.key === current ? 'nav active' : 'nav'} aria-current={i.key === current ? 'page' : undefined} onClick={() => navigate(i.key)}>
                    <Icon name={i.icon} size={18} />
                    {i.label}
                  </button>
                ))}
            </div>
          ))}
        </nav>
      </aside>
      {menuOpen && <div className="scrim" onClick={() => setMenuOpen(false)} aria-hidden="true" />}

      <div className="content">
        <header className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setMenuOpen((o) => !o)} aria-label="Abrir menu" aria-expanded={menuOpen} aria-controls="sidebar">
            <Icon name={menuOpen ? 'x' : 'menu'} />
          </button>
          {orgs.length > 1 ? (
            <select aria-label="Organização" value={session.organization.id} onChange={(e) => switchOrg(Number(e.target.value))}>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          ) : (
            <span className="org">{session.organization.name}</span>
          )}
          <span className="spacer" />
          <ThemeToggle />
          <NotificationBell key={orgKey} onOpenItem={openNotification} onSeeAll={() => navigate('notifications')} />
          <div className="user-chip">
            <span className="avatar" aria-hidden="true">{initials(session.user.name)}</span>
            <span className="who">
              <strong>{session.user.name}</strong>
              <small>{session.role}</small>
            </span>
          </div>
          <button className="icon-btn" onClick={onLogout} title="Sair" aria-label="Sair">
            <Icon name="logout" />
          </button>
        </header>
        <main>{content}</main>
      </div>
    </div>
  )
}
