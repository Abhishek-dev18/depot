import { describe, expect, it } from 'vitest'
import { ManifestError, validateManifest, validateUploadName } from './validate'

const MB = 1024 * 1024

/** A manifest that tiles 300 bytes across three chunks. */
function good() {
  return {
    transferId: 1,
    name: 'a.bin',
    size: 300,
    chunkCount: 3,
    fileHash: 'aGFzaA',
    chunks: [
      { index: 0, offset: 0, length: 100, hash: 'h0' },
      { index: 1, offset: 100, length: 100, hash: 'h1' },
      { index: 2, offset: 200, length: 100, hash: 'h2' },
    ],
  }
}

const check = (m: unknown) => validateManifest(m, MB)

describe('validateManifest (protocol.md §5.7)', () => {
  it('passes a manifest that adds up', () => {
    expect(check(good()).name).toBe('a.bin')
  })

  it('rejects chunks that do not tile the file', () => {
    // The failure this exists for. A gap or an overlap reassembles into
    // something that is not the file, and the only thing that would
    // notice is the whole-file hash — after the entire transfer has run.
    const gap = good()
    gap.chunks[1].offset = 150
    expect(() => check(gap)).toThrow(/starts at 150, not 100/)

    const overlap = good()
    overlap.chunks[2].offset = 150
    expect(() => check(overlap)).toThrow(ManifestError)
  })

  it('rejects a chunk list that does not cover the claimed size', () => {
    const short = good()
    short.size = 500
    expect(() => check(short)).toThrow(/cover 300 bytes but it claims 500/)
  })

  it('rejects a count that disagrees with the list', () => {
    const lying = good()
    lying.chunkCount = 99
    expect(() => check(lying)).toThrow(/says 99 chunks and carries 3/)
  })

  it('rejects a chunk larger than CAPS settled on', () => {
    // The Client sized its buffers for the negotiated figure; a larger
    // chunk is not a disagreement to absorb quietly.
    const big = good()
    big.chunks[0].length = 2 * MB
    expect(() => check(big)).toThrow(/past the 1048576 agreed in CAPS/)
  })

  it('rejects an absurd chunk count before walking it', () => {
    const many = { ...good(), chunkCount: 5_000_000, chunks: new Array(5_000_000).fill(null) }
    expect(() => check(many)).toThrow(/claims 5000000 chunks/)
  })

  it('rejects empty chunks, which would never complete', () => {
    const empty = good()
    empty.chunks[1].length = 0
    expect(() => check(empty)).toThrow(/chunk 1 is empty/)
  })

  it('rejects misnumbered chunks', () => {
    const shuffled = good()
    shuffled.chunks[1].index = 7
    expect(() => check(shuffled)).toThrow(/chunk 1 is labelled 7/)
  })

  it('rejects the shapes JSON can hand back', () => {
    expect(() => check(null)).toThrow(/not an object/)
    expect(() => check('MANIFEST')).toThrow(/not an object/)
    expect(() => check({ ...good(), chunks: 'three' })).toThrow(/not a list/)
    expect(() => check({ ...good(), name: '' })).toThrow(/names no file/)
    expect(() => check({ ...good(), fileHash: undefined })).toThrow(/no whole-file hash/)
    expect(() => check({ ...good(), size: -1 })).toThrow(ManifestError)
    expect(() => check({ ...good(), size: Number.NaN })).toThrow(ManifestError)
    expect(() =>
      check({ ...good(), chunkCount: 1, chunks: [{ index: 0, offset: 0, length: 300 }] }),
    ).toThrow(/no hash/)
  })

  it('accepts an empty file, which has no chunks at all', () => {
    const empty = { ...good(), size: 0, chunkCount: 0, chunks: [] }
    expect(check(empty).size).toBe(0)
  })
})

describe('validateUploadName (protocol.md §5.10)', () => {
  it('takes an ordinary file name', () => {
    expect(validateUploadName('scan.pdf')).toBe('scan.pdf')
    expect(validateUploadName('holiday 2026 (1).jpg')).toBe('holiday 2026 (1).jpg')
    expect(validateUploadName('résumé.docx')).toBe('résumé.docx')
  })

  it('refuses anything shaped like a path', () => {
    expect(() => validateUploadName('a/b.txt')).toThrow(/looks like a path/)
    expect(() => validateUploadName('..\\\\windows\\\\system32')).toThrow(/looks like a path/)
    expect(() => validateUploadName('../../etc/passwd')).toThrow(/looks like a path/)
  })

  it('refuses names that hide or mean something to the filesystem', () => {
    expect(() => validateUploadName('.')).toThrow()
    expect(() => validateUploadName('..')).toThrow()
    expect(() => validateUploadName('.bashrc')).toThrow(/starts with a dot/)
  })

  it('refuses control characters', () => {
    // A newline in a name is how a log line gets forged, and a NUL is
    // how a name gets truncated by something written in C.
    expect(() => validateUploadName('report\nfake')).toThrow(/control characters/)
    expect(() => validateUploadName('report\u0000.txt')).toThrow(/control characters/)
  })

  it('refuses the empty and the absurd', () => {
    expect(() => validateUploadName('')).toThrow(/empty/)
    expect(() => validateUploadName('x'.repeat(300))).toThrow(/longer than/)
    expect(() => validateUploadName(null)).toThrow(/not a string/)
  })
})
