import { useEffect, useRef, useState, type FormEvent } from 'react'
import QRCode from 'qrcode'
import { api, request, ROLE_LABELS, type Role, type Session } from './api'
import { Alert, Loading, ask, errorText, toast } from './feedback'
import { date, dateTime } from './format'
import MaskedInput, { maskWarning } from './MaskedInput'
import Modal from './Modal'
import PasswordInput from './PasswordInput'

/** "Meu perfil": dados pessoais, foto, e-mail e senha, verificação em duas etapas, aparelhos conectados e privacidade (LGPD). */

interface Profile {
  user: {
    id: number
    name: string
    email: string
    pending_email: string | null
    phone: string | null
    document: string | null
    birth_date: string | null
    created_at: string
    has_avatar: boolean
    avatar_version: number | null
  }
  role: Role
  organization: { id: number; name: string }
  organizations: { id: number; name: string; role: Role }[]
}

const json = (method: string, body?: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })

export default function ProfilePage({ onSession, onLoggedOut }: { session: Session; onSession: (s: Session) => void; onLoggedOut?: () => void }) {
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

  /** Depois de mudar nome/foto/e-mail, a sessão do app (menu, saudação) precisa refletir. */
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
        <EmailForm profile={profile} onSaved={load} />
        <PasswordForm />
        <TwoFactorCard />
        <SessionsCard profile={profile} />
        <PrivacyCard onClosed={() => onLoggedOut?.()} />
      </div>
    </section>
  )
}

/** Recorta o centro, reduz para 256 px e recomprime em JPEG: a foto de perfil nunca passa de poucos KB. */
async function avatarBlob(file: File): Promise<Blob> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error('Não foi possível ler a imagem. Use JPEG, PNG ou WebP.')
  }
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 256
  canvas.getContext('2d')!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86))
  if (!blob) throw new Error('Não foi possível preparar a imagem.')
  return blob
}

function AvatarEditor({ profile, onSaved }: { profile: Profile; onSaved: () => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const u = profile.user
  const initials = u.name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('')

  async function pick(file: File | undefined) {
    if (!file) return
    setBusy(true)
    try {
      const blob = await avatarBlob(file)
      const res = await fetch('/api/profile/avatar', { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: blob })
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Não foi possível enviar a foto.')
      await onSaved()
      toast.success('Foto de perfil atualizada.')
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  async function remove() {
    setBusy(true)
    try {
      await request('/api/profile/avatar', { method: 'DELETE' })
      await onSaved()
      toast.success('Foto removida.')
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="avatar-editor">
      <span className="avatar avatar-lg" aria-hidden="true">
        {u.has_avatar ? <img src={`/api/profile/avatar?v=${u.avatar_version ?? 0}`} alt="" /> : initials}
      </span>
      <div className="stack-sm">
        <strong>Foto de perfil</strong>
        <span className="muted small">Só você e o menu a veem. JPEG, PNG ou WebP.</span>
        <div className="actions">
          <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" hidden aria-label="Escolher foto de perfil" onChange={(e) => void pick(e.target.files?.[0])} />
          <button type="button" onClick={() => input.current?.click()} disabled={busy}>{busy ? 'Enviando…' : u.has_avatar ? 'Trocar foto' : 'Enviar foto'}</button>
          {u.has_avatar && <button type="button" onClick={remove} disabled={busy}>Remover</button>}
        </div>
      </div>
    </div>
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
      <AvatarEditor profile={profile} onSaved={onSaved} />
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
  const pending = profile.user.pending_email

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const r = await request<{ message: string }>('/api/profile/email', json('POST', { email, password }))
      setEmail('')
      setPassword('')
      await onSaved()
      toast.success(r.message)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="panel stack" onSubmit={submit} aria-labelledby="perfil-email">
      <h3 id="perfil-email">E-mail de acesso</h3>
      <p className="muted small">Hoje: <strong>{profile.user.email}</strong>. Para trocar, confirme com a sua senha atual e depois clique no link enviado ao e-mail novo.</p>
      {pending && (
        <p className="notice" role="status">
          Aguardando confirmação: enviamos um link para <strong>{pending}</strong>. Até você clicar, o login continua sendo <strong>{profile.user.email}</strong>.
          Digitou errado? Peça a troca de novo com o e-mail correto.
        </p>
      )}
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
        <button type="submit" disabled={busy || !email || !password}>{busy ? 'Enviando…' : 'Enviar link de confirmação'}</button>
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

// ---------------------------------------------------------------- Verificação em duas etapas

interface MfaStatus {
  available: boolean
  enabled: boolean
  enabled_at: string | null
  recovery_left: number
}

function TwoFactorCard() {
  const [status, setStatus] = useState<MfaStatus | null>(null)
  const [dialog, setDialog] = useState<'setup' | 'disable' | 'codes' | null>(null)
  const [error, setError] = useState('')

  async function load() {
    try {
      setStatus(await request<MfaStatus>('/api/profile/mfa'))
    } catch (e) {
      setError(errorText(e))
    }
  }
  useEffect(() => {
    void load()
  }, [])

  return (
    <div className="panel stack" aria-labelledby="perfil-2fa">
      <h3 id="perfil-2fa">Verificação em duas etapas</h3>
      {error && <Alert>{error}</Alert>}
      {!status ? (
        !error && <Loading label="Carregando…" />
      ) : (
        <>
          <p className="muted small">
            Além da senha, o login pede um código de 6 dígitos do aplicativo autenticador (Google Authenticator, Authy, 1Password…). Protege a conta mesmo se a senha vazar.
          </p>
          {status.enabled ? (
            <>
              <p>
                <span className="badge badge-ok">Ativa</span>{' '}
                <span className="muted small">desde {status.enabled_at ? date(status.enabled_at) : '—'} · {status.recovery_left} código(s) de recuperação restante(s)</span>
              </p>
              {status.recovery_left <= 2 && <p className="notice" role="status">Poucos códigos de recuperação restantes. Gere novos.</p>}
              <div className="actions">
                <button onClick={() => setDialog('codes')}>Gerar novos códigos</button>
                <button className="danger" onClick={() => setDialog('disable')}>Desativar</button>
              </div>
            </>
          ) : status.available ? (
            <>
              <p><span className="badge">Desativada</span></p>
              <div className="actions">
                <button className="primary" onClick={() => setDialog('setup')}>Ativar verificação em duas etapas</button>
              </div>
            </>
          ) : (
            <p className="notice" role="status">Indisponível neste servidor: falta configurar <code>INTEGRATIONS_SECRET</code> (guarda o segredo cifrado).</p>
          )}
        </>
      )}
      {dialog === 'setup' && <SetupMfaModal onClose={() => { setDialog(null); void load() }} />}
      {dialog === 'disable' && <MfaActionModal mode="disable" onClose={() => { setDialog(null); void load() }} />}
      {dialog === 'codes' && <MfaActionModal mode="codes" onClose={() => { setDialog(null); void load() }} />}
    </div>
  )
}

function RecoveryCodes({ codes }: { codes: string[] }) {
  function download() {
    const blob = new Blob([`Códigos de recuperação do Ethos (cada um vale uma vez)\n\n${codes.join('\n')}\n`], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'codigos-recuperacao-ethos.txt'
    a.click()
    URL.revokeObjectURL(a.href)
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(codes.join('\n'))
      toast.success('Códigos copiados.')
    } catch {
      toast.error('Não foi possível copiar. Selecione e copie manualmente.')
    }
  }
  return (
    <div className="stack">
      <p className="notice" role="status">Guarde estes códigos num lugar seguro. Cada um vale <strong>uma vez</strong> e <strong>não será mostrado de novo</strong>. Se perder o celular, são a sua saída.</p>
      <ul className="recovery-codes" aria-label="Códigos de recuperação">
        {codes.map((c) => <li key={c}><code>{c}</code></li>)}
      </ul>
      <div className="actions">
        <button type="button" onClick={copy}>Copiar</button>
        <button type="button" onClick={download}>Baixar .txt</button>
      </div>
    </div>
  )
}

function SetupMfaModal({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<'password' | 'scan' | 'done'>('password')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [secret, setSecret] = useState('')
  const [qr, setQr] = useState('')
  const [codes, setCodes] = useState<string[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function start(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const r = await request<{ secret: string; uri: string }>('/api/profile/mfa/setup', json('POST', { password }))
      setSecret(r.secret)
      setQr(await QRCode.toString(r.uri, { type: 'svg', margin: 1, width: 200 }))
      setPassword('')
      setStep('scan')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function confirm(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const r = await request<{ recovery_codes: string[] }>('/api/profile/mfa/enable', json('POST', { code }))
      setCodes(r.recovery_codes)
      setStep('done')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Ativar verificação em duas etapas" size="sm" onClose={onClose} locked={step === 'done'}>
      {step === 'password' && (
        <form className="stack" onSubmit={start}>
          <p className="muted small">Confirme a sua senha para começar.</p>
          <label>
            Senha atual
            <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" aria-label="Senha atual" />
          </label>
          {error && <Alert>{error}</Alert>}
          <div className="actions">
            <button type="button" onClick={onClose}>Cancelar</button>
            <button type="submit" className="primary" disabled={busy || !password}>Continuar</button>
          </div>
        </form>
      )}
      {step === 'scan' && (
        <form className="stack" onSubmit={confirm}>
          <p className="muted small">1. No aplicativo autenticador, escaneie o QR code (ou digite a chave).</p>
          <div className="qr-box" role="img" aria-label="QR code para o aplicativo autenticador" dangerouslySetInnerHTML={{ __html: qr }} />
          <p className="small">Chave manual: <code className="access-code" style={{ fontSize: '0.95rem', letterSpacing: '0.08em' }}>{secret.match(/.{1,4}/g)?.join(' ')}</code></p>
          <p className="muted small">2. Digite o código de 6 dígitos que o aplicativo mostra agora.</p>
          <label>
            Código
            <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={7} required aria-label="Código de 6 dígitos" />
          </label>
          {error && <Alert>{error}</Alert>}
          <div className="actions">
            <button type="button" onClick={onClose}>Cancelar</button>
            <button type="submit" className="primary" disabled={busy || code.replace(/\s/g, '').length !== 6}>Ativar</button>
          </div>
        </form>
      )}
      {step === 'done' && (
        <div className="stack">
          <p><span className="badge badge-ok">Ativada</span> Da próxima vez que entrar, o código será pedido.</p>
          <RecoveryCodes codes={codes} />
          <div className="actions"><button className="primary" onClick={onClose}>Guardei os códigos</button></div>
        </div>
      )}
    </Modal>
  )
}

function MfaActionModal({ mode, onClose }: { mode: 'disable' | 'codes'; onClose: () => void }) {
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [codes, setCodes] = useState<string[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (mode === 'disable') {
        await request('/api/profile/mfa/disable', json('POST', { password, code }))
        toast.success('Verificação em duas etapas desativada.')
        onClose()
      } else {
        setCodes((await request<{ recovery_codes: string[] }>('/api/profile/mfa/recovery-codes', json('POST', { password, code }))).recovery_codes)
      }
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={mode === 'disable' ? 'Desativar verificação em duas etapas' : 'Gerar novos códigos de recuperação'} size="sm" onClose={onClose} locked={!!codes}>
      {codes ? (
        <div className="stack">
          <RecoveryCodes codes={codes} />
          <p className="muted small">Os códigos anteriores deixaram de valer.</p>
          <div className="actions"><button className="primary" onClick={onClose}>Guardei os códigos</button></div>
        </div>
      ) : (
        <form className="stack" onSubmit={submit}>
          <p className="muted small">Confirme com a sua senha e um código atual (do aplicativo ou de recuperação).</p>
          <label>
            Senha atual
            <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" aria-label="Senha atual" />
          </label>
          <label>
            Código
            <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" maxLength={20} required aria-label="Código de verificação" />
          </label>
          {error && <Alert>{error}</Alert>}
          <div className="actions">
            <button type="button" onClick={onClose}>Cancelar</button>
            <button type="submit" className={mode === 'disable' ? 'danger' : 'primary'} disabled={busy || !password || !code.trim()}>
              {mode === 'disable' ? 'Desativar' : 'Gerar códigos'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------- Aparelhos

interface DeviceSession {
  ref: string
  current: boolean
  device: string
  ip: string | null
  organization: string
  created_at: string
  last_seen_at: string
}

function SessionsCard({ profile }: { profile: Profile }) {
  const [items, setItems] = useState<DeviceSession[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function load() {
    try {
      setItems((await request<{ items: DeviceSession[] }>('/api/profile/sessions')).items)
    } catch (e) {
      setError(errorText(e))
    }
  }
  useEffect(() => {
    void load()
  }, [])

  async function endOthers() {
    setBusy(true)
    try {
      const r = await request<{ ended: number }>('/api/profile/sessions/logout-others', json('POST'))
      toast.success(r.ended === 0 ? 'Não havia outras sessões abertas.' : `${r.ended} sessão(ões) encerrada(s).`)
      await load()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  async function end(s: DeviceSession) {
    if (!(await ask(`Encerrar a sessão de ${s.device}?`, { title: 'Encerrar sessão', confirmLabel: 'Encerrar', danger: true }))) return
    try {
      await request(`/api/profile/sessions/${s.ref}`, { method: 'DELETE' })
      toast.success('Sessão encerrada.')
      await load()
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  return (
    <div className="panel stack">
      <h3>Aparelhos conectados</h3>
      <p className="muted small">Se você reconhece todos, está tudo certo. Entrou em um computador que não é seu? Encerre a sessão dele.</p>
      {error && <Alert>{error}</Alert>}
      {!items ? (
        !error && <Loading label="Carregando…" />
      ) : (
        <ul className="plain-list device-list">
          {items.map((s) => (
            <li key={s.ref}>
              <div>
                <strong>{s.device}</strong> {s.current && <span className="badge badge-ok">este aparelho</span>}
                <div className="muted small">
                  {s.organization}{s.ip ? ` · IP ${s.ip}` : ''} · último uso {dateTime(s.last_seen_at)} · entrou em {dateTime(s.created_at)}
                </div>
              </div>
              {!s.current && <button onClick={() => end(s)} aria-label={`Encerrar sessão de ${s.device}`}>Encerrar</button>}
            </li>
          ))}
        </ul>
      )}
      <div className="actions">
        <button onClick={endOthers} disabled={busy || (items?.length ?? 0) < 2}>{busy ? 'Encerrando…' : 'Encerrar todas as outras'}</button>
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

// ---------------------------------------------------------------- Privacidade (LGPD)

function PrivacyCard({ onClosed }: { onClosed: () => void }) {
  const [busy, setBusy] = useState(false)
  const [closing, setClosing] = useState(false)

  async function exportData() {
    setBusy(true)
    try {
      const res = await fetch('/api/profile/export')
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Não foi possível exportar agora.')
      const blob = await res.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = 'meus-dados-ethos.json'
      a.click()
      URL.revokeObjectURL(a.href)
      toast.success('Arquivo gerado.')
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel stack" aria-labelledby="perfil-privacidade">
      <h3 id="perfil-privacidade">Seus dados e privacidade</h3>
      <p className="muted small">
        Você pode baixar uma cópia dos seus dados pessoais ou encerrar a conta. Os registros da administradora (contratos, cobranças, recibos)
        pertencem a ela e são guardados conforme a lei; para esses, fale com a administradora.
      </p>
      <div className="actions">
        <button onClick={exportData} disabled={busy}>{busy ? 'Gerando…' : 'Baixar meus dados (.json)'}</button>
        <button className="danger" onClick={() => setClosing(true)}>Encerrar minha conta</button>
      </div>
      {closing && <CloseAccountModal onClose={() => setClosing(false)} onDone={onClosed} />}
    </div>
  )
}

function CloseAccountModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await request('/api/profile/delete', json('POST', { password, confirm, code: code || undefined }))
      toast.success('Conta encerrada.')
      onDone()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Encerrar minha conta" size="sm" onClose={onClose} locked={busy}>
      <form className="stack" onSubmit={submit}>
        <p className="notice" role="status">
          Isto apaga o seu login, nome, contatos, documento, foto e notificações, e <strong>não pode ser desfeito</strong>. O histórico de atividades da
          administradora é preservado por obrigação legal.
        </p>
        <label>
          Senha atual
          <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" aria-label="Senha atual" />
        </label>
        <label>
          Código da verificação em duas etapas <span className="muted">(se estiver ativa)</span>
          <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" maxLength={20} aria-label="Código de verificação" />
        </label>
        <label>
          Digite EXCLUIR para confirmar
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" required />
        </label>
        {error && <Alert>{error}</Alert>}
        <div className="actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="submit" className="danger" disabled={busy || !password || confirm !== 'EXCLUIR'}>Encerrar conta</button>
        </div>
      </form>
    </Modal>
  )
}
