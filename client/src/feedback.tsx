import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'

/* ------------------------------------------------------------------------------------------
 * Feedback ao usuário: avisos (toasts), alertas de erro inline, confirmações e carregando.
 * Um só lugar define o tom: erros dizem o que houve e o que fazer; sucessos são curtos.
 * ---------------------------------------------------------------------------------------- */

type Kind = 'success' | 'error' | 'info'
interface ToastItem { id: number; kind: Kind; text: string }

let items: ToastItem[] = []
let nextId = 1
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l))
const snapshot = () => items

function push(kind: Kind, text: string) {
  if (!text) return
  // Efeitos duplicados (StrictMode) ou cliques repetidos não empilham o mesmo aviso.
  if (items.some((t) => t.kind === kind && t.text === text)) return
  items = [...items.slice(-3), { id: nextId++, kind, text }]
  emit()
}
function dismiss(id: number) {
  items = items.filter((t) => t.id !== id)
  emit()
}

export const toast = {
  success: (text: string) => push('success', text),
  error: (text: string) => push('error', text),
  info: (text: string) => push('info', text),
}

/** Texto de um erro qualquer, sempre algo legível. */
export function errorText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : 'Algo deu errado. Tente novamente.'
}

/* ------------------------------------------------------------------------------------------ Confirmação */

interface AskOptions { title?: string; confirmLabel?: string; danger?: boolean }
interface Pending extends AskOptions { message: string; resolve: (ok: boolean) => void }
let pending: Pending | null = null
const askListeners = new Set<() => void>()
const emitAsk = () => askListeners.forEach((l) => l())

const VERBS = ['Excluir', 'Remover', 'Revogar', 'Cancelar', 'Publicar', 'Arquivar', 'Estornar', 'Marcar', 'Encerrar', 'Rescindir', 'Ativar']
const DANGER = /^(excluir|remover|revogar|cancelar|estornar|rescindir)/i

/** Pergunta antes de uma ação destrutiva ou irreversível. Resolve `true` se o usuário confirmar. */
export function ask(message: string, options: AskOptions = {}): Promise<boolean> {
  const verb = message.split(/[\s?]/)[0] ?? ''
  const known = VERBS.find((v) => v.toLowerCase() === verb.toLowerCase())
  pending?.resolve(false)
  return new Promise((resolve) => {
    pending = {
      message,
      resolve,
      title: options.title ?? (DANGER.test(message) ? 'Esta ação não pode ser desfeita' : 'Confirmar ação'),
      confirmLabel: options.confirmLabel ?? known ?? 'Confirmar',
      danger: options.danger ?? DANGER.test(message),
    }
    emitAsk()
  })
}
function answer(ok: boolean) {
  const p = pending
  pending = null
  emitAsk()
  p?.resolve(ok)
}
const subscribeAsk = (l: () => void) => (askListeners.add(l), () => void askListeners.delete(l))

function ConfirmDialog() {
  const p = useSyncExternalStore(subscribeAsk, () => pending)
  const confirmRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!p) return
    const previous = document.activeElement as HTMLElement | null
    confirmRef.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && answer(false)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previous?.focus?.()
    }
  }, [p])
  if (!p) return null
  return (
    <div className="dialog-scrim" onMouseDown={(e) => e.target === e.currentTarget && answer(false)}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dlg-title" aria-describedby="dlg-msg">
        <h3 id="dlg-title">{p.title}</h3>
        <p id="dlg-msg">{p.message}</p>
        <div className="dialog-actions">
          <button onClick={() => answer(false)}>Voltar</button>
          <button ref={confirmRef} className={p.danger ? 'danger solid' : 'primary'} onClick={() => answer(true)}>{p.confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------------------------------ Avisos */

const SYMBOL: Record<Kind, string> = { success: '✓', error: '!', info: 'i' }

function ToastStack() {
  const list = useSyncExternalStore(subscribe, snapshot)
  return (
    <div className="toasts" aria-live="polite">
      {list.map((t) => (
        <ToastCard key={t.id} item={t} />
      ))}
    </div>
  )
}

function ToastCard({ item }: { item: ToastItem }) {
  const timer = useRef<number | undefined>(undefined)
  const start = () => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => dismiss(item.id), item.kind === 'error' ? 9000 : 4500)
  }
  useEffect(() => {
    start()
    return () => window.clearTimeout(timer.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id])
  return (
    <div className={`toast toast-${item.kind}`} role={item.kind === 'error' ? 'alert' : 'status'} onMouseEnter={() => window.clearTimeout(timer.current)} onMouseLeave={start}>
      <span className="toast-icon" aria-hidden="true">{SYMBOL[item.kind]}</span>
      <span className="toast-text">{item.text}</span>
      <button className="toast-close" onClick={() => dismiss(item.id)} aria-label="Fechar aviso">×</button>
    </div>
  )
}

/** Monte uma vez na raiz do app. */
export function FeedbackHost() {
  return (
    <>
      <ToastStack />
      <ConfirmDialog />
    </>
  )
}

/* ------------------------------------------------------------------------------------------ Componentes */

/** Mensagem de erro junto do formulário/lista onde aconteceu. */
export function Alert({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`alert ${className}`.trim()} role="alert">
      <span className="alert-icon" aria-hidden="true">!</span>
      <span>{children}</span>
    </div>
  )
}

/** Substitui o antigo parágrafo de "notice": mostra o texto como aviso de sucesso que some sozinho. */
export function Toast({ children }: { children: ReactNode }) {
  const text = typeof children === 'string' ? children : ''
  useEffect(() => {
    if (text) toast.success(text)
  }, [text])
  return null
}

/** Estado de carregamento com esqueleto (mantém o layout estável e avisa leitores de tela). */
export function Loading({ label = 'Carregando…' }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="skeleton" style={{ width: '38%' }} />
      <span className="skeleton" style={{ width: '92%' }} />
      <span className="skeleton" style={{ width: '76%' }} />
      <span className="sr-only">{label}</span>
    </div>
  )
}

/** Estado vazio com orientação do próximo passo. */
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <p className="muted">{children}</p>}
    </div>
  )
}
