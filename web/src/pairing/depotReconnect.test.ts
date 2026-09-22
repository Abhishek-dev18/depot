import { describe, expect, it, vi } from 'vitest'

/**
 * A relay that answers *while* the Depot is still registering.
 *
 * A real one can: on Android, OkHttp reads the socket on its own thread,
 * so a message can be delivered between `register()` returning and the
 * next line running. Since §7.1's `watch`, Signal tells a waiting browser
 * the instant a Depot registers, and the browser's request arrives within
 * a round trip — squarely in that gap. The phone registered first and
 * subscribed afterwards, so the request found nobody listening and was
 * dropped; the browser waited out its timeout, showed the "same Wi-Fi"
 * screen, and connected on the next try, twenty to thirty seconds late.
 *
 * JavaScript cannot deliver a message between two synchronous calls on
 * its own, which is why no browser-to-browser test ever saw this. The
 * fake below does exactly what a socket thread can: it hands a request
 * to whoever is listening at the moment of registration.
 */
const listeners = new Set<(e: { type: string; clientId?: string; payload?: unknown }) => void>()

vi.mock('../signal/client', () => ({
  SignalClient: class {
    ready() {
      return Promise.resolve()
    }
    onMessage(fn: (e: never) => void) {
      listeners.add(fn as never)
      return () => listeners.delete(fn as never)
    }
    register() {
      // Delivered during registration, the way a socket thread can.
      for (const fn of [...listeners]) {
        fn({ type: 'incoming', clientId: 'browser-that-was-waiting', payload: {} })
      }
    }
    relay() {}
    close() {}
    waitFor() {
      return new Promise(() => {})
    }
  },
}))

vi.mock('../storage/identityStore', () => ({
  loadOrCreateIdentity: () =>
    Promise.resolve({ publicKey: new Uint8Array(32).fill(1), privateKey: new Uint8Array(64).fill(2) }),
}))

describe('a Depot registering with Signal', () => {
  it('is already listening when the first request arrives', async () => {
    const { runDepotReconnectListener } = await import('./depotReconnect')

    // The request carries no valid credential, so the Depot refuses it.
    // Refusing it is the proof it was *heard*: a dropped request produces
    // nothing at all, which is what the phone was doing.
    const refused = new Promise<string>((resolve) => {
      void runDepotReconnectListener(
        'ws://unused',
        { list: () => [], open: () => null },
        undefined,
        {
          onStatus: () => {},
          onRegistered: () => {},
          onClientConnected: () => {},
          onClientProgress: () => {},
          onClientRejected: ({ clientId }) => resolve(clientId),
          onError: () => {},
        },
      )
    })

    const who = await Promise.race([
      refused,
      new Promise<string>((resolve) => setTimeout(() => resolve('(dropped)'), 1_000)),
    ])
    expect(who).toBe('browser-that-was-waiting')
  })
})
