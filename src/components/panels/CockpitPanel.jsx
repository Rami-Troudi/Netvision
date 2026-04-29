import NationalPanel from './NationalPanel'
import GovernoratePanel from './GovernoratePanel'
import DelegationPanel from './DelegationPanel'
import KpiCard from '../dashboard/KpiCard'
import StatusBadge from '../dashboard/StatusBadge'
import { diagnoseCell, formatMetric, classifyRanIssue, computeRecurrenceMetrics } from '../../admin/adminAggregation'
import { stateLabel, getCellState } from '../../admin/adminOps'

export default function CockpitPanel(props) {
  const { activeTab } = props
  if (activeTab === 'peak-hours') return <PeakHoursPanel {...props} />
  if (activeTab === 'qos') return <QosPanel {...props} />
  if (activeTab === 'data') return <DataPanel {...props} />
  if (activeTab === 'system') return <SystemPanel {...props} />
  return <OverviewPanel {...props} />
}

function OverviewPanel(props) {
  const { scope, nationalSummary, governorateRows, delegationRows, metric, selectedGovernorate, selectedDelegation, delegationSummary, governorateSummary, onSelectGovernorate, onSelectDelegation, reconciliation } = props
  const summary = scope.level === 'delegation' || scope.level === 'cell' ? delegationSummary : scope.level === 'governorate' ? governorateSummary : nationalSummary
  return <section className="panel-shell cockpit-panel"><div className="panel-heading"><div><p>Overview</p><h1>{scope.level === 'national' ? 'Tunisia Network Overview' : scope.delegationName || scope.governorateName}</h1></div><StatusBadge status={summary.status} /></div>{scope.level === 'national' ? <NationalPanel compact summary={nationalSummary} governorates={governorateRows} metric={metric} onSelectGovernorate={onSelectGovernorate} reconciliation={reconciliation} /> : null}{scope.level === 'governorate' ? <GovernoratePanel governorate={selectedGovernorate} summary={governorateSummary} delegations={delegationRows} metric={metric} currentTime={props.currentTime} onSelectDelegation={onSelectDelegation} /> : null}{(scope.level === 'delegation' || scope.level === 'cell') ? <DelegationPanel delegation={selectedDelegation} summary={delegationSummary} sites={props.siteRows} onSelectCell={props.onSelectCell} /> : null}</section>
}

function PeakHoursPanel({ scope, currentTime, summary, peakRows, onSelectCell }) {
  const showCellRows = scope.level === 'delegation' || scope.level === 'cell'
  const recurrence = computeRecurrenceMetrics(peakRows)
  
  return <section className="panel-shell cockpit-panel">
    <div className="panel-heading">
      <div>
        <p>Peak Hours</p>
        <h1>{scope.delegationName || scope.governorateName || 'Busy-hour view'}</h1>
      </div>
      <span className="time-chip">{currentTime?.timestamp || 'No time slice'}</span>
    </div>
    
    <div className="kpi-grid compact">
      <KpiCard label="Peak hour" value={peakRows[0]?.peak_hour || '—'} />
      <KpiCard label="Congested cells" value={summary.congested_cells} />
      <KpiCard label="Recurrence" value={`${(recurrence.recurrence_ratio * 100).toFixed(0)}%`} />
      <KpiCard label="Peak PRB" value={peakRows[0]?.avg_prb_at_peak ? `${peakRows[0].avg_prb_at_peak.toFixed(0)}%` : '—'} />
      <KpiCard label="Structural flag" value={recurrence.structural_flag ? 'Yes' : 'No'} />
    </div>

    {!showCellRows ? (
      <div className="empty-state" role="note">Peak-hour detail is scoped to delegation and cell review in this phase.</div>
    ) : (
      <div className="site-table-card">
        <div className="section-title">Peak-hour cells</div>
        {peakRows?.length ? (
          <table>
            <caption className="sr-only">Peak hours table</caption>
            <thead>
              <tr>
                <th scope="col">Cell</th>
                <th scope="col">Peak hour</th>
                <th scope="col">Peak PRB</th>
                <th scope="col">Recurrence</th>
                <th scope="col">Impact</th>
              </tr>
            </thead>
            <tbody>
              {peakRows.slice(0, 10).map((row) => {
                const issue = classifyRanIssue(row)
                return (
                  <tr key={row.cell_name} onClick={() => onSelectCell?.(row.cell_name)}>
                    <td>{row.cell_name}</td>
                    <td>{row.peak_hour || 'N/A'}</td>
                    <td>{formatMetric(row.avg_prb_at_peak)}%</td>
                    <td>{(row.recurrence_ratio * 100).toFixed(0)}%</td>
                    <td className={`severity-${issue.severity}`}>{issue.issue}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <div className="empty-state" role="note">Peak-hour data unavailable or empty for this scope.</div>
        )}
      </div>
    )}
  </section>
}

function QosPanel({ scope, summary, selectedCell, siteRows, filters, onFilterChange, bands, onSelectCell }) {
  if (scope.level === 'national') {
    return <section className="panel-shell cockpit-panel"><div className="panel-heading"><div><p>QoS Analysis</p><h1>National QoS summary</h1></div><StatusBadge status={summary.status} /></div><ScopeKpis summary={summary} /><div className="empty-state" role="note">Select a governorate, then a delegation, to inspect radio assets.</div></section>
  }
  if (scope.level === 'governorate') {
    return <section className="panel-shell cockpit-panel"><div className="panel-heading"><div><p>QoS Analysis</p><h1>{scope.governorateName}</h1></div><StatusBadge status={summary.status} /></div><ScopeKpis summary={summary} /><div className="empty-state" role="note">Sites and cells are intentionally hidden until a delegation is selected.</div></section>
  }
  if (selectedCell) {
    return <CellQosPanel cell={selectedCell} />
  }
  return <section className="panel-shell cockpit-panel"><div className="panel-heading"><div><p>QoS Analysis</p><h1>{scope.delegationName || 'Delegation'}</h1></div><StatusBadge status={summary.status} /></div><ScopeKpis summary={summary} /><FilterBox filters={filters} onFilterChange={onFilterChange} bands={bands} /><div className="site-table-card"><div className="section-title">Delegation sites <span>{siteRows.length}</span></div>{siteRows.length ? <table><caption className="sr-only">Delegation site health table</caption><thead><tr><th scope="col">State</th><th scope="col">Site</th><th scope="col">Worst cell</th><th scope="col">Cells</th><th scope="col">PRB</th><th scope="col">QoS</th></tr></thead><tbody>{siteRows.map((site) => <tr key={site.site_name} onClick={() => onSelectCell(site.worst_cell)}><td><span className="state-dot" style={{ background: site.state_color }} />{site.state_label}</td><td>{site.site_name}</td><td>{site.worst_cell}</td><td>{site.cells.length}</td><td>{formatMetric(site.avg_prb)}%</td><td>{formatMetric(site.avg_throughput)} Mbps / CQI {formatMetric(site.avg_cqi)}</td></tr>)}</tbody></table> : <div className="empty-state" role="note">No matched radio assets in this delegation.</div>}</div></section>
}

function ScopeKpis({ summary }) {
  return <div className="kpi-grid compact"><KpiCard label="Cells" value={summary.observed_cells} /><KpiCard label="Avg PRB" value={summary.avg_prb} unit="%" /><KpiCard label="Throughput" value={summary.avg_throughput} unit="Mbps" /><KpiCard label="CQI" value={summary.avg_cqi} /><KpiCard label="Users" value={summary.active_users} /><KpiCard label="Congestion" value={summary.congestion_rate} unit="%" /></div>
}

function CellQosPanel({ cell }) {
  const state = getCellState(cell)
  const issue = classifyRanIssue(cell)
  
  return <section className="panel-shell cockpit-panel">
    <div className="panel-heading">
      <div>
        <p>QoS Analysis</p>
        <h1>{cell.cell_name}</h1>
      </div>
      <StatusBadge status={state === 'critical' ? 'critical' : state === 'watch' ? 'watch' : 'stable'} />
    </div>
    
    <div className="kpi-grid compact">
      <KpiCard label="PRB load" value={cell.prb_load} unit="%" />
      <KpiCard label="Throughput" value={cell.throughput} unit="Mbps" />
      <KpiCard label="CQI" value={cell.cqi} />
      <KpiCard label="Active users" value={cell.active_users} />
      <KpiCard label="TA" value={cell.ta} />
      <KpiCard label="Health" value={cell.health} />
    </div>
    
    <div className="diagnosis-box">
      <strong>RAN Classification:</strong> {issue.issue} (Severity: {issue.severity}, Confidence: {(issue.confidence * 100).toFixed(0)}%)
      <div className="diagnosis-evidence">{issue.evidence.join(' • ')}</div>
      <strong>Multi-KPI Diagnosis:</strong> {diagnoseCell(cell)}
    </div>
    
    <div className="site-table-card">
      <div className="section-title">Cell context</div>
      <table>
        <caption className="sr-only">Selected cell details</caption>
        <tbody>
          <tr>
            <th scope="row">Site</th>
            <td>{cell.site_name || 'Unknown site'}</td>
          </tr>
          <tr>
            <th scope="row">Delegation</th>
            <td>{cell.admin?.deleg_name || 'Unmatched'}</td>
          </tr>
          <tr>
            <th scope="row">Governorate</th>
            <td>{cell.admin?.gov_name || 'Unmatched'}</td>
          </tr>
          <tr>
            <th scope="row">State</th>
            <td>{stateLabel(state)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
}

function DataPanel({ data, reconciliation, driftStatus, driftAlerts, driftUi, onExpandDrift, importState, exportRecommendationsState, onImportFile, onImportTypeChange, onRestoreRuntime, onExportJson, onExportReport, onExportRecommendationsCsv, dataMode, onDataModeChange }) {
  const warnings = reconciliation?.warnings || []
  const showDriftCollapsedNotice = driftStatus?.available === false && driftUi?.collapsed
  return <section className="panel-shell cockpit-panel" aria-busy={importState.status === 'parsing' || exportRecommendationsState?.status === 'downloading'}><div className="panel-heading"><div><p>Data Quality</p><h1>Runtime and admin data</h1></div></div><div className="kpi-grid"><KpiCard label="Runtime cells" value={Object.keys(data?.baseline || {}).length} /><KpiCard label="Admin matches" value={reconciliation?.cell_spatial_join?.matched_cells ?? 'N/A'} /><KpiCard label="COD delegations" value={reconciliation?.counts?.cod_delegations ?? 'N/A'} /><KpiCard label="Drift alerts" value={driftAlerts.length} /></div><div className="ingestion-card"><div className="section-title">Data ingestion</div><div className="ingestion-row"><label htmlFor="data-mode">Mode</label><select id="data-mode" value={dataMode || 'real'} onChange={(e) => onDataModeChange?.(e.target.value)}><option value="real">Real mode</option><option value="mock">Mock demo mode</option></select><label htmlFor="import-type" className="sr-only">Import type</label><select id="import-type" value={importState.importType} onChange={(e) => onImportTypeChange(e.target.value)}><option value="reference">Reference Data CSV</option><option value="kpi">KPI Hourly Data CSV</option></select><label className="file-pill">Choose CSV<input aria-label="Choose CSV file for import" type="file" accept=".csv,text/csv" onChange={(e) => onImportFile(e.target.files?.[0], importState.importType)} /></label><button data-testid="restore-runtime" className="ghost-button" onClick={onRestoreRuntime}>Restore runtime</button></div>{importState.status !== 'idle' ? <div className={`empty-state ${importState.status === 'error' ? 'warning' : ''}`} role="status">{importState.status === 'error' ? importState.error : `${importState.fileName} - ${importState.result?.imported_cells ?? importState.preview?.totalRows ?? 0} rows/cells processed`}</div> : <div className="empty-state" role="note">Import reference CSV first for geometry, then KPI CSV to update timeline/session data.</div>}{importState.result?.warnings?.map((w) => <div key={w} className="empty-state warning" role="note">{w}</div>)}</div>{showDriftCollapsedNotice ? <div className="empty-state warning" role="status">Drift artifacts are unavailable. <button className="ghost-button inline" aria-expanded="false" onClick={onExpandDrift}>Show details</button></div> : <div className="diagnosis-box"><strong>Drift:</strong> {driftStatus?.available === false ? driftStatus.reason : `${driftAlerts.length} alerts above threshold.`}</div>}{warnings.map((w) => <div key={w} className="empty-state warning" role="note">{w}</div>)}{exportRecommendationsState?.status === 'error' ? <div className="empty-state warning" role="status">{exportRecommendationsState.error}</div> : null}{exportRecommendationsState?.status === 'done' ? <div className="empty-state" role="status">Recommendations CSV downloaded{exportRecommendationsState.filename ? `: ${exportRecommendationsState.filename}` : ''}.</div> : null}<div className="export-actions"><button data-testid="export-json" className="primary-cta" onClick={onExportJson}>Export scoped JSON</button><button data-testid="export-report" className="ghost-button" onClick={onExportReport}>Download report</button><button data-testid="export-recommendations" className="ghost-button" disabled={exportRecommendationsState?.status === 'downloading'} onClick={onExportRecommendationsCsv}>{exportRecommendationsState?.status === 'downloading' ? 'Exporting recommendations...' : 'Export recommendations CSV'}</button></div></section>
}

function SystemPanel({ backendHealth, workerState, data, endpointCoverage }) {
  const byEndpoint = Object.fromEntries((endpointCoverage || []).map((item) => [item.endpoint, item]))
  const queueDetail = workerState === 'ready' ? 'ready' : 'Simulation queue unavailable - optional service outside current phase.'
  return <section className="panel-shell cockpit-panel"><div className="panel-heading"><div><p>System Status</p><h1>Services</h1></div></div><div className="section-title">Core</div><div className="system-grid"><Service name="Next data API" ok={Boolean(data) && byEndpoint['/api/data/*']?.reachable !== false} detail="runtime data loaded" /><Service name="Map engine" ok detail="MapLibre offline polygons" /><Service name="Admin geography" ok={Boolean(data?.governorates?.features?.length && data?.delegations?.features?.length)} detail="governorates and delegations loaded" /><Service name="Peak Hours API" ok={byEndpoint['/api/peak-hours']?.reachable !== false} detail={byEndpoint['/api/peak-hours']?.detail || 'ready'} /></div><div className="section-title system-optional-title">Optional / outside current phase</div><div className="system-grid"><Service name="FastAPI backend" ok={backendHealth?.available || backendHealth?.status === 'ok'} detail={backendHealth?.status || backendHealth?.detail || 'optional for this phase'} /><Service name="Redis / worker" ok={workerState === 'ready'} detail={queueDetail} /><Service name="Recommendation export" ok={byEndpoint['/api/recommendations-export']?.reachable !== false} detail="optional export service" /><Service name="Simulation queue" ok={workerState === 'ready'} detail={queueDetail} /></div></section>
}

function Service({ name, ok, detail }) { return <div className="service-card"><span className={ok ? 'ok' : 'bad'} /> <strong>{name}</strong><em>{detail}</em></div> }

function FilterBox({ filters, onFilterChange, bands }) {
  return <div className="filter-box"><div className="section-title">Filters</div><div className="filter-pills">{['critical', 'watch', 'degraded', 'healthy', 'no_data', 'unmatched'].map((key) => <label key={key}><input type="checkbox" checked={Boolean(filters[key])} onChange={(e) => onFilterChange({ [key]: e.target.checked })} />{stateLabel(key)}</label>)}</div><div className="filter-ranges"><label>PRB min <input type="range" min="0" max="100" value={filters.minPrb} onChange={(e) => onFilterChange({ minPrb: Number(e.target.value) })} /> {filters.minPrb}%</label><label>PRB max <input type="range" min="0" max="100" value={filters.maxPrb} onChange={(e) => onFilterChange({ maxPrb: Number(e.target.value) })} /> {filters.maxPrb}%</label></div><div className="filter-pills band-pills">{bands.map((band) => <label key={band}><input type="checkbox" checked={Boolean(filters.bands?.[band])} onChange={(e) => onFilterChange({ bands: { ...filters.bands, [band]: e.target.checked } })} />Band {band}</label>)}</div></div>
}
