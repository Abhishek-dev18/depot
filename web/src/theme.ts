import { useEffect, useState } from 'react'

/**
 * Light or dark, or whatever the system says.
 *
 * The palette lives in index.css as tokens on :root, dark by default and
 * overridden under [data-theme="light"]. This module only decides which
 * one applies: it resolves the preference against the system setting and
 * writes the answer to <html data-theme>. index.html runs the same
 * resolution inline before first paint, so a light page never flashes
 * dark on load; this takes over from there and follows the system while
 * the preference is "system".
 */
export type ThemePreference = 'system' | 'light' | 'dark'
export type Theme = 'light' | 'dark'

const KEY = 'depot:theme'
const listeners = new Set<(pref: ThemePreference) => void>()

export function readThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  } catch {
    // Storage blocked: the system decides.
  }
  return 'system'
}

function systemTheme(): Theme {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function resolveTheme(pref: ThemePreference): Theme {
  return pref === 'system' ? systemTheme() : pref
}

function apply(pref: ThemePreference): void {
  document.documentElement.dataset.theme = resolveTheme(pref)
}

export function setThemePreference(pref: ThemePreference): void {
  try {
    localStorage.setItem(KEY, pref)
  } catch {
    // Applies for this page even if it cannot be remembered.
  }
  apply(pref)
  for (const listener of listeners) listener(pref)
}

/** Next in the cycle the nav button steps through. */
export function nextThemePreference(pref: ThemePreference): ThemePreference {
  return pref === 'system' ? 'light' : pref === 'light' ? 'dark' : 'system'
}

/** Applies the stored preference and keeps following the system while it says "system". */
export function startTheme(): void {
  apply(readThemePreference())
  if (typeof matchMedia !== 'function') return
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (readThemePreference() === 'system') apply('system')
  })
}

/** The current preference, kept in step across every control that shows it. */
export function useThemePreference(): [ThemePreference, (pref: ThemePreference) => void] {
  const [pref, setPref] = useState<ThemePreference>(readThemePreference)
  useEffect(() => {
    listeners.add(setPref)
    return () => {
      listeners.delete(setPref)
    }
  }, [])
  return [pref, setThemePreference]
}
