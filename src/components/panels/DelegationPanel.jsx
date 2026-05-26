import KpiCard from '../dashboard/KpiCard'
import StatusBadge from '../dashboard/StatusBadge'
import { formatMetric } from '../../admin/adminAggregation'

export default function DelegationPanel({ delegation, summary, sites, onSelectCell }) {
  return (
    <section className="panel-shell">
      <div className="panel-heading"><div><p>Vue opérationnelle délégation</p><h1>{delegation?.deleg_name || 'Délégation'}</h1></div><StatusBadge status={summary.status} /></div>
      <div className="kpi-grid compact">
        <KpiCard label="Sites" value={sites.length} />
        <KpiCard label="Cellules" value={summary.observed_cells} />
        <KpiCard label="PRB moyen" value={summary.avg_prb} unit="%" />
        <KpiCard label="Débit" value={summary.avg_throughput} unit="Mbps" />
      </div>
      <div className="site-table-card">
        <div className="section-title">Santé des sites</div>
        {sites.length ? <table><thead><tr><th>Site</th><th>Cellules</th><th>État</th><th>PRB</th><th>Utilisateurs</th></tr></thead><tbody>
          {sites.map((site) => <tr key={site.site_name} onClick={() => site.cells[0] && onSelectCell(site.cells[0].cell_name)}><td>{site.site_name}</td><td>{site.cells.length}</td><td><StatusBadge status={site.status} /></td><td>{formatMetric(site.avg_prb)}%</td><td>{formatMetric(site.active_users, 0)}</td></tr>)}
        </tbody></table> : <div className="empty-state">Aucun actif radio associé dans cette délégation.</div>}
      </div>
      <div className="diagnosis-box">Sélectionnez un site ou une cellule pour inspecter les preuves QoS. Les sites et cellules sont masqués avant le périmètre délégation.</div>
    </section>
  )
}
