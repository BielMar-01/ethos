export type PublicRoute = 'home' | 'login' | 'register' | 'api'

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
      return 'home'
  }
}

const PATHS: Record<PublicRoute, string> = { home: '/', login: '/entrar', register: '/cadastro', api: '/api' }

export const go = (route: PublicRoute) => {
  window.location.hash = PATHS[route]
}
