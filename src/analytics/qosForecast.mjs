import path from 'path'
import { readFile } from 'fs/promises'

import { buildInsightNarrative } from './qosInsightNarratives.mjs'

export const FORECAST_MODEL_VERSION = 'netvision-qos-forecast-rules-v1'
export const VALID_RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical'])
export const VALID_CONFIDENCE = new Set(['low', 'medium', 'high'])
const KPI_FIELDS = ['prb_load', 'throughput', 'cqi', 'active_users']

function n(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function round(value, digits = 2) {
  const factor = 10 ** digits
  return Math.round((Number(value) || 0) * factor) / factor
}

function parseTimestamp(timestamp = '') {
  const match = String(timestamp).match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})$/)
  if (!match) return null
  const [, dd, mm, yyyy, hh, min] = match
  return new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min), 0))
}

function formatTimestamp(date) {
  return `${String(date.getUTCDate()).padStart(2, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${date.getUTCFullYear()} ${String(date.getUTCHours()).padStart(2, '0')}:00`
}

function normalizeObservation(obs = {}) {
  const throughputRaw = obs.throughput_mbps ?? obs.throughput ?? obs.throughput_kbps
  const throughput = n(throughputRaw, 0) > 1000 ? n(throughputRaw, 0) / 1000 : n(throughputRaw, 0)
  return {
    prb_load: n(obs.prb_load ?? obs.load ?? obs.prb, 0),
    throughput,
    cqi: n(obs.cqi, 0),
    active_users: n(obs.active_users ?? obs.rrc_users ?? obs.users, 0),
    rrc_users: n(obs.rrc_users, 0),
    traffic: n(obs.traffic, 0),
    ta: n(obs.ta, 0),
  }
}

function slope(values = []) {
  const clean = values.filter((value) => Number.isFinite(value))
  if (clean.length < 2) return 0
  const first = clean[0]
  const last = clean[clean.length - 1]
  return (last - first) / (clean.length - 1)
}

function avg(values = []) {
  const clean = values.filter((value) => Number.isFinite(value))
  if (!clean.length) return 0
  return clean.reduce((sum, value) => sum + value, 0) / clean.length
}

function riskLevel(score) {
  if (score >= 80) return 'critical'
  if (score >= 60) return 'high'
  if (score >= 35) return 'medium'
  return 'low'
}

function scopeMatches(meta = {}, scope = {}) {
  const level = scope.scope_level || scope.level || 'national'
  if (level === 'cell') return !scope.cell_name || meta.cell_name === scope.cell_name
  if (level === 'site') return !scope.site_name || meta.site_name === scope.site_name
  if (level === 'delegation') return !scope.deleg_id || meta.deleg_id === scope.deleg_id
  if (level === 'governorate') return !scope.gov_id || meta.gov_id === scope.gov_id
  return true
}

function confidenceFor({ availableSliceCount, missingKpiRatio, evidenceCount, conflictCount }) {
  let score = 25
  if (availableSliceCount >= 4) score += 25
  if (availableSliceCount >= 8) score += 15
  if (missingKpiRatio <= 0.15) score += 20
  if (evidenceCount >= 2) score += 15
  score -= conflictCount * 15
  if (availableSliceCount < 3) score = Math.min(score, 45)
  score = clamp(score, 0, 100)
  let confidence = 'low'
  if (score >= 75 && availableSliceCount >= 8 && missingKpiRatio <= 0.15 && conflictCount === 0) confidence = 'high'
  else if (score >= 55 && availableSliceCount >= 4 && missingKpiRatio <= 0.35) confidence = 'medium'
  return { confidence, confidence_score: Math.round(score) }
}

function buildCellForecast({ cellName, baselineEntry = {}, slices = [], horizon = 1, generatedAt, targetTimestamp }) {
  const history = slices
    .map((slice) => ({ timestamp: slice.timestamp, obs: slice.observations?.[cellName] }))
    .filter((item) => item.obs)
    .map((item) => ({ timestamp: item.timestamp, kpis: normalizeObservation(item.obs) }))

  const current = history.at(-1)?.kpis || normalizeObservation({})
  const recent = history.slice(-Math.max(4, Math.min(8, history.length)))
  const missingTotal = Math.max(1, history.length * KPI_FIELDS.length)
  const missingCount = history.reduce((count, item) => count + KPI_FIELDS.filter((field) => !Number.isFinite(item.kpis[field]) || item.kpis[field] <= 0).length, 0)
  const missingKpiRatio = missingCount / missingTotal
  const prbs = recent.map((item) => item.kpis.prb_load)
  const thps = recent.map((item) => item.kpis.throughput)
  const cqis = recent.map((item) => item.kpis.cqi)
  const users = recent.map((item) => item.kpis.active_users)
  const congestionCount = history.filter((item) => item.kpis.prb_load >= 80 && (item.kpis.throughput < 18 || item.kpis.cqi < 8)).length
  const congestionRecurrence = history.length ? congestionCount / history.length : 0

  const features = {
    recent_prb_avg: round(avg(prbs)),
    recent_prb_slope: round(slope(prbs)),
    recent_throughput_avg: round(avg(thps)),
    recent_throughput_slope: round(slope(thps)),
    recent_cqi_avg: round(avg(cqis)),
    recent_cqi_slope: round(slope(cqis)),
    recent_active_users_avg: round(avg(users)),
    recent_active_users_slope: round(slope(users)),
    congestion_recurrence_ratio: round(congestionRecurrence, 3),
    missing_kpi_ratio: round(missingKpiRatio, 3),
    available_slice_count: history.length,
    hour_of_day: parseTimestamp(history.at(-1)?.timestamp || '')?.getUTCHours() ?? 0,
    busy_hour_flag: congestionRecurrence >= 0.25,
  }

  const evidence = []
  const warnings = []
  let score = 0
  let predictedIssue = 'Risque faible'
  let conflictCount = 0

  if (history.length < 3) {
    score = 30
    predictedIssue = 'Données insuffisantes'
    warnings.push('historique KPI insuffisant pour une prévision fiable.')
  }

  if (features.recent_prb_avg >= 75) {
    score += 22
    evidence.push(`PRB moyen récent élevé (${features.recent_prb_avg}%).`)
  }
  if (features.recent_prb_slope >= 2) {
    score += 16
    evidence.push(`PRB en hausse (${features.recent_prb_slope} pts/tranche).`)
  }
  if (features.recent_throughput_slope <= -1) {
    score += 18
    evidence.push(`Débit en baisse (${features.recent_throughput_slope} Mbps/tranche).`)
  }
  if (features.recent_cqi_slope <= -0.25 || features.recent_cqi_avg < 8) {
    score += 18
    evidence.push(`CQI orienté défavorablement (moyenne ${features.recent_cqi_avg}).`)
  }
  if (features.recent_active_users_slope >= 5) {
    score += 12
    evidence.push(`Utilisateurs actifs en hausse (${features.recent_active_users_slope}/tranche).`)
  }
  if (features.congestion_recurrence_ratio >= 0.25) {
    score += 16
    evidence.push(`Congestion récurrente sur ${(features.congestion_recurrence_ratio * 100).toFixed(0)}% des tranches disponibles.`)
  }

  if (features.recent_prb_avg >= 70 && features.recent_throughput_slope < 0 && features.recent_cqi_avg >= 8.5) {
    predictedIssue = 'Risque de congestion capacitaire'
  }
  if (features.recent_prb_avg >= 65 && features.recent_throughput_slope < 0 && (features.recent_cqi_slope < 0 || features.recent_cqi_avg < 8.5)) {
    predictedIssue = 'Risque de qualité radio dégradée'
  }
  if (features.busy_hour_flag && score >= 50) {
    predictedIssue = 'Risque de surcharge en heure critique'
  }
  if (history.length < 3) {
    predictedIssue = 'Données insuffisantes'
  }
  if (features.recent_prb_avg >= 80 && features.recent_throughput_slope >= 0 && features.recent_cqi_avg >= 10) {
    conflictCount += 1
    warnings.push('Charge élevée mais débit/CQI encore cohérents : signal à confirmer.')
  }
  if (missingKpiRatio > 0.35) warnings.push('KPI incomplets sur plusieurs tranches.')

  const riskScore = Math.round(clamp(score, 0, 100))
  const confidence = confidenceFor({
    availableSliceCount: history.length,
    missingKpiRatio,
    evidenceCount: evidence.length,
    conflictCount,
  })
  const admin = baselineEntry.admin || {}
  const row = {
    cell_name: cellName,
    site_name: baselineEntry.site_name || baselineEntry.enodeb_name || '',
    gov_id: admin.gov_id || '',
    gov_name: admin.gov_name || '',
    deleg_id: admin.deleg_id || '',
    deleg_name: admin.deleg_name || '',
    risk_score: riskScore,
    risk_level: riskLevel(riskScore),
    predicted_issue: predictedIssue,
    horizon,
    confidence: confidence.confidence,
    confidence_score: confidence.confidence_score,
    evidence: evidence.length ? evidence : ['Aucun signal multi-KPI fort sur les dernières tranches.'],
    current_kpis: current,
    trend_features: features,
    predicted_at: generatedAt,
    target_timestamp: targetTimestamp,
    warnings,
  }
  return { ...row, insight: buildInsightNarrative(row) }
}

function summarize(rows = [], totalCells = 0) {
  const predicted = rows.filter((row) => row.risk_level !== 'low')
  const highRisk = rows.filter((row) => row.risk_level === 'high' || row.risk_level === 'critical')
  const critical = rows.filter((row) => row.risk_level === 'critical')
  const avgRisk = rows.length ? rows.reduce((sum, row) => sum + row.risk_score, 0) / rows.length : 0
  const confScores = rows.map((row) => row.confidence_score).filter(Number.isFinite)
  const avgConf = confScores.length ? avg(confScores) : 0
  return {
    total_cells: totalCells,
    predicted_cells: predicted.length,
    high_risk_cells: highRisk.length,
    critical_risk_cells: critical.length,
    average_risk_score: round(avgRisk),
    confidence: avgConf >= 75 ? 'high' : avgConf >= 55 ? 'medium' : 'low',
  }
}

export function buildForecastForRuntime(runtime, options = {}) {
  const horizon = Number(options.horizon ?? 1)
  if (![1, 3].includes(horizon)) throw new Error('horizon must be 1 or 3')

  const baseline = runtime.baseline || {}
  const slices = Array.isArray(runtime.timeSlices) ? runtime.timeSlices : []
  const generatedAt = options.generatedAt || new Date().toISOString()
  const lastDate = parseTimestamp(slices.at(-1)?.timestamp || '')
  const targetTimestamp = lastDate ? formatTimestamp(new Date(lastDate.getTime() + horizon * 3600_000)) : ''
  const scope = options.scope || {}
  const includeLow = options.includeLow === true
  const minRisk = clamp(n(options.minRisk, 0), 0, 100)
  const limit = Math.max(1, Math.min(500, Number.parseInt(String(options.limit ?? 50), 10) || 50))
  const warnings = []

  if (slices.length < 3) warnings.push('Données temporelles insuffisantes pour produire une prévision fiable.')

  const rows = Object.entries(baseline)
    .map(([cellName, entry]) => buildCellForecast({ cellName, baselineEntry: entry, slices, horizon, generatedAt, targetTimestamp }))
    .filter((row) => scopeMatches(row, scope))
    .filter((row) => row.risk_score >= minRisk)
    .filter((row) => includeLow || row.risk_level !== 'low' || row.predicted_issue === 'Données insuffisantes')
    .sort((a, b) => b.risk_score - a.risk_score || a.cell_name.localeCompare(b.cell_name))
    .slice(0, limit)

  return {
    ok: true,
    generated_at: generatedAt,
    data_mode: runtime.mode || 'real',
    horizon,
    model_version: FORECAST_MODEL_VERSION,
    scope,
    rows,
    summary: summarize(rows, Object.keys(baseline).length),
    warnings,
  }
}

export async function loadRuntimeForForecast(root, mode = 'real', maxSlices = 24) {
  const [baselineRaw, indexRaw] = await Promise.all([
    readFile(path.resolve(root, 'baseline.json'), 'utf8'),
    readFile(path.resolve(root, 'time_index.json'), 'utf8'),
  ])
  const baseline = JSON.parse(baselineRaw)
  const timeIndex = JSON.parse(indexRaw)
  const timestamps = Array.isArray(timeIndex?.timestamps) ? timeIndex.timestamps : []
  const recentEntries = timestamps.slice(Math.max(0, timestamps.length - maxSlices))
  const timeSlices = []
  const warnings = []
  for (const entry of recentEntries) {
    const filename = String(entry?.filename || '')
    if (!filename.endsWith('.json')) {
      warnings.push(`Tranche ignorée (format non JSON): ${filename}`)
      continue
    }
    try {
      const raw = await readFile(path.resolve(root, 'time_data', filename), 'utf8')
      const parsed = JSON.parse(raw)
      timeSlices.push({ timestamp: entry.timestamp, observations: parsed?.observations || {} })
    } catch {
      warnings.push(`Tranche indisponible: ${filename}`)
    }
  }
  return { root, mode, baseline, timeIndex, timeSlices, warnings }
}

export function validateForecastArtifact(artifact = {}) {
  const errors = []
  if (artifact.model_version !== FORECAST_MODEL_VERSION) errors.push('model_version invalide')
  if (![1, 3].includes(Number(artifact.horizon))) errors.push('horizon invalide')
  if (!Array.isArray(artifact.rows)) errors.push('rows doit être un tableau')
  for (const [idx, row] of (artifact.rows || []).entries()) {
    if (!row.cell_name) errors.push(`rows[${idx}].cell_name manquant`)
    if (!Number.isFinite(Number(row.risk_score)) || row.risk_score < 0 || row.risk_score > 100) errors.push(`rows[${idx}].risk_score hors plage`)
    if (!VALID_RISK_LEVELS.has(row.risk_level)) errors.push(`rows[${idx}].risk_level invalide`)
    if (!VALID_CONFIDENCE.has(row.confidence)) errors.push(`rows[${idx}].confidence invalide`)
    if (row.confidence === 'high' && Number(row.trend_features?.available_slice_count || 0) < 8) errors.push(`rows[${idx}].confidence trop élevée pour l'historique`)
    if (!Array.isArray(row.evidence)) errors.push(`rows[${idx}].evidence invalide`)
  }
  return { ok: errors.length === 0, errors }
}
