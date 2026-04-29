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
        <label htmlFor="global-search-input" className="sr-only">Global search</label>
        <input id="global-search-input" data-testid="global-search-input" aria-label="Search governorate, delegation, site, or cell" value={query} onChange={(e) => onQueryChange(e.target.value)} placeholder="Search governorate, delegation, site, cell..." />
        {searchResults.length ? (
          <div className="search-popover" role="listbox" aria-label="Search results">
            {searchResults.map((item) => <button role="option" aria-selected="false" key={`${item.type}:${item.id}`} onClick={() => onSearchSelect(item)}><strong>{item.type}</strong><span>{item.label}</span></button>)}
          </div>
        ) : null}
      </div>
      <div className="sr-only" aria-live="polite">{query ? `${searchResults.length} search results` : ''}</div>
      <div className="header-actions">
        <select value={metricMode} onChange={(e) => onMetricModeChange(e.target.value)} aria-label="Map metric">
          {metricModes.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        <button data-testid="toggle-dark-mode" className="ghost-button" aria-pressed={theme === 'dark'} onClick={onToggleTheme}>{theme === 'dark' ? 'Light Mode' : 'Dark Mode'}</button><button data-testid="toggle-focus-mode" className="ghost-button" aria-pressed={focusMode} onClick={onToggleFocus}>{focusMode ? 'Exit Focus' : 'Focus Mode'}</button>
      </div>
    </header>
  )
}
