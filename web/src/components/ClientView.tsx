import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useLog } from '../hooks/useLog'
import { runClientPairing } from '../pairing/clientPairing'
import {
  runClientReconnect,
  type DepotConnection,
  type DepotOfflineWaiting,
} from '../pairing/clientReconnect'
import type { QRPayload } from '../pairing/types'
import { listPairings, type Pairing } from '../storage/pairings'
import type { TurnConfig } from '../transport/webrtc'
import { depotLabelFor } from '../format'
import { ClientNav } from './ClientNav'
import { ConnectionBadge, NoRouteBadge } from './ConnectionBadge'
import { FilesPanel } from './FilesPanel'
import { Log } from './Log'
import { NoRoutePanel } from './NoRoutePanel'
import { retryDelayMs, showsFailure } from './retryPolicy'
import { PairPanel } from './PairPanel'
import { WaitingPanel } from './WaitingPanel'

interface Props {
  signalUrl: string
  turnConfig?: TurnConfig
  onOpenSettings: () => void
  /** Rendered under the nav when open; owned by App, which holds the values. */
  settingsPanel?: ReactNode
}

/**
 * The Client, as the interface spec draws it: no install, no account.
 * Open the page, pair once, and the phone's shared folders appear.
 *
 * Three states, and they are the spec's three browser frames — pair,
 * browse, or explain why there is no route. There is no fourth "logged
 * out" state because there is no account to log out of; what this browser
 * holds is a credential, and losing it means pairing again.
 */
export function ClientView({ signalUrl, turnConfig, onOpenSettings, settingsPanel }: Props) {
  const { lines, push, clear } = useLog()
  const [pairings, setPairings] = useState<Pairing[]>([])
  const [session, setSession] = useState<DepotConnection | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [offline, setOffline] = useState(false)
  const [attempts, setAttempts] = useState(0)
  /**
   * How many times the Depot has been asked, for the screen to show.
   *
   * Separate from [attempts], which exists only to space out retries
   * after something went wrong. Conflating them meant that counting
   * polls for the display also backed the polling off — see
   * onDepotOffline — so the two are now different numbers because they
   * answer different questions.
   */
  const [polls, setPolls] = useState(0)

  const [qr, setQr] = useState<{ dataUrl: string; json: string } | null>(null)
  const [sas, setSas] = useState<string | null>(null)
  const [issuedAt, setIssuedAt] = useState<number | null>(null)
  const [pairingBusy, setPairingBusy] = useState(false)
  const [rate, setRate] = useState<number | undefined>(undefined)

  const sessionRef = useRef<DepotConnection | null>(null)
  /**
   * The socket held open waiting for Signal to say the Depot registered.
   *
   * At most one: a second attempt supersedes the first, and whichever is
   * abandoned has to give its socket back or the page leaks one per try.
   */
  const waitingRef = useRef<DepotOfflineWaiting | null>(null)
  /** Read from callbacks that must not capture a stale list. */
  const pairingsRef = useRef<Pairing[]>([])
  const connectRef = useRef<((depotId: string) => Promise<void>) | null>(null)
  const autoConnected = useRef(false)
  // A ref, not the state: two callers racing to connect would both read
  // the old `connecting` before React re-rendered either of them.
  const connectingRef = useRef(false)

  useEffect(() => {
    sessionRef.current = session
  }, [session])

  useEffect(() => {
    pairingsRef.current = pairings
  }, [pairings])

  // The waiting socket belongs to this page; navigating away closes it.
  useEffect(
    () => () => {
      waitingRef.current?.stopWaiting()
      waitingRef.current = null
    },
    [],
  )

  // The data channels and the signal socket belong to the session, so
  // navigating away has to close it rather than leaving both dangling.
  useEffect(
    () => () => {
      sessionRef.current?.close()
    },
    [],
  )

  const refreshPairings = useCallback(() => {
    void listPairings().then(setPairings)
  }, [])

  useEffect(() => {
    refreshPairings()
  }, [refreshPairings])

  const connect = useCallback(
    async (depotId: string) => {
      if (sessionRef.current || connectingRef.current) return
      connectingRef.current = true
      setConnecting(true)
      setFailure(null)
      await runClientReconnect(signalUrl, depotId, turnConfig, {
        onStatus: push,
        onConnected: ({ connectionType }) => push(`connected (${connectionType})`),
        onSession: (open) => {
          waitingRef.current?.stopWaiting()
          waitingRef.current = null
          sessionRef.current = open
          setSession(open)
          setOffline(false)
          setAttempts(0)
          setPolls(0)
        },
        onDepotOffline: (waiting) => {
          setOffline(true)
          // Not counted as an attempt, and the last failure is cleared.
          //
          // "That Depot is not registered" is a complete answer to the
          // question, arriving in one round trip — not a thing that went
          // wrong. Counting it pushed the backoff to its 30-second
          // ceiling within four polls of a phone that was merely
          // switched off, so turning the phone back on took half a
          // minute to notice instead of the four seconds intended.
          setFailure(null)
          setAttempts(0)
          setPolls((n) => n + 1)
          // Signal now says so the moment it registers, so waiting beats
          // asking again: the answer arrives in the time it takes the
          // phone to connect, rather than at the next poll. The poll
          // below stays as the fallback for a notice that never comes —
          // a Signal restart, a socket a router quietly dropped.
          waitingRef.current?.stopWaiting()
          waitingRef.current = waiting
          void waiting
            .waitForIt()
            .then(() => {
              if (waitingRef.current !== waiting) return
              waitingRef.current = null
              waiting.stopWaiting()
              const depotId = pairingsRef.current[0]?.depotId
              // Through a ref: this callback lives inside connect's own
              // definition, and naming it directly would make it
              // reference itself.
              if (depotId) void connectRef.current?.(depotId)
            })
            .catch(() => {
              // Timed out or the socket went. The poll picks it up.
              if (waitingRef.current === waiting) waitingRef.current = null
              waiting.stopWaiting()
            })
        },
        onError: (message) => {
          push(`error: ${message}`)
          setFailure(message)
          // Counted like a refusal, because it is another thing that did
          // not work and the page has to try again after it.
          setAttempts((n) => n + 1)
        },
      })
      connectingRef.current = false
      setConnecting(false)
    },
    [signalUrl, turnConfig, push],
  )

  useEffect(() => {
    connectRef.current = connect
  }, [connect])

  // A browser that already holds a credential should behave like a client
  // that is simply connected, not make the user ask for it every time.
  useEffect(() => {
    if (autoConnected.current) return
    if (pairings.length === 0 || session || connecting || failure) return
    autoConnected.current = true
    void connect(pairings[0].depotId)
  }, [pairings, session, connecting, failure, connect])

  /*
   * Keep trying, whichever way it did not work.
   *
   * There are two: the Depot says it is not registered, and the attempt
   * fails outright. This used to poll only for the first, so a page that
   * had seen one error sat on the failure screen for ever — the phone
   * could come online and nothing would notice, because nothing was
   * looking. That is most of "it never connects until I reload": a
   * reload is simply the only thing that starts a fresh attempt.
   *
   * A phone that is merely switched off is polled briskly, since the
   * answer costs one round trip and arrives at once. A failure backs off,
   * because whatever went wrong is unlikely to be fixed four seconds
   * later and the attempt itself is expensive.
   */
  useEffect(() => {
    if (session || connecting) return
    if (!offline && failure === null) return
    const depotId = pairings[0]?.depotId
    if (!depotId) return
    // See retryPolicy.ts: quick after a failure, with a ceiling of
    // seconds rather than half a minute.
    const delay = retryDelayMs(failure !== null, attempts)
    const timer = setTimeout(() => {
      void connect(depotId)
    }, delay)
    return () => clearTimeout(timer)
  }, [offline, failure, session, connecting, attempts, pairings, connect])

  /**
   * The transport died — the phone stopped listening, slept, or changed
   * network. Drop back to waiting, which already polls, so turning the
   * Depot on again brings the page back without anyone reloading it.
   */
  useEffect(() => {
    if (!session) return
    return session.onClosed(() => {
      push('connection closed by the Depot')
      sessionRef.current = null
      setSession(null)
      setOffline(true)
      setAttempts((n) => n + 1)
    })
  }, [session, push])

  const disconnect = () => {
    sessionRef.current?.close()
    sessionRef.current = null
    setSession(null)
    autoConnected.current = true // do not immediately reconnect
    push('disconnected')
  }

  /**
   * "Try now", and it has to actually try.
   *
   * It used to clear the two flags and leave an effect to notice. From
   * the failure screen that worked, because `failure` is one of that
   * effect's dependencies. From the waiting screen it did nothing at
   * all: `offline` is not, so clearing it re-ran only the loop above —
   * which then saw `offline` false and stopped scheduling. Pressing the
   * button was how you switched the retrying off.
   */
  const retry = () => {
    setFailure(null)
    setOffline(false)
    setAttempts(0)
    const depotId = pairings[0]?.depotId
    if (depotId) void connect(depotId)
  }

  /** Drop the stored credential and start over with a fresh code. */
  const pairAgain = () => {
    setOffline(false)
    setFailure(null)
    setPairings([])
    autoConnected.current = true
  }

  const startPairing = async () => {
    clear()
    setQr(null)
    setSas(null)
    setIssuedAt(null)
    setPairingBusy(true)
    await runClientPairing(signalUrl, {
      onStatus: push,
      onQrReady: (payload: QRPayload, dataUrl) => {
        setQr({ dataUrl, json: JSON.stringify(payload, null, 2) })
        setIssuedAt(Date.now())
      },
      onSas: setSas,
      onPaired: () => {
        // The comparison is done. Leaving the digits up invites the user
        // to check them again against a screen that has moved on, and the
        // QR's session is single-use, so neither should outlive pairing.
        setSas(null)
        setQr(null)
        setIssuedAt(null)
        autoConnected.current = false
        refreshPairings()
      },
      onError: (msg) => {
        setSas(null)
        push(`error: ${msg}`)
      },
    })
    setPairingBusy(false)
  }

  const pairing = pairings[0]

  /*
   * Memoised because FilesPanel lists it as an effect dependency, and
   * that effect resets the breadcrumb to the root. An inline arrow here
   * is a new function every render, so a progress tick or a log line
   * would throw whoever was browsing back out of the folder they were
   * in. Stable identity is part of this component's contract, not a
   * micro-optimisation.
   */
  const reportFileError = useCallback(
    (message: string) => {
      push(`error: ${message}`)
      setFailure(message)
    },
    [push],
  )

  // A failure below the threshold is retried quietly, under the same
  // "reaching your Depot" the page shows for any attempt in progress —
  // see retryPolicy.ts for why one miss is not worth a warning.
  const failed = showsFailure(failure !== null, attempts)
  const quietlyRetrying = failure !== null && !failed

  return (
    <div className="client-shell">
      <ClientNav
        onSettings={onOpenSettings}
        badge={
          session ? (
            <ConnectionBadge type={session.connectionType} rate={rate} />
          ) : failed ? (
            <NoRouteBadge />
          ) : offline ? (
            <NoRouteBadge label="DEPOT OFFLINE" tone="idle" />
          ) : connecting || quietlyRetrying ? (
            <NoRouteBadge label="CONNECTING" tone="idle" />
          ) : (
            <NoRouteBadge label="NOT LINKED" tone="idle" />
          )
        }
        actions={
          session ? (
            <button className="wnav-action" onClick={disconnect}>
              Disconnect
            </button>
          ) : undefined
        }
      />

      {settingsPanel}

      {session ? (
        <FilesPanel
          session={session}
          depotLabel={depotLabelFor(session.depotId, pairing?.depotLabel)}
          onSettings={onOpenSettings}
          onError={reportFileError}
          log={push}
          onRate={setRate}
        />
      ) : failed && failure ? (
        <NoRoutePanel message={failure} attempts={attempts} onRetry={retry} onSettings={onOpenSettings} />
      ) : offline ? (
        <WaitingPanel attempts={polls} onRetryNow={retry} onPairAgain={pairAgain} />
      ) : connecting || quietlyRetrying ? (
        <div className="connecting">
          <div className="connecting-mark" aria-hidden="true" />
          <div className="pairttl">Reaching your Depot</div>
          <p className="pairsub">{lines[lines.length - 1] ?? 'starting'}</p>
        </div>
      ) : (
        <PairPanel qr={qr} sas={sas} busy={pairingBusy} issuedAt={issuedAt} onStart={() => void startPairing()} />
      )}

      <details className="wire-log">
        <summary>Wire log</summary>
        <Log lines={lines} />
      </details>
    </div>
  )
}
