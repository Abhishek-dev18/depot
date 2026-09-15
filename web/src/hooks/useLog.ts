import { useCallback, useState } from 'react'

export function useLog() {
  const [lines, setLines] = useState<string[]>([])
  const push = useCallback((line: string) => {
    const stamp = new Date().toLocaleTimeString()
    setLines((prev) => [...prev, `${stamp}  ${line}`])
  }, [])
  const clear = useCallback(() => setLines([]), [])
  return { lines, push, clear }
}
