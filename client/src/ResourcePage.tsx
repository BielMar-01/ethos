import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, type Item } from './api'
import { cepDigits, lookupCep, maskCep } from './cep'
import Modal from './Modal'
import type { FieldDef, ResourceDef } from './resources'
import { Alert, Loading, ask, toast } from './feedback'
import { brl } from './format'
import MaskedInput, { maskWarning } from './MaskedInput'
import { centsFromMoney, maskDocument, maskPhone, moneyFromCents } from './masks'

type FormState = Record<string, string>

function toForm(fields: FieldDef[], item?: Item): FormState {
  return Object.fromEntries(
    fields.map((f) => {
      const v = item?.[f.name]
      if (v == null) return [f.name, item ? '' : (f.default ?? '')]
      if (f.type === 'money') return [f.name, moneyFromCents(Number(v))]
      if (f.mask === 'phone') return [f.name, maskPhone(String(v))]
      if (f.mask === 'document') return [f.name, maskDocument(String(v))]
      return [f.name, String(v)]
    }),
  )
}

function toBody(fields: FieldDef[], form: FormState): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const f of fields) {
    const v = form[f.name]
    if (v === '') body[f.name] = null
    else if (f.type === 'money') body[f.name] = centsFromMoney(v)
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
  const [viewing, setViewing] = useState<Item | null>(null)
  const [form, setForm] = useState<FormState>({})
  const [query, setQuery] = useState('')
  const [cepHint, setCepHint] = useState<{ kind: 'busy' | 'ok' | 'error'; text: string } | null>(null)

  /** Ao digitar o CEP: máscara e, com 8 números, busca o endereço e preenche rua, bairro, cidade e UF. */
  async function onCep(field: FieldDef, raw: string) {
    const masked = maskCep(raw)
    setForm((f) => ({ ...f, [field.name]: masked }))
    if (cepDigits(masked).length !== 8) return setCepHint(null)
    setCepHint({ kind: 'busy', text: 'Buscando endereço…' })
    try {
      const a = await lookupCep(masked)
      setForm((f) => ({
        ...f,
        [field.name]: a.zip,
        street: a.street || f.street || '',
        neighborhood: a.neighborhood || f.neighborhood || '',
        city: a.city,
        state: a.state,
        ...(a.complement && !f.complement ? { complement: a.complement } : {}),
      }))
      setCepHint({ kind: 'ok', text: 'Endereço preenchido. Complete o número.' })
      // Leva o cursor direto para o número (a única coisa que o CEP não sabe).
      window.setTimeout(() => document.querySelector<HTMLInputElement>('input[name="number"]')?.focus(), 0)
    } catch (e) {
      setCepHint({ kind: 'error', text: e instanceof Error ? e.message : 'Não foi possível consultar o CEP.' })
    }
  }

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
    setCepHint(null)
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
      toast.success(`${def.singular[0].toUpperCase()}${def.singular.slice(1)} ${def.fem ? 'salva' : 'salvo'} com sucesso.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro inesperado')
    }
  }

  async function remove(item: Item) {
    if (!(await ask(`Excluir ${def.fem ? "esta" : "este"} ${def.singular}? Esta ação não pode ser desfeita.`))) return
    try {
      await api.remove(def.key, item.id)
      await load()
      toast.success(`${def.singular[0].toUpperCase()}${def.singular.slice(1)} ${def.fem ? 'excluída' : 'excluído'}.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro inesperado')
    }
  }

  function display(f: FieldDef, item: Item): string {
    const v = item[f.name]
    if (v == null || v === '') return '—'
    if (f.type === 'money') return brl(Number(v))
    if (f.mask === 'phone') return maskPhone(String(v))
    if (f.mask === 'document') return maskDocument(String(v))
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
          {def.fem ? 'Nova' : 'Novo'} {def.singular}
        </button>
      </div>

      {error && <Alert>{error}</Alert>}

      {viewing && (
        <Modal
          title={String(viewing[def.fields[0]!.name] ?? def.singular)}
          subtitle={def.singular[0]!.toUpperCase() + def.singular.slice(1)}
          onClose={() => setViewing(null)}
          footer={
            <>
              <button onClick={() => setViewing(null)}>Fechar</button>
              {canDelete && (
                <button
                  className="danger"
                  onClick={() => {
                    const it = viewing
                    setViewing(null)
                    void remove(it)
                  }}
                >
                  Excluir
                </button>
              )}
              <button
                className="primary"
                onClick={() => {
                  const it = viewing
                  setViewing(null)
                  open(it)
                }}
              >
                Editar
              </button>
            </>
          }
        >
          <dl className="view-grid">
            {def.fields.map((f) => (
              <div key={f.name}>
                <dt>{f.label}</dt>
                <dd>{display(f, viewing)}</dd>
              </div>
            ))}
          </dl>
        </Modal>
      )}

      {editing && (
        <Modal title={editing === 'new' ? `${def.fem ? 'Nova' : 'Novo'} ${def.singular}` : `Editar ${def.singular}`} onClose={() => setEditing(null)} size="md">
        <form className="form-grid" onSubmit={save}>
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
              ) : f.type === 'money' || f.mask ? (
                <>
                  <MaskedInput
                    name={f.name}
                    kind={f.type === 'money' ? 'money' : f.mask!}
                    value={form[f.name] ?? ''}
                    required={f.required}
                    onValue={(v) => setForm({ ...form, [f.name]: v })}
                  />
                  {f.mask && maskWarning(f.mask, form[f.name] ?? '') && <small className="mask-hint">{maskWarning(f.mask, form[f.name] ?? '')}</small>}
                </>
              ) : (
                <input
                  name={f.name}
                  type={f.type === 'number' ? 'number' : f.type === 'email' ? 'email' : 'text'}
                  min={f.type === 'number' ? 0 : undefined}
                  value={form[f.name]}
                  required={f.required}
                  inputMode={f.cep ? 'numeric' : undefined}
                  autoComplete={f.cep ? 'postal-code' : undefined}
                  placeholder={f.cep ? '00000-000' : undefined}
                  maxLength={f.cep ? 9 : undefined}
                  onChange={(e) => (f.cep ? void onCep(f, e.target.value) : setForm({ ...form, [f.name]: e.target.value }))}
                />
              )}
              {f.cep && cepHint && <small className={`cep-hint ${cepHint.kind}`} role={cepHint.kind === 'error' ? 'alert' : 'status'}>{cepHint.text}</small>}
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
        </Modal>
      )}

      {loading ? (
        <Loading label="Carregando…" />
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
                <tr key={it.id} className="clickable" onClick={() => setViewing(it)}>
                  {columns.map((c) => (
                    <td key={c.name}>{display(c, it)}</td>
                  ))}
                  <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => setViewing(it)}>Ver</button>
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
