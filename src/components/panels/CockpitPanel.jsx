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

const BUSY_METRICS = [
  { id: 'congestion_rate', label: 'Congestion Pressure' },
  { id: 'prb', label: 'PRB' },
  { id: 'active_users', label: 'Active Users' },
  { id: 'throughput_drop', label: 'Throughput Drop' },
  { id: 'cqi_drop', label: 'CQI Drop' },
]

function PeakHoursPanel({ scope, currentTime, summary, peakRows, peakPayload, busyMetric, onBusyMetricChange, onPeakRowSelect }) {
  const recurrence = computeRecurrenceMetrics(peakRows)
  const peakSummary = peakPayload?.summary || {}
  return <section className="panel-shell cockpit-panel">
    <div className="panel-heading">
      <div>
        <p>Peak Hours</p>
        <h1>{scope.delegationName || scope.governorateName || 'When does it happen?'}</h1>
      </div>
      <span className="time-chip">{currentTime?.timestamp || 'No time slice'}</span>
    </div>
    <div className="metric-selector"><label htmlFor="busy-metric">Busy metric</label><select id="busy-metric" value={busyMetric} onChange={(event) => onBusyMetricChange(event.target.value)}>{BUSY_METRICS.map((metric) => <option key={metric.id} value={metric.id}>{metric.label}</option>)}</select></div>
    
    <div className="kpi-grid compact">
      <KpiCard label="Peak hour" value={peakSummary.peak_hour || 'N/A'} />
      <KpiCard label="Peak window" value={peakSummary.peak_window || 'N/A'} />
      <KpiCard label="Peak PRB" value={peakSummary.avg_prb_at_peak ? `${peakSummary.avg_prb_at_peak.toFixed(0)}%` : 'N/A'} />
      <KpiCard label="Peak congestion" value={peakSummary.peak_congestion_rate || 0} unit="%" />
      <KpiCard label="Peak users" value={peakSummary.active_users_at_peak || 0} />
      <KpiCard label="Affected cells" value={peakSummary.affected_cells_at_peak || summary.congested_cells} />
      <KpiCard label="Recurrence" value={`${(recurrence.recurrence_ratio * 100).toFixed(0)}%`} />
      <KpiCard label="Structural flag" value={recurrence.structural_flag ? 'Yes' : 'No'} />
    </div>

    {peakPayload?.available === false ? <div className="empty-state" role="note">{peakPayload.reason || 'No busy-hour samples for this scope.'}</div> : null}
    {peakRows?.length ? <BusyHourHeatmap rows={peakRows} /> : null}
    {peakRows?.length ? (
      <div className="site-table-card">
        <div className="section-title">Peak offenders</div>
        <table>
          <caption className="sr-only">Peak offenders table</caption>
          <thead><tr><th scope="col">Scope</th><th scope="col">Peak Hour</th><th scope="col">Peak Window</th><th scope="col">Peak PRB</th><th scope="col">Peak Throughput</th><th scope="col">Peak CQI</th><th scope="col">Active Users</th><th scope="col">Affected Cells</th><th scope="col">Recurrence</th><th scope="col">QoS Impact</th></tr></thead>
          <tbody>{peakRows.slice(0, 12).map((row) => {
            const issue = classifyRanIssue({ ...row, avg_prb: row.avg_prb_at_peak, avg_throughput: row.avg_throughput_at_peak, avg_cqi: row.avg_cqi_at_peak })
            return <tr key={`${row.group_by}:${row.id}`} onClick={() => onPeakRowSelect?.(row)}><td>{row.name}</td><td>{row.peak_hour || 'N/A'}</td><td>{row.peak_window || 'N/A'}</td><td>{formatMetric(row.avg_prb_at_peak)}%</td><td>{formatMetric(row.avg_throughput_at_peak)} Mbps</td><td>{formatMetric(row.avg_cqi_at_peak)}</td><td>{formatMetric(row.active_users_at_peak, 0)}</td><td>{row.affected_cells_at_peak || 0}</td><td>{formatMetric((row.recurrence_ratio || 0) * 100, 0)}%</td><td className={`severity-${issue.severity}`}>{issue.issue}</td></tr>
          })}</tbody>
        </table>
      </div>
    ) : null}
  </section>
}

function BusyHourHeatmap({ rows }) {
  const max = Math.max(1, ...rows.flatMap((row) => (row.hourly_profile || []).map((bucket) => Number(bucket.metric_value) || 0)))
  return <div className="heatmap-card"><div className="section-title">24h pressure profile</div><div className="heatmap-grid"><div className="heatmap-hours">{Array.from({ length: 24 }, (_, hour) => <span key={hour}>{String(hour).padStart(2, '0')}</span>)}</div>{rows.slice(0, 10).map((row) => <div key={`${row.group_by}:${row.id}`} className="heatmap-row"><strong title={row.name}>{row.name}</strong><div>{(row.hourly_profile || []).map((bucket) => <span key={bucket.hour} title={`${row.name} ${bucket.label}: ${formatMetric(bucket.metric_value)}`} style={{ opacity: 0.18 + Math.min(0.82, (Number(bucket.metric_value) || 0) / max) }} />)}</div></div>)}</div></div>
}

function QosPanel({ scope, summary, selectedCell, siteRows, scopedCells, filters, onFilterChange, bands, onSelectCell, peakRows }) {
  const issue = classifyRanIssue({ ...summary, recurrence_ratio: computeRecurrenceMetrics(peakRows).recurrence_ratio })
  const compliance = computeCompliance(scopedCells)
  if (scope.level === 'national') {
    return <ScopeQosPanel title="National QoS summary" summary={summary} issue={issue} compliance={compliance} note="Select a governorate, then a delegation, to inspect radio assets." />
  }
  if (scope.level === 'governorate') {
    return <ScopeQosPanel title={scope.governorateName} summary={summary} issue={issue} compliance={compliance} note="Sites and cells are intentionally hidden until a delegation is selected." />
  }
  if (selectedCell) {
    return <CellQosPanel cell={selectedCell} />
  }
  return <section className="panel-shell cockpit-panel"><div className="panel-heading"><div><p>QoS Analysis</p><h1>{scope.delegationName || 'Delegation'}</h1></div><StatusBadge status={summary.status} /></div><ScopeKpis summary={summary} /><RanIssueBox issue={issue} /><ComplianceCards compliance={compliance} /><FilterBox filters={filters} onFilterChange={onFilterChange} bands={bands} /><div className="site-table-card"><div className="section-title">Delegation sites <span>{siteRows.length}</span></div>{siteRows.length ? <table><caption className="sr-only">Delegation site health table</caption><thead><tr><th scope="col">State</th><th scope="col">Site</th><th scope="col">Worst cell</th><th scope="col">Cells</th><th scope="col">PRB</th><th scope="col">QoS</th></tr></thead><tbody>{siteRows.map((site) => <tr key={site.site_name} onClick={() => onSelectCell(site.worst_cell)}><td><span className="state-dot" style={{ background: site.state_color }} />{site.state_label}</td><td>{site.site_name}</td><td>{site.worst_cell}</td><td>{site.cells.length}</td><td>{formatMetric(site.avg_prb)}%</td><td>{formatMetric(site.avg_throughput)} Mbps / CQI {formatMetric(site.avg_cqi)}</td></tr>)}</tbody></table> : <div className="empty-state" role="note">No matched radio assets in this delegation.</div>}</div></section>
}

function ScopeQosPanel({ title, summary, issue, compliance, note }) {
  return <section className="panel-shell cockpit-panel"><div className="panel-heading"><div><p>QoS Analysis</p><h1>{title}</h1></div><StatusBadge status={summary.status} /></div><ScopeKpis summary={summary} /><RanIssueBox issue={issue} /><ComplianceCards compliance={compliance} /><div className="comparison-card"><div className="section-title">Peak vs normal</div><span>Peak load is represented by current busy-hour recurrence and congestion pressure. Normal baseline uses the active time slice until more history is available.</span></div><div className="empty-state" role="note">{note}</div></section>
}

function RanIssueBox({ issue }) {
  return <div className="diagnosis-box"><strong>Likely RAN cause:</strong> {issue.issue} <span className={`severity-${issue.severity}`}>({issue.severity}, {formatMetric(issue.confidence * 100, 0)}% confidence)</span><div className="diagnosis-evidence">{issue.evidence?.length ? issue.evidence.join(' - ') : 'Evidence is limited for this scope.'}</div></div>
}

function ComplianceCards({ compliance }) {
  return <div className="kpi-grid compact"><KpiCard label="Below throughput target" value={compliance.lowThroughputPct} unit="%" /><KpiCard label="Above PRB target" value={compliance.highPrbPct} unit="%" /><KpiCard label="Below CQI target" value={compliance.lowCqiPct} unit="%" /><KpiCard label="Recurrently congested" value={compliance.recurrentPct} unit="%" /><KpiCard label="Affected delegations" value={compliance.affectedDelegationPct} unit="%" /><KpiCard label="QoS score" value={compliance.qosScore} /></div>
}

function computeCompliance(cells = []) {
  const total = Math.max(1, cells.length)
  const delegations = new Set(cells.map((cell) => cell.admin?.deleg_id).filter(Boolean))
  const affectedDelegations = new Set(cells.filter((cell) => cell.prb_load >= 85 || cell.throughput < 15 || cell.cqi < 8).map((cell) => cell.admin?.deleg_id).filter(Boolean))
  const lowThroughputPct = cells.filter((cell) => cell.throughput > 0 && cell.throughput < 15).length / total * 100
  const highPrbPct = cells.filter((cell) => cell.prb_load >= 85).length / total * 100
  const lowCqiPct = cells.filter((cell) => cell.cqi > 0 && cell.cqi < 8).length / total * 100
  const affectedDelegationPct = delegations.size ? affectedDelegations.size / delegations.size * 100 : 0
  const qosScore = Math.max(0, 100 - (lowThroughputPct * 0.35 + highPrbPct * 0.35 + lowCqiPct * 0.3))
  return { lowThroughputPct, highPrbPct, lowCqiPct, recurrentPct: highPrbPct, affectedDelegationPct, qosScore }
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
      <div className="diagnosis-evidence">{issue.evidence.join(' - ')}</div>
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
