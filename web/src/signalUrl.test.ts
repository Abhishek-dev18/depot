import { describe, expect, it } from 'vitest'
import { isLoopbackSignalUrl } from './signalUrl'

/**
 * A loopback Signal URL in the QR resolves to the phone itself, so the
 * Depot connects to nothing and pairing fails with no obvious cause.
 */
describe('loopback Signal URL detection', () => {
  it('flags addresses that mean "this machine"', () => {
    expect(isLoopbackSignalUrl('ws://localhost:8080/ws')).toBe(true)
    expect(isLoopbackSignalUrl('ws://127.0.0.1:8080/ws')).toBe(true)
    expect(isLoopbackSignalUrl('ws://[::1]:8080/ws')).toBe(true)
  })

  it('accepts addresses a phone can actually reach', () => {
    expect(isLoopbackSignalUrl('ws://192.168.1.11:8080/ws')).toBe(false)
    expect(isLoopbackSignalUrl('wss://signal.example.com/ws')).toBe(false)
  })

  it('does not flag a malformed URL, which has its own failure', () => {
    expect(isLoopbackSignalUrl('not a url')).toBe(false)
    expect(isLoopbackSignalUrl('')).toBe(false)
  })
})
