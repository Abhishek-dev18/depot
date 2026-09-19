interface Props {
  attempts: number
  onRetryNow: () => void
  onPairAgain: () => void
}

/**
 * The Depot is not listening — which is not a failure, and must not look
 * like one.
 *
 * The interface spec's FALLBACK frame is for a network that will not carry
 * a connection. A phone whose owner has not started it yet is a different
 * situation with a different answer, and showing the red one sends people
 * to debug a network that is working fine. This waits, says what to do,
 * and connects on its own when the Depot appears.
 */
export function WaitingPanel({ attempts, onRetryNow, onPairAgain }: Props) {
  return (
    <div className="waitwrap">
      <div className="waitmark" aria-hidden="true">
        <i />
      </div>
      <div className="failttl">Waiting for your Depot</div>
      <p className="failsub">
        Open Depot on your phone and start the terminal. This page keeps looking, and connects on its own
        the moment it appears — you do not need to reload.
      </p>
      <div className="tick">
        {attempts <= 1 ? 'CHECKING' : `CHECKED ${attempts} TIMES · STILL OFFLINE`}
      </div>

      <div className="opts">
        <button className="opt" onClick={onRetryNow}>
          <div className="oi">▲</div>
          <div>
            <div>Check again now</div>
            <div className="od">THE PHONE MUST BE ON THE SAME SIGNAL SERVER</div>
          </div>
        </button>
        <button className="opt" onClick={onPairAgain}>
          <div className="oi">◆</div>
          <div>
            <div>Pair with a different Depot</div>
            <div className="od">REPLACES THE CREDENTIAL THIS BROWSER HOLDS</div>
          </div>
        </button>
      </div>
    </div>
  )
}
