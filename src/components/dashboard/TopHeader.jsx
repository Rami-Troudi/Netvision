export default function TopHeader({
  metricMode,
  metricModes,
  onMetricModeChange,
  query,
  onQueryChange,
  searchResults,
  onSearchSelect,
  dataMode,
  onSecondaryPanel,
  adminToolsEnabled = false,
  theme = 'light',
  onToggleTheme,
  focusMode = false,
  onToggleFocus,
  onRunDemo,
  role = 'operator',
  onRoleChange,
  showRoleSwitch = false,
}) {
  return (
    <header className="top-header">
      <div className="brand-lockup">
        <div className="brand-mark">NV</div>
        <div>
          <div className="brand-title">NetVision Supervision RAN</div>
          <div className="brand-subtitle">Centre régional RAN Tunisie</div>
        </div>
      </div>
      <div className="global-search">
        <label htmlFor="global-search-input" className="sr-only">Recherche globale</label>
        <input id="global-search-input" data-testid="global-search-input" aria-label="Recherche gouvernorat, délégation, site, cellule" value={query} onChange={(e) => onQueryChange(e.target.value)} placeholder="Rechercher gouvernorat, délégation, site, cellule..." />
        {searchResults.length ? (
          <div className="search-popover" role="listbox" aria-label="Résultats recherche">
            {searchResults.map((item) => <button role="option" aria-selected="false" key={`${item.type}:${item.id}`} onClick={() => onSearchSelect(item)}><strong>{item.type}</strong><span>{item.label}</span></button>)}
          </div>
        ) : null}
      </div>
      {dataMode === 'mock' ? <div className="mock-mode-badge"><strong>Jeu de démonstration</strong><span>{adminToolsEnabled ? 'runtime_data_mock' : 'Données non réelles'}</span></div> : null}
      <div className="sr-only" aria-live="polite">{query ? `${searchResults.length} résultats de recherche` : ''}</div>
      <div className="header-actions">
        <select value={metricMode} onChange={(e) => onMetricModeChange(e.target.value)} aria-label="Métrique carte">
          {metricModes.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        {adminToolsEnabled ? <button className="ghost-button" onClick={onToggleTheme}>{theme === 'dark' ? 'Mode clair' : 'Mode sombre'}</button> : null}
        {adminToolsEnabled ? <button className="ghost-button" onClick={onToggleFocus}>{focusMode ? 'Sortir focus' : 'Mode focus'}</button> : null}
        {adminToolsEnabled ? <button className="ghost-button" onClick={onRunDemo}>Démo guidée</button> : null}
        {adminToolsEnabled ? <button data-testid="open-data-quality" className="ghost-button" onClick={() => onSecondaryPanel?.('data')}>Données</button> : null}
        {adminToolsEnabled ? <button data-testid="open-system-status" className="ghost-button" onClick={() => onSecondaryPanel?.('system')}>Admin</button> : null}
        {showRoleSwitch ? (
          <label className="role-switch">
            <span>Mode</span>
            <select value={role} onChange={(event) => onRoleChange?.(event.target.value)} aria-label="Mode interface">
              <option value="operator">Opérateur</option>
              <option value="admin">Admin</option>
            </select>
          </label>
        ) : null}
      </div>
    </header>
  )
}
