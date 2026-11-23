import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { api, type Template } from './api'
import { dateTime } from './format'

const message = (e: unknown) => (e instanceof Error ? e.message : 'Erro inesperado')

// Ponto de partida apenas ilustrativo: NÃO tem validade jurídica; deve ser substituído
// por um modelo aprovado pela administração/jurídico.
const EXAMPLE = `CONTRATO DE LOCAÇÃO RESIDENCIAL

LOCADOR: {{locador.nome}}, documento {{locador.documento}}.
LOCATÁRIO: {{locatario.nome}}, documento {{locatario.cpf}}.

OBJETO: imóvel situado em {{imovel.endereco}}, unidade {{unidade.identificacao}}.

PRAZO: de {{contrato.data_inicio}} a {{contrato.data_fim}}.

ALUGUEL: {{contrato.valor_aluguel}} mensais, com vencimento todo dia {{contrato.dia_vencimento}}.

GARANTIA: {{contrato.garantia}}.

[Inclua aqui as cláusulas aprovadas pela administração.]`

export default function TemplatesPage({ canDelete }: { canDelete: boolean }) {
  const [items, setItems] = useState<Template[]>([])
  const [variables, setVariables] = useState<{ key: string; label: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Template | 'new' | null>(null)
  const [name, setName] = useState('')
  const [body, setBody] = useState('')
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  const load = useCallback(async () => {
    try {
      const [t, v] = await Promise.all([api.templates(), api.variables()])
      setItems(t.items)
      setVariables(v.variables)
    } catch (e) {
      setError(message(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  function open(t: Template | 'new') {
    setError('')
    setName(t === 'new' ? '' : t.name)
    setBody(t === 'new' ? '' : t.body)
    setEditing(t)
  }

  function insertVariable(key: string) {
    const el = bodyRef.current
    const token = `{{${key}}}`
    if (!el) {
      setBody((b) => b + token)
      return
    }
    const { selectionStart: s, selectionEnd: e } = el
    setBody(body.slice(0, s) + token + body.slice(e))
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(s + token.length, s + token.length)
    })
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    setError('')
    try {
      if (editing === 'new') await api.createTemplate(name, body)
      else if (editing) await api.updateTemplate(editing.id, name, body)
      setEditing(null)
      await load()
    } catch (err) {
      setError(message(err))
    }
  }

  async function remove(t: Template) {
    if (!window.confirm(`Excluir o modelo "${t.name}"? Documentos já emitidos não são afetados.`)) return
    try {
      await api.removeTemplate(t.id)
      await load()
    } catch (err) {
      setError(message(err))
    }
  }

  return (
    <section>
      <div className="page-head">
        <h2>Modelos de contrato</h2>
        <button className="primary" onClick={() => open('new')}>
          Novo modelo
        </button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}

      {editing && (
        <form className="panel stack" onSubmit={save}>
          <h3>{editing === 'new' ? 'Novo modelo' : `Editar modelo (versão atual: ${editing.version})`}</h3>
          <label>
            Nome
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
          </label>
          <div>
            <div className="muted small">Clique para inserir uma variável na posição do cursor:</div>
            <div className="chips">
              {variables.map((v) => (
                <button type="button" key={v.key} className="chip" title={v.label} onClick={() => insertVariable(v.key)}>
                  {`{{${v.key}}}`}
                </button>
              ))}
            </div>
          </div>
          <label>
            Texto do contrato
            <textarea
              ref={bodyRef}
              className="editor"
              rows={18}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              required
            />
          </label>
          {!body.trim() && (
            <div>
              <button type="button" onClick={() => setBody(EXAMPLE)}>
                Inserir texto de exemplo
              </button>
              <span className="muted small"> O exemplo não tem validade jurídica: use o modelo aprovado pela administração.</span>
            </div>
          )}
          <p className="muted small">
            Ao salvar uma alteração no texto, a versão do modelo sobe. Documentos já emitidos mantêm a versão com que foram gerados.
          </p>
          <div className="actions">
            <button type="button" onClick={() => setEditing(null)}>
              Cancelar
            </button>
            <button type="submit" className="primary">
              Salvar
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <p className="muted">Carregando…</p>
      ) : items.length === 0 ? (
        <p className="empty">Nenhum modelo cadastrado ainda.</p>
      ) : (
        <div className="panel table-wrap">
          <table>
            <thead>
              <tr>
                <th>Nome</th>
                <th>Versão</th>
                <th>Atualizado em</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>v{t.version}</td>
                  <td>{dateTime(t.updated_at)}</td>
                  <td className="row-actions">
                    <button onClick={() => open(t)}>Editar</button>
                    {canDelete && (
                      <button className="danger" onClick={() => remove(t)}>
                        Excluir
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
