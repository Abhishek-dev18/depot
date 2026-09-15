/**
 * The SAS as the hero of the screen, not a buried alert — see the
 * "Depot — Interface Design" artifact's design notes. Each digit gets its
 * own box in the accent color; this is the one step that catches a
 * Signal-in-the-middle (protocol.md §3.4), so it gets the visual weight.
 */
export function SasDisplay({ code }: { code: string }) {
  return (
    <div className="sas-digits">
      {code.split('').map((digit, i) => (
        <b key={i}>{digit}</b>
      ))}
    </div>
  )
}
