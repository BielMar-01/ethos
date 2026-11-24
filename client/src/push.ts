import { request } from './api'

/** Web Push: registra o aparelho no servidor (VAPID). O service worker (`sw.js`) mostra o aviso. */

const toKey = (b64: string) => {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4)
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

export async function pushSubscribed(): Promise<boolean> {
  if (!supported()) return false
  const reg = await navigator.serviceWorker.getRegistration()
  return !!(await reg?.pushManager.getSubscription())
}

export async function subscribePush(): Promise<void> {
  if (!supported()) throw new Error('Este navegador não suporta notificações push.')
  const cfg = await request<{ enabled: boolean; public_key: string | null }>('/api/push/config')
  if (!cfg.enabled || !cfg.public_key) throw new Error('Push não está configurado no servidor.')
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Permissão de notificação negada no navegador.')
  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register('/sw.js'))
  await navigator.serviceWorker.ready
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(cfg.public_key) })
  const json = sub.toJSON()
  await request('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }) })
}

export async function unsubscribePush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration()
  const sub = await reg?.pushManager.getSubscription()
  if (!sub) return
  await request('/api/push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) })
  await sub.unsubscribe()
}
