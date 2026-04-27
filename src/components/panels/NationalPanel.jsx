import KpiCard from '../dashboard/KpiCard'
import RankingTable from '../dashboard/RankingTable'
import TrendChart from '../dashboard/TrendChart'
import { formatMetric } from '../../admin/adminAggregation'

export default function NationalPanel({ summary, governorates, metric, onSelectGovernorate, reconciliation }) {
  const warnings = reconciliation?.warnings || []
  return (
    <section className="panel-shell">
      <div className="panel-heading"><div><p>National view</p><h1>Tunisia Network Overview</h1></div><span className="live-pill">Live runtime slice</span></div>
      <div className="kpi-grid">
        <KpiCard label="Observed Cells" value={summary.observed_cells} />
        <KpiCard label="Active Users" value={summary.active_users} />
        <KpiCard label="Avg PRB Load" value={summary.avg_prb} unit="%" tone={summary.avg_prb > 80 ? 'danger' : 'neutral'} />
        <KpiCard label="Avg Throughput" value={summary.avg_throughput} unit="Mbps" />
        <KpiCard label="Congestion Rate" value={summary.congestion_rate} unit="%" tone={summary.congestion_rate > 10 ? 'danger' : 'neutral'} />
        <KpiCard label="Affected Delegations" value={summary.delegations} />
      </div>
      <TrendChart label="National congestion/performance trend" points={[summary.congestion_rate * .7, summary.congestion_rate * .9, summary.congestion_rate, summary.congestion_rate * .85, summary.congestion_rate * 1.05]} />
      <RankingTable title="Top Affected Governorates" rows={governorates.slice(0, 8)} metricLabel={metric.label} metricUnit={metric.unit} onSelect={onSelectGovernorate} />
      <div className="geo-status"><strong>Admin geography:</strong> COD-AB + INS registry target <span>{reconciliation?.counts?.cod_delegations || 0} / {reconciliation?.counts?.target_delegations_ins_rgph_2024 || 279} delegations</span>{warnings.length ? <em>{warnings.length} reconciliation items need review</em> : null}</div>
      <button className="primary-cta" onClick={() => governorates[0] && onSelectGovernorate(governorates[0])}>Inspect highest-impact governorate</button>
    </section>
  )
}
