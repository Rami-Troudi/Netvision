export default function TopHeader({ metricMode, metricModes, onMetricModeChange, query, onQueryChange, searchResults, onSearchSelect, dataMode, onSecondaryPanel, adminToolsEnabled = false }) {
  return (
    <header className="top-header">
      <div className="brand-lockup">
        <div className="brand-mark">NV</div>
        <div>
          <div className="brand-title">NetVision Jumeau Numerique</div>
          <div className="brand-subtitle">Centre regional RAN Tunisie</div>
        </div>
      </div>
      <div className="global-search">
        <label htmlFor="global-search-input" className="sr-only">Recherche globale</label>
        <input id="global-search-input" data-testid="global-search-input" aria-label="Recherche gouvernorat, delegation, site, cellule" value={query} onChange={(e) => onQueryChange(e.target.value)} placeholder="Rechercher gouvernorat, delegation, site, cellule..." />
        {searchResults.length ? (
          <div className="search-popover" role="listbox" aria-label="Resultats recherche">
            {searchResults.map((item) => <button role="option" aria-selected="false" key={`${item.type}:${item.id}`} onClick={() => onSearchSelect(item)}><strong>{item.type}</strong><span>{item.label}</span></button>)}
          </div>
        ) : null}
      </div>
      {dataMode === 'mock' && adminToolsEnabled ? <div className="mock-mode-badge"><strong>JEU DEMO</strong><span>Validation interne</span></div> : null}
      <div className="sr-only" aria-live="polite">{query ? `${searchResults.length} resultats de recherche` : ''}</div>
      <div className="header-actions">
        <select value={metricMode} onChange={(e) => onMetricModeChange(e.target.value)} aria-label="Metrique carte">
          {metricModes.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        {adminToolsEnabled ? <button data-testid="open-data-quality" className="ghost-button" onClick={() => onSecondaryPanel?.('data')}>Donnees</button> : null}
        {adminToolsEnabled ? <button data-testid="open-system-status" className="ghost-button" onClick={() => onSecondaryPanel?.('system')}>Admin</button> : null}
      </div>
    </header>
  )
}
