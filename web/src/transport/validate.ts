import type { Manifest } from './manifest'

/**
 * Checking a MANIFEST before acting on it (protocol.md §5.7).
 *
 * The Depot is authenticated, so this is not a defence against a
 * stranger — §1.2 is clear that a compromised Depot is out of scope.
 * It is a defence against a *buggy* one, and against the difference
 * between an error and a hang.
 *
 * Unchecked, a manifest claiming a million chunks sends the Client into
 * a million IndexedDB lookups before it draws anything, and one whose
 * chunk offsets do not tile the file produces a whole-file hash mismatch
 * at the very end, after the entire transfer. Both look to the user like
 * the browser has died. Rejecting them at the door costs one pass over
 * an array the Client was about to iterate anyway, and turns a silent
 * stall into a sentence.
 */

/** No single file this product serves is plausibly larger. */
const MAX_FILE_SIZE = 1024 ** 4 // 1 TiB

/**
 * At the smallest chunk size anyone would negotiate, a million chunks is
 * already a file far past MAX_FILE_SIZE. This bounds the work done
 * before the size check can even be reached.
 */
const MAX_CHUNKS = 1_000_000

export class ManifestError extends Error {}

function fail(reason: string): never {
  throw new ManifestError(`the Depot sent a manifest this Client cannot use: ${reason}`)
}

function isFiniteNonNegative(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0
}

/**
 * Returns the manifest unchanged, or throws.
 *
 * [maxChunkSize] is what CAPS settled on (§5.4). A chunk larger than
 * that is not a disagreement to tolerate: the Client sized its buffers
 * for the negotiated figure.
 */
export function validateManifest(value: unknown, maxChunkSize: number): Manifest {
  if (typeof value !== 'object' || value === null) fail('it is not an object')
  const m = value as Record<string, unknown>

  if (typeof m.name !== 'string' || m.name.length === 0) fail('it names no file')
  if (m.name.length > 1024) fail('the file name is implausibly long')
  if (typeof m.fileHash !== 'string' || m.fileHash.length === 0) fail('it carries no whole-file hash')
  if (!isFiniteNonNegative(m.transferId)) fail('its transfer id is not a number')
  if (!isFiniteNonNegative(m.size)) fail('its size is not a number')
  if (m.size > MAX_FILE_SIZE) fail(`it claims to be ${m.size} bytes`)

  if (!Array.isArray(m.chunks)) fail('its chunk list is not a list')
  const chunks = m.chunks as unknown[]
  if (chunks.length > MAX_CHUNKS) fail(`it claims ${chunks.length} chunks`)
  if (!isFiniteNonNegative(m.chunkCount)) fail('its chunk count is not a number')
  if (m.chunkCount !== chunks.length) {
    fail(`it says ${m.chunkCount} chunks and carries ${chunks.length}`)
  }

  // The chunks must tile the file exactly: each one starting where the
  // last ended, together covering every byte and no more. Anything else
  // reassembles into something that is not the file, and the only thing
  // that would notice is the whole-file hash — after the whole transfer.
  let offset = 0
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]
    if (typeof c !== 'object' || c === null) fail(`chunk ${i} is not an object`)
    const chunk = c as Record<string, unknown>
    if (chunk.index !== i) fail(`chunk ${i} is labelled ${String(chunk.index)}`)
    if (typeof chunk.hash !== 'string' || chunk.hash.length === 0) fail(`chunk ${i} has no hash`)
    if (!isFiniteNonNegative(chunk.length)) fail(`chunk ${i} has no usable length`)
    if (chunk.length === 0) fail(`chunk ${i} is empty`)
    if (chunk.length > maxChunkSize) {
      fail(`chunk ${i} is ${chunk.length} bytes, past the ${maxChunkSize} agreed in CAPS`)
    }
    if (chunk.offset !== offset) {
      fail(`chunk ${i} starts at ${String(chunk.offset)}, not ${offset} where the last one ended`)
    }
    offset += chunk.length
  }

  if (offset !== m.size) fail(`its chunks cover ${offset} bytes but it claims ${m.size}`)

  return value as Manifest
}

/**
 * A name a Client asked the Depot to write under (protocol.md §5.10).
 *
 * Returns the name, or throws. This is not the security boundary — the
 * destination is a directory handle the Depot itself minted, so there is
 * no path to escape from. It exists because a display name carrying a
 * separator is confusing, and because something downstream of this
 * protocol may yet treat it as a path even though this protocol does
 * not.
 */
export function validateUploadName(name: unknown): string {
  if (typeof name !== 'string') fail('the name is not a string')
  if (name.length === 0) fail('the name is empty')
  if (name.length > 255) fail('the name is longer than any filesystem will take')
  if (name.includes('/') || name.includes('\\')) fail(`"${name}" looks like a path, not a name`)
  if (name === '.' || name === '..' || name.startsWith('.')) {
    fail(`"${name}" starts with a dot, which hides it and may mean something to the filesystem`)
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) fail('the name contains control characters')
  return name
}
