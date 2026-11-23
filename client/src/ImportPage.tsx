import { useRef, useState, type DragEvent } from 'react'
import { Alert, Empty, errorText, toast } from './feedback'
import { downloadCsv, readCsvFile } from './csv'

/** Importação em massa: vários arquivos CSV de uma vez (proprietários, inquilinos, imóveis, unidades), com simulação antes de gravar. */

type Resource = 'owners' | 'tenants' | 'properties' | 'units'
const ORDER: Resource[] = ['owners', 'tenants', 'properties', 'units']

const KINDS: Record<Resource, { label: string; file: string; headers: string[]; example: string[]; hint: string }> = {
  owners: {
    label: 'Proprietários',
    file: 'modelo-proprietarios.csv',
    headers: ['nome', 'documento', 'email', 'telefone'],
    example: ['Maria Souza', '123.456.789-09', 'maria@exemplo.com', '(11) 99999-0001'],
    hint: 'Obrigatórios: nome e documento (CPF/CNPJ). Quem já tem o mesmo documento é pulado.',
  },
  tenants: {
    label: 'Inquilinos',
    file: 'modelo-inquilinos.csv',
    headers: ['nome', 'documento', 'email', 'telefone'],
    example: ['Carlos Almeida', '987.654.321-00', 'carlos@exemplo.com', '(11) 98888-0007'],
    hint: 'Obrigatórios: nome e documento (CPF/CNPJ). Quem já tem o mesmo documento é pulado.',
  },
  properties: {
    label: 'Imóveis',
    file: 'modelo-imoveis.csv',
    headers: ['nome', 'tipo', 'rua', 'numero', 'complemento', 'bairro', 'cidade', 'uf', 'cep', 'proprietarios'],
    example: ['Edifício Aurora', 'apartamento', 'Rua das Flores', '100', '', 'Centro', 'São Paulo', 'SP', '01000-000', '123.456.789-09 | 111.222.333-96'],
    hint: 'Tipo: casa, apartamento, terreno, comercial ou outro. "proprietarios" = documentos separados por | (devem estar cadastrados ou no mesmo envio).',
  },
  units: {
    label: 'Unidades',
    file: 'modelo-unidades.csv',
    headers: ['imovel', 'identificador', 'quartos', 'area_m2', 'aluguel_referencia', 'situacao'],
    example: ['Edifício Aurora', 'Apto 101', '2', '62', '2500,00', 'disponivel'],
    hint: 'O imóvel é indicado pelo nome (deve existir ou estar no mesmo envio). Situação: disponivel, ocupada ou manutencao.',
  },
}

interface FileEntry {
  id: number
  name: string
  kind: Resource | ''
  headers: string[]
  rows: Record<string, string>[]
}
interface Summary { received: number; created: number; skipped: { line: number; reason: string }[] }
interface Report {
  dryRun: boolean
  results: Record<Resource, Summary>
  errors: { resource: Resource; line: number; message: string }[]
  errorCount: number
}

const canon = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** Descobre o tipo pelo nome do arquivo e, se não der, pelas colunas. Vazio = o usuário escolhe. */
function detect(name: string, headers: string[]): Resource | '' {
  const n = canon(name)
  if (/proprietari|owner|donos?/.test(n)) return 'owners'
  if (/inquilin|locatari|tenant/.test(n)) return 'tenants'
  if (/unidade|unit|apto/.test(n)) return 'units'
  if (/imove|propert|predio/.test(n)) return 'properties'
  const h = headers.map(canon)
  if (h.includes('identificador') || h.includes('unidade')) return 'units'
  if (h.includes('tipo') && !h.includes('documento') && !h.includes('cpf')) return 'properties'
  return ''
}

let nextId = 1

export default function ImportPage() {
  const [files, setFiles] = useState<FileEntry[]>([])
  const [report, setReport] = useState<Report | null>(null)
  const [busy, setBusy] = useState<'' | 'check' | 'import'>('')
  const [done, setDone] = useState<Report | null>(null)
  const [error, setError] = useState('')
  const [drag, setDrag] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  // Qualquer mudança nos arquivos invalida a simulação anterior.
  const change = (fn: (f: FileEntry[]) => FileEntry[]) => {
    setFiles(fn)
    setReport(null)
    setDone(null)
    setError('')
  }

  async function add(list: FileList | File[]) {
    const added: FileEntry[] = []
    for (const file of Array.from(list)) {
      if (!/\.(csv|txt)$/i.test(file.name)) {
        toast.error(`"${file.name}" não é CSV. No Excel: Arquivo → Salvar como → CSV UTF-8.`)
        continue
      }
      try {
        const parsed = await readCsvFile(file)
        if (parsed.rows.length === 0) {
          toast.error(`"${file.name}" não tem linhas de dados (só o cabeçalho ou está vazio).`)
          continue
        }
        added.push({ id: nextId++, name: file.name, kind: detect(file.name, parsed.headers), headers: parsed.headers, rows: parsed.rows })
      } catch {
        toast.error(`Não consegui ler "${file.name}".`)
      }
    }
    if (added.length) change((f) => [...f, ...added])
  }

  function onDrop(e: DragEvent) {
    e.preventDefault()
    setDrag(false)
    if (e.dataTransfer.files.length) void add(e.dataTransfer.files)
  }

  const total = files.reduce((n, f) => n + f.rows.length, 0)
  const unassigned = files.some((f) => f.kind === '')

  /** Junta os arquivos do mesmo tipo e guarda de onde veio cada linha (para apontar o arquivo certo nos erros). */
  function build() {
    const sets: Partial<Record<Resource, Record<string, string>[]>> = {}
    const segments: Record<Resource, { name: string; start: number; count: number }[]> = { owners: [], tenants: [], properties: [], units: [] }
    for (const f of files) {
      if (!f.kind) continue
      const list = (sets[f.kind] ??= [])
      segments[f.kind].push({ name: f.name, start: list.length, count: f.rows.length })
      list.push(...f.rows)
    }
    return { sets, segments }
  }
  const { segments } = build()
  const where = (resource: Resource, line: number) => {
    const idx = line - 2
    const seg = segments[resource].find((s) => idx >= s.start && idx < s.start + s.count)
    return seg ? `${seg.name}, linha ${idx - seg.start + 2}` : `linha ${line}`
  }

  async function send(dryRun: boolean) {
    setBusy(dryRun ? 'check' : 'import')
    setError('')
    try {
      const res = await fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun, sets: build().sets }),
      })
      const body = await res.json().catch(() => ({}))
      if (res.status === 401) throw new Error('Sua sessão expirou. Entre novamente.')
      if (res.status !== 200 && res.status !== 422) throw new Error(typeof body.error === 'string' ? body.error : 'Não foi possível importar. Tente novamente.')
      const r = body as Report
      if (dryRun) {
        setReport(r)
        if (r.errorCount === 0) toast.success('Arquivos conferidos: nenhum erro. Confirme para importar.')
        else toast.error(`Encontramos ${r.errorCount} problema(s). Corrija os arquivos e confira de novo.`)
      } else if (r.errorCount > 0) {
        setReport(r)
        toast.error('Nada foi importado: há erros nos arquivos.')
      } else {
        setDone(r)
        setReport(null)
        setFiles([])
        toast.success('Importação concluída.')
      }
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy('')
    }
  }

  const ok = report && report.errorCount === 0
  const created = report ? ORDER.reduce((n, r) => n + report.results[r].created, 0) : 0

  return (
    <section>
      <div className="page-head">
        <div>
          <h2>Importar dados</h2>
          <p className="muted page-sub">
            Envie planilhas CSV de proprietários, inquilinos, imóveis e unidades — vários arquivos de uma vez. Antes de gravar, você vê o que seria criado; se houver erro, nada é importado.
          </p>
        </div>
      </div>

      <div className="panel">
        <h3>1. Baixe os modelos (opcional)</h3>
        <p className="muted">Abrem no Excel. Mantenha a primeira linha (cabeçalho) e apague a linha de exemplo. Aceitamos nomes de colunas parecidos (com ou sem acento).</p>
        <div className="template-grid">
          {ORDER.map((r) => (
            <div key={r} className="template-card">
              <strong>{KINDS[r].label}</strong>
              <span className="muted small">{KINDS[r].hint}</span>
              <button onClick={() => downloadCsv(KINDS[r].file, KINDS[r].headers, KINDS[r].example)}>Baixar modelo</button>
            </div>
          ))}
        </div>
        <p className="muted small">Ordem automática: proprietários → inquilinos → imóveis → unidades. Por isso um imóvel pode citar proprietários, e uma unidade pode citar imóveis, que estão no mesmo envio.</p>
      </div>

      <div className="panel">
        <h3>2. Envie os arquivos</h3>
        <div
          className={drag ? 'dropzone over' : 'dropzone'}
          onDragOver={(e) => {
            e.preventDefault()
            setDrag(true)
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
          onClick={() => input.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
        >
          <strong>Arraste os arquivos CSV aqui</strong>
          <span className="muted">ou clique para escolher (pode selecionar vários)</span>
          <input
            ref={input}
            type="file"
            accept=".csv,.txt,text/csv"
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
              <li key={f.id} className={f.kind ? '' : 'needs-kind'}>
                <span className="grow">
                  <strong>{f.name}</strong>
                  <span className="muted small block">{f.rows.length} linha(s) · colunas: {f.headers.slice(0, 6).join(', ')}{f.headers.length > 6 ? '…' : ''}</span>
                </span>
                <select aria-label={`Tipo de ${f.name}`} value={f.kind} onChange={(e) => change((all) => all.map((x) => (x.id === f.id ? { ...x, kind: e.target.value as Resource | '' } : x)))}>
                  <option value="">Escolha o tipo…</option>
                  {ORDER.map((r) => (
                    <option key={r} value={r}>{KINDS[r].label}</option>
                  ))}
                </select>
                <button className="icon-btn" aria-label={`Remover ${f.name}`} onClick={() => change((all) => all.filter((x) => x.id !== f.id))}>×</button>
              </li>
            ))}
          </ul>
        )}
        {files.length > 0 && (
          <div className="import-actions">
            <span className="muted">{files.length} arquivo(s) · {total} linha(s){total > 2000 ? ' — máximo de 2.000 por importação, divida os arquivos' : ''}</span>
            <button className="primary" disabled={busy !== '' || unassigned || total === 0 || total > 2000} onClick={() => send(true)}>
              {busy === 'check' ? 'Conferindo…' : '3. Conferir antes de importar'}
            </button>
          </div>
        )}
        {unassigned && files.length > 0 && <p className="muted small">Escolha o tipo dos arquivos marcados para continuar.</p>}
      </div>

      {error && <Alert>{error}</Alert>}

      {report && (
        <div className="panel">
          <h3>{ok ? 'Tudo certo — veja o que será feito' : 'Corrija os problemas abaixo'}</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Tipo</th><th>Recebidas</th><th>Novas</th><th>Já existiam (puladas)</th></tr>
              </thead>
              <tbody>
                {ORDER.filter((r) => report.results[r].received > 0).map((r) => (
                  <tr key={r}>
                    <td>{KINDS[r].label}</td>
                    <td>{report.results[r].received}</td>
                    <td><strong>{report.results[r].created}</strong></td>
                    <td>{report.results[r].skipped.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {report.errors.length > 0 && (
            <>
              <h4>{report.errorCount} problema(s) encontrado(s){report.errorCount > report.errors.length ? ` (mostrando ${report.errors.length})` : ''}</h4>
              <ul className="error-list">
                {report.errors.map((e, i) => (
                  <li key={i}>
                    <span className="where">{KINDS[e.resource].label} · {where(e.resource, e.line)}</span>
                    {e.message}
                  </li>
                ))}
              </ul>
              <p className="muted small">Corrija no Excel, remova o arquivo antigo, envie o novo e confira de novo. Nada foi gravado.</p>
            </>
          )}

          {ok && (
            <div className="import-actions">
              <span className="muted">{created === 0 ? 'Tudo isso já existe: não há nada novo para criar.' : `${created} registro(s) novo(s) serão criados.`}</span>
              <button className="primary" disabled={busy !== '' || created === 0} onClick={() => send(false)}>
                {busy === 'import' ? 'Importando…' : `Importar ${created} registro(s)`}
              </button>
            </div>
          )}
        </div>
      )}

      {done && (
        <div className="panel success-panel">
          <h3>Importação concluída</h3>
          <ul>
            {ORDER.filter((r) => done.results[r].received > 0).map((r) => (
              <li key={r}>
                {KINDS[r].label}: <strong>{done.results[r].created}</strong> criado(s)
                {done.results[r].skipped.length > 0 ? `, ${done.results[r].skipped.length} já existia(m)` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {files.length === 0 && !report && !done && <Empty title="Nenhum arquivo enviado ainda">Comece baixando um modelo ou arrastando suas planilhas para cima.</Empty>}
    </section>
  )
}
