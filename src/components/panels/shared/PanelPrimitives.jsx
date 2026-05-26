export function PanelHeader({ eyebrow, title, subtitle, status, actions = null }) {
  return (
    <div className="workflow-hero panel-header-plus">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {subtitle ? <span className="hero-subtitle">{subtitle}</span> : null}
      </div>
      <div className="hero-actions">
        {status ? <span className={`status-pill ${status.tone || ''}`}>{status.label}</span> : null}
        {actions}
      </div>
    </div>
  )
}

export function SectionCard({ title, kicker, children, className = '' }) {
  return (
    <section className={`section-card ${className}`.trim()}>
      {title ? <div className="section-title">{title}{kicker ? <span>{kicker}</span> : null}</div> : null}
      {children}
    </section>
  )
}

export function EmptyState({ title, children, action = null, tone = '' }) {
  return (
    <div className={`empty-state state-card ${tone}`.trim()} role="note">
      {title ? <strong>{title}</strong> : null}
      {children ? <span>{children}</span> : null}
      {action}
    </div>
  )
}

export function EvidenceList({ items = [] }) {
  if (!items.length) return null
  return <ul className="evidence-list">{items.map((item) => <li key={item}>{item}</li>)}</ul>
}

export function ActionBar({ title, description, children }) {
  return (
    <div className="primary-action-bar">
      <div>
        <strong>{title}</strong>
        <span>{description}</span>
      </div>
      {children}
    </div>
  )
}
