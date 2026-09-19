/**
 * The interface spec's own notation — "41.2 GB", "612 MB", "0:09", "14 SEP".
 *
 * Deliberately the same rules as the Android app's Format.kt, because the
 * two halves of the product show the same figures and should agree about
 * how to write them. Decimal units, not binary: a phone's storage screen
 * says GB for 10^9 bytes, so matching it keeps the two comparable rather
 * than mysteriously 7% apart.
 */
const UNITS = ['KB', 'MB', 'GB', 'TB', 'PB']

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1000) return `${Math.round(bytes)} B`
  let value = bytes / 1000
  let unit = 0
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000
    unit++
  }
  // One decimal below a hundred, none above: "4.2 MB" but "612 MB".
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${UNITS[unit]}`
}

export function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—'
  return `${formatBytes(bytesPerSecond)}/s`
}

/** "0:09", or an hours figure once seconds stop being useful. */
export function formatEta(remainingBytes: number, bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0 || remainingBytes <= 0) return '—'
  const seconds = Math.round(remainingBytes / bytesPerSecond)
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600)
    return `${hours}h ${Math.floor((seconds % 3600) / 60)}m`
  }
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** mm:ss, for the pairing code's two-minute life (§3.1). */
export function formatClock(millis: number): string {
  const seconds = Math.max(0, Math.round(millis / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

/** "14 SEP" — the file table's MODIFIED column. */
export function formatDay(millis: number | undefined): string {
  if (millis === undefined || !Number.isFinite(millis)) return '—'
  const d = new Date(millis)
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`
}

/** A base64 identity key is 43 characters of noise. */
export function shortId(id: string, head = 12): string {
  return id.length <= head ? id : `${id.slice(0, head)}…`
}

/** A Depot's own name if it has one, otherwise enough of its key to recognise. */
export function depotLabelFor(depotId: string, label?: string): string {
  return label && label.trim().length > 0 ? label : shortId(depotId, 10)
}

/**
 * Reading a clock is an effect, not a value, so it lives outside any
 * component body — React's rules require render to be idempotent, and a
 * component that reads the time while rendering is not.
 */
export function nowMs(): number {
  return Date.now()
}
