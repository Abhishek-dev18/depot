import type { ConnectionType } from '../transport/webrtc'

const LABEL: Record<ConnectionType, string> = {
  direct: 'DIRECT',
  relayed: 'RELAYED (TURN)',
  unknown: 'CONNECTED',
}

/** "Connection state is never hidden" — see index.css's header comment. */
export function ConnectionBadge({ type }: { type: ConnectionType }) {
  return (
    <span className={`conn conn-${type}`}>
      <i />
      {LABEL[type]}
    </span>
  )
}
