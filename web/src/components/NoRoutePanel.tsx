interface Props {
  message: string
  onRetry: () => void
  onSettings: () => void
}

/**
 * FALLBACK · NO DIRECT ROUTE.
 *
 * The interface spec is firm that failure states give options rather than
 * apologies: no spinner, no vague "try again", but a plain-language
 * account of what the network is doing and two concrete things to do about
 * it. Carrier NAT is the usual cause and neither option is a guess.
 */
export function NoRoutePanel({ message, onRetry, onSettings }: Props) {
  return (
    <div className="failwrap">
      <div className="failic">!</div>
      <div className="failttl">Couldn&rsquo;t reach your Depot</div>
      <p className="failsub">
        Your network wouldn&rsquo;t allow a link to the phone right now. This usually means it is on
        mobile data behind carrier NAT, or the two devices are on networks that cannot see each other.
      </p>
      <p className="failwhy">{message}</p>

      <div className="opts">
        <button className="opt" onClick={onRetry}>
          <div className="oi">▲</div>
          <div>
            <div>Put both devices on the same Wi-Fi, then try again</div>
            <div className="od">FASTEST · NO RELAY NEEDED</div>
          </div>
        </button>
        <button className="opt" onClick={onSettings}>
          <div className="oi">◆</div>
          <div>
            <div>Add your own relay server</div>
            <div className="od">CONNECTION SETTINGS › TURN · YOUR SERVER, YOUR DATA</div>
          </div>
        </button>
      </div>
    </div>
  )
}
