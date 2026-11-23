import { useEffect, useRef, useState, type DragEvent } from 'react'
import { api, json, request } from './api'
import { cepDigits, lookupCep, maskCep } from './cep'
import { Alert, errorText, toast } from './feedback'
import { brl, parseReais } from './format'
import { prepareImage } from './photos'

/**
 * Cadastro por documento: o usuário envia fotos/PDFs (RG, CNH, contrato, matrícula, IPTU…), o servidor lê com IA e
 * devolve SUGESTÕES. Nada é gravado até o usuário revisar e confirmar. O arquivo não fica guardado.
 */

type Role = 'proprietario' | 'inquilino' | 'fiador' | 'outro'
interface Person { role: Role; name: string; document: string; email: string; phone: string; valid: boolean | null }
interface Draft {
  people: Person[]
  property: { name: string; type: string; zip: string; street: string; number: string; complement: string; neighborhood: string; city: string; state: string }
  unit: { identifier: string; area_m2: string; bedrooms: string }
  lease: { start_date: string; end_date: string; rent: string; due_day: string; guarantee: string }
}
interface Extraction {
  kind: string
  people: { role: Role; name: string; document: string; document_valid: boolean | null; email: string; phone: string }[]
  property: Draft['property']
  unit: { identifier: string; area_m2: number | null; bedrooms: number | null }
  lease: { start_date: string; end_date: string; rent_cents: number | null; due_day: number | null; guarantee: string }
  notes: string
}
interface FileState { id: number; name: string; status: 'reading' | 'done' | 'error'; text: string; kind?: string; notes?: string }

const KIND_LABEL: Record<string, string> = {
  identidade: 'Documento de identidade',
  comprovante_residencia: 'Comprovante de residência',
  contrato_locacao: 'Contrato de locação',
  matricula_imovel: 'Matrícula do imóvel',
  iptu_ou_conta: 'IPTU / conta',
  outro: 'Outro documento',
}
const ROLE_LABEL: Record<Role, string> = { proprietario: 'Proprietário', inquilino: 'Inquilino', fiador: 'Fiador', outro: 'Outro' }

const EMPTY: Draft = {
  people: [],
  property: { name: '', type: '', zip: '', street: '', number: '', complement: '', neighborhood: '', city: '', state: '' },
  unit: { identifier: '', area_m2: '', bedrooms: '' },
  lease: { start_date: '', end_date: '', rent: '', due_day: '', guarantee: '' },
}
const MAX_FILES = 6
const digits = (s: string) => s.replace(/\D/g, '')
const personKey = (p: Person) => digits(p.document) || p.name.trim().toLowerCase()
let nextId = 1

/** Junta o que cada arquivo trouxe: pessoas pelo documento; nos demais campos, o primeiro valor preenchido vence. */
function merge(draft: Draft, x: Extraction): Draft {
  const people = [...draft.people]
  for (const p of x.people) {
    const incoming: Person = { role: p.role, name: p.name, document: p.document, email: p.email, phone: p.phone, valid: p.document_valid }
    const i = people.findIndex((q) => personKey(q) === personKey(incoming))
    if (i < 0) people.push(incoming)
    else {
      const cur = people[i]!
      people[i] = {
        ...cur,
        role: cur.role === 'outro' ? incoming.role : cur.role,
        name: cur.name || incoming.name,
        email: cur.email || incoming.email,
        phone: cur.phone || incoming.phone,
        document: cur.document || incoming.document,
        valid: cur.valid ?? incoming.valid,
      }
    }
  }
  const fill = <T extends Record<string, string>>(a: T, b: T): T => Object.fromEntries(Object.keys(a).map((k) => [k, a[k] || b[k] || ''])) as T
  return {
    people,
    property: fill(draft.property, x.property),
    unit: fill(draft.unit, { identifier: x.unit.identifier, area_m2: x.unit.area_m2 ? String(x.unit.area_m2) : '', bedrooms: x.unit.bedrooms !== null ? String(x.unit.bedrooms) : '' }),
    lease: fill(draft.lease, {
      start_date: x.lease.start_date,
      end_date: x.lease.end_date,
      rent: x.lease.rent_cents ? (x.lease.rent_cents / 100).toFixed(2).replace('.', ',') : '',
      due_day: x.lease.due_day ? String(x.lease.due_day) : '',
      guarantee: x.lease.guarantee,
    }),
  }
}

export default function IntakePage({ onNavigate }: { onNavigate: (key: string) => void }) {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [provider, setProvider] = useState<{ label: string; model: string; images: boolean } | null>(null)
  const [consent, setConsent] = useState(false)
  const [files, setFiles] = useState<FileState[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<string[] | null>(null)
  const [drag, setDrag] = useState(false)
  const [cepHint, setCepHint] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    request<{ enabled: boolean; provider: { label: string; model: string; images: boolean } | null }>('/api/extract/status')
      .then((r) => {
        setEnabled(r.enabled)
        setProvider(r.provider)
      })
      .catch(() => setEnabled(false))
  }, [])

  const reading = files.some((f) => f.status === 'reading')

  async function readOne(file: File, id: number) {
    const patch = (p: Partial<FileState>) => setFiles((all) => all.map((f) => (f.id === id ? { ...f, ...p } : f)))
    try {
      const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
      const blob: Blob = isPdf ? file : await prepareImage(file)
      if (blob.size > 4 * 1024 * 1024) throw new Error('Arquivo grande demais (máximo 4 MB). Envie um PDF menor ou fotos separadas.')
      const res = await fetch('/api/extract', { method: 'POST', headers: { 'Content-Type': isPdf ? 'application/pdf' : blob.type }, body: blob })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Não foi possível ler este arquivo.')
      const x = body as Extraction
      setDraft((d) => merge(d ?? EMPTY, x))
      setResult(null)
      patch({ status: 'done', kind: x.kind, notes: x.notes, text: `${x.people.length} pessoa(s)${x.property.street || x.property.name ? ', imóvel' : ''}${x.lease.rent_cents ? ', contrato' : ''}` })
    } catch (e) {
      patch({ status: 'error', text: errorText(e) })
    }
  }

  async function add(list: FileList | File[]) {
    const picked = Array.from(list)
    if (files.length + picked.length > MAX_FILES) {
      toast.error(`Envie até ${MAX_FILES} arquivos por vez.`)
      return
    }
    const entries = picked.map((f) => ({ file: f, id: nextId++ }))
    setFiles((all) => [...all, ...entries.map((e) => ({ id: e.id, name: e.file.name, status: 'reading' as const, text: 'Lendo…' }))])
    // Um por vez: respeita o limite de uso do serviço e deixa a mesclagem previsível.
    for (const e of entries) await readOne(e.file, e.id)
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    setDrag(false)
    if (consent && e.dataTransfer.files.length) void add(e.dataTransfer.files)
  }

  const setProp = (k: keyof Draft['property'], v: string) => setDraft((d) => d && { ...d, property: { ...d.property, [k]: v } })
  const setUnit = (k: keyof Draft['unit'], v: string) => setDraft((d) => d && { ...d, unit: { ...d.unit, [k]: v } })
  const setLease = (k: keyof Draft['lease'], v: string) => setDraft((d) => d && { ...d, lease: { ...d.lease, [k]: v } })
  const setPerson = (i: number, patch: Partial<Person>) => setDraft((d) => d && { ...d, people: d.people.map((p, j) => (j === i ? { ...p, ...patch } : p)) })

  async function onZip(raw: string) {
    const masked = maskCep(raw)
    setProp('zip', masked)
    if (cepDigits(masked).length !== 8) return setCepHint('')
    setCepHint('Buscando endereço…')
    try {
      const a = await lookupCep(masked)
      setDraft((d) => d && { ...d, property: { ...d.property, zip: a.zip, street: a.street || d.property.street, neighborhood: a.neighborhood || d.property.neighborhood, city: a.city, state: a.state } })
      setCepHint('Endereço completado pelo CEP.')
    } catch (e) {
      setCepHint(errorText(e))
    }
  }

  /** Grava tudo: cadastros (tudo ou nada, sem duplicar) e, se houver dados, o contrato em rascunho. */
  async function confirm() {
    if (!draft) return
    setError('')
    setSaving(true)
    try {
      const owners = draft.people.filter((p) => p.role === 'proprietario')
      const tenants = draft.people.filter((p) => p.role === 'inquilino')
      const fiadores = draft.people.filter((p) => p.role === 'fiador')
      const row = (p: Person) => ({ nome: p.name, documento: p.document, email: p.email, telefone: p.phone })
      const p = draft.property
      const propertyName = p.name.trim() || [p.street, p.number].filter(Boolean).join(', ')
      const sets: Record<string, unknown[]> = {}
      if (owners.length) sets.owners = owners.map(row)
      if (tenants.length) sets.tenants = tenants.map(row)
      if (propertyName) {
        sets.properties = [{ nome: propertyName, tipo: p.type || 'outro', cep: p.zip, rua: p.street, numero: p.number, complemento: p.complement, bairro: p.neighborhood, cidade: p.city, uf: p.state, proprietarios: owners.map((o) => o.document).filter(Boolean).join(' | ') }]
        if (draft.unit.identifier.trim()) {
          sets.units = [{ imovel: propertyName, identificador: draft.unit.identifier, area: draft.unit.area_m2, quartos: draft.unit.bedrooms, aluguel_referencia: draft.lease.rent }]
        }
      }
      if (Object.keys(sets).length === 0) throw new Error('Não há nada para cadastrar: preencha ao menos uma pessoa ou o imóvel.')

      const res = await fetch('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sets }) })
      const report = await res.json().catch(() => ({}))
      if (res.status === 422 && Array.isArray(report.errors)) {
        throw new Error(report.errors.map((e: { message: string }) => e.message).join(' · '))
      }
      if (!res.ok) throw new Error(typeof report.error === 'string' ? report.error : 'Não foi possível cadastrar.')

      const lines: string[] = []
      const created = (['owners', 'tenants', 'properties', 'units'] as const).map((k) => [k, report.results[k]?.created ?? 0] as const)
      const label = { owners: 'proprietário(s)', tenants: 'inquilino(s)', properties: 'imóvel(is)', units: 'unidade(s)' }
      for (const [k, n] of created) if (n > 0) lines.push(`${n} ${label[k]} cadastrado(s)`)
      const skipped = (['owners', 'tenants', 'properties', 'units'] as const).reduce((n, k) => n + (report.results[k]?.skipped.length ?? 0), 0)
      if (skipped) lines.push(`${skipped} já existia(m) e foi(ram) reaproveitado(s)`)

      // Rascunho do contrato: só se houver unidade, locatário e os dados mínimos.
      const l = draft.lease
      const rentCents = parseReais(l.rent)
      const missing = [
        !draft.unit.identifier.trim() && 'unidade',
        tenants.length === 0 && 'inquilino',
        !l.start_date && 'início',
        !l.end_date && 'fim',
        !rentCents && 'aluguel',
        !l.due_day && 'dia de vencimento',
      ].filter(Boolean) as string[]
      if (l.start_date || l.end_date || l.rent) {
        if (missing.length) lines.push(`Contrato NÃO criado: faltam ${missing.join(', ')}. Você pode criá-lo depois em Contratos.`)
        else {
          const [units, props, tens] = await Promise.all([api.list('units'), api.list('properties'), api.list('tenants')])
          const prop = props.items.find((x) => String(x.name).trim().toLowerCase() === propertyName.toLowerCase())
          const unit = units.items.find((u) => u.property_id === prop?.id && String(u.identifier).trim().toLowerCase() === draft.unit.identifier.trim().toLowerCase())
          const tenantIds = tenants.map((t) => tens.items.find((x) => digits(String(x.document)) === digits(t.document))?.id).filter((x): x is number => typeof x === 'number')
          if (!unit || tenantIds.length === 0) lines.push('Contrato NÃO criado: não encontrei a unidade ou o inquilino cadastrados. Crie-o em Contratos.')
          else {
            const guarantee = [l.guarantee, ...fiadores.map((f) => `Fiador: ${f.name}${f.document ? ` (${f.document})` : ''}`)].filter(Boolean).join(' · ')
            try {
              await request('/api/leases', json('POST', { unit_id: unit.id, tenantIds, start_date: l.start_date, end_date: l.end_date, rent_cents: rentCents, due_day: Number(l.due_day), guarantee: guarantee || null }))
              lines.push(`Contrato criado como RASCUNHO (${brl(rentCents!)}/mês). Revise e ative em Contratos.`)
            } catch (e) {
              lines.push(`Cadastros feitos, mas o contrato não foi criado: ${errorText(e)}`)
            }
          }
        }
      }
      setResult(lines)
      setDraft(null)
      setFiles([])
      toast.success('Cadastro concluído.')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section>
      <div className="page-head">
        <div>
          <h2>Cadastro por documento</h2>
          <p className="muted page-sub">
            Envie fotos ou PDFs de RG, CNH, comprovante de residência, contrato de locação, matrícula ou IPTU. O sistema lê e preenche proprietário, inquilino, imóvel, unidade e até o rascunho do contrato — você confere tudo antes de salvar.
          </p>
        </div>
      </div>

      {enabled === false && (
        <Alert>A leitura automática ainda não está ativada neste sistema (falta configurar a chave do serviço de IA). Enquanto isso, use <button className="link" onClick={() => onNavigate('import')}>Importar dados</button> ou os cadastros manuais.</Alert>
      )}

      <div className="panel">
        <h3>1. Envie os documentos</h3>
        {provider && (
          <p className="muted small">
            Leitura feita por <strong>{provider.label}</strong> ({provider.model}). {provider.images ? '' : 'Este provedor lê só texto: envie PDFs com texto (fotos não funcionam). '}Para trocar, use Administração › Integrações.
          </p>
        )}
        <label className="consent">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>
            Entendo que cada arquivo é enviado ao serviço de IA da Anthropic <strong>apenas para leitura</strong>, não fica guardado no Ethos e contém dados pessoais que só devo enviar com base legal (LGPD). Vou conferir tudo antes de salvar.
          </span>
        </label>
        <div
          className={`dropzone${drag ? ' over' : ''}${!consent || enabled === false ? ' disabled' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            if (consent) setDrag(true)
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
          onClick={() => consent && enabled !== false && input.current?.click()}
          role="button"
          tabIndex={0}
          aria-disabled={!consent || enabled === false}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && consent && enabled !== false && input.current?.click()}
        >
          <strong>{consent ? 'Arraste os arquivos aqui ou clique para escolher' : 'Marque a confirmação acima para enviar'}</strong>
          <span className="muted">JPEG, PNG, WebP ou PDF · até {MAX_FILES} arquivos · máx. 4 MB cada. No celular, pode tirar a foto na hora.</span>
          <input
            ref={input}
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void add(e.target.files)
              e.target.value = ''
            }}
          />
        </div>
        {files.length > 0 && (
          <ul className="file-list">
            {files.map((f) => (
              <li key={f.id} className={f.status === 'error' ? 'needs-kind' : ''}>
                <span className="grow">
                  <strong>{f.name}</strong>
                  <span className={`small block ${f.status === 'error' ? 'error-text' : 'muted'}`}>
                    {f.status === 'reading' ? 'Lendo documento…' : f.status === 'error' ? f.text : `${KIND_LABEL[f.kind ?? 'outro']} · ${f.text}`}
                    {f.notes ? ` · ${f.notes}` : ''}
                  </span>
                </span>
                {f.status === 'reading' && <span className="spinner" aria-hidden="true" />}
              </li>
            ))}
          </ul>
        )}
      </div>

      {draft && (
        <div className="panel">
          <h3>2. Confira e corrija</h3>
          <p className="muted small">Os dados abaixo foram lidos dos documentos e podem ter erros. Corrija o que for preciso; campos vazios não serão criados.</p>
          {error && <Alert>{error}</Alert>}

          <h4>Pessoas</h4>
          {draft.people.length === 0 && <p className="muted small">Nenhuma pessoa encontrada.</p>}
          {draft.people.map((p, i) => (
            <div key={i} className="form-grid person-row">
              <label>Papel
                <select value={p.role} onChange={(e) => setPerson(i, { role: e.target.value as Role })}>
                  {(Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>
              </label>
              <label>Nome<input value={p.name} onChange={(e) => setPerson(i, { name: e.target.value })} /></label>
              <label>CPF/CNPJ
                <input value={p.document} onChange={(e) => setPerson(i, { document: e.target.value, valid: null })} />
                {p.valid === false && <small className="cep-hint error">Dígitos verificadores não conferem: confira o número.</small>}
              </label>
              <label>E-mail<input type="email" value={p.email} onChange={(e) => setPerson(i, { email: e.target.value })} /></label>
              <label>Telefone<input value={p.phone} onChange={(e) => setPerson(i, { phone: e.target.value })} /></label>
              <button className="danger" onClick={() => setDraft((d) => d && { ...d, people: d.people.filter((_, j) => j !== i) })}>Remover</button>
            </div>
          ))}
          <button onClick={() => setDraft((d) => d && { ...d, people: [...d.people, { role: 'inquilino', name: '', document: '', email: '', phone: '', valid: null }] })}>+ Adicionar pessoa</button>

          <h4>Imóvel</h4>
          <div className="form-grid">
            <label>Nome do imóvel<input value={draft.property.name} onChange={(e) => setProp('name', e.target.value)} placeholder="Ex.: Edifício Aurora" /></label>
            <label>Tipo
              <select value={draft.property.type} onChange={(e) => setProp('type', e.target.value)}>
                <option value="">—</option>
                {['casa', 'apartamento', 'terreno', 'comercial', 'outro'].map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label>CEP
              <input value={draft.property.zip} inputMode="numeric" placeholder="00000-000" maxLength={9} onChange={(e) => void onZip(e.target.value)} />
              {cepHint && <small className="cep-hint">{cepHint}</small>}
            </label>
            <label>Rua<input value={draft.property.street} onChange={(e) => setProp('street', e.target.value)} /></label>
            <label>Número<input value={draft.property.number} onChange={(e) => setProp('number', e.target.value)} /></label>
            <label>Complemento<input value={draft.property.complement} onChange={(e) => setProp('complement', e.target.value)} /></label>
            <label>Bairro<input value={draft.property.neighborhood} onChange={(e) => setProp('neighborhood', e.target.value)} /></label>
            <label>Cidade<input value={draft.property.city} onChange={(e) => setProp('city', e.target.value)} /></label>
            <label>UF<input value={draft.property.state} maxLength={2} onChange={(e) => setProp('state', e.target.value.toUpperCase())} /></label>
          </div>

          <h4>Unidade</h4>
          <div className="form-grid">
            <label>Identificação<input value={draft.unit.identifier} onChange={(e) => setUnit('identifier', e.target.value)} placeholder="Ex.: Apto 101" /></label>
            <label>Área (m²)<input value={draft.unit.area_m2} inputMode="numeric" onChange={(e) => setUnit('area_m2', e.target.value)} /></label>
            <label>Quartos<input value={draft.unit.bedrooms} inputMode="numeric" onChange={(e) => setUnit('bedrooms', e.target.value)} /></label>
          </div>

          <h4>Contrato (rascunho)</h4>
          <div className="form-grid">
            <label>Início<input type="date" value={draft.lease.start_date} onChange={(e) => setLease('start_date', e.target.value)} /></label>
            <label>Fim<input type="date" value={draft.lease.end_date} onChange={(e) => setLease('end_date', e.target.value)} /></label>
            <label>Aluguel (R$)<input value={draft.lease.rent} inputMode="decimal" onChange={(e) => setLease('rent', e.target.value)} /></label>
            <label>Dia do vencimento<input value={draft.lease.due_day} inputMode="numeric" onChange={(e) => setLease('due_day', e.target.value)} /></label>
            <label className="span-all">Garantia<input value={draft.lease.guarantee} onChange={(e) => setLease('guarantee', e.target.value)} /></label>
          </div>
          <p className="muted small">O contrato é criado só como <strong>rascunho</strong>: você revisa e ativa em Contratos. Sem início, fim, aluguel, vencimento, unidade e inquilino, só os cadastros são feitos.</p>

          <div className="import-actions">
            <button onClick={() => { setDraft(null); setFiles([]) }}>Descartar</button>
            <button className="primary" disabled={saving || reading} onClick={confirm}>{saving ? 'Salvando…' : '3. Confirmar e cadastrar'}</button>
          </div>
        </div>
      )}

      {result && (
        <div className="panel success-panel">
          <h3>Pronto</h3>
          <ul>{result.map((l) => <li key={l}>{l}</li>)}</ul>
          <div className="import-actions">
            <button onClick={() => onNavigate('properties')}>Ver imóveis</button>
            <button className="primary" onClick={() => onNavigate('leases')}>Ver contratos</button>
          </div>
        </div>
      )}
    </section>
  )
}
