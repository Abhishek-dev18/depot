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
await client.waitForTimeout(2500)

// --- depot offers a file and listens --------------------------------
await depot.locator('input[type=file]').setInputFiles('/tmp/sample.txt')
await depot.waitForTimeout(700)
await depot.getByRole('button', { name: /Start listening/i }).click()
log('depot listening')
await depot.waitForTimeout(2500)

// --- client connects -------------------------------------------------
for (let attempt = 1; attempt <= 6; attempt++) {
  const browsing = await client.locator('.ftable').count()
  if (browsing > 0) break
  const failed = await client.locator('.failwrap').count()
  if (failed > 0) {
    log(`attempt ${attempt}: no route yet, retrying`)
    await client.locator('.opt').first().click()
  }
  await client.waitForTimeout(4000)
}

await client.waitForSelector('.ftable', { timeout: 30000 })
log('FILES screen reached')
await client.waitForTimeout(1200)
await client.screenshot({ path: '/tmp/client-files.png' })

const rows = await client.locator('.fr:not(.fr-note)').allInnerTexts()
log('listing rows:', JSON.stringify(rows))

// --- download it -----------------------------------------------------
if (rows.length > 0) {
  await client.locator('.fr:not(.fr-note)').first().click()
  await client.waitForSelector('.received-row', { timeout: 40000 })
  const got = await client.locator('.received-row').first().innerText()
  log('received:', got.replace(/\s+/g, ' '))
  await client.screenshot({ path: '/tmp/client-received.png' })
}

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
