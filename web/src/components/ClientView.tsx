import { useCallback, useEffect, useRef, useState } from 'react'
import { useLog } from '../hooks/useLog'
import { runClientPairing } from '../pairing/clientPairing'
import { runClientReconnect, type DepotConnection } from '../pairing/clientReconnect'
import type { QRPayload } from '../pairing/types'
import { listPairings, type Pairing } from '../storage/pairings'
import type { TurnConfig } from '../transport/webrtc'
import { depotLabelFor } from '../format'
import { FilesPanel } from './FilesPanel'
import { Log } from './Log'
import { NoRoutePanel } from './NoRoutePanel'
import { PairPanel } from './PairPanel'

interface Props {
  signalUrl: string
  turnConfig?: TurnConfig
  onOpenSettings: () => void
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
export function ClientView({ signalUrl, turnConfig, onOpenSettings }: Props) {
  const { lines, push, clear } = useLog()
  const [pairings, setPairings] = useState<Pairing[]>([])
  const [session, setSession] = useState<DepotConnection | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const [qr, setQr] = useState<{ dataUrl: string; json: string } | null>(null)
  const [sas, setSas] = useState<string | null>(null)
  const [issuedAt, setIssuedAt] = useState<number | null>(null)
  const [pairingBusy, setPairingBusy] = useState(false)

  const sessionRef = useRef<DepotConnection | null>(null)
  const autoConnected = useRef(false)

  useEffect(() => {
    sessionRef.current = session
  }, [session])

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
      if (sessionRef.current) return
      setConnecting(true)
      setFailure(null)
      await runClientReconnect(signalUrl, depotId, turnConfig, {
        onStatus: push,
        onConnected: ({ connectionType }) => push(`connected (${connectionType})`),
        onSession: (open) => {
          sessionRef.current = open
          setSession(open)
        },
        onError: (message) => {
          push(`error: ${message}`)
          setFailure(message)
        },
      })
      setConnecting(false)
    },
    [signalUrl, turnConfig, push],
  )

  // A browser that already holds a credential should behave like a client
  // that is simply connected, not make the user ask for it every time.
  useEffect(() => {
    if (autoConnected.current) return
    if (pairings.length === 0 || session || connecting || failure) return
    autoConnected.current = true
    void connect(pairings[0].depotId)
  }, [pairings, session, connecting, failure, connect])

  const disconnect = () => {
    sessionRef.current?.close()
    sessionRef.current = null
    setSession(null)
    autoConnected.current = true // do not immediately reconnect
    push('disconnected')
  }

  const retry = () => {
    setFailure(null)
    autoConnected.current = false
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

  return (
    <div className="client-shell">
      {session ? (
        <FilesPanel
          session={session}
          depotLabel={depotLabelFor(session.depotId, pairing?.depotLabel)}
          onDisconnect={disconnect}
          onSettings={onOpenSettings}
          onError={(message) => {
            push(`error: ${message}`)
            setFailure(message)
          }}
          log={push}
        />
      ) : failure ? (
        <NoRoutePanel message={failure} onRetry={retry} onSettings={onOpenSettings} />
      ) : connecting ? (
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
