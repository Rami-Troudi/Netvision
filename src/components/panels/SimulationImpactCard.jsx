import { formatMetric } from '../../admin/adminAggregation'

export default function SimulationImpactCard({ result }) {
  if (!result) return <div className="empty-state">Lancez une action supportee pour comparer l impact KPI avant et apres.</div>
  const before = result.before || result.current || {}
  const after = result.after || result.predicted || {}
  return (
    <div className="simulation-impact">
      <div className="section-title">Resultat indicatif</div>
      <p className="impact-note">Impact avant / apres estime par scenario local.</p>
      <div className="impact-grid">
        <Impact label="PRB" before={before.prb_load ?? before.load} after={after.prb_load ?? after.load} unit="%" />
        <Impact label="Debit" before={normalizeThroughput(before.throughput)} after={normalizeThroughput(after.throughput)} unit="Mbps" />
        <Impact label="CQI" before={before.cqi} after={after.cqi} />
      </div>
      {result.engine || result.fidelity_level || result.runtime_seconds ? (
        <div className="impact-meta">
          <span>Niveau {localizeFidelity(result.fidelity_level)}</span>
          {Number.isFinite(Number(result.runtime_seconds)) ? <span>Duree {formatMetric(result.runtime_seconds)}s</span> : null}
          {result.calibration?.quality ? <span>Calibration {localizeCalibrationQuality(result.calibration.quality)}</span> : null}
          {Number.isFinite(Number(result.confidence_pct)) ? <span>Confiance {formatMetric(result.confidence_pct)}%</span> : null}
        </div>
      ) : null}
      {result.feasibility || result.credibility ? (
        <div className="assumption-list">
          <strong>Credibilite du resultat</strong>
          {result.feasibility ? <span>Faisabilite {result.feasibility.ok ? 'confirmee' : 'bloquee'}</span> : null}
          {result.credibility ? <span>Score credibilite {formatMetric(result.credibility.score)}%</span> : null}
          {Array.isArray(result.credibility?.reasons) && result.credibility.reasons.slice(0, 3).map((item) => <span key={item}>{item}</span>)}
        </div>
      ) : null}
      {Array.isArray(result.scenario_assumptions) && result.scenario_assumptions.length ? (
        <div className="assumption-list">
          <strong>Hypotheses du scenario</strong>
          {result.scenario_assumptions.slice(0, 3).map((item) => <span key={item}>{item}</span>)}
        </div>
      ) : null}
      {result.recommendation ? <p className="impact-note">{localizeImpactNote(result.recommendation)}</p> : null}
      {Array.isArray(result.confidence_explain) && result.confidence_explain.length ? (
        <div className="assumption-list">
          <strong>Limites de fiabilite</strong>
          {result.confidence_explain.slice(0, 3).map((item) => <span key={item}>{item}</span>)}
        </div>
      ) : null}
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
function localizeConfidence(confidence) {
  return { low: 'faible', medium: 'moyenne', high: 'elevee' }[String(confidence || '').toLowerCase()] || confidence
}
function localizeCalibrationQuality(quality) {
  return { low: 'faible', medium: 'moyenne', high: 'elevee' }[String(quality || '').toLowerCase()] || quality
}
function localizeFidelity(fidelity) {
  const key = String(fidelity || 'operations_v1').toLowerCase()
  if (key === 'operations_v2_calibrated') return 'calibre'
  return 'standard'
}
function Impact({ label, before, after, unit = '' }) {
  return <div><span>{label}</span><strong>{formatMetric(before)}{unit}</strong><em>{formatMetric(after)}{unit}</em></div>
}
