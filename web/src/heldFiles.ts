import type { DirEntry } from './transport/transferSession'

/**
 * A file that already came across and is still in this browser's hands.
 *
 * Held for the life of the connection, which is also the life of the
 * handles it is keyed by (§5.9 mints them per session). A new session
 * means new handles, so nothing here would match anyway.
 */
export interface HeldFile {
  /** The handle it arrived under, which is how it is recognised again. */
  handle: string
  name: string
  size: number
  /** The listing's figure at the time it was fetched — see isStale. */
  modifiedAt?: number
  blob: Blob
  /** A save URL, kept for the life of the panel so the row stays clickable. */
  url: string
}

/**
 * Whether a file in hand still matches what the Depot is offering.
 *
 * The listing is the only evidence available without asking for the bytes
 * again, so size and modification time are what there is. Either one
 * disagreeing means the held copy is of a different file that happens to
 * share a handle, and re-fetching is correct. Where the Depot reports
 * neither, there is nothing to compare and the held copy stands — which
 * is why the preview carries an explicit "fetch again" rather than
 * leaving that case to a guess.
 */
export function isStale(held: HeldFile, entry: DirEntry): boolean {
  if (entry.size !== undefined && entry.size !== held.size) return true
  if (entry.modifiedAt !== undefined && entry.modifiedAt !== held.modifiedAt) return true
  return false
}
