import { useCallback, useEffect, useState } from 'react'
import { useLog } from '../hooks/useLog'
import { runClientPairing } from '../pairing/clientPairing'
import { runClientReconnect } from '../pairing/clientReconnect'
import type { QRPayload } from '../pairing/types'
import { listPairings, type Pairing } from '../storage/pairings'
import { Log } from './Log'

export function ClientView({ signalUrl }: { signalUrl: string }) {
  const { lines, push, clear } = useLog()
  const [busy, setBusy] = useState(false)
  const [qr, setQr] = useState<{ dataUrl: string; json: string } | null>(null)
  const [sas, setSas] = useState<string | null>(null)
  const [pairings, setPairings] = useState<Pairing[]>([])
  const [reconnecting, setReconnecting] = useState<string | null>(null)

  const refreshPairings = useCallback(() => {
    void listPairings().then(setPairings)
  }, [])

  useEffect(() => {
    refreshPairings()
  }, [refreshPairings])

  const startPairing = async () => {
    clear()
    setQr(null)
    setSas(null)
    setBusy(true)
    await runClientPairing(signalUrl, {
      onStatus: push,
      onQrReady: (payload: QRPayload, dataUrl) => setQr({ dataUrl, json: JSON.stringify(payload, null, 2) }),
      onSas: setSas,
      onPaired: () => refreshPairings(),
      onError: (msg) => push(`error: ${msg}`),
    })
    setBusy(false)
  }

  const reconnect = async (depotId: string) => {
    clear()
    setReconnecting(depotId)
    await runClientReconnect(signalUrl, depotId, {
      onStatus: push,
      onConnected: ({ pingRoundtripOk }) =>
        push(`reconnected — session key check ${pingRoundtripOk ? 'passed' : 'skipped'}`),
      onError: (msg) => push(`error: ${msg}`),
    })
    setReconnecting(null)
  }

  return (
    <div className="panel">
      <h2>Client</h2>
      <p className="hint">This is the browser session that ends up holding a credential for a Depot.</p>

      <button onClick={() => void startPairing()} disabled={busy}>
        {busy ? 'Pairing…' : 'Start pairing'}
      </button>

      {qr && (
        <div className="qr">
          <img src={qr.dataUrl} alt="pairing QR code" width={220} height={220} />
          <details>
            <summary>No camera in a browser tab — copy this into the Depot simulator instead</summary>
            <pre>{qr.json}</pre>
          </details>
        </div>
      )}

      {sas && (
        <div className="sas">
          <p>Compare this code with the Depot. It must match exactly.</p>
          <div className="sas-code">{sas}</div>
        </div>
      )}

      <h3>Paired Depots</h3>
      {pairings.length === 0 ? (
        <p className="hint">None yet — pair with a Depot above.</p>
      ) : (
        <ul className="entity-list">
          {pairings.map((p) => (
            <li key={p.depotId}>
              <code title={p.depotId}>{p.depotId.slice(0, 16)}…</code>
              <button onClick={() => void reconnect(p.depotId)} disabled={reconnecting === p.depotId}>
                {reconnecting === p.depotId ? 'Reconnecting…' : 'Reconnect'}
              </button>
            </li>
          ))}
        </ul>
      )}

      <Log lines={lines} />
    </div>
  )
}
