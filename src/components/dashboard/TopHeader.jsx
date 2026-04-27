export default function TopHeader({ metricMode, metricModes, onMetricModeChange, focusMode, onToggleFocus, theme, onToggleTheme, query, onQueryChange, searchResults, onSearchSelect }) {
  return (
    <header className="top-header">
      <div className="brand-lockup">
        <div className="brand-mark">NV</div>
        <div>
          <div className="brand-title">NetVision Digital Twin</div>
          <div className="brand-subtitle">Tunisia Regional RAN Command Center</div>
        </div>
      </div>
      <div className="global-search">
        <input value={query} onChange={(e) => onQueryChange(e.target.value)} placeholder="Search governorate, delegation, site, cell..." />
        {searchResults.length ? (
          <div className="search-popover">
            {searchResults.map((item) => <button key={`${item.type}:${item.id}`} onClick={() => onSearchSelect(item)}><strong>{item.type}</strong><span>{item.label}</span></button>)}
          </div>
        ) : null}
      </div>
      <div className="header-actions">
        <select value={metricMode} onChange={(e) => onMetricModeChange(e.target.value)} aria-label="Map metric">
          {metricModes.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        <button className="ghost-button" onClick={onToggleTheme}>{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</button><button className="ghost-button" onClick={onToggleFocus}>{focusMode ? 'Exit Focus' : 'Focus Mode'}</button>
      </div>
    </header>
  )
}
