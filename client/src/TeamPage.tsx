import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, ROLE_LABELS, type Invitation, type Item, type Member, type Role } from './api'
import { Alert, Toast, Loading, ask, toast } from './feedback'
import Modal from './Modal'
import PasswordInput from './PasswordInput'

const ROLES = Object.keys(ROLE_LABELS) as Role[]

const message = (e: unknown) => (e instanceof Error ? e.message : 'Erro inesperado')

export default function TeamPage({ currentUserId }: { currentUserId: number }) {
  const [members, setMembers] = useState<Member[]>([])
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [link, setLink] = useState<{ label: string; url: string } | null>(null)
  const [resetting, setResetting] = useState<Member | null>(null)
  const [inviting, setInviting] = useState(false)
  const [viewing, setViewing] = useState<Member | null>(null)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('colaborador')
  const [tenants, setTenants] = useState<Item[]>([])
  const [owners, setOwners] = useState<Item[]>([])
  const [linkId, setLinkId] = useState('')

  const load = useCallback(async () => {
    try {
      const [m, i, t, o] = await Promise.all([api.members(), api.invitations(), api.list('tenants'), api.list('owners')])
      setMembers(m.members)
      setInvitations(i.invitations)
      setTenants(t.items)
      setOwners(o.items)
    } catch (e) {
      setError(message(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function run(action: () => Promise<void>) {
    setError('')
    setNotice('')
    try {
      await action()
    } catch (e) {
      setError(message(e))
    }
  }

  const invite = (e: FormEvent) => {
    e.preventDefault()
    return run(async () => {
      const linkBody =
        role === 'inquilino' ? { tenantId: Number(linkId) } : role === 'proprietario' ? { ownerId: Number(linkId) } : undefined
      const r = await api.createInvitation(email, role, linkBody)
      setLink({ label: `Convite para ${r.invitation.email}`, url: r.link })
      setEmail('')
      setLinkId('')
      setInviting(false)
      await load()
    })
  }

  const resetByEmail = (m: Member) =>
    run(async () => {
      await api.memberPasswordReset(m.id, 'email')
      setNotice(`E-mail de redefinição enviado para ${m.email}.`)
    })

  const resetByLink = (m: Member) =>
    run(async () => {
      const r = await api.memberPasswordReset(m.id, 'link')
      setLink({ label: `Link de redefinição de ${m.name}`, url: r.link! })
    })

  const changeRole = (m: Member, next: Role) =>
    run(async () => {
      await api.setMemberRole(m.id, next)
      await load()
    })

  const resetMfa = async (m: Member) => {
    if (!(await ask(`Desativar a verificação em duas etapas de ${m.name}? Ela entrará só com a senha e poderá configurar de novo. As outras sessões dela serão encerradas.`, { title: 'Redefinir 2FA', confirmLabel: 'Desativar 2FA', danger: true }))) return
    return run(async () => {
      await api.memberMfaReset(m.id)
      setNotice(`Verificação em duas etapas de ${m.name} desativada.`)
    })
  }

  const remove = async (m: Member) => {
    if (!(await ask(`Remover ${m.name} da organização? Ele perde o acesso imediatamente.`))) return
    return run(async () => {
      await api.removeMember(m.id)
      await load()
    })
  }

  const revoke = (i: Invitation) =>
    run(async () => {
      await api.revokeInvitation(i.id)
      await load()
    })

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setNotice('Link copiado.')
    } catch {
      setNotice('Não foi possível copiar automaticamente; selecione e copie o link.')
    }
  }

  return (
    <section>
      <div className="page-head">
        <h2>Equipe</h2>
        <button className="primary" onClick={() => setInviting(true)}>Convidar pessoa</button>
      </div>

      {error && <Alert>{error}</Alert>}
      {notice && <Toast>{notice}</Toast>}

      {link && (
        <Modal title={link.label} size="sm" onClose={() => setLink(null)}>
        <div className="link-box">
          <p className="muted">
            Quem tiver este link acessa a conta/convite. Envie apenas à pessoa certa — ele não será exibido de novo.
          </p>
          <input readOnly value={link.url} aria-label={link.label} onFocus={(e) => e.currentTarget.select()} />
          <div className="actions">
            <button onClick={() => setLink(null)}>Fechar</button>
            <button className="primary" onClick={() => copy(link.url)}>
              Copiar link
            </button>
          </div>
        </div>
        </Modal>
      )}

      {inviting && (
      <Modal title="Convidar pessoa" onClose={() => setInviting(false)}>
      <form className="form-grid" onSubmit={invite}>
        <label>
          E-mail
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Papel
          <select
            value={role}
            onChange={(e) => {
              setRole(e.target.value as Role)
              setLinkId('')
            }}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
        {(role === 'inquilino' || role === 'proprietario') && (
          <label>
            {role === 'inquilino' ? 'Cadastro do inquilino' : 'Cadastro do proprietário'}
            <select value={linkId} onChange={(e) => setLinkId(e.target.value)} required>
              <option value="">Selecione quem é</option>
              {(role === 'inquilino' ? tenants : owners).map((p) => (
                <option key={p.id} value={p.id}>
                  {String(p.name)}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="muted small span-all">
          {role === 'inquilino' || role === 'proprietario'
            ? 'Clientes acessam a área do cliente e enxergam apenas os dados ligados a este cadastro.'
            : 'Administradores e colaboradores acessam o painel da organização.'}
        </p>
        <div className="actions">
          <button type="submit" className="primary">
            Gerar convite
          </button>
        </div>
      </form>
      </Modal>
      )}

      {loading ? (
        <Loading label="Carregando…" />
      ) : (
        <>
          <h3>Membros</h3>
          <div className="panel table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>E-mail</th>
                  <th>Papel</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id}>
                    <td>{m.name}</td>
                    <td>{m.email}</td>
                    <td>
                      {m.role === 'inquilino' || m.role === 'proprietario' ? (
                        // Clientes têm vínculo com um cadastro: para mudar, remova e convide de novo.
                        <span>
                          {ROLE_LABELS[m.role]}
                          {m.linked_name ? <span className="muted"> · {m.linked_name}</span> : <span className="error"> · sem vínculo</span>}
                        </span>
                      ) : (
                        <select
                          aria-label={`Papel de ${m.name}`}
                          value={m.role}
                          onChange={(e) => changeRole(m, e.target.value as Role)}
                        >
                          {(['admin', 'colaborador'] as Role[]).map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABELS[r]}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="row-actions">
                      <button onClick={() => setViewing(m)}>Ver</button>
                      <button onClick={() => setResetting(m)}>Redefinir senha</button>
                      <button onClick={() => resetMfa(m)}>Redefinir 2FA</button>
                      {m.id !== currentUserId && (
                        <button className="danger" onClick={() => remove(m)}>
                          Remover
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>Convites pendentes</h3>
          {invitations.length === 0 ? (
            <p className="empty">Nenhum convite pendente.</p>
          ) : (
            <div className="panel table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>E-mail</th>
                    <th>Papel</th>
                    <th>Expira em</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {invitations.map((i) => (
                    <tr key={i.id}>
                      <td>{i.email}</td>
                      <td>{ROLE_LABELS[i.role]}</td>
                      <td>{new Date(i.expires_at).toLocaleDateString('pt-BR')}</td>
                      <td className="row-actions">
                        <button className="danger" onClick={() => revoke(i)}>
                          Revogar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {viewing && (
        <Modal
          title={viewing.name}
          subtitle={ROLE_LABELS[viewing.role]}
          size="sm"
          onClose={() => setViewing(null)}
          footer={
            <>
              <button onClick={() => setViewing(null)}>Fechar</button>
              <button
                className="primary"
                onClick={() => {
                  const m = viewing
                  setViewing(null)
                  setResetting(m)
                }}
              >
                Redefinir senha
              </button>
            </>
          }
        >
          <dl className="view-grid">
            <div className="wide"><dt>E-mail</dt><dd>{viewing.email}</dd></div>
            <div><dt>Papel</dt><dd>{ROLE_LABELS[viewing.role]}</dd></div>
            <div><dt>Vínculo</dt><dd>{viewing.linked_name ?? '—'}</dd></div>
          </dl>
        </Modal>
      )}

      {resetting && (
        <ResetPasswordDialog
          member={resetting}
          onClose={() => setResetting(null)}
          onEmail={() => {
            const m = resetting
            setResetting(null)
            return resetByEmail(m)
          }}
          onLink={() => {
            const m = resetting
            setResetting(null)
            return resetByLink(m)
          }}
        />
      )}
    </section>
  )
}

/** Redefinição pela tela: o admin escolhe entre e-mail, link ou definir a senha agora (digitada ou gerada). */
function ResetPasswordDialog({ member, onClose, onEmail, onLink }: { member: Member; onClose: () => void; onEmail: () => void; onLink: () => void }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [created, setCreated] = useState<string | null>(null)

  async function setNow(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (password && password.length < 8) return setError('A senha deve ter pelo menos 8 caracteres.')
    setBusy(true)
    try {
      const r = await api.memberPasswordReset(member.id, 'password', password || undefined)
      if (r.password) setCreated(r.password)
      else {
        toast.success(`Senha de ${member.name} alterada. As sessões dela foram encerradas.`)
        onClose()
      }
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={`Redefinir senha de ${member.name}`} size="sm" onClose={onClose}>
      <div>
        {created ? (
          <>
            <p>Senha temporária criada. <strong>Ela só aparece agora</strong>: passe para {member.name} por um canal seguro e peça que a troque.</p>
            <div className="secret-box">
              <code>{created}</code>
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(created)
                    toast.success('Senha copiada.')
                  } catch {
                    toast.error('Não foi possível copiar. Selecione e copie manualmente.')
                  }
                }}
              >
                Copiar
              </button>
            </div>
            <div className="modal-actions"><button className="primary" onClick={onClose}>Concluir</button></div>
          </>
        ) : (
          <>
            <p>Escolha como redefinir. Nos três casos as sessões abertas da pessoa deixam de valer assim que a nova senha é usada.</p>
            <form onSubmit={setNow} className="reset-box">
              <strong>Definir a senha agora</strong>
              <span className="muted small">Digite uma senha ou deixe em branco para gerar uma temporária.</span>
              <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Nova senha (mín. 8 caracteres)" autoComplete="new-password" />
              {error && <Alert>{error}</Alert>}
              <button className="primary" disabled={busy}>{busy ? 'Salvando…' : password ? 'Definir esta senha' : 'Gerar senha temporária'}</button>
            </form>
            <div className="reset-alt">
              <button onClick={onEmail}>Enviar link por e-mail</button>
              <button onClick={onLink}>Gerar link para copiar</button>
            </div>
            <div className="modal-actions"><button onClick={onClose}>Cancelar</button></div>
          </>
        )}
      </div>
    </Modal>
  )
}
