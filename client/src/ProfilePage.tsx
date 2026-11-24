import { useEffect, useState, type FormEvent } from 'react'
import { api, request, ROLE_LABELS, type Role, type Session } from './api'
import { Alert, Loading, errorText, toast } from './feedback'
import { date } from './format'
import MaskedInput, { maskWarning } from './MaskedInput'
import PasswordInput from './PasswordInput'

/** "Meu perfil": cada pessoa edita os próprios dados, troca e-mail e senha e encerra outras sessões. */

interface Profile {
  user: { id: number; name: string; email: string; phone: string | null; document: string | null; birth_date: string | null; created_at: string }
  role: Role
  organization: { id: number; name: string }
  organizations: { id: number; name: string; role: Role }[]
}

const json = (method: string, body?: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })

export default function ProfilePage({ onSession }: { session: Session; onSession: (s: Session) => void }) {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [error, setError] = useState('')

  async function load() {
    try {
      setProfile(await request<Profile>('/api/profile'))
    } catch (e) {
      setError(errorText(e))
    }
  }
  useEffect(() => {
    void load()
  }, [])

  /** Depois de mudar nome/e-mail, a sessão do app (menu, saudação) precisa refletir. */
  async function refreshSession() {
    await load()
    const me = await api.me()
    if ('role' in me) onSession(me)
  }

  if (error) return <Alert>{error}</Alert>
  if (!profile) return <Loading label="Carregando…" />
  return (
    <section>
      <div className="page-head">
        <h2>Meu perfil</h2>
        <span className="muted">{ROLE_LABELS[profile.role]} · {profile.organization.name}</span>
      </div>
      <div className="profile-grid">
        <DataForm profile={profile} onSaved={refreshSession} />
        <EmailForm profile={profile} onSaved={refreshSession} />
        <PasswordForm />
        <SessionsCard profile={profile} />
      </div>
    </section>
  )
}

function DataForm({ profile, onSaved }: { profile: Profile; onSaved: () => Promise<void> }) {
  const u = profile.user
  const [name, setName] = useState(u.name)
  const [phone, setPhone] = useState(u.phone ?? '')
  const [document, setDocument] = useState(u.document ?? '')
  const [birth, setBirth] = useState(u.birth_date ? u.birth_date.slice(0, 10) : '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await request('/api/profile', json('PUT', { name, phone, document, birth_date: birth }))
      await onSaved()
      toast.success('Perfil atualizado.')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="panel stack" onSubmit={submit} aria-labelledby="perfil-dados">
      <h3 id="perfil-dados">Dados pessoais</h3>
      <div className="form-grid">
        <label className="wide">
          Nome
          <input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={100} autoComplete="name" />
        </label>
        <label>
          Telefone
          <MaskedInput kind="phone" value={phone} onValue={setPhone} />
          {maskWarning('phone', phone) && <span className="mask-hint">{maskWarning('phone', phone)}</span>}
        </label>
        <label>
          CPF / CNPJ
          <MaskedInput kind="document" value={document} onValue={setDocument} />
          {maskWarning('document', document) && <span className="mask-hint">{maskWarning('document', document)}</span>}
        </label>
        <label>
          Data de nascimento
          <input type="date" value={birth} onChange={(e) => setBirth(e.target.value)} max={new Date().toLocaleDateString('sv-SE')} autoComplete="bday" />
        </label>
      </div>
      <p className="muted small">Conta criada em {date(u.created_at)}. Telefone, CPF e nascimento são opcionais e ficam visíveis só para você.</p>
      {error && <Alert>{error}</Alert>}
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar dados'}</button>
      </div>
    </form>
  )
}

function EmailForm({ profile, onSaved }: { profile: Profile; onSaved: () => Promise<void> }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await request('/api/profile/email', json('POST', { email, password }))
      setEmail('')
      setPassword('')
      await onSaved()
      toast.success('E-mail de acesso alterado. Use o novo e-mail no próximo login.')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="panel stack" onSubmit={submit} aria-labelledby="perfil-email">
      <h3 id="perfil-email">E-mail de acesso</h3>
      <p className="muted small">Hoje: <strong>{profile.user.email}</strong>. Para trocar, confirme com a sua senha atual.</p>
      <div className="form-grid">
        <label>
          Novo e-mail
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="off" />
        </label>
        <label>
          Senha atual
          <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" aria-label="Senha atual para trocar o e-mail" />
        </label>
      </div>
      {error && <Alert>{error}</Alert>}
      <div className="actions">
        <button type="submit" disabled={busy || !email || !password}>{busy ? 'Alterando…' : 'Alterar e-mail'}</button>
      </div>
    </form>
  )
}

function PasswordForm() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (next !== again) return setError('A confirmação não é igual à nova senha.')
    setBusy(true)
    try {
      await request('/api/profile/password', json('POST', { current_password: current, new_password: next }))
      setCurrent('')
      setNext('')
      setAgain('')
      toast.success('Senha alterada. Os outros aparelhos foram desconectados.')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="panel stack" onSubmit={submit} aria-labelledby="perfil-senha">
      <h3 id="perfil-senha">Senha</h3>
      <div className="form-grid">
        <label className="wide">
          Senha atual
          <PasswordInput value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password" aria-label="Senha atual" />
        </label>
        <label>
          Nova senha
          <PasswordInput value={next} onChange={(e) => setNext(e.target.value)} required minLength={8} maxLength={200} autoComplete="new-password" aria-label="Nova senha" />
        </label>
        <label>
          Repita a nova senha
          <PasswordInput value={again} onChange={(e) => setAgain(e.target.value)} required minLength={8} maxLength={200} autoComplete="new-password" aria-label="Repita a nova senha" />
        </label>
      </div>
      <p className="muted small">Mínimo de 8 caracteres. Ao trocar, as outras sessões abertas (outros aparelhos) são encerradas.</p>
      {error && <Alert>{error}</Alert>}
      <div className="actions">
        <button type="submit" disabled={busy || !current || !next}>{busy ? 'Alterando…' : 'Alterar senha'}</button>
      </div>
    </form>
  )
}

function SessionsCard({ profile }: { profile: Profile }) {
  const [busy, setBusy] = useState(false)
  async function endOthers() {
    setBusy(true)
    try {
      const r = await request<{ ended: number }>('/api/profile/sessions/logout-others', json('POST'))
      toast.success(r.ended === 0 ? 'Não havia outras sessões abertas.' : `${r.ended} sessão(ões) encerrada(s).`)
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="panel stack">
      <h3>Segurança e acessos</h3>
      <p className="muted small">Se você entrou em um computador que não é seu, encerre as outras sessões. Esta continua aberta.</p>
      <div className="actions">
        <button onClick={endOthers} disabled={busy}>{busy ? 'Encerrando…' : 'Encerrar outras sessões'}</button>
      </div>
      {profile.organizations.length > 0 && (
        <>
          <h4>Seus acessos</h4>
          <ul className="plain-list">
            {profile.organizations.map((o) => (
              <li key={o.id}>
                <strong>{o.name}</strong> <span className="muted">· {ROLE_LABELS[o.role]}</span>
                {o.id === profile.organization.id && <span className="badge"> atual</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
