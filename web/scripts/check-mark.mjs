/**
 * Every copy of the Depot crate, measured against public/favicon.svg.
 *
 * The mark lives in several places — the favicon, two CSS pseudo-element
 * constructions, the Android launcher vectors (dark and light) and a
 * notification vector —
 * and they had quietly drifted into four different shapes. Eyeballing
 * them side by side does not catch a seam two pixels high or a block
 * sitting slightly too far into the corner, so this renders each one and
 * measures where its parts actually land.
 *
 *   npm i -D playwright     # once
 *   node scripts/check-mark.mjs
 *
 * It reads the real files on every run. An earlier version snapshotted
 * the CSS into its own test page and then reported stale numbers after an
 * edit, which is a good way to believe you have fixed something you have
 * not.
 */
import { launchChromium } from './browser.mjs'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const web = fileURLToPath(new URL('..', import.meta.url))
const res = fileURLToPath(new URL('../../android/app/src/main/res/', import.meta.url))

function vectorToSvg(file, viewBox) {
  const src = readFileSync(res + file, 'utf8')
  const paths = [...src.matchAll(/<path\b([\s\S]*?)\/>/g)].map(([, attrs]) => {
    const d = /android:pathData="([^"]+)"/.exec(attrs)[1]
    const fill = /android:fillColor="(#\w+)"/.exec(attrs)[1]
    const stroke = /android:strokeColor="(#\w+)"/.exec(attrs)
    const width = /android:strokeWidth="([\d.]+)"/.exec(attrs)
    const f = fill === '#00000000' ? 'none' : '#FFB020'
    const s = stroke ? ` stroke="#FFB020" stroke-width="${width[1]}"` : ''
    return `<path d="${d}" fill="${f}"${s}/>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="${viewBox}">${paths.join('')}</svg>`
}

const css = readFileSync(web + 'src/App.css', 'utf8')
const rule = (name) =>
  ['', '::before', '::after']
    .map((sel) => new RegExp(`\\n(\\.${name}${sel}\\s*\\{[\\s\\S]*?\\n\\})`).exec(css))
    .filter(Boolean)
    .map((m) => m[1])
    .join('\n')

const cells = {
  favicon: readFileSync(web + 'public/favicon.svg', 'utf8').replace(
    'width="32" height="32"',
    'width="200" height="200"',
  ),
  launcher: vectorToSvg('drawable/ic_launcher_foreground.xml', '0 0 108 108'),
  // The light-mode launcher icon: its own file, so its own measurement.
  launcherLight: vectorToSvg('drawable-notnight/ic_launcher_foreground.xml', '0 0 108 108'),
  notification: vectorToSvg('drawable/ic_notification.xml', '0 0 24 24'),
  brandmark: '<span class="brand-mark z32"></span>',
  wmark: '<span class="wmark z26"></span>',
}

/**
 * How much of its canvas each drawn icon may occupy before a mask eats it.
 *
 * A launcher may crop an adaptive icon to a circle, a squircle or a
 * teardrop; Android guarantees only the central 66dp of the 108dp canvas.
 * Several systems draw notification icons inside a circular badge too. A
 * square mark is limited by its diagonal rather than its width, which is
 * what made an icon that looked comfortably inside its canvas lose its
 * corners on a real launcher.
 */
const SAFE = {
  launcher: { canvas: 108, safeDiameter: 66 },
  launcherLight: { canvas: 108, safeDiameter: 66 },
  // Not Android's number. Whatever draws notification icons on a real
  // handset crops far inside anything documented — 23dp of 24 clipped,
  // then 14, then 12. This is the launcher's proven ratio (40 of 108)
  // applied to a 24dp canvas, which is measured evidence rather than a
  // specification's promise.
  notification: { canvas: 24, safeDiameter: 14 },
}

const html = `<!doctype html><meta charset="utf-8"><style>
:root { --amber:#FFB020; }
/*
 * The project's own reset. Without it these marks render 36px rather than
 * 32 — the borders land outside the box — and every measurement below
 * shifts by just enough to look like a real drift. That cost an hour.
 */
* { box-sizing: border-box; }
body { margin:0; background:#000; }
.cell { width:200px; height:200px; display:flex; align-items:center; justify-content:center; }
.brand-mark, .wmark { display:inline-block; }
.z32 { zoom:6.25; } .z26 { zoom:7.6923; }
${rule('brand-mark')}
${rule('wmark')}
</style>${Object.entries(cells)
  .map(([id, markup]) => `<div class="cell" id="${id}">${markup}</div>`)
  .join('')}`

const file = `${tmpdir()}/depot-mark.html`
writeFileSync(file, html)

const browser = await launchChromium()
const tab = await browser.newPage({ viewport: { width: 200, height: 1400 } })
await tab.goto('file://' + file)
await tab.waitForTimeout(300)

/**
 * Reads the rendered pixels back through a canvas in the same page, so
 * the whole check is one command with no image library on the Node side.
 * Positions come out as fractions of the mark's own bounding box, which
 * is what makes marks of different sizes comparable at all.
 */
async function measure(id) {
  const shot = await tab.locator('#' + id).screenshot()
  const dataUrl = 'data:image/png;base64,' + shot.toString('base64')
  return tab.evaluate(async (url) => {
    const img = new Image()
    img.src = url
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const { data } = ctx.getImageData(0, 0, c.width, c.height)
    const amber = (x, y) => {
      const i = (y * c.width + x) * 4
      return data[i] > 150 && data[i + 1] > 90 && data[i + 1] < 225 && data[i + 2] < 130
    }
    const runs = (flags) => {
      const out = []
      let start = null
      flags.forEach((f, i) => {
        if (f && start === null) start = i
        else if (!f && start !== null) {
          out.push([start, i - 1])
          start = null
        }
      })
      if (start !== null) out.push([start, flags.length - 1])
      return out
    }

    const xs = [...Array(c.width).keys()]
    const ys = [...Array(c.height).keys()]
    const rows = ys.filter((y) => xs.some((x) => amber(x, y)))
    const cols = xs.filter((x) => ys.some((y) => amber(x, y)))
    const [top, bot] = [rows[0], rows[rows.length - 1]]
    const [left, right] = [cols[0], cols[cols.length - 1]]
    const H = bot - top + 1
    const W = right - left + 1

    // The centre column crosses the top border, the seam and the bottom
    // border and nothing else, so the middle run is the seam.
    const cx = left + Math.floor(W / 2)
    const band = runs(ys.slice(top, bot + 1).map((y) => amber(cx, y)))
    const seam = band.length >= 3 ? band[1] : null
    const seamY = seam ? (seam[0] + seam[1]) / 2 / H : NaN

    const sy = seam ? top + Math.floor((seam[0] + seam[1]) / 2) : top
    const sr = runs(xs.slice(left, right + 1).map((x) => amber(x, sy))).filter((r) => r[1] - r[0] > W * 0.2)
    const [sx0, sx1] = sr.length ? [sr[0][0] / W, sr[0][1] / W] : [NaN, NaN]

    // The block sits in the lower-right, clear of the side strokes.
    const yb = top + Math.floor(H * 0.73)
    const br = runs(xs.slice(left, right + 1).map((x) => amber(x, yb))).filter(
      (r) => r[0] > W * 0.4 && r[1] < W * 0.93,
    )
    const [bx0, bx1] = br.length ? [br[br.length - 1][0] / W, br[br.length - 1][1] / W] : [NaN, NaN]
    const xb = br.length ? left + Math.floor(((bx0 + bx1) / 2) * W) : left
    const cr = runs(ys.slice(top, bot + 1).map((y) => amber(xb, y))).filter(
      (r) => r[0] > H * 0.4 && r[1] < H * 0.93,
    )
    const [by0, by1] = cr.length ? [cr[cr.length - 1][0] / H, cr[cr.length - 1][1] / H] : [NaN, NaN]

    return { seamY, sx0, sx1, bx0, bx1, by0, by1, W, H, cell: c.width }
  }, dataUrl)
}

const names = Object.keys(cells)
const results = {}
for (const id of names) results[id] = await measure(id)
await browser.close()

const keys = ['seamY', 'sx0', 'sx1', 'bx0', 'bx1', 'by0', 'by1']
const ref = results.favicon
const pad = (v) => (Number.isNaN(v) ? '     nan' : v.toFixed(3).padStart(8))

console.log('Every copy of the mark, as fractions of its own box.')
console.log('favicon is the reference; anything over 0.03 has drifted.\n')
console.log('mark'.padEnd(14) + keys.map((k) => k.padStart(8)).join('') + '   drift')
console.log('-'.repeat(88))

let worst = 0
for (const id of names) {
  const r = results[id]
  const safe = SAFE[id]
  if (safe) {
    // The mark's own size in canvas units, and the radius its corners
    // reach from the centre.
    const extent = (Math.max(r.W, r.H) / r.cell) * safe.canvas
    const corner = (extent * Math.SQRT2) / 2
    const limit = safe.safeDiameter / 2
    const ok = corner <= limit
    console.log(
      `  ${id}: ${extent.toFixed(1)}dp of ${safe.canvas}, corners reach ${corner.toFixed(1)}dp ` +
        `(safe radius ${limit}) ${ok ? 'ok' : 'WILL BE CLIPPED'}`,
    )
    if (!ok) process.exitCode = 1
  }
  const drift = Math.max(
    ...keys.map((k) => (Number.isNaN(r[k]) || Number.isNaN(ref[k]) ? 0 : Math.abs(r[k] - ref[k]))),
  )
  const missing = keys.some((k) => Number.isNaN(r[k]))
  if (id !== 'favicon') worst = Math.max(worst, drift)
  const note = missing ? 'NOT MEASURED' : drift < 0.03 ? 'ok' : 'DRIFT'
  console.log(id.padEnd(14) + keys.map((k) => pad(r[k])).join('') + `   ${drift.toFixed(3)} ${note}`)
  if (missing) process.exitCode = 1
}
if (worst >= 0.03) process.exitCode = 1
