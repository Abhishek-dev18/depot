/** Minimal inline icons — stroke="currentColor" so they follow text color in both themes, no icon-font dependency. */

const base = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

export function LaptopIcon() {
  return (
    <svg {...base} aria-hidden="true">
      <rect x="3" y="4" width="18" height="12" rx="1.5" />
      <path d="M2 19h20" />
    </svg>
  )
}

export function PhoneIcon() {
  return (
    <svg {...base} aria-hidden="true">
      <rect x="7" y="2" width="10" height="20" rx="2" />
      <path d="M11 18h2" />
    </svg>
  )
}

export function ShieldIcon() {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  )
}

export function FolderIcon() {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
    </svg>
  )
}

export function LinkIcon() {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M9 15l6-6" />
      <path d="M14 5l1.5-1.5a3.5 3.5 0 0 1 5 5L19 10" />
      <path d="M10 19l-1.5 1.5a3.5 3.5 0 0 1-5-5L5 14" />
    </svg>
  )
}

export function CopyIcon() {
  return (
    <svg {...base} width={14} height={14} aria-hidden="true">
      <rect x="9" y="9" width="12" height="12" rx="1.5" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </svg>
  )
}

export function CheckIcon() {
  return (
    <svg {...base} width={14} height={14} aria-hidden="true">
      <path d="M4 12l5 5L20 6" />
    </svg>
  )
}

export function SunIcon() {
  return (
    <svg {...base} width={16} height={16} aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  )
}

export function MoonIcon() {
  return (
    <svg {...base} width={16} height={16} aria-hidden="true">
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
    </svg>
  )
}

/** Half light, half dark: "whatever the system says". */
export function AutoThemeIcon() {
  return (
    <svg {...base} width={16} height={16} aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" />
    </svg>
  )
}
