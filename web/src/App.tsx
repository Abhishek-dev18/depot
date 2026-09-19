import { useState } from 'react'
import './App.css'
import { ClientView } from './components/ClientView'
import { DepotSimulatorView } from './components/DepotSimulatorView'
import { ConnectionSettings } from './components/ConnectionSettings'
import { LaptopIcon, PhoneIcon } from './components/icons'
import { defaultSignalUrl } from './signalUrl'
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

  const settingsPanel = settingsOpen ? (
    <ConnectionSettings
      signalUrl={signalUrl}
      onSignalUrlChange={updateSignalUrl}
      turnConfig={turnConfig}
      onTurnConfigChange={updateTurnConfig}
      onClose={() => setSettingsOpen(false)}
      onOpenSimulator={role === 'client' ? () => switchRole('depot') : undefined}
    />
  ) : null

  // The Client fills the window; the simulator keeps the narrow column it
  // was built in. It is a form, and a form the width of a desktop is worse
  // than one that stays where the eye already is.
  if (role === 'client') {
    return (
      <div id="app" data-role="client">
        <ClientView
          signalUrl={signalUrl}
          turnConfig={turnForTransport}
          onOpenSettings={() => setSettingsOpen(true)}
          settingsPanel={settingsPanel}
        />
      </div>
    )
  }

  return (
    <div id="app" data-role="depot">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <h1>Depot simulator</h1>
        </div>
        <p className="hint">
          Stands in for the Android app so pairing, reconnection and transfer can be exercised from a
          second tab. The real Depot is the phone.
        </p>

        <div className="role-switch" role="tablist" aria-label="Role">
          <button role="tab" aria-selected={false} onClick={() => switchRole('client')}>
            <LaptopIcon />
            Client
          </button>
          <button role="tab" aria-selected className="active" onClick={() => switchRole('depot')}>
            <PhoneIcon />
            Depot simulator
          </button>
          <button type="button" className="settings-toggle" onClick={() => setSettingsOpen((v) => !v)}>
            {settingsOpen ? 'Hide' : 'Show'} connection settings
          </button>
        </div>
        {settingsPanel}
      </header>

      <DepotSimulatorView signalUrl={signalUrl} turnConfig={turnForTransport} />
    </div>
  )
}

export default App
