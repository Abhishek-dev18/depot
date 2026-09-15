import { useCallback, useEffect, useRef, useState } from 'react'
import { useLog } from '../hooks/useLog'
import { runDepotPairing } from '../pairing/depotPairing'
import { runDepotReconnectListener, type DepotReconnectListener } from '../pairing/depotReconnect'
import { listDevices, revokeDevice, type DeviceRecord } from '../storage/devices'
import type { OfferedFile } from '../transport/transferSession'
import type { TurnConfig } from '../transport/webrtc'
import { Badge } from './Badge'
import { Card } from './Card'
import { FolderIcon, LinkIcon, ShieldIcon } from './icons'
import { Log } from './Log'
import { ProgressBar } from './ProgressBar'

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
  const [progressByClient, setProgressByClient] = useState<Record<string, { index: number; total: number }>>({})

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

  const chooseFile = async (fileList: FileList | null) => {
    const file = fileList?.[0]
    if (!file) return
    const bytes = new Uint8Array(await file.arrayBuffer())
    offeredFileRef.current = { name: file.name, bytes }
    setOfferedFile({ name: file.name, size: bytes.length })
    push(`offering ${file.name} (${bytes.length.toLocaleString()} bytes)`)
  }

  const startListening = async () => {
    if (listenerRef.current) return
    const l = await runDepotReconnectListener(signalUrl, () => offeredFileRef.current, turnConfig, {
      onStatus: push,
      onRegistered: (id) => push(`registered as ${id.slice(0, 16)}…`),
      onClientConnected: ({ clientId }) => {
        push(`client ${clientId.slice(0, 16)}… connected, data channel open`)
        refreshDevices()
      },
      onClientProgress: ({ clientId, index, total }) => {
        setProgressByClient((prev) => ({ ...prev, [clientId]: { index: index + 1, total } }))
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
            <p>Compare this code with the Client. Only approve if it matches exactly.</p>
            <div className="sas-code">{sas.code}</div>
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
            <p className="hint">
              <Badge tone="success">Listening</Badge>{' '}
              as <code title={listener.depotId}>{listener.depotId.slice(0, 16)}…</code>
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
            {devices.map((d) => (
              <li key={d.clientIdentityPub}>
                <div className="entity-main">
                  <code title={d.clientIdentityPub}>{d.clientIdentityPub.slice(0, 16)}…</code>
                  {d.revoked && <Badge tone="danger">Revoked</Badge>}
                  {progressByClient[d.clientIdentityPub] && !d.revoked && (
                    <ProgressBar
                      value={progressByClient[d.clientIdentityPub].index}
                      total={progressByClient[d.clientIdentityPub].total}
                    />
                  )}
                </div>
                {!d.revoked && <button onClick={() => void revoke(d.clientIdentityPub)}>Revoke</button>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Log lines={lines} />
    </div>
  )
}
