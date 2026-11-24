import { request } from './api'
import { ask, errorText, toast } from './feedback'
import { Loaded, Table, useLoad } from './kit'

/** Erros recentes do sistema (servidor e navegador), com aviso por e-mail ao administrador quando há enxurrada. */
interface Entry { id: number; source: 'server' | 'client'; message: string; method: string | null; path: string | null; status: number | null; created_at: string }

export default function Monitoring() {
  const s = useLoad(() => request<{ items: Entry[]; last_24h: { n: number; server: number; client: number } }>('/api/admin/errors'))
  async function clear() {
    if (!(await ask('Limpar o registro de erros?', { confirmLabel: 'Limpar' }))) return
    try {
      await request('/api/admin/errors', { method: 'DELETE' })
      await s.reload()
    } catch (e) {
      toast.error(errorText(e))
    }
  }
  return (
    <div className="panel stack" style={{ marginTop: '1rem' }}>
      <h3 style={{ margin: 0 }}>Monitoramento de erros</h3>
      <Loaded state={s}>
        {(d) => (
          <>
            <p className="muted small">Últimas 24 h: <strong>{d.last_24h.n}</strong> erro(s) ({d.last_24h.server} do servidor, {d.last_24h.client} do navegador). Com 10 ou mais erros do servidor em 10 minutos, quem opera a plataforma (variável ERROR_ALERT_EMAILS) recebe um e-mail. Guarda 30 dias, sem corpo de requisição.</p>
            <Table rows={d.items} empty="Nenhum erro registrado. 👍" cols={[
              { head: 'Quando', cell: (e) => new Date(e.created_at).toLocaleString('pt-BR') },
              { head: 'Origem', cell: (e) => (e.source === 'server' ? 'Servidor' : 'Navegador') },
              { head: 'Onde', cell: (e) => [e.method, e.path].filter(Boolean).join(' ') || '—' },
              { head: 'Mensagem', cell: (e) => <span style={{ overflowWrap: 'anywhere' }}>{e.message}</span> },
            ]} />
            {d.items.length > 0 && <div className="actions"><button onClick={clear}>Limpar registro</button></div>}
          </>
        )}
      </Loaded>
    </div>
  )
}
