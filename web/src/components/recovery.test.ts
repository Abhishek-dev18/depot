import { describe, expect, it } from 'vitest'

/**
 * The scheduling rules ClientView follows when it is not connected.
 *
 * Extracted rather than driven through the component: what went wrong
 * was never a rendering question, it was which effect re-runs when which
 * flag changes, and that is easier to state as a function than to
 * discover through a DOM.
 *
 * Both bugs these describe were live. A page that had seen one error sat
 * on the failure screen for ever, because only `offline` scheduled
 * anything; and "try now" from the waiting screen cleared `offline`,
 * which stopped the only loop that was running.
 */

interface State {
  session: boolean
  connecting: boolean
  offline: boolean
  failure: string | null
  attempts: number
  hasPairing: boolean
}

const idle: State = {
  session: false,
  connecting: false,
  offline: false,
  failure: null,
  attempts: 0,
  hasPairing: true,
}

/**
 * What a "that Depot is not registered" answer does to the state.
 *
 * Mirrors ClientView's onDepotOffline. It is an answer, not a failure,
 * so it clears the last one and resets the count — which is the whole
 * point of the test below it.
 */
function depotSaidOffline(s: State): State {
  return { ...s, offline: true, failure: null, attempts: 0, connecting: false }
}

/** Milliseconds until the next attempt, or null for "do not schedule one". */
function nextAttemptIn(s: State): number | null {
  if (s.session || s.connecting) return null
  if (!s.offline && s.failure === null) return null
  if (!s.hasPairing) return null
  return s.failure === null ? 4_000 : Math.min(30_000, 4_000 * 2 ** Math.min(s.attempts, 3))
}

describe('when the Client tries again', () => {
  it('polls while the Depot says it is not listening', () => {
    expect(nextAttemptIn({ ...idle, offline: true, attempts: 1 })).toBe(4_000)
  })

  it('also tries again after a failure', () => {
    // The bug. A single error left the page on the failure screen with
    // nothing scheduled, so bringing the phone online changed nothing
    // and reloading was the only way forward.
    expect(nextAttemptIn({ ...idle, failure: 'the Depot did not answer', attempts: 1 })).not.toBeNull()
  })

  it('backs off on repeated failures, but not for ever', () => {
    const delay = (attempts: number) => nextAttemptIn({ ...idle, failure: 'x', attempts })
    expect(delay(0)).toBe(4_000)
    expect(delay(1)).toBe(8_000)
    expect(delay(2)).toBe(16_000)
    expect(delay(3)).toBe(30_000)
    expect(delay(50)).toBe(30_000)
  })

  it('keeps polling briskly for a phone that is merely switched off', () => {
    // Nothing is broken in this case and the answer costs one round
    // trip, so backing off would only make the page slower to notice.
    expect(nextAttemptIn({ ...idle, offline: true, attempts: 9 })).toBe(4_000)
  })

  it('schedules nothing once connected, or while an attempt is in flight', () => {
    expect(nextAttemptIn({ ...idle, offline: true, session: true })).toBeNull()
    expect(nextAttemptIn({ ...idle, failure: 'x', connecting: true })).toBeNull()
  })

  it('schedules nothing when there is no Depot to connect to', () => {
    expect(nextAttemptIn({ ...idle, offline: true, hasPairing: false })).toBeNull()
  })

  it('schedules nothing when there is nothing to recover from', () => {
    expect(nextAttemptIn(idle)).toBeNull()
  })
})

/**
 * "Try now" has to try. The old one cleared the flags and left an effect
 * to notice, which worked from the failure screen and did nothing from
 * the waiting screen — where clearing `offline` stopped the poll that
 * was the only thing still working.
 */
function retry(s: State): { connects: boolean; after: State } {
  const after = { ...s, failure: null, offline: false, attempts: 0 }
  return { connects: s.hasPairing, after }
}

describe('pressing try now', () => {
  it('connects from the failure screen', () => {
    expect(retry({ ...idle, failure: 'no route', attempts: 3 }).connects).toBe(true)
  })

  it('connects from the waiting screen too', () => {
    // This is the one that did nothing at all.
    expect(retry({ ...idle, offline: true, attempts: 3 }).connects).toBe(true)
  })

  it('does not leave the page in a state that schedules nothing', () => {
    // The trap: clearing both flags means the recovery loop has nothing
    // to act on, so if the press itself does not connect, nothing ever
    // will again.
    const { connects, after } = retry({ ...idle, offline: true })
    expect(nextAttemptIn(after)).toBeNull()
    expect(connects).toBe(true)
  })
})

/*
 * The reported symptom: switch the phone's terminal off and on again and
 * the browser took about thirty seconds to notice, every time. Refreshing
 * the page noticed at once, which is what made it look like the page was
 * not trying at all.
 *
 * It was trying. An offline answer was being counted as a failed attempt,
 * so four polls of a phone that was merely switched off drove the backoff
 * to its ceiling — and the ceiling is thirty seconds.
 */
describe('a Depot that says it is not listening', () => {
  it('is an answer, not a failure, so the brisk poll continues', () => {
    // Four polls of a phone that is switched off.
    let s: State = { ...idle, offline: true }
    for (let i = 0; i < 4; i++) s = depotSaidOffline(s)

    expect(s.attempts).toBe(0)
    expect(nextAttemptIn(s)).toBe(4_000)
  })

  it('clears a backoff left by an earlier failure', () => {
    // The sequence that produced the thirty seconds: one real failure —
    // a stale registration that never answered — and then polls of a
    // phone that was simply off.
    const afterFailure: State = { ...idle, failure: 'the Depot did not answer', attempts: 3 }
    expect(nextAttemptIn(afterFailure)).toBe(30_000)

    expect(nextAttemptIn(depotSaidOffline(afterFailure))).toBe(4_000)
  })
})
