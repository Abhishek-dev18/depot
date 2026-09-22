import { describe, expect, it } from 'vitest'
import { registerSigningBytes } from './registration'
import { utf8 } from './transcript'

describe('registration signing bytes (§7.1)', () => {
  // Built here, on Android, and in signal/register.go. If they drift
  // apart no Depot can register, so all three pin the same answer.
  it('matches the bytes Signal checks', () => {
    const expected = new Uint8Array([0, 24, ...utf8('depot-signal-register/v1'), 0, 2, 0x41, 0x42, 0, 2, 1, 2])
    expect(registerSigningBytes('AB', new Uint8Array([1, 2]))).toEqual(expected)
  })
})
