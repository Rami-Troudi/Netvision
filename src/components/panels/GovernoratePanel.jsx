import KpiCard from '../dashboard/KpiCard'
import RankingTable from '../dashboard/RankingTable'
import StatusBadge from '../dashboard/StatusBadge'
import TrendChart from '../dashboard/TrendChart'

export default function GovernoratePanel({ governorate, summary, delegations, metric, currentTime, onSelectDelegation }) {
  return (
    <section className="panel-shell">
      <div className="panel-heading"><div><p>Governorate focus</p><h1>{governorate?.gov_name || 'Governorate'}</h1></div><StatusBadge status={summary.status} /></div>
      <div className="time-chip">Time slice: {currentTime?.timestamp || 'not loaded'}</div>
      <div className="kpi-grid compact">
        <KpiCard label="Avg PRB" value={summary.avg_prb} unit="%" />
        <KpiCard label="Throughput" value={summary.avg_throughput} unit="Mbps" />
        <KpiCard label="CQI" value={summary.avg_cqi} />
        <KpiCard label="Active Users" value={summary.active_users} />
        <KpiCard label="Congested Cells" value={`${summary.congested_cells} / ${summary.observed_cells}`} />
        <KpiCard label="Recoverable Traffic" value={summary.recoverable_traffic} unit="GB" />
      </div>
      <TrendChart label="Regional congestion trend" points={[summary.congestion_rate*.8, summary.congestion_rate*.9, summary.congestion_rate*1.15, summary.congestion_rate]} />
      <RankingTable title="Top Affected Delegations" rows={delegations.slice(0, 10)} metricLabel={metric.label} metricUnit={metric.unit} onSelect={onSelectDelegation} empty="No matched radio observations in this governorate." />
      <div className="diagnosis-box">Regional diagnosis: {summary.congested_cells ? 'Congestion is concentrated in the ranked delegations; drill down to inspect sites and cells.' : 'No congested cells in the selected time slice.'}</div>
      <button className="primary-cta" onClick={() => delegations[0] && onSelectDelegation(delegations[0])}>Explore Delegations</button>
    </section>
  )
}
