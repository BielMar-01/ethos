import { useEffect, useRef, useState, type CSSProperties, type ElementType, type ReactNode } from 'react'

const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/** Observa um elemento e diz quando ele entrou na tela (uma vez só). Sem IntersectionObserver ou com "menos movimento": já visível. */
function useInView<T extends HTMLElement>(threshold = 0.15) {
  const ref = useRef<T>(null)
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined' || reduced())
  useEffect(() => {
    const el = ref.current
    if (seen || !el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true)
          io.disconnect()
        }
      },
      { threshold, rootMargin: '0px 0px -8% 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [seen, threshold])
  return [ref, seen] as const
}

/** Aparece suavemente (subindo) quando entra na tela. `delay` em ms permite escalonar irmãos. */
export function Reveal({
  children,
  delay = 0,
  as: Tag = 'div',
  className = '',
  style,
}: {
  children: ReactNode
  delay?: number
  as?: ElementType
  className?: string
  style?: CSSProperties
}) {
  const [ref, seen] = useInView<HTMLElement>()
  return (
    <Tag ref={ref} className={`reveal${seen ? ' in' : ''} ${className}`.trim()} style={{ ...style, '--d': `${delay}ms` } as CSSProperties}>
      {children}
    </Tag>
  )
}

/** Número que "sobe" até o valor quando entra na tela. */
export function Counter({ to, prefix = '', suffix = '', duration = 1400 }: { to: number; prefix?: string; suffix?: string; duration?: number }) {
  const [ref, seen] = useInView<HTMLSpanElement>(0.4)
  const [value, setValue] = useState(() => (reduced() ? to : 0))
  useEffect(() => {
    if (!seen || reduced()) return
    let raf = 0
    const start = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      setValue(Math.round(to * (1 - Math.pow(1 - t, 3)))) // desacelera no fim
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [seen, to, duration])
  return (
    <span ref={ref}>
      {prefix}
      {value.toLocaleString('pt-BR')}
      {suffix}
    </span>
  )
}

/** true depois que a página rolou além de `px` (para dar sombra ao cabeçalho fixo). */
export function useScrolled(px = 8) {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > px)
    on()
    window.addEventListener('scroll', on, { passive: true })
    return () => window.removeEventListener('scroll', on)
  }, [px])
  return scrolled
}
