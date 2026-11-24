import { useCallback, useEffect, useState } from 'react'
import { api, ROLE_LABELS, type Role, type Session } from './api'
import type { AppNotification } from './commApi'
import AccessPage from './AccessPage'
import AnnouncementsPage from './AnnouncementsPage'
import ApiPage from './ApiPage'
import AuditPage from './AuditPage'
import Dashboard from './Dashboard'
import FinancePage from './FinancePage'
import Icon, { type IconName } from './Icon'
import ImportPage from './ImportPage'
import IntakePage from './IntakePage'
import IntegrationsPage from './IntegrationsPage'
import InspectionsPage from './InspectionsPage'
import LeasesPage from './LeasesPage'
import MaintenancePage from './MaintenancePage'
import NotificationBell from './NotificationBell'
import NotificationsPage from './NotificationsPage'
import PortalPage from './PortalPage'
import ProfilePage from './ProfilePage'
import ResourcePage from './ResourcePage'
import TeamPage from './TeamPage'
import TemplatesPage from './TemplatesPage'
import ThemeToggle from './ThemeToggle'
import { InstallButton, OfflineBanner } from './pwa'
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
      { key: 'intake', label: 'Ler documentos', icon: 'camera' },
      { key: 'import', label: 'Importar dados', icon: 'upload' },
    ],
  },
  {
    label: 'Operação',
    items: [
      { key: 'leases', label: 'Contratos', icon: 'file' },
      { key: 'finance', label: 'Financeiro', icon: 'wallet' },
      { key: 'maintenance', label: 'Manutenção', icon: 'wrench' },
      { key: 'inspections', label: 'Vistorias', icon: 'camera' },
      { key: 'access', label: 'Moradores e acessos', icon: 'users' },
      { key: 'announcements', label: 'Comunicados', icon: 'megaphone' },
    ],
  },
  {
    label: 'Administração',
    items: [
      { key: 'templates', label: 'Modelos', icon: 'tag' },
      { key: 'team', label: 'Equipe', icon: 'shield', adminOnly: true },
      { key: 'audit', label: 'Registros', icon: 'history', adminOnly: true },
      { key: 'integrations', label: 'Integrações', icon: 'plug', adminOnly: true },
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
const TENANT_TAB: Record<string, string> = { visitor: 'visitors', maintenance: 'maintenance', inspection: 'inspections', charge: 'finance', payment: 'finance', lease: 'contract', announcement: 'announcements' }
const OWNER_TAB: Record<string, string> = { maintenance: 'maintenance', inspection: 'inspections', lease: 'properties', announcement: 'announcements' }

const isStaffRole = (r: Role) => r === 'admin' || r === 'colaborador'
const COLLAPSE_KEY = 'ethos-sidebar'
const MOBILE = '(max-width: 960px)'

/** Menu recolhido: a escolha do usuário vale; sem escolha, telas médias (tablet) começam recolhidas. */
function initialCollapsed(): boolean {
  try {
    const saved = localStorage.getItem(COLLAPSE_KEY)
    if (saved === '1') return true
    if (saved === '0') return false
  } catch {
    /* sem armazenamento: usa o padrão */
  }
  return typeof window !== 'undefined' && window.innerWidth < 1200
}

const initials = (name: string) => name.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('')

export default function Shell({ session, onLogout, onSession }: { session: Session; onLogout: () => void; onSession: (s: Session) => void }) {
  const staff = isStaffRole(session.role)
  const isAdmin = session.role === 'admin'
  const home = staff ? 'home' : 'portal'

  const [current, setCurrent] = useState(home)
  const [menuOpen, setMenuOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(initialCollapsed)
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

  /** Botão do topo: no celular abre/fecha a gaveta; no tablet e no computador recolhe/expande a barra lateral. */
  function toggleMenu() {
    if (window.matchMedia(MOBILE).matches) {
      setMenuOpen((o) => !o)
      return
    }
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1')
      } catch {
        /* ignora */
      }
      return !c
    })
  }

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
  if (current === 'profile') content = <ProfilePage key={`pf-${orgKey}`} session={session} onSession={onSession} onLoggedOut={onLogout} />
  else if (current === 'notifications') content = <NotificationsPage key={`n-${orgKey}`} onOpenItem={openNotification} isStaff={staff} />
  else if (!staff) content = <PortalPage key={`p-${orgKey}-${portalTarget?.n ?? 0}`} role={session.role} initialTab={portalTarget?.tab} />
  else if (current === 'team' && isAdmin) content = <TeamPage key={`t-${orgKey}`} currentUserId={session.user.id} />
  else if (current === 'intake') content = <IntakePage key={`in-${orgKey}`} onNavigate={navigate} />
  else if (current === 'import') content = <ImportPage key={`im-${orgKey}`} />
  else if (current === 'integrations' && isAdmin) content = <IntegrationsPage key={`ig-${orgKey}`} />
  else if (current === 'audit' && isAdmin) content = <AuditPage key={`au-${orgKey}`} />
  else if (current === 'leases') content = <LeasesPage key={`l-${orgKey}`} isAdmin={isAdmin} />
  else if (current === 'finance') content = <FinancePage key={`f-${orgKey}`} isAdmin={isAdmin} />
  else if (current === 'maintenance') content = <MaintenancePage key={`m-${orgKey}`} isAdmin={isAdmin} currentUserId={session.user.id} />
  else if (current === 'inspections') content = <InspectionsPage key={`i-${orgKey}`} />
  else if (current === 'access') content = <AccessPage key={`ac-${orgKey}`} />
  else if (current === 'announcements') content = <AnnouncementsPage key={`a-${orgKey}`} />
  else if (current === 'templates') content = <TemplatesPage key={`tp-${orgKey}`} canDelete={isAdmin} />
  else if (current === 'api') content = <ApiPage key={`api-${orgKey}`} isAdmin={isAdmin} />
  else if (resource) content = <ResourcePage key={`${resource.key}-${orgKey}`} def={resource} canDelete={isAdmin} />
  else content = <Dashboard key={`d-${orgKey}`} name={session.user.name} onNavigate={navigate} />

  return (
    <div className={collapsed ? 'shell collapsed' : 'shell'}>
      <a className="skip-link" href="#main">Ir para o conteúdo</a>
      <OfflineBanner />
      <aside id="sidebar" className={menuOpen ? 'sidebar open' : 'sidebar'} aria-label="Menu principal">
        <div className="brand" title="Ethos">
          <span className="brand-mark" aria-hidden="true">E</span>
          <span className="brand-text">Ethos</span>
        </div>
        <nav>
          {groups.map((g, gi) => (
            <div key={gi}>
              {g.label && <div className="nav-label">{g.label}</div>}
              {g.items
                .filter((i) => !i.adminOnly || isAdmin)
                .map((i) => (
                  <button
                    key={i.key}
                    className={i.key === current ? 'nav active' : 'nav'}
                    aria-current={i.key === current ? 'page' : undefined}
                    title={collapsed ? i.label : undefined}
                    onClick={() => navigate(i.key)}
                  >
                    <Icon name={i.icon} size={18} />
                    <span className="nav-text">{i.label}</span>
                  </button>
                ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <button
            className={current === 'profile' ? 'user-card active' : 'user-card'}
            onClick={() => navigate('profile')}
            aria-current={current === 'profile' ? 'page' : undefined}
            title={collapsed ? `${session.user.name} (${ROLE_LABELS[session.role]}) — Meu perfil` : 'Meu perfil'}
          >
            <span className="avatar" aria-hidden="true">
              {session.user.avatar_version ? <img src={`/api/profile/avatar?v=${session.user.avatar_version}`} alt="" /> : initials(session.user.name)}
            </span>
            <span className="who">
              <strong>{session.user.name}</strong>
              <small>{ROLE_LABELS[session.role]} · Meu perfil</small>
            </span>
          </button>
          <button className="nav logout" onClick={onLogout} title={collapsed ? 'Sair' : undefined}>
            <Icon name="logout" size={18} />
            <span className="nav-text">Sair</span>
          </button>
        </div>
      </aside>
      {menuOpen && <div className="scrim" onClick={() => setMenuOpen(false)} aria-hidden="true" />}

      <div className="content">
        <header className="topbar">
          <button
            className="icon-btn menu-btn"
            onClick={toggleMenu}
            aria-label={menuOpen ? 'Fechar menu' : collapsed ? 'Expandir menu' : 'Recolher menu'}
            aria-expanded={menuOpen || !collapsed}
            aria-controls="sidebar"
            title={collapsed ? 'Expandir menu' : 'Recolher menu'}
          >
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
          <InstallButton />
          <ThemeToggle />
          <NotificationBell key={orgKey} onOpenItem={openNotification} onSeeAll={() => navigate('notifications')} />
        </header>
        <main id="main" tabIndex={-1}>{content}</main>
      </div>
    </div>
  )
}
