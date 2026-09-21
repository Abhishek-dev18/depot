import { useCallback, useEffect, useRef, useState } from 'react'
import type { DepotConnection } from '../pairing/clientReconnect'
import type { DirEntry } from '../transport/transferSession'
import { formatBytes, formatDay, nowMs } from '../format'
import { heldFor, keyFor, type HeldFile } from '../heldFiles'
import { describePreview, previewBlockedReason } from '../preview'
import { listCachedFiles, putCachedFile } from '../storage/fileCache'
import { Dialog } from './Dialog'
import { PreviewOverlay } from './PreviewOverlay'
import { TransferCard, type TransferState } from './TransferCard'

/**
 * One file this browser was asked to send to the Depot (§5.10).
 *
 * `storedAs` is what the Depot actually called it, which is not always
 * what was offered — it never overwrites, so a name already taken comes
 * back with something appended.
 */
interface Outgoing {
  id: number
  name: string
  size: number
  to: string
  state: 'waiting' | 'sending' | 'sent' | 'failed'
  storedAs?: string
  error?: string
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
  const [received, setReceived] = useState<HeldFile[]>([])
  const [pending, setPending] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState<string | null>(null)
  // The refusal dialog for a file too large to draw in a tab.
  const [uploading, setUploading] = useState<TransferState | null>(null)
  /**
   * What has been handed to this browser to send, and how each one went.
   *
   * Kept for the session rather than cleared as each finishes: the
   * mirror of the phone's SHARED list, where what you picked stays on
   * screen so you can see what you sent and what it was called at the
   * other end. A Depot never overwrites, so the name it chose is often
   * not the one that was offered, and that is worth saying once rather
   * than leaving to be discovered.
   */
  const [outbox, setOutbox] = useState<Outgoing[]>([])
  const [sendTo, setSendTo] = useState<string | null>(null)
  const [refused, setRefused] = useState<{ title: string; body: string; action?: { label: string; onClick: () => void } } | null>(null)

  // The refresh callbacks fire from outside React and must not capture a
  // stale trail, so the current one is kept in a ref alongside the state.
  const trailRef = useRef<DirEntry[]>([])
  useEffect(() => {
    trailRef.current = trail
  }, [trail])

  // Same reason as the trail above: fetchFile runs outside a render and
  // needs to know what is already held without listing `received` as a
  // dependency, which would rebuild it on every arrival.
  const receivedRef = useRef<HeldFile[]>([])
  useEffect(() => {
    receivedRef.current = received
  }, [received])

  const urlsRef = useRef<string[]>([])
  useEffect(
    () => () => {
      for (const url of urlsRef.current) URL.revokeObjectURL(url)
    },
    [],
  )

  // What previous visits left behind. Without this a reload throws away
  // files that are sitting in the browser's own storage, and the user
  // pays the phone's data to fetch them a second time.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const cached = await listCachedFiles()
      if (cancelled || cached.length === 0) return
      const restored = cached.map((file) => {
        const url = URL.createObjectURL(file.blob)
        urlsRef.current.push(url)
        return {
          key: file.key,
          name: file.name,
          size: file.size,
          modifiedAt: file.modifiedAt,
          mime: file.mime,
          blob: file.blob,
          url,
          persisted: true,
        }
      })
      setReceived((prev) => [...restored.filter((r) => !prev.some((p) => p.key === r.key)), ...prev])
    })()
    return () => {
      cancelled = true
    }
  }, [])

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

  /*
   * The first listing, once per session.
   *
   * Deliberately not routed through open(): an effect must not set state
   * synchronously, and it should drop its result if the component goes
   * away mid-request.
   *
   * Its dependencies must all be stable, which is why ClientView hands
   * this component memoised callbacks. They were not, and re-running
   * this effect calls setTrail([]) — so it was silently a "go back to
   * the root" button wired to anything that caused a render: a progress
   * tick, a log line, an upload finishing. Invisible until there was a
   * folder to be thrown out of.
   */
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
  const refresh = useCallback(async (): Promise<DirEntry[] | null> => {
    const handle = trailRef.current.length === 0 ? '' : trailRef.current[trailRef.current.length - 1].handle
    try {
      const listed = await session.list(handle)
      setEntries(listed)
      if (trailRef.current.length === 0) setRoots(listed)
      return listed
    } catch {
      // A failed refresh leaves what is already shown; the connection
      // watcher is what notices if the session itself is gone.
      return null
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

  const fetchFile = useCallback(
    async (entry: DirEntry) => {
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
        // Keyed from the listing row, never from the manifest.
        //
        // The key's whole job is to be computable before anything has
        // been fetched, so that a listing can be matched against what is
        // already held. Mixing in the manifest's name meant a Depot
        // whose two names differ by so much as a space stored a key that
        // could never be looked up again — every click a fresh transfer,
        // and a RECEIVED list that grew a duplicate each time.
        const key = keyFor(entry)
        const persisted = await putCachedFile({
          key,
          name: file.name,
          size: file.size,
          modifiedAt: entry.modifiedAt,
          mime: entry.mime,
          blob: file.blob,
          receivedAt: nowMs(),
        })
        const held: HeldFile = {
          key,
          name: file.name,
          size: file.size,
          modifiedAt: entry.modifiedAt,
          mime: entry.mime,
          blob: file.blob,
          url,
          persisted,
        }
        // A re-fetch replaces the copy it supersedes rather than sitting
        // beside it: two rows with one name and different bytes is a
        // question nobody can answer from the outside.
        // Handing back the superseded copy's save URL happens here and
        // not inside the updater below. React may call an updater more
        // than once and does so in development on purpose, to catch one
        // that is doing something other than working out the next state
        // — which is how the preview came to be pointed at a handle that
        // had already been given back.
        const previous = receivedRef.current.find((f) => f.key === key)
        if (previous) {
          URL.revokeObjectURL(previous.url)
          urlsRef.current = urlsRef.current.filter((u) => u !== previous.url)
        }
        setReceived((prev) => [held, ...prev.filter((f) => f.key !== key)])
        log(
          persisted
            ? `${file.name} verified against the manifest and whole-file hash, and kept`
            : `${file.name} verified — too large to keep, so a reload will need it again`,
        )
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err))
      } finally {
        setTransfer(null)
        setPending(null)
      }
    },
    [session, log, onError],
  )

  /**
   * Clicking a file.
   *
   * A file already in hand is opened, not asked for again: the bytes are
   * here, and re-fetching would spend the phone's battery and both ends'
   * data to arrive at what the browser is already holding. Only a listing
   * that disagrees with the held copy sends it back over the wire.
   */
  /** Why this file cannot be drawn, or null. Size is known from the listing. */
  const blockedReason = (file: { name: string; size?: number; mime?: string }): string | null =>
    previewBlockedReason(describePreview(file.name, file.mime), file.size ?? 0)

  /** Bring it over and say nothing more — the FETCH action on a row. */
  const fetchOnly = async (entry: DirEntry) => {
    if (pending || heldFor(received, entry)) return
    await fetchFile(entry)
  }

  /**
   * Clicking the file itself: bring it over and open it.
   *
   * The two actions are one code path with different endings, which is
   * the point — fetching is fetching, and whether a preview follows is a
   * property of the click, not of the transfer.
   */
  const fetchAndPreview = async (entry: DirEntry) => {
    if (pending) return
    const reason = blockedReason(entry)
    if (reason !== null) {
      const held = heldFor(received, entry)
      setRefused({
        title: 'Too large to preview',
        body: reason,
        action: held
          ? undefined
          : { label: 'Fetch it anyway', onClick: () => void fetchFile(entry) },
      })
      return
    }
    const held = heldFor(received, entry)
    if (held) {
      setPreviewing(held.key)
      return
    }
    await fetchFile(entry)
    // Opened by key rather than by the returned value: fetchFile owns the
    // received list, and reading it back is what keeps one source of truth.
    setPreviewing(keyFor(entry))
  }

  /** PREVIEW in the lower list, which never goes back to the Depot. */
  const previewHeld = (file: HeldFile) => {
    const reason = blockedReason(file)
    if (reason !== null) {
      setRefused({ title: 'Too large to preview', body: reason })
      return
    }
    setPreviewing(file.key)
  }

  /**
   * Ask for it again anyway.
   *
   * The only escape from a Depot that reports neither a size nor a
   * modification time: with nothing to compare, a changed file keeps the
   * same key and the held copy would otherwise stand forever.
   */
  const refetch = async (key: string) => {
    if (pending) return
    setPreviewing(null)
    // Re-read the listing first, so the copy that comes back is recorded
    // under the Depot's current figures rather than remembered ones.
    const listed = await refresh()
    const entry = listed?.find((e) => e.kind === 'file' && keyFor(e) === key)
    if (!entry) {
      onError('that file is no longer in this listing')
      return
    }
    // Dropped first, so the fetch is not short-circuited by the very copy
    // it is meant to replace.
    setReceived((prev) => prev.filter((f) => f.key !== key))
    await fetchFile(entry)
  }

  /**
   * §5.10 — the one direction that writes.
   *
   * Offered only where the Depot said `writable`, which is a statement
   * of intent and not an authorisation: the Depot checks the grant again
   * when the PUT lands, so the worst this can do is ask and be refused.
   */
  const uploadHere = trail.length > 0 && trail[trail.length - 1].writable === true
  const destination = uploadHere ? trail[trail.length - 1] : undefined

  /**
   * Everywhere this Depot has said it will accept a file.
   *
   * Read from the root listing rather than from wherever the user has
   * browsed to, because sending should not require finding the right
   * folder first — the phone's half of this is one button, and so is
   * this. `writable` is a statement of intent and not an authorisation:
   * the Depot checks the grant again when the PUT lands, so the worst
   * this can do is ask somewhere it will be refused.
   */
  const destinations = roots.filter((entry) => entry.kind === 'dir' && entry.writable === true)
  const sendTarget =
    destinations.find((d) => d.handle === sendTo) ?? (destinations.length > 0 ? destinations[0] : undefined)

  /**
   * Hands several files over at once, sent one after another.
   *
   * In sequence rather than together: two uploads racing share one data
   * channel and one pair of hands at the other end, so they would take
   * the same total time while each looked stuck.
   */
  const sendAll = async (files: FileList | null) => {
    const picked = [...(files ?? [])]
    if (picked.length === 0 || !sendTarget) return
    const to = sendTarget
    const queued: Outgoing[] = picked.map((file, i) => ({
      id: nowMs() + i,
      name: file.name,
      size: file.size,
      to: to.name,
      state: 'waiting',
    }))
    setOutbox((prev) => [...queued, ...prev])

    for (const [i, file] of picked.entries()) {
      const id = queued[i].id
      const mark = (patch: Partial<Outgoing>) =>
        setOutbox((prev) => prev.map((o) => (o.id === id ? { ...o, ...patch } : o)))
      mark({ state: 'sending' })
      try {
        await uploadOne(file, to)
        // uploadOne logs the name it was stored under; read it back from
        // there rather than duplicating the rule about renaming.
        mark({ state: 'sent', storedAs: lastStoredRef.current ?? file.name })
      } catch (err) {
        mark({ state: 'failed', error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  /** What the Depot called the file it most recently accepted. */
  const lastStoredRef = useRef<string | null>(null)

  const uploadOne = async (file: File, to: DirEntry): Promise<void> => {
    const startedAt = nowMs()
    setUploading({ name: file.name, bytesReceived: 0, bytesTotal: file.size, startedAt, updatedAt: startedAt })
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const stored = await session.send(
        to.handle,
        { name: file.name, bytes, mime: file.type || undefined },
        (e) => {
          if (e.type === 'chunk-sent') {
            setUploading((prev) =>
              prev === null
                ? prev
                : { ...prev, bytesReceived: e.bytesSent ?? prev.bytesReceived, updatedAt: nowMs() },
            )
          }
        },
      )
      lastStoredRef.current = stored
      // A Depot never overwrites, so what it stored may not be what was
      // asked for. Saying so beats letting someone find out later.
      log(
        stored === file.name
          ? `${stored} sent to ${to.name}`
          : `sent to ${to.name} as ${stored} — that name was taken`,
      )
      await refresh()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
      // Rethrown as well as reported: the queue needs to mark this one
      // failed and carry on with the rest.
      throw err
    } finally {
      setUploading(null)
    }
  }

  const rate =
    transfer && transfer.updatedAt > transfer.startedAt
      ? (transfer.bytesReceived * 1000) / (transfer.updatedAt - transfer.startedAt)
      : undefined

  useEffect(() => {
    onRate(rate)
  }, [rate, onRate])

  const previewFile = previewing === null ? undefined : received.find((f) => f.key === previewing)

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

          {uploadHere && (
            <div className="uprow">
              <label className={uploading ? 'upbtn busy' : 'upbtn'}>
                <input
                  type="file"
                  multiple
                  disabled={uploading !== null || pending !== null}
                  onChange={(e) => {
                    void sendAll(e.target.files)
                    // Cleared so the same file can be picked twice.
                    e.target.value = ''
                  }}
                />
                {uploading ? `SENDING ${uploading.name}` : `SEND A FILE TO ${destination?.name.toUpperCase()}`}
              </label>
              <span className="uphint">This folder accepts files. Nothing is overwritten.</span>
            </div>
          )}

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
              entries.map((entry) => {
                const held = heldFor(received, entry)
                const busy = pending === entry.handle
                // A held file opens from memory, so a transfer in flight
                // is no reason to make it unclickable.
                const frozen = pending !== null && held === undefined
                return (
                  <div key={entry.handle} className={busy ? 'fr fr-busy' : 'fr'}>
                    <button
                      className="fr-open"
                      onClick={() =>
                        entry.kind === 'dir' ? void open([...trail, entry]) : void fetchAndPreview(entry)
                      }
                      disabled={frozen}
                      title={
                        entry.kind === 'dir'
                          ? undefined
                          : held
                            ? 'Already in this browser — opens without asking the Depot again'
                            : 'Fetch it and open it'
                      }
                    >
                      <span className="n">
                        <i aria-hidden="true">{entry.kind === 'dir' ? '▤' : '▣'}</i>
                        <span className="fn">{entry.name}</span>
                      </span>
                      <span className="sz">{entry.kind === 'dir' ? '—' : formatBytes(entry.size ?? 0)}</span>
                      <span className="dt">{formatDay(entry.modifiedAt)}</span>
                    </button>
                    <div className="fr-act">
                      {entry.kind === 'dir' ? null : held ? (
                        <span className="held">✓ HELD</span>
                      ) : (
                        <button
                          className="fr-fetch"
                          onClick={() => void fetchOnly(entry)}
                          disabled={frozen}
                          title="Bring it over without opening it"
                        >
                          {busy ? 'FETCHING' : 'FETCH'}
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
          </div>

          {/*
            protocol.md §5.10, made a first-class action rather than
            something found by browsing.
            
            Sending used to appear only once you had navigated into a
            folder the Depot had marked writable, which meant the
            feature existed and could not be found. The phone's half of
            this is one button on its home screen; so is this.
          */}
          <div className="sendbox">
            <div className="sl">SEND TO DEPOT</div>
            {destinations.length === 0 ? (
              <p className="sendnote">
                This Depot is not accepting files. On the phone: <b>Shared folders</b>, pick a
                folder, then turn on <b>Accept files into this folder</b>. Granting a folder to
                read from is deliberately not the same question.
              </p>
            ) : (
              <>
                <div className="sendrow">
                  <label className={uploading ? 'upbtn busy' : 'upbtn'}>
                    <input
                      type="file"
                      multiple
                      disabled={uploading !== null || pending !== null}
                      onChange={(e) => {
                        void sendAll(e.target.files)
                        e.target.value = ''
                      }}
                    />
                    {uploading ? `SENDING ${uploading.name}` : 'CHOOSE FILES TO SEND'}
                  </label>
                  {destinations.length === 1 ? (
                    <span className="uphint">
                      Into <b>{sendTarget?.name}</b>. Nothing is ever overwritten.
                    </span>
                  ) : (
                    <label className="sendpick">
                      INTO{' '}
                      <select
                        value={sendTarget?.handle ?? ''}
                        onChange={(e) => setSendTo(e.target.value)}
                      >
                        {destinations.map((d) => (
                          <option key={d.handle} value={d.handle}>
                            {d.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
                {outbox.length > 0 && (
                  <div className="outbox">
                    {outbox.map((o) => (
                      <div key={o.id} className={`out-row out-${o.state}`}>
                        <span className="out-name" title={o.name}>
                          {o.name}
                        </span>
                        <span className="out-size">{formatBytes(o.size)}</span>
                        <span className="out-state">
                          {o.state === 'waiting' && `WAITING · ${o.to.toUpperCase()}`}
                          {o.state === 'sending' && `SENDING → ${o.to.toUpperCase()}`}
                          {o.state === 'sent' &&
                            (o.storedAs && o.storedAs !== o.name
                              ? `SENT AS ${o.storedAs} · THAT NAME WAS TAKEN`
                              : `SENT · IN ${o.to.toUpperCase()}`)}
                          {o.state === 'failed' && (o.error ?? 'FAILED')}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {received.length > 0 && (
            <div className="received">
              <div className="sl">RECEIVED · VERIFIED</div>
              {received.map((file) => {
                const reason = blockedReason(file)
                const kind = describePreview(file.name, file.mime).kind
                return (
                  <div key={file.key} className="received-row">
                    <span className="received-name" title={file.name}>
                      {file.name}
                    </span>
                    <span className="received-size">{formatBytes(file.size)}</span>
                    {/*
                      Shadowed, and deliberately not marked disabled in
                      any sense a machine reads. A disabled control
                      swallows its own click, so the question it provokes
                      — why can I not press this — would have nowhere to
                      be answered; and aria-disabled would tell a screen
                      reader the same lie, since this button does work.
                      It is dimmed to say "not what you want", and
                      pressing it explains why.
                    */}
                    <button
                      className={reason === null ? 'received-act' : 'received-act off'}
                      title={reason ?? undefined}
                      onClick={() => previewHeld(file)}
                    >
                      {kind === 'none' ? 'DETAILS' : 'PREVIEW'}
                    </button>
                    {/*
                      The only thing here that writes to the machine.
                      Everything above this line happens in the browser.
                    */}
                    <a className="received-act download" href={file.url} download={file.name}>
                      DOWNLOAD
                    </a>
                  </div>
                )
              })}
            </div>
          )}
        </div>

      {refused && (
        <Dialog
          title={refused.title}
          body={refused.body}
          action={refused.action}
          onClose={() => setRefused(null)}
        />
      )}
      {previewFile && (
        <PreviewOverlay
          file={previewFile}
          onClose={() => setPreviewing(null)}
          onRefetch={() => void refetch(previewFile.key)}
        />
      )}
      {transfer && <TransferCard transfer={transfer} />}
      {uploading && <TransferCard transfer={uploading} direction="up" />}
    </div>
  )
}
