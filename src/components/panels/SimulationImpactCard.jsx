import { formatMetric } from '../../admin/adminAggregation'

export default function SimulationImpactCard({ result }) {
  if (!result) return <div className="empty-state">Run a supported action to compare before and after KPI impact.</div>
  const before = result.before || result.current || {}
  const after = result.after || result.predicted || {}
  const confidence = result.confidence || result.confidence_level || 'fast'
  return (
    <div className="simulation-impact">
      <div className="section-title">Before / After Impact <span>{confidence} confidence</span></div>
      <div className="impact-grid">
        <Impact label="PRB" before={before.prb_load ?? before.load} after={after.prb_load ?? after.load} unit="%" />
        <Impact label="Throughput" before={normalizeThroughput(before.throughput)} after={normalizeThroughput(after.throughput)} unit="Mbps" />
        <Impact label="CQI" before={before.cqi} after={after.cqi} />
      </div>
      {result.recommendation ? <p className="impact-note">{result.recommendation}</p> : null}
    </div>
  )
}
function normalizeThroughput(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return value
  return n > 1000 ? n / 1000 : n
}
function Impact({ label, before, after, unit = '' }) {
  return <div><span>{label}</span><strong>{formatMetric(before)}{unit}</strong><em>{formatMetric(after)}{unit}</em></div>
}
