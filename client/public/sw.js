/* Service worker do Ethos.
 * Regras de segurança: NADA de /api é guardado (dados de pessoas, contratos e financeiro nunca ficam em cache do
 * navegador); só a "casca" do app (HTML, JS, CSS, fontes, ícones) para abrir rápido e mostrar a tela de "sem conexão".
 * Ao publicar uma versão nova, mude VERSION para renovar o cache. */
const VERSION = 'ethos-v2'
const SHELL = ['/', '/offline.html', '/manifest.webmanifest', '/favicon.svg', '/icons/icon-192.png', '/icons/icon-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return // dados: sempre direto na rede, nunca em cache

  // Navegação: rede primeiro (sempre a versão mais nova); sem rede, a casca guardada; por fim, a tela offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          if (res.ok && url.pathname === '/') caches.open(VERSION).then((c) => c.put('/', copy))
          return res
        })
        .catch(async () => (await caches.match('/')) || (await caches.match('/offline.html'))),
    )
    return
  }

  // Arquivos estáticos: usa o guardado e atualiza em segundo plano.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone()
            caches.open(VERSION).then((c) => c.put(req, copy))
          }
          return res
        })
        .catch(() => cached)
      return cached || network
    }),
  )
})

// Web Push: mostra o aviso e, ao clicar, abre/foca o app.
self.addEventListener('push', (event) => {
  let data = { title: 'Ethos', body: '', url: '/' }
  try {
    data = { ...data, ...event.data.json() }
  } catch {
    /* sem corpo */
  }
  event.waitUntil(self.registration.showNotification(data.title, { body: data.body, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: data.url } }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => 'focus' in c)
      return open ? open.focus() : self.clients.openWindow(url)
    }),
  )
})
