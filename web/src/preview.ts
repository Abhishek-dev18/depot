/**
 * What a browser can be asked to show, and how to ask safely.
 *
 * A received file is bytes the Depot sent. Nothing about it is trusted:
 * the name came from the phone's filesystem, and a phone that has been
 * talked into sharing the wrong directory is exactly the case this has to
 * survive. The danger is not the bytes themselves but the context they
 * get rendered in — a blob: URL inherits the page's origin, so anything
 * that runs script inside one runs it next to this Client's IndexedDB,
 * where the pairing identity keys live.
 *
 * So two rules hold everywhere below:
 *
 *  1. The type is asserted from the extension and stamped onto the blob,
 *     never sniffed. A file called notes.pdf is served as application/pdf
 *     even if its first bytes say "<!DOCTYPE html>", which is what stops
 *     the browser deciding to parse it as a document.
 *  2. Each kind gets the narrowest element that can render it. Images go
 *     in <img>, where SVG script is inert; text is read out and printed,
 *     never parsed; only PDF gets a frame.
 *
 * That frame carries no sandbox attribute, which looks wrong and is not.
 * Measured in Chromium, with a file whose bytes are
 * `<script>postMessage(Object.keys(localStorage))</script>`:
 *
 *   served as text/html, no sandbox   -> script ran, read localStorage
 *   served as application/pdf, none   -> silent
 *   served as application/pdf, sandbox="" -> silent
 *
 * So rule 1 is the defence and the sandbox adds nothing to it. It also
 * costs everything: any sandbox value at all — "", allow-scripts, even
 * allow-scripts allow-same-origin — makes the browser's own PDF viewer
 * refuse a blob: URL and draw a broken-file icon instead. Sandboxing
 * here would have bought no safety and shipped a preview that never
 * showed a PDF. scripts/e2e.mjs re-runs those three cases.
 *
 * Anything not on the list below is not previewed. "Show it and see" is
 * how this goes wrong.
 */

export type PreviewKind = 'image' | 'pdf' | 'video' | 'audio' | 'text' | 'none'

export interface Preview {
  kind: PreviewKind
  /** The type the bytes will be stamped with before being handed over. */
  mime: string
  /**
   * Set when the format was recognised but no browser can draw it, so
   * the panel can name it instead of showing an empty frame.
   */
  undecodable?: string
}

const NONE: Preview = { kind: 'none', mime: 'application/octet-stream' }

const IMAGE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  // Safe here and only here: an <img> renders SVG without a script context.
  svg: 'image/svg+xml',
}

const VIDEO: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
}

const AUDIO: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
}

/**
 * Printed as characters, never parsed, which is why html and xml are on
 * this list rather than treated as documents.
 */
const TEXT = new Set([
  'txt', 'text', 'md', 'markdown', 'rst', 'log', 'csv', 'tsv', 'json', 'jsonl',
  'xml', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'properties', 'env',
  'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rb',
  'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp',
  'cs', 'php', 'sh', 'bash', 'zsh', 'fish', 'sql', 'gradle', 'diff', 'patch',
  'gitignore', 'dockerfile', 'makefile', 'srt', 'vtt', 'ics',
])

/**
 * Past this, a preview stops being a glance and becomes a way to freeze
 * the tab. Big files still save; they just do not get painted.
 */
export const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024

/**
 * What the Depot says a file is, where that maps onto something safe.
 *
 * A name is not always enough. Android content providers hand back
 * display names with no extension at all — Google Photos and Drive both
 * do — and a Client that only reads extensions decides those files are
 * unpreviewable, which looks exactly like a broken preview.
 *
 * The Depot's own type is better evidence, but it is still the Depot
 * talking, so it buys nothing beyond choosing which of the renderers
 * below to use. It is matched against the same allowlist, and a Depot
 * claiming text/html gets a <pre> like any other text.
 */
const MIME_KIND: Array<[RegExp, PreviewKind]> = [
  [/^image\/(png|jpeg|gif|webp|avif|bmp|x-icon|svg\+xml)$/, 'image'],
  [/^application\/pdf$/, 'pdf'],
  [/^video\//, 'video'],
  [/^audio\//, 'audio'],
  [/^text\//, 'text'],
  [/^application\/(json|xml|x-yaml|yaml|javascript|x-sh|sql)$/, 'text'],
]

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  // A file with no extension at all is usually a README or a script, but
  // guessing is exactly what rule 1 forbids, so it gets no preview from
  // the name alone.
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * Formats a browser will not decode, named so the panel can say which
 * rather than going blank. HEIC is the one that matters: it is what a
 * modern phone camera writes, and no major browser reads it.
 */
const UNDECODABLE: Record<string, string> = {
  heic: 'HEIC',
  heif: 'HEIF',
  hevc: 'HEVC',
  raw: 'camera RAW',
  dng: 'camera RAW (DNG)',
  cr2: 'camera RAW (CR2)',
  nef: 'camera RAW (NEF)',
  arw: 'camera RAW (ARW)',
  tif: 'TIFF',
  tiff: 'TIFF',
  mkv: 'Matroska',
  avi: 'AVI',
  wmv: 'Windows Media',
  flv: 'Flash Video',
}

export function describePreview(name: string, mime?: string): Preview {
  const ext = extensionOf(name)

  // The name first: it is what the user sees, and an extension the
  // browser cannot decode should be named as such even when the Depot
  // reports a type that sounds renderable (image/heic is still HEIC).
  const undecodable = UNDECODABLE[ext]
  if (undecodable) return { kind: 'none', mime: 'application/octet-stream', undecodable }

  if (ext in IMAGE) return { kind: 'image', mime: IMAGE[ext] }
  if (ext === 'pdf') return { kind: 'pdf', mime: 'application/pdf' }
  if (ext in VIDEO) return { kind: 'video', mime: VIDEO[ext] }
  if (ext in AUDIO) return { kind: 'audio', mime: AUDIO[ext] }
  if (TEXT.has(ext)) return { kind: 'text', mime: 'text/plain' }

  // Only then what the Depot claims, which is how a file with no usable
  // extension gets previewed at all.
  const claimed = (mime ?? '').split(';')[0].trim().toLowerCase()
  if (claimed) {
    for (const [pattern, kind] of MIME_KIND) {
      if (!pattern.test(claimed)) continue
      // Text is printed, never parsed, so it is served as text/plain
      // whatever the Depot called it.
      return { kind, mime: kind === 'text' ? 'text/plain' : claimed }
    }
  }

  return NONE
}

/**
 * The same bytes, relabelled.
 *
 * Blob.slice over the whole range is the documented way to restate a
 * type, and it does not copy — which matters when the thing being
 * relabelled is a video the size of the phone's camera roll.
 */
export function retype(blob: Blob, mime: string): Blob {
  return blob.slice(0, blob.size, mime)
}
