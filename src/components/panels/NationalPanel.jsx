import KpiCard from '../dashboard/KpiCard'
import RankingTable from '../dashboard/RankingTable'
import TrendChart from '../dashboard/TrendChart'
import { formatMetric } from '../../admin/adminAggregation'

export default function NationalPanel({ summary, governorates, delegationVariations = [], metric, onSelectGovernorate, reconciliation }) {
  const warnings = reconciliation?.warnings || []
  return (
    <section className="panel-shell">
      <div className="panel-heading"><div><p>Vue nationale</p><h1>Vue réseau Tunisie</h1></div><span className="live-pill">Tranche active</span></div>
      <div className="kpi-grid">
        <KpiCard label="Cellules observees" value={summary.observed_cells} />
        <KpiCard label="Utilisateurs actifs" value={summary.active_users} />
        <KpiCard label="Charge PRB moyenne" value={summary.avg_prb} unit="%" tone={summary.avg_prb > 80 ? 'danger' : 'neutral'} />
        <KpiCard label="Debit moyen" value={summary.avg_throughput} unit="Mbps" />
        <KpiCard label="Taux de congestion" value={summary.congestion_rate} unit="%" tone={summary.congestion_rate > 10 ? 'danger' : 'neutral'} />
        <KpiCard label="Delegations impactees" value={summary.delegations} />
      </div>
      <TrendChart label="Tendance nationale congestion/performance" points={[summary.congestion_rate * .7, summary.congestion_rate * .9, summary.congestion_rate, summary.congestion_rate * .85, summary.congestion_rate * 1.05]} />
      <DelegationVariationCard rows={delegationVariations} metric={metric} />
      <RankingTable title="Gouvernorats les plus impactes" rows={governorates.slice(0, 8)} metricLabel={metric.label} metricUnit={metric.unit} onSelect={onSelectGovernorate} />
      {warnings.length ? <div className="geo-status"><strong>Qualité du rapprochement :</strong><span>{warnings.length} élément à revoir dans les données administratives</span></div> : null}
      <button className="primary-cta" onClick={() => governorates[0] && onSelectGovernorate(governorates[0])}>Inspecter le gouvernorat le plus impacte</button>
    </section>
  )
}

function DelegationVariationCard({ rows = [], metric }) {
  if (!rows.length) {
    return <div className="variation-card idle"><div className="section-title">Variations delegations</div><span>Lancez la lecture ou avancez d une tranche pour voir les delegations qui changent.</span></div>
  }
  return (
    <div className="variation-card">
      <div className="section-title">Variations delegations <span>depuis la tranche precedente</span></div>
      <div className="variation-list">
        {rows.slice(0, 6).map((row) => {
          const direction = row.deltaValue >= 0 ? 'up' : 'down'
          return (
            <div key={row.id} className={`variation-row ${direction}`}>
              <strong>{row.name}</strong>
              <span>{row.deltaValue >= 0 ? '+' : ''}{formatMetric(row.deltaValue)}{metric.unit}</span>
              <em>PRB {row.deltaPrb >= 0 ? '+' : ''}{formatMetric(row.deltaPrb)} pts · congestion {row.deltaCongestion >= 0 ? '+' : ''}{formatMetric(row.deltaCongestion)} pts</em>
            </div>
          )
        })}
      </div>
    </div>
  )
}
