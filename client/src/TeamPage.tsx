import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, ROLE_LABELS, type Invitation, type Item, type Member, type Role } from './api'
import { Alert, Toast, Loading, ask } from './feedback'

const ROLES = Object.keys(ROLE_LABELS) as Role[]

const message = (e: unknown) => (e instanceof Error ? e.message : 'Erro inesperado')

export default function TeamPage({ currentUserId }: { currentUserId: number }) {
  const [members, setMembers] = useState<Member[]>([])
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [link, setLink] = useState<{ label: string; url: string } | null>(null)
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
      </div>

      {error && <Alert>{error}</Alert>}
      {notice && <Toast>{notice}</Toast>}

      {link && (
        <div className="panel link-box">
          <strong>{link.label}</strong>
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
      )}

      <form className="panel form-grid" onSubmit={invite}>
        <h3>Convidar pessoa</h3>
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
                      <button onClick={() => resetByEmail(m)}>Redefinir senha (e-mail)</button>
                      <button onClick={() => resetByLink(m)}>Gerar link</button>
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
    </section>
  )
}
