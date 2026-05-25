import path from 'path'
import { readFile } from 'fs/promises'

import { buildInsightNarrative } from './qosInsightNarratives.mjs'
import { QOS_THRESHOLDS, riskLevelFromScore } from './qosThresholds.mjs'

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

export function parseTimestamp(timestamp = '') {
  const text = String(timestamp || '').trim()
  if (!text) return null
  const custom = text.match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})$/)
  if (custom) {
    const [, dd, mm, yyyy, hh, min] = custom
    return new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min), 0))
  }
  const iso = Date.parse(text)
  if (Number.isFinite(iso)) return new Date(iso)
  return null
}

function formatTimestamp(date) {
  return `${String(date.getUTCDate()).padStart(2, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${date.getUTCFullYear()} ${String(date.getUTCHours()).padStart(2, '0')}:00`
}

function normalizeThroughput(obs = {}) {
  if (obs.throughput_mbps !== undefined && obs.throughput_mbps !== null && obs.throughput_mbps !== '') return n(obs.throughput_mbps, 0)
  if (obs.throughput_kbps !== undefined && obs.throughput_kbps !== null && obs.throughput_kbps !== '') return n(obs.throughput_kbps, 0) / 1000
  if (obs.throughput !== undefined && obs.throughput !== null && obs.throughput !== '') {
    const raw = n(obs.throughput, 0)
    return raw > 1000 ? raw / 1000 : raw
  }
  return 0
}

function normalizeObservation(obs = {}) {
  return {
    prb_load: n(obs.prb_load ?? obs.load ?? obs.prb, 0),
    throughput: normalizeThroughput(obs),
    cqi: n(obs.cqi, 0),
    active_users: n(obs.active_users ?? obs.rrc_users ?? obs.users, 0),
    rrc_users: n(obs.rrc_users, 0),
    traffic: n(obs.traffic, 0),
    ta: n(obs.ta, 0),
  }
}

function isMissing(value) {
  if (value === null || value === undefined) return true
  if (typeof value === 'string' && value.trim() === '') return true
  if (typeof value === 'number' && !Number.isFinite(value)) return true
  return false
}

function extractField(obs = {}, field) {
  if (field === 'prb_load') return obs.prb_load ?? obs.load ?? obs.prb
  if (field === 'throughput') {
    if (obs.throughput_mbps !== undefined) return obs.throughput_mbps
    if (obs.throughput_kbps !== undefined) return obs.throughput_kbps
    return obs.throughput
  }
  if (field === 'cqi') return obs.cqi
  if (field === 'active_users') return obs.active_users ?? obs.rrc_users ?? obs.users
  return undefined
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

function scopeMatches(meta = {}, scope = {}) {
  const level = scope.scope_level || scope.level || 'national'
  if (level === 'cell') return !scope.cell_name || meta.cell_name === scope.cell_name
  if (level === 'site') return !scope.site_name || meta.site_name === scope.site_name
  if (level === 'delegation') return !scope.deleg_id || meta.deleg_id === scope.deleg_id
  if (level === 'governorate') return !scope.gov_id || meta.gov_id === scope.gov_id
  return true
}

function confidenceFor({ availableSliceCount, missingKpiRatio, evidenceCount, conflictCount }) {
  const cfg = QOS_THRESHOLDS.confidence
  let score = 25
  if (availableSliceCount >= cfg.min_slices_medium) score += 25
  if (availableSliceCount >= cfg.min_slices_high) score += 15
  if (missingKpiRatio <= cfg.missing_ratio_high_max) score += 20
  if (evidenceCount >= 2) score += 15
  score -= conflictCount * 15
  if (availableSliceCount < 3) score = Math.min(score, 45)
  score = clamp(score, 0, 100)
  let confidence = 'low'
  if (score >= cfg.high_min_score && availableSliceCount >= cfg.min_slices_high && missingKpiRatio <= cfg.missing_ratio_high_max && conflictCount === 0) confidence = 'high'
  else if (score >= cfg.medium_min_score && availableSliceCount >= cfg.min_slices_medium && missingKpiRatio <= cfg.missing_ratio_medium_max) confidence = 'medium'
  return { confidence, confidence_score: Math.round(score) }
}

function buildCellForecast({ cellName, baselineEntry = {}, slices = [], horizon = 1, generatedAt, targetTimestamp }) {
  const history = slices
    .map((slice) => ({ timestamp: slice.timestamp, obs: slice.observations?.[cellName] }))
    .filter((item) => item.obs)
    .map((item) => ({ timestamp: item.timestamp, raw: item.obs, kpis: normalizeObservation(item.obs) }))

  const current = history.at(-1)?.kpis || normalizeObservation({})
  const recent = history.slice(-Math.max(4, Math.min(8, history.length)))
  const missingTotal = Math.max(1, history.length * KPI_FIELDS.length)
  const missingCount = history.reduce((count, item) => count + KPI_FIELDS.filter((field) => isMissing(extractField(item.raw, field))).length, 0)
  const missingKpiRatio = missingCount / missingTotal
  const prbs = recent.map((item) => item.kpis.prb_load)
  const thps = recent.map((item) => item.kpis.throughput)
  const cqis = recent.map((item) => item.kpis.cqi)
  const users = recent.map((item) => item.kpis.active_users)
  const congestionCount = history.filter((item) => item.kpis.prb_load >= QOS_THRESHOLDS.prb_high && (item.kpis.throughput < QOS_THRESHOLDS.throughput_low_mbps || item.kpis.cqi < QOS_THRESHOLDS.cqi_low)).length
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
    busy_hour_flag: congestionRecurrence >= QOS_THRESHOLDS.recurrence_ratio_high,
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

  if (features.recent_prb_avg >= QOS_THRESHOLDS.prb_high) {
    score += 22
    evidence.push(`PRB moyen récent élevé (${features.recent_prb_avg}%).`)
  }
  if (features.recent_prb_slope >= QOS_THRESHOLDS.prb_risk_slope) {
    score += 16
    evidence.push(`PRB en hausse (${features.recent_prb_slope} pts/tranche).`)
  }
  if (features.recent_throughput_slope <= QOS_THRESHOLDS.throughput_drop_slope_mbps) {
    score += 18
    evidence.push(`Débit en baisse (${features.recent_throughput_slope} Mbps/tranche).`)
  }
  if (features.recent_cqi_slope <= QOS_THRESHOLDS.cqi_drop_slope || features.recent_cqi_avg < QOS_THRESHOLDS.cqi_low) {
    score += 18
    evidence.push(`CQI orienté défavorablement (moyenne ${features.recent_cqi_avg}).`)
  }
  if (features.recent_active_users_slope >= QOS_THRESHOLDS.active_users_rise_slope) {
    score += 12
    evidence.push(`Utilisateurs actifs en hausse (${features.recent_active_users_slope}/tranche).`)
  }
  if (features.congestion_recurrence_ratio >= QOS_THRESHOLDS.recurrence_ratio_high) {
    score += 16
    evidence.push(`Congestion récurrente sur ${(features.congestion_recurrence_ratio * 100).toFixed(0)}% des tranches disponibles.`)
  }

  if (features.recent_prb_avg >= 70 && features.recent_throughput_slope < 0 && features.recent_cqi_avg >= 8.5) predictedIssue = 'Risque de congestion capacitaire'
  if (features.recent_prb_avg >= 65 && features.recent_throughput_slope < 0 && (features.recent_cqi_slope < 0 || features.recent_cqi_avg < 8.5)) predictedIssue = 'Risque de qualité radio dégradée'
  if (features.busy_hour_flag && score >= 50) predictedIssue = 'Risque de surcharge en heure critique'
  if (history.length < 3) predictedIssue = 'Données insuffisantes'
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
    risk_level: riskLevelFromScore(riskScore),
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

function summarize(rows = [], scopedTotal = 0) {
  const predicted = rows.filter((row) => row.risk_level !== 'low')
  const highRisk = rows.filter((row) => row.risk_level === 'high' || row.risk_level === 'critical')
  const critical = rows.filter((row) => row.risk_level === 'critical')
  const avgRisk = rows.length ? rows.reduce((sum, row) => sum + row.risk_score, 0) / rows.length : 0
  const confScores = rows.map((row) => row.confidence_score).filter(Number.isFinite)
  const avgConf = confScores.length ? avg(confScores) : 0
  return {
    total_cells: scopedTotal,
    predicted_cells: predicted.length,
    high_risk_cells: highRisk.length,
    critical_risk_cells: critical.length,
    average_risk_score: round(avgRisk),
    confidence: avgConf >= QOS_THRESHOLDS.confidence.high_min_score ? 'high' : avgConf >= QOS_THRESHOLDS.confidence.medium_min_score ? 'medium' : 'low',
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

  const scopedCells = Object.entries(baseline)
    .map(([cellName, entry]) => ({
      cell_name: cellName,
      site_name: entry.site_name || entry.enodeb_name || '',
      gov_id: entry.admin?.gov_id || '',
      deleg_id: entry.admin?.deleg_id || '',
    }))
    .filter((meta) => scopeMatches(meta, scope))
    .map((meta) => meta.cell_name)

  const rows = scopedCells
    .map((cellName) => buildCellForecast({ cellName, baselineEntry: baseline[cellName], slices, horizon, generatedAt, targetTimestamp }))
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
    summary: summarize(rows, scopedCells.length),
    warnings,
  }
}

function normalizeParquetRow(row = {}) {
  const cellName = String(row.cell_name || row.cell || row.cellid || row.cell_id || '').trim()
  if (!cellName) return null
  return {
    cell_name: cellName,
    prb_load: row.prb_load ?? row.load ?? row.prb,
    throughput_mbps: row.throughput_mbps,
    throughput_kbps: row.throughput_kbps,
    throughput: row.throughput,
    cqi: row.cqi,
    active_users: row.active_users ?? row.users,
    rrc_users: row.rrc_users,
    traffic: row.traffic,
    ta: row.ta,
  }
}

async function readParquetObservations(filePath) {
  const observations = {}
  const parquetModule = await import('parquetjs-lite')
  const Reader = parquetModule?.ParquetReader || parquetModule?.default?.ParquetReader
  if (!Reader) throw new Error('parquetjs-lite reader unavailable')
  const reader = await Reader.openFile(filePath)
  try {
    const cursor = reader.getCursor()
    // Streaming read to avoid loading the full file in memory.
    for (let row = await cursor.next(); row; row = await cursor.next()) {
      const normalized = normalizeParquetRow(row)
      if (!normalized) continue
      observations[normalized.cell_name] = normalized
    }
  } finally {
    await reader.close()
  }
  return observations
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
    const jsonPath = path.resolve(root, 'time_data', filename.endsWith('.json') ? filename : filename.replace(/\.parquet$/i, '.json'))
    const parquetPath = path.resolve(root, 'time_data', filename.endsWith('.parquet') ? filename : filename.replace(/\.json$/i, '.parquet'))
    try {
      const raw = await readFile(jsonPath, 'utf8')
      const parsed = JSON.parse(raw)
      timeSlices.push({ timestamp: entry.timestamp, observations: parsed?.observations || {} })
      continue
    } catch {}
    try {
      const observations = await readParquetObservations(parquetPath)
      if (Object.keys(observations).length) {
        timeSlices.push({ timestamp: entry.timestamp, observations })
        warnings.push(`Tranche lue depuis parquet: ${path.basename(parquetPath)}`)
        continue
      }
    } catch {}
    warnings.push(`Tranche indisponible: ${filename}`)
  }
  if (!timeSlices.length) {
    warnings.push('Aucune tranche JSON/Parquet lisible dans time_data.')
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
    if (row.confidence === 'high' && Number(row.trend_features?.available_slice_count || 0) < QOS_THRESHOLDS.confidence.min_slices_high) errors.push(`rows[${idx}].confidence trop élevée pour l'historique`)
    if (!Array.isArray(row.evidence)) errors.push(`rows[${idx}].evidence invalide`)
  }
  return { ok: errors.length === 0, errors }
}
