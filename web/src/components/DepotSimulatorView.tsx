import { useCallback, useEffect, useRef, useState } from 'react'
import { useLog } from '../hooks/useLog'
import { runDepotPairing } from '../pairing/depotPairing'
import { runDepotReconnectListener, type DepotReconnectListener } from '../pairing/depotReconnect'
import { listDevices, revokeDevice, type DeviceRecord } from '../storage/devices'
import { Log } from './Log'

export function DepotSimulatorView({ signalUrl }: { signalUrl: string }) {
  const { lines, push, clear } = useLog()
  const [qrText, setQrText] = useState('')
  const [busy, setBusy] = useState(false)
  const [sas, setSas] = useState<{ code: string; approve: () => void } | null>(null)
  const [devices, setDevices] = useState<DeviceRecord[]>([])
  const [listener, setListener] = useState<DepotReconnectListener | null>(null)
  const listenerRef = useRef<DepotReconnectListener | null>(null)

  const refreshDevices = useCallback(() => {
    void listDevices().then(setDevices)
  }, [])

  useEffect(() => {
    refreshDevices()
  }, [refreshDevices])

  useEffect(
    () => () => {
      listenerRef.current?.stop()
    },
    [],
  )

  const joinPairing = async () => {
    clear()
    setSas(null)
    setBusy(true)
    await runDepotPairing(qrText, {
      onStatus: push,
      onSas: (code, approve) => setSas({ code, approve }),
      onPaired: () => {
        refreshDevices()
        setSas(null)
        setQrText('')
      },
      onError: (msg) => push(`error: ${msg}`),
    })
    setBusy(false)
  }

  const startListening = async () => {
    if (listenerRef.current) return
    const l = await runDepotReconnectListener(signalUrl, {
      onStatus: push,
      onRegistered: (id) => push(`registered as ${id.slice(0, 16)}…`),
      onClientConnected: ({ clientId, pingRoundtripOk }) => {
        push(`client ${clientId.slice(0, 16)}… reconnected — session key check ${pingRoundtripOk ? 'passed' : 'skipped'}`)
        refreshDevices()
      },
      onClientRejected: ({ clientId, reason }) => push(`rejected ${clientId.slice(0, 16)}…: ${reason}`),
      onError: (msg) => push(`error: ${msg}`),
    })
    listenerRef.current = l
    setListener(l)
  }

  const stopListening = () => {
    listenerRef.current?.stop()
    listenerRef.current = null
    setListener(null)
    push('stopped listening')
  }

  const revoke = async (clientId: string) => {
    await revokeDevice(clientId)
    listenerRef.current?.revoke(clientId)
    push(`revoked ${clientId.slice(0, 16)}…`)
    refreshDevices()
  }

  return (
    <div className="panel">
      <h2>Depot simulator</h2>
      <p className="hint">
        Stands in for the Android app so pairing and reconnection can be tested end to end without it. Paste the
        Client's QR JSON below — a browser tab has no camera.
      </p>

      <textarea
        value={qrText}
        onChange={(e) => setQrText(e.target.value)}
        rows={6}
        placeholder="Paste the QR payload JSON from the Client tab here"
      />
      <button onClick={() => void joinPairing()} disabled={busy || !qrText.trim()}>
        {busy ? 'Joining…' : 'Join pairing'}
      </button>

      {sas && (
        <div className="sas">
          <p>Compare this code with the Client. Only approve if it matches exactly.</p>
          <div className="sas-code">{sas.code}</div>
          <button
            onClick={() => {
              sas.approve()
              setSas(null)
            }}
          >
            Approve
          </button>
        </div>
      )}

      <h3>Reconnection listener</h3>
      {listener ? (
        <>
          <p className="hint">
            Listening as <code title={listener.depotId}>{listener.depotId.slice(0, 16)}…</code>
          </p>
          <button onClick={stopListening}>Stop listening</button>
        </>
      ) : (
        <button onClick={() => void startListening()}>Start listening</button>
      )}

      <h3>Paired devices</h3>
      {devices.length === 0 ? (
        <p className="hint">None yet.</p>
      ) : (
        <ul className="entity-list">
          {devices.map((d) => (
            <li key={d.clientIdentityPub}>
              <code title={d.clientIdentityPub}>{d.clientIdentityPub.slice(0, 16)}…</code>
              {d.revoked ? (
                <em>revoked</em>
              ) : (
                <button onClick={() => void revoke(d.clientIdentityPub)}>Revoke</button>
              )}
            </li>
          ))}
        </ul>
      )}

      <Log lines={lines} />
    </div>
  )
}
