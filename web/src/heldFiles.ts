import { keyFor } from './storage/fileCache'
import type { DirEntry } from './transport/transferSession'

/**
 * A file that already came across and is still in this browser's hands.
 *
 * Identified by content — name, length, modification time — rather than
 * by the §5.9 handle it arrived under. Handles are minted per session
 * and mean nothing after a reload, and the point of holding a file is
 * precisely to still have it then. A file that changed on the Depot gets
 * a different key and so simply does not match, which is why there is no
 * separate staleness check to get wrong.
 */
export interface HeldFile {
  key: string
  name: string
  size: number
  modifiedAt?: number
  blob: Blob
  /** A save URL, kept for the life of the panel so the row stays clickable. */
  url: string
  /** False when it was too large to keep, so the UI can avoid promising otherwise. */
  persisted: boolean
}

export { keyFor }

/** The held copy of what this row points at, if there is one. */
export function heldFor(held: HeldFile[], entry: DirEntry): HeldFile | undefined {
  if (entry.kind === 'dir') return undefined
  const key = keyFor(entry)
  return held.find((f) => f.key === key)
}
