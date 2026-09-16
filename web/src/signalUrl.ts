/**
 * The Signal URL travels inside the pairing QR (protocol.md §3.1), so it
 * has to be an address the *phone* can reach. A hardcoded localhost put a
 * URL in the QR that resolves to the phone itself, and the Depot then
 * failed to connect to nothing in particular.
 */

/** Derived from the page's own host, so opening this app at a LAN address produces a QR that works. */
export function defaultSignalUrl(): string {
  try {
    return `ws://${window.location.hostname}:8080/ws`
  } catch {
    return 'ws://localhost:8080/ws'
  }
}

/** Addresses that mean "this machine", and so cannot travel in a QR. */
export function isLoopbackSignalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}
