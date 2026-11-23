import { useCallback, useEffect, useState } from 'react'
import { comm, type AppNotification, type NotifPref } from './commApi'
import { dateTime, timeAgo } from './format'

const message = (e: unknown) => (e instanceof Error ? e.message : 'Erro inesperado')

const CATEGORY: Record<string, string> = {
  financeiro: 'Financeiro',
  manutencao: 'Manutenção',
  vistoria: 'Vistoria',
  contrato: 'Contrato',
  comunicado: 'Comunicado',
}

/** Caixa de entrada completa + preferências por categoria (canal interno; os demais canais ainda não existem). */
export default function NotificationsPage({ onOpenItem, isStaff }: { onOpenItem: (n: AppNotification) => void; isStaff: boolean }) {
  const [items, setItems] = useState<AppNotification[]>([])
  const [unread, setUnread] = useState(0)
  const [onlyUnread, setOnlyUnread] = useState(false)
  const [prefs, setPrefs] = useState<NotifPref[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    try {
      const [n, p] = await Promise.all([comm.notifications(onlyUnread ? 'limit=100&unread=1' : 'limit=100'), comm.preferences()])
      setItems(n.items)
      setUnread(n.unread)
      setPrefs(p.items)
    } catch (e) {
      setError(message(e))
    } finally {
      setLoading(false)
    }
  }, [onlyUnread])

  useEffect(() => {
    load()
  }, [load])

  async function open(n: AppNotification) {
    if (!n.read_at) await comm.markRead(n.id).catch(() => {})
    onOpenItem(n)
  }

  async function readAll() {
    await comm.readAll()
    await load()
  }

  async function toggle(p: NotifPref) {
    setError('')
    try {
      await comm.setPreference(p.category, !p.in_app)
      setPrefs((cur) => cur.map((x) => (x.category === p.category ? { ...x, in_app: !x.in_app } : x)))
    } catch (e) {
      setError(message(e))
    }
  }

  async function reminders() {
    setError('')
    try {
      const r = await comm.runReminders()
      setNotice(`Lembretes gerados — vencimento próximo: ${r.dueSoon}, atraso: ${r.overdue}, contratos perto do fim: ${r.leasesEnding}.`)
      await load()
    } catch (e) {
      setError(message(e))
    }
  }

  return (
    <section>
      <div className="page-head">
        <h2>Notificações</h2>
        <label className="check" style={{ flexDirection: 'row', gap: '0.5rem', alignItems: 'center' }}>
          <input type="checkbox" checked={onlyUnread} onChange={(e) => setOnlyUnread(e.target.checked)} /> Só não lidas
        </label>
        <button onClick={readAll} disabled={unread === 0}>Marcar todas como lidas</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}

      <div className="dash-cols">
        <div className="panel" style={{ padding: 0 }}>
          {loading ? (
            <p className="muted" style={{ padding: '1rem' }}>Carregando…</p>
          ) : items.length === 0 ? (
            <p className="empty" style={{ border: 'none' }}>{onlyUnread ? 'Nenhuma notificação não lida.' : 'Você ainda não tem notificações.'}</p>
          ) : (
            items.map((n) => (
              <button key={n.id} className={n.read_at ? 'notif-item' : 'notif-item unread'} onClick={() => open(n)}>
                <span className="dot" aria-hidden="true" />
                <span style={{ flex: 1 }}>
                  <span className="cat">{CATEGORY[n.category] ?? n.category}</span>
                  <span className="notif-title">{n.title}</span>
                  {n.body && <span className="notif-body">{n.body}</span>}
                  <span className="notif-time" title={dateTime(n.created_at)}>{timeAgo(n.created_at)}</span>
                </span>
              </button>
            ))
          )}
        </div>

        <div className="stack">
          <div className="panel">
            <h3 style={{ marginTop: 0 }}>Preferências</h3>
            <p className="muted small">Escolha o que aparece no seu sino. Avisos e e-mails por outros canais ainda não estão disponíveis.</p>
            {prefs.map((p) => (
              <div key={p.category} className="toggle-row">
                <span>{p.label}</span>
                <button
                  type="button"
                  className="switch"
                  role="switch"
                  aria-checked={p.in_app}
                  aria-label={`Notificações de ${p.label}`}
                  onClick={() => toggle(p)}
                />
              </div>
            ))}
          </div>
          {isStaff && (
            <div className="panel">
              <h3 style={{ marginTop: 0 }}>Lembretes automáticos</h3>
              <p className="muted small">
                O sistema avisa o inquilino sobre vencimentos próximos e atrasos, e a equipe sobre contratos perto do fim. Roda sozinho a cada 6 horas; você pode gerar agora.
              </p>
              <button onClick={reminders}>Gerar lembretes agora</button>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
