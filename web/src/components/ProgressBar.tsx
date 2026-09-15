function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function ProgressBar({
  value,
  total,
  bytesDone,
  bytesTotal,
}: {
  value: number
  total: number
  bytesDone?: number
  bytesTotal?: number
}) {
  const pct = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0
  return (
    <div className="progress">
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="progress-meta">
        <span>
          <b>{pct}%</b>
        </span>
        <span>
          <b>
            {value}/{total}
          </b>{' '}
          chunks
        </span>
        {bytesDone !== undefined && bytesTotal !== undefined && (
          <span>
            <b>{formatBytes(bytesDone)}</b> / {formatBytes(bytesTotal)}
          </span>
        )}
      </div>
    </div>
  )
}
