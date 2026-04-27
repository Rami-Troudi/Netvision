import { COCKPIT_TABS } from '../../admin/adminOps'

export default function CockpitRail({ activeTab, onTabChange, alertCount = 0 }) {
  return (
    <nav className="cockpit-rail" aria-label="Cockpit sections">
      {COCKPIT_TABS.map((tab) => (
        <button key={tab.id} className={activeTab === tab.id ? 'active' : ''} onClick={() => onTabChange(tab.id)} title={tab.label}>
          <span>{tab.short}</span>
          <em>{tab.label}</em>
          {tab.id === 'triage' && alertCount ? <b>{alertCount}</b> : null}
        </button>
      ))}
    </nav>
  )
}
