import { describe, expect, it } from 'vitest'
import { LinkSpeed } from './linkSpeed'

/**
 * The estimator behind §5.6's "is this worth compressing" question.
 *
 * It only has to be right about the thing that decision turns on: a LAN
 * and a phone on mobile data are two orders of magnitude apart.
 */
describe('LinkSpeed', () => {
  it('knows nothing until it has seen something', () => {
    expect(new LinkSpeed().current()).toBeUndefined()
  })

  it('reads a slow link as slow', () => {
    const link = new LinkSpeed()
    // 64 KB taking 64 ms is 1 MB/s — a phone on a poor connection.
    for (let i = 0; i < 20; i++) link.sample(64 * 1024, 64)
    const mbps = (link.current()! * 8) / 1_000_000
    expect(mbps).toBeGreaterThan(7)
    expect(mbps).toBeLessThan(9)
  })

  it('reads a fast link as fast', () => {
    const link = new LinkSpeed()
    // 64 KB in 1.3 ms is about 400 Mbps — a direct LAN connection.
    for (let i = 0; i < 20; i++) link.sample(64 * 1024, 1.3)
    expect((link.current()! * 8) / 1_000_000).toBeGreaterThan(300)
  })

  it('ignores a send the channel swallowed instantly', () => {
    // A chunk accepted with no wait says the buffer had room, not that
    // the wire is infinitely fast. Timing it yields absurd figures,
    // which would then argue against compressing on a link that is in
    // fact slow.
    const link = new LinkSpeed()
    link.sample(64 * 1024, 0)
    link.sample(64 * 1024, 0.4)
    expect(link.current()).toBeUndefined()
  })

  it('does not let one stall rewrite what it knows', () => {
    const link = new LinkSpeed()
    for (let i = 0; i < 30; i++) link.sample(64 * 1024, 1.3)
    const before = link.current()!
    link.sample(64 * 1024, 500) // one bad moment
    // Moved, because a stall is evidence; but not moved to the stall.
    expect(link.current()!).toBeLessThan(before)
    expect(link.current()!).toBeGreaterThan(before * 0.7)
  })
})
