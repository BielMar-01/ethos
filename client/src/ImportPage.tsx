import { useRef, useState, type DragEvent } from 'react'
import { Alert, Empty, errorText, toast } from './feedback'
import { downloadCsv, parseCsv, readCsvFile, readXlsxFile } from './csv'

/** Importação em massa: vários arquivos (CSV ou Excel) ou dados colados da planilha, de 7 tipos, com simulação antes de gravar. */

type Resource = 'owners' | 'tenants' | 'properties' | 'units' | 'leases' | 'charges' | 'inspections'
const ORDER: Resource[] = ['owners', 'tenants', 'properties', 'units', 'leases', 'charges', 'inspections']

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
  leases: {
    label: 'Contratos',
    file: 'modelo-contratos.csv',
    headers: ['imovel', 'unidade', 'locatarios', 'inicio', 'fim', 'aluguel', 'dia_vencimento', 'garantia', 'situacao', 'observacoes'],
    example: ['Edifício Aurora', 'Apto 101', '987.654.321-00 | 111.222.333-96', '01/01/2026', '31/12/2026', '2500,00', '10', 'Caução de 3 aluguéis', 'vigente', ''],
    hint: 'Unidade e locatários (documentos separados por |) devem existir ou estar no mesmo envio. Datas dd/mm/aaaa. Situação: rascunho (padrão), vigente, encerrado ou rescindido. Vigente não pode sobrepor outro vigente da unidade.',
  },
  charges: {
    label: 'Cobranças',
    file: 'modelo-cobrancas.csv',
    headers: ['imovel', 'unidade', 'tipo', 'descricao', 'vencimento', 'valor'],
    example: ['Edifício Aurora', 'Apto 101', 'aluguel', 'Aluguel 06/2026', '10/06/2026', '2500,00'],
    hint: 'Vai para o contrato da unidade que cobre o vencimento (precisa existir, fora de rascunho). Tipo: aluguel (padrão), multa, juros, taxa ou outro; só o aluguel tem descrição automática. Repetidas são puladas.',
  },
  inspections: {
    label: 'Vistorias',
    file: 'modelo-vistorias.csv',
    headers: ['imovel', 'unidade', 'tipo', 'data', 'observacoes'],
    example: ['Edifício Aurora', 'Apto 101', 'entrada', '02/01/2026', ''],
    hint: 'Entram como agendadas, já com o checklist padrão por ambiente. Tipo: entrada, saida ou periodica. Repetidas (mesma unidade, tipo e data) são puladas.',
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
  if (/contrato|lease|locacao/.test(n)) return 'leases'
  if (/cobranc|boleto|charge|fatura/.test(n)) return 'charges'
  if (/vistoria|inspec/.test(n)) return 'inspections'
  if (/proprietari|owner|donos?/.test(n)) return 'owners'
  if (/inquilin|locatari|tenant/.test(n)) return 'tenants'
  if (/unidade|unit|apto/.test(n)) return 'units'
  if (/imove|propert|predio/.test(n)) return 'properties'
  const h = headers.map(canon)
  if (h.includes('locatarios') || h.includes('inicio')) return 'leases'
  if (h.includes('vencimento') && h.includes('valor')) return 'charges'
  if (h.includes('data') && h.includes('tipo') && h.includes('unidade')) return 'inspections'
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
  const [pasteKind, setPasteKind] = useState<Resource>('owners')
  const [pasteText, setPasteText] = useState('')

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
      if (/\.xls$/i.test(file.name)) {
        toast.error(`"${file.name}" é um Excel antigo (.xls). Abra no Excel e use Arquivo → Salvar como → Pasta de Trabalho do Excel (.xlsx) ou CSV UTF-8.`)
        continue
      }
      if (!/\.(csv|txt|tsv|xlsx)$/i.test(file.name)) {
        toast.error(`"${file.name}" não é um arquivo aceito. Use Excel (.xlsx) ou CSV.`)
        continue
      }
      try {
        const parsed = /\.xlsx$/i.test(file.name) ? await readXlsxFile(file) : await readCsvFile(file)
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

  /** Dados copiados do Excel/Google Planilhas (colunas separadas por tabulação), com a primeira linha como cabeçalho. */
  function addPasted() {
    const parsed = parseCsv(pasteText)
    if (parsed.headers.length === 0 || parsed.rows.length === 0) {
      toast.error('Cole as células com a primeira linha de cabeçalho e ao menos uma linha de dados.')
      return
    }
    change((f) => [...f, { id: nextId++, name: `Colado (${KINDS[pasteKind].label})`, kind: pasteKind, headers: parsed.headers, rows: parsed.rows }])
    setPasteText('')
    toast.success(`${parsed.rows.length} linha(s) adicionada(s).`)
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
    const segments = Object.fromEntries(ORDER.map((r) => [r, [] as { name: string; start: number; count: number }[]])) as Record<Resource, { name: string; start: number; count: number }[]>
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
            Envie planilhas (Excel ou CSV) ou cole direto da planilha: proprietários, inquilinos, imóveis, unidades, contratos, cobranças e vistorias — vários de uma vez. Antes de gravar, você vê o que seria criado; se houver erro, nada é importado.
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
        <p className="muted small">Ordem automática: proprietários → inquilinos → imóveis → unidades → contratos → cobranças → vistorias. Por isso cada tipo pode citar o anterior mesmo que ele esteja no mesmo envio. Telefone, CPF/CNPJ e CEP são padronizados na importação.</p>
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
          <strong>Arraste os arquivos aqui (Excel .xlsx ou CSV)</strong>
          <span className="muted">ou clique para escolher (pode selecionar vários)</span>
          <input
            ref={input}
            type="file"
            accept=".csv,.txt,.tsv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
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

      <div className="panel">
        <h3>Ou cole direto da planilha</h3>
        <p className="muted small">No Excel ou Google Planilhas, selecione as células <strong>incluindo a linha de títulos</strong>, copie (Ctrl+C) e cole aqui.</p>
        <div className="paste-row">
          <select aria-label="Tipo dos dados colados" value={pasteKind} onChange={(e) => setPasteKind(e.target.value as Resource)}>
            {ORDER.map((r) => (
              <option key={r} value={r}>{KINDS[r].label}</option>
            ))}
          </select>
          <button disabled={!pasteText.trim()} onClick={addPasted}>Adicionar à lista</button>
        </div>
        <textarea
          aria-label="Dados colados da planilha"
          className="paste-box"
          rows={5}
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          placeholder={KINDS[pasteKind].headers.join('\t')}
          spellCheck={false}
        />
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
