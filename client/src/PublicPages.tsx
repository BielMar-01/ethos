import { useEffect, useState, type FormEvent } from 'react'
import { request } from './api'
import { Alert, Loading } from './feedback'
import { json, money } from './kit'
import MaskedInput from './MaskedInput'
import ContractDocument, { type DocLayout } from './ContractDocument'

/** Páginas públicas (sem login): assinatura de documento por link e vitrine de unidades disponíveis. */

const shell = (children: React.ReactNode) => (
  <div className="auth-main" style={{ minHeight: '100vh', alignItems: 'flex-start', padding: '1.5rem 1rem' }}>
    <div className="card auth-card" style={{ maxWidth: 760, width: '100%' }}>
      <div className="brand auth-brand">Ethos</div>
      {children}
    </div>
  </div>
)

interface SignInfo {
  document: { title: string; content: string; hash: string; number?: string | null; format?: number; layout?: DocLayout | null }
  signer: { name: string; role: string; signed_at: string | null }
  status: string
  others: { name: string; role: string; signed: boolean }[]
}

export function SignPage({ token }: { token: string }) {
  const [info, setInfo] = useState<SignInfo | null>(null)
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [accept, setAccept] = useState(false)
  const [done, setDone] = useState<null | { completed: boolean }>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    request<SignInfo>(`/api/sign/${encodeURIComponent(token)}`).then(setInfo).catch((e) => setError(e instanceof Error ? e.message : 'Link inválido.'))
  }, [token])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      setDone(await request<{ completed: boolean }>(`/api/sign/${encodeURIComponent(token)}`, json('POST', { signed_name: name, accept })))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível assinar.')
    } finally {
      setBusy(false)
    }
  }

  if (error && !info) return shell(<><h2>Link indisponível</h2><Alert>{error}</Alert><p className="muted">O link pode ter sido cancelado ou digitado errado. Peça um novo a quem o enviou.</p></>)
  if (!info) return <Loading label="Carregando documento…" />
  const signed = !!info.signer.signed_at || !!done
  return shell(
    <>
      <h2>{info.document.title}</h2>
      <p className="muted">Olá, <strong>{info.signer.name}</strong> ({info.signer.role}). Leia o documento abaixo e, se concordar, assine no fim da página.</p>
      <div style={{ maxHeight: '60vh', overflow: 'auto' }} tabIndex={0} role="region" aria-label="Texto do documento">
        <ContractDocument content={info.document.content} layout={info.document.layout} format={info.document.format} number={info.document.number} />
      </div>
      <p className="muted small">Impressão digital do texto (SHA-256): <code>{info.document.hash}</code></p>
      <h3>Quem assina</h3>
      <ul className="plain-list">{info.others.map((o) => <li key={o.name}>{o.name} <span className="muted">({o.role})</span> {o.signed ? <span className="badge badge-ok">assinou</span> : <span className="badge">pendente</span>}</li>)}</ul>
      {signed ? (
        <p className="notice" role="status">Assinatura registrada. {done?.completed || info.status === 'concluida' ? 'Todas as assinaturas foram coletadas.' : 'Falta(m) outra(s) pessoa(s) assinar.'}</p>
      ) : info.status !== 'pendente' ? (
        <Alert>Esta coleta de assinaturas não está mais aberta.</Alert>
      ) : (
        <form className="stack" onSubmit={submit}>
          <label>Digite o seu nome completo, como acima, para assinar<input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" placeholder={info.signer.name} /></label>
          <label className="check"><input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} /> Li o documento e concordo com o seu conteúdo.</label>
          {error && <Alert>{error}</Alert>}
          <button className="primary" disabled={busy || !accept || name.trim().length < 3}>Assinar</button>
          <p className="muted small">Assinatura eletrônica simples: ficam registrados data, hora, endereço IP e navegador. Não é assinatura qualificada (ICP-Brasil).</p>
        </form>
      )}
    </>,
  )
}

interface Listing { organization: string; items: { id: number; identifier: string; bedrooms: number | null; area_m2: number | null; rent_reference_cents: number | null; property_name: string; type: string; neighborhood: string | null; city: string | null; state: string | null }[] }

export function ListingPage({ token }: { token: string }) {
  const [data, setData] = useState<Listing | null>(null)
  const [error, setError] = useState('')
  const [unitId, setUnitId] = useState<number | null>(null)
  const [sent, setSent] = useState(false)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')
  const [consent, setConsent] = useState(false)
  const [website, setWebsite] = useState('')
  const [formError, setFormError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    request<Listing>(`/api/public/listings/${encodeURIComponent(token)}`).then(setData).catch((e) => setError(e instanceof Error ? e.message : 'Vitrine indisponível.'))
  }, [token])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setFormError('')
    try {
      await request('/api/public/interest', json('POST', { token, name, phone, email, message, consent, unit_id: unitId ?? undefined, website }))
      setSent(true)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Não foi possível enviar.')
    } finally {
      setBusy(false)
    }
  }

  if (error) return shell(<><h2>Vitrine indisponível</h2><Alert>{error}</Alert></>)
  if (!data) return <Loading label="Carregando…" />
  return shell(
    <>
      <h2>Imóveis disponíveis — {data.organization}</h2>
      {data.items.length === 0 ? <p className="muted">No momento não há unidades disponíveis. Deixe seu contato abaixo e avisaremos.</p> : (
        <div className="listing-grid">
          {data.items.map((u) => (
            <button key={u.id} type="button" className={unitId === u.id ? 'listing-card active' : 'listing-card'} onClick={() => setUnitId(unitId === u.id ? null : u.id)} aria-pressed={unitId === u.id}>
              <strong>{u.property_name} · {u.identifier}</strong>
              <span className="muted">{[u.neighborhood, u.city && `${u.city}${u.state ? `/${u.state}` : ''}`].filter(Boolean).join(' · ')}</span>
              <span>{[u.bedrooms ? `${u.bedrooms} quarto(s)` : null, u.area_m2 ? `${u.area_m2} m²` : null].filter(Boolean).join(' · ')}</span>
              {u.rent_reference_cents && <strong>{money(u.rent_reference_cents)}/mês</strong>}
            </button>
          ))}
        </div>
      )}
      <h3>Tenho interesse</h3>
      {sent ? <p className="notice" role="status">Recebemos o seu contato. Em breve falaremos com você.</p> : (
        <form className="stack" onSubmit={submit}>
          {unitId && <p className="muted small">Interesse em: {data.items.find((u) => u.id === unitId)?.identifier}</p>}
          <div className="form-grid">
            <label>Nome<input value={name} onChange={(e) => setName(e.target.value)} required minLength={3} /></label>
            <label>Telefone (com DDD)<MaskedInput kind="phone" value={phone} onValue={setPhone} /></label>
            <label>E-mail<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <label className="wide">Mensagem<textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500} /></label>
          </div>
          {/* Armadilha para robôs: pessoas não veem nem preenchem. */}
          <label style={{ position: 'absolute', left: '-9999px' }} aria-hidden="true">Site<input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} /></label>
          <label className="check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Autorizo a administradora a usar estes dados para entrar em contato comigo sobre imóveis.</label>
          {formError && <Alert>{formError}</Alert>}
          <button className="primary" disabled={busy || !consent || (!phone && !email)}>Enviar</button>
        </form>
      )}
    </>,
  )
}
