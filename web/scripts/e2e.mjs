/**
 * Drives the whole protocol through two real browser tabs: pairing (§3),
 * the SAS comparison, reconnection (§4), browsing (§5.9) and a verified
 * transfer (§5.7).
 *
 * The unit tests exercise the transport over a fake DataChannel pair,
 * which is faster and more precise but cannot tell you that WebRTC
 * negotiated, that the relay routed, or that the screen shows what
 * happened. This can. It is how the file listing was first seen working.
 *
 * Needs three things running, and Playwright installed (npm i -D playwright):
 *
 *   cd signal && go run .
 *   cd web && npm run build && npx vite preview --port 4173
 *   cd web && node scripts/e2e.mjs
 *
 * Screenshots land in /tmp. Not part of `npm test` — it wants servers and
 * a browser, and CI has neither wired up.
 */
import { writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const BASE = 'http://localhost:4173'
const log = (...a) => console.log('[e2e]', ...a)

// Fixtures, written here so the script needs nothing but a server.
// The PNG is a 1x1 red pixel; the point is that it decodes, not what it shows.
writeFileSync('/tmp/sample.txt', 'the quick brown fox\n'.repeat(400))
writeFileSync(
  '/tmp/sample.png',
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
)
writeFileSync('/tmp/sample.pdf', minimalPdf('DEPOT PDF'))
// A name that says JPEG over bytes that are not one, to drive the
// failure path: a media element that cannot decode renders nothing
// at all, which is indistinguishable from a preview that never came.
writeFileSync('/tmp/broken.jpg', 'not an image at all, just text pretending\n'.repeat(20))

/** One page, one line of Helvetica. Real enough for a browser to open. */
function minimalPdf(text) {
  const stream = `BT /F1 28 Tf 30 100 Td (${text}) Tj ET`
  const bodies = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${stream.length}>>stream\n${stream}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ]
  let out = '%PDF-1.4\n'
  const offsets = []
  bodies.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const startxref = out.length
  out += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<</Size ${bodies.length + 1}/Root 1 0 R>>\nstartxref\n${startxref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })

const client = await ctx.newPage()
const depot = await ctx.newPage()
client.on('pageerror', (e) => log('client pageerror:', e.message))
depot.on('pageerror', (e) => log('depot pageerror:', e.message))

await client.goto(`${BASE}/`, { waitUntil: 'networkidle' })
await depot.goto(`${BASE}/?role=depot`, { waitUntil: 'networkidle' })
log('both tabs open')

// --- pair -----------------------------------------------------------
await client.getByRole('button', { name: 'Show pairing code' }).click()
// The payload lives inside a collapsed <details>, so it is present but
// not visible; read it from the DOM rather than waiting for visibility.
await client.waitForFunction(() => !!document.querySelector('.pair-fallback pre'), null, { timeout: 20000 })
const payload = await client.evaluate(() => document.querySelector('.pair-fallback pre').textContent)
log('QR payload captured:', payload.replace(/\s+/g, ' ').slice(0, 70), '…')

await depot.locator('textarea').first().fill(payload)
await depot.getByRole('button', { name: /Join pairing/i }).click()
log('depot joining')

await depot.waitForSelector('.sas-digits, .sasweb', { timeout: 25000 })
const depotSas = (await depot.locator('.sas-digits, .sasweb').first().innerText()).replace(/\s+/g, '')
const clientSas = (await client.locator('.sasweb').first().innerText()).replace(/\s+/g, '')
log('SAS  client =', clientSas, ' depot =', depotSas, clientSas === depotSas ? '✓ match' : '✗ MISMATCH')

await depot.getByRole('button', { name: /^Approve$/i }).click()
log('approved')
await client.waitForTimeout(3000)

// --- the Depot is paired but not listening yet ----------------------
// A phone whose owner has not started it is not a broken network. This
// asserts the difference, because getting it wrong sent someone off to
// debug Wi-Fi that was working, and made them reload the page by hand.
const waiting = await client.locator('.waitwrap').count()
const failed = await client.locator('.failwrap').count()
log(`depot not started yet -> waiting=${waiting} failed=${failed}`,
  waiting === 1 && failed === 0 ? '✓ waits' : '✗ WRONG STATE')

// --- depot listens, sharing nothing yet -----------------------------
await depot.getByRole('button', { name: /Start listening/i }).click()
log('depot listening — client should notice on its own, with no clicks')

// Deliberately no retry click and no reload: the poll has to do it.
await client.waitForSelector('.ftable', { timeout: 45000 })
log('client reconnected unaided')

const emptyRows = await client.locator('.fr:not(.fr-note)').count()
log(`listing before anything is shared: ${emptyRows} row(s)`, emptyRows === 0 ? '✓' : '✗ EXPECTED EMPTY')

// --- share a file at a Client that is already connected -------------
// The reported bug: this only appeared after reloading the browser.
await depot.locator('input[type=file]').setInputFiles('/tmp/sample.txt')
await client.waitForSelector('.fr:not(.fr-note)', { timeout: 20000 })
const rows = await client.locator('.fr:not(.fr-note)').allInnerTexts()
log('listing updated with no reload:', JSON.stringify(rows))

await client.waitForTimeout(600)
await client.screenshot({ path: '/tmp/client-files.png' })

// --- download it -----------------------------------------------------
await client.locator('.fr:not(.fr-note)').first().click()
await client.waitForSelector('.received-row', { timeout: 40000 })
log('received:', (await client.locator('.received-row').first().innerText()).replace(/\s+/g, ' '))
await client.screenshot({ path: '/tmp/client-received.png' })

// --- a file already in hand is not asked for twice -------------------
// One log line per completed fetch, so counting them is how "did it go
// back over the wire?" gets answered rather than assumed.
const fetches = () =>
  client.locator('.log-line', { hasText: 'verified against the manifest' }).count()
const before = await fetches()
await client.waitForSelector('.fr .held', { timeout: 10000 })
log(`row marked HELD after the transfer ✓  (fetches so far: ${before})`)

await client.locator('.fr:not(.fr-note)').first().click()
await client.waitForSelector('.pv', { timeout: 10000 })
const after = await fetches()
log(`second click -> preview open, fetches ${before} -> ${after}`,
  after === before ? '✓ nothing re-downloaded' : '✗ FETCHED AGAIN')

const shown = await client.locator('.pv-text').innerText()
log('preview text starts:', JSON.stringify(shown.slice(0, 40)),
  shown.startsWith('the quick brown fox') ? '✓ shows the real contents' : '✗ WRONG CONTENT')
await client.screenshot({ path: '/tmp/client-preview-text.png' })
await client.keyboard.press('Escape')
await client.waitForSelector('.pv', { state: 'detached', timeout: 5000 })
log('Escape closed it ✓')

// --- swapping the offered file invalidates the held copy -------------
// Same slot on the Depot, different bytes. The browser must not go on
// showing what it happens to be holding.
await depot.locator('input[type=file]').setInputFiles('/tmp/sample.png')
await client.waitForFunction(
  () => {
    const row = document.querySelector('.fr:not(.fr-note) .fn')
    return !!row && row.textContent.endsWith('.png')
  },
  null,
  { timeout: 20000 },
)
const heldOnNewFile = await client.locator('.fr .held').count()
log(`listing swapped to the png; stale HELD marks: ${heldOnNewFile}`,
  heldOnNewFile === 0 ? '✓ not claimed as held' : '✗ CLAIMS TO HOLD THE OLD FILE')

await client.locator('.fr:not(.fr-note)').first().click()
await client.waitForSelector('.fr .held', { timeout: 40000 })
const afterPng = await fetches()
log(`png fetched (${before} -> ${afterPng})`, afterPng > before ? '✓ went over the wire' : '✗ SERVED STALE BYTES')

await client.locator('.fr:not(.fr-note)').first().click()
await client.waitForSelector('.pv img', { timeout: 10000 })
const decoded = await client.evaluate(() => {
  const img = document.querySelector('.pv img')
  return { complete: img.complete, w: img.naturalWidth, h: img.naturalHeight }
})
log('image preview:', JSON.stringify(decoded),
  decoded.complete && decoded.w > 0 ? '✓ the browser decoded it' : '✗ BROKEN IMAGE')
await client.screenshot({ path: '/tmp/client-preview-image.png' })
await client.keyboard.press('Escape')

// --- a reload must not throw away what already arrived ---------------
// The report: everything under RECEIVED vanished on refresh, and the
// same bytes had to come over the phone's data a second time.
const fetchesBeforeReload = await fetches()
await client.reload({ waitUntil: 'networkidle' })
await client.waitForSelector('.received-row', { timeout: 45000 })
const survived = await client.locator('.received-row').allInnerTexts()
log('after reload, RECEIVED holds:', JSON.stringify(survived.map((t) => t.split('\n')[0])))
await client.waitForSelector('.ftable', { timeout: 45000 })
await client.waitForSelector('.fr .held', { timeout: 20000 })
log('the row is still marked HELD after a reload ✓')

// And clicking it must open, not re-fetch.
await client.locator('.fr:not(.fr-note)').first().click()
await client.waitForSelector('.pv', { timeout: 10000 })
const fetchesAfterReload = await fetches()
log(
  `clicked after reload: fetches this page = ${fetchesAfterReload}`,
  fetchesAfterReload === 0
    ? '✓ opened from the cache, nothing re-downloaded'
    : '✗ WENT BACK OVER THE WIRE',
)
log(`(before the reload this page had done ${fetchesBeforeReload})`)
await client.keyboard.press('Escape')

// --- what the browser admits to holding ------------------------------
await client.getByRole('button', { name: 'Settings' }).click()
await client.waitForFunction(
  () => {
    const el = document.querySelector('.cache-usage')
    return !!el && !el.textContent.includes('Reading')
  },
  null,
  { timeout: 10000 },
)
const usage = await client.locator('.cache-usage').innerText()
log('settings reports held files:', JSON.stringify(usage))
await client.screenshot({ path: '/tmp/client-settings.png' })
await client.getByRole('button', { name: 'Close' }).click()
await client.waitForSelector('.ftable', { timeout: 10000 })

// --- a preview that cannot decode must say so ------------------------
await depot.locator('input[type=file]').setInputFiles('/tmp/broken.jpg')
await client.waitForFunction(
  () => document.querySelector('.fr:not(.fr-note) .fn')?.textContent?.endsWith('.jpg'),
  null,
  { timeout: 20000 },
)
await client.locator('.fr:not(.fr-note)').first().click()
await client.waitForSelector('.fr .held', { timeout: 40000 })
await client.locator('.fr:not(.fr-note)').first().click()
await client.waitForSelector('.pv', { timeout: 10000 })
await client.waitForTimeout(1200)
const broken = await client.evaluate(() => {
  const note = document.querySelector('.pv-none')
  const img = document.querySelector('.pv img')
  return { explained: note ? note.innerText.replace(/\s+/g, ' ').slice(0, 90) : null, stillShowingImg: !!img }
})
log('undecodable image:', JSON.stringify(broken))
log(
  broken.explained && !broken.stillShowingImg
    ? '  ✓ says what happened instead of going blank'
    : '  ✗ BLANK PANEL — the user is told nothing',
)
await client.screenshot({ path: '/tmp/client-preview-failed.png' })
await client.keyboard.press('Escape')

// --- a pdf, the one kind that needs a frame --------------------------
// Worth its own step: the frame carries no sandbox (see preview.ts), and
// that decision is only defensible if it is the one that renders.
await depot.locator('input[type=file]').setInputFiles('/tmp/sample.pdf')
await client.waitForFunction(
  () => {
    const row = document.querySelector('.fr:not(.fr-note) .fn')
    return !!row && row.textContent.endsWith('.pdf')
  },
  null,
  { timeout: 20000 },
)
await client.locator('.fr:not(.fr-note)').first().click()
await client.waitForSelector('.fr .held', { timeout: 40000 })
await client.locator('.fr:not(.fr-note)').first().click()
await client.waitForSelector('.pv-frame', { timeout: 10000 })
await client.waitForTimeout(3000)
// Chromium draws a broken-file icon on a grey field when the viewer
// refuses the document, so a white page is the thing to look for.
const pdfPixels = await client.evaluate(async () => {
  const box = document.querySelector('.pv-frame').getBoundingClientRect()
  return { w: Math.round(box.width), h: Math.round(box.height) }
})
const shot = await client.screenshot({ path: '/tmp/client-preview-pdf.png' })
log('pdf frame:', JSON.stringify(pdfPixels), `screenshot ${shot.length} bytes -> /tmp/client-preview-pdf.png`)
await client.keyboard.press('Escape')

// Put the text file back, so the rest of the run is unchanged.
await depot.locator('input[type=file]').setInputFiles('/tmp/sample.txt')
await client.waitForFunction(
  () => {
    const row = document.querySelector('.fr:not(.fr-note) .fn')
    return !!row && row.textContent.endsWith('.txt')
  },
  null,
  { timeout: 20000 },
)

// --- the Depot goes away, then comes back ---------------------------
// The other reported bug: turning the phone's terminal off and on again
// left the browser showing a dead connection until it was reloaded.
await depot.getByRole('button', { name: /Stop listening/i }).click()
log('depot stopped')
await client.waitForSelector('.waitwrap', { timeout: 30000 })
log('client noticed the Depot went away ✓')

await depot.getByRole('button', { name: /Start listening/i }).click()
log('depot listening again')
await client.waitForSelector('.ftable', { timeout: 45000 })
log('client came back unaided ✓')

// --- a preview must not become a way in ------------------------------
// preview.ts asserts a type on the blob rather than letting the browser
// sniff one, and the PDF frame carries no sandbox because a sandbox
// breaks the viewer. That is only defensible if the assertion really is
// what stops a document executing, so it is re-measured here against a
// file whose bytes are a script that reaches for this origin's storage.
const escapes = await client.evaluate(async () => {
  localStorage.setItem('depot-e2e-canary', 'pretend-identity-key')
  const evil =
    "<script>try{parent.postMessage('ESCAPED '+JSON.stringify(Object.keys(localStorage)),'*')}" +
    "catch(e){parent.postMessage('BLOCKED','*')}<\/script>"
  const attempt = async (mime) => {
    const blob = mime ? new Blob([evil], { type: mime }) : new Blob([evil])
    const url = URL.createObjectURL(blob)
    const frame = document.createElement('iframe')
    frame.src = url
    frame.style.cssText = 'position:fixed;left:-9999px;width:10px;height:10px'
    document.body.appendChild(frame)
    const said = await new Promise((resolve) => {
      const on = (e) => { removeEventListener('message', on); resolve(String(e.data)) }
      addEventListener('message', on)
      setTimeout(() => { removeEventListener('message', on); resolve('(silent)') }, 2500)
    })
    frame.remove()
    URL.revokeObjectURL(url)
    return said
  }
  const out = {
    asPdf: await attempt('application/pdf'),
    untyped: await attempt(''),
    // The control. If this one is silent the whole measurement is
    // meaningless, because nothing was ever capable of escaping.
    asHtml: await attempt('text/html'),
  }
  localStorage.removeItem('depot-e2e-canary')
  return out
})
log('html wearing a .pdf name:', JSON.stringify(escapes))
log(
  escapes.asHtml.startsWith('ESCAPED')
    ? '  control escaped, so the test can tell the difference ✓'
    : '  ✗ CONTROL DID NOT ESCAPE — this proves nothing, fix the probe',
)
log(
  escapes.asPdf === '(silent)' && escapes.untyped === '(silent)'
    ? '  asserting application/pdf kept it out ✓'
    : '  ✗ A PREVIEW CAN EXECUTE IN THIS ORIGIN',
)

const box = await client.evaluate(() => {
  const r = (s) => {
    const el = document.querySelector(s)
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }
  }
  return { viewport: { w: innerWidth, h: innerHeight }, nav: r('.wnav'), side: r('.side'), main: r('.main') }
})
log('layout:', JSON.stringify(box))

await browser.close()
log('done')
