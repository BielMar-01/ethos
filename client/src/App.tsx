import { useEffect, useState, type FormEvent } from 'react'
import { api, type InviteInfo, type Session } from './api'
import Icon from './Icon'
import PasswordInput from './PasswordInput'
import LandingPage, { PublicLayout } from './LandingPage'
import ApiPage from './ApiPage'
import Shell from './Shell'
import { go, isStandalone, routeFromHash, type PublicRoute } from './routes'
import './App.css'
import './layout.css'
import './ux.css'
import './public.css'
import './shell.css'
import './modal.css'
import { Alert, Loading, toast } from './feedback'

const message = (e: unknown) => (e instanceof Error ? e.message : 'Erro inesperado')

/** Lê o que o link de e-mail / convite trouxe e limpa a URL. */
type Entry =
  | { kind: 'reset'; accessToken: string }
  | { kind: 'emailChange'; accessToken: string }
  | { kind: 'signup' }
  | { kind: 'linkError'; text: string }
  | { kind: 'invite'; token: string }
  | { kind: 'none' }

function readEntry(): Entry {
  const hash = new URLSearchParams(window.location.hash.slice(1))
  const query = new URLSearchParams(window.location.search)
  let entry: Entry = { kind: 'none' }
  if (hash.get('type') === 'recovery' && hash.get('access_token')) {
    entry = { kind: 'reset', accessToken: hash.get('access_token')! }
  } else if (hash.get('type') === 'email_change' && hash.get('access_token')) {
    entry = { kind: 'emailChange', accessToken: hash.get('access_token')! }
  } else if (hash.get('type') === 'signup' && hash.get('access_token')) {
    entry = { kind: 'signup' }
  } else if (hash.get('error')) {
    entry = {
      kind: 'linkError',
      text: 'Este link é inválido ou expirou. Solicite um novo (recuperação de senha, e-mail ou confirmação de cadastro).',
    }
  } else if (query.get('invite')) {
    entry = { kind: 'invite', token: query.get('invite')! }
  }
  if (entry.kind !== 'none') window.history.replaceState(null, '', window.location.pathname)
  return entry
}

function Page({ title, children, onSubmit }: { title: string; children: React.ReactNode; onSubmit?: (e: FormEvent) => void }) {
  return (
    <div className="auth-split route-enter">
      <aside className="auth-aside" aria-hidden="true">
        <span className="blob b1" />
        <span className="blob b2" />
        <div className="aside-inner">
          <div className="brand">Ethos</div>
          <h2>Sua administração, organizada e transparente.</h2>
          <ul>
            <li><Icon name="shield" /> Dados de cada organização sempre separados</li>
            <li><Icon name="wallet" /> Cobranças, recibos e repasses num só lugar</li>
            <li><Icon name="history" /> Registro de tudo o que acontece no sistema</li>
          </ul>
        </div>
      </aside>
      <div className="auth-main">
        <form className="card auth auth-card" onSubmit={onSubmit} key={title}>
          <div className="brand auth-brand">Ethos</div>
          <h2>{title}</h2>
          {children}
        </form>
      </div>
    </div>
  )
}

function AuthForm({ onAuth, notice, initialMode = 'login' }: { onAuth: (s: Session) => void; notice?: string; initialMode?: 'login' | 'register' }) {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>(initialMode)
  const [name, setName] = useState('')
  const [organization, setOrganization] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [info, setInfo] = useState(notice ?? '')
  const [busy, setBusy] = useState(false)
  // Verificação em duas etapas: depois da senha certa o servidor devolve um desafio e espera o código.
  const [challenge, setChallenge] = useState<string | null>(null)
  const [code, setCode] = useState('')

  function switchMode(next: typeof mode) {
    setError('')
    setInfo('')
    setMode(next)
  }

  async function resend() {
    setError('')
    try {
      await api.resendVerification(email)
      setInfo('Se o e-mail estiver aguardando confirmação, enviamos um novo link.')
    } catch (err) {
      setError(message(err))
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setInfo('')
    setBusy(true)
    try {
      if (mode === 'forgot') {
        await api.forgot(email)
        setInfo('Se o e-mail estiver cadastrado, você receberá um link para redefinir a senha.')
      } else if (challenge) {
        onAuth(await api.mfa(challenge, code))
      } else if (mode === 'login') {
        const r = await api.login(email, password)
        if ('mfa_required' in r) {
          setChallenge(r.mfa_token)
          setPassword('')
          setCode('')
        } else onAuth(r)
      } else {
        const r = await api.register(name, email, password, organization)
        if ('verification_required' in r) {
          setPassword('')
          setMode('login')
          setInfo(`Enviamos um link de confirmação para ${r.email}. Clique nele e depois entre aqui.`)
        } else onAuth(r)
      }
    } catch (err) {
      const text = message(err)
      setError(text)
      // Desafio vencido ou queimado por erros: volta para e-mail e senha.
      if (challenge && /Entre novamente/.test(text)) {
        setChallenge(null)
        setCode('')
      }
    } finally {
      setBusy(false)
    }
  }

  if (challenge) {
    return (
      <Page title="Verificação em duas etapas" onSubmit={submit}>
        <p className="muted">Abra o aplicativo autenticador e digite o código de 6 dígitos. Sem o celular, use um dos seus códigos de recuperação.</p>
        <label>
          Código
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="text"
            autoComplete="one-time-code"
            autoFocus
            required
            maxLength={20}
            aria-label="Código de verificação"
          />
        </label>
        {error && <Alert>{error}</Alert>}
        <button type="submit" className="primary" disabled={busy || !code.trim()}>
          Confirmar
        </button>
        <button type="button" className="link" onClick={() => { setChallenge(null); setCode(''); setError('') }}>
          Voltar
        </button>
      </Page>
    )
  }

  return (
    <Page title={mode === 'login' ? 'Entrar' : mode === 'register' ? 'Criar conta' : 'Recuperar senha'} onSubmit={submit}>
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
      {mode !== 'forgot' && (
        <label>
          Senha
          <PasswordInput
            value={password}
            minLength={mode === 'register' ? 8 : undefined}
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
      )}
      {error && <Alert>{error}</Alert>}
      {info && <p className="notice" role="status">{info}</p>}
      <button type="submit" className="primary" disabled={busy}>
        {mode === 'login' ? 'Entrar' : mode === 'register' ? 'Cadastrar' : 'Enviar link de recuperação'}
      </button>
      {mode === 'login' && /Confirme o seu e-mail/.test(error) && email && (
        <button type="button" className="link" onClick={resend}>
          Reenviar o link de confirmação
        </button>
      )}
      {mode === 'login' && (
        <button type="button" className="link" onClick={() => switchMode('forgot')}>
          Esqueci minha senha
        </button>
      )}
      <button type="button" className="link" onClick={() => switchMode(mode === 'register' ? 'login' : mode === 'login' ? 'register' : 'login')}>
        {mode === 'login' ? 'Não tem conta? Cadastre-se' : 'Voltar para o login'}
      </button>
      {!isStandalone() && (
        <button type="button" className="link" onClick={() => go('home')}>
          ← Voltar ao início
        </button>
      )}
    </Page>
  )
}

function ResetPassword({ accessToken, onDone }: { accessToken: string; onDone: () => void }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (password !== confirm) {
      setError('As senhas não conferem.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await api.reset(accessToken, password)
      onDone()
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Page title="Nova senha" onSubmit={submit}>
      <label>
        Nova senha
        <PasswordInput minLength={8} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </label>
      <label>
        Confirmar senha
        <PasswordInput minLength={8} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </label>
      {error && <Alert>{error}</Alert>}
      <button type="submit" className="primary" disabled={busy}>
        Salvar nova senha
      </button>
    </Page>
  )
}

/** Destino do link de confirmação de e-mail: troca de e-mail (espelha no app) ou cadastro. */
function ConfirmEmail({ entry, onDone }: { entry: { kind: 'emailChange'; accessToken: string } | { kind: 'signup' }; onDone: () => void }) {
  const [state, setState] = useState<'working' | 'ok' | 'error'>(entry.kind === 'emailChange' ? 'working' : 'ok')
  const [text, setText] = useState(entry.kind === 'signup' ? 'E-mail confirmado! Agora é só entrar com o seu e-mail e senha.' : '')

  useEffect(() => {
    if (entry.kind !== 'emailChange') return
    api
      .emailConfirmed(entry.accessToken)
      .then((r) => {
        setText(`Pronto: o e-mail de acesso agora é ${r.email}. Entre usando o novo e-mail.`)
        setState('ok')
      })
      .catch((err) => {
        setText(message(err))
        setState('error')
      })
  }, [entry])

  if (state === 'working') return <Loading label="Confirmando o novo e-mail…" />
  return (
    <Page title={state === 'ok' ? 'E-mail confirmado' : 'Não foi possível confirmar'}>
      {state === 'ok' ? <p className="notice" role="status">{text}</p> : <Alert>{text}</Alert>}
      <button type="button" className="primary" onClick={onDone}>
        Ir para o login
      </button>
    </Page>
  )
}

function AcceptInvite({ token, onAuth, onCancel }: { token: string; onAuth: (s: Session) => void; onCancel: () => void }) {
  const [info, setInfo] = useState<InviteInfo | null>(null)
  const [invalid, setInvalid] = useState(false)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.inviteInfo(token).then(setInfo).catch(() => setInvalid(true))
  }, [token])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      onAuth(await api.acceptInvite(token, name, password))
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }

  if (invalid) {
    return (
      <Page title="Convite inválido">
        <p className="muted">Este convite expirou, já foi usado ou foi revogado. Peça um novo ao administrador.</p>
        <button type="button" className="primary" onClick={onCancel}>
          Ir para o login
        </button>
      </Page>
    )
  }
  if (!info) return <Loading label="Carregando convite…" />

  return (
    <Page title={`Convite para ${info.organizationName}`} onSubmit={submit}>
      <p className="muted">
        Entrando como <strong>{info.email}</strong>.{' '}
        {info.existingAccount
          ? 'Você já tem conta: confirme com a sua senha atual.'
          : 'Crie seu acesso para continuar.'}
      </p>
      {!info.existingAccount && (
        <label>
          Seu nome
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
      )}
      <label>
        {info.existingAccount ? 'Sua senha' : 'Escolha uma senha'}
        <PasswordInput
          minLength={info.existingAccount ? undefined : 8}
          autoComplete={info.existingAccount ? 'current-password' : 'new-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>
      {error && <Alert>{error}</Alert>}
      <button type="submit" className="primary" disabled={busy}>
        Aceitar convite
      </button>
    </Page>
  )
}

export default function App() {
  const [entry, setEntry] = useState<Entry>(readEntry)
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState('')
  const [route, setRoute] = useState<PublicRoute>(() => routeFromHash(window.location.hash))

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash(window.location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    api
      .me()
      .then((r) => setSession('role' in r ? r : null))
      .catch(() => setSession(null))
      .finally(() => setLoading(false))
  }, [])

  // Qualquer chamada que volte 401 (sessão expirada em outra aba, por exemplo) leva ao login com um aviso.
  useEffect(() => {
    const onExpired = () => {
      toast.info('Sua sessão expirou. Entre novamente.')
      setSession(null)
    }
    window.addEventListener('ethos:unauthorized', onExpired)
    return () => window.removeEventListener('ethos:unauthorized', onExpired)
  }, [])

  function authenticated(s: Session) {
    window.history.replaceState(null, '', window.location.pathname)
    setSession(s)
  }

  if (loading) return <Loading label="Carregando…" />

  if (entry.kind === 'reset') {
    return (
      <ResetPassword
        accessToken={entry.accessToken}
        onDone={() => {
          setSession(null)
          setNotice('Senha alterada. Entre com a nova senha.')
          setEntry({ kind: 'none' })
          go('login')
        }}
      />
    )
  }
  if (entry.kind === 'emailChange' || entry.kind === 'signup') {
    return (
      <ConfirmEmail
        entry={entry}
        onDone={() => {
          setEntry({ kind: 'none' })
          // Se o link foi aberto no mesmo navegador já logado, volta ao painel; senão vai ao login.
          api
            .me()
            .then((r) => {
              if ('role' in r) setSession(r)
              else go('login')
            })
            .catch(() => go('login'))
        }}
      />
    )
  }
  if (entry.kind === 'invite') {
    return (
      <AcceptInvite
        token={entry.token}
        onAuth={(s) => {
          authenticated(s)
          setEntry({ kind: 'none' })
        }}
        onCancel={() => {
          setEntry({ kind: 'none' })
          go('login')
        }}
      />
    )
  }
  if (!session) {
    // Link de recuperação inválido/expirado: mostra o login com o aviso.
    if (entry.kind === 'linkError') return <AuthForm onAuth={authenticated} notice={entry.text} />
    if (route === 'api') {
      return (
        <PublicLayout route="api">
          <ApiPage isAdmin={false} />
        </PublicLayout>
      )
    }
    if (route === 'login' || route === 'register') {
      return <AuthForm key={route} initialMode={route} onAuth={authenticated} notice={notice} />
    }
    return <LandingPage />
  }
  return (
    <Shell
      session={session}
      onSession={setSession}
      onLogout={async () => {
        await api.logout().catch(() => {})
        setSession(null)
        toast.success('Você saiu do sistema.')
        go(isStandalone() ? 'login' : 'home')
      }}
    />
  )
}
