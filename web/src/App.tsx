import { useState } from 'react'
import './App.css'
import { ClientView } from './components/ClientView'
import { DepotSimulatorView } from './components/DepotSimulatorView'

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
        <h1>Depot</h1>
        <p className="hint">
          Two roles, one page — open this URL in a second tab with <code>?role=depot</code> (or use the switch
          below) to run the Client and the Depot simulator side by side.
        </p>
        <div className="role-switch">
          <button className={role === 'client' ? 'active' : ''} onClick={() => switchRole('client')}>
            Client
          </button>
          <button className={role === 'depot' ? 'active' : ''} onClick={() => switchRole('depot')}>
            Depot simulator
          </button>
        </div>
        <label className="signal-url">
          Signal server
          <input value={signalUrl} onChange={(e) => updateSignalUrl(e.target.value)} spellCheck={false} />
        </label>
      </header>

      {role === 'client' ? <ClientView signalUrl={signalUrl} /> : <DepotSimulatorView signalUrl={signalUrl} />}
    </div>
  )
}

export default App
