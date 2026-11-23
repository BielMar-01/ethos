import { useCallback, useEffect, useRef, useState } from 'react'
import Icon from './Icon'
import { comm, type AppNotification } from './commApi'
import { timeAgo } from './format'

const CATEGORY_LABEL: Record<string, string> = {
  financeiro: 'Financeiro',
  manutencao: 'Manutenção',
  vistoria: 'Vistoria',
  contrato: 'Contrato',
  comunicado: 'Comunicado',
}

/** Sino com contagem de não lidas (atualiza a cada minuto e ao voltar para a aba) e painel das mais recentes. */
export default function NotificationBell({
  onOpenItem,
  onSeeAll,
}: {
  onOpenItem: (n: AppNotification) => void
  onSeeAll: () => void
}) {
  const [unread, setUnread] = useState(0)
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<AppNotification[]>([])
  const [loading, setLoading] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)

  const refreshCount = useCallback(() => {
    comm.unreadCount().then((r) => setUnread(r.unread)).catch(() => {})
  }, [])

  useEffect(() => {
    refreshCount()
    const timer = setInterval(refreshCount, 60_000)
    const onFocus = () => refreshCount()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [refreshCount])

  // Fecha ao clicar fora ou apertar Esc.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function toggle() {
    const next = !open
    setOpen(next)
    if (!next) return
    setLoading(true)
    try {
      const r = await comm.notifications('limit=8')
      setItems(r.items)
      setUnread(r.unread)
    } catch {
      setItems([])
    } finally {
      setLoading(false)
    }
  }

  async function pick(n: AppNotification) {
    setOpen(false)
    if (!n.read_at) {
      await comm.markRead(n.id).catch(() => {})
      refreshCount()
    }
    onOpenItem(n)
  }

  async function readAll() {
    await comm.readAll().catch(() => {})
    setItems((cur) => cur.map((i) => ({ ...i, read_at: i.read_at ?? new Date().toISOString() })))
    setUnread(0)
  }

  return (
    <div className="bell-wrap" ref={wrap}>
      <button
        type="button"
        className="icon-btn"
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={unread > 0 ? `Notificações: ${unread} não lida(s)` : 'Notificações'}
      >
        <Icon name="bell" />
        {unread > 0 && <span className="badge-dot" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label="Notificações">
          <div className="popover-head">
            <strong>Notificações</strong>
            <span>
              {unread > 0 && <button className="link" onClick={readAll}>Marcar todas como lidas</button>}
            </span>
          </div>
          {loading ? (
            <p className="muted" style={{ padding: '1rem' }}>Carregando…</p>
          ) : items.length === 0 ? (
            <p className="muted" style={{ padding: '1.2rem', textAlign: 'center' }}>Nada por aqui ainda.</p>
          ) : (
            items.map((n) => (
              <button key={n.id} className={n.read_at ? 'notif-item' : 'notif-item unread'} onClick={() => pick(n)}>
                <span className="dot" aria-hidden="true" />
                <span>
                  <span className="cat">{CATEGORY_LABEL[n.category] ?? n.category}</span>
                  <span className="notif-title">{n.title}</span>
                  {n.body && <span className="notif-body">{n.body}</span>}
                  <span className="notif-time">{timeAgo(n.created_at)}</span>
                </span>
              </button>
            ))
          )}
          <div style={{ padding: '0.5rem 0.9rem', borderTop: '1px solid var(--border)' }}>
            <button className="link" onClick={() => { setOpen(false); onSeeAll() }}>Ver todas e preferências</button>
          </div>
        </div>
      )}
    </div>
  )
}
