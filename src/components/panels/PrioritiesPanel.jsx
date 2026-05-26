import KpiCard from '../dashboard/KpiCard'
import StatusBadge from '../dashboard/StatusBadge'
import { formatMetric } from '../../admin/adminAggregation'
import { stateLabel, getCellState } from '../../admin/adminOps'
import { confidenceLabelFr } from '../../analytics/qosInsightNarratives.mjs'

export default function PrioritiesPanel(props) {
  const { alerts = [], peakRows = [], forecastState = {}, onSelectCell, onPeakRowSelect, onTabChange } = props
  const forecastRows = Array.isArray(forecastState?.rows) ? forecastState.rows : []
  return <section className="panel-shell cockpit-panel">
    <div className="panel-heading"><div><p>PrioritÃ©s</p><h1>PrioritÃ©s rÃ©seau</h1></div><StatusBadge status="watch" /></div>
    <div className="empty-state" role="note">Cellules et zones Ã  surveiller selon les KPI, les heures critiques et le risque prochain horizon.</div>
    <div className="kpi-grid compact">
      <KpiCard label="Critiques maintenant" value={alerts.length} />
      <KpiCard label="Risque prochain horizon" value={forecastRows.length} />
      <KpiCard label="Heures critiques rÃ©currentes" value={peakRows.length} />
      <KpiCard label="Confiance" value={confidenceLabelFr(forecastState?.summary?.confidence)} />
    </div>
    <div className="site-table-card"><div className="section-title">Ã€ traiter maintenant</div><table><tbody>{alerts.slice(0, 8).map((cell) => <tr key={cell.cell_name} onClick={() => onSelectCell?.(cell.cell_name, { activeTab: 'cell-dossier' })}><td>{cell.cell_name}</td><td>{stateLabel(getCellState(cell))}</td><td>{formatMetric(cell.prb_load)}%</td></tr>)}</tbody></table></div>
    <div className="site-table-card"><div className="section-title">Risque prochain horizon</div>{forecastRows.length ? <table><tbody>{forecastRows.slice(0, 8).map((row) => <tr key={row.cell_name} onClick={() => onSelectCell?.(row.cell_name, { activeTab: 'cell-dossier' })}><td>{row.cell_name}</td><td>{row.predicted_issue}</td><td>{row.risk_score}</td></tr>)}</tbody></table> : <div className="empty-state">Aucun risque forecast disponible dans ce pÃ©rimÃ¨tre.</div>}</div>
    <div className="site-table-card"><div className="section-title">Heures critiques</div>{peakRows.length ? <table><tbody>{peakRows.slice(0, 8).map((row) => <tr key={`${row.group_by}:${row.id}`} onClick={() => onPeakRowSelect?.(row)}><td>{row.name}</td><td>{row.peak_hour || '-'}</td><td>{formatMetric(row.avg_prb_at_peak)}%</td></tr>)}</tbody></table> : <div className="empty-state">Aucune heure critique dÃ©tectÃ©e pour ce pÃ©rimÃ¨tre.</div>}</div>
    <div className="site-table-card">
      <div className="section-title">Pourquoi c&apos;est prioritaire</div>
      <ul className="compact-list">
        <li>Signaux observÃ©s: pression PRB, dÃ©bit, CQI et charge utilisateurs.</li>
        <li>Ã€ vÃ©rifier maintenant: cellule touchÃ©e, voisinage, fenÃªtre horaire rÃ©currente.</li>
      </ul>
      <button className="primary-cta" type="button" onClick={() => onTabChange?.('cell-dossier')}>Ouvrir le dossier</button>
    </div>
  </section>
}

