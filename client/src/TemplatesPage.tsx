import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { api, type Template, type TemplateVariables } from './api'
import { dateTime } from './format'
import { Alert, Loading, ask, toast } from './feedback'
import CompanyModal from './CompanyModal'
import Modal from './Modal'

const message = (e: unknown) => (e instanceof Error ? e.message : 'Erro inesperado')

type Starter = { id: string; type: string; name: string; description: string; body: string }

export default function TemplatesPage({ canDelete }: { canDelete: boolean }) {
  const [items, setItems] = useState<Template[]>([])
  const [meta, setMeta] = useState<TemplateVariables>({ variables: [], blocks: [], types: [] })
  const [starters, setStarters] = useState<Starter[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Template | 'new' | null>(null)
  const [viewing, setViewing] = useState<Template | null>(null)
  const [company, setCompany] = useState(false)
  const [name, setName] = useState('')
  const [type, setType] = useState('locacao_residencial')
  const [body, setBody] = useState('')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('')
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  const load = useCallback(async () => {
    try {
      const [t, v, s] = await Promise.all([api.templates(), api.variables(), api.starters()])
      setItems(t.items)
      setMeta(v)
      setStarters(s.items)
    } catch (e) {
      setError(message(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const typeLabel = (value: string) => meta.types.find((t) => t.value === value)?.label ?? value

  function open(t: Template | 'new') {
    setError('')
    setSearch('')
    setName(t === 'new' ? '' : t.name)
    setType(t === 'new' ? 'locacao_residencial' : t.type)
    setBody(t === 'new' ? '' : t.body)
    setEditing(t)
  }

  /** Insere o texto na posição do cursor (ou envolve a seleção, no caso de blocos). */
  function insert(before: string, after = '') {
    const el = bodyRef.current
    const s = el?.selectionStart ?? body.length
    const e = el?.selectionEnd ?? body.length
    const selected = after ? body.slice(s, e) : ''
    const token = before + selected + after
    setBody(body.slice(0, s) + token + body.slice(e))
    requestAnimationFrame(() => {
      el?.focus()
      const cursor = after && !selected ? s + before.length : s + token.length
      el?.setSelectionRange(cursor, cursor)
    })
  }

  async function useStarter(id: string) {
    const starter = starters.find((s) => s.id === id)
    if (!starter) return
    if (body.trim() && !(await ask('Substituir o texto que está no editor pelo modelo escolhido?'))) return
    setBody(starter.body)
    setType(starter.type)
    if (!name.trim()) setName(starter.name)
    toast.info(starter.description)
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    setError('')
    try {
      if (editing === 'new') await api.createTemplate(name, type, body)
      else if (editing) await api.updateTemplate(editing.id, name, type, body)
      setEditing(null)
      await load()
    } catch (err) {
      setError(message(err))
    }
  }

  async function remove(t: Template) {
    if (!(await ask(`Excluir o modelo "${t.name}"? Documentos já emitidos não são afetados.`))) return
    try {
      await api.removeTemplate(t.id)
      await load()
      toast.success('Modelo excluído.')
    } catch (err) {
      setError(message(err))
    }
  }

  const q = search.trim().toLowerCase()
  const matches = meta.variables.filter((v) => !q || v.key.includes(q) || v.label.toLowerCase().includes(q) || v.group.toLowerCase().includes(q))
  const groups = [...new Set(matches.map((v) => v.group))]
  const visible = filter ? items.filter((t) => t.type === filter) : items

  return (
    <section>
      <div className="page-head">
        <h2>Modelos de contrato</h2>
        {items.length > 0 && (
          <select aria-label="Filtrar por tipo" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">Todos os tipos</option>
            {meta.types.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        )}
        <button onClick={() => setCompany(true)}>Dados da empresa</button>
        <button className="primary" onClick={() => open('new')}>
          Novo modelo
        </button>
      </div>
      {error && <Alert>{error}</Alert>}
      {company && <CompanyModal canEdit={canDelete} onClose={() => setCompany(false)} />}

      {viewing && (
        <Modal
          title={viewing.name}
          subtitle={`${typeLabel(viewing.type)} · versão ${viewing.version} · atualizado em ${dateTime(viewing.updated_at)}`}
          size="lg"
          onClose={() => setViewing(null)}
          footer={
            <>
              <button onClick={() => setViewing(null)}>Fechar</button>
              {canDelete && (
                <button
                  className="danger"
                  onClick={() => {
                    const x = viewing
                    setViewing(null)
                    void remove(x)
                  }}
                >
                  Excluir
                </button>
              )}
              <button
                className="primary"
                onClick={() => {
                  const x = viewing
                  setViewing(null)
                  open(x)
                }}
              >
                Editar
              </button>
            </>
          }
        >
          <pre className="doc-preview">{viewing.body}</pre>
        </Modal>
      )}

      {editing && (
        <Modal title={editing === 'new' ? 'Novo modelo' : `Editar modelo (versão atual: ${editing.version})`} size="xl" onClose={() => setEditing(null)}>
        <form className="stack" onSubmit={save}>
          <div className="form-grid">
            <label>
              Nome
              <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
            </label>
            <label>
              Tipo de contrato
              <select value={type} onChange={(e) => setType(e.target.value)}>
                {meta.types.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </label>
            <label>
              Começar de um modelo pronto
              <select value="" onChange={(e) => void useStarter(e.target.value)}>
                <option value="">Escolha…</option>
                {starters.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
          </div>
          <p className="muted small">O modelo padrão da Ethos ainda aguarda revisão jurídica. Os esqueletos não têm cláusulas. Use em contratos reais somente o texto aprovado.</p>

          <div className="stack">
            <label>
              Variáveis (clique para inserir na posição do cursor)
              <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Procurar: rg, aluguel, garantia…" />
            </label>
            <div>
              {groups.map((g, i) => (
                <details key={g} className="var-group" open={Boolean(q) || i === 0}>
                  <summary>{g}</summary>
                  <div className="chips">
                    {matches.filter((v) => v.group === g).map((v) => (
                      <button type="button" key={v.key} className="chip" title={v.label} onClick={() => insert(`{{${v.key}}}`)}>
                        {`{{${v.key}}}`}
                      </button>
                    ))}
                  </div>
                </details>
              ))}
              {groups.length === 0 && <p className="muted small">Nenhuma variável encontrada.</p>}
            </div>
            <div className="inline" role="group" aria-label="Estrutura do documento">
              {meta.blocks.map((b) => (
                <button type="button" key={b.key} onClick={() => insert(`{{#${b.key}}}\n`, `\n{{/${b.key}}}`)}>{b.label}</button>
              ))}
              <button type="button" onClick={() => insert('\n## ')}>Seção</button>
              <button type="button" onClick={() => insert('**', '**')}>Negrito</button>
              <button type="button" onClick={() => insert('\n[[assinaturas]]\n')}>Quadro de assinaturas</button>
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
          <details className="var-group">
            <summary>Como formatar</summary>
            <ul className="plain-list small">
              <li><code># </code> no começo da linha: título do documento. <code>## </code>: título de seção.</li>
              <li><code>&gt; </code> no começo da linha: quadro de aviso. <code>**texto**</code>: negrito.</li>
              <li>Linha em branco separa parágrafos. Subcláusulas como <code>**4.5.1 —**</code> ficam recuadas.</li>
              <li>Com mais de um locatário ou locador, envolva o parágrafo no bloco: ele se repete para cada pessoa.</li>
              <li><code>{'{{locador.qualificacao}}'}</code> monta a qualificação completa (pessoa física ou jurídica) e exige os dados do cadastro.</li>
              <li><code>[[assinaturas]]</code> marca o lugar das assinaturas (sem isso, vão para o fim).</li>
            </ul>
          </details>
          <p className="muted small">
            Ao salvar uma alteração no texto, a versão do modelo sobe. Documentos já emitidos mantêm a versão com que foram gerados.
          </p>
          {error && <Alert>{error}</Alert>}
          <div className="actions">
            <button type="button" onClick={() => setEditing(null)}>
              Cancelar
            </button>
            <button type="submit" className="primary">
              Salvar
            </button>
          </div>
        </form>
        </Modal>
      )}

      {loading ? (
        <Loading label="Carregando…" />
      ) : visible.length === 0 ? (
        <p className="empty">{items.length === 0 ? 'Nenhum modelo cadastrado ainda. Em “Novo modelo” você pode começar do padrão da Ethos.' : 'Nenhum modelo deste tipo.'}</p>
      ) : (
        <div className="panel table-wrap">
          <table>
            <thead>
              <tr>
                <th>Nome</th>
                <th>Tipo</th>
                <th>Versão</th>
                <th>Atualizado em</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((t) => (
                <tr key={t.id} className="clickable" onClick={() => setViewing(t)}>
                  <td>{t.name}</td>
                  <td>{typeLabel(t.type)}</td>
                  <td>v{t.version}</td>
                  <td>{dateTime(t.updated_at)}</td>
                  <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => setViewing(t)}>Ver</button>
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
