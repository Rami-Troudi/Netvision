import { formatMetric } from '../../admin/adminAggregation'
import StatusBadge from './StatusBadge'

export default function RankingTable({ title, rows = [], metricLabel, metricUnit = '', onSelect, empty = 'Aucune ligne disponible.' }) {
  return (
    <div className="ranking-card">
      <div className="section-title">{title}</div>
      {rows.length ? <table><thead><tr><th>#</th><th>Nom</th><th>Etat</th><th>{metricLabel}</th><th>Cellules</th><th>PRB</th></tr></thead><tbody>
        {rows.map((row, idx) => <tr key={row.id || row.name} onClick={() => onSelect?.(row)}><td>{idx + 1}</td><td>{row.name}</td><td><StatusBadge status={row.status} /></td><td>{formatMetric(row.value)}{metricUnit}</td><td>{row.observed_cells || 0}</td><td>{formatMetric(row.avg_prb)}%</td></tr>)}
      </tbody></table> : <div className="empty-state">{empty}</div>}
    </div>
  )
}
