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
import { chromium } from 'playwright'

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const BASE = 'http://localhost:4173'
const log = (...a) => console.log('[e2e]', ...a)

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
