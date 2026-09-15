import { useState } from 'react'
import './App.css'
import { ClientView } from './components/ClientView'
import { DepotSimulatorView } from './components/DepotSimulatorView'
import { LaptopIcon, PhoneIcon } from './components/icons'

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
    return localStorage.getItem('depot:signalUrl') ?? 'ws://localhost:8080/ws'
  } catch {
    return 'ws://localhost:8080/ws'
  }
}

function App() {
  const [role, setRole] = useState<Role>(initialRole)
  const [signalUrl, setSignalUrl] = useState(initialSignalUrl)
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
          {settingsOpen ? 'Hide' : 'Show'} signal server settings
        </button>
        {settingsOpen && (
          <label className="signal-url">
            Signal server
            <input value={signalUrl} onChange={(e) => updateSignalUrl(e.target.value)} spellCheck={false} />
          </label>
        )}
      </header>

      {role === 'client' ? <ClientView signalUrl={signalUrl} /> : <DepotSimulatorView signalUrl={signalUrl} />}
    </div>
  )
}

export default App
