export default function RecommendationCard({ recommendation, onSimulate }) {
  const action = recommendation?.sim_action || recommendation?.simAction || recommendation?.action
  return (
    <div className="recommendation-card">
      <div><strong>{recommendation?.title || recommendation?.action || 'Recommendation'}</strong><span>{recommendation?.confidence || 'medium'} confidence</span></div>
      <p>{recommendation?.reason || 'Backend did not provide detailed evidence.'}</p>
      {action ? <button onClick={() => onSimulate(action)}>Simulate {action}</button> : null}
    </div>
  )
}
