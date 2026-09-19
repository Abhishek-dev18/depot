import { describe, expect, it } from 'vitest'
import { describePreview, retype } from './preview'
import { keyFor } from './storage/fileCache'

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

describe('keyFor — what counts as the same file across sessions', () => {
  const file = (over: Record<string, unknown> = {}) =>
    ({ name: 'notes.txt', size: 100, modifiedAt: 1000, ...over })

  it('matches a listing that still agrees', () => {
    expect(keyFor(file())).toBe(keyFor(file()))
  })

  it('does not match once the file has changed underneath', () => {
    expect(keyFor(file({ size: 101 }))).not.toBe(keyFor(file()))
    expect(keyFor(file({ modifiedAt: 2000 }))).not.toBe(keyFor(file()))
    expect(keyFor(file({ name: 'other.txt' }))).not.toBe(keyFor(file()))
  })

  it('still identifies a file the Depot says nothing about', () => {
    // No size and no timestamp is not evidence of a change. Treating it
    // as one would re-download on every single click, so the key holds
    // and the preview's "fetch again" is the way out.
    const vague = { name: 'notes.txt' }
    expect(keyFor(vague)).toBe(keyFor({ name: 'notes.txt' }))
    expect(keyFor(vague)).not.toBe(keyFor(file()))
  })

  it('does not mistake a zero for a missing figure', () => {
    // An empty file has size 0, and `size || '?'` would write that as
    // "not reported" — making every empty file look like every other.
    expect(keyFor({ name: 'a', size: 0, modifiedAt: 5 })).not.toBe(keyFor({ name: 'a', modifiedAt: 5 }))
    expect(keyFor({ name: 'a', size: 0, modifiedAt: 5 })).toBe(keyFor({ name: 'a', size: 0, modifiedAt: 5 }))
  })
})
