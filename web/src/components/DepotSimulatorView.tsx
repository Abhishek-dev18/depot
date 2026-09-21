import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLog } from '../hooks/useLog'
import { runDepotPairing } from '../pairing/depotPairing'
import { runDepotReconnectListener, type DepotReconnectListener } from '../pairing/depotReconnect'
import { listDevices, revokeDevice, type DeviceRecord } from '../storage/devices'
import { memoryInbox, offeredFilesSource, type OfferedFile } from '../transport/transferSession'
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
  // A list, because picking a second file should not un-share the first.
  const [offeredFiles, setOfferedFiles] = useState<Array<{ name: string; size: number }>>([])
  const offeredFilesRef = useRef<OfferedFile[]>([])

  // §5.10 — a folder this simulated Depot will accept uploads into, so
  // the direction that writes is exercisable in two browser tabs.
  const [inboxNames, setInboxNames] = useState<string[]>([])
  const inbox = useMemo(() => memoryInbox((files) => setInboxNames([...files.keys()])), [])

  // §5.9: a file landing in the inbox changes what a connected Client
  // would see. Driven from the state rather than from inside the store's
  // callback, so nothing reaches for a ref while rendering.
  useEffect(() => {
    if (inboxNames.length > 0) listenerRef.current?.notifySharedChanged()
  }, [inboxNames])
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

  /**
   * Adds every file picked, rather than replacing what is on offer.
   *
   * The same name and length is treated as the same file, so picking a
   * folder twice does not produce two of everything.
   */
  const chooseFiles = async (fileList: FileList | null) => {
    const picked = [...(fileList ?? [])]
    if (picked.length === 0) return
    const loaded: OfferedFile[] = []
    for (const file of picked) {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const already = offeredFilesRef.current.some(
        (f) => f.name === file.name && f.bytes.length === bytes.length,
      )
      if (!already) loaded.push({ name: file.name, bytes, mime: file.type || undefined })
    }
    if (loaded.length === 0) return
    offeredFilesRef.current = [...offeredFilesRef.current, ...loaded]
    setOfferedFiles(offeredFilesRef.current.map((f) => ({ name: f.name, size: f.bytes.length })))
    for (const f of loaded) push(`offering ${f.name} (${f.bytes.length.toLocaleString()} bytes)`)
    // §5.9: anyone already connected is now looking at a stale listing.
    listenerRef.current?.notifySharedChanged()
  }

  const stopOffering = (name: string, size: number) => {
    offeredFilesRef.current = offeredFilesRef.current.filter(
      (f) => !(f.name === name && f.bytes.length === size),
    )
    setOfferedFiles(offeredFilesRef.current.map((f) => ({ name: f.name, size: f.bytes.length })))
    push(`stopped offering ${name}`)
    listenerRef.current?.notifySharedChanged()
  }

  const startListening = async () => {
    if (listenerRef.current) return
    const l = await runDepotReconnectListener(
      signalUrl,
      offeredFilesSource(() => offeredFilesRef.current, inbox),
      turnConfig,
      {
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
      },
    )
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
          <input
            type="file"
            multiple
            onChange={(e) => {
              void chooseFiles(e.target.files)
              // Cleared so the same file can be picked again after it
              // has been removed.
              e.target.value = ''
            }}
          />
          <span>{offeredFiles.length === 0 ? 'Choose files' : 'Add more files'}</span>
        </label>
        {offeredFiles.length > 0 && (
          <ul className="offer-list">
            {offeredFiles.map((f) => (
              <li key={`${f.name}:${f.size}`}>
                {f.name} ({f.size.toLocaleString()} bytes){' '}
                <button className="linkish" onClick={() => stopOffering(f.name, f.size)}>
                  stop
                </button>
              </li>
            ))}
          </ul>
        )}

        {/*
          §5.10. The real Depot writes into a folder the user granted and
          marked writable; this is the same shape with a Map behind it.
        */}
        <p className="hint settings-section-label">
          Inbox — the one folder this Depot accepts files into. A real Depot asks for this per
          folder and the answer defaults to no.
        </p>
        {inboxNames.length === 0 ? (
          <p className="hint">Nothing has been sent up yet.</p>
        ) : (
          <ul className="inbox-list">
            {inboxNames.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
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
