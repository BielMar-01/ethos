import { useCallback, useEffect, useState } from 'react'
import { pushSubscribed, subscribePush, unsubscribePush } from './push'
import { comm, type AppNotification, type Channel, type NotifPref, type PrefsResponse } from './commApi'
import { dateTime, timeAgo } from './format'
import { Alert, Toast, Loading } from './feedback'

const CHANNELS: { key: Channel; label: string }[] = [
  { key: 'in_app', label: 'Sino' },
  { key: 'email', label: 'E-mail' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'push', label: 'Push' },
]

const message = (e: unknown) => (e instanceof Error ? e.message : 'Erro inesperado')

const CATEGORY: Record<string, string> = {
  financeiro: 'Financeiro',
  manutencao: 'Manutenção',
  vistoria: 'Vistoria',
  contrato: 'Contrato',
  comunicado: 'Comunicado',
  acesso: 'Portaria',
  seguranca: 'Segurança',
  encomenda: 'Encomenda',
  ocorrencia: 'Ocorrência',
}

/** Caixa de entrada completa + preferências por categoria (canal interno; os demais canais ainda não existem). */
export default function NotificationsPage({ onOpenItem, isStaff }: { onOpenItem: (n: AppNotification) => void; isStaff: boolean }) {
  const [items, setItems] = useState<AppNotification[]>([])
  const [unread, setUnread] = useState(0)
  const [onlyUnread, setOnlyUnread] = useState(false)
  const [prefs, setPrefs] = useState<NotifPref[]>([])
  const [info, setInfo] = useState<PrefsResponse | null>(null)
  const [pushOn, setPushOn] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    try {
      const [n, p] = await Promise.all([comm.notifications(onlyUnread ? 'limit=100&unread=1' : 'limit=100'), comm.preferences()])
      setItems(n.items)
      setUnread(n.unread)
      setPrefs(p.items)
      setInfo(p)
      setPushOn(await pushSubscribed())
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

  async function toggle(p: NotifPref, channel: Channel) {
    setError('')
    try {
      await comm.setPreference(p.category, channel, !p[channel])
      setPrefs((cur) => cur.map((x) => (x.category === p.category ? { ...x, [channel]: !x[channel] } : x)))
    } catch (e) {
      setError(message(e))
    }
  }

  async function whatsapp() {
    setError('')
    try {
      await comm.setWhatsAppConsent(!info?.whatsapp_opt_in)
      await load()
    } catch (e) {
      setError(message(e))
    }
  }

  async function push() {
    setError('')
    try {
      if (pushOn) await unsubscribePush()
      else await subscribePush()
      setPushOn(await pushSubscribed())
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
      {error && <Alert>{error}</Alert>}
      {notice && <Toast>{notice}</Toast>}

      <div className="dash-cols">
        <div className="panel" style={{ padding: 0 }}>
          {loading ? (
            <Loading label="Carregando…" />
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
            <p className="muted small">Escolha onde receber cada tipo de aviso. Canais sem provedor configurado no servidor aparecem desativados.</p>
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Preferências de aviso">
              <table className="pref-table">
                <thead>
                  <tr>
                    <th>Aviso</th>
                    {CHANNELS.map((c) => <th key={c.key} title={info?.channels[c.key] ? '' : 'Indisponível neste servidor'}>{c.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {prefs.map((p) => (
                    <tr key={p.category}>
                      <td>{p.label}</td>
                      {CHANNELS.map((c) => (
                        <td key={c.key}>
                          <button
                            type="button"
                            className="switch"
                            role="switch"
                            aria-checked={p[c.key]}
                            aria-label={`${c.label}: ${p.label}`}
                            disabled={!info?.channels[c.key]}
                            onClick={() => toggle(p, c.key)}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="stack-sm" style={{ marginTop: '0.75rem' }}>
              {info?.channels.whatsapp && (
                <label className="check">
                  <input type="checkbox" checked={!!info.whatsapp_opt_in} onChange={whatsapp} disabled={!info.has_phone && !info.whatsapp_opt_in} />
                  Aceito receber avisos por WhatsApp no telefone do meu perfil{!info.has_phone && ' (cadastre um telefone em Meu perfil)'}
                </label>
              )}
              {info?.channels.push && (
                <label className="check">
                  <input type="checkbox" checked={pushOn} onChange={push} />
                  Receber avisos neste aparelho (notificação do navegador)
                </label>
              )}
            </div>
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
