import { useEffect, useRef } from 'react'

interface Props {
  title: string
  body: string
  /** The thing that can still be done, where there is one. */
  action?: { label: string; onClick: () => void }
  onClose: () => void
}

/**
 * A small modal for the one case that has to be refused before it starts.
 *
 * Used where an action is offered but cannot be carried out — a file too
 * large to draw in a tab. The refusal is never a dead end: whatever can
 * still be done with the file is offered here, so the answer to "why is
 * this greyed out" and "then what do I do" arrive together.
 */
export function Dialog({ title, body, action, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    closeRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="dlg" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="dlg-box" onClick={(e) => e.stopPropagation()}>
        <div className="dlg-title">{title}</div>
        <p className="dlg-body">{body}</p>
        <div className="dlg-actions">
          {action && (
            <button
              className="wnav-action dlg-go"
              onClick={() => {
                action.onClick()
                onClose()
              }}
            >
              {action.label}
            </button>
          )}
          <button ref={closeRef} className="wnav-action" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
