import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Alert, Loading, errorText, toast } from './feedback'
import Modal from './Modal'
import { brl, parseReais, reaisInput } from './format'

/** Peças pequenas e reutilizáveis para as telas novas: carregamento, abas, tabela, formulário em modal e download. */

export const json = (method: string, body?: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })

/** Carrega dados de uma função assíncrona e permite recarregar. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps)
  const reload = useCallback(async () => {
    try {
      setData(await run())
      setError('')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLoading(false)
    }
  }, [run])
  useEffect(() => {
    void reload()
  }, [reload])
  return { data, error, loading, reload, setData }
}

export function Tabs<K extends string>({ tabs, value, onChange }: { tabs: readonly (readonly [K, string])[]; value: K; onChange: (k: K) => void }) {
  return (
    <div className="tabs no-print" role="tablist">
      {tabs.map(([k, label]) => (
        <button key={k} role="tab" aria-selected={value === k} className={value === k ? 'tab active' : 'tab'} onClick={() => onChange(k)}>
          {label}
        </button>
      ))}
    </div>
  )
}

export interface Col<T> {
  head: string
  cell: (row: T) => ReactNode
  className?: string
}

/** Tabela simples; linha clicável opcional. */
export function Table<T extends { id: number | string }>({ cols, rows, onRow, empty = 'Nada por aqui ainda.' }: { cols: Col<T>[]; rows: T[]; onRow?: (r: T) => void; empty?: string }) {
  if (rows.length === 0) return <p className="muted">{empty}</p>
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label="Tabela (role para ver mais)">
      <table>
        <thead>
          <tr>{cols.map((c) => <th key={c.head} className={c.className}>{c.head}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={onRow ? 'clickable' : undefined} onClick={onRow ? () => onRow(r) : undefined}>
              {cols.map((c) => <td key={c.head} className={c.className}>{c.cell(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function Loaded<T>({ state, children }: { state: { data: T | null; error: string; loading: boolean }; children: (d: T) => ReactNode }) {
  if (state.error) return <Alert>{state.error}</Alert>
  if (state.loading || !state.data) return <Loading label="Carregando…" />
  return <>{children(state.data)}</>
}

// ------------------------------------------------------------------ Formulário em modal

export type FieldSpec = {
  /** Subtítulo exibido antes do primeiro campo de cada grupo. */
  section?: string
} & (
  | { name: string; label: string; type?: 'text' | 'email' | 'number' | 'date' | 'datetime' | 'time' | 'textarea'; required?: boolean; hint?: string; placeholder?: string; min?: number; max?: number; wide?: boolean }
  | { name: string; label: string; type: 'money'; required?: boolean; hint?: string; wide?: boolean }
  | { name: string; label: string; type: 'select'; options: { value: string; label: string }[]; required?: boolean; hint?: string; wide?: boolean }
  | { name: string; label: string; type: 'check'; hint?: string; wide?: boolean }
  | { name: string; label: string; type: 'multi'; options: { value: string; label: string }[]; hint?: string; wide?: boolean }
)

type Values = Record<string, string | boolean | string[]>

const initialOf = (fields: FieldSpec[], initial: Record<string, unknown>): Values => {
  const v: Values = {}
  for (const f of fields) {
    const x = initial[f.name]
    if (f.type === 'check') v[f.name] = x === true
    else if (f.type === 'multi') v[f.name] = Array.isArray(x) ? x.map(String) : typeof x === 'string' && x ? x.split(',') : []
    else if (f.type === 'money') v[f.name] = typeof x === 'number' ? reaisInput(x) : ''
    else v[f.name] = x === null || x === undefined ? '' : String(x)
  }
  return v
}

/** Converte os campos digitados no corpo da requisição (dinheiro em centavos, vazio = omitido ou null). */
function bodyOf(fields: FieldSpec[], v: Values, keepEmpty: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    const x = v[f.name]
    if (f.type === 'check') out[f.name] = x === true
    else if (f.type === 'multi') out[f.name] = x as string[]
    else if (f.type === 'money') {
      const c = typeof x === 'string' ? parseReais(x) : null
      if (c !== null) out[f.name] = c
      else if (keepEmpty) out[f.name] = null
    } else if (f.type === 'number') {
      if (x === '') {
        if (keepEmpty) out[f.name] = null
      } else out[f.name] = Number(x)
    } else if (f.type === 'datetime') {
      if (x === '') {
        if (keepEmpty) out[f.name] = null
      } else out[f.name] = new Date(String(x)).toISOString()
    } else if (x === '') {
      if (keepEmpty) out[f.name] = null
    } else out[f.name] = x
  }
  return out
}

/** Janela com formulário montado a partir de uma lista de campos. `onSubmit` recebe o corpo pronto e pode lançar erro. */
export function FormModal({
  title, fields, initial = {}, submitLabel = 'Salvar', size = 'md', onSubmit, onClose, intro, keepEmpty = false,
}: {
  title: string
  fields: FieldSpec[]
  initial?: Record<string, unknown>
  submitLabel?: string
  size?: 'sm' | 'md' | 'lg'
  intro?: ReactNode
  /** Em edição, campos vazios viram null (limpam o valor) em vez de serem omitidos. */
  keepEmpty?: boolean
  onSubmit: (body: Record<string, unknown>) => Promise<void>
  onClose: () => void
}) {
  const [v, setV] = useState<Values>(() => initialOf(fields, initial))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (name: string, val: string | boolean | string[]) => setV((cur) => ({ ...cur, [name]: val }))

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await onSubmit(bodyOf(fields, v, keepEmpty))
      onClose()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  function renderField(f: FieldSpec) {
    const id = `f-${f.name}`
    const wide = f.wide || f.type === 'textarea' || f.type === 'multi' ? 'wide' : undefined
    if (f.type === 'check') {
      return (
        <label key={f.name} className={`check ${wide ?? ''}`}>
          <input type="checkbox" checked={v[f.name] === true} onChange={(e) => set(f.name, e.target.checked)} /> {f.label}
          {f.hint && <span className="muted small"> — {f.hint}</span>}
        </label>
      )
    }
    if (f.type === 'multi') {
      return (
        <fieldset key={f.name} className="mode-pick wide">
          <legend>{f.label}</legend>
          {f.options.map((o) => (
            <label key={o.value}>
              <input type="checkbox" checked={(v[f.name] as string[]).includes(o.value)} onChange={(e) => set(f.name, e.target.checked ? [...(v[f.name] as string[]), o.value] : (v[f.name] as string[]).filter((x) => x !== o.value))} /> {o.label}
            </label>
          ))}
        </fieldset>
      )
    }
    return (
      <label key={f.name} className={wide} htmlFor={id}>
        {f.label}
        {f.type === 'select' ? (
          <select id={id} value={String(v[f.name])} onChange={(e) => set(f.name, e.target.value)} required={f.required}>
            {!f.required && <option value="">—</option>}
            {f.required && v[f.name] === '' && <option value="">Escolha…</option>}
            {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : f.type === 'textarea' ? (
          <textarea id={id} rows={3} value={String(v[f.name])} onChange={(e) => set(f.name, e.target.value)} required={f.required} placeholder={f.placeholder} />
        ) : f.type === 'money' ? (
          <span className="money-field"><span>R$</span><input id={id} inputMode="decimal" value={String(v[f.name])} onChange={(e) => set(f.name, e.target.value)} required={f.required} placeholder="0,00" aria-label={`${f.label} em reais`} /></span>
        ) : (
          <input
            id={id}
            type={f.type === 'datetime' ? 'datetime-local' : f.type ?? 'text'}
            value={String(v[f.name])}
            onChange={(e) => set(f.name, e.target.value)}
            required={f.required}
            placeholder={f.placeholder}
            min={f.min}
            max={f.max}
          />
        )}
        {f.hint && <span className="muted small">{f.hint}</span>}
      </label>
    )
  }

  return (
    <Modal title={title} size={size} onClose={onClose} locked={busy}>
      <form className="stack" onSubmit={submit}>
        {intro}
        <div className="form-grid">
          {fields.flatMap((f, index) => {
            const heading = f.section && f.section !== fields[index - 1]?.section ? [<h4 key={`s-${f.name}`} className="span-all form-section">{f.section}</h4>] : []
            return [...heading, renderField(f)]
          })}
        </div>
        {error && <Alert>{error}</Alert>}
        <div className="actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Salvando…' : submitLabel}</button>
        </div>
      </form>
    </Modal>
  )
}

// ------------------------------------------------------------------ Download (CSV, arquivos)

/** Baixa um arquivo do servidor (com o cookie da sessão). */
export async function download(path: string, filename: string) {
  const res = await fetch(path)
  if (!res.ok) {
    toast.error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Não foi possível baixar.')
    return
  }
  const a = document.createElement('a')
  a.href = URL.createObjectURL(await res.blob())
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

export const money = (c: number | null | undefined) => (c === null || c === undefined ? '—' : brl(c))
export const dateOnly = (s: string | null | undefined) => (s ? s.slice(0, 10).split('-').reverse().join('/') : '—')

/** Cartão de número (KPIs), no mesmo estilo do painel inicial. */
export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'ok' | 'warn' | 'danger' }) {
  return (
    <div className={tone === 'danger' ? 'stat danger-stat' : 'stat'}>
      <span>{label}</span>
      <strong>{value}</strong>
      {hint && <small className="muted">{hint}</small>}
    </div>
  )
}
