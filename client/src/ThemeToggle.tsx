import Icon, { type IconName } from './Icon'
import { useTheme, type ThemeMode } from './theme'

const LABEL: Record<ThemeMode, string> = { system: 'Tema do sistema', light: 'Tema claro', dark: 'Tema escuro' }
const ICON: Record<ThemeMode, IconName> = { system: 'monitor', light: 'sun', dark: 'moon' }

/** Alterna entre sistema → claro → escuro. O rótulo diz o estado atual e o que acontece ao clicar. */
export default function ThemeToggle() {
  const { mode, cycle } = useTheme()
  const next: ThemeMode = mode === 'system' ? 'light' : mode === 'light' ? 'dark' : 'system'
  return (
    <button type="button" className="icon-btn" onClick={cycle} title={`${LABEL[mode]} — clique para: ${LABEL[next].toLowerCase()}`} aria-label={`${LABEL[mode]}. Clique para alternar para ${LABEL[next].toLowerCase()}`}>
      <Icon name={ICON[mode]} />
    </button>
  )
}
