import { describe, expect, it } from 'vitest'
import { isStale, type HeldFile } from './heldFiles'
import { describePreview, retype } from './preview'

const held = (over: Partial<HeldFile> = {}): HeldFile => ({
  handle: 'h1',
  name: 'notes.txt',
  size: 100,
  modifiedAt: 1000,
  blob: new Blob(['hello']),
  url: 'blob:x',
  ...over,
})

describe('describePreview', () => {
  it('shows images in an image element', () => {
    expect(describePreview('holiday.JPG')).toEqual({ kind: 'image', mime: 'image/jpeg' })
    expect(describePreview('a.png').kind).toBe('image')
    expect(describePreview('a.webp').kind).toBe('image')
  })

  it('treats markup as text rather than as a document', () => {
    // The whole point: an <img> cannot run script from an SVG, and a
    // <pre> cannot run it from anything. Neither goes near a frame.
    expect(describePreview('logo.svg')).toEqual({ kind: 'image', mime: 'image/svg+xml' })
    expect(describePreview('page.html')).toEqual({ kind: 'text', mime: 'text/plain' })
    expect(describePreview('feed.xml')).toEqual({ kind: 'text', mime: 'text/plain' })
  })

  it('stamps a type from the name so nothing gets sniffed', () => {
    // A document that calls itself a PDF is served as application/pdf,
    // which is exactly what stops the browser parsing it as HTML.
    expect(describePreview('invoice.pdf')).toEqual({ kind: 'pdf', mime: 'application/pdf' })
  })

  it('refuses to guess', () => {
    expect(describePreview('archive.zip').kind).toBe('none')
    expect(describePreview('firmware.bin').kind).toBe('none')
    expect(describePreview('README').kind).toBe('none')
    expect(describePreview('.gitignore').kind).toBe('none')
    expect(describePreview('')).toEqual({ kind: 'none', mime: 'application/octet-stream' })
  })

  it('reads the last extension, not the first', () => {
    // A dotted name is ordinary, and reading from the first dot turns
    // "holiday.2024.jpg" into the extension "2024.jpg" — no preview for
    // a perfectly good photograph.
    expect(describePreview('holiday.2024.jpg').kind).toBe('image')
    expect(describePreview('v1.2.3-notes.md').kind).toBe('text')
  })

  it('does not match an extension buried in the middle', () => {
    // "report.pdf.exe" is an executable. Anything that searches the name
    // for a known extension rather than reading the last one will offer
    // to render it.
    expect(describePreview('report.pdf.exe').kind).toBe('none')
    expect(describePreview('archive.tar.gz').kind).toBe('none')
    expect(describePreview('photo.png.zip').kind).toBe('none')
  })

  it('handles media', () => {
    expect(describePreview('clip.mp4')).toEqual({ kind: 'video', mime: 'video/mp4' })
    expect(describePreview('song.flac')).toEqual({ kind: 'audio', mime: 'audio/flac' })
  })
})

describe('retype', () => {
  it('relabels the same bytes', async () => {
    const original = new Blob([new Uint8Array([1, 2, 3])], { type: 'application/octet-stream' })
    const relabelled = retype(original, 'application/pdf')
    expect(relabelled.type).toBe('application/pdf')
    expect(relabelled.size).toBe(3)
    expect(new Uint8Array(await relabelled.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })
})

describe('isStale', () => {
  const entry = (over: Record<string, unknown> = {}) =>
    ({ handle: 'h1', name: 'notes.txt', kind: 'file' as const, size: 100, modifiedAt: 1000, ...over })

  it('holds on to a file the listing still agrees with', () => {
    expect(isStale(held(), entry())).toBe(false)
  })

  it('re-fetches when the file changed underneath', () => {
    expect(isStale(held(), entry({ size: 101 }))).toBe(true)
    expect(isStale(held(), entry({ modifiedAt: 2000 }))).toBe(true)
  })

  it('keeps the held copy when the Depot says nothing to compare', () => {
    // No size and no timestamp is not evidence of a change, and
    // treating it as one would re-download on every single click.
    expect(isStale(held(), entry({ size: undefined, modifiedAt: undefined }))).toBe(false)
  })

  it('uses whichever figure the Depot did report', () => {
    expect(isStale(held(), entry({ size: undefined, modifiedAt: 2000 }))).toBe(true)
    expect(isStale(held(), entry({ size: 99, modifiedAt: undefined }))).toBe(true)
  })

  it('does not mistake a zero for a missing figure', () => {
    // An empty file has size 0, and `entry.size || ...` would read that
    // as "not reported" and quietly keep the wrong bytes.
    expect(isStale(held({ size: 100 }), entry({ size: 0 }))).toBe(true)
    expect(isStale(held({ size: 0 }), entry({ size: 0 }))).toBe(false)
  })
})
