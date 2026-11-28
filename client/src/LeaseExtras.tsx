import { useState } from 'react'
import { request } from './api'
import { Alert, ask, errorText, toast } from './feedback'
import { FormModal, Loaded, Table, dateOnly, download, json, money, useLoad, type FieldSpec } from './kit'
import Modal from './Modal'

/** Contrato: aditivos (renovação/reajuste), rescisão guiada, garantias e coleta de assinaturas dos documentos. */

interface Addendum { id: number; kind: string; effective_from: string; new_end: string | null; new_rent_cents: number | null; previous_rent_cents: number; index_name: string | null; index_percent: number | null; content: string; applied_at: string | null }
interface Guarantee { id: number; kind: string; status: string; amount_cents: number | null; valid_until: string | null; details: Record<string, string> }

const KIND = { renovacao: 'Renovação', reajuste: 'Reajuste', aditivo: 'Aditivo' } as Record<string, string>
const G_KIND = { fiador: 'Fiador', caucao: 'Caução', seguro_fianca: 'Seguro-fiança', titulo_capitalizacao: 'Título de capitalização', outro: 'Outra' } as Record<string, string>

export default function LeaseExtras({ leaseId, status, isAdmin, onChanged }: { leaseId: number; status: string; isAdmin: boolean; onChanged: () => void }) {
  const add = useLoad(() => request<{ items: Addendum[] }>(`/api/leases/${leaseId}/addenda`), [leaseId])
  const gar = useLoad(() => request<{ items: Guarantee[] }>(`/api/leases/${leaseId}/guarantees`), [leaseId])
  const [dlg, setDlg] = useState<'addendum' | 'terminate' | 'guarantee' | null>(null)
  const [viewing, setViewing] = useState<Addendum | null>(null)
  const [editGar, setEditGar] = useState<Guarantee | null>(null)

  async function removeGuarantee(g: Guarantee) {
    if (!(await ask(`Excluir a garantia "${G_KIND[g.kind]}"?`, { confirmLabel: 'Excluir', danger: true }))) return
    try {
      await request(`/api/guarantees/${g.id}`, { method: 'DELETE' })
      await gar.reload()
    } catch (e) {
      toast.error(errorText(e))
    }
  }

  return (
    <div className="panel no-print stack">
      <h3>Aditivos, garantias e rescisão</h3>
      <div className="actions left">
        {status === 'vigente' && <button className="primary" onClick={() => setDlg('addendum')}>Renovar / reajustar / aditivo</button>}
        <button onClick={() => setDlg('guarantee')}>Cadastrar garantia</button>
        {status === 'vigente' && <button className="danger" onClick={() => setDlg('terminate')}>Rescindir (guiado)</button>}
      </div>

      <h4>Aditivos</h4>
      <Loaded state={add}>
        {(d) => (
          <Table rows={d.items} empty="Nenhum aditivo." onRow={setViewing} cols={[
            { head: 'Tipo', cell: (a) => KIND[a.kind] ?? a.kind },
            { head: 'Vigência', cell: (a) => (a.applied_at ? dateOnly(a.effective_from) : `agendado p/ ${dateOnly(a.effective_from)}`) },
            { head: 'Novo prazo', cell: (a) => dateOnly(a.new_end) },
            { head: 'Aluguel', cell: (a) => (a.new_rent_cents ? `${money(a.previous_rent_cents)} → ${money(a.new_rent_cents)}${a.index_percent !== null ? ` (${a.index_percent}%)` : ''}` : '—') },
          ]} />
        )}
      </Loaded>

      <h4>Garantias</h4>
      <Loaded state={gar}>
        {(d) => (
          <Table rows={d.items} empty="Nenhuma garantia cadastrada." cols={[
            { head: 'Tipo', cell: (g) => G_KIND[g.kind] ?? g.kind },
            { head: 'Detalhes', cell: (g) => Object.entries(g.details).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · ') || '—' },
            { head: 'Valor', cell: (g) => money(g.amount_cents), className: 'num' },
            { head: 'Vence', cell: (g) => dateOnly(g.valid_until) },
            { head: 'Situação', cell: (g) => g.status },
            { head: '', cell: (g) => <span className="row-actions"><button onClick={() => setEditGar(g)}>Editar</button>{isAdmin && <button onClick={() => removeGuarantee(g)}>Excluir</button>}</span> },
          ]} />
        )}
      </Loaded>

      {dlg === 'addendum' && <AddendumModal leaseId={leaseId} onClose={() => setDlg(null)} onDone={() => { void add.reload(); onChanged() }} />}
      {dlg === 'terminate' && <TerminateModal leaseId={leaseId} onClose={() => setDlg(null)} onDone={() => { setDlg(null); onChanged() }} />}
      {dlg === 'guarantee' && <GuaranteeModal leaseId={leaseId} onClose={() => setDlg(null)} onDone={() => void gar.reload()} />}
      {editGar && <GuaranteeModal leaseId={leaseId} guarantee={editGar} onClose={() => setEditGar(null)} onDone={() => void gar.reload()} />}
      {viewing && (
        <Modal title={`${KIND[viewing.kind]} (minuta)`} size="md" onClose={() => setViewing(null)} footer={<button onClick={() => window.print()}>Imprimir / salvar PDF</button>}>
          <article className="paper" style={{ whiteSpace: 'pre-wrap' }}>{viewing.content}</article>
        </Modal>
      )}
    </div>
  )
}

function AddendumModal({ leaseId, onClose, onDone }: { leaseId: number; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<'renovacao' | 'reajuste' | 'aditivo'>('reajuste')
  const [pct, setPct] = useState<string>('')
  const [indexName, setIndexName] = useState('')
  const [info, setInfo] = useState('')

  async function fetchIndex(index: 'igpm' | 'ipca') {
    setInfo('Consultando o Banco Central…')
    try {
      const r = await request<{ index: string; accumulated_percent: number; from: string; to: string }>(`/api/indices/accumulated?index=${index}&months=12`)
      setPct(String(r.accumulated_percent))
      setIndexName(r.index)
      setInfo(`${r.index} acumulado em 12 meses (${r.from} a ${r.to}): ${r.accumulated_percent}%. Confira com o que o contrato prevê.`)
    } catch (e) {
      setInfo(errorText(e))
    }
  }

  const fields: FieldSpec[] = [
    ...(kind !== 'reajuste' ? [{ name: 'new_end_date', label: 'Novo fim do contrato', type: 'date' as const, required: kind === 'renovacao' }] : []),
    ...(kind !== 'renovacao' ? [
      { name: 'index_percent', label: 'Reajuste (%)', type: 'number' as const, hint: 'Ex.: 4,5. Ou informe o novo valor abaixo.' },
      { name: 'new_rent_cents', label: 'Novo aluguel', type: 'money' as const },
    ] : [{ name: 'new_rent_cents', label: 'Novo aluguel (opcional)', type: 'money' as const }]),
    { name: 'effective_from', label: 'Vale a partir de', type: 'date', hint: 'Vazio = hoje. Data futura fica agendada.' },
    { name: 'notes', label: 'Observações', type: 'textarea' },
  ]
  return (
    <FormModal
      key={`${kind}-${pct}`}
      title="Aditivo do contrato"
      submitLabel="Emitir aditivo"
      size="md"
      initial={{ index_percent: pct }}
      fields={fields}
      intro={
        <>
          <label>Tipo
            <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="reajuste">Reajuste do aluguel</option>
              <option value="renovacao">Renovação (novo prazo)</option>
              <option value="aditivo">Outro aditivo (prazo e/ou aluguel)</option>
            </select>
          </label>
          {kind !== 'renovacao' && (
            <div className="actions left">
              <button type="button" onClick={() => fetchIndex('igpm')}>Usar IGP-M 12 meses</button>
              <button type="button" onClick={() => fetchIndex('ipca')}>Usar IPCA 12 meses</button>
            </div>
          )}
          {info && <p className="notice" role="status">{info}</p>}
        </>
      }
      onSubmit={async (b) => {
        const body: Record<string, unknown> = { ...b, kind }
        if (indexName && b.index_percent !== undefined) body.index_name = indexName
        const r = await request<{ applied: boolean }>(`/api/leases/${leaseId}/addenda`, json('POST', body))
        toast.success(r.applied ? 'Aditivo em vigor. O inquilino foi avisado.' : 'Aditivo agendado: entra em vigor na data escolhida.')
        onDone()
      }}
      onClose={onClose}
    />
  )
}

interface Breakdown { total_days: number; remaining_days: number; rent_cents: number; fine_months: number; fine_base_cents: number; fine_cents: number; open_future_charges: number; notes: string[] }

function TerminateModal({ leaseId, onClose, onDone }: { leaseId: number; onClose: () => void; onDone: () => void }) {
  const [date, setDate] = useState(new Date().toLocaleDateString('sv-SE'))
  const [months, setMonths] = useState('3')
  const [reason, setReason] = useState('')
  const [waive, setWaive] = useState(false)
  const [cancelFuture, setCancelFuture] = useState(true)
  const [b, setB] = useState<Breakdown | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function calc() {
    setBusy(true)
    setError('')
    try {
      setB(await request<Breakdown>(`/api/leases/${leaseId}/terminate/preview`, json('POST', { date, fine_months: Number(months) })))
    } catch (e) {
      setB(null)
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  async function confirm() {
    if (!(await ask('Rescindir o contrato? A unidade ficará disponível e isto não pode ser desfeito.', { title: 'Rescindir contrato', confirmLabel: 'Rescindir', danger: true }))) return
    setBusy(true)
    try {
      const r = await request<{ cancelled_charges: number; fine_charge_id: number | null }>(`/api/leases/${leaseId}/terminate`, json('POST', { date, fine_months: Number(months), reason, waive_fine: waive, cancel_future_charges: cancelFuture }))
      toast.success(`Contrato rescindido.${r.fine_charge_id ? ' Multa lançada em Financeiro.' : ''}${r.cancelled_charges ? ` ${r.cancelled_charges} aluguel(éis) futuro(s) cancelado(s).` : ''}`)
      onDone()
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  return (
    <Modal title="Rescisão guiada" size="md" onClose={onClose} locked={busy}>
      <div className="stack">
        <div className="form-grid">
          <label>Data da rescisão<input type="date" value={date} onChange={(e) => { setDate(e.target.value); setB(null) }} /></label>
          <label>Multa prevista no contrato (nº de aluguéis)<input type="number" min={0} max={12} step="0.5" value={months} onChange={(e) => { setMonths(e.target.value); setB(null) }} /></label>
          <label className="wide">Motivo<input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></label>
        </div>
        {error && <Alert>{error}</Alert>}
        <div className="actions"><button onClick={calc} disabled={busy}>Calcular</button></div>
        {b && (
          <>
            <dl className="view-grid">
              <div><dt>Prazo do contrato</dt><dd>{b.total_days} dias</dd></div>
              <div><dt>Faltavam</dt><dd>{b.remaining_days} dias</dd></div>
              <div><dt>Multa prevista</dt><dd>{money(b.fine_base_cents)} ({b.fine_months} × {money(b.rent_cents)})</dd></div>
              <div><dt>Multa proporcional</dt><dd><strong>{money(b.fine_cents)}</strong></dd></div>
            </dl>
            <ul className="plain-list muted small">{b.notes.map((n) => <li key={n}>{n}</li>)}</ul>
            <label className="check"><input type="checkbox" checked={waive} onChange={(e) => setWaive(e.target.checked)} /> Isentar a multa (não gera cobrança)</label>
            {b.open_future_charges > 0 && <label className="check"><input type="checkbox" checked={cancelFuture} onChange={(e) => setCancelFuture(e.target.checked)} /> Cancelar os {b.open_future_charges} aluguel(éis) com vencimento depois da rescisão (os já pagos ficam)</label>}
            <div className="actions"><button className="danger" onClick={confirm} disabled={busy}>Rescindir contrato</button></div>
          </>
        )}
      </div>
    </Modal>
  )
}

function GuaranteeModal({ leaseId, guarantee, onClose, onDone }: { leaseId: number; guarantee?: Guarantee; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState(guarantee?.kind ?? 'fiador')
  const d = (name: string, label: string, required = false): FieldSpec => ({ name: `d_${name}`, label, required })
  const byKind: Record<string, FieldSpec[]> = {
    fiador: [d('name', 'Nome do fiador', true), d('document', 'CPF/CNPJ', true), d('phone', 'Telefone'), d('email', 'E-mail'), d('address', 'Endereço'), d('rg', 'RG e órgão emissor'), d('nationality', 'Nacionalidade'), d('marital_status', 'Estado civil'), d('profession', 'Profissão')],
    caucao: [{ name: 'amount_cents', label: 'Valor depositado', type: 'money', required: true }, d('months', 'Equivale a quantos aluguéis'), d('account', 'Onde está depositado')],
    seguro_fianca: [d('insurer', 'Seguradora', true), d('policy_number', 'Nº da apólice', true), { name: 'amount_cents', label: 'Cobertura', type: 'money' }, { name: 'valid_until', label: 'Vigência até', type: 'date', required: true }],
    titulo_capitalizacao: [d('issuer', 'Emissora', true), d('number', 'Nº do título', true), { name: 'amount_cents', label: 'Valor', type: 'money' }, { name: 'valid_until', label: 'Vencimento', type: 'date' }],
    outro: [d('description', 'Descrição', true), { name: 'amount_cents', label: 'Valor', type: 'money' }, { name: 'valid_until', label: 'Vence em', type: 'date' }],
  }
  const initial: Record<string, unknown> = { amount_cents: guarantee?.amount_cents, valid_until: guarantee?.valid_until?.slice(0, 10) }
  for (const [k, v] of Object.entries(guarantee?.details ?? {})) initial[`d_${k}`] = v
  const fields: FieldSpec[] = [...byKind[kind]!, ...(guarantee ? [{ name: 'status', label: 'Situação', type: 'select' as const, required: true, options: [{ value: 'ativa', label: 'Ativa' }, { value: 'liberada', label: 'Liberada' }, { value: 'executada', label: 'Executada' }] }] : []), { name: 'notes', label: 'Observações', type: 'textarea' }]
  if (guarantee) initial.status = guarantee.status
  return (
    <FormModal
      key={kind}
      title={guarantee ? 'Editar garantia' : 'Nova garantia'}
      fields={fields}
      initial={initial}
      keepEmpty
      intro={!guarantee && (
        <label>Tipo
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.entries(G_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      )}
      onSubmit={async (b) => {
        const details: Record<string, string> = {}
        const top: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(b)) {
          if (k.startsWith('d_')) { if (v) details[k.slice(2)] = String(v) } else top[k] = v
        }
        if (guarantee) await request(`/api/guarantees/${guarantee.id}`, json('PATCH', { ...top, details }))
        else await request(`/api/leases/${leaseId}/guarantees`, json('POST', { ...top, kind, details }))
        toast.success('Garantia salva.')
        onDone()
      }}
      onClose={onClose}
    />
  )
}

// ------------------------------------------------------------------ Assinaturas

interface SignRequest { id: number; status: string; content_hash: string; created_at: string; completed_at: string | null; signers: { id: number; name: string; email: string | null; role: string; viewed_at: string | null; signed_at: string | null }[] }
interface SignerRow { name: string; email: string; role: string }
const ROLES: Record<string, string> = { locador: 'Locador', locatario: 'Locatário', fiador: 'Fiador', testemunha: 'Testemunha', outro: 'Outro' }

export function SignatureModal({ docId, title, onClose }: { docId: number; title: string; onClose: () => void }) {
  const s = useLoad(() => request<{ item: SignRequest | null }>(`/api/documents/${docId}/signature`), [docId])
  const [rows, setRows] = useState<SignerRow[]>([{ name: '', email: '', role: 'locatario' }])
  const [links, setLinks] = useState<{ name: string; role: string; link: string }[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function start() {
    setBusy(true)
    setError('')
    try {
      const r = await request<{ links: { name: string; role: string; link: string }[]; emailed: number }>(`/api/documents/${docId}/signature`, json('POST', { signers: rows.map((x) => ({ ...x, email: x.email || undefined })) }))
      setLinks(r.links)
      toast.success(`Coleta iniciada${r.emailed ? ` (${r.emailed} e-mail(s) enviado(s))` : ''}.`)
      await s.reload()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  async function cancel() {
    if (!(await ask('Cancelar a coleta? Os links deixam de funcionar.', { confirmLabel: 'Cancelar coleta', danger: true }))) return
    try {
      await request(`/api/documents/${docId}/signature/cancel`, json('POST'))
      setLinks(null)
      await s.reload()
    } catch (e) {
      setError(errorText(e))
    }
  }
  const upd = (i: number, patch: Partial<SignerRow>) => setRows((cur) => cur.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  return (
    <Modal title={`Assinaturas — ${title}`} size="lg" onClose={onClose} locked={busy}>
      <div className="stack">
        <p className="muted small">Assinatura eletrônica <strong>simples</strong>: cada pessoa abre um link, lê o texto, digita o próprio nome e confirma; ficam registrados data, hora e IP. Não é assinatura qualificada (ICP-Brasil).</p>
        {error && <Alert>{error}</Alert>}
        {links && (
          <div className="notice stack" role="status">
            <strong>Links de assinatura (só aparecem agora):</strong>
            {links.map((l) => (
              <div key={l.link} className="inline">
                <span style={{ flex: 1 }}>{l.name} ({ROLES[l.role]})</span>
                <button onClick={() => navigator.clipboard.writeText(l.link).then(() => toast.success('Link copiado.'))}>Copiar link</button>
              </div>
            ))}
          </div>
        )}
        <Loaded state={s}>
          {(d) =>
            d.item && d.item.status !== 'cancelada' ? (
              <>
                <p><span className={d.item.status === 'concluida' ? 'badge badge-ok' : 'badge'}>{d.item.status === 'concluida' ? 'Todas as assinaturas coletadas' : 'Aguardando assinaturas'}</span></p>
                <Table rows={d.item.signers} cols={[
                  { head: 'Nome', cell: (x) => x.name },
                  { head: 'Papel', cell: (x) => ROLES[x.role] },
                  { head: 'Visualizou', cell: (x) => (x.viewed_at ? 'sim' : '—') },
                  { head: 'Assinou', cell: (x) => (x.signed_at ? new Date(x.signed_at).toLocaleString('pt-BR') : 'pendente') },
                ]} />
                <p className="muted small">Hash SHA-256 do texto: <code>{d.item.content_hash}</code></p>
                <div className="actions">
                  {d.item.status === 'pendente' && <button className="danger" onClick={cancel}>Cancelar coleta</button>}
                  {d.item.status === 'concluida' && <button className="primary" onClick={() => download(`/api/documents/${docId}/signature/certificate`, `certificado-assinatura-${docId}.txt`)}>Baixar certificado</button>}
                </div>
              </>
            ) : (
              <>
                <h4>Quem vai assinar</h4>
                {rows.map((r, i) => (
                  <div key={i} className="form-grid">
                    <label>Nome completo<input value={r.name} onChange={(e) => upd(i, { name: e.target.value })} required /></label>
                    <label>E-mail (opcional)<input type="email" value={r.email} onChange={(e) => upd(i, { email: e.target.value })} /></label>
                    <label>Papel<select value={r.role} onChange={(e) => upd(i, { role: e.target.value })}>{Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
                    {rows.length > 1 && <button type="button" onClick={() => setRows((cur) => cur.filter((_, j) => j !== i))}>Remover</button>}
                  </div>
                ))}
                <div className="actions">
                  <button type="button" onClick={() => setRows((cur) => [...cur, { name: '', email: '', role: 'locador' }])} disabled={rows.length >= 8}>+ Signatário</button>
                  <button className="primary" onClick={start} disabled={busy || rows.some((r) => r.name.trim().length < 3)}>Iniciar coleta</button>
                </div>
              </>
            )
          }
        </Loaded>
      </div>
    </Modal>
  )
}
