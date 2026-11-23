export type PublicRoute = 'home' | 'login' | 'register' | 'api'

/** Rodando como app instalado (PWA): não existe "página inicial de divulgação", o app abre direto no login. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  const nav = window.navigator as Navigator & { standalone?: boolean }
  return window.matchMedia?.('(display-mode: standalone)').matches === true || nav.standalone === true
}

/** Navegação por hash (#/entrar), sem biblioteca de rotas. O hash de recuperação de senha não começa com "/". */
export function routeFromHash(hash: string): PublicRoute {
  switch (hash.replace(/^#\/?/, '')) {
    case 'entrar':
      return 'login'
    case 'cadastro':
      return 'register'
    case 'api':
      return 'api'
    default:
      return isStandalone() ? 'login' : 'home'
  }
}

const PATHS: Record<PublicRoute, string> = { home: '/', login: '/entrar', register: '/cadastro', api: '/api' }

export const go = (route: PublicRoute) => {
  window.location.hash = PATHS[route]
}
