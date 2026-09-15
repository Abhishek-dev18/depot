import { useState } from 'react'
import { CheckIcon, CopyIcon } from './icons'

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard API unavailable (e.g. insecure context) — nothing more we can do here
    }
  }

  return (
    <button type="button" className="copy-button" onClick={() => void copy()}>
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}
