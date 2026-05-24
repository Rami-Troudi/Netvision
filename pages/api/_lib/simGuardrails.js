const fs = require('fs')
const path = require('path')

const NEIGHBOR_ACTIONS = new Set(['redistribute', 'neighbor_optimization'])
const ACTIONS_REQUIRING_SLICE = new Set(['tilt', 'redistribute', 'neighbor_optimization', 'add_carrier', 'add_sector'])

function num(v, d = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

function loadJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return fallback
  }
}

function canSimulate({ runtimeRoot, payload, observation = null, hasTimeFile = true }) {
  const reasons = []
  const warnings = []
  const cell = String(payload?.cell_name || '').trim()
  const action = String(payload?.action || '').trim()
  if (!cell) reasons.push('Cellule manquante.')
  if (!action) reasons.push('Action manquante.')

  const baseline = loadJson(path.resolve(runtimeRoot, 'baseline.json'), {})
  const entry = baseline?.[cell]
  if (!entry) reasons.push('Cellule absente du baseline runtime.')
  const observed = observation || {}
  if (entry) {
    const prb = num(observed.prb_load ?? observed.load ?? entry.prb_load, 0)
    if (prb < 0 || prb > 100) reasons.push('PRB hors plage valide [0..100].')
  }
  if (ACTIONS_REQUIRING_SLICE.has(action) && !hasTimeFile) {
    reasons.push('Tranche temporelle invalide ou absente pour cette simulation.')
  }

  if (NEIGHBOR_ACTIONS.has(action)) {
    const neighborGraph = loadJson(path.resolve(runtimeRoot, 'neighbor_graph.json'), {})
    const neighbors = neighborGraph?.[cell]?.candidate_offload || neighborGraph?.[cell]?.nearest || []
    if (!Array.isArray(neighbors) || neighbors.length < 1) reasons.push('Voisins insuffisants pour cette action.')
  }

  if (action === 'add_sector' && entry?.site_name == null) reasons.push('Contexte site requis pour ajouter un secteur.')
  if (action === 'tilt') {
    const degrees = num(payload?.params?.degrees, 2)
    if (degrees < -10 || degrees > 10) reasons.push('Angle tilt invalide [-10..10].')
    if (entry?.antenna_height_m == null) warnings.push('Hauteur antenne absente, precision reduite.')
  }
  if (action === 'redistribute') {
    const ratio = num(payload?.params?.ratio, 0.15)
    if (ratio < 0.05 || ratio > 0.5) reasons.push('Ratio de redistribution invalide [0.05..0.5].')
  }
  return { ok: reasons.length === 0, warnings, blocked_reasons: reasons }
}

function validatePlausibility({ action, before, after }) {
  const reasons = []
  const throughputGain = num(after?.throughput, 0) - num(before?.throughput, 0)
  const prbDelta = num(before?.prb_load, 0) - num(after?.prb_load, 0)
  if (Math.abs(throughputGain) > 80) reasons.push('Delta debit improbable > 80 Mbps.')
  if (Math.abs(prbDelta) > 70) reasons.push('Delta PRB improbable > 70 points.')
  if (action === 'add_carrier' && throughputGain < 0) reasons.push('Add carrier ne devrait pas degrader le debit.')
  if (action === 'add_sector' && prbDelta < 0) reasons.push('Add sector ne devrait pas augmenter la pression PRB.')
  return {
    valid: reasons.length === 0,
    score: Math.max(0, 100 - reasons.length * 25),
    reasons,
    validator_version: 'netvision-sim-credibility-v1',
  }
}

module.exports = {
  canSimulate,
  validatePlausibility,
}
