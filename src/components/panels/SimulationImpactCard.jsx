import { formatMetric } from '../../admin/adminAggregation'

export default function SimulationImpactCard({ result }) {
  if (!result) return <div className="empty-state">Lancez une action supportee pour comparer l impact KPI avant et apres.</div>
  const before = result.before || result.current || {}
  const after = result.after || result.predicted || {}
  return (
    <div className="simulation-impact">
      <div className="section-title">Impact avant / apres</div>
      <div className="impact-grid">
        <Impact label="PRB" before={before.prb_load ?? before.load} after={after.prb_load ?? after.load} unit="%" />
        <Impact label="Debit" before={normalizeThroughput(before.throughput)} after={normalizeThroughput(after.throughput)} unit="Mbps" />
        <Impact label="CQI" before={before.cqi} after={after.cqi} />
      </div>
      {result.recommendation ? <p className="impact-note">{localizeImpactNote(result.recommendation)}</p> : null}
    </div>
  )
}
function normalizeThroughput(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return value
  return n > 1000 ? n / 1000 : n
}
function localizeImpactNote(note) {
  return String(note || '')
    .replace(/Add sector to increase structural capacity envelope/gi, 'Ajouter un secteur pour augmenter la capacite structurelle.')
    .replace(/Add carrier to increase available capacity/gi, 'Ajouter une porteuse pour augmenter la capacite disponible.')
    .replace(/Redistribute load/gi, 'Reequilibrer la charge')
    .replace(/Adjust antenna tilt/gi, 'Ajuster l inclinaison antennaire')
}
function Impact({ label, before, after, unit = '' }) {
  return <div><span>{label}</span><strong>{formatMetric(before)}{unit}</strong><em>{formatMetric(after)}{unit}</em></div>
}
