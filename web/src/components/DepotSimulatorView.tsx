import { useCallback, useEffect, useRef, useState } from 'react'
import { useLog } from '../hooks/useLog'
import { runDepotPairing } from '../pairing/depotPairing'
import { runDepotReconnectListener, type DepotReconnectListener } from '../pairing/depotReconnect'
import { listDevices, revokeDevice, type DeviceRecord } from '../storage/devices'
import { singleFileSource, type OfferedFile } from '../transport/transferSession'
import type { ConnectionType, TurnConfig } from '../transport/webrtc'
import { Badge } from './Badge'
import { Card } from './Card'
import { ConnectionBadge } from './ConnectionBadge'
import { FolderIcon, LinkIcon, ShieldIcon } from './icons'
import { Log } from './Log'
import { ProgressBar } from './ProgressBar'
import { SasDisplay } from './SasDisplay'

interface ClientProgress {
  index: number
  total: number
  bytesSent?: number
  bytesTotal?: number
}

export function DepotSimulatorView({ signalUrl, turnConfig }: { signalUrl: string; turnConfig?: TurnConfig }) {
  const { lines, push, clear } = useLog()
  const [qrText, setQrText] = useState('')
  const [busy, setBusy] = useState(false)
  const [sas, setSas] = useState<{ code: string; approve: () => void } | null>(null)
  const [devices, setDevices] = useState<DeviceRecord[]>([])
  const [listener, setListener] = useState<DepotReconnectListener | null>(null)
  const listenerRef = useRef<DepotReconnectListener | null>(null)
  const [offeredFile, setOfferedFile] = useState<{ name: string; size: number } | null>(null)
  const offeredFileRef = useRef<OfferedFile | null>(null)
  const [progressByClient, setProgressByClient] = useState<Record<string, ClientProgress>>({})
  const [connectionByClient, setConnectionByClient] = useState<Record<string, ConnectionType>>({})

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
      onError: (msg) => {
        // A failed pairing must not leave a stale code on screen that the
        // user could still be comparing against.
        setSas(null)
        push(`error: ${msg}`)
      },
    })
    setBusy(false)
  }

  const chooseFile = async (fileList: FileList | null) => {
    const file = fileList?.[0]
    if (!file) return
    const bytes = new Uint8Array(await file.arrayBuffer())
    offeredFileRef.current = { name: file.name, bytes, mime: file.type || undefined }
    setOfferedFile({ name: file.name, size: bytes.length })
    push(`offering ${file.name} (${bytes.length.toLocaleString()} bytes)`)
    // §5.9: anyone already connected is now looking at a stale listing.
    listenerRef.current?.notifySharedChanged()
  }

  const startListening = async () => {
    if (listenerRef.current) return
    const l = await runDepotReconnectListener(signalUrl, singleFileSource(() => offeredFileRef.current), turnConfig, {
      onStatus: push,
      onRegistered: (id) => push(`registered as ${id.slice(0, 16)}…`),
      onClientConnected: ({ clientId, connectionType }) => {
        push(`client ${clientId.slice(0, 16)}… connected, data channel open`)
        setConnectionByClient((prev) => ({ ...prev, [clientId]: connectionType }))
        refreshDevices()
      },
      onClientProgress: ({ clientId, index, total, bytesSent, bytesTotal }) => {
        setProgressByClient((prev) => ({ ...prev, [clientId]: { index: index + 1, total, bytesSent, bytesTotal } }))
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
    <div className="view">
      <p className="view-intro">
        Stands in for the Android app so pairing, reconnection and file transfer can be tested end to end without
        it.
      </p>

      <Card title="Pair with a Client" subtitle="Paste the Client's QR JSON — a browser tab has no camera." icon={<ShieldIcon />}>
        <textarea
          value={qrText}
          onChange={(e) => setQrText(e.target.value)}
          rows={5}
          placeholder="Paste the QR payload JSON from the Client tab here"
        />
        <button onClick={() => void joinPairing()} disabled={busy || !qrText.trim()}>
          {busy ? 'Joining…' : 'Join pairing'}
        </button>

        {sas && (
          <div className="sas">
            <p className="sas-question">Does the Client show this number?</p>
            <SasDisplay code={sas.code} />
            <p className="sas-warn">If the numbers differ, someone may be intercepting the connection.</p>
            <button
              className="primary"
              onClick={() => {
                sas.approve()
                setSas(null)
              }}
            >
              Approve
            </button>
          </div>
        )}
      </Card>

      <Card title="File to offer" subtitle="Whatever is selected here is what a reconnecting Client receives." icon={<FolderIcon />}>
        <label className="file-picker">
          <input type="file" onChange={(e) => void chooseFile(e.target.files)} />
          <span>{offeredFile ? 'Choose a different file' : 'Choose a file'}</span>
        </label>
        {offeredFile && (
          <p className="hint">
            Offering <strong>{offeredFile.name}</strong> ({offeredFile.size.toLocaleString()} bytes)
          </p>
        )}
      </Card>

      <Card title="Reconnection listener" icon={<LinkIcon />}>
        {listener ? (
          <>
            <div className="pulse">
              <i />
              Accepting connections
            </div>
            <p className="hint">
              Listening as <code title={listener.depotId}>{listener.depotId.slice(0, 16)}…</code>
            </p>
            <button onClick={stopListening}>Stop listening</button>
          </>
        ) : (
          <button onClick={() => void startListening()}>Start listening</button>
        )}
      </Card>

      <Card title="Paired devices" icon={<LinkIcon />}>
        {devices.length === 0 ? (
          <p className="empty-state">None yet.</p>
        ) : (
          <ul className="entity-list">
            {devices.map((d) => {
              const clientProgress = progressByClient[d.clientIdentityPub]
              const connectionType = connectionByClient[d.clientIdentityPub]
              return (
                <li key={d.clientIdentityPub}>
                  <div className="entity-icon">▣</div>
                  <div className="entity-main">
                    <code title={d.clientIdentityPub}>{d.clientIdentityPub.slice(0, 16)}…</code>
                    {clientProgress && !d.revoked && (
                      <ProgressBar
                        value={clientProgress.index}
                        total={clientProgress.total}
                        bytesDone={clientProgress.bytesSent}
                        bytesTotal={clientProgress.bytesTotal}
                      />
                    )}
                  </div>
                  <div className="entity-actions">
                    {d.revoked ? (
                      <Badge tone="danger">Revoked</Badge>
                    ) : (
                      <>
                        {connectionType && <ConnectionBadge type={connectionType} />}
                        <button onClick={() => void revoke(d.clientIdentityPub)}>Revoke</button>
                      </>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      <Log lines={lines} />
    </div>
  )
}
