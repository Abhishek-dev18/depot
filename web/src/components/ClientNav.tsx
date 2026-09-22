import type { ReactNode } from 'react'
import { nextThemePreference, useThemePreference, type ThemePreference } from '../theme'
import { AutoThemeIcon, MoonIcon, SunIcon } from './icons'

const THEME_LABEL: Record<ThemePreference, string> = {
  system: 'Theme: following the system',
  light: 'Theme: light',
  dark: 'Theme: dark',
}

interface Props {
  badge?: ReactNode
  actions?: ReactNode
  onSettings: () => void
}

/**
 * `.wnav` — the one bar across the top of every browser frame in the
 * interface spec. It is the Client's whole chrome: a mark, a name, and
 * whatever the connection is currently doing.
 *
 * It sits above all three states rather than only the file browser, so
 * the page does not appear to change identity between pairing, browsing
 * and failing.
 */
export function ClientNav({ badge, actions, onSettings }: Props) {
  const [theme, setTheme] = useThemePreference()
  const next = nextThemePreference(theme)
  return (
    <div className="wnav">
      <div className="wmark" aria-hidden="true" />
      <div className="wname">Depot</div>
      {badge}
      {actions}
      <button
        className="wnav-action wnav-icon wnav-theme"
        onClick={() => setTheme(next)}
        title={`${THEME_LABEL[theme]} — click for ${next === 'system' ? 'the system setting' : next}`}
        aria-label={THEME_LABEL[theme]}
      >
        {theme === 'light' ? <SunIcon /> : theme === 'dark' ? <MoonIcon /> : <AutoThemeIcon />}
      </button>
      <button className="wnav-action wnav-icon" onClick={onSettings} title="Connection settings">
        ⚙
      </button>
    </div>
  )
}
