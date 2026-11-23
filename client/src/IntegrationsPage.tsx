import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { json, request } from './api'
import { KeysPanel } from './ApiPage'
import { Alert, Loading, ask, errorText, toast } from './feedback'
import { dateTime } from './format'
import Icon, { type IconName } from './Icon'
import Modal from './Modal'
import PasswordInput from './PasswordInput'

/**
 * Integrações (só administrador): conexões com serviços externos e automações.
 * Hoje: Asaas (guarda e testa a chave), IA da organização (leitura de documentos), webhooks de saída (n8n, Make, Zapier…) e chaves de API.
 */

interface State {
  secrets_ready: boolean
  asaas: Conn
  ai: {
    catalog: AiDef[]
    providers: Record<string, Conn>
    server_key: boolean
    active: { provider: string; label: string; model: string | null; source: 'organization' | 'server' } | null
  }
  webhooks: { total: number; enabled: number }
  api_keys: { active: number }
}
interface Conn {
  configured: boolean
  primary?: boolean
  enabled: boolean
  config: Record<string, unknown>
  hint: string | null
  last_tested_at: string | null
  last_status: 'ok' | 'error' | null
  last_error: string | null
}
interface AiDef {
  id: string
  label: string
  kind: 'anthropic' | 'openai'
  baseUrl: string | null
  models: string[]
  vision: boolean
  pdf: boolean
  keyUrl: string
  note?: string
}
interface Hook {
  id: number
  name: string
  url: string
  events: string[]
  enabled: boolean
  last_status: 'ok' | 'error' | null
  last_http_status: number | null
  last_error: string | null
  last_at: string | null
  last_event: string | null
}
interface Delivery { id: number; event: string; status: 'ok' | 'error'; http_status: number | null; error: string | null; attempts: number; duration_ms: number | null; created_at: string }
interface EventDef { event: string; label: string; group: string }

type Open = null | 'asaas' | 'ai' | 'webhooks' | 'keys'

export default function IntegrationsPage() {
  const [data, setData] = useState<State | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<Open>(null)

  const load = useCallback(async () => {
    try {
      setData(await request<State>('/api/integrations'))
      setError('')
    } catch (e) {
      setError(errorText(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const close = () => {
    setOpen(null)
    void load()
  }

  if (!data) return error ? <Alert>{error}</Alert> : <Loading label="Carregando integrações…" />

  const asaasBadge = badge(data.asaas)
  const ai = data.ai.active

  return (
    <section>
      <div className="page-head">
        <div>
          <h2>Integrações</h2>
          <p className="muted page-sub">Conecte o Ethos a serviços de pagamento, inteligência artificial e ferramentas de automação como o n8n.</p>
        </div>
      </div>

      {!data.secrets_ready && (
        <Alert>
          O servidor ainda não tem a chave de proteção (<code>INTEGRATIONS_SECRET</code>), então não é possível guardar chaves de integrações com segurança. Defina-a nas variáveis de ambiente (veja docs/DEPLOY-VERCEL.md) e recarregue.
        </Alert>
      )}
      {error && <Alert>{error}</Alert>}

      <div className="integration-grid">
        <Card icon="wallet" title="Asaas" subtitle="Pagamentos: boleto, Pix e cartão" status={asaasBadge} onClick={() => setOpen('asaas')} cta={data.asaas.configured ? 'Gerenciar' : 'Conectar'}>
          Guarde a chave de API e confirme a conexão. A emissão de cobranças pelo Asaas será liberada nas próximas versões.
        </Card>
        <Card
          icon="camera"
          title="IA — leitura de documentos"
          subtitle="Claude, GPT, Gemini, Grok, DeepSeek e mais"
          status={ai ? { tone: 'ok', text: `Em uso: ${ai.label.split(' (')[0]}${ai.source === 'server' ? ' (chave do servidor)' : ''}` } : { tone: 'muted', text: 'Desligada' }}
          onClick={() => setOpen('ai')}
          cta={Object.values(data.ai.providers).some((p) => p.configured) ? 'Gerenciar' : 'Configurar'}
        >
          Alimenta “Ler documentos”: foto ou PDF de RG, contrato e matrícula viram cadastros. Use o provedor que preferir — Claude, GPT, Gemini, Grok, DeepSeek, OpenRouter ou outro compatível — com a chave da sua organização.
        </Card>
        <Card
          icon="code"
          title="Webhooks e automações"
          subtitle="n8n, Make, Zapier, seu sistema"
          status={data.webhooks.total ? { tone: 'ok', text: `${data.webhooks.enabled} de ${data.webhooks.total} ativo(s)` } : { tone: 'muted', text: 'Nenhum endereço' }}
          onClick={() => setOpen('webhooks')}
          cta="Gerenciar"
        >
          O Ethos avisa seu endereço quando algo acontece (pagamento recebido, contrato ativado, chamado aberto…), com assinatura para você validar.
        </Card>
        <Card
          icon="key"
          title="Chaves de API"
          subtitle="Acesso de leitura aos seus dados"
          status={data.api_keys.active ? { tone: 'ok', text: `${data.api_keys.active} chave(s) ativa(s)` } : { tone: 'muted', text: 'Nenhuma chave' }}
          onClick={() => setOpen('keys')}
          cta="Gerenciar"
        >
          Para o n8n, planilhas e painéis consultarem o Ethos. As chaves são somente leitura por enquanto.
        </Card>
      </div>

      <div className="panel soon">
        <strong>Em breve</strong>
        <span className="muted">Cobranças pelo Asaas (boleto e Pix), conciliação automática, WhatsApp e e-mail, escrita via API.</span>
      </div>

      {open === 'asaas' && <AsaasModal conn={data.asaas} secretsReady={data.secrets_ready} onClose={close} />}
      {open === 'ai' && <AiModal initial={data.ai} secretsReady={data.secrets_ready} onClose={close} />}
      {open === 'webhooks' && <WebhooksModal secretsReady={data.secrets_ready} onClose={close} />}
      {open === 'keys' && (
        <Modal title="Chaves de API" subtitle="Consulta aos dados da organização (somente leitura)" size="lg" onClose={close}>
          <KeysPanel />
        </Modal>
      )}
    </section>
  )
}

type Tone = 'ok' | 'warn' | 'danger' | 'muted'
function badge(c: Conn): { tone: Tone; text: string } {
  if (!c.configured) return { tone: 'muted', text: 'Não conectado' }
  if (!c.enabled) return { tone: 'warn', text: 'Pausado' }
  if (c.last_status === 'ok') return { tone: 'ok', text: 'Conectado' }
  if (c.last_status === 'error') return { tone: 'danger', text: 'Erro na última verificação' }
  return { tone: 'warn', text: 'Chave salva, não testada' }
}

function Card({ icon, title, subtitle, status, onClick, cta, children }: { icon: IconName; title: string; subtitle: string; status: { tone: Tone; text: string }; onClick: () => void; cta: string; children: ReactNode }) {
  return (
    <article className="integration-card">
      <header>
        <span className="feature-icon"><Icon name={icon} /></span>
        <div>
          <h3>{title}</h3>
          <small className="muted">{subtitle}</small>
        </div>
      </header>
      <p>{children}</p>
      <footer>
        <span className={`audit-kind tone-${status.tone}`}>{status.text}</span>
        <button className="primary" onClick={onClick}>{cta}</button>
      </footer>
    </article>
  )
}

function TestResult({ conn }: { conn: Conn }) {
  if (!conn.last_tested_at) return <p className="muted small">Ainda não testada.</p>
  return (
    <p className={`small ${conn.last_status === 'ok' ? 'ok-text' : 'error-text'}`}>
      {conn.last_status === 'ok' ? 'Última verificação: conectado' : `Última verificação falhou: ${conn.last_error ?? 'erro'}`} · {dateTime(conn.last_tested_at)}
    </p>
  )
}

// ------------------------------------------------------------------------------------------------ Asaas

function AsaasModal({ conn, secretsReady, onClose }: { conn: Conn; secretsReady: boolean; onClose: () => void }) {
  const [env, setEnv] = useState(String(conn.config.environment ?? 'sandbox'))
  const [key, setKey] = useState('')
  const [enabled, setEnabled] = useState(conn.enabled || !conn.configured)
  const [state, setState] = useState(conn)
  const [busy, setBusy] = useState<'' | 'save' | 'test'>('')
  const [error, setError] = useState('')

  async function save(e?: FormEvent) {
    e?.preventDefault()
    setError('')
    setBusy('save')
    try {
      const r = await request<{ integration: Conn }>('/api/integrations/asaas', json('PUT', { api_key: key || undefined, environment: env, enabled }))
      setState(r.integration)
      setKey('')
      toast.success('Configuração do Asaas salva.')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy('')
    }
  }

  async function test() {
    setError('')
    setBusy('test')
    try {
      const r = await request<{ ok: boolean; message: string }>('/api/integrations/asaas/test', { method: 'POST' })
      setState((s) => ({ ...s, last_status: r.ok ? 'ok' : 'error', last_error: r.ok ? null : r.message, last_tested_at: new Date().toISOString() }))
      if (r.ok) toast.success(r.message)
      else toast.error(r.message)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy('')
    }
  }

  async function disconnect() {
    if (!(await ask('Desconectar o Asaas? A chave guardada será apagada.'))) return
    try {
      await request('/api/integrations/asaas', { method: 'DELETE' })
      toast.success('Asaas desconectado.')
      onClose()
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <Modal title="Asaas" subtitle="Pagamentos (boleto, Pix e cartão)" onClose={onClose}>
      <form className="stack" onSubmit={save}>
        {!secretsReady && <Alert>Defina INTEGRATIONS_SECRET no servidor para poder salvar a chave.</Alert>}
        <p className="muted small">
          No Asaas, abra <strong>Integrações › Chaves de API</strong> e gere uma chave. Use primeiro o <strong>sandbox</strong> (ambiente de testes) para validar sem mexer em dinheiro real.
        </p>
        <label>
          Ambiente
          <select value={env} onChange={(e) => setEnv(e.target.value)}>
            <option value="sandbox">Sandbox (testes)</option>
            <option value="production">Produção (dinheiro real)</option>
          </select>
        </label>
        <label>
          Chave de API {state.hint && <span className="muted small">— guardada, termina em …{state.hint}</span>}
          <PasswordInput value={key} onChange={(e) => setKey(e.target.value)} placeholder={state.configured ? 'Deixe em branco para manter a atual' : 'Cole a chave do Asaas'} autoComplete="off" />
        </label>
        <label className="check-line">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>Integração ativa</span>
        </label>
        {state.configured && <TestResult conn={state} />}
        {error && <Alert>{error}</Alert>}
        <div className="actions">
          {state.configured && <button type="button" className="danger" onClick={disconnect}>Desconectar</button>}
          {state.configured && <button type="button" disabled={busy !== ''} onClick={test}>{busy === 'test' ? 'Testando…' : 'Testar conexão'}</button>}
          <button type="submit" className="primary" disabled={busy !== '' || !secretsReady}>{busy === 'save' ? 'Salvando…' : 'Salvar'}</button>
        </div>
      </form>
    </Modal>
  )
}

// ------------------------------------------------------------------------------------------------ IA (vários provedores)

function AiModal({ initial, secretsReady, onClose }: { initial: State['ai']; secretsReady: boolean; onClose: () => void }) {
  const [ai, setAi] = useState(initial)
  const firstConfigured = initial.catalog.find((c) => initial.providers[c.id]?.configured)?.id
  const [id, setId] = useState(initial.active?.provider && initial.active.source === 'organization' ? initial.active.provider : (firstConfigured ?? 'openai'))
  const def = ai.catalog.find((c) => c.id === id)!
  const conn = ai.providers[id]
  const [key, setKey] = useState('')
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [primary, setPrimary] = useState(false)
  const [busy, setBusy] = useState<'' | 'save' | 'test'>('')
  const [error, setError] = useState('')

  // Ao trocar de provedor, carrega os valores dele.
  useEffect(() => {
    const c = ai.providers[id]
    setKey('')
    setError('')
    setModel(String(c?.config.model ?? ''))
    setBaseUrl(String(c?.config.base_url ?? ''))
    setEnabled(c ? c.enabled : true)
    setPrimary(c ? c.config.primary === true : !Object.values(ai.providers).some((p) => p.configured))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const reload = async () => {
    const fresh = await request<State>('/api/integrations')
    setAi(fresh.ai)
    return fresh.ai
  }

  async function save(e?: FormEvent) {
    e?.preventDefault()
    setError('')
    setBusy('save')
    try {
      await request(`/api/integrations/${id}`, json('PUT', { api_key: key || undefined, model, base_url: def.id === 'custom' ? baseUrl : undefined, enabled, primary }))
      setKey('')
      await reload()
      toast.success(`${def.label.split(' (')[0]} salvo.`)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy('')
    }
  }

  async function test() {
    setError('')
    setBusy('test')
    try {
      const r = await request<{ ok: boolean; message: string }>(`/api/integrations/${id}/test`, { method: 'POST' })
      await reload()
      if (r.ok) toast.success(r.message)
      else toast.error(r.message)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy('')
    }
  }

  async function disconnect() {
    if (!(await ask(`Remover a chave de ${def.label}?`))) return
    try {
      await request(`/api/integrations/${id}`, { method: 'DELETE' })
      toast.success('Chave removida.')
      await reload()
      setKey('')
    } catch (err) {
      setError(errorText(err))
    }
  }

  const listId = `models-${id}`
  return (
    <Modal title="IA — leitura de documentos" subtitle="Escolha o provedor e cole a sua chave" size="lg" onClose={onClose}>
      <div className="stack">
        {!secretsReady && <Alert>Defina INTEGRATIONS_SECRET no servidor para poder salvar chaves.</Alert>}
        <p className="muted small">
          {ai.active ? (
            <>
              Em uso agora: <strong>{ai.active.label}</strong>
              {ai.active.model ? ` · ${ai.active.model}` : ''}
              {ai.active.source === 'server' ? ' (chave padrão do servidor)' : ''}.
            </>
          ) : (
            'Nenhum provedor em uso: a leitura de documentos está desligada.'
          )}{' '}
          Você pode configurar vários e escolher qual usar. Cada documento lido é enviado ao provedor escolhido só para leitura e não fica guardado no Ethos.
        </p>

        <div className="provider-chips" role="tablist" aria-label="Provedores">
          {ai.catalog.map((c) => {
            const p = ai.providers[c.id]
            return (
              <button key={c.id} role="tab" aria-selected={c.id === id} className={c.id === id ? 'chip active' : 'chip'} onClick={() => setId(c.id)}>
                {c.label.split(' (')[0]}
                {p?.configured && <span className={`chip-dot ${p.enabled ? (p.config.primary ? 'main' : 'on') : 'off'}`} aria-label={p.config.primary ? 'em uso' : 'configurado'} />}
              </button>
            )
          })}
        </div>

        <form className="stack" onSubmit={save}>
          <div className="provider-note">
            <strong>{def.label}</strong>
            <span className="muted small">
              {def.vision ? 'Lê fotos' : 'Não lê fotos (só texto)'} · {def.kind === 'anthropic' || def.pdf ? 'lê PDF direto' : 'PDF: o texto é extraído antes de enviar'}
              {def.keyUrl ? ` · criar chave: ${def.keyUrl}` : ''}
            </span>
            {def.note && <span className="muted small">{def.note}</span>}
          </div>

          {def.id === 'custom' && (
            <label>
              URL base (https)
              <input type="url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://meu-servico.com/v1" required />
            </label>
          )}
          <label>
            Chave de API {conn?.hint && <span className="muted small">— guardada, termina em …{conn.hint}</span>}
            <PasswordInput value={key} onChange={(e) => setKey(e.target.value)} placeholder={conn?.configured ? 'Deixe em branco para manter a atual' : def.kind === 'anthropic' ? 'sk-ant-…' : 'Cole a chave'} autoComplete="off" />
          </label>
          <label>
            Modelo {def.kind !== 'anthropic' && <span className="muted small">— digite o ID exato (as opções são sugestões)</span>}
            {def.kind === 'anthropic' ? (
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                <option value="">Padrão do sistema</option>
                {def.models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            ) : (
              <>
                <input list={listId} value={model} onChange={(e) => setModel(e.target.value)} placeholder={def.models[0] ?? 'ID do modelo'} maxLength={100} />
                <datalist id={listId}>
                  {def.models.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </>
            )}
          </label>
          <label className="check-line">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span>Ativo</span>
          </label>
          <label className="check-line">
            <input type="checkbox" checked={primary} onChange={(e) => setPrimary(e.target.checked)} />
            <span>Usar este provedor para ler documentos</span>
          </label>
          {conn?.configured && <TestResult conn={conn} />}
          {error && <Alert>{error}</Alert>}
          <div className="actions">
            {conn?.configured && <button type="button" className="danger" onClick={disconnect}>Remover chave</button>}
            {conn?.configured && <button type="button" disabled={busy !== ''} onClick={test}>{busy === 'test' ? 'Testando…' : 'Testar conexão'}</button>}
            <button type="submit" className="primary" disabled={busy !== '' || !secretsReady}>{busy === 'save' ? 'Salvando…' : 'Salvar'}</button>
          </div>
        </form>
      </div>
    </Modal>
  )
}

// ------------------------------------------------------------------------------------------------ Webhooks

function WebhooksModal({ secretsReady, onClose }: { secretsReady: boolean; onClose: () => void }) {
  const [items, setItems] = useState<Hook[] | null>(null)
  const [events, setEvents] = useState<EventDef[]>([])
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Hook | 'new' | null>(null)
  const [log, setLog] = useState<Hook | null>(null)
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const [l, e] = await Promise.all([request<{ items: Hook[] }>('/api/webhooks'), request<{ events: EventDef[] }>('/api/webhooks/events')])
      setItems(l.items)
      setEvents(e.events)
      setError('')
    } catch (err) {
      setError(errorText(err))
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  async function test(h: Hook) {
    try {
      const r = await request<{ ok: boolean; error: string | null; http_status: number | null }>(`/api/webhooks/${h.id}/test`, { method: 'POST' })
      if (r.ok) toast.success(`“${h.name}” respondeu HTTP ${r.http_status}. Conexão funcionando.`)
      else toast.error(`“${h.name}”: ${r.error ?? 'falhou'}`)
      await load()
    } catch (err) {
      toast.error(errorText(err))
    }
  }
  async function toggle(h: Hook) {
    try {
      await request(`/api/webhooks/${h.id}`, json('PATCH', { enabled: !h.enabled }))
      await load()
    } catch (err) {
      toast.error(errorText(err))
    }
  }
  async function remove(h: Hook) {
    if (!(await ask(`Excluir o endereço "${h.name}"? Ele deixa de receber eventos.`))) return
    try {
      await request(`/api/webhooks/${h.id}`, { method: 'DELETE' })
      toast.success('Endereço excluído.')
      await load()
    } catch (err) {
      toast.error(errorText(err))
    }
  }
  async function rotate(h: Hook) {
    if (!(await ask(`Gerar um novo segredo para "${h.name}"? O segredo atual para de funcionar na hora e você precisará atualizá-lo no destino.`))) return
    try {
      const r = await request<{ secret: string }>(`/api/webhooks/${h.id}/rotate-secret`, { method: 'POST' })
      setSecret({ name: h.name, value: r.secret })
    } catch (err) {
      toast.error(errorText(err))
    }
  }

  return (
    <Modal title="Webhooks e automações" subtitle="O Ethos envia um aviso assinado ao seu endereço a cada evento" size="lg" onClose={onClose}>
      {!secretsReady && <Alert>Defina INTEGRATIONS_SECRET no servidor para poder criar endereços.</Alert>}
      {error && <Alert>{error}</Alert>}
      <div className="toolbar">
        <span className="muted small grow">No n8n, crie um nó <strong>Webhook</strong> (método POST) e cole a URL aqui. Só endereços https públicos são aceitos.</span>
        <button className="primary" disabled={!secretsReady} onClick={() => setEditing('new')}>Novo endereço</button>
      </div>
      {!items ? (
        <Loading label="Carregando…" />
      ) : items.length === 0 ? (
        <p className="empty">Nenhum endereço ainda. Crie o primeiro para começar a automatizar.</p>
      ) : (
        <ul className="hook-list">
          {items.map((h) => (
            <li key={h.id} className={h.enabled ? '' : 'paused'}>
              <div className="grow">
                <strong>{h.name}</strong> {!h.enabled && <span className="audit-kind tone-warn">Pausado</span>}
                <div className="muted small hook-url">{h.url}</div>
                <div className="small">
                  {h.events.includes('*') ? 'Todos os eventos' : `${h.events.length} evento(s)`}
                  {' · '}
                  {h.last_at ? (
                    <span className={h.last_status === 'ok' ? 'ok-text' : 'error-text'}>
                      última entrega {h.last_status === 'ok' ? 'ok' : `falhou${h.last_http_status ? ` (HTTP ${h.last_http_status})` : ''}`} · {dateTime(h.last_at)}
                    </span>
                  ) : (
                    <span className="muted">nenhuma entrega ainda</span>
                  )}
                </div>
              </div>
              <div className="hook-actions">
                <button onClick={() => test(h)}>Testar</button>
                <button onClick={() => setLog(h)}>Entregas</button>
                <button onClick={() => setEditing(h)}>Editar</button>
                <button onClick={() => toggle(h)}>{h.enabled ? 'Pausar' : 'Ativar'}</button>
                <button onClick={() => rotate(h)}>Novo segredo</button>
                <button className="danger" onClick={() => remove(h)}>Excluir</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <HookForm
          hook={editing === 'new' ? null : editing}
          events={events}
          onClose={() => setEditing(null)}
          onSaved={(created) => {
            setEditing(null)
            if (created) setSecret(created)
            void load()
          }}
        />
      )}
      {log && <DeliveriesModal hook={log} onClose={() => setLog(null)} />}
      {secret && <SecretModal info={secret} onClose={() => setSecret(null)} />}
    </Modal>
  )
}

function HookForm({ hook, events, onClose, onSaved }: { hook: Hook | null; events: EventDef[]; onClose: () => void; onSaved: (created?: { name: string; value: string }) => void }) {
  const [name, setName] = useState(hook?.name ?? '')
  const [url, setUrl] = useState(hook?.url ?? '')
  const [all, setAll] = useState(hook ? hook.events.includes('*') : true)
  const [picked, setPicked] = useState<string[]>(hook && !hook.events.includes('*') ? hook.events : [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const groups = [...new Set(events.map((e) => e.group))]

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    const chosen = all ? ['*'] : picked
    if (chosen.length === 0) return setError('Escolha pelo menos um evento ou marque “Todos os eventos”.')
    setBusy(true)
    try {
      if (hook) {
        await request(`/api/webhooks/${hook.id}`, json('PATCH', { name, url, events: chosen }))
        toast.success('Endereço atualizado.')
        onSaved()
      } else {
        const r = await request<{ item: Hook; secret: string }>('/api/webhooks', json('POST', { name, url, events: chosen }))
        onSaved({ name: r.item.name, value: r.secret })
      }
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={hook ? 'Editar endereço' : 'Novo endereço'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label>
          Nome
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required placeholder="Ex.: n8n — financeiro" />
        </label>
        <label>
          URL de destino
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="https://n8n.seudominio.com/webhook/ethos" />
        </label>
        <fieldset className="event-picker">
          <legend>Eventos</legend>
          <label className="check-line">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            <span>Todos os eventos (inclusive os que forem criados no futuro)</span>
          </label>
          {!all &&
            groups.map((g) => (
              <div key={g} className="event-group">
                <strong>{g}</strong>
                {events
                  .filter((e) => e.group === g)
                  .map((e) => (
                    <label key={e.event} className="check-line">
                      <input type="checkbox" checked={picked.includes(e.event)} onChange={(ev) => setPicked((p) => (ev.target.checked ? [...p, e.event] : p.filter((x) => x !== e.event)))} />
                      <span>{e.label} <code>{e.event}</code></span>
                    </label>
                  ))}
              </div>
            ))}
        </fieldset>
        {error && <Alert>{error}</Alert>}
        <div className="actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar'}</button>
        </div>
      </form>
    </Modal>
  )
}

function SecretModal({ info, onClose }: { info: { name: string; value: string }; onClose: () => void }) {
  return (
    <Modal title="Segredo de assinatura" subtitle={info.name} size="md" locked onClose={onClose}>
      <div className="stack">
        <p><strong>Copie agora: este segredo não será mostrado de novo.</strong> Use-o no destino para conferir que cada aviso veio mesmo do Ethos.</p>
        <div className="secret-box">
          <code>{info.value}</code>
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(info.value)
                toast.success('Segredo copiado.')
              } catch {
                toast.error('Não foi possível copiar. Selecione e copie manualmente.')
              }
            }}
          >
            Copiar
          </button>
        </div>
        <details>
          <summary>Como validar a assinatura</summary>
          <p className="muted small">
            Cada envio traz <code>X-Ethos-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code>, onde <code>v1</code> é o HMAC-SHA256 do texto <code>&lt;t&gt;.&lt;corpo&gt;</code> com este segredo. Rejeite se <code>t</code> for muito antigo (ex.: mais de 5 minutos).
            Outros cabeçalhos: <code>X-Ethos-Event</code> e <code>X-Ethos-Delivery</code>. O n8n pode ignorar a assinatura no começo, mas valide em produção.
          </p>
          <pre className="doc-preview">{`const sig = req.headers['x-ethos-signature'] // "t=...,v1=..."
const [t, v1] = sig.split(',').map((p) => p.split('=')[1])
const esperado = crypto.createHmac('sha256', SEGREDO)
  .update(t + '.' + rawBody).digest('hex')
const ok = crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(esperado))`}</pre>
        </details>
        <div className="modal-actions"><button className="primary" onClick={onClose}>Já copiei</button></div>
      </div>
    </Modal>
  )
}

function DeliveriesModal({ hook, onClose }: { hook: Hook; onClose: () => void }) {
  const [items, setItems] = useState<Delivery[] | null>(null)
  useEffect(() => {
    request<{ items: Delivery[] }>(`/api/webhooks/${hook.id}/deliveries`).then((r) => setItems(r.items)).catch(() => setItems([]))
  }, [hook.id])
  return (
    <Modal title="Últimas entregas" subtitle={hook.name} size="lg" onClose={onClose}>
      {!items ? (
        <Loading label="Carregando…" />
      ) : items.length === 0 ? (
        <p className="empty">Nenhuma entrega registrada ainda. Use “Testar” para enviar um aviso de verificação.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Quando</th><th>Evento</th><th>Resultado</th><th>Tentativas</th><th>Tempo</th></tr></thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.id}>
                  <td>{dateTime(d.created_at)}</td>
                  <td><code>{d.event}</code></td>
                  <td>
                    <span className={`audit-kind tone-${d.status === 'ok' ? 'ok' : 'danger'}`}>{d.status === 'ok' ? 'Entregue' : 'Falhou'}</span>
                    {d.http_status ? ` HTTP ${d.http_status}` : ''}
                    {d.error && <div className="muted small">{d.error}</div>}
                  </td>
                  <td>{d.attempts}</td>
                  <td>{d.duration_ms !== null ? `${d.duration_ms} ms` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}
