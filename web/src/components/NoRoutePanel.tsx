interface Props {
  message: string
  /** How many attempts have failed, so the page can say it is still going. */
  attempts: number
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
export function NoRoutePanel({ message, attempts, onRetry, onSettings }: Props) {
  // A phone that did not answer in time is not a phone that cannot be
  // reached, and saying so sends people to move devices onto the same
  // Wi-Fi to fix something that was merely still waking up.
  const timedOut = message.includes('did not answer') || message.includes('did not accept')

  return (
    <div className="failwrap">
      <div className="failic">!</div>
      <div className="failttl">
        {timedOut ? 'Your Depot didn\u2019t answer' : 'Couldn\u2019t reach your Depot'}
      </div>
      <p className="failsub">
        {timedOut
          ? 'The phone is registered, so the two can see each other — it just did not reply in time. A Depot that has only just been switched on takes a moment to be ready.'
          : 'Your network wouldn\u2019t allow a link to the phone right now. This usually means it is on mobile data behind carrier NAT, or the two devices are on networks that cannot see each other.'}
      </p>
      <p className="failwhy">{message}</p>
      <div className="tick">
        {attempts <= 1 ? 'TRYING AGAIN SHORTLY' : `TRIED ${attempts} TIMES · STILL TRYING`}
      </div>

      <div className="opts">
        <button className="opt" onClick={onRetry}>
          <div className="oi">▲</div>
          <div>
            <div>{timedOut ? 'Try now' : 'Put both devices on the same Wi-Fi, then try again'}</div>
            <div className="od">
              {timedOut ? 'THIS PAGE IS ALREADY RETRYING ON ITS OWN' : 'FASTEST · NO RELAY NEEDED'}
            </div>
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
