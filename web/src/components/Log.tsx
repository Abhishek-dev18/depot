import { useEffect, useRef } from 'react'

export function Log({ lines }: { lines: string[] }) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  if (lines.length === 0) return null

  return (
    <div className="log-wrap">
      <div className="log-title">Activity</div>
      <div className="log" ref={scrollRef}>
        {lines.map((line, i) => (
          <div className={`log-line${line.includes('error:') ? ' log-error' : ''}`} key={i}>
            {line}
          </div>
        ))}
      </div>
    </div>
  )
}
