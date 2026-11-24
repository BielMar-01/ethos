/** Envia erros de JavaScript do navegador ao servidor (sem dados pessoais, sem query string), no máximo 5 por sessão. */
let sent = 0
const seen = new Set<string>()

export function reportClientError(message: string, stack?: string) {
  if (sent >= 5 || seen.has(message)) return
  seen.add(message)
  sent++
  void fetch('/api/client-errors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: message.slice(0, 300), stack: stack?.slice(0, 2000), url: location.pathname }),
    keepalive: true,
  }).catch(() => {})
}

export function installErrorReporting() {
  window.addEventListener('error', (e) => reportClientError(e.message || 'Erro de script', e.error?.stack))
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason
    reportClientError(r instanceof Error ? r.message : String(r ?? 'Promessa rejeitada'), r instanceof Error ? r.stack : undefined)
  })
}
