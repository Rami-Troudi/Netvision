import KpiCard from '../dashboard/KpiCard'
import RankingTable from '../dashboard/RankingTable'
import StatusBadge from '../dashboard/StatusBadge'
import TrendChart from '../dashboard/TrendChart'

export default function GovernoratePanel({ governorate, summary, delegations, metric, currentTime, onSelectDelegation }) {
  return (
    <section className="panel-shell">
      <div className="panel-heading"><div><p>Focus gouvernorat</p><h1>{governorate?.gov_name || 'Gouvernorat'}</h1></div><StatusBadge status={summary.status} /></div>
      <div className="time-chip">Tranche : {currentTime?.timestamp || 'non chargée'}</div>
      <div className="kpi-grid compact">
        <KpiCard label="PRB moyen" value={summary.avg_prb} unit="%" />
        <KpiCard label="Débit" value={summary.avg_throughput} unit="Mbps" />
        <KpiCard label="CQI" value={summary.avg_cqi} />
        <KpiCard label="Utilisateurs actifs" value={summary.active_users} />
        <KpiCard label="Cellules congestionnées" value={`${summary.congested_cells} / ${summary.observed_cells}`} />
        <KpiCard label="Trafic récupérable" value={summary.recoverable_traffic} unit="GB" />
      </div>
      <TrendChart label="Tendance régionale de congestion" points={[summary.congestion_rate*.8, summary.congestion_rate*.9, summary.congestion_rate*1.15, summary.congestion_rate]} />
      <RankingTable title="Délégations les plus impactées" rows={delegations.slice(0, 10)} metricLabel={metric.label} metricUnit={metric.unit} onSelect={onSelectDelegation} empty="Aucune observation radio associée dans ce gouvernorat." />
      <div className="diagnosis-box">Diagnostic régional : {summary.congested_cells ? 'La congestion est concentrée sur les délégations classées, descendez au niveau site/cellule.' : 'Aucune cellule congestionnée sur la tranche sélectionnée.'}</div>
      <button className="primary-cta" onClick={() => delegations[0] && onSelectDelegation(delegations[0])}>Explorer les délégations</button>
    </section>
  )
}
