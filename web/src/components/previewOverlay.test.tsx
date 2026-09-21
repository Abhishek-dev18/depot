import { StrictMode } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PreviewOverlay } from './PreviewOverlay'
import type { HeldFile } from '../heldFiles'

/**
 * An object URL that can be asked whether it is still alive.
 *
 * jsdom has no createObjectURL at all, so one has to be supplied either
 * way; making it track revocation is what turns it into the instrument
 * this file needs.
 */
const live = new Set<string>()
let minted = 0

beforeEach(() => {
  live.clear()
  minted = 0
  URL.createObjectURL = vi.fn(() => {
    const url = `blob:test/${++minted}`
    live.add(url)
    return url
  })
  URL.revokeObjectURL = vi.fn((url: string) => {
    live.delete(url)
  })
})

let container: HTMLDivElement
let root: Root

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function show(file: HeldFile): void {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  // StrictMode on purpose: it mounts, tears down and mounts again, which
  // is what a browser in development does to every component and what
  // React reserves the right to do in production.
  act(() => {
    root.render(
      <StrictMode>
        <PreviewOverlay file={file} onClose={() => {}} onRefetch={() => {}} />
      </StrictMode>,
    )
  })
}

function heldImage(): HeldFile {
  return {
    key: '127000:1700:photo.jpg',
    name: 'photo.jpg',
    size: 127_000,
    modifiedAt: 1700,
    mime: 'image/jpeg',
    blob: new Blob([new Uint8Array(16)], { type: 'image/jpeg' }),
    url: 'blob:test/save',
    persisted: true,
  }
}

/**
 * The reported bug, in one sentence: open a photo, close it, open it
 * again, and the panel says the bytes do not decode.
 *
 * They decoded a moment earlier and were verified against the Depot's
 * own hash on the way in. What had actually happened is that the object
 * URL was created while rendering and revoked by an effect's cleanup, so
 * the mount that followed the teardown went on pointing at a handle that
 * had already been given back — and a media element with a dead src
 * fires onError, which the panel can only report as "could not decode".
 */
describe('PreviewOverlay and the handle it draws from', () => {
  it('leaves the rendered image pointing at a URL that is still alive', () => {
    show(heldImage())

    const img = container.querySelector('img')
    expect(img, 'the image should be rendered').not.toBeNull()
    const src = img!.getAttribute('src')!
    expect(src.startsWith('blob:')).toBe(true)
    expect(live.has(src), `${src} was revoked while still on screen`).toBe(true)
  })

  it('gives every handle back when it closes', () => {
    show(heldImage())
    expect(live.size).toBeGreaterThan(0)

    act(() => root.unmount())
    expect([...live], 'an object URL outlived the panel that made it').toEqual([])

    // afterEach unmounts again; a second unmount of the same root is a
    // no-op, so re-arm it with something disposable.
    container = document.createElement('div')
    root = createRoot(container)
  })

  it('does not mint a handle for a kind that does not need one', () => {
    show({ ...heldImage(), name: 'notes.txt', mime: 'text/plain' })
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })
})
