import type { ReactNode } from 'react'

export function Card({
  title,
  subtitle,
  icon,
  right,
  children,
}: {
  title: string
  subtitle?: string
  icon?: ReactNode
  right?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="card">
      <div className="card-header">
        <div className="card-heading">
          {icon && <span className="card-icon">{icon}</span>}
          <div>
            <h3>{title}</h3>
            {subtitle && <p className="hint">{subtitle}</p>}
          </div>
        </div>
        {right}
      </div>
      <div className="card-body">{children}</div>
    </section>
  )
}
