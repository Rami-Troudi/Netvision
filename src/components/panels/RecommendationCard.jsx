import { ACTION_LABELS_FR } from '../../utils/uiPolicy.mjs'

export default function RecommendationCard({ recommendation, onSimulate, simulationReady = true, unavailableReason = '' }) {
  const action = recommendation?.sim_action || recommendation?.simAction || recommendation?.action
  const canSimulate = Boolean(recommendation?.isSimulatable ?? action)
  const actionLabel = ACTION_LABELS_FR[action] || action
  return (
    <div className="recommendation-card">
      <div><strong>{recommendation?.title || recommendation?.action || 'Action proposée'}</strong><span>Priorité {recommendation?.tier || 'standard'}</span></div>
      <p>{recommendation?.reason || 'Preuve KPI insuffisante pour détailler la cause.'}</p>
      <div className="reco-metrics-inline"><span>Priorité {recommendation?.tier || 'aucune'}</span><span>Récupération {recommendation?.recoveryRate || 0}%</span><span>Gain {recommendation?.gainUe || 0} UE / {recommendation?.gainGb || 0} GB</span></div>
      {canSimulate && action ? (
        <button disabled={!simulationReady} title={!simulationReady ? unavailableReason : ''} onClick={() => onSimulate(action)}>
          Simuler : {actionLabel}
        </button>
      ) : <em className="advisory-note">Conseil uniquement, pas d&apos;action simulateur disponible.</em>}
    </div>
  )
}
