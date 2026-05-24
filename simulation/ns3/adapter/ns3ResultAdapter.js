const RECOVERY_RATE_PRIORS = Object.freeze({
  tilt: 15,
  redistribute: 40,
  neighbor_optimization: 35,
  add_carrier: 50,
  add_sector: 85,
})
const CALIBRATION_PROFILES = Object.freeze({
  default: { quality: 'low', throughput_factor: 1, prb_factor: 1, cqi_factor: 1 },
  operations_v2_calibrated: { quality: 'medium', throughput_factor: 0.96, prb_factor: 1.03, cqi_factor: 0.98 },
})

function num(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizeKpi(raw = {}, observed = {}) {
  const throughput = num(raw.avg_throughput_mbps ?? raw.throughput_mbps ?? raw.throughput ?? observed.throughput_mbps, 0)
  const prbLoad = num(raw.estimated_prb_load ?? raw.prb_load ?? raw.load ?? observed.prb_load, 0)
  const cqi = num(raw.avg_cqi ?? raw.cqi ?? observed.cqi, 0)
  const servedUsers = num(raw.served_users ?? raw.active_users ?? observed.active_users, 0)
  return {
    prb_load: round(prbLoad, 2),
    load: round(prbLoad, 2),
    throughput: round(throughput, 2),
    throughput_mbps: round(throughput, 2),
    cqi: round(cqi, 2),
    active_users: Math.round(servedUsers),
    served_users: Math.round(servedUsers),
    congested: Boolean(raw.congested ?? prbLoad >= 85),
    qos_score: Math.max(0, Math.min(100, Math.round(raw.qos_score ?? 100 - Math.max(0, prbLoad - 50) * 1.4))),
  }
}

function adaptNs3Result({ scenario = {}, metrics = {}, artifacts = {} }) {
  const action = scenario?.action?.type || scenario?.action || 'unknown'
  const observed = scenario?.observed_kpis || {}
  const before = normalizeKpi(metrics.before, observed)
  const after = normalizeKpi(metrics.after, observed)
  const throughputGainPct = before.throughput > 0
    ? ((after.throughput - before.throughput) / before.throughput) * 100
    : 0
  const prbReduction = before.prb_load - after.prb_load
  const cqiDelta = after.cqi - before.cqi
  const usersDelta = after.active_users - before.active_users
  const confidenceReport = computeConfidence({ scenario, metrics })

  const profile = resolveCalibrationProfile(scenario, action)
  const calibrated = applyCalibration(after, profile)
  const credibility = require('../../../pages/api/_lib/simGuardrails.js').validatePlausibility({ action, before, after: calibrated })
  return {
    job_id: scenario.job_id,
    engine: 'ns3',
    status: 'done',
    fidelity_level: scenario.fidelity_level || 'operations_v1',
    target_cell: scenario?.scenario?.target_cell || scenario.target_cell,
    action,
    before,
    after: calibrated,
    impact: {
      throughput_gain_pct: round(throughputGainPct, 1),
      prb_reduction_points: round(prbReduction, 2),
      cqi_delta: round(cqiDelta, 2),
      additional_served_users: Math.round(usersDelta),
      congestion_resolved: Boolean(before.congested && !after.congested),
      affected_neighbors: Array.isArray(metrics.affected_neighbors) ? metrics.affected_neighbors : [],
    },
    recovery_rate: RECOVERY_RATE_PRIORS[action] ?? 0,
    recommendation: recommendationForAction(action),
    confidence: confidenceReport.level,
    confidence_pct: confidenceReport.score,
    confidence_explain: confidenceReport.reasons,
    feasibility: scenario?.feasibility || { ok: true, warnings: [], blocked_reasons: [] },
    credibility,
    calibration: {
      profile: profile.key,
      quality: profile.quality,
      confidence: confidenceReport.level,
      baseline_error: {
        throughput_mape: metrics?.calibration?.throughput_mape ?? null,
        cqi_error: metrics?.calibration?.cqi_error ?? null,
        load_error: metrics?.calibration?.load_error ?? null,
      },
    },
    scenario_assumptions: scenarioAssumptions(action, scenario),
    artifacts,
    runtime_seconds: num(metrics.runtime_seconds, 0),
  }
}

function resolveCalibrationProfile(scenario, action) {
  const requestedFidelity = String(scenario?.fidelity_level || 'operations_v1')
  const requestedProfile = scenario?.calibration?.profile || (requestedFidelity === 'operations_v2_calibrated' ? 'operations_v2_calibrated' : 'default')
  const runtimeProfiles = scenario?.calibration?.profiles && typeof scenario.calibration.profiles === 'object'
    ? scenario.calibration.profiles
    : {}
  const key = requestedFidelity === 'operations_v2_calibrated'
    ? requestedProfile
    : requestedProfile
  const profile = runtimeProfiles[key] || runtimeProfiles[`${key}:${action}`] || CALIBRATION_PROFILES[key] || deriveCalibrationProfile(scenario, action)
  return { key, ...profile, action }
}

function deriveCalibrationProfile(scenario, action) {
  if (String(scenario?.fidelity_level || '') !== 'operations_v2_calibrated') return CALIBRATION_PROFILES.default
  const target = scenario?.topology?.target || {}
  const prb = num(scenario?.observed_kpis?.prb_load, target.prb_load || 0)
  const quality = prb >= 85 ? 'medium' : 'low'
  const actionFactor = action === 'add_sector' ? 0.98 : action === 'add_carrier' ? 0.97 : 0.96
  return {
    quality,
    throughput_factor: actionFactor,
    prb_factor: prb >= 85 ? 1.02 : 1.01,
    cqi_factor: 0.98,
  }
}

function applyCalibration(after, profile) {
  return {
    ...after,
    throughput: round(after.throughput * (profile.throughput_factor || 1), 2),
    throughput_mbps: round(after.throughput_mbps * (profile.throughput_factor || 1), 2),
    prb_load: round(after.prb_load * (profile.prb_factor || 1), 2),
    cqi: round(after.cqi * (profile.cqi_factor || 1), 2),
  }
}

function recommendationForAction(action) {
  if (action === 'add_carrier') return 'Ajouter une porteuse pour augmenter la capacite radio disponible.'
  if (action === 'add_sector') return 'Ajouter un secteur pour separer la charge geographique de la cellule.'
  if (action === 'redistribute') return 'Reequilibrer une partie des utilisateurs vers les voisins avec marge PRB.'
  if (action === 'neighbor_optimization') return 'Optimiser les voisins par biais de rattachement et relief interferences.'
  if (action === 'tilt') return 'Ajuster l inclinaison et la puissance avec prudence faute de metadonnees antennaires completes.'
  return 'Simulation ns-3 adaptee au contrat NetVision.'
}

function scenarioAssumptions(action, scenario) {
  const assumptions = [
    'Les UEs sont synthetiques et distribues autour du secteur selectionne.',
    'La demande trafic est inferee depuis les utilisateurs actifs, le debit observe et la charge PRB.',
    'Le scenario ns-3 reste local: cellule cible, secteurs du meme site et voisins proches.',
  ]
  if (action === 'tilt') assumptions.push('Le tilt est approximatif sans hauteur, tilt reel et patron antennaire operateur.')
  if (action === 'neighbor_optimization') assumptions.push('L optimisation voisins est un modele politique approximatif de bias/rattachement.')
  if (!scenario?.topology?.neighbor_graph_source || scenario.topology.neighbor_graph_source === 'inferred') {
    assumptions.push('Les relations voisines sont derivees par geometrie et doivent etre calibrees avec les donnees operateur.')
  }
  return assumptions
}

function round(value, digits = 2) {
  const factor = 10 ** digits
  return Math.round(num(value, 0) * factor) / factor
}

function computeConfidence({ scenario = {}, metrics = {} }) {
  const reasons = []
  let score = 100

  const throughputMape = num(metrics?.calibration?.throughput_mape, 1)
  const cqiError = num(metrics?.calibration?.cqi_error, 5)
  const loadError = num(metrics?.calibration?.load_error, 1)

  score -= Math.min(35, throughputMape * 100 * 0.6)
  score -= Math.min(20, cqiError * 4)
  score -= Math.min(20, loadError * 100 * 0.4)

  if (!Array.isArray(scenario?.topology?.neighbors) || scenario.topology.neighbors.length < 2) {
    score -= 12
    reasons.push('Peu de voisins exploitables dans le scenario local.')
  }
  if (scenario?.topology?.neighbor_graph_source === 'inferred') {
    score -= 10
    reasons.push('Relations voisines inferrees geometriquement (non validees operateur).')
  }
  if (scenario?.action?.type === 'tilt') {
    score -= 8
    reasons.push('Modele tilt approximatif sans metadonnees antennaires completes.')
  }
  if (scenario?.action?.type === 'neighbor_optimization') {
    score -= 6
    reasons.push('Optimisation voisins basee sur un modele politique approxime.')
  }
  if ((scenario?.guardrails?.warnings || []).length) {
    score -= Math.min(10, scenario.guardrails.warnings.length * 3)
    reasons.push('Certaines guardrails scenario sont en mode avertissement.')
  }

  const normalized = Math.max(0, Math.min(99, Math.round(score)))
  if (normalized >= 75) return { level: 'high', score: normalized, reasons }
  if (normalized >= 50) return { level: 'medium', score: normalized, reasons }
  return { level: 'low', score: normalized, reasons }
}

module.exports = {
  RECOVERY_RATE_PRIORS,
  adaptNs3Result,
}
