import { Alert, toast } from './feedback'
import { FormModal, type FieldSpec } from './kit'

/** Dados que faltam para gerar o contrato, preenchidos sem sair da tela dele. */

export interface MissingData {
  message: string
  unresolved: string[]
  fixes: { id: string; section: string; label: string; input: 'text' | 'email' | 'number' | 'money' | 'select' | 'multi'; options?: { value: string; label: string }[]; hint?: string; adminOnly?: boolean }[]
}

export default function MissingDataPanel({ data, isAdmin, open, onOpen, onClose, onSave }: {
  data: MissingData
  isAdmin: boolean
  open: boolean
  onOpen: () => void
  onClose: () => void
  /** Grava e devolve o aviso a mostrar. */
  onSave: (values: Record<string, unknown>) => Promise<string>
}) {
  const allowed = data.fixes.filter((f) => isAdmin || !f.adminOnly)
  const blocked = data.fixes.filter((f) => !isAdmin && f.adminOnly)
  const notes = [...data.unresolved, ...(blocked.length ? [`Peça ao administrador para preencher os dados da empresa: ${blocked.map((f) => f.label).join(', ')}.`] : [])]

  // Mantém os campos do mesmo grupo juntos, na ordem em que os grupos aparecem.
  const sections = [...new Set(allowed.map((f) => f.section))]
  const fields: FieldSpec[] = sections.flatMap((section) =>
    allowed.filter((f) => f.section === section).map((f): FieldSpec => {
      const base = { name: f.id, label: f.label, section, hint: f.hint }
      if (f.input === 'select' || f.input === 'multi') return { ...base, type: f.input, options: f.options ?? [] }
      return { ...base, type: f.input }
    }),
  )

  return (
    <div className="stack" role="alert">
      <Alert>
        {allowed.length > 0 ? `Faltam ${allowed.length} informação(ões) para gerar o contrato.` : 'Faltam dados para gerar o contrato.'}
      </Alert>
      {notes.length > 0 && <ul className="plain-list small">{notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      {allowed.length > 0 ? (
        <div>
          <button type="button" className="primary" onClick={onOpen}>Preencher agora</button>
        </div>
      ) : (
        <p className="muted small">{data.message}</p>
      )}
      {open && allowed.length > 0 && (
        <FormModal
          key={allowed.map((f) => f.id).join('|')}
          title="Completar dados do contrato"
          size="lg"
          submitLabel="Salvar e pré-visualizar"
          fields={fields}
          intro={
            <>
              <p className="muted small">O que você preencher fica salvo no cadastro (pessoa, unidade, empresa ou contrato). Pode preencher uma parte agora: o que faltar aparece de novo.</p>
              {notes.length > 0 && <ul className="plain-list small">{notes.map((n) => <li key={n}>{n}</li>)}</ul>}
            </>
          }
          onSubmit={async (body) => {
            const values = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== '' && v !== null && !(Array.isArray(v) && v.length === 0)))
            toast.success(await onSave(values))
          }}
          onClose={onClose}
        />
      )}
    </div>
  )
}
