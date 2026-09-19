import { isLoopbackSignalUrl } from '../signalUrl'
import type { TurnConfig } from '../transport/webrtc'

interface Props {
  signalUrl: string
  onSignalUrlChange: (value: string) => void
  turnConfig: TurnConfig
  onTurnConfigChange: (value: TurnConfig) => void
  onClose: () => void
  /** Only offered from the Client; the simulator is already here. */
  onOpenSimulator?: () => void
}

/**
 * The two addresses this browser needs: the relay both sides meet
 * through, and optionally a TURN server for when no direct route exists.
 *
 * Kept out of the way rather than on the page — the interface spec's
 * frames have no settings panel in them, because a Client that works does
 * not need one. It opens from the nav, and from the fallback screen that
 * has a reason to send you here.
 */
export function ConnectionSettings({
  signalUrl,
  onSignalUrlChange,
  turnConfig,
  onTurnConfigChange,
  onClose,
  onOpenSimulator,
}: Props) {
  return (
    <div className="settings-panel">
      <div className="settings-head">
        <span className="sl">CONNECTION</span>
        <button className="wnav-action" onClick={onClose}>
          Close
        </button>
      </div>

      <label className="signal-url">
        Signal server
        <input value={signalUrl} onChange={(e) => onSignalUrlChange(e.target.value)} spellCheck={false} />
      </label>
      {isLoopbackSignalUrl(signalUrl) && (
        <p className="hint signal-url-warning">
          This address goes into the QR code, and on a phone it points at the phone itself. To pair a real
          device, open this page at your computer&rsquo;s LAN address (for example{' '}
          <code>http://192.168.1.11:5173/</code>) and this field will follow.
        </p>
      )}

      <p className="hint settings-section-label">
        TURN server — only needed when no direct route exists. See the project&rsquo;s docker-compose.yml to
        run your own, so relayed bytes still cross only machines you chose.
      </p>
      <label className="signal-url">
        URL
        <input
          value={turnConfig.url}
          onChange={(e) => onTurnConfigChange({ ...turnConfig, url: e.target.value })}
          placeholder="turn:turn.example.com:3478"
          spellCheck={false}
        />
      </label>
      <label className="signal-url">
        Username
        <input
          value={turnConfig.username}
          onChange={(e) => onTurnConfigChange({ ...turnConfig, username: e.target.value })}
          spellCheck={false}
        />
      </label>
      <label className="signal-url">
        Credential
        <input
          type="password"
          value={turnConfig.credential}
          onChange={(e) => onTurnConfigChange({ ...turnConfig, credential: e.target.value })}
          spellCheck={false}
        />
      </label>

      {onOpenSimulator && (
        <button className="wnav-action settings-simulator" onClick={onOpenSimulator}>
          Open the Depot simulator
        </button>
      )}
    </div>
  )
}
