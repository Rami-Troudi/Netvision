import { ACTION_LABELS_FR } from '../../utils/uiPolicy.mjs'

function readableReason(reason) {
  const text = String(reason || '').trim()
  if (!text) return 'Preuve KPI insuffisante pour détailler la cause.'
  return text
    .replace(/PRB load above 90%/gi, 'PRB supérieure à 90%')
    .replace(/PRB-saturated but CQI\/throughput acceptable/gi, 'PRB saturée avec CQI et débit encore acceptables')
    .replace(/capacity-driven/gi, 'pression capacitaire probable')
    .replace(/manual review recommended/gi, 'vérification terrain recommandée')
    .replace(/active users above/gi, 'utilisateurs actifs au-dessus de')
    .replace(/RRC users above/gi, 'utilisateurs RRC au-dessus de')
    .replace(/;\s*/g, ' ; ')
}

function tierLabel(tier) {
  return {
    long_terme: 'long terme',
    moyen_terme: 'moyen terme',
    court_terme: 'court terme',
    standard: 'standard',
  }[String(tier || '').toLowerCase()] || tier || 'standard'
}

export default function RecommendationCard({ recommendation, onSimulate, simulationReady = true, unavailableReason = '', showActionButton = true }) {
  const action = recommendation?.sim_action || recommendation?.simAction || recommendation?.action
  const canSimulate = Boolean(recommendation?.isSimulatable ?? action)
  const actionLabel = ACTION_LABELS_FR[action] || action
  return (
    <div className="recommendation-card">
      <div><strong>{recommendation?.title || recommendation?.action || 'Action à tester'}</strong><span>Priorité {tierLabel(recommendation?.tier)}</span></div>
      <p>{readableReason(recommendation?.reason)}</p>
      <div className="reco-metrics-inline"><span>Priorité {tierLabel(recommendation?.tier || 'aucune')}</span><span>Récupération {recommendation?.recoveryRate || 0}%</span><span>Gain {recommendation?.gainUe || 0} UE / {recommendation?.gainGb || 0} GB</span></div>
      {showActionButton && canSimulate && action ? (
        <button disabled={!simulationReady} title={!simulationReady ? unavailableReason : ''} onClick={() => onSimulate(action)}>
          Simuler : {actionLabel}
        </button>
      ) : !canSimulate || !action ? <em className="advisory-note">Conseil uniquement, pas d&apos;action simulateur disponible.</em> : null}
    </div>
  )
}
