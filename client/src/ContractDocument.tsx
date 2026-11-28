import { useEffect, useState, type ReactNode } from 'react'
import './contract-doc.css'

/**
 * Documento de contrato com a identidade da Ethos: cabeçalho, marca d'água, número, rodapé e quadro de assinaturas.
 * Usado na tela da equipe, na área do cliente, no link de assinatura e na impressão (PDF pelo navegador).
 * O texto vira elementos React (nunca HTML), com uma marcação mínima: "# ", "## ", "> ", **negrito** e [[assinaturas]].
 */

export interface DocLayout {
  type_label: string
  company: { name: string; legal_name: string | null; cnpj: string | null; creci: string | null; address: string | null; city: string | null; phone: string | null; email: string | null }
  logo: string | null
  signers: { role: string; name: string; document: string | null }[]
  witnesses: { name: string | null; document: string | null }[]
}

/** Símbolo da casa com o "E" (redesenhado a partir do modelo da Ethos; o logo oficial enviado em Dados da empresa o substitui). */
function EthosMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
      <path d="M6 21 24 6l18 15v19a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2Z" />
      <path d="M32 22H18v14h14M18 29h11" />
    </svg>
  )
}

const inline = (text: string): ReactNode[] =>
  text.split(/(\*\*[^*]+\*\*)/).filter(Boolean).map((part, i) => (part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part))

function Signatures({ layout }: { layout: DocLayout }) {
  return (
    <div className="eth-signatures">
      <div className="eth-sign-grid">
        {layout.signers.map((s, i) => (
          <div className="eth-sign" key={i}>
            <strong>{s.role}</strong>
            <span>{s.name}</span>
            {s.document && <span>{s.document}</span>}
          </div>
        ))}
      </div>
      <div className="eth-sign-grid">
        {layout.witnesses.map((w, i) => (
          <div className="eth-witness" key={i}>
            <strong>TESTEMUNHA {i + 1}</strong>
            <span>Nome: {w.name || <i className="eth-blank" />}</span>
            <span>Documento: {w.document || <i className="eth-blank" />}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function body(content: string, layout: DocLayout): ReactNode[] {
  const out: ReactNode[] = []
  let para: string[] = []
  let signed = false
  const flush = () => {
    if (para.length === 0) return
    const sub = /^\*\*(\d+\.\d+\.\d+|[a-z]\))/.test(para[0]!)
    out.push(
      <p key={out.length} className={sub ? 'eth-sub' : undefined}>
        {para.map((l, i) => <span key={i}>{i > 0 && <br />}{inline(l)}</span>)}
      </p>,
    )
    para = []
  }
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trimEnd()
    const heading = /^(#{1,2}) (.+)$/.exec(line)
    if (!line.trim()) flush()
    else if (heading) {
      flush()
      out.push(heading[1] === '#' ? <h1 key={out.length}>{inline(heading[2]!)}</h1> : <h2 key={out.length}>{inline(heading[2]!)}</h2>)
    } else if (line.startsWith('> ')) {
      flush()
      out.push(<div key={out.length} className="eth-note">{inline(line.slice(2))}</div>)
    } else if (line.trim() === '[[assinaturas]]') {
      flush()
      signed = true
      // O texto de encerramento (local e data) fica na mesma página das assinaturas.
      const closing = out.splice(Math.max(0, out.length - 1))
      out.push(
        <div key={`fecho-${out.length}`} className="eth-closing">
          {closing}
          <Signatures layout={layout} />
        </div>,
      )
    } else para.push(line)
  }
  flush()
  // Todo documento tem quadro de assinaturas, mesmo que o modelo não diga onde.
  if (!signed) out.push(<Signatures key="fim" layout={layout} />)
  return out
}

function useHash(content: string) {
  const [hash, setHash] = useState('')
  useEffect(() => {
    let alive = true
    void crypto.subtle?.digest('SHA-256', new TextEncoder().encode(content)).then((buf) => {
      if (alive) setHash([...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join(''))
    })
    return () => {
      alive = false
    }
  }, [content])
  return hash
}

export default function ContractDocument({ content, layout, number, format }: { content: string; layout?: DocLayout | null; number?: string | null; format?: number }) {
  const hash = useHash(content)
  // Documentos emitidos antes desta versão continuam exatamente como eram.
  if (format !== 2 || !layout) return <article className="paper">{content}</article>

  const c = layout.company
  const draft = !number
  const isEthos = /ethos/i.test(c.name)
  const wordmark = isEthos ? 'Ethos' : c.name
  const footer = [c.legal_name ?? c.name, c.cnpj && `CNPJ ${c.cnpj}`, c.creci && `CRECI ${c.creci}`, [c.address, c.city].filter(Boolean).join(', '), c.phone, c.email].filter(Boolean).join(' · ')

  return (
    <article className="eth-doc">
      <div className="eth-watermark" aria-hidden="true">
        {layout.logo ? <img src={layout.logo} alt="" /> : <EthosMark />}
        <span>{(isEthos ? 'Ethos' : c.name).toUpperCase()}</span>
      </div>
      {draft && <div className="eth-draft" aria-hidden="true">MINUTA</div>}
      <table className="eth-sheet" role="presentation">
        <thead>
          <tr>
            <td>
              <header className="eth-head">
                {layout.logo ? (
                  <img className="eth-logo" src={layout.logo} alt={c.legal_name ?? c.name} />
                ) : (
                  <div className="eth-brand">
                    <EthosMark />
                    <div>
                      <strong>{wordmark}</strong>
                      {isEthos && <small>ADMINISTRADORA DE IMÓVEIS</small>}
                    </div>
                  </div>
                )}
                <div className="eth-meta">
                  <span>{layout.type_label.toUpperCase()}</span>
                  <strong>{number ?? 'MINUTA · SEM NÚMERO'}</strong>
                </div>
              </header>
            </td>
          </tr>
        </thead>
        <tfoot>
          <tr>
            <td>
              <footer className="eth-foot">
                <span>{footer}</span>
                <span>{draft ? 'Minuta sem valor: ainda não emitida' : `Documento ${number}`}{!draft && hash ? ` · verificação ${hash.slice(0, 16)}` : ''}</span>
              </footer>
            </td>
          </tr>
        </tfoot>
        <tbody>
          <tr>
            <td className="eth-body">{body(content, layout)}</td>
          </tr>
        </tbody>
      </table>
    </article>
  )
}
