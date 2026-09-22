/**
 * When the page tries again, and when it admits something is wrong.
 *
 * Asked for as "reload the page every second in the background until it
 * connects, but keep the screen as it is". Reloading cannot keep the
 * screen — it is the screen being thrown away — but what a reload did
 * that the page did not was start a fresh attempt *now*, instead of
 * sitting out a backoff. That part is kept, and the page is not thrown
 * away to get it.
 */

/**
 * Failed attempts in a row before the page says so.
 *
 * The screen that follows a failure tells the user their network is at
 * fault and suggests moving devices onto the same Wi-Fi. Shown after a
 * single transient miss — a phone that has only just come online, a
 * request that crossed with a registration — it sends people to fix a
 * network that is working. Three in a row, a few seconds apart, is
 * enough to mean it.
 */
export const FAILURES_BEFORE_SAYING_SO = 3

/**
 * Milliseconds until the next attempt.
 *
 * A Depot that says it is offline is waited on (§7.1's `watch`) and
 * polled every four seconds only as a fallback. An attempt that failed
 * is retried quickly, and the ceiling is seconds rather than half a
 * minute: this is one browser talking to one phone, an attempt costs a
 * WebSocket and a few hundred bytes, and the thirty-second ceiling this
 * replaces was the difference between "it connected" and "it connected
 * eventually, if you waited".
 */
export function retryDelayMs(failed: boolean, attempts: number): number {
  if (!failed) return 4_000
  return Math.min(6_000, 2_000 * Math.max(1, attempts))
}

/** Whether the failure screen should be showing yet. */
export function showsFailure(failed: boolean, attempts: number): boolean {
  return failed && attempts >= FAILURES_BEFORE_SAYING_SO
}
