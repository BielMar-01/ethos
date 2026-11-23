import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, type ApiKey, type OpenApiDoc } from './api'
import { dateTime } from './format'
import { Alert, Loading, ask, toast } from './feedback'

const message = (e: unknown) => (e instanceof Error ? e.message : 'Erro inesperado')

interface Op {
  method: string
  path: string
  tag: string
  summary: string
  description: string
  apiKey: boolean
  params: { name: string; in: string; description?: string; example?: string | number }[]
  requestExample?: unknown
  status: string
  responseExample?: unknown
}

function flatten(doc: OpenApiDoc): Op[] {
  const ops: Op[] = []
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const status = Object.keys(op.responses).find((s) => s.startsWith('2')) ?? '200'
      ops.push({
        method,
        path,
        tag: op.tags[0] ?? 'Outros',
        summary: op.summary,
        description: op.description,
        apiKey: op.security.some((s) => 'ApiKey' in s),
        params: op.parameters,
        requestExample: op.requestBody?.content['application/json'].example,
        status,
        responseExample: op.responses[status]?.content?.['application/json'].example,
      })
    }
  }
  return ops
}

const pretty = (v: unknown) => JSON.stringify(v, null, 2)

function curl(op: Op, origin: string): string {
  const qs = op.params.filter((p) => p.in === 'query' && p.example !== undefined).slice(0, 1)
  const path = op.path.replace(/\{\w+\}/g, '1') + (qs.length ? `?${qs[0]!.name}=${qs[0]!.example}` : '')
  return `curl -H "Authorization: Bearer SUA_CHAVE" \\\n  "${origin}${path}"`
}

export default function ApiPage({ isAdmin }: { isAdmin: boolean }) {
  const [doc, setDoc] = useState<OpenApiDoc | null>(null)
  const [error, setError] = useState('')
  const origin = window.location.origin.includes(':5173') ? 'http://localhost:3000' : window.location.origin

  useEffect(() => {
    api.openapi().then(setDoc).catch((e) => setError(message(e)))
  }, [])

  const ops = doc ? flatten(doc) : []
  const tags = [...new Set(ops.map((o) => o.tag))]

  return (
    <section>
      <div className="page-head">
        <h2>API</h2>
        <a className="button-link" href="/api/openapi.json" target="_blank" rel="noreferrer">
          Baixar OpenAPI (JSON)
        </a>
      </div>
      {error && <Alert>{error}</Alert>}

      <div className="panel stack">
        <h3 style={{ margin: 0 }}>Como consumir</h3>
        <p className="muted">
          A API é REST/JSON. Para integrações, um administrador cria uma <strong>chave de API</strong> (aba API do painel) e você a envia no cabeçalho{' '}
          <code>Authorization: Bearer ethos_…</code>. As chaves são <strong>somente leitura</strong> e enxergam apenas a sua organização.
          Valores monetários são <strong>inteiros em centavos</strong>; datas são <code>AAAA-MM-DD</code>.
        </p>
        <pre className="code">{`curl -H "Authorization: Bearer SUA_CHAVE" \\\n  "${origin}/api/charges?month=2026-11&status=vencida"`}</pre>
        <p className="muted small">
          Os exemplos de resposta abaixo são <strong>mocks ilustrativos</strong> (dados fictícios) que mostram o formato real de cada endpoint.
          Operações de escrita e a área do cliente exigem login (sessão) e não aceitam chave.
        </p>
      </div>

      {isAdmin && <KeysPanel />}

      {!doc ? (
        <Loading label="Carregando documentação…" />
      ) : (
        tags.map((tag) => (
          <div key={tag}>
            <h3>{tag}</h3>
            <div className="panel endpoints">
              {ops
                .filter((o) => o.tag === tag)
                .map((o) => (
                  <details key={`${o.method} ${o.path}`}>
                    <summary>
                      <span className={`method method-${o.method}`}>{o.method.toUpperCase()}</span>
                      <code>{o.path}</code>
                      <span className="muted"> — {o.summary}</span>
                      {o.apiKey && <span className="badge badge-vigente key-badge">chave de API</span>}
                    </summary>
                    <div className="endpoint-body">
                      <p className="muted small" style={{ whiteSpace: 'pre-line' }}>{o.description.replace(/\*\*/g, '')}</p>
                      {o.params.length > 0 && (
                        <table>
                          <thead><tr><th>Parâmetro</th><th>Em</th><th>Descrição</th><th>Exemplo</th></tr></thead>
                          <tbody>
                            {o.params.map((p) => (
                              <tr key={p.name}><td><code>{p.name}</code></td><td>{p.in}</td><td>{p.description ?? '—'}</td><td>{String(p.example ?? '')}</td></tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                      {o.apiKey && o.method === 'get' && <pre className="code">{curl(o, origin)}</pre>}
                      {o.requestExample !== undefined && (
                        <>
                          <div className="muted small">Corpo da requisição (exemplo)</div>
                          <pre className="code">{pretty(o.requestExample)}</pre>
                        </>
                      )}
                      {o.responseExample !== undefined && (
                        <>
                          <div className="muted small">Resposta {o.status} (exemplo ilustrativo)</div>
                          <pre className="code">{pretty(o.responseExample)}</pre>
                        </>
                      )}
                    </div>
                  </details>
                ))}
            </div>
          </div>
        ))
      )}
    </section>
  )
}

function KeysPanel() {
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [name, setName] = useState('')
  const [created, setCreated] = useState<string | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setKeys((await api.apiKeys()).items)
    } catch (e) {
      setError(message(e))
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function create(e: FormEvent) {
    e.preventDefault()
    setError('')
    try {
      const r = await api.createApiKey(name)
      setCreated(r.token)
      setName('')
      await load()
      toast.success('Chave criada. Copie agora: ela não será mostrada de novo.')
    } catch (err) {
      setError(message(err))
    }
  }

  async function revoke(k: ApiKey) {
    if (!(await ask(`Revogar a chave "${k.name}"? Integrações que a usam deixam de funcionar.`))) return
    try {
      await api.revokeApiKey(k.id)
      await load()
      toast.success('Chave revogada.')
    } catch (err) {
      setError(message(err))
    }
  }

  return (
    <div className="panel stack">
      <h3 style={{ margin: 0 }}>Chaves de API</h3>
      {error && <Alert>{error}</Alert>}
      {created && (
        <div className="key-once">
          <strong>Copie agora: esta chave não será exibida novamente.</strong>
          <input readOnly value={created} aria-label="Nova chave de API" onFocus={(e) => e.currentTarget.select()} />
          <div className="actions">
            <button onClick={() => setCreated(null)}>Já copiei</button>
            <button className="primary" onClick={() => navigator.clipboard?.writeText(created)}>Copiar</button>
          </div>
        </div>
      )}
      <form className="inline" onSubmit={create}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome (ex.: Integração BI)" maxLength={100} required aria-label="Nome da chave" />
        <button type="submit" className="primary">Criar chave</button>
      </form>
      {keys.length === 0 ? (
        <p className="muted">Nenhuma chave criada.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Nome</th><th>Chave</th><th>Criada</th><th>Último uso</th><th /></tr></thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} className={k.revoked_at ? 'voided' : ''}>
                  <td>{k.name}</td>
                  <td><code>{k.prefix}…</code></td>
                  <td>{dateTime(k.created_at)}</td>
                  <td>{k.last_used_at ? dateTime(k.last_used_at) : 'nunca'}</td>
                  <td className="row-actions">
                    {k.revoked_at ? <span className="badge badge-c-cancelada">revogada</span> : <button className="danger" onClick={() => revoke(k)}>Revogar</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
