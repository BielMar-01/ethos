import { useCallback, useState } from 'react'

export type ThemeMode = 'light' | 'dark' | 'system'

const KEY = 'ethos-theme'

function read(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system' // armazenamento bloqueado (modo privado etc.)
  }
}

/** "system" remove o atributo: aí vale a preferência do sistema operacional (prefers-color-scheme). */
function apply(mode: ThemeMode) {
  const root = document.documentElement
  if (mode === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', mode)
}

const ORDER: ThemeMode[] = ['system', 'light', 'dark']

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(read)

  const set = useCallback((next: ThemeMode) => {
    setMode(next)
    apply(next)
    try {
      if (next === 'system') localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, next)
    } catch {
      /* sem persistência: vale só nesta sessão */
    }
  }, [])

  const cycle = useCallback(() => set(ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length]!), [mode, set])
  return { mode, set, cycle }
}
