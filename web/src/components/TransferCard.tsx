import { formatBytes, formatEta, formatRate } from '../format'

export interface TransferState {
  name: string
  bytesReceived: number
  bytesTotal: number
  startedAt: number
  updatedAt: number
}

/**
 * `.xfer` — the floating transfer readout from the interface spec.
 *
 * Rate and ETA are averages over the transfer so far rather than an
 * instantaneous reading: a per-chunk figure on an SCTP channel swings
 * wildly enough to be unreadable, and the number people actually want is
 * "how long until this is done".
 */
export function TransferCard({
  transfer,
  direction = 'down',
}: {
  transfer: TransferState
  /** Up is §5.10; the readout is the same, the words are not. */
  direction?: 'down' | 'up'
}) {
  const { bytesReceived, bytesTotal, startedAt, updatedAt } = transfer
  const elapsed = Math.max(1, updatedAt - startedAt)
  const rate = (bytesReceived * 1000) / elapsed
  const remaining = Math.max(0, bytesTotal - bytesReceived)
  const percent = bytesTotal > 0 ? Math.min(100, Math.round((bytesReceived / bytesTotal) * 100)) : 0

  return (
    <div className="xfer">
      <div className={direction === 'up' ? 'xh xh-up' : 'xh'}>
        <div className="xt" title={transfer.name}>
          {direction === 'up' ? '↑ ' : ''}
          {transfer.name}
        </div>
        <div className="xp">{percent}%</div>
      </div>
      <div className="bar">
        <i style={{ width: `${percent}%` }} />
      </div>
      <div className="xm">
        <div>
          <b>{formatRate(rate)}</b>
        </div>
        <div>
          <b>{formatBytes(remaining)}</b> left
        </div>
        <div>
          <b>{formatEta(remaining, rate)}</b> eta
        </div>
      </div>
    </div>
  )
}
