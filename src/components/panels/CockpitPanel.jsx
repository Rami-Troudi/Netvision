import { useEffect, useMemo, useState } from 'react'
import NationalPanel from './NationalPanel'
import GovernoratePanel from './GovernoratePanel'
import DelegationPanel from './DelegationPanel'
import CellOperationalPanel from './CellOperationalPanel'
import KpiCard from '../dashboard/KpiCard'
import StatusBadge from '../dashboard/StatusBadge'
import { diagnoseCell, formatMetric, classifyRanIssue, computeRecurrenceMetrics } from '../../admin/adminAggregation'
import { stateLabel, getCellState } from '../../admin/adminOps'
import { downloadRecommendationsCsv } from '../../services/operationalApi.mjs'
import { inferCongestedFromKpis } from '../../utils/v2Contracts.mjs'
import { diagnosisLabelFr } from '../../utils/uiPolicy.mjs'
import { fetchJson } from '../../admin/adminData'
import { confidenceLabelFr } from '../../analytics/qosInsightNarratives.mjs'

export default function CockpitPanel(props) {
  const { activeTab, adminToolsEnabled } = props
  if (activeTab === 'peak-hours') return <PeakHoursPanel {...props} />
  if (activeTab === 'forecast') return <ForecastPanel {...props} />
  if (activeTab === 'qos') return <QosPanel {...props} />
  if (activeTab === 'operations') return <OperationsPanel {...props} />
  if (adminToolsEnabled && activeTab === 'analytics') return <AnalyticsPanel {...props} />
  if (adminToolsEnabled && activeTab === 'data') return <DataPanel {...props} />
  if (adminToolsEnabled && activeTab === 'system') return <SystemPanel {...props} />
  return <OverviewPanel {...props} />
}

function ForecastPanel({ scope, selectedCell, onSelectCell, adminToolsEnabled }) {
  const [horizon, setHorizon] = useState(1)
  const [highOnly, setHighOnly] = useState(true)
  const [forecastState, setForecastState] = useState({ ok: true, rows: [], summary: {}, warnings: [], loading: true })
  const [selectedForecastCell, setSelectedForecastCell] = useState('')
  const rows = forecastState?.rows || []
  const selectedRow = rows.find((row) => row.cell_name === selectedForecastCell) || rows[0] || null
  const query = useMemo(() => {
    const params = new URLSearchParams({
      horizon: String(horizon),
      limit: '50',
      include_low: highOnly ? 'false' : 'true',
      min_risk: highOnly ? '35' : '0',
    })
    if (scope.level === 'cell' && scope.selectedCellName) {
      params.set('scope_level', 'cell')
      params.set('cell_name', scope.selectedCellName)
      params.set('include_low', 'true')
      params.set('min_risk', '0')
    } else if (scope.level === 'delegation' && scope.delegationId) {
      params.set('scope_level', 'delegation')
      params.set('deleg_id', scope.delegationId)
    } else if (scope.level === 'governorate' && scope.governorateId) {
      params.set('scope_level', 'governorate')
      params.set('gov_id', scope.governorateId)
    } else {
      params.set('scope_level', 'national')
    }
    return params.toString()
  }, [scope.level, scope.selectedCellName, scope.delegationId, scope.governorateId, horizon, highOnly])

  useEffect(() => {
    let cancelled = false
    setForecastState((prev) => ({ ...prev, loading: true }))
    fetchJson(`/api/forecast?${query}`)
      .then((payload) => {
        if (!cancelled) {
          setForecastState({ ...payload, loading: false })
          setSelectedForecastCell(payload?.rows?.[0]?.cell_name || '')
        }
      })
      .catch((err) => {
        if (!cancelled) setForecastState({ ok: true, rows: [], summary: {}, warnings: [err.message || String(err)], loading: false })
      })
    return () => { cancelled = true }
  }, [query])

  return <section className="panel-shell cockpit-panel">
    <div className="panel-heading"><div><p>Prévision indicative</p><h1>{selectedCell?.cell_name || scope.delegationName || 'Prévision QoS'}</h1></div><StatusBadge status={rows.length ? 'watch' : 'stable'} /></div>
    <div className="metric-selector">
      <label htmlFor="forecast-horizon">Horizon</label>
      <select id="forecast-horizon" value={horizon} onChange={(event) => setHorizon(Number(event.target.value))}>
        <option value={1}>Horizon 1 tranche</option>
        <option value={3}>Horizon 3 tranches</option>
      </select>
      <label><input type="checkbox" checked={highOnly} onChange={(event) => setHighOnly(event.target.checked)} /> Risques élevés seulement</label>
    </div>
    <div className="kpi-grid compact">
      <KpiCard label="Cellules à risque élevé" value={forecastState?.summary?.high_risk_cells || 0} />
      <KpiCard label="Cellules critiques" value={forecastState?.summary?.critical_risk_cells || 0} />
      <KpiCard label="Risque moyen" value={forecastState?.summary?.average_risk_score || 0} />
      <KpiCard label="Horizon" value={forecastState?.horizon || horizon} />
      <KpiCard label="Confiance globale" value={confidenceLabelFr(forecastState?.summary?.confidence)} />
    </div>
    {forecastState.loading ? <div className="empty-state" role="status">Calcul de la prévision...</div> : null}
    {(forecastState.warnings || []).map((warning) => <div key={warning} className="empty-state warning" role="note">{warning}</div>)}
    {!forecastState.loading && !rows.length ? <div className="empty-state" role="note">Données temporelles insuffisantes pour produire une prévision fiable.</div> : null}
    {rows.length ? <div className="site-table-card"><div className="section-title">Risque estimé <span>{rows.length}</span></div><table><thead><tr><th>Cellule</th><th>Site</th><th>Risque</th><th>Cause probable</th><th>Confiance</th><th>Évidence</th></tr></thead><tbody>{rows.map((row) => <tr key={row.cell_name} onClick={() => { setSelectedForecastCell(row.cell_name); onSelectCell?.(row.cell_name) }}><td>{row.cell_name}</td><td>{row.site_name || '-'}</td><td>{row.risk_score}</td><td>{row.predicted_issue}</td><td>{confidenceLabelFr(row.confidence)}</td><td>{(row.evidence || []).slice(0, 1).join(' ')}</td></tr>)}</tbody></table></div> : null}
    {selectedRow ? <div className="site-table-card">
      <div className="section-title">Analyse assistée</div>
      <div className="diagnosis-box">
        <strong>{selectedRow.cell_name}</strong> - {selectedRow.insight?.summary}
        <div className="diagnosis-evidence">{selectedRow.insight?.why_it_matters}</div>
      </div>
      <div className="kpi-grid compact">
        <KpiCard label="PRB actuel" value={selectedRow.current_kpis?.prb_load || 0} unit="%" />
        <KpiCard label="Débit actuel" value={selectedRow.current_kpis?.throughput || 0} unit="Mbps" />
        <KpiCard label="CQI actuel" value={selectedRow.current_kpis?.cqi || 0} />
        <KpiCard label="Utilisateurs" value={selectedRow.current_kpis?.active_users || 0} />
      </div>
      <div className="delta-grid">
        <span>Tendance PRB <strong>{formatMetric(selectedRow.trend_features?.recent_prb_slope)}</strong></span>
        <span>Tendance débit <strong>{formatMetric(selectedRow.trend_features?.recent_throughput_slope)}</strong></span>
        <span>Tendance CQI <strong>{formatMetric(selectedRow.trend_features?.recent_cqi_slope)}</strong></span>
        <span>Tranches disponibles <strong>{selectedRow.trend_features?.available_slice_count || 0}</strong></span>
      </div>
      <ul className="compact-list">{(selectedRow.insight?.recommended_inspection || []).map((item) => <li key={item}>{item}</li>)}</ul>
      {adminToolsEnabled ? <div className="empty-state" role="note">Modèle {forecastState.model_version} - généré {forecastState.generated_at} - mode {forecastState.data_mode}</div> : null}
    </div> : null}
  </section>
}

function AnalyticsPanel({ governorateRows, delegationRows }) {
  return <section className="panel-shell cockpit-panel">
    <div className="panel-heading"><div><p>Analyse</p><h1>Explore KPI</h1></div></div>
    <div className="site-table-card"><div className="section-title">Top gouvernorats</div><table><thead><tr><th>Nom</th><th>Congestion</th><th>PRB</th><th>Débit</th></tr></thead><tbody>{governorateRows.slice(0, 10).map((row) => <tr key={row.id}><td>{row.name}</td><td>{formatMetric(row.congestion_rate)}%</td><td>{formatMetric(row.avg_prb)}%</td><td>{formatMetric(row.avg_throughput)} Mbps</td></tr>)}</tbody></table></div>
    <div className="site-table-card"><div className="section-title">Top délégations</div><table><thead><tr><th>Nom</th><th>Congestion</th><th>PRB</th><th>Débit</th></tr></thead><tbody>{delegationRows.slice(0, 10).map((row) => <tr key={row.id}><td>{row.name}</td><td>{formatMetric(row.congestion_rate)}%</td><td>{formatMetric(row.avg_prb)}%</td><td>{formatMetric(row.avg_throughput)} Mbps</td></tr>)}</tbody></table></div>
  </section>
}

function OverviewPanel(props) {
  const { scope, nationalSummary, governorateRows, delegationRows, delegationVariationRows, metric, selectedGovernorate, selectedDelegation, delegationSummary, governorateSummary, onSelectGovernorate, onSelectDelegation, reconciliation, sliceDelta, watchlist = [], savedViews = [], onRestoreView, onRemoveView } = props
  const summary = scope.level === 'delegation' || scope.level === 'cell' ? delegationSummary : scope.level === 'governorate' ? governorateSummary : nationalSummary
  return <section className="panel-shell cockpit-panel"><div className="panel-heading"><div><p>Vue réseau</p><h1>{scope.level === 'national' ? 'Réseau mobile Tunisie' : scope.delegationName || scope.governorateName}</h1></div><StatusBadge status={summary.status} /></div><SincePreviousCard delta={sliceDelta} compact />{scope.level === 'national' ? <NationalPanel compact summary={nationalSummary} governorates={governorateRows} delegationVariations={delegationVariationRows} metric={metric} onSelectGovernorate={onSelectGovernorate} reconciliation={reconciliation} /> : null}{scope.level === 'governorate' ? <GovernoratePanel governorate={selectedGovernorate} summary={governorateSummary} delegations={delegationRows} metric={metric} currentTime={props.currentTime} onSelectDelegation={onSelectDelegation} /> : null}{(scope.level === 'delegation' || scope.level === 'cell') ? <DelegationPanel delegation={selectedDelegation} summary={delegationSummary} sites={props.siteRows} onSelectCell={props.onSelectCell} /> : null}
  {watchlist.length ? <div className="site-table-card"><div className="section-title">Watchlist NOC</div><table><tbody>{watchlist.slice(0, 8).map((w) => <tr key={w.cell_name}><td>{w.cell_name}</td><td>{w.note || 'Surveillance'}</td></tr>)}</tbody></table></div> : null}
  {savedViews.length ? <div className="site-table-card"><div className="section-title">Vues sauvegardees</div><table><tbody>{savedViews.slice(0, 8).map((v) => <tr key={v.id}><td>{v.name}</td><td><button className="ghost-button" onClick={() => onRestoreView?.(v.id)}>Restaurer</button><button className="ghost-button" onClick={() => onRemoveView?.(v.id)}>Supprimer</button></td></tr>)}</tbody></table></div> : null}
  </section>
}

const BUSY_METRICS = [
  { id: 'congestion_rate', label: 'Indice de congestion' },
  { id: 'prb', label: 'PRB' },
  { id: 'active_users', label: 'Utilisateurs actifs' },
  { id: 'throughput_drop', label: 'Baisse debit' },
  { id: 'cqi_drop', label: 'Baisse CQI' },
]

function PeakHoursPanel({ scope, currentTime, summary, peakRows, peakPayload, busyMetric, onBusyMetricChange, onPeakRowSelect, sliceDelta }) {
  const recurrence = computeRecurrenceMetrics(peakRows)
  const peakSummary = peakPayload?.summary || {}
  return <section className="panel-shell cockpit-panel">
    <div className="panel-heading">
      <div>
        <p>Heures critiques</p>
        <h1>{scope.delegationName || scope.governorateName || 'Quand le réseau sature'}</h1>
      </div>
      <span className="time-chip">{currentTime?.timestamp || 'Aucune tranche'}</span>
    </div>
    <div className="metric-selector"><label htmlFor="busy-metric">Mesure analysee</label><select id="busy-metric" value={busyMetric} onChange={(event) => onBusyMetricChange(event.target.value)}>{BUSY_METRICS.map((metric) => <option key={metric.id} value={metric.id}>{metric.label}</option>)}</select></div>
    <SincePreviousCard delta={sliceDelta} compact />
    <div className="kpi-grid compact">
      <KpiCard label="Heure pic" value={peakSummary.peak_hour || '-'} />
      <KpiCard label="Fenetre critique" value={peakSummary.peak_window || '-'} />
      <KpiCard label="PRB au pic" value={peakSummary.avg_prb_at_peak ? `${peakSummary.avg_prb_at_peak.toFixed(0)}%` : '-'} />
      <KpiCard label="Congestion pic" value={peakSummary.peak_congestion_rate || 0} unit="%" />
      <KpiCard label="Utilisateurs pic" value={peakSummary.active_users_at_peak || 0} />
      <KpiCard label="Cellules touchees" value={peakSummary.affected_cells_at_peak || summary.congested_cells} />
      <KpiCard label="Recurrence" value={`${(recurrence.recurrence_ratio * 100).toFixed(0)}%`} />
    </div>
    {peakPayload?.available === false ? <div className="empty-state" role="note">{peakPayload.reason || 'Aucun echantillon critique pour ce perimetre.'}</div> : null}
    {peakRows?.length ? <BusyHourHeatmap rows={peakRows} /> : null}
    {peakRows?.length ? (
      <div className="site-table-card">
        <div className="section-title">Zones à traiter</div>
        <table>
          <caption className="sr-only">Zones en heure critique</caption>
          <thead><tr><th scope="col">Périmètre</th><th scope="col">Heure pic</th><th scope="col">Fenêtre</th><th scope="col">PRB</th><th scope="col">Débit</th><th scope="col">CQI</th><th scope="col">Utilisateurs</th><th scope="col">Cellules</th><th scope="col">Récurrence</th><th scope="col">Diagnostic</th></tr></thead>
          <tbody>{peakRows.slice(0, 12).map((row) => {
            const issue = classifyRanIssue({ ...row, avg_prb: row.avg_prb_at_peak, avg_throughput: row.avg_throughput_at_peak, avg_cqi: row.avg_cqi_at_peak })
            return <tr key={`${row.group_by}:${row.id}`} onClick={() => onPeakRowSelect?.(row)}><td>{row.name}</td><td>{row.peak_hour || '-'}</td><td>{row.peak_window || '-'}</td><td>{formatMetric(row.avg_prb_at_peak)}%</td><td>{formatMetric(row.avg_throughput_at_peak)} Mbps</td><td>{formatMetric(row.avg_cqi_at_peak)}</td><td>{formatMetric(row.active_users_at_peak, 0)}</td><td>{row.affected_cells_at_peak || 0}</td><td>{formatMetric((row.recurrence_ratio || 0) * 100, 0)}%</td><td className={`severity-${issue.severity}`}>{diagnosisLabelFr(issue)}</td></tr>
          })}</tbody>
        </table>
      </div>
    ) : null}
  </section>
}

function BusyHourHeatmap({ rows }) {
  const max = Math.max(1, ...rows.flatMap((row) => (row.hourly_profile || []).map((bucket) => Number(bucket.metric_value) || 0)))
  return <div className="heatmap-card"><div className="section-title">Profil 24h</div><div className="heatmap-grid"><div className="heatmap-hours">{Array.from({ length: 24 }, (_, hour) => <span key={hour}>{String(hour).padStart(2, '0')}</span>)}</div>{rows.slice(0, 8).map((row) => <div key={`${row.group_by}:${row.id}`} className="heatmap-row"><strong title={row.name}>{row.name}</strong><div>{(row.hourly_profile || []).map((bucket) => <span key={bucket.hour} title={`${row.name} ${bucket.label}: ${formatMetric(bucket.metric_value)}`} style={{ opacity: 0.18 + Math.min(0.82, (Number(bucket.metric_value) || 0) / max) }} />)}</div></div>)}</div></div>
}

function QosPanel({ scope, summary, selectedCell, siteRows, scopedCells, filters, onFilterChange, bands, onSelectCell, peakRows, sliceDelta, workerState, currentTime, onTabChange }) {
  const issue = classifyRanIssue({ ...summary, recurrence_ratio: computeRecurrenceMetrics(peakRows).recurrence_ratio })
  const compliance = computeCompliance(scopedCells)
  if (scope.level === 'national') {
    return <ScopeQosPanel title="Synthèse radio nationale" summary={summary} issue={issue} compliance={compliance} note="Choisissez un gouvernorat puis une délégation pour inspecter les actifs radio." sliceDelta={sliceDelta} />
  }
  if (scope.level === 'governorate') {
    return <ScopeQosPanel title={scope.governorateName} summary={summary} issue={issue} compliance={compliance} note="Sélectionnez une délégation pour afficher les sites et les cellules." sliceDelta={sliceDelta} />
  }
  if (selectedCell) {
    return <CellQosPanel cell={selectedCell} currentTime={currentTime} workerState={workerState} sliceDelta={sliceDelta} onOpenOperations={() => onTabChange?.('operations')} />
  }
  return <section className="panel-shell cockpit-panel"><div className="panel-heading"><div><p>Qualité radio</p><h1>{scope.delegationName || 'Délégation'}</h1></div><StatusBadge status={summary.status} /></div><SincePreviousCard delta={sliceDelta} compact /><ScopeKpis summary={summary} /><RanIssueBox issue={issue} /><ComplianceCards compliance={compliance} /><FilterBox filters={filters} onFilterChange={onFilterChange} bands={bands} /><div className="site-table-card"><div className="section-title">Sites de la délégation <span>{siteRows.length}</span></div>{siteRows.length ? <table><caption className="sr-only">État radio des sites</caption><thead><tr><th scope="col">État</th><th scope="col">Site</th><th scope="col">Cellule prioritaire</th><th scope="col">Cellules</th><th scope="col">PRB</th><th scope="col">Qualité</th></tr></thead><tbody>{siteRows.map((site) => <tr key={site.site_name} onClick={() => onSelectCell(site.worst_cell)}><td><span className="state-dot" style={{ background: site.state_color }} />{site.state_label}</td><td>{site.site_name}</td><td>{site.worst_cell}</td><td>{site.cells.length}</td><td>{formatMetric(site.avg_prb)}%</td><td>{formatMetric(site.avg_throughput)} Mbps / CQI {formatMetric(site.avg_cqi)}</td></tr>)}</tbody></table> : <div className="empty-state" role="note">Aucun actif radio rapproché dans cette délégation.</div>}</div></section>
}

function ScopeQosPanel({ title, summary, issue, compliance, note, sliceDelta }) {
  return <section className="panel-shell cockpit-panel"><div className="panel-heading"><div><p>Qualité radio</p><h1>{title}</h1></div><StatusBadge status={summary.status} /></div><SincePreviousCard delta={sliceDelta} compact /><ScopeKpis summary={summary} /><RanIssueBox issue={issue} /><ComplianceCards compliance={compliance} /><div className="empty-state" role="note">{note}</div></section>
}

function RanIssueBox({ issue }) {
  return <div className="diagnosis-box"><strong>Diagnostic radio :</strong> {diagnosisLabelFr(issue)}<div className="diagnosis-evidence">{issue.evidence?.length ? issue.evidence.join(' - ') : 'Preuves limitees sur ce perimetre.'}</div></div>
}

function ComplianceCards({ compliance }) {
  return <div className="kpi-grid compact"><KpiCard label="Débit faible" value={compliance.lowThroughputPct} unit="%" /><KpiCard label="PRB élevé" value={compliance.highPrbPct} unit="%" /><KpiCard label="CQI faible" value={compliance.lowCqiPct} unit="%" /><KpiCard label="Congestion récurrente" value={compliance.recurrentPct} unit="%" /><KpiCard label="Délégations touchées" value={compliance.affectedDelegationPct} unit="%" /><KpiCard label="Score qualité" value={compliance.qosScore} /></div>
}

function SincePreviousCard({ delta, compact = false }) {
  if (!delta?.available) return null
  if (compact && !delta.newCongested && !delta.recovered && !delta.worsened && !delta.improved) return null
  return <div className="comparison-card"><div className="section-title">Évolution tranche précédente</div><div className="delta-grid"><span>Nouvelles congestions <strong>{delta.newCongested}</strong></span><span>Récupérées <strong>{delta.recovered}</strong></span><span>Aggravées <strong>{delta.worsened}</strong></span><span>Améliorées <strong>{delta.improved}</strong></span></div></div>
}

function computeCompliance(cells = []) {
  const total = Math.max(1, cells.length)
  const delegations = new Set(cells.map((cell) => cell.admin?.deleg_id).filter(Boolean))
  const affectedDelegations = new Set(cells.filter((cell) => inferCongestedFromKpis({
    prbLoad: Number(cell.prb_load) || 0,
    throughputKbps: Number(cell.throughput_kbps) || (Number(cell.throughput) || 0) * 1000,
    activeUsers: Number(cell.active_users) || 0,
  }) || cell.throughput < 15 || cell.cqi < 8).map((cell) => cell.admin?.deleg_id).filter(Boolean))
  const lowThroughputPct = cells.filter((cell) => cell.throughput > 0 && cell.throughput < 15).length / total * 100
  const highPrbPct = cells.filter((cell) => inferCongestedFromKpis({
    prbLoad: Number(cell.prb_load) || 0,
    throughputKbps: Number(cell.throughput_kbps) || (Number(cell.throughput) || 0) * 1000,
    activeUsers: Number(cell.active_users) || 0,
  })).length / total * 100
  const lowCqiPct = cells.filter((cell) => cell.cqi > 0 && cell.cqi < 8).length / total * 100
  const affectedDelegationPct = delegations.size ? affectedDelegations.size / delegations.size * 100 : 0
  const qosScore = Math.max(0, 100 - (lowThroughputPct * 0.35 + highPrbPct * 0.35 + lowCqiPct * 0.3))
  return { lowThroughputPct, highPrbPct, lowCqiPct, recurrentPct: highPrbPct, affectedDelegationPct, qosScore }
}

function ScopeKpis({ summary }) {
  return <div className="kpi-grid compact"><KpiCard label="Cellules" value={summary.observed_cells} /><KpiCard label="PRB moyen" value={summary.avg_prb} unit="%" /><KpiCard label="Débit" value={summary.avg_throughput} unit="Mbps" /><KpiCard label="CQI" value={summary.avg_cqi} /><KpiCard label="Utilisateurs" value={summary.active_users} /><KpiCard label="Congestion" value={summary.congestion_rate} unit="%" /></div>
}

function CellQosPanel({ cell, currentTime, workerState, sliceDelta, onOpenOperations }) {
  const state = getCellState(cell)
  const issue = classifyRanIssue(cell)
  return <section className="panel-shell cockpit-panel">
    <div className="panel-heading">
      <div>
        <p>Qualité radio</p>
        <h1>{cell.cell_name}</h1>
      </div>
      <StatusBadge status={state === 'critical' ? 'critical' : state === 'watch' ? 'watch' : 'stable'} />
    </div>
    <SincePreviousCard delta={sliceDelta} compact />
    <div className="kpi-grid compact">
      <KpiCard label="Charge PRB" value={cell.prb_load} unit="%" hint="Mesure la saturation capacitaire de la cellule." />
      <KpiCard label="Débit" value={cell.throughput} unit="Mbps" hint="Capacité utile perçue par les utilisateurs." />
      <KpiCard label="CQI" value={cell.cqi} hint="Qualité radio instantanée du lien." />
      <KpiCard label="Utilisateurs actifs" value={cell.active_users} hint="Concurrence radio sur cette tranche horaire." />
      <KpiCard label="TA" value={cell.ta} hint="Indicateur de distance et d'etendue de couverture." />
      <KpiCard label="Santé" value={cell.health} />
    </div>
    <div className="diagnosis-box">
      <strong>Diagnostic radio :</strong> {diagnosisLabelFr(issue)}
      <div className="diagnosis-evidence">{issue.evidence.join(' - ')}</div>
      <strong>Lecture KPI :</strong> {diagnoseCell(cell)}
    </div>
    <div className="next-action-card">
      <strong>Action cellule prête</strong>
      <p>Ouvrez Action cellule pour simuler une correction sur {cell.cell_name} a {currentTime?.timestamp || 'la tranche courante'}.</p>
      <span className={workerState === 'ready' ? 'severity-low' : 'severity-medium'}>{workerState === 'ready' ? 'Simulation disponible' : 'Simulation indisponible'}</span>
      <button type="button" className="primary-cta" onClick={onOpenOperations}>Ouvrir Action cellule</button>
    </div>
    <div className="site-table-card">
      <div className="section-title">Cell context</div>
      <table>
        <caption className="sr-only">Selected cell details</caption>
        <tbody>
          <tr><th scope="row">Site</th><td>{cell.site_name || 'Site inconnu'}</td></tr>
          <tr><th scope="row">Délégation</th><td>{cell.admin?.deleg_name || 'Non rapprochée'}</td></tr>
          <tr><th scope="row">Gouvernorat</th><td>{cell.admin?.gov_name || 'Non rapproché'}</td></tr>
          <tr><th scope="row">Etat</th><td>{stateLabel(state)}</td></tr>
        </tbody>
      </table>
    </div>
  </section>
}

function OperationsPanel({ selectedCell, currentTime, workerState, backendHealth, jobsHealth, onSelectCell, alerts, adminToolsEnabled }) {
  const queueReady = workerState === 'ready'
  const simulationDetail = queueReady
    ? 'Simulation disponible'
    : adminToolsEnabled
      ? (typeof workerState === 'string' && workerState !== 'unavailable' ? workerState : 'Simulation ns-3 indisponible: verifier WSL Ubuntu, ns-3 et Redis dans Admin.')
      : 'Simulation indisponible : verifier les services dans le mode Admin.'
  if (!selectedCell) {
    return <section className="panel-shell cockpit-panel"><div className="panel-heading"><div><p>Action cellule</p><h1>Sélectionner une cellule</h1></div><StatusBadge status="watch" /></div><div className="empty-state" role="note">Recherchez une cellule ou cliquez un site dans Qualité radio pour ouvrir les recommandations et les simulations.</div>{alerts?.length ? <div className="site-table-card"><div className="section-title">Cellules prioritaires</div><table><caption className="sr-only">Cellules à traiter</caption><tbody>{alerts.slice(0, 8).map((cell) => <tr key={cell.cell_name} onClick={() => onSelectCell?.(cell.cell_name)}><td>{cell.cell_name}</td><td>{stateLabel(getCellState(cell))}</td><td>{formatMetric(cell.prb_load)}%</td></tr>)}</tbody></table></div> : null}</section>
  }
  return <CellOperationalPanel cell={selectedCell} currentTime={currentTime} queueReady={queueReady} queueDetail={simulationDetail} backendHealth={backendHealth} disabledActions={jobsHealth?.slo?.disabled_actions || []} />
}

function DataPanel({ data, reconciliation, importState, onImportFile, onImportTypeChange, onImportProfileChange, onRestoreRuntime, onExportJson, onExportReport, dataMode, onDataModeChange, dataQuality, currentTime }) {
  const warnings = reconciliation?.warnings || []
  const schemaDiff = importState.dryRun?.schema_diff
  const missingRequired = schemaDiff?.missing_required || []
  const unknownFields = schemaDiff?.unknown || []
  const dryRunWarnings = importState.dryRun?.sample_warnings || []
  const importStatusMessage = importState.status === 'error'
    ? importState.error
    : `${importState.fileName} - ${importState.result?.imported_cells ?? importState.preview?.totalRows ?? 0} lignes/cellules traitees`

  return <section className="panel-shell cockpit-panel" aria-busy={importState.status === 'parsing'}><div className="panel-heading"><div><p>Data Quality</p><h1>Runtime and admin data</h1></div></div><div className="kpi-grid"><KpiCard label="Runtime cells" value={dataQuality?.baselineCount ?? Object.keys(data?.baseline || {}).length} /><KpiCard label="Matched cells" value={dataQuality?.matched ?? reconciliation?.cell_spatial_join?.matched_cells ?? 'N/A'} /><KpiCard label="Unmatched cells" value={dataQuality?.unmatched ?? 'N/A'} /><KpiCard label="Low spatial confidence" value={dataQuality?.lowSpatial ?? 'N/A'} /><KpiCard label="Missing KPI ratio" value={formatMetric((dataQuality?.missingKpiRatio || 0) * 100, 0)} unit="%" /><KpiCard label="Time slices" value={dataQuality?.timeSlices ?? 0} /><KpiCard label="No observations" value={dataQuality?.withoutObs ?? 0} /><KpiCard label="Last peak-hours" value={dataQuality?.lastPeakComputation || 'N/A'} /></div><div className="ingestion-card"><div className="section-title">Data ingestion</div><div className="ingestion-row"><label htmlFor="data-mode">Mode</label><select id="data-mode" value={dataMode || 'real'} onChange={(e) => onDataModeChange?.(e.target.value)}><option value="real">Real mode</option><option value="mock">Mock demo mode</option></select><label htmlFor="import-type" className="sr-only">Import type</label><select id="import-type" value={importState.importType} onChange={(e) => onImportTypeChange(e.target.value)}><option value="reference">Reference Data CSV</option><option value="kpi">KPI Hourly Data CSV</option></select><label htmlFor="import-profile" className="sr-only">Import profile</label><select id="import-profile" value={importState.selectedProfileId || ''} onChange={(e) => onImportProfileChange?.(e.target.value)}><option value="">Auto mapping</option>{(importState.profiles || []).map((profile) => <option key={profile.id} value={profile.id}>{profile.dataset_name} ({profile.source_type})</option>)}</select><label className="file-pill">Choose CSV<input aria-label="Choose CSV file for import" type="file" accept=".csv,text/csv" onChange={(e) => onImportFile(e.target.files?.[0], importState.importType)} /></label><button data-testid="restore-runtime" className="ghost-button" onClick={onRestoreRuntime}>Restore runtime</button></div>{importState.status !== 'idle' ? <div className={`empty-state ${importState.status === 'error' ? 'warning' : ''}`} role="status">{importStatusMessage}</div> : <div className="empty-state" role="note">Import reference CSV first for geometry, then KPI CSV to update timeline/session data. Strict congestion mode activates when a Congestion Flag column is mapped.</div>}{schemaDiff ? <div className="site-table-card"><div className="section-title">Schema diff (dry-run)</div><div className="delta-grid"><span>Accepted <strong>{schemaDiff.accepted?.length || 0}</strong></span><span>Unknown <strong>{unknownFields.length}</strong></span><span>Missing required <strong>{missingRequired.length}</strong></span></div></div> : null}{missingRequired.length ? <div className="empty-state warning" role="note">Import bloque: colonnes obligatoires manquantes ({missingRequired.join(', ')}).</div> : null}{unknownFields.length ? <div className="empty-state warning" role="note">Champs ignores (non autorises): {unknownFields.slice(0, 8).join(', ')}{unknownFields.length > 8 ? ' ...' : ''}.</div> : null}{dryRunWarnings.map((w) => <div key={w} className="empty-state warning" role="note">{w}</div>)}{importState.result?.warnings?.map((w) => <div key={w} className="empty-state warning" role="note">{w}</div>)}</div>{warnings.map((w) => <div key={w} className="empty-state warning" role="note">{w}</div>)}<div className="export-actions"><button data-testid="export-json" className="primary-cta" onClick={onExportJson}>Export report JSON</button><button data-testid="export-report" className="ghost-button" onClick={onExportReport}>Download report TXT</button><button data-testid="export-recommendations-csv" className="ghost-button" onClick={() => downloadRecommendationsCsv(currentTime?.timestamp)}>Full recommendations CSV</button><button data-testid="export-congested-csv" className="ghost-button" onClick={() => downloadRecommendationsCsv(currentTime?.timestamp)}>Congested recommendations CSV</button></div></section>
}

function SystemPanel({ backendHealth, workerState, data, endpointCoverage }) {
  const byEndpoint = Object.fromEntries((endpointCoverage || []).map((item) => [item.endpoint, item]))
  const queueDetail = workerState === 'ready' ? 'ready' : 'Simulation queue unavailable - optional service outside current phase.'
  return <section className="panel-shell cockpit-panel"><div className="panel-heading"><div><p>System Status</p><h1>Services</h1></div></div><div className="section-title">Core</div><div className="system-grid"><Service name="Next data API" ok={Boolean(data) && byEndpoint['/api/data/*']?.reachable !== false} detail="runtime data loaded" /><Service name="Map engine" ok detail="MapLibre offline polygons" /><Service name="Admin geography" ok={Boolean(data?.governorates?.features?.length && data?.delegations?.features?.length)} detail="governorates and delegations loaded" /><Service name="Peak Hours API" ok={byEndpoint['/api/peak-hours']?.reachable !== false} detail={byEndpoint['/api/peak-hours']?.detail || 'ready'} /></div><div className="section-title system-optional-title">Optional / outside current phase</div><div className="system-grid"><Service name="FastAPI backend" ok={backendHealth?.available || backendHealth?.status === 'ok'} detail={backendHealth?.status || backendHealth?.detail || 'optional for this phase'} /><Service name="Redis / worker" ok={workerState === 'ready'} detail={queueDetail} /><Service name="Simulation queue" ok={workerState === 'ready'} detail={queueDetail} /></div></section>
}

function Service({ name, ok, detail }) { return <div className="service-card"><span className={ok ? 'ok' : 'bad'} /> <strong>{name}</strong><em>{detail}</em></div> }

function FilterBox({ filters, onFilterChange, bands }) {
  return <div className="filter-box"><div className="section-title">Filtres</div><div className="filter-pills">{['critical', 'watch', 'degraded', 'healthy', 'no_data', 'unmatched'].map((key) => <label key={key}><input type="checkbox" checked={Boolean(filters[key])} onChange={(e) => onFilterChange({ [key]: e.target.checked })} />{stateLabel(key)}</label>)}</div><div className="filter-ranges"><label>PRB min <input type="range" min="0" max="100" value={filters.minPrb} onChange={(e) => onFilterChange({ minPrb: Number(e.target.value) })} /> {filters.minPrb}%</label><label>PRB max <input type="range" min="0" max="100" value={filters.maxPrb} onChange={(e) => onFilterChange({ maxPrb: Number(e.target.value) })} /> {filters.maxPrb}%</label></div><div className="filter-pills band-pills">{bands.map((band) => <label key={band}><input type="checkbox" checked={Boolean(filters.bands?.[band])} onChange={(e) => onFilterChange({ bands: { ...filters.bands, [band]: e.target.checked } })} />Bande {band}</label>)}</div></div>
}
