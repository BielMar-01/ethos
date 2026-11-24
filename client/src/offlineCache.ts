/**
 * Leitura offline da ÁREA DO CLIENTE: as últimas respostas de algumas telas de LEITURA do próprio inquilino/proprietário ficam
 * neste aparelho (localStorage) e só aparecem quando não há internet. Regras de privacidade:
 *  - só rotas /api/portal/* de leitura (GET), nunca dados da equipe;
 *  - apagado ao sair e quando a sessão expira;
 *  - cada resposta vale por 7 dias; o service worker continua sem guardar nada de /api.
 */
const PREFIX = 'ethos-offline:'
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const ALLOW = [/^\/api\/portal\/(tenant|owner)\/(leases|charges|payments|boletos|properties|units|transfers|income|summary|parcels|incidents)/, /^\/api\/portal\/(me|announcements|polls)/]

const allowed = (path: string) => ALLOW.some((r) => r.test(path.split('?')[0]!))

export function saveForOffline(path: string, data: unknown) {
  if (!allowed(path)) return
  try {
    localStorage.setItem(PREFIX + path, JSON.stringify({ at: Date.now(), data }))
  } catch {
    /* sem espaço ou modo privado: segue sem cache */
  }
}

export function readOffline<T>(path: string): { data: T; at: number } | null {
  if (!allowed(path)) return null
  try {
    const raw = localStorage.getItem(PREFIX + path)
    if (!raw) return null
    const { at, data } = JSON.parse(raw) as { at: number; data: T }
    return Date.now() - at <= MAX_AGE_MS ? { data, at } : null
  } catch {
    return null
  }
}

export function clearOfflineCache() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k)
  } catch {
    /* ignora */
  }
}

if (typeof window !== 'undefined') window.addEventListener('ethos:unauthorized', clearOfflineCache)
