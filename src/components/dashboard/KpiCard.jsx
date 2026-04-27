import { formatMetric } from '../../admin/adminAggregation'

export default function KpiCard({ label, value, unit = '', tone = 'neutral', hint = '' }) {
  return (
    <div className={`kpi-card kpi-${tone}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{typeof value === 'number' ? formatMetric(value) : value}<span>{unit}</span></div>
      {hint ? <div className="kpi-hint">{hint}</div> : null}
    </div>
  )
}
