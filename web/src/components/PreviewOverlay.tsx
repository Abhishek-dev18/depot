import { useEffect, useMemo, useRef, useState } from 'react'
import { formatBytes } from '../format'
import type { HeldFile } from '../heldFiles'
import { TEXT_PREVIEW_LIMIT, describePreview, retype } from '../preview'

interface Props {
  file: HeldFile
  onClose: () => void
  /** Ask the Depot for it again, for when the held copy is not what is wanted. */
  onRefetch: () => void
}

/**
 * A look at a file that already arrived, without asking for it twice.
 *
 * The preview URL is its own object URL, separate from the row's save
 * URL, because it points at a re-typed view of the same bytes — see
 * preview.ts for why the type is asserted rather than sniffed. It is
 * revoked when this closes; the save URL outlives it.
 */
export function PreviewOverlay({ file, onClose, onRefetch }: Props) {
  const preview = describePreview(file.name)
  const [text, setText] = useState<string | null>(null)
  const [unreadable, setUnreadable] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)

  // Derived from the file, not stored: an object URL is a handle the
  // render needs immediately, and putting it in state would mean one
  // render with nothing to show followed by another with the picture.
  // The effect below exists only to give it back.
  const url = useMemo(
    () =>
      preview.kind === 'none' || preview.kind === 'text'
        ? null
        : URL.createObjectURL(retype(file.blob, preview.mime)),
    [file.blob, preview.kind, preview.mime],
  )
  useEffect(() => {
    if (url === null) return
    return () => URL.revokeObjectURL(url)
  }, [url])

  // Whether it is worth reading at all is a fact about the file, so it is
  // worked out while rendering rather than discovered by an effect.
  const tooLarge = preview.kind === 'text' && file.size > TEXT_PREVIEW_LIMIT

  useEffect(() => {
    if (preview.kind !== 'text' || tooLarge) return
    let cancelled = false
    void file.blob.text().then(
      (body) => {
        if (!cancelled) setText(body)
      },
      () => {
        if (!cancelled) setUnreadable(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [file.blob, preview.kind, tooLarge])

  // Escape closes, and focus starts on the close button, so the overlay
  // can be dismissed without reaching for the mouse.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    closeRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="pv"
      role="dialog"
      aria-modal="true"
      aria-label={`Preview of ${file.name}`}
      // A click on the backdrop dismisses; a click on the panel must not
      // bubble up and dismiss it from underneath itself.
      onClick={onClose}
    >
      <div className="pv-panel" onClick={(e) => e.stopPropagation()}>
        <div className="pv-bar">
          <span className="pv-tag">RECEIVED</span>
          <span className="pv-name" title={file.name}>
            {file.name}
          </span>
          <span className="pv-size">{formatBytes(file.size)}</span>
          {!file.persisted && (
            <span className="pv-note" title="Too large to keep — it will need fetching again after a reload">
              NOT KEPT
            </span>
          )}
          <a className="pv-act" href={file.url} download={file.name}>
            SAVE
          </a>
          <button className="pv-act pv-act-quiet" onClick={onRefetch}>
            FETCH AGAIN
          </button>
          <button ref={closeRef} className="pv-close" onClick={onClose} aria-label="Close preview">
            ✕
          </button>
        </div>

        <div className={`pv-body pv-body-${preview.kind}`}>
          {preview.kind === 'image' && url && <img src={url} alt={file.name} />}

          {preview.kind === 'video' && url && (
            <video src={url} controls preload="metadata">
              <track kind="captions" />
            </video>
          )}

          {preview.kind === 'audio' && url && <audio src={url} controls />}

          {/* The only framed kind, and deliberately not sandboxed — see
              preview.ts. The asserted type is what keeps a document from
              running here; a sandbox attribute adds nothing to that and
              breaks the browser's PDF viewer completely. */}
          {preview.kind === 'pdf' && url && <iframe className="pv-frame" src={url} title={file.name} />}

          {preview.kind === 'text' && tooLarge && (
            <div className="pv-none">
              <b>Too large to show here.</b>
              <span>{formatBytes(file.size)} of text. Save it and open it in an editor.</span>
            </div>
          )}

          {preview.kind === 'text' && !tooLarge && unreadable && (
            <div className="pv-none">
              <b>Not readable as text.</b>
              <span>The name says text but the bytes disagree. Save it to look properly.</span>
            </div>
          )}

          {preview.kind === 'text' && !tooLarge && !unreadable && text !== null && (
            <pre className="pv-text">{text}</pre>
          )}

          {preview.kind === 'text' && !tooLarge && !unreadable && text === null && (
            <div className="pv-none">Reading…</div>
          )}

          {preview.kind === 'none' && (
            <div className="pv-none">
              <b>No preview for this kind of file.</b>
              <span>It is here and verified — save it to open it in something that knows how.</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
