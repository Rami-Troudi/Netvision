import KpiCard from '../dashboard/KpiCard'
import StatusBadge from '../dashboard/StatusBadge'
import { diagnoseCell, formatMetric, classifyRanIssue, computeRecurrenceMetrics } from '../../admin/adminAggregation'
import { stateLabel, getCellState } from '../../admin/adminOps'
import { inferCongestedFromKpis } from '../../utils/v2Contracts.mjs'
import { diagnosisLabelFr } from '../../utils/uiPolicy.mjs'

function SincePreviousCard({ delta, compact = false }) {
  if (!delta?.available) return null
  if (compact && !delta.newCongested && !delta.recovered && !delta.worsened && !delta.improved) return null
  return <div className="comparison-card"><div className="section-title">Ã‰volution tranche prÃ©cÃ©dente</div><div className="delta-grid"><span>Nouvelles congestions <strong>{delta.newCongested}</strong></span><span>RÃ©cupÃ©rÃ©es <strong>{delta.recovered}</strong></span><span>AggravÃ©es <strong>{delta.worsened}</strong></span><span>AmÃ©liorÃ©es <strong>{delta.improved}</strong></span></div></div>
}

function RanIssueBox({ issue }) {
  return <div className="diagnosis-box"><strong>Diagnostic radio :</strong> {diagnosisLabelFr(issue)}<div className="diagnosis-evidence">{issue.evidence?.length ? issue.evidence.join(' - ') : 'Preuves limitees sur ce perimetre.'}</div></div>
}

function ComplianceCards({ compliance }) {
  return <div className="kpi-grid compact"><KpiCard label="DÃ©bit faible" value={compliance.lowThroughputPct} unit="%" /><KpiCard label="PRB Ã©levÃ©" value={compliance.highPrbPct} unit="%" /><KpiCard label="CQI faible" value={compliance.lowCqiPct} unit="%" /><KpiCard label="Congestion rÃ©currente" value={compliance.recurrentPct} unit="%" /><KpiCard label="DÃ©lÃ©gations touchÃ©es" value={compliance.affectedDelegationPct} unit="%" /><KpiCard label="Score qualitÃ©" value={compliance.qosScore} /></div>
}

function ScopeKpis({ summary }) {
  return <div className="kpi-grid compact"><KpiCard label="Cellules" value={summary.observed_cells} /><KpiCard label="PRB moyen" value={summary.avg_prb} unit="%" /><KpiCard label="DÃ©bit" value={summary.avg_throughput} unit="Mbps" /><KpiCard label="CQI" value={summary.avg_cqi} /><KpiCard label="Utilisateurs" value={summary.active_users} /><KpiCard label="Congestion" value={summary.congestion_rate} unit="%" /></div>
}

function ScopeQosPanel({ title, summary, issue, compliance, note, sliceDelta }) {
  return <section className="panel-shell cockpit-panel"><div className="panel-heading"><div><p>QualitÃ© radio</p><h1>{title}</h1></div><StatusBadge status={summary.status} /></div><SincePreviousCard delta={sliceDelta} compact /><ScopeKpis summary={summary} /><RanIssueBox issue={issue} /><ComplianceCards compliance={compliance} /><div className="empty-state" role="note">{note}</div></section>
}

function FilterBox({ filters, onFilterChange, bands }) {
  return <div className="filter-box"><div className="section-title">Filtres</div><div className="filter-pills">{['critical', 'watch', 'degraded', 'healthy', 'no_data', 'unmatched'].map((key) => <label key={key}><input type="checkbox" checked={Boolean(filters[key])} onChange={(e) => onFilterChange({ [key]: e.target.checked })} />{stateLabel(key)}</label>)}</div><div className="filter-ranges"><label>PRB min <input type="range" min="0" max="100" value={filters.minPrb} onChange={(e) => onFilterChange({ minPrb: Number(e.target.value) })} /> {filters.minPrb}%</label><label>PRB max <input type="range" min="0" max="100" value={filters.maxPrb} onChange={(e) => onFilterChange({ maxPrb: Number(e.target.value) })} /> {filters.maxPrb}%</label></div><div className="filter-pills band-pills">{bands.map((band) => <label key={band}><input type="checkbox" checked={Boolean(filters.bands?.[band])} onChange={(e) => onFilterChange({ bands: { ...filters.bands, [band]: e.target.checked } })} />Bande {band}</label>)}</div></div>
}

function CellQosPanel({ cell, currentTime, workerState, sliceDelta, onOpenOperations }) {
  const state = getCellState(cell)
  const issue = classifyRanIssue(cell)
  return <section className="panel-shell cockpit-panel">
    <div className="panel-heading">
      <div>
        <p>Dossier cellule</p>
        <h1>{cell.cell_name}</h1>
      </div>
      <StatusBadge status={state === 'critical' ? 'critical' : state === 'watch' ? 'watch' : 'stable'} />
    </div>
    <SincePreviousCard delta={sliceDelta} compact />
    <div className="kpi-grid compact">
      <KpiCard label="Charge PRB" value={cell.prb_load} unit="%" hint="Mesure la saturation capacitaire de la cellule." />
      <KpiCard label="DÃ©bit" value={cell.throughput} unit="Mbps" hint="CapacitÃ© utile perÃ§ue par les utilisateurs." />
      <KpiCard label="CQI" value={cell.cqi} hint="QualitÃ© radio instantanÃ©e du lien." />
      <KpiCard label="Utilisateurs actifs" value={cell.active_users} hint="Concurrence radio sur cette tranche horaire." />
      <KpiCard label="TA" value={cell.ta} hint="Indicateur de distance et d'etendue de couverture." />
      <KpiCard label="SantÃ©" value={cell.health} />
    </div>
    <div className="diagnosis-box">
      <strong>Diagnostic radio :</strong> {diagnosisLabelFr(issue)}
      <div className="diagnosis-evidence">{issue.evidence.join(' - ')}</div>
      <strong>Lecture KPI :</strong> {diagnoseCell(cell)}
    </div>
    <div className="next-action-card">
      <strong>Simulation prÃªte</strong>
      <p>PrÃ©parez une simulation sur {cell.cell_name} Ã  {currentTime?.timestamp || 'la tranche courante'}.</p>
      <span className={workerState === 'ready' ? 'severity-low' : 'severity-medium'}>{workerState === 'ready' ? 'Simulation disponible' : 'Simulation indisponible'}</span>
      <button type="button" className="primary-cta" onClick={onOpenOperations}>PrÃ©parer simulation</button>
    </div>
    <div className="site-table-card">
      <div className="section-title">Cell context</div>
      <table>
        <caption className="sr-only">Selected cell details</caption>
        <tbody>
          <tr><th scope="row">Site</th><td>{cell.site_name || 'Site inconnu'}</td></tr>
          <tr><th scope="row">DÃ©lÃ©gation</th><td>{cell.admin?.deleg_name || 'Non rapprochÃ©e'}</td></tr>
          <tr><th scope="row">Gouvernorat</th><td>{cell.admin?.gov_name || 'Non rapprochÃ©'}</td></tr>
          <tr><th scope="row">Etat</th><td>{stateLabel(state)}</td></tr>
        </tbody>
      </table>
    </div>
  </section>
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

function QosPanel({ scope, summary, selectedCell, siteRows, scopedCells, filters, onFilterChange, bands, onSelectCell, peakRows, sliceDelta, workerState, currentTime, onTabChange }) {
  const issue = classifyRanIssue({ ...summary, recurrence_ratio: computeRecurrenceMetrics(peakRows).recurrence_ratio })
  const compliance = computeCompliance(scopedCells)
  if (scope.level === 'national') {
    return <ScopeQosPanel title="SynthÃ¨se radio nationale" summary={summary} issue={issue} compliance={compliance} note="Choisissez un gouvernorat puis une dÃ©lÃ©gation pour inspecter les actifs radio." sliceDelta={sliceDelta} />
  }
  if (scope.level === 'governorate') {
    return <ScopeQosPanel title={scope.governorateName} summary={summary} issue={issue} compliance={compliance} note="SÃ©lectionnez une dÃ©lÃ©gation pour afficher les sites et les cellules." sliceDelta={sliceDelta} />
  }
  if (selectedCell) {
    return <CellQosPanel cell={selectedCell} currentTime={currentTime} workerState={workerState} sliceDelta={sliceDelta} onOpenOperations={() => onTabChange?.('simulation')} />
  }
  return <section className="panel-shell cockpit-panel"><div className="panel-heading"><div><p>QualitÃ© radio</p><h1>{scope.delegationName || 'DÃ©lÃ©gation'}</h1></div><StatusBadge status={summary.status} /></div><SincePreviousCard delta={sliceDelta} compact /><ScopeKpis summary={summary} /><RanIssueBox issue={issue} /><ComplianceCards compliance={compliance} /><FilterBox filters={filters} onFilterChange={onFilterChange} bands={bands} /><div className="site-table-card"><div className="section-title">Sites de la dÃ©lÃ©gation <span>{siteRows.length}</span></div>{siteRows.length ? <table><caption className="sr-only">Ã‰tat radio des sites</caption><thead><tr><th scope="col">Ã‰tat</th><th scope="col">Site</th><th scope="col">Cellule prioritaire</th><th scope="col">Cellules</th><th scope="col">PRB</th><th scope="col">QualitÃ©</th></tr></thead><tbody>{siteRows.map((site) => <tr key={site.site_name} onClick={() => onSelectCell(site.worst_cell)}><td><span className="state-dot" style={{ background: site.state_color }} />{site.state_label}</td><td>{site.site_name}</td><td>{site.worst_cell}</td><td>{site.cells.length}</td><td>{formatMetric(site.avg_prb)}%</td><td>{formatMetric(site.avg_throughput)} Mbps / CQI {formatMetric(site.avg_cqi)}</td></tr>)}</tbody></table> : <div className="empty-state" role="note">Aucun actif radio rapprochÃ© dans cette dÃ©lÃ©gation.</div>}</div></section>
}

export default function CellDossierPanel(props) {
  const { selectedCell, alerts = [], onSelectCell, onTabChange } = props
  if (!selectedCell) {
    return <section className="panel-shell cockpit-panel">
      <div className="panel-heading"><div><p>Dossier cellule</p><h1>SÃ©lectionner une cellule</h1></div><StatusBadge status="watch" /></div>
      <div className="empty-state" role="note">SÃ©lectionnez une cellule depuis la carte, la recherche ou les prioritÃ©s.</div>
      {alerts.length ? <div className="site-table-card"><div className="section-title">Ã€ traiter maintenant</div><table><tbody>{alerts.slice(0, 8).map((cell) => <tr key={cell.cell_name} onClick={() => onSelectCell?.(cell.cell_name)}><td>{cell.cell_name}</td><td>{stateLabel(getCellState(cell))}</td><td>{formatMetric(cell.prb_load)}%</td></tr>)}</tbody></table></div> : null}
      <button className="ghost-button" type="button" onClick={() => onTabChange?.('priorities')}>Voir les prioritÃ©s</button>
    </section>
  }
  return <QosPanel {...props} />
}

