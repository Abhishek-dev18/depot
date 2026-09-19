import type { ConnectionType } from '../transport/webrtc'
import { formatRate } from '../format'

const LABEL: Record<ConnectionType, string> = {
  direct: 'DIRECT',
  relayed: 'RELAYED',
  unknown: 'CONNECTED',
}

/**
 * `.conn` — the interface spec is firm that this is never hidden: a
 * relayed path means bytes are crossing a third machine, and a privacy
 * tool that quietly stopped saying so would be undercutting its own claim.
 *
 * Throughput joins it only while something is actually moving. A standing
 * "0 B/s" would be a claim about the link rather than about the transfer.
 */
export function ConnectionBadge({ type, rate }: { type: ConnectionType; rate?: number }) {
  return (
    <span className={`conn conn-${type}`}>
      <i />
      {LABEL[type]}
      {rate !== undefined && rate > 0 && ` · ${formatRate(rate)}`}
    </span>
  )
}

/** The same badge shape for a connection that does not exist. */
export function NoRouteBadge({ label = 'NO ROUTE' }: { label?: string }) {
  return (
    <span className="conn conn-none">
      <i />
      {label}
    </span>
  )
}
