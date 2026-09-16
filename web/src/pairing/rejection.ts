import type { Envelope } from '../signal/envelope'

/**
 * protocol.md §4.2 — a Depot refusing a reconnection says so, rather than
 * leaving the Client to time out.
 *
 * The reason travels in the payload rather than the envelope's `reason`
 * field because Signal only populates that on errors it generates itself;
 * it drops the field when relaying between peers, so a Depot cannot use it.
 */
export const TypeRejected = 'REJECTED'

export interface RejectedPayload {
  reason: string
}

/**
 * The reasons say only whether a credential is still honoured, which the
 * outcome reveals anyway: a peer that is refused learns nothing it could
 * not infer from never receiving a challenge.
 */
export function throwIfRejected(e: Envelope): void {
  if (e.type !== TypeRejected) return
  const { reason } = (e.payload ?? {}) as Partial<RejectedPayload>
  throw new Error(`reconnection rejected: ${reason ?? 'unknown'}`)
}
