import { useRef, useState } from 'react'
import { request } from './api'
import { Alert, ask, errorText, toast } from './feedback'
import { Loaded, Table, dateOnly, download, useLoad } from './kit'

/** Documentos que já existem (contrato assinado, aditivos, laudos…), guardados junto do contrato. */

interface LeaseFile { id: number; kind: string; title: string; content_type: string; size_bytes: number; created_at: string; created_by_name: string | null }

const KINDS: [string, string][] = [['contrato', 'Contrato assinado'], ['aditivo', 'Aditivo'], ['vistoria', 'Laudo de vistoria'], ['garantia', 'Garantia'], ['distrato', 'Distrato'], ['outro', 'Outro']]
const EXT: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx' }
const MAX = 5 * 1024 * 1024

export default function LeaseFiles({ leaseId, isAdmin }: { leaseId: number; isAdmin: boolean }) {
  const files = useLoad(() => request<{ items: LeaseFile[] }>(`/api/leases/${leaseId}/files`), [leaseId])
  const input = useRef<HTMLInputElement>(null)
  const [kind, setKind] = useState('contrato')
  const [progress, setProgress] = useState('')
  const [problems, setProblems] = useState<string[]>([])

  async function upload(list: File[]) {
    setProblems([])
    const failed: string[] = []
    let sent = 0
    // Um de cada vez: um arquivo com problema não impede os outros.
    for (const [i, file] of list.entries()) {
      setProgress(`Enviando ${i + 1} de ${list.length}…`)
      if (file.size > MAX) {
        failed.push(`${file.name}: maior que 5 MB.`)
        continue
      }
      const title = file.name.replace(/\.[^.]+$/, '').trim().padEnd(2, '_').slice(0, 150)
      try {
        await request(`/api/leases/${leaseId}/files?kind=${kind}&title=${encodeURIComponent(title)}`, { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } })
        sent += 1
      } catch (e) {
        failed.push(`${file.name}: ${errorText(e)}`)
      }
    }
    setProgress('')
    setProblems(failed)
    if (sent > 0) toast.success(sent === 1 ? 'Documento anexado.' : `${sent} documentos anexados.`)
    await files.reload()
  }

  async function remove(f: LeaseFile) {
    if (!(await ask(`Excluir o anexo "${f.title}"? O arquivo será apagado e não poderá ser recuperado.`, { title: 'Excluir anexo', confirmLabel: 'Excluir', danger: true }))) return
    try {
      await request(`/api/lease-files/${f.id}`, { method: 'DELETE' })
      await files.reload()
    } catch (e) {
      setProblems([errorText(e)])
    }
  }

  return (
    <div className="panel no-print stack">
      <h3>Documentos já existentes</h3>
      <p className="muted small">Anexe o contrato já assinado, aditivos e laudos deste contrato. PDF, Word (.docx), JPEG ou PNG, até 5 MB cada. Só a equipe vê estes arquivos.</p>
      <div className="inline">
        <select aria-label="Tipo do anexo" value={kind} onChange={(e) => setKind(e.target.value)}>
          {KINDS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <button type="button" className="primary" disabled={Boolean(progress)} onClick={() => input.current?.click()}>{progress || 'Anexar arquivos'}</button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          aria-label="Arquivos do contrato"
          accept=".pdf,.docx,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onChange={(e) => {
            const list = Array.from(e.target.files ?? [])
            e.target.value = ''
            if (list.length) void upload(list)
          }}
        />
      </div>
      {problems.length > 0 && <Alert>{problems.join(' ')}</Alert>}
      <Loaded state={files}>
        {(d) => (
          <Table rows={d.items} empty="Nenhum arquivo anexado a este contrato." cols={[
            { head: 'Tipo', cell: (f) => KINDS.find(([v]) => v === f.kind)?.[1] ?? f.kind },
            { head: 'Arquivo', cell: (f) => f.title },
            { head: 'Enviado em', cell: (f) => `${dateOnly(f.created_at)}${f.created_by_name ? ` · ${f.created_by_name}` : ''}` },
            { head: 'Tamanho', cell: (f) => `${Math.max(1, Math.round(f.size_bytes / 1024))} KB`, className: 'num' },
            {
              head: '',
              cell: (f) => (
                <span className="row-actions">
                  <button type="button" onClick={() => void download(`/api/lease-files/${f.id}/file`, `${f.title}.${EXT[f.content_type] ?? 'bin'}`)} aria-label={`Baixar ${f.title}`}>Baixar</button>
                  {isAdmin && <button type="button" className="danger" onClick={() => void remove(f)} aria-label={`Excluir ${f.title}`}>Excluir</button>}
                </span>
              ),
            },
          ]} />
        )}
      </Loaded>
    </div>
  )
}
