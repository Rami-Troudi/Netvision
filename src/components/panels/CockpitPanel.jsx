import NationalPanel from './NationalPanel'
import GovernoratePanel from './GovernoratePanel'
import DelegationPanel from './DelegationPanel'
import CellOperationalPanel from './CellOperationalPanel'
import KpiCard from '../dashboard/KpiCard'
import StatusBadge from '../dashboard/StatusBadge'
import { formatMetric } from '../../admin/adminAggregation'
import { stateLabel, getCellState, buildActionNarrative } from '../../admin/adminOps'

export default function CockpitPanel(props) {
  const { activeTab } = props
  if (activeTab === 'triage') return <TriagePanel {...props} />
  if (activeTab === 'operations') return <OperationsPanel {...props} />
  if (activeTab === 'actions') return <ActionsPanel {...props} />
  if (activeTab === 'data') return <DataPanel {...props} />
  if (activeTab === 'system') return <SystemPanel {...props} />
  return <TriagePanel {...props} />
}

function TriagePanel(props) {
  const { scope, nationalSummary, governorateRows, delegationRows, metric, selectedGovernorate, selectedDelegation, delegationSummary, governorateSummary, alerts, onSelectGovernorate, onSelectDelegation, onSelectCell, reconciliation } = props
  const summary = scope.level === 'delegation' || scope.level === 'cell' ? delegationSummary : scope.level === 'governorate' ? governorateSummary : nationalSummary
  return (
    <section className="panel-shell cockpit-panel">
      <div className="panel-heading"><div><p>Triage cockpit</p><h1>{scope.level === 'national' ? 'What needs attention?' : scope.delegationName || scope.governorateName}</h1></div><StatusBadge status={summary.status} /></div>
      <div className="next-action-card"><strong>Next best action</strong><p>{buildActionNarrative(scope, summary, alerts)}</p>{alerts[0] ? <button className="primary-cta" onClick={() => onSelectCell(alerts[0].cell_name)}>Inspect {alerts[0].cell_name}</button> : null}</div>
      {scope.level === 'national' ? <NationalPanel compact summary={nationalSummary} governorates={governorateRows} metric={metric} onSelectGovernorate={onSelectGovernorate} reconciliation={reconciliation} /> : null}
      {scope.level === 'governorate' ? <GovernoratePanel governorate={selectedGovernorate} summary={governorateSummary} delegations={delegationRows} metric={metric} currentTime={props.currentTime} onSelectDelegation={onSelectDelegation} /> : null}
      {(scope.level === 'delegation' || scope.level === 'cell') ? <DelegationPanel delegation={selectedDelegation} summary={delegationSummary} sites={props.siteRows} onSelectCell={(cellName) => onSelectCell(cellName)} /> : null}
    </section>
  )
}

function OperationsPanel({ scope, summary, siteRows, scopedCells, filters, onFilterChange, bands, onSelectCell, peakRows }) {
  return (
    <section className="panel-shell cockpit-panel">
      <div className="panel-heading"><div><p>Operations</p><h1>{scope.delegationName || scope.governorateName || 'National operations'}</h1></div><span className="live-pill">QoS + QoL</span></div>
      <div className="kpi-grid compact"><KpiCard label="Cells" value={summary.observed_cells} /><KpiCard label="Sites" value={siteRows.length} /><KpiCard label="Avg PRB" value={summary.avg_prb} unit="%" /><KpiCard label="Throughput" value={summary.avg_throughput} unit="Mbps" /><KpiCard label="CQI" value={summary.avg_cqi} /><KpiCard label="Users" value={summary.active_users} /></div>
      <FilterBox filters={filters} onFilterChange={onFilterChange} bands={bands} />
      <div className="site-table-card"><div className="section-title">Scoped Sites <span>{siteRows.length}</span></div>{siteRows.length ? <table><thead><tr><th>State</th><th>Site</th><th>Worst cell</th><th>Cells</th><th>PRB</th><th>QoS</th></tr></thead><tbody>{siteRows.map((site) => <tr key={site.site_name} onClick={() => onSelectCell(site.worst_cell)}><td><span className="state-dot" style={{ background: site.state_color }} />{site.state_label}</td><td>{site.site_name}</td><td>{site.worst_cell}</td><td>{site.cells.length}</td><td>{formatMetric(site.avg_prb)}%</td><td>{formatMetric(site.avg_throughput)} Mbps / CQI {formatMetric(site.avg_cqi)}</td></tr>)}</tbody></table> : <div className="empty-state">No sites match the current filters.</div>}</div>
      <div className="site-table-card"><div className="section-title">Peak Hours</div>{peakRows?.length ? <table><tbody>{peakRows.slice(0, 6).map((row) => <tr key={row.cell_name}><td>{row.cell_name}</td><td>{row.peak_hour || 'N/A'}</td><td>{formatMetric(row.peak_avg_prb)}%</td></tr>)}</tbody></table> : <div className="empty-state">Peak-hour data unavailable or empty for this scope.</div>}</div>
    </section>
  )
}

function ActionsPanel({ selectedCell, currentTime, scope, alerts, onSelectCell }) {
  if (selectedCell) return <CellOperationalPanel cell={selectedCell} currentTime={currentTime} />
  return <section className="panel-shell cockpit-panel"><div className="panel-heading"><div><p>Actions</p><h1>Select a cell to act</h1></div></div><div className="empty-state">Recommendations and simulations are enabled only at cell scope.</div>{alerts.slice(0, 8).map((cell) => <button key={cell.cell_name} className="action-row" onClick={() => onSelectCell(cell.cell_name)}><span className="state-dot" />{cell.cell_name}<em>{stateLabel(getCellState(cell))}</em></button>)}</section>
}

function DataPanel({ data, reconciliation, driftStatus, driftAlerts, importState, onImportFile, onImportTypeChange, onRestoreRuntime, onExportJson, onExportReport }) {
  const warnings = reconciliation?.warnings || []
  return <section className="panel-shell cockpit-panel"><div className="panel-heading"><div><p>Data</p><h1>Runtime, ingestion and admin data</h1></div></div><div className="kpi-grid"><KpiCard label="Runtime cells" value={Object.keys(data?.baseline || {}).length} /><KpiCard label="Admin matches" value={reconciliation?.cell_spatial_join?.matched_cells ?? '—'} /><KpiCard label="COD delegations" value={reconciliation?.counts?.cod_delegations ?? '—'} /><KpiCard label="Drift alerts" value={driftAlerts.length} /></div><div className="ingestion-card"><div className="section-title">Data ingestion</div><div className="ingestion-row"><select value={importState.importType} onChange={(e) => onImportTypeChange(e.target.value)}><option value="reference">Reference Data CSV</option><option value="kpi">KPI Hourly Data CSV</option></select><label className="file-pill">Choose CSV<input type="file" accept=".csv,text/csv" onChange={(e) => onImportFile(e.target.files?.[0], importState.importType)} /></label><button className="ghost-button" onClick={onRestoreRuntime}>Restore runtime</button></div>{importState.status !== 'idle' ? <div className={`empty-state ${importState.status === 'error' ? 'warning' : ''}`}>{importState.status === 'error' ? importState.error : `${importState.fileName} · ${importState.result?.imported_cells ?? importState.preview?.totalRows ?? 0} rows/cells processed`}</div> : <div className="empty-state">Import reference CSV first for geometry, then KPI CSV to update timeline/session data. Auto-mapping uses the original browser worker.</div>}{importState.result?.warnings?.map((w) => <div key={w} className="empty-state warning">{w}</div>)}</div><div className="diagnosis-box"><strong>Drift:</strong> {driftStatus?.available === false ? driftStatus.reason : `${driftAlerts.length} alerts above threshold.`}</div>{warnings.map((w) => <div key={w} className="empty-state warning">{w}</div>)}<div className="export-actions"><button className="primary-cta" onClick={onExportJson}>Export scoped JSON</button><button className="ghost-button" onClick={onExportReport}>Download report</button></div></section>
}

function SystemPanel({ backendHealth, workerState, data }) {
  return <section className="panel-shell cockpit-panel"><div className="panel-heading"><div><p>System</p><h1>Service health</h1></div></div><div className="system-grid"><Service name="Next data API" ok={Boolean(data)} detail="runtime data loaded" /><Service name="FastAPI backend" ok={backendHealth?.available || backendHealth?.status === 'ok'} detail={backendHealth?.status || backendHealth?.detail || 'not checked'} /><Service name="Redis / worker" ok={workerState === 'ready'} detail={workerState} /><Service name="Map engine" ok detail="MapLibre offline polygons" /></div></section>
}

function Service({ name, ok, detail }) { return <div className="service-card"><span className={ok ? 'ok' : 'bad'} /> <strong>{name}</strong><em>{detail}</em></div> }

function FilterBox({ filters, onFilterChange, bands }) {
  return <div className="filter-box"><div className="section-title">Filters</div><div className="filter-pills">{['critical','watch','degraded','healthy','no_data','unmatched'].map((key) => <label key={key}><input type="checkbox" checked={Boolean(filters[key])} onChange={(e) => onFilterChange({ [key]: e.target.checked })} />{stateLabel(key)}</label>)}</div><div className="filter-ranges"><label>PRB min <input type="range" min="0" max="100" value={filters.minPrb} onChange={(e) => onFilterChange({ minPrb: Number(e.target.value) })} /> {filters.minPrb}%</label><label>PRB max <input type="range" min="0" max="100" value={filters.maxPrb} onChange={(e) => onFilterChange({ maxPrb: Number(e.target.value) })} /> {filters.maxPrb}%</label></div><div className="filter-pills band-pills">{bands.map((band) => <label key={band}><input type="checkbox" checked={Boolean(filters.bands?.[band])} onChange={(e) => onFilterChange({ bands: { ...filters.bands, [band]: e.target.checked } })} />Band {band}</label>)}</div></div>
}
