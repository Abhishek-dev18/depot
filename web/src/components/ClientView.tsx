import { useCallback, useEffect, useRef, useState } from 'react'
import { useLog } from '../hooks/useLog'
import { runClientPairing } from '../pairing/clientPairing'
import { runClientReconnect } from '../pairing/clientReconnect'
import type { QRPayload } from '../pairing/types'
import { listPairings, type Pairing } from '../storage/pairings'
import type { TurnConfig } from '../transport/webrtc'
import { Badge } from './Badge'
import { Card } from './Card'
import { CopyButton } from './CopyButton'
import { ShieldIcon, LinkIcon } from './icons'
import { Log } from './Log'
import { ProgressBar } from './ProgressBar'

interface ReceivedFile {
  name: string
  size: number
  url: string
}

export function ClientView({ signalUrl, turnConfig }: { signalUrl: string; turnConfig?: TurnConfig }) {
  const { lines, push, clear } = useLog()
  const [busy, setBusy] = useState(false)
  const [qr, setQr] = useState<{ dataUrl: string; json: string } | null>(null)
  const [sas, setSas] = useState<string | null>(null)
  const [pairings, setPairings] = useState<Pairing[]>([])
  const [reconnecting, setReconnecting] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ index: number; total: number } | null>(null)
  const [received, setReceived] = useState<ReceivedFile | null>(null)
  const receivedUrlRef = useRef<string | null>(null)

  const refreshPairings = useCallback(() => {
    void listPairings().then(setPairings)
  }, [])

  useEffect(() => {
    refreshPairings()
  }, [refreshPairings])

  useEffect(
    () => () => {
      if (receivedUrlRef.current) URL.revokeObjectURL(receivedUrlRef.current)
    },
    [],
  )

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
    setProgress(null)
    if (receivedUrlRef.current) {
      URL.revokeObjectURL(receivedUrlRef.current)
      receivedUrlRef.current = null
    }
    setReceived(null)
    setReconnecting(depotId)
    await runClientReconnect(signalUrl, depotId, turnConfig, {
      onStatus: push,
      onConnected: () => push('reconnected'),
      onProgress: ({ index, total }) => setProgress({ index: index + 1, total }),
      onFileReceived: (file) => {
        const url = URL.createObjectURL(new Blob([file.bytes.slice()]))
        receivedUrlRef.current = url
        setReceived({ name: file.name, size: file.bytes.length, url })
      },
      onError: (msg) => push(`error: ${msg}`),
    })
    setReconnecting(null)
  }

  return (
    <div className="view">
      <p className="view-intro">This is the browser session that ends up holding a credential for a Depot.</p>

      <Card title="Pair with a Depot" subtitle="Generates a QR code the Depot scans (or, here, pastes)." icon={<ShieldIcon />}>
        <button onClick={() => void startPairing()} disabled={busy}>
          {busy && !qr ? 'Starting…' : 'Start pairing'}
        </button>

        {qr && (
          <div className="qr">
            <img src={qr.dataUrl} alt="pairing QR code" width={200} height={200} />
            <details>
              <summary>No camera in a browser tab — copy this into the Depot simulator instead</summary>
              <div className="qr-json">
                <pre>{qr.json}</pre>
                <CopyButton text={qr.json} />
              </div>
            </details>
          </div>
        )}

        {sas && (
          <div className="sas">
            <p>Compare this code with the Depot. It must match exactly.</p>
            <div className="sas-code">{sas}</div>
          </div>
        )}
      </Card>

      <Card title="Paired Depots" icon={<LinkIcon />}>
        {pairings.length === 0 ? (
          <p className="empty-state">None yet — pair with a Depot above.</p>
        ) : (
          <ul className="entity-list">
            {pairings.map((p) => (
              <li key={p.depotId}>
                <div className="entity-main">
                  <code title={p.depotId}>{p.depotId.slice(0, 16)}…</code>
                  <Badge tone="neutral">{p.depotLabel}</Badge>
                </div>
                <button onClick={() => void reconnect(p.depotId)} disabled={reconnecting === p.depotId}>
                  {reconnecting === p.depotId ? 'Reconnecting…' : 'Reconnect'}
                </button>
              </li>
            ))}
          </ul>
        )}

        {progress && !received && (
          <div className="transfer-status">
            <ProgressBar value={progress.index} total={progress.total} />
          </div>
        )}

        {received && (
          <div className="sas success">
            <p>
              Received <strong>{received.name}</strong> ({received.size.toLocaleString()} bytes) — verified against
              the manifest and whole-file hash.
            </p>
            <a className="download-link" href={received.url} download={received.name}>
              Download
            </a>
          </div>
        )}
      </Card>

      <Log lines={lines} />
    </div>
  )
}
