import { useEffect, useState, type FormEvent } from 'react'
import { api, type User } from './api'
import './App.css'

function AuthForm({ onAuth }: { onAuth: (user: User) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const { user } =
        mode === 'login'
          ? await api.login(email, password)
          : await api.register(name, email, password)
      onAuth(user)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro inesperado')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h1>Ethos</h1>
      <h2>{mode === 'login' ? 'Entrar' : 'Criar conta'}</h2>
      {mode === 'register' && (
        <label>
          Nome
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
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
      {error && <p className="error">{error}</p>}
      <button type="submit" disabled={busy}>
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

function Dashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [users, setUsers] = useState<User[]>([])

  useEffect(() => {
    if (user.role === 'admin') api.users().then((r) => setUsers(r.users)).catch(() => {})
  }, [user])

  return (
    <div className="dashboard">
      <header>
        <strong>Ethos</strong>
        <span>
          {user.name} ({user.role})
        </span>
        <button onClick={onLogout}>Sair</button>
      </header>
      <main>
        <h2>Painel</h2>
        <p>Bem-vindo, {user.name}.</p>
        {user.role === 'admin' && (
          <>
            <h3>Usuários</h3>
            <table>
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>E-mail</th>
                  <th>Perfil</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>{u.name}</td>
                    <td>{u.email}</td>
                    <td>{u.role}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </main>
    </div>
  )
}

export default function App() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api
      .me()
      .then((r) => setUser(r.user))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <p className="center">Carregando…</p>
  if (!user) return <AuthForm onAuth={setUser} />
  return (
    <Dashboard
      user={user}
      onLogout={async () => {
        await api.logout()
        setUser(null)
      }}
    />
  )
}
