import { useEffect, useState } from 'react'
import { PAIRING_QR_TTL_MS } from '../pairing/types'
import { formatClock } from '../format'
import { CopyButton } from './CopyButton'

interface Props {
  qr: { dataUrl: string; json: string } | null
  sas: string | null
  busy: boolean
  issuedAt: number | null
  onStart: () => void
}

/**
 * PAIR · AWAITING APPROVAL, as the interface spec draws it.
 *
 * The countdown is not decoration. §3.1 gives the payload a two-minute
 * life, and a code that has quietly expired looks exactly like a code that
 * is being ignored by the phone — the timer is what tells those apart.
 */
export function PairPanel({ qr, sas, busy, issuedAt, onStart }: Props) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (issuedAt === null) return
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [issuedAt])

  const remaining = issuedAt === null ? PAIRING_QR_TTL_MS : issuedAt + PAIRING_QR_TTL_MS - now
  const expired = remaining <= 0

  if (!qr) {
    return (
      <div className="pairwrap">
        <div className="qr qr-empty" aria-hidden="true">
          <div className="qr-placeholder" />
        </div>
        <div className="pairhead">
          <div className="pairttl">Link this browser to your Depot</div>
          <p className="pairsub">
            Your phone is the server. This browser holds nothing but a credential, and files pass
            between the two without touching anyone else&rsquo;s machine.
          </p>
        </div>
        <button className="btn-primary" onClick={onStart} disabled={busy}>
          {busy ? 'Starting…' : 'Show pairing code'}
        </button>
      </div>
    )
  }

  return (
    <div className="pairwrap">
      <div className={expired ? 'qr qr-expired' : 'qr'}>
        <img src={qr.dataUrl} alt="pairing QR code" width={200} height={200} />
        {expired && <div className="qr-veil">EXPIRED</div>}
      </div>

      <div className="pairhead">
        <div className="pairttl">{expired ? 'This code has expired' : 'Scan with your Depot'}</div>
        <p className="pairsub">
          {expired
            ? 'A pairing code is single-use and lives for two minutes. Start again for a fresh one.'
            : 'Open Depot on your phone and point it here. The code expires in two minutes.'}
        </p>
      </div>

      {sas && (
        <>
          <div className="sasweb">
            {sas.split('').map((digit, i) => (
              <b key={i}>{digit}</b>
            ))}
          </div>
          <div className="tick">CONFIRM THIS NUMBER MATCHES YOUR PHONE</div>
        </>
      )}

      {!sas &&
        (expired ? (
          <button className="btn-primary" onClick={onStart} disabled={busy}>
            Start again
          </button>
        ) : (
          <div className="tick">WAITING FOR THE PHONE · {formatClock(remaining)}</div>
        ))}

      <details className="pair-fallback">
        <summary>No camera on the phone? Paste this into it instead</summary>
        <div className="qr-json">
          <pre>{qr.json}</pre>
          <CopyButton text={qr.json} />
        </div>
      </details>
    </div>
  )
}
