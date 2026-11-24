import { useEffect, useState, useSyncExternalStore } from 'react'
import Icon from './Icon'
import { toast } from './feedback'

/** Registra o service worker só em produção (em desenvolvimento ele atrapalharia o hot reload). */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        reg.addEventListener('updatefound', () => {
          const worker = reg.installing
          worker?.addEventListener('statechange', () => {
            // Já havia versão em uso: a nova foi instalada e vale a partir do próximo carregamento.
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              toast.info('Nova versão do Ethos instalada. Ela entra em uso ao recarregar a página.')
            }
          })
        })
      })
      .catch(() => {
        /* sem service worker o app funciona igual, só não instala/abre offline */
      })
  })
}

// ---------------------------------------------------------------------------------------- Instalação

interface InstallEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferred: InstallEvent | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault() // guarda o convite do navegador para mostrar no nosso botão
    deferred = e as InstallEvent
    emit()
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    emit()
    toast.success('Ethos instalado. Procure o ícone na sua tela inicial.')
  })
}

const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l))

/** Botão "Instalar app": aparece só quando o navegador permite instalar e o app ainda não está instalado. */
export function InstallButton() {
  const available = useSyncExternalStore(subscribe, () => deferred !== null, () => false)
  if (!available) return null
  return (
    <button
      className="icon-btn"
      title="Instalar o app"
      aria-label="Instalar o app no dispositivo"
      onClick={async () => {
        const e = deferred
        if (!e) return
        await e.prompt()
        const { outcome } = await e.userChoice
        if (outcome === 'accepted') deferred = null
        emit()
      }}
    >
      <Icon name="download" />
    </button>
  )
}

// ---------------------------------------------------------------------------------------- Sem conexão

/** Faixa fixa quando o aparelho perde a internet (e um aviso quando volta). */
export function OfflineBanner() {
  const [online, setOnline] = useState(() => navigator.onLine)
  const [saved, setSaved] = useState<number | null>(null)
  useEffect(() => {
    const onData = (e: Event) => setSaved((e as CustomEvent<number>).detail)
    window.addEventListener('ethos:offline-data', onData)
    return () => window.removeEventListener('ethos:offline-data', onData)
  }, [])
  useEffect(() => {
    const up = () => {
      setOnline(true)
      setSaved(null)
      toast.success('Conexão restabelecida.')
    }
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])
  if (online) return null
  return (
    <div className="offline-banner" role="status">
      Sem conexão. Suas alterações não serão salvas até a internet voltar.
      {saved !== null && ` Você está vendo os dados salvos neste aparelho às ${new Date(saved).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}.`}
    </div>
  )
}
