import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, type Item } from './api'
import type { FieldDef, ResourceDef } from './resources'

type FormState = Record<string, string>

function toForm(fields: FieldDef[], item?: Item): FormState {
  return Object.fromEntries(fields.map((f) => [f.name, item?.[f.name] != null ? String(item[f.name]) : '']))
}

function toBody(fields: FieldDef[], form: FormState): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const f of fields) {
    const v = form[f.name]
    if (v === '') body[f.name] = null
    else body[f.name] = f.type === 'number' || f.type === 'ref' ? Number(v) : v
  }
  return body
}

export default function ResourcePage({ def, canDelete }: { def: ResourceDef; canDelete: boolean }) {
  const [items, setItems] = useState<Item[]>([])
  const [refs, setRefs] = useState<Record<string, Item[]>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Item | 'new' | null>(null)
  const [form, setForm] = useState<FormState>({})
  const [query, setQuery] = useState('')

  const load = useCallback(async () => {
    try {
      setItems((await api.list(def.key)).items)
      const refKeys = [...new Set(def.fields.filter((f) => f.type === 'ref').map((f) => f.ref!))]
      const loaded = await Promise.all(refKeys.map(async (k) => [k, (await api.list(k)).items] as const))
      setRefs(Object.fromEntries(loaded))
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro inesperado')
    } finally {
      setLoading(false)
    }
  }, [def])

  useEffect(() => {
    load()
  }, [load])

  function open(item: Item | 'new') {
    setError('')
    setForm(toForm(def.fields, item === 'new' ? undefined : item))
    setEditing(item)
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    setError('')
    try {
      const body = toBody(def.fields, form)
      if (editing === 'new') await api.create(def.key, body)
      else if (editing) await api.update(def.key, editing.id, body)
      setEditing(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro inesperado')
    }
  }

  async function remove(item: Item) {
    if (!window.confirm(`Excluir este ${def.singular}? Esta ação não pode ser desfeita.`)) return
    try {
      await api.remove(def.key, item.id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro inesperado')
    }
  }

  function display(f: FieldDef, item: Item): string {
    const v = item[f.name]
    if (v == null) return '—'
    if (f.type === 'select') return f.options?.find((o) => o.value === v)?.label ?? String(v)
    if (f.type === 'ref') return String(refs[f.ref!]?.find((r) => r.id === v)?.name ?? v)
    return String(v)
  }

  const columns = def.fields.filter((f) => f.column)
  const q = query.trim().toLowerCase()
  const visible = q
    ? items.filter((it) => columns.some((c) => display(c, it).toLowerCase().includes(q)))
    : items

  return (
    <section>
      <div className="page-head">
        <h2>{def.title}</h2>
        <input
          className="search"
          placeholder="Buscar…"
          aria-label={`Buscar em ${def.title}`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="primary" onClick={() => open('new')}>
          Novo {def.singular}
        </button>
      </div>

      {error && <p className="error" role="alert">{error}</p>}

      {editing && (
        <form className="panel form-grid" onSubmit={save}>
          <h3>{editing === 'new' ? `Novo ${def.singular}` : `Editar ${def.singular}`}</h3>
          {def.fields.map((f) => (
            <label key={f.name}>
              {f.label}
              {f.type === 'select' ? (
                <select
                  value={form[f.name]}
                  required={f.required}
                  onChange={(e) => setForm({ ...form, [f.name]: e.target.value })}
                >
                  <option value="">{f.required ? 'Selecione' : '—'}</option>
                  {f.options!.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : f.type === 'ref' ? (
                <select
                  value={form[f.name]}
                  required={f.required}
                  onChange={(e) => setForm({ ...form, [f.name]: e.target.value })}
                >
                  <option value="">Selecione</option>
                  {(refs[f.ref!] ?? []).map((r) => (
                    <option key={r.id} value={r.id}>
                      {String(r.name)}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type={f.type === 'number' ? 'number' : f.type === 'email' ? 'email' : 'text'}
                  min={f.type === 'number' ? 0 : undefined}
                  value={form[f.name]}
                  required={f.required}
                  onChange={(e) => setForm({ ...form, [f.name]: e.target.value })}
                />
              )}
            </label>
          ))}
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
      ) : visible.length === 0 ? (
        <p className="empty">
          {items.length === 0 ? `Nenhum ${def.singular} cadastrado ainda.` : 'Nada encontrado para a busca.'}
        </p>
      ) : (
        <div className="panel table-wrap">
          <table>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.name}>{c.label}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((it) => (
                <tr key={it.id}>
                  {columns.map((c) => (
                    <td key={c.name}>{display(c, it)}</td>
                  ))}
                  <td className="row-actions">
                    <button onClick={() => open(it)}>Editar</button>
                    {canDelete && (
                      <button className="danger" onClick={() => remove(it)}>
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
