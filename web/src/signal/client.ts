import { TypeConnect, TypeError, TypeHello, TypeJoin, TypeRegister, TypeRevoke, type Envelope } from './envelope'

/** Thin wrapper over the WebSocket connection to signal (protocol.md §7). */
export class SignalClient {
  private ws: WebSocket
  private listeners = new Set<(e: Envelope) => void>()
  private openPromise: Promise<void>

  constructor(url: string) {
    this.ws = new WebSocket(url)
    this.openPromise = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true })
      this.ws.addEventListener(
        'error',
        () => reject(new Error(`could not connect to signal at ${url}`)),
        { once: true },
      )
    })
    this.ws.addEventListener('message', (ev) => {
      let parsed: Envelope
      try {
        parsed = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as Envelope
      } catch {
        return
      }
      for (const listener of this.listeners) listener(parsed)
    })
  }

  ready(): Promise<void> {
    return this.openPromise
  }

  send(e: Envelope): void {
    this.ws.send(JSON.stringify(e))
  }

  onMessage(fn: (e: Envelope) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Resolves with the first message matching predicate, or rejects on timeout. */
  waitFor(predicate: (e: Envelope) => boolean, timeoutMs = 15000): Promise<Envelope> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe()
        reject(new Error('timed out waiting for signal message'))
      }, timeoutMs)
      const unsubscribe = this.onMessage((e) => {
        if (predicate(e)) {
          clearTimeout(timer)
          unsubscribe()
          resolve(e)
        }
      })
    })
  }

  close(): void {
    this.ws.close()
  }

  // --- Convenience senders, one per type Signal owns (envelope.ts) ---

  hello(sessionId: string): void {
    this.send({ type: TypeHello, sessionId })
  }

  join(sessionId: string): void {
    this.send({ type: TypeJoin, sessionId })
  }

  register(depotId: string): void {
    this.send({ type: TypeRegister, depotId })
  }

  connectTo(depotId: string, clientId: string, payload: unknown): void {
    this.send({ type: TypeConnect, depotId, clientId, payload })
  }

  revoke(clientId: string): void {
    this.send({ type: TypeRevoke, clientId })
  }

  /** Opaque relay — everything Signal doesn't own: PAIR_RESPONSE, PAIR_CONFIRM, CHALLENGE, RESPONSE, SESSION_OK, … */
  relay(type: string, payload: unknown, clientId?: string): void {
    this.send({ type, payload, clientId })
  }
}

/** Rejects if the next message is an error envelope; otherwise resolves it. */
export function rejectOnError(e: Envelope): Envelope {
  if (e.type === TypeError) {
    throw new Error(`signal error: ${e.reason ?? 'unknown'}`)
  }
  return e
}
