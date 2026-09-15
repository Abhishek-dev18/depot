/**
 * Length-prefixed concatenation, per protocol.md §3.3: every field is
 * preceded by its length as a uint16 big-endian, so no two distinct field
 * splits can ever produce the same transcript bytes (unlike naive
 * concatenation, where e.g. "ab"+"c" and "a"+"bc" collide).
 */
export function buildTranscript(fields: Uint8Array[]): Uint8Array {
  let total = 0
  for (const f of fields) {
    if (f.length > 0xffff) throw new Error('transcript field exceeds uint16 length prefix')
    total += 2 + f.length
  }

  const out = new Uint8Array(total)
  let offset = 0
  for (const f of fields) {
    out[offset] = (f.length >> 8) & 0xff
    out[offset + 1] = f.length & 0xff
    offset += 2
    out.set(f, offset)
    offset += f.length
  }
  return out
}

/**
 * ASCII-only encoder used for protocol constants and base64 strings (the
 * only inputs this function is ever called with). Deliberately avoids the
 * global TextEncoder: under some test environments (jsdom) it returns a
 * Uint8Array from a different realm than `new Uint8Array()`, which
 * libsodium's strict type checks reject.
 */
export function utf8(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code > 0x7f) throw new Error('utf8() only supports ASCII input')
    out[i] = code
  }
  return out
}

export function u8(n: number): Uint8Array {
  return Uint8Array.of(n & 0xff)
}
