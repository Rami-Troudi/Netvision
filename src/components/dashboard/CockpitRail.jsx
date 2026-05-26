export default function CockpitRail({ activeTab, onTabChange, alertCount = 0, tabs = [] }) {
  return (
    <nav className="cockpit-rail" aria-label="Cockpit sections">
      {tabs.map((tab) => (
        <button data-testid={`cockpit-tab-${tab.id}`} aria-label={tab.label} aria-pressed={activeTab === tab.id} key={tab.id} className={activeTab === tab.id ? 'active' : ''} onClick={() => onTabChange(tab.id)} title={tab.label}>
          <span>{tab.short}</span>
          <em>{tab.label}</em>
          {tab.id === 'priorities' && alertCount ? <b aria-label={`${alertCount} priorités`}>{alertCount}</b> : null}
        </button>
      ))}
    </nav>
  )
}
