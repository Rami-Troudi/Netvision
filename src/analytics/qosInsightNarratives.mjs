export function confidenceLabelFr(confidence = 'low') {
  return {
    low: 'faible',
    medium: 'moyenne',
    high: 'élevée',
  }[confidence] || 'faible'
}

export function buildInsightNarrative(row = {}) {
  const issue = String(row.predicted_issue || 'Risque faible')
  const confidence = confidenceLabelFr(row.confidence)
  const evidence = Array.isArray(row.evidence) ? row.evidence : []
  const warnings = Array.isArray(row.warnings) ? row.warnings : []
  const trend = row.trend_features || {}
  const prbSlope = Number(trend.recent_prb_slope) || 0
  const thpSlope = Number(trend.recent_throughput_slope) || 0
  const cqiSlope = Number(trend.recent_cqi_slope) || 0

  let why = 'Les KPI disponibles ne montrent pas de signal convergent fort sur le prochain horizon.'
  if (issue.includes('congestion capacitaire')) {
    why = 'La charge PRB augmente alors que le débit utilisateur diminue, ce qui suggère une pression capacitaire.'
  } else if (issue.includes('qualité radio')) {
    why = 'Le débit et le CQI se dégradent ensemble, ce qui oriente vers une cause radio, interférence ou couverture.'
  } else if (issue.includes('heure critique')) {
    why = 'La cellule présente une pression récurrente autour des mêmes tranches horaires.'
  } else if (issue.includes('Données insuffisantes')) {
    why = 'L’historique disponible est trop court ou incomplet pour isoler une tendance fiable.'
  }

  const recommended = [
    'Vérifier l’évolution PRB/débit sur les dernières tranches.',
    'Contrôler le CQI pour distinguer capacité et qualité radio.',
  ]
  if (prbSlope > 0 && thpSlope < 0) recommended.push('Comparer la cellule avec les voisins ayant de la marge PRB.')
  if (cqiSlope < 0) recommended.push('Inspecter les indicateurs couverture/interférence autour du secteur.')

  return {
    summary: `Cette cellule présente un ${issue.toLowerCase()} sur le prochain horizon.`,
    why_it_matters: why,
    recommended_inspection: recommended,
    next_steps: [
      'Ouvrir Qualité radio.',
      'Vérifier les voisins.',
      'Lancer une simulation seulement si les préconditions sont satisfaites.',
    ],
    cautions: [
      'Prévision indicative basée sur les données disponibles.',
      confidence === 'faible' ? 'Confiance limitée si les KPI sont incomplets.' : `Confiance ${confidence} selon l’historique disponible.`,
      ...warnings,
    ],
    evidence,
  }
}
