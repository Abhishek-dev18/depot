export function ProgressBar({ value, total, label }: { value: number; total: number; label?: string }) {
  const pct = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0
  return (
    <div className="progress">
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="progress-label">{label ?? `${value} / ${total} (${pct}%)`}</span>
    </div>
  )
}
