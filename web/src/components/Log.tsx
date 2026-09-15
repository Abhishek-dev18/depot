export function Log({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null
  return (
    <div className="log">
      {lines.map((line, i) => (
        <div key={i}>{line}</div>
      ))}
    </div>
  )
}
