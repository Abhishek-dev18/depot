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
 * CI runs it on every push (the `browser` job), so a change that breaks
 * pairing, browsing or a transfer is caught there rather than here.
 *
 * Screenshots land in /tmp. Not part of `npm test`: it wants two servers
 * and a real browser, which is a different kind of slow.
 */
import { writeFileSync } from 'node:fs'
import { launchChromium } from './browser.mjs'

const BASE = 'http://localhost:4173'
const log = (...a) => console.log('[e2e]', ...a)

/**
 * The row for whatever the Depot is currently sharing.
 *
 * The listing also carries the Inbox folder (§5.10), so "the first row"
 * stopped meaning "the shared file" — targeting by name rather than by
 * position is what keeps these steps saying what they mean.
 */
const shared = () => client.locator('.fr:not(.fr-note)').filter({ hasNotText: 'Inbox' })

/**
 * Offers exactly these files and nothing else.
 *
 * Picking is additive now — that is the whole point of the multi-file
 * work — so a step that wants "the Depot is sharing this one thing"
 * has to say so, rather than relying on a new pick wiping the last.
 */
const offerOnly = async (paths) => {
  const stops = depot.locator('.offer-list .linkish')
  for (let n = await stops.count(); n > 0; n = await stops.count()) {
    await stops.first().click()
  }
  await depot.locator('input[type=file]').setInputFiles(paths)
}

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
writeFileSync('/tmp/one.txt', 'first of several\n'.repeat(60))
writeFileSync('/tmp/two.txt', 'second of several\n'.repeat(80))
writeFileSync('/tmp/upload.txt', 'sent from the browser to the phone\n'.repeat(120))
writeFileSync('/tmp/fetchonly.txt', 'fetched without opening\n'.repeat(50))
// Over MAX_PREVIEW_SIZE, so the preview must refuse before it starts.
writeFileSync('/tmp/huge.txt', 'x'.repeat(52_000_000))
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

const browser = await launchChromium()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })

const client = await ctx.newPage()
const depot = await ctx.newPage()
client.on('pageerror', (e) => log('client pageerror:', e.message))
depot.on('pageerror', (e) => log('depot pageerror:', e.message))

/**
 * What both sides thought was going on when a step gave up.
 *
 * A bare "waitForFunction timed out" names the line and nothing else,
 * which on a two-tab protocol test is the least useful half of the
 * story: the question is always whether the Depot never sent it or the
 * Client never showed it.
 */
process.on('uncaughtException', (err) => {
  const tail = (page, sel, n) =>
    page.evaluate(
      ([s, k]) => [...document.querySelectorAll(s)].slice(-k).map((el) => el.textContent.trim()),
      [sel, n],
    ).catch(() => ['(unreadable)'])
  ;(async () => {
    log('FAILED:', err.message.split('\n')[0])
    log('  client rows:  ', JSON.stringify(await tail(client, '.fr:not(.fr-note) .fn', 20)))
    log('  depot offering:', JSON.stringify(await tail(depot, '.offer-list li', 20)))
    log('  depot log:    ', JSON.stringify(await tail(depot, '.log-line', 40)))
    log('  client log:   ', JSON.stringify(await tail(client, '.log-line', 40)))
    await client.screenshot({ path: '/tmp/failure-client.png' }).catch(() => {})
    await depot.screenshot({ path: '/tmp/failure-depot.png' }).catch(() => {})
  })().finally(() => process.exit(1))
})

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
const noticedAt = Date.now()
await depot.getByRole('button', { name: /Start listening/i }).click()
log('depot listening — client should notice on its own, with no clicks')

// Deliberately no retry click and no reload.
await client.waitForSelector('.ftable', { timeout: 45000 })
// Reported, not asserted. Signal tells a waiting Client the moment a
// Depot registers (§7), which makes this a round trip rather than a
// poll interval — but the poll is still there as a fallback and can
// happen to fire early, so a threshold here would pass whether the
// notice worked or not. The relay's own tests prove the notice is sent;
// this figure is for a human reading the log.
log(`client reconnected unaided in ${Date.now() - noticedAt}ms`)

const emptyRows = await shared().count()
const inboxRows = await client.locator('.fr:not(.fr-note)').filter({ hasText: 'Inbox' }).count()
log(
  `before anything is shared: ${emptyRows} file(s), ${inboxRows} inbox`,
  emptyRows === 0 && inboxRows === 1 ? '✓ only the place uploads go' : '✗ UNEXPECTED LISTING',
)

// --- "check again now" must actually check ---------------------------
// It used to clear the flags and leave an effect to notice. From this
// screen that did nothing at all — `offline` is not one of that effect's
// dependencies — so pressing the button was how you switched the
// retrying off, and the page then waited for ever.
await depot.getByRole('button', { name: /Stop listening/i }).click()
await client.waitForSelector('.waitwrap', { timeout: 30000 })
const tickBefore = await client.locator('.tick').innerText()
await client.getByRole('button', { name: /Check again now/i }).click()
// A press that tries produces an attempt; a press that only clears
// flags produces silence, and the tick below never moves again.
await client.waitForFunction(
  (was) => {
    const tick = document.querySelector('.tick')
    return !!tick && tick.textContent !== was
  },
  tickBefore,
  { timeout: 30000 },
)
log('pressing "check again now" started another attempt ✓')

await depot.getByRole('button', { name: /Start listening/i }).click()
await client.waitForSelector('.ftable', { timeout: 60000 })
log('and it still reconnects on its own afterwards ✓')

// --- share a file at a Client that is already connected -------------
// The reported bug: this only appeared after reloading the browser.
await offerOnly('/tmp/sample.txt')
await client.waitForFunction(
  () => [...document.querySelectorAll('.fr:not(.fr-note) .fn')].some((n) => n.textContent === 'sample.txt'),
  null,
  { timeout: 20000 },
)
const rows = await shared().allInnerTexts()
log('listing updated with no reload:', JSON.stringify(rows))

await client.waitForTimeout(600)
await client.screenshot({ path: '/tmp/client-files.png' })

// --- click the file: fetch it and open it ----------------------------
// Clicking the name means "bring it over and show me". FETCH, tested
// further down, is the same transfer without the opening.
await shared().locator('.fr-open').first().click()
await client.waitForSelector('.received-row', { timeout: 40000 })
log('received:', (await client.locator('.received-row').first().innerText()).replace(/\s+/g, ' '))
await client.waitForSelector('.pv', { timeout: 15000 })
log('clicking the file opened it as well as fetching it ✓')
await client.keyboard.press('Escape')
await client.waitForSelector('.pv', { state: 'detached', timeout: 5000 })
await client.screenshot({ path: '/tmp/client-received.png' })

// --- a file already in hand is not asked for twice -------------------
// One log line per completed fetch, so counting them is how "did it go
// back over the wire?" gets answered rather than assumed.
const fetches = () =>
  client.locator('.log-line', { hasText: 'verified against the manifest' }).count()
const before = await fetches()
await client.waitForSelector('.fr .held', { timeout: 10000 })
log(`row marked HELD after the transfer ✓  (fetches so far: ${before})`)

await shared().locator('.fr-open').first().click()
await client.waitForSelector('.pv', { timeout: 10000 })
const after = await fetches()
log(`clicked again -> preview open, fetches ${before} -> ${after}`,
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
await offerOnly('/tmp/sample.png')
await client.waitForFunction(
  () => {
    return [...document.querySelectorAll('.fr:not(.fr-note) .fn')].some((n) =>
      n.textContent.endsWith('.png'),
    )
  },
  null,
  { timeout: 20000 },
)
const heldOnNewFile = await client.locator('.fr .held').count()
log(`listing swapped to the png; stale HELD marks: ${heldOnNewFile}`,
  heldOnNewFile === 0 ? '✓ not claimed as held' : '✗ CLAIMS TO HOLD THE OLD FILE')

await shared().locator('.fr-open').first().click()
await client.waitForSelector('.fr .held', { timeout: 40000 })
await client.keyboard.press('Escape')
await client.waitForSelector('.pv', { state: 'detached', timeout: 8000 })
const afterPng = await fetches()
log(`png fetched (${before} -> ${afterPng})`, afterPng > before ? '✓ went over the wire' : '✗ SERVED STALE BYTES')

await shared().locator('.fr-open').first().click()
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
await shared().locator('.fr-open').first().click()
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

// --- two ways to click a row, and two verbs on what arrived ----------
// FETCH brings it over and says nothing more; the name brings it over
// and opens it. Below, PREVIEW stays in the browser and DOWNLOAD is the
// only thing that writes to the machine.
await offerOnly('/tmp/fetchonly.txt')
await client.waitForFunction(
  () => [...document.querySelectorAll('.fr:not(.fr-note) .fn')].some((n) => n.textContent === 'fetchonly.txt'),
  null,
  { timeout: 20000 },
)
const beforeFetch = await fetches()
await shared().locator('.fr-fetch').first().click()
await client.waitForSelector('.fr .held', { timeout: 40000 })
const openedByFetch = await client.locator('.pv').count()
log(
  `FETCH: fetches ${beforeFetch} -> ${await fetches()}, preview open = ${openedByFetch}`,
  openedByFetch === 0 ? '✓ brought it over without opening it' : '✗ OPENED A PREVIEW',
)

const row = client.locator('.received-row').filter({ hasText: 'fetchonly.txt' })
const verbs = await row.locator('.received-act').allInnerTexts()
log('verbs on the received row:', JSON.stringify(verbs),
  verbs.join(',') === 'PREVIEW,DOWNLOAD' ? '✓' : '✗ WRONG ACTIONS')
const downloadHref = await row.locator('a.received-act.download').getAttribute('download')
log('download writes to disk as:', JSON.stringify(downloadHref),
  downloadHref === 'fetchonly.txt' ? '✓ and only on click' : '✗')

await row.locator('button.received-act').click()
await client.waitForSelector('.pv', { timeout: 10000 })
log('PREVIEW opened from the cache ✓  (fetches unchanged:', await fetches(), ')')
await client.keyboard.press('Escape')
await client.waitForSelector('.pv', { state: 'detached', timeout: 5000 })

// --- too large to draw: shadowed, and it says why --------------------
await offerOnly('/tmp/huge.txt')
await client.waitForFunction(
  () => [...document.querySelectorAll('.fr:not(.fr-note) .fn')].some((n) => n.textContent === 'huge.txt'),
  null,
  { timeout: 20000 },
)
await shared().locator('.fr-open').first().click()
await client.waitForSelector('.dlg', { timeout: 10000 })
const refusal = await client.evaluate(() => ({
  title: document.querySelector('.dlg-title')?.textContent,
  body: document.querySelector('.dlg-body')?.textContent,
  offers: [...document.querySelectorAll('.dlg-actions button')].map((b) => b.textContent),
}))
log('clicking a too-large file:', JSON.stringify(refusal))
log(
  refusal.title === 'Too large to preview' && refusal.offers.includes('Fetch it anyway')
    ? '  ✓ refused, explained, and still offers the thing that works'
    : '  ✗ WRONG REFUSAL',
)
await client.screenshot({ path: '/tmp/client-toobig.png' })
await client.locator('.dlg-go').click()
await client.waitForSelector('.fr .held', { timeout: 60000 })

const shadowed = await client.evaluate(() => {
  const r = [...document.querySelectorAll('.received-row')].find((x) => x.textContent.includes('huge.txt'))
  const b = r?.querySelector('button.received-act')
  const style = b ? getComputedStyle(b) : null
  return {
    dimmed: b?.className.includes('off') && Number(style?.opacity) < 1,
    // Not disabled in any sense a machine reads: it still takes clicks,
    // and a screen reader is not told otherwise.
    reallyClickable: b !== null && !b?.hasAttribute('disabled') && !b?.hasAttribute('aria-disabled'),
    explains: (b?.getAttribute('title') ?? '').slice(0, 40),
  }
})
log('its PREVIEW in the lower list:', JSON.stringify(shadowed),
  shadowed.dimmed && shadowed.reallyClickable ? '✓ shadowed but live' : '✗ WRONG STATE')

// Shadowed, not disabled: the click still lands and gets an answer.
await client
  .locator('.received-row')
  .filter({ hasText: 'huge.txt' })
  .locator('button.received-act')
  .click()
await client.waitForSelector('.dlg', { timeout: 10000 })
log('clicking the shadowed PREVIEW still explains itself ✓')
await client.keyboard.press('Escape')

// --- a preview that cannot decode must say so ------------------------
await offerOnly('/tmp/broken.jpg')
await client.waitForFunction(
  () => [...document.querySelectorAll('.fr:not(.fr-note) .fn')].some((n) => n.textContent.endsWith('.jpg')),
  null,
  { timeout: 20000 },
)
await shared().locator('.fr-open').first().click()
await client.waitForSelector('.pv', { timeout: 40000 })
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
await offerOnly('/tmp/sample.pdf')
await client.waitForFunction(
  () => [...document.querySelectorAll('.fr:not(.fr-note) .fn')].some((n) => n.textContent.endsWith('.pdf')),
  null,
  { timeout: 20000 },
)
await shared().locator('.fr-open').first().click()
await client.waitForSelector('.pv-frame', { timeout: 40000 })
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
await offerOnly('/tmp/sample.txt')
await client.waitForFunction(
  () => {
    return [...document.querySelectorAll('.fr:not(.fr-note) .fn')].some(
      (n) => n.textContent === 'sample.txt',
    )
  },
  null,
  { timeout: 20000 },
)

// --- §5.10: the direction that writes --------------------------------
// The Depot's Inbox is the one folder it accepts into. Everything else
// must not even offer the control.
await client.locator('.crumb-link').first().click()
await client.waitForSelector('.ftable', { timeout: 15000 })
const offeredAtRoot = await client.locator('.uprow').count()
log(`in-folder upload control at the root: ${offeredAtRoot}`,
  offeredAtRoot === 0 ? '✓ not offered where it is not allowed' : '✗ OFFERED EVERYWHERE')

// --- sending without having to find the folder first -----------------
// The control above appears only once you are standing in a folder the
// Depot accepts into, which meant sending existed and could not be
// found. This one is on the first screen and names where things go.
writeFileSync('/tmp/send-a.txt', 'first of two sent up\n'.repeat(40))
writeFileSync('/tmp/send-b.txt', 'second of two sent up\n'.repeat(55))

const sendPanel = await client.evaluate(() => {
  const box = document.querySelector('.sendbox')
  return {
    present: !!box,
    says: box?.innerText.replace(/\s+/g, ' ').slice(0, 80) ?? '',
  }
})
log('send panel at the root:', JSON.stringify(sendPanel),
  sendPanel.present && sendPanel.says.includes('Inbox')
    ? '✓ offered, and names where things land'
    : '✗ NO WAY TO SEND WITHOUT BROWSING')

await client.locator('.sendbox .upbtn input').setInputFiles(['/tmp/send-a.txt', '/tmp/send-b.txt'])
// Both, one after the other: they share one channel, so they queue.
await client.waitForFunction(
  () => {
    const rows = [...document.querySelectorAll('.out-row')]
    return rows.length === 2 && rows.every((r) => r.classList.contains('out-sent'))
  },
  null,
  { timeout: 90000 },
)
const outbox = await client.locator('.out-row').allInnerTexts()
log('outbox after sending two at once:', JSON.stringify(outbox.map((t) => t.replace(/\s+/g, ' '))))

const bothOnDepot = await depot.locator('.inbox-list li').allInnerTexts()
log('the Depot holds:', JSON.stringify(bothOnDepot),
  bothOnDepot.some((t) => t.includes('send-a.txt')) && bothOnDepot.some((t) => t.includes('send-b.txt'))
    ? '✓ both arrived'
    : '✗ NOT BOTH STORED')

// The point of keeping them listed: what you sent stays on screen.
const stillListed = await client.locator('.out-row').count()
log(`outbox still shows ${stillListed} file(s) after both finished`,
  stillListed === 2 ? '✓ kept for the session' : '✗ CLEARED ITSELF')

await client.locator('.fr-open').filter({ hasText: 'Inbox' }).first().click()
await client.waitForSelector('.uprow', { timeout: 15000 })
log('inside Inbox, the control appears ✓')

await client.locator('.uprow .upbtn input').setInputFiles('/tmp/upload.txt')
// By name. The send panel above has already put two files in here and
// logged them, so waiting for "sent to Inbox" was satisfied before this
// upload had even started — and the check below then read the folder
// too early, failing about one run in three.
await client.waitForFunction(
  () =>
    [...document.querySelectorAll('.log-line')].some((l) =>
      l.textContent.includes('upload.txt sent to Inbox'),
    ),
  null,
  { timeout: 60000 },
)
const sentLine = await client.evaluate(
  () => [...document.querySelectorAll('.log-line')].filter((l) => l.textContent.includes('sent to')).pop()
    .textContent,
)
log('upload:', JSON.stringify(sentLine))

const onDepot = await depot.locator('.inbox-list li').allInnerTexts()
log('the Depot now holds:', JSON.stringify(onDepot),
  onDepot.includes('upload.txt') ? '✓ it arrived' : '✗ NOT STORED')

// Browsing must survive the upload: the listing effect used to reset
// the breadcrumb on any re-render, which a finishing upload causes.
const afterFirst = await client.evaluate(() => ({
  uprow: document.querySelectorAll('.uprow').length,
  crumb: document.querySelector('.crumb')?.innerText.replace(/\s+/g, ' '),
}))
log('still in the folder afterwards:', JSON.stringify(afterFirst),
  afterFirst.uprow === 1 && afterFirst.crumb?.includes('Inbox') ? '✓' : '✗ THROWN BACK TO THE ROOT')

// Send it again: the Depot must not overwrite.
await client.locator('.uprow .upbtn input').setInputFiles('/tmp/upload.txt')
await client.waitForFunction(
  () => [...document.querySelectorAll('.log-line')].some((l) => l.textContent.includes('that name was taken')),
  null,
  { timeout: 60000 },
)
const afterSecond = await depot.locator('.inbox-list li').allInnerTexts()
// By name rather than by count: other steps have put files here too,
// and what is under test is that the second upload.txt did not land on
// top of the first.
const uploads = afterSecond.filter((t) => t.startsWith('upload'))
log('after sending the same name twice:', JSON.stringify(uploads),
  uploads.length === 2 && uploads.some((t) => t.includes('(1)'))
    ? '✓ kept both, overwrote neither'
    : '✗ OVERWROTE')

// And the Client can read back what it just sent.
await client.waitForFunction(
  () => document.querySelectorAll('.fr:not(.fr-note)').length >= 2,
  null,
  { timeout: 20000 },
)
await client.locator('.fr-open').filter({ hasText: 'upload.txt' }).first().click()
await client.waitForSelector('.pv-text', { timeout: 40000 })
const roundTripped = await client.locator('.pv-text').innerText()
log('read back what was sent up:', JSON.stringify(roundTripped.slice(0, 34)),
  roundTripped.startsWith('sent from the browser') ? '✓ byte for byte' : '✗ WRONG CONTENT')
await client.screenshot({ path: '/tmp/client-upload.png' })
await client.keyboard.press('Escape')
await client.locator('.crumb-link').first().click()
await client.waitForSelector('.ftable', { timeout: 15000 })

// --- several files at once, and adding one keeps the rest ------------
// Picking a second file used to un-share the first, so sending two meant
// sending one and then losing it.
await offerOnly(['/tmp/one.txt', '/tmp/two.txt'])
await client.waitForFunction(
  () => {
    const names = [...document.querySelectorAll('.fr:not(.fr-note) .fn')].map((n) => n.textContent)
    return names.includes('one.txt') && names.includes('two.txt')
  },
  null,
  { timeout: 20000 },
)
log('two files picked at once both appear ✓')

// Fetch the first, then add a third: the first must stay held, which
// means its handle did not move under it.
await client.locator('.fr-open').filter({ hasText: 'one.txt' }).first().click()
await client.waitForSelector('.pv', { timeout: 40000 })
await client.keyboard.press('Escape')
await client.waitForSelector('.pv', { state: 'detached', timeout: 5000 })
const fetchesAfterFirst = await fetches()

await depot.locator('input[type=file]').setInputFiles('/tmp/sample.pdf')
await client.waitForFunction(
  () => [...document.querySelectorAll('.fr:not(.fr-note) .fn')].some((n) => n.textContent === 'sample.pdf'),
  null,
  { timeout: 20000 },
)
const stillHeld = await client.evaluate(() =>
  [...document.querySelectorAll('.fr:not(.fr-note)')]
    .filter((r) => r.textContent.includes('one.txt'))
    .some((r) => r.querySelector('.held') !== null),
)
log('after adding a third file, one.txt is still marked HELD:', stillHeld, stillHeld ? '✓' : '✗ ITS HANDLE MOVED')

// And opening it again costs nothing, which is the point of that.
await client.locator('.fr-open').filter({ hasText: 'one.txt' }).first().click()
await client.waitForSelector('.pv', { timeout: 15000 })
log(`reopened it: fetches ${fetchesAfterFirst} -> ${await fetches()}`,
  (await fetches()) === fetchesAfterFirst ? '✓ nothing re-downloaded' : '✗ FETCHED AGAIN')
await client.keyboard.press('Escape')
await client.waitForSelector('.pv', { state: 'detached', timeout: 5000 })

// Removing one leaves the others.
await depot.locator('.offer-list .linkish').first().click()
await client.waitForFunction(
  () => [...document.querySelectorAll('.fr:not(.fr-note) .fn')].every((n) => n.textContent !== 'one.txt'),
  null,
  { timeout: 20000 },
)
const remaining = await client.evaluate(() =>
  [...document.querySelectorAll('.fr:not(.fr-note) .fn')].map((n) => n.textContent),
)
log('after removing one.txt:', JSON.stringify(remaining),
  remaining.includes('two.txt') && remaining.includes('sample.pdf') ? '✓ the rest stayed' : '✗ TOOK OTHERS WITH IT')

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

// Light mode, then clearing what is held — last, because it empties the
// list everything above depends on.
await client.click('.wnav-theme') // system -> light
const theme = await client.evaluate(() => document.documentElement.dataset.theme)
if (theme !== 'light') throw new Error(`the theme button left the page ${theme}`)
await client.screenshot({ path: '/tmp/client-light.png' })
log('light theme: ✓ applied (screenshot /tmp/client-light.png)')
await client.click('.wnav-theme') // light -> dark
await client.click('.wnav-theme') // dark -> system, as it started

const heldBefore = await client.locator(".received-row").count()
if (heldBefore < 2) throw new Error(`expected at least two received files to clear, found ${heldBefore}`)
await client.locator('.received-row').first().locator('.received-remove').click()
await client.waitForFunction((n) => document.querySelectorAll('.received-row').length === n - 1, heldBefore)
log(`removing one received file: ${heldBefore} -> ${heldBefore - 1} ✓`)

await client.click('.received-clear')
await client.waitForFunction(() => document.querySelectorAll('.received-row').length === 0)
await client.reload()
await client.waitForTimeout(2500)
const afterReload = await client.locator('.received-row').count()
if (afterReload !== 0) throw new Error(`${afterReload} file(s) came back after CLEAR ALL and a reload`)
log('CLEAR ALL: list emptied, and nothing came back after a reload ✓')

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
