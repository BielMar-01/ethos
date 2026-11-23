import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Janela modal padrão do sistema: TODA criação, edição, visualização e detalhe abre aqui.
 *  - Computador/tablet: cartão centralizado com rolagem interna; celular: tela cheia (folha), com área segura e rodapé fixo.
 *  - Esc e clique no fundo fecham (a não ser que `locked`); o foco fica preso dentro e volta ao botão de origem.
 *  - A rolagem da página de trás é travada; vários modais empilham (o último fica por cima).
 *  - Impressão: o modal vira a própria página (a tela de trás some) para imprimir contratos, laudos e recibos.
 */

let openCount = 0

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl'

export default function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  size = 'md',
  locked = false,
}: {
  /** Título na barra superior. Omita quando o conteúdo já traz o próprio cabeçalho. */
  title?: ReactNode
  subtitle?: ReactNode
  onClose: () => void
  children: ReactNode
  /** Botões fixos no rodapé (opcional: formulários costumam trazer os seus). */
  footer?: ReactNode
  size?: ModalSize
  /** Impede fechar por Esc/fundo (ex.: enquanto salva). O botão × continua. */
  locked?: boolean
}) {
  const dialog = useRef<HTMLDivElement>(null)
  const pressedOnScrim = useRef(false)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const lockedRef = useRef(locked)
  lockedRef.current = locked

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    openCount++
    document.body.classList.add('has-modal')
    document.body.style.overflow = 'hidden'

    // Foco inicial: primeiro campo do formulário; senão, a própria janela.
    const root = dialog.current
    const first = root?.querySelector<HTMLElement>('.modal-body input:not([type="hidden"]), .modal-body select, .modal-body textarea')
    ;(first ?? root)?.focus({ preventScroll: true })

    const onKey = (e: KeyboardEvent) => {
      // Só o modal do topo reage; confirmações (`ask`) ficam acima e tratam o próprio Esc.
      const all = document.querySelectorAll('.modal')
      if (all[all.length - 1] !== root || document.querySelector('.dialog-scrim')) return
      if (e.key === 'Escape' && !lockedRef.current) {
        e.stopPropagation()
        closeRef.current()
        return
      }
      if (e.key === 'Tab' && root) {
        const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null)
        if (items.length === 0) return
        const firstEl = items[0]!
        const lastEl = items[items.length - 1]!
        if (e.shiftKey && (document.activeElement === firstEl || document.activeElement === root)) {
          e.preventDefault()
          lastEl.focus()
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault()
          firstEl.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      openCount--
      if (openCount === 0) {
        document.body.classList.remove('has-modal')
        document.body.style.overflow = ''
      }
      previous?.focus?.({ preventScroll: true })
    }
  }, [])

  return createPortal(
    <div
      className="modal-scrim"
      onMouseDown={(e) => {
        pressedOnScrim.current = e.target === e.currentTarget
      }}
      onClick={(e) => {
        // Só fecha se o clique COMEÇOU e TERMINOU no fundo (selecionar texto e soltar fora não perde o formulário).
        if (e.target === e.currentTarget && pressedOnScrim.current && !locked) onClose()
      }}
    >
      <div ref={dialog} className={`modal modal-${size}${title ? ' titled' : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} tabIndex={-1}>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Fechar janela">
          ×
        </button>
        {title && (
          <header className="modal-head">
            <h2>{title}</h2>
            {subtitle && <p className="muted">{subtitle}</p>}
          </header>
        )}
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}
