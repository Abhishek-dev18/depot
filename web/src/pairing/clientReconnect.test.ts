import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fromBase64, toBase64 } from '../crypto/codec'
import { signDepotChallenge } from '../crypto/reconnect'
import { sodium } from '../crypto/sodium'

/**
 * §4 from the browser's side, against a relay that answers with whatever
 * CHALLENGE the test chooses.
 *
 * Signal lets anyone register any depotId. What stops an impostor that
 * does so is the Depot's signature in CHALLENGE, and the only way to show
 * the browser actually checks it is to hand it one that does not verify
 * and see that it never answers.
 */
type Sent = { type: string; payload: unknown }

let sent: Sent[] = []
let clientEk = ''
let challengeFor: (clientEk: Uint8Array) => Promise<unknown> = () => Promise.resolve({})
let clientIdentity: { publicKey: Uint8Array; privateKey: Uint8Array }
let depotIdentity: { publicKey: Uint8Array; privateKey: Uint8Array }

vi.mock('../signal/client', () => ({
  SignalClient: class {
    private asked = 0
    ready() {
      return Promise.resolve()
    }
    connectTo(_depotId: string, _clientId: string, payload: { clientEk: string }) {
      clientEk = payload.clientEk
    }
    relay(type: string, payload: unknown) {
      sent.push({ type, payload })
    }
    waitFor() {
      // The first thing the browser waits for is CHALLENGE; nothing after
      // it matters here, so everything later simply never arrives.
      if (this.asked++ > 0) return new Promise(() => {})
      return challengeFor(fromBase64(clientEk)).then((payload) => ({ type: 'CHALLENGE', payload }))
    }
    close() {}
  },
}))

vi.mock('../storage/identityStore', () => ({
  loadOrCreateIdentity: () => Promise.resolve(clientIdentity),
}))

vi.mock('../storage/pairings', () => ({
  getPairing: (depotId: string) => Promise.resolve({ depotId, credential: {} }),
  savePairing: () => Promise.resolve(),
}))

async function reconnect(): Promise<string | undefined> {
  const { runClientReconnect } = await import('./clientReconnect')
  let error: string | undefined
  const run = runClientReconnect('ws://unused', toBase64(depotIdentity.publicKey), undefined, {
    onStatus: () => {},
    onDepotOffline: () => {},
    onConnected: () => {},
    onSession: () => {},
    onError: (e) => {
      error = e
    },
  })
  // A genuine Depot leaves the browser waiting for SESSION_OK, which this
  // relay never sends; by then RESPONSE is either out or it is not.
  await Promise.race([run, new Promise((r) => setTimeout(r, 200))])
  return error
}

async function challengeSignedBy(privateKey: Uint8Array, ek: Uint8Array) {
  const s = await sodium()
  const depotEk = s.crypto_scalarmult_base(s.randombytes_buf(32))
  const nonce = s.randombytes_buf(16)
  return {
    depotEk: toBase64(depotEk),
    challengeNonce: toBase64(nonce),
    depotSig: await signDepotChallenge(privateKey, ek, depotEk, nonce),
  }
}

describe('a browser reconnecting to its Depot', () => {
  beforeEach(async () => {
    const s = await sodium()
    sent = []
    clientIdentity = s.crypto_sign_keypair()
    depotIdentity = s.crypto_sign_keypair()
  })

  it('answers a CHALLENGE signed by the Depot it paired with', async () => {
    challengeFor = (ek) => challengeSignedBy(depotIdentity.privateKey, ek)
    const error = await reconnect()
    expect(error).toBeUndefined()
    expect(sent.map((m) => m.type)).toEqual(['RESPONSE'])
  })

  it('refuses one signed by anybody else, without answering it', async () => {
    const s = await sodium()
    const impostor = s.crypto_sign_keypair()
    challengeFor = (ek) => challengeSignedBy(impostor.privateKey, ek)
    const error = await reconnect()
    expect(error).toMatch(/not the Depot this browser paired with/)
    expect(sent).toEqual([])
  })

  it('refuses one that does not say who sent it', async () => {
    challengeFor = async (ek) => {
      const { depotEk, challengeNonce } = await challengeSignedBy(depotIdentity.privateKey, ek)
      return { depotEk, challengeNonce }
    }
    const error = await reconnect()
    expect(error).toMatch(/did not prove who it is/)
    expect(sent).toEqual([])
  })

  it('refuses a genuine signature lifted from some other attempt', async () => {
    // Signed by the real Depot, but for a different browser key: a relay
    // that once saw a genuine CHALLENGE cannot replay it at this one.
    const s = await sodium()
    challengeFor = () => challengeSignedBy(depotIdentity.privateKey, s.crypto_scalarmult_base(s.randombytes_buf(32)))
    const error = await reconnect()
    expect(error).toMatch(/not the Depot this browser paired with/)
    expect(sent).toEqual([])
  })
})
