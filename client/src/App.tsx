import { useEffect, useState, type FormEvent } from 'react'
import { api, type Session } from './api'
import ResourcePage from './ResourcePage'
import { RESOURCES } from './resources'
import './App.css'

function AuthForm({ onAuth }: { onAuth: (s: Session) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [name, setName] = useState('')
  const [organization, setOrganization] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      onAuth(
        mode === 'login'
          ? await api.login(email, password)
          : await api.register(name, email, password, organization),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro inesperado')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card auth" onSubmit={submit}>
      <div className="brand">Ethos</div>
      <h2>{mode === 'login' ? 'Entrar' : 'Criar conta'}</h2>
      {mode === 'register' && (
        <>
          <label>
            Seu nome
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label>
            Nome da administradora
            <input value={organization} onChange={(e) => setOrganization(e.target.value)} />
          </label>
        </>
      )}
      <label>
        E-mail
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </label>
      <label>
        Senha
        <input
          type="password"
          value={password}
          minLength={mode === 'register' ? 8 : undefined}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <button type="submit" className="primary" disabled={busy}>
        {mode === 'login' ? 'Entrar' : 'Cadastrar'}
      </button>
      <button
        type="button"
        className="link"
        onClick={() => {
          setError('')
          setMode(mode === 'login' ? 'register' : 'login')
        }}
      >
        {mode === 'login' ? 'Não tem conta? Cadastre-se' : 'Já tem conta? Entrar'}
      </button>
    </form>
  )
}

const STAFF = ['admin', 'colaborador']

function Shell({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [current, setCurrent] = useState(RESOURCES[0].key)
  const isStaff = STAFF.includes(session.role)
  const def = RESOURCES.find((r) => r.key === current)!

  return (
    <div className="shell">
      <aside>
        <div className="brand">Ethos</div>
        <nav>
          {isStaff &&
            RESOURCES.map((r) => (
              <button
                key={r.key}
                className={r.key === current ? 'nav active' : 'nav'}
                onClick={() => setCurrent(r.key)}
              >
                {r.title}
              </button>
            ))}
        </nav>
      </aside>
      <div className="content">
        <header>
          <span className="muted">{session.organization.name}</span>
          <span className="spacer" />
          <span>
            {session.user.name} · {session.role}
          </span>
          <button onClick={onLogout}>Sair</button>
        </header>
        <main>
          {isStaff ? (
            <ResourcePage key={def.key} def={def} canDelete={session.role === 'admin'} />
          ) : (
            <p className="empty">Seu perfil ({session.role}) ainda não tem telas disponíveis.</p>
          )}
        </main>
      </div>
    </div>
  )
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api
      .me()
      .then((r) => setSession('role' in r ? r : null))
      .catch(() => setSession(null))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <p className="center muted">Carregando…</p>
  if (!session) return <AuthForm onAuth={setSession} />
  return (
    <Shell
      session={session}
      onLogout={async () => {
        await api.logout()
        setSession(null)
      }}
    />
  )
}
