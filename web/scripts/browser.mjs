import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

/**
 * Launching Chromium wherever it happens to live.
 *
 * Three cases, and the scripts have to work in all of them: CI, which
 * runs `playwright install` and so has Playwright's own copy exactly
 * where it expects; a contributor's machine, the same; and a container
 * with a browser preinstalled somewhere Playwright does not look, where
 * PLAYWRIGHT_BROWSERS_PATH points at a build whose revision does not
 * match the installed Playwright.
 *
 * Hardcoding one path works until someone else runs it, and that is how
 * these scripts started.
 */
export async function launchChromium(options = {}) {
  const attempts = []

  if (process.env.CHROME) attempts.push(process.env.CHROME)
  // undefined means "whatever Playwright installed", which is the
  // normal case and the one CI is in.
  attempts.push(undefined)
  attempts.push(...discover())

  let lastError
  for (const executablePath of attempts) {
    try {
      return await chromium.launch({
        executablePath,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
        ...options,
      })
    } catch (err) {
      lastError = err
    }
  }
  throw new Error(
    `no Chromium could be launched. Tried: ${attempts.map((a) => a ?? "Playwright's own").join(', ')}\n` +
      `Install one with: npx playwright install chromium\n` +
      `Original error: ${lastError?.message ?? lastError}`,
  )
}

/** Any chrome-linux/chrome under the browsers path, newest revision first. */
function discover() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (!root) return []
  try {
    return readdirSync(root)
      .filter((name) => name.startsWith('chromium'))
      .sort()
      .reverse()
      .flatMap((name) => [
        join(root, name, 'chrome-linux', 'chrome'),
        join(root, name, 'chrome-linux', 'headless_shell'),
      ])
  } catch {
    return []
  }
}
