import { useCallback, useEffect, useRef, useState } from 'react'
import type { DepotConnection } from '../pairing/clientReconnect'
import type { DirEntry } from '../transport/transferSession'
import { formatBytes, formatDay, nowMs } from '../format'
import { TransferCard, type TransferState } from './TransferCard'

interface ReceivedFile {
  name: string
  size: number
  url: string
}

interface Props {
  session: DepotConnection
  depotLabel: string
  onSettings: () => void
  onError: (message: string) => void
  log: (line: string) => void
  /** Reported upward so the nav above can show live throughput. */
  onRate: (bytesPerSecond: number | undefined) => void
}

/**
 * FILES · BROWSE & TRANSFER (§5.9).
 *
 * Every row here came from a handle the Depot minted, so the breadcrumb is
 * a trail of things the phone chose to mention rather than a path this
 * browser composed. There is nothing to sanitise because there is nothing
 * to construct.
 */
export function FilesPanel({ session, depotLabel, onSettings, onError, log, onRate }: Props) {
  const [roots, setRoots] = useState<DirEntry[]>([])
  const [trail, setTrail] = useState<DirEntry[]>([])
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [transfer, setTransfer] = useState<TransferState | null>(null)
  const [received, setReceived] = useState<ReceivedFile[]>([])
  const [pending, setPending] = useState<string | null>(null)

  // The refresh callbacks fire from outside React and must not capture a
  // stale trail, so the current one is kept in a ref alongside the state.
  const trailRef = useRef<DirEntry[]>([])
  useEffect(() => {
    trailRef.current = trail
  }, [trail])

  const urlsRef = useRef<string[]>([])
  useEffect(
    () => () => {
      for (const url of urlsRef.current) URL.revokeObjectURL(url)
    },
    [],
  )

  const open = useCallback(
    async (next: DirEntry[]) => {
      const handle = next.length === 0 ? '' : next[next.length - 1].handle
      setLoading(true)
      try {
        const listed = await session.list(handle)
        setTrail(next)
        setEntries(listed)
        if (next.length === 0) setRoots(listed)
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    },
    [session, onError],
  )

  // The first listing is deliberately not routed through open(): an
  // effect must not set state synchronously, and it should drop its result
  // if the component goes away mid-request.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const listed = await session.list('')
        if (cancelled) return
        setRoots(listed)
        setEntries(listed)
        setTrail([])
      } catch (err) {
        if (!cancelled) onError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [session, onError])

  /**
   * Re-reads whatever is on screen, without the spinner.
   *
   * Used for the Depot saying its shared set changed and for coming back
   * to the tab — both cases where the listing is quietly stale, and
   * showing "Listing…" over content that is about to be almost identical
   * would be a worse lie than the staleness.
   */
  const refresh = useCallback(async () => {
    const handle = trailRef.current.length === 0 ? '' : trailRef.current[trailRef.current.length - 1].handle
    try {
      const listed = await session.list(handle)
      setEntries(listed)
      if (trailRef.current.length === 0) setRoots(listed)
    } catch {
      // A failed refresh leaves what is already shown; the connection
      // watcher is what notices if the session itself is gone.
    }
  }, [session])

  // The Depot pushes §5.9's SHARED_CHANGED when a grant or the offered
  // file changes. Without this the browser shows what was true at the
  // moment it connected, which is what made a newly shared file appear
  // only after a reload.
  useEffect(() => session.onChanged(() => void refresh()), [session, refresh])

  // A tab that was in the background may have missed one. §5.9 is
  // explicit that the notice is advisory, so this is the safety net.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [refresh])

  const download = async (entry: DirEntry) => {
    if (pending) return
    setPending(entry.handle)
    const startedAt = nowMs()
    setTransfer({ name: entry.name, bytesReceived: 0, bytesTotal: entry.size ?? 0, startedAt, updatedAt: startedAt })
    try {
      const file = await session.fetch(entry.handle, (e) => {
        if (e.type === 'chunk-received') {
          setTransfer((prev) =>
            prev === null
              ? prev
              : {
                  ...prev,
                  bytesReceived: e.bytesReceived ?? prev.bytesReceived,
                  bytesTotal: e.bytesTotal ?? prev.bytesTotal,
                  updatedAt: nowMs(),
                },
          )
        }
        if (e.type === 'resumed') log(`resuming — ${e.index} of ${e.total} chunk(s) already held`)
        if (e.type === 'chunk-invalid') log(`chunk ${e.index} failed verification, dropped`)
      })
      const url = URL.createObjectURL(file.blob)
      urlsRef.current.push(url)
      setReceived((prev) => [{ name: file.name, size: file.size, url }, ...prev])
      log(`${file.name} verified against the manifest and whole-file hash`)
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setTransfer(null)
      setPending(null)
    }
  }

  const rate =
    transfer && transfer.updatedAt > transfer.startedAt
      ? (transfer.bytesReceived * 1000) / (transfer.updatedAt - transfer.startedAt)
      : undefined

  useEffect(() => {
    onRate(rate)
  }, [rate, onRate])

  return (
    <div className="wbody">
        <nav className="side">
          <div className="sl" title={session.depotId}>
            {depotLabel.toUpperCase()}
          </div>
          {roots.length === 0 && !loading && <div className="si si-empty">Nothing shared</div>}
          {roots.map((root) => {
            const active = trail.length > 0 && trail[0].handle === root.handle
            return (
              <button
                key={root.handle}
                className={active ? 'si on' : 'si'}
                onClick={() => void open([root])}
              >
                <i aria-hidden="true">{root.kind === 'dir' ? '▤' : '▣'}</i>
                <span className="si-name">{root.name}</span>
                {root.count !== undefined && <span className="c">{root.count}</span>}
              </button>
            )
          })}

          <div className="sl sl-gap">SESSION</div>
          <div className="si si-static">
            <i aria-hidden="true">◱</i>
            <span className="si-name">Transfers</span>
            <span className="c">{received.length}</span>
          </div>
          <button className="si" onClick={onSettings}>
            <i aria-hidden="true">⚙</i>
            <span className="si-name">Settings</span>
          </button>
        </nav>

        <div className="main">
          <div className="crumb">
            <button className="crumb-link" onClick={() => void open([])}>
              {depotLabel.toUpperCase()}
            </button>
            {trail.map((entry, i) => (
              <span key={entry.handle}>
                {' / '}
                {i === trail.length - 1 ? (
                  <b>{entry.name}</b>
                ) : (
                  <button className="crumb-link" onClick={() => void open(trail.slice(0, i + 1))}>
                    {entry.name}
                  </button>
                )}
              </span>
            ))}
          </div>

          <div className="ftable">
            <div className="fh">
              <div>NAME</div>
              <div>SIZE</div>
              <div>MODIFIED</div>
            </div>
            {loading && <div className="fr fr-note">Listing…</div>}
            {!loading && entries.length === 0 && (
              <div className="fr fr-note">
                {trail.length === 0
                  ? 'This Depot is not sharing anything yet. Choose a file on the phone.'
                  : 'Empty.'}
              </div>
            )}
            {!loading &&
              entries.map((entry) => (
                <button
                  key={entry.handle}
                  className={pending === entry.handle ? 'fr fr-busy' : 'fr'}
                  onClick={() => (entry.kind === 'dir' ? void open([...trail, entry]) : void download(entry))}
                  disabled={pending !== null}
                >
                  <div className="n">
                    <i aria-hidden="true">{entry.kind === 'dir' ? '▤' : '▣'}</i>
                    {entry.name}
                  </div>
                  <div className="sz">{entry.kind === 'dir' ? '—' : formatBytes(entry.size ?? 0)}</div>
                  <div className="dt">{formatDay(entry.modifiedAt)}</div>
                </button>
              ))}
          </div>

          {received.length > 0 && (
            <div className="received">
              <div className="sl">RECEIVED · VERIFIED</div>
              {received.map((file, i) => (
                <a key={`${file.name}-${i}`} className="received-row" href={file.url} download={file.name}>
                  <span className="received-name">{file.name}</span>
                  <span className="received-size">{formatBytes(file.size)}</span>
                  <span className="received-save">Save</span>
                </a>
              ))}
            </div>
          )}
        </div>

      {transfer && <TransferCard transfer={transfer} />}
    </div>
  )
}

