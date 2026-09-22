import { fromBase64, toBase64 } from '../crypto/codec'
import type { Credential } from '../crypto/credential'
import { verifyCredential } from '../crypto/credential'
import { deriveKeys, ecdh } from '../crypto/derive'
import { generateEphemeralKeyPair } from '../crypto/keys'
import { reconnectTranscript, signReconnectResponse } from '../crypto/reconnect'
import { loadOrCreateIdentity } from '../storage/identityStore'
import { getPairing, savePairing } from '../storage/pairings'
import { SignalClient } from '../signal/client'
import type { Envelope } from '../signal/envelope'
import { ReasonDepotOffline, TypeDepotOnline, TypeError as SignalError } from '../signal/envelope'
import { TypeRejected, throwIfRejected } from './rejection'
import { negotiateAsOfferer, type ConnectionType, type TurnConfig } from '../transport/webrtc'
import { openClientSession, type ClientSession } from '../transport/transferSession'

/**
 * What to do about a Depot that is not registered yet.
 *
 * Handed to the caller rather than decided here, because how long to
 * wait before giving up and showing something is a question about the
 * screen, not about the protocol.
 */
export interface DepotOfflineWaiting {
  /** Resolves when Signal says it registered; rejects on timeout. */
  waitForIt: () => Promise<void>
  /** Releases the socket held open for that. Always call it. */
  stopWaiting: () => void
}

export interface ClientReconnectCallbacks {
  onStatus: (status: string) => void

  /**
   * The Depot is simply not registered with Signal right now — its owner
   * has not started it, or the phone is asleep.
   *
   * Reported apart from onError because it is not a failure: nothing is
   * misconfigured and nothing needs fixing, the other end is just not
   * there yet. Telling someone their network is at fault when their phone
   * is merely switched off sends them to debug the wrong thing.
   */
  onDepotOffline: (waiting: DepotOfflineWaiting) => void
  onConnected: (info: { depotId: string; connectionType: ConnectionType }) => void
  /**
   * The session is open and can be browsed. Closing it tears down the
   * data channels and the signal connection with it.
   */
  onSession: (session: DepotConnection) => void
  onError: (message: string) => void
}

/** A live connection to a Depot: browse it, pull files from it, close it. */
export interface DepotConnection extends ClientSession {
  depotId: string
  connectionType: ConnectionType
}

interface ChallengePayload {
  depotEk: string
  challengeNonce: string
}

/**
 * How long to give the Depot to answer a step of §4.
 *
 * Fifteen seconds was too short and the failure it produced was a lie. A
 * phone that has just been switched on is cold: the service starts, the
 * socket connects, and only then does it build a peer connection and
 * gather candidates. It answers — later than this used to wait.
 *
 * What the user saw was "your network wouldn't allow a link", which sent
 * them to move devices onto the same Wi-Fi to fix a phone that was
 * merely still waking up.
 */
const STEP_TIMEOUT_MS = 40_000

/**
 * Waits for one step, and says which step it was if it does not come.
 *
 * "timed out waiting for signal message" names nothing. A timeout here
 * means the Depot is registered — Signal answered, or the request would
 * have been refused outright — and did not reply, which is a different
 * problem from having no route to it and has a different answer.
 */
/**
 * How long to wait for the Depot's very first word.
 *
 * Shorter than the rest, because a registration that does not answer is
 * usually a registration that has outlived its phone. Signal holds one
 * until the socket is noticed to be gone, so a phone that slept, changed
 * network or was switched off leaves one behind: the Client gets past
 * "that Depot is offline" and then waits on a peer that is not there.
 *
 * Waiting the full step timeout for that is the worst of both — the
 * phone is usually back and re-registered within a few seconds, and
 * every second spent waiting on the dead registration is a second the
 * fresh one is not being tried. Giving up quickly and asking again is
 * what makes a phone coming back online feel immediate.
 */
const FIRST_REPLY_TIMEOUT_MS = 12_000

/**
 * How long to hold a watch open before asking again from scratch.
 *
 * Signal keeps no state across restarts by design, so a watch does not
 * survive one — and a socket held open for hours through a home router
 * is not a thing to rely on either. Long enough that waiting is the
 * normal case, short enough that a lost notice costs one wait rather
 * than for ever.
 */
const WATCH_TIMEOUT_MS = 5 * 60_000

async function waitForStep(
  client: SignalClient,
  predicate: (e: Envelope) => boolean,
  whatFailed: string,
  timeoutMs: number = STEP_TIMEOUT_MS,
): Promise<Envelope> {
  try {
    return await client.waitFor(predicate, timeoutMs)
  } catch {
    throw new Error(`${whatFailed} within ${Math.round(timeoutMs / 1000)}s`)
  }
}

/**
 * Client side of protocol.md §4 and §5. Proves possession of
 * ClientIdentity's private key (§4), then negotiates a WebRTC data channel
 * over the same signal relay and hands back an open session the caller can
 * browse and pull files from (§5.7, §5.9).
 *
 * The signal connection is kept open for the life of that session rather
 * than closed on the way out: WebRTC renegotiation and any later ICE
 * candidates travel over it, and a Depot that revokes this Client mid-
 * session announces it there too.
 */
export async function runClientReconnect(
  signalUrl: string,
  depotId: string,
  turn: TurnConfig | undefined,
  cb: ClientReconnectCallbacks,
): Promise<void> {
  let client: SignalClient | undefined
  try {
    const pairing = await getPairing(depotId)
    if (!pairing) throw new Error('no stored pairing for this Depot — pair first')

    cb.onStatus('generating fresh ephemeral key')
    const identity = await loadOrCreateIdentity('identity:client')
    const ephemeral = await generateEphemeralKeyPair()
    const clientId = toBase64(identity.publicKey)

    cb.onStatus('connecting to signal')
    client = new SignalClient(signalUrl)
    await client.ready()

    client.connectTo(depotId, clientId, {
      credential: pairing.credential,
      clientEk: toBase64(ephemeral.publicKey),
    })

    cb.onStatus('awaiting challenge')
    const challenge = await waitForStep(
      client,
      (e) => e.type === 'CHALLENGE' || e.type === TypeRejected || e.type === SignalError,
      'the Depot is registered but did not answer the reconnection request',
      FIRST_REPLY_TIMEOUT_MS,
    )
    if (challenge.type === SignalError) {
      if (challenge.reason === ReasonDepotOffline) {
        // Not registered. Rather than close and ask again in a few
        // seconds, ask Signal to say so the moment it registers: the
        // answer is known there the instant it is true, and no polling
        // interval is both immediate and cheap. See §7.
        //
        // The socket stays open for that, so this is the one path that
        // reports offline without closing — and the caller is handed the
        // means to stop waiting.
        const held = client
        cb.onDepotOffline({
          waitForIt: async () => {
            held.watch(depotId)
            await held.waitFor(
              (e) => e.type === TypeDepotOnline && e.depotId === depotId,
              WATCH_TIMEOUT_MS,
            )
          },
          stopWaiting: () => held.close(),
        })
        return
      }
      throw new Error(`reconnection rejected: ${challenge.reason}`)
    }
    throwIfRejected(challenge)

    const { depotEk, challengeNonce } = challenge.payload as ChallengePayload
    const depotEkBytes = fromBase64(depotEk)
    const challengeNonceBytes = fromBase64(challengeNonce)

    const transcript = reconnectTranscript(ephemeral.publicKey, depotEkBytes, challengeNonceBytes)
    const sig = await signReconnectResponse(identity.privateKey, transcript)

    cb.onStatus('sending signed response')
    client.relay('RESPONSE', { sig })

    const ok = await waitForStep(
      client,
      (e) => e.type === 'SESSION_OK' || e.type === TypeRejected || e.type === SignalError,
      'the Depot did not accept the signed response',
    )
    if (ok.type === SignalError) {
      if (ok.reason === ReasonDepotOffline) {
        // Halfway through the handshake is not where a watch belongs:
        // whatever happened, starting again is cheaper than reasoning
        // about a half-built session.
        client.close()
        cb.onDepotOffline({ waitForIt: () => Promise.resolve(), stopWaiting: () => {} })
        return
      }
      throw new Error(`reconnection rejected: ${ok.reason}`)
    }
    throwIfRejected(ok)

    // protocol.md §4.1: silent credential renewal — save it only if it
    // actually verifies against this Depot's identity, so a compromised
    // Signal can't slip in a forged "renewed" credential.
    const { credential: renewed } = (ok.payload ?? {}) as { credential?: Credential }
    if (renewed && (await verifyCredential(renewed, fromBase64(depotId)))) {
      await savePairing({ ...pairing, credential: renewed })
    }

    const shared = await ecdh(ephemeral.privateKey, depotEkBytes)
    const keys = await deriveKeys(shared, transcript)

    cb.onStatus('negotiating data channel')
    const channels = await negotiateAsOfferer(client, turn)

    cb.onStatus('connected')
    cb.onConnected({ depotId, connectionType: channels.connectionType })

    const session = await openClientSession(channels, { kC2D: keys.kC2D, kD2C: keys.kD2C })
    const signal = client
    let closed = false

    cb.onStatus('ready')
    cb.onSession({
      ...session,
      depotId,
      connectionType: channels.connectionType,
      close: () => {
        if (closed) return
        closed = true
        session.close()
        channels.close()
        signal.close()
      },
    })
  } catch (err) {
    cb.onError(err instanceof Error ? err.message : String(err))
    client?.close()
  }
}
