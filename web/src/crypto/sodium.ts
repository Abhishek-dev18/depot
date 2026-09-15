import _sodium from 'libsodium-wrappers'

let ready: Promise<typeof _sodium> | null = null

/** Lazily initialises libsodium exactly once and returns the ready instance. */
export function sodium(): Promise<typeof _sodium> {
  if (!ready) {
    ready = _sodium.ready.then(() => _sodium)
  }
  return ready
}
