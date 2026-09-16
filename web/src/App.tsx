import { useState } from 'react'
import './App.css'
import { ClientView } from './components/ClientView'
import { DepotSimulatorView } from './components/DepotSimulatorView'
import { LaptopIcon, PhoneIcon } from './components/icons'
import { defaultSignalUrl, isLoopbackSignalUrl } from './signalUrl'
import type { TurnConfig } from './transport/webrtc'

type Role = 'client' | 'depot'

function initialRole(): Role {
  try {
    return new URLSearchParams(window.location.search).get('role') === 'depot' ? 'depot' : 'client'
  } catch {
    return 'client'
  }
}

function initialSignalUrl(): string {
  try {
    return localStorage.getItem('depot:signalUrl') ?? defaultSignalUrl()
  } catch {
    return defaultSignalUrl()
  }
}

const EMPTY_TURN: TurnConfig = { url: '', username: '', credential: '' }

function initialTurnConfig(): TurnConfig {
  try {
    const raw = localStorage.getItem('depot:turnServer')
    if (!raw) return EMPTY_TURN
    return { ...EMPTY_TURN, ...(JSON.parse(raw) as Partial<TurnConfig>) }
  } catch {
    return EMPTY_TURN
  }
}

function App() {
  const [role, setRole] = useState<Role>(initialRole)
  const [signalUrl, setSignalUrl] = useState(initialSignalUrl)
  const [turnConfig, setTurnConfig] = useState<TurnConfig>(initialTurnConfig)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const switchRole = (next: Role) => {
    setRole(next)
    try {
      const url = new URL(window.location.href)
      if (next === 'depot') url.searchParams.set('role', 'depot')
      else url.searchParams.delete('role')
      window.history.replaceState(null, '', url)
    } catch {
      // URL/history unavailable (e.g. sandboxed preview) — role still switches in-memory.
    }
  }

  const updateSignalUrl = (value: string) => {
    setSignalUrl(value)
    try {
      localStorage.setItem('depot:signalUrl', value)
    } catch {
      // best-effort persistence only
    }
  }

  const updateTurnConfig = (next: TurnConfig) => {
    setTurnConfig(next)
    try {
      localStorage.setItem('depot:turnServer', JSON.stringify(next))
    } catch {
      // best-effort persistence only
    }
  }

  // Empty URL means "not configured" — treated as no TURN server at all,
  // rather than threading blank strings down into RTCPeerConnection.
  const turnForTransport = turnConfig.url.trim() ? turnConfig : undefined

  return (
    <div id="app">
      <header>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <h1>Depot</h1>
        </div>
        <p className="hint">
          Two roles, one page — open this URL in a second tab with <code>?role=depot</code> to run the Client and
          the Depot simulator side by side.
        </p>

        <div className="role-switch" role="tablist" aria-label="Role">
          <button
            role="tab"
            aria-selected={role === 'client'}
            className={role === 'client' ? 'active' : ''}
            onClick={() => switchRole('client')}
          >
            <LaptopIcon />
            Client
          </button>
          <button
            role="tab"
            aria-selected={role === 'depot'}
            className={role === 'depot' ? 'active' : ''}
            onClick={() => switchRole('depot')}
          >
            <PhoneIcon />
            Depot simulator
          </button>
        </div>

        <button type="button" className="settings-toggle" onClick={() => setSettingsOpen((v) => !v)}>
          {settingsOpen ? 'Hide' : 'Show'} connection settings
        </button>
        {settingsOpen && (
          <div className="settings-panel">
            <label className="signal-url">
              Signal server
              <input value={signalUrl} onChange={(e) => updateSignalUrl(e.target.value)} spellCheck={false} />
            </label>
            {isLoopbackSignalUrl(signalUrl) && (
              <p className="hint signal-url-warning">
                This address goes into the QR code, and on a phone it points at the phone itself. To pair a
                real device, open this page at your computer&rsquo;s LAN address (for example{' '}
                <code>http://192.168.1.11:5173/</code>) and this field will follow.
              </p>
            )}

            <p className="hint settings-section-label">
              TURN server (optional — only needed when a direct or STUN-assisted connection fails; see the
              project's docker-compose.yml to self-host one)
            </p>
            <label className="signal-url">
              URL
              <input
                value={turnConfig.url}
                onChange={(e) => updateTurnConfig({ ...turnConfig, url: e.target.value })}
                placeholder="turn:turn.example.com:3478"
                spellCheck={false}
              />
            </label>
            <label className="signal-url">
              Username
              <input
                value={turnConfig.username}
                onChange={(e) => updateTurnConfig({ ...turnConfig, username: e.target.value })}
                spellCheck={false}
              />
            </label>
            <label className="signal-url">
              Credential
              <input
                type="password"
                value={turnConfig.credential}
                onChange={(e) => updateTurnConfig({ ...turnConfig, credential: e.target.value })}
                spellCheck={false}
              />
            </label>
          </div>
        )}
      </header>

      {role === 'client' ? (
        <ClientView signalUrl={signalUrl} turnConfig={turnForTransport} />
      ) : (
        <DepotSimulatorView signalUrl={signalUrl} turnConfig={turnForTransport} />
      )}
    </div>
  )
}

export default App
