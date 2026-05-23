import { getScopedCellNames } from './adminScope'
import { normalizeOperationalCell } from '../utils/v2Contracts.mjs'
import { inferCongestedFromKpis } from '../utils/v2Contracts.mjs'
import { normalizeAdminNames, normalizeDelegationName, normalizeGovernorateName } from './adminNaming'

export const METRIC_MODES = [
  { id: 'congestion_rate', label: 'Taux de congestion', unit: '%' },
  { id: 'avg_prb', label: 'Charge PRB moyenne', unit: '%' },
  { id: 'avg_throughput', label: 'Debit moyen', unit: 'Mbps' },
  { id: 'avg_cqi', label: 'CQI moyen', unit: '' },
  { id: 'lost_traffic', label: 'Trafic perdu', unit: 'GB' },
  { id: 'recoverable_traffic', label: 'Trafic recuperable', unit: 'GB' },
]

function num(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function isCongestedBySourceRules(cell) {
  const prbLoad = num(cell?.prb_load)
  const throughputKbps = num(cell?.throughput_kbps) || (num(cell?.throughput) * 1000)
  const activeUsers = num(cell?.active_users)
  return inferCongestedFromKpis({ prbLoad, throughputKbps, activeUsers })
}

export function normalizeObservation(base = {}, obs = {}) {
  return normalizeOperationalCell(base, obs, null)
}

export function buildCells(baseline = {}, observations = {}, adminCellIndex = {}) {
  return Object.entries(baseline).map(([cellName, base]) => ({
    ...normalizeObservation(base, { ...(observations[cellName] || {}), cell_name: cellName }),
    cell_name: cellName,
    admin: normalizeAdminNames(adminCellIndex[cellName] || null),
  }))
}

function weightedAverage(cells, key, weightKey = 'active_users') {
  const weighted = cells.reduce((acc, cell) => {
    const value = num(cell[key], NaN)
    const weight = Math.max(0, num(cell[weightKey], 0))
    if (!Number.isFinite(value) || weight <= 0) return acc
    acc.sum += value * weight
    acc.weight += weight
    return acc
  }, { sum: 0, weight: 0 })
  if (weighted.weight > 0) return weighted.sum / weighted.weight
  const values = cells.map((cell) => num(cell[key], NaN)).filter(Number.isFinite)
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
}

export function aggregateCells(cells = [], label = 'Scope') {
  const observed = cells.length
  const congested = cells.filter((cell) => cell.congested || isCongestedBySourceRules(cell)).length
  const activeUsers = cells.reduce((sum, cell) => sum + num(cell.active_users), 0)
  const traffic = cells.reduce((sum, cell) => sum + num(cell.traffic), 0)
  const sites = new Set(cells.map((cell) => cell.site_name).filter(Boolean)).size
  const delegations = new Set(cells.map((cell) => cell.admin?.deleg_id).filter(Boolean)).size
  const lostTraffic = cells.reduce((sum, cell) => sum + num(cell.lost_traffic), 0)
  const recoverableTraffic = cells.reduce((sum, cell) => sum + num(cell.recoverable_traffic), 0)
  const avgPrb = weightedAverage(cells, 'prb_load')
  const avgThroughput = weightedAverage(cells, 'throughput')
  const avgCqi = weightedAverage(cells, 'cqi', activeUsers > 0 ? 'active_users' : 'traffic')
  return {
    label,
    observed_cells: observed,
    total_cells: observed,
    congested_cells: congested,
    congestion_rate: observed ? (congested / observed) * 100 : 0,
    active_users: activeUsers,
    rrc_users: cells.reduce((sum, cell) => sum + num(cell.rrc_users), 0),
    traffic,
    sites,
    delegations,
    avg_prb: avgPrb,
    avg_throughput: avgThroughput,
    avg_cqi: avgCqi,
    avg_ta: weightedAverage(cells, 'ta'),
    avg_health: weightedAverage(cells, 'health'),
    lost_traffic: lostTraffic,
    recoverable_traffic: recoverableTraffic,
    status: congested / Math.max(1, observed) > 0.2 ? 'critical' : congested ? 'watch' : 'stable',
  }
}

export function aggregateNationalScope(cells) {
  return aggregateCells(cells, 'Tunisia')
}

export function aggregateGovernorateScope(cells, governorateId) {
  return aggregateCells(cells.filter((cell) => cell.admin?.gov_id === governorateId), governorateId)
}

export function aggregateDelegationScope(cells, delegationId) {
  return aggregateCells(cells.filter((cell) => cell.admin?.deleg_id === delegationId), delegationId)
}

export function rankGovernorates(cells, registry, metricMode = 'congestion_rate') {
  return (registry?.governorates || []).map((gov) => {
    const scoped = cells.filter((cell) => cell.admin?.gov_id === gov.gov_id)
    const govName = normalizeGovernorateName(gov.gov_name)
    return { ...gov, gov_name: govName, ...aggregateCells(scoped, govName), id: gov.gov_id, name: govName, value: metricValue(aggregateCells(scoped), metricMode) }
  }).sort((a, b) => b.value - a.value)
}

export function rankDelegations(cells, registry, governorateId, metricMode = 'congestion_rate') {
  return (registry?.delegations || [])
    .filter((deleg) => !governorateId || deleg.gov_id === governorateId)
    .map((deleg) => {
      const scoped = cells.filter((cell) => cell.admin?.deleg_id === deleg.deleg_id)
      const delegName = normalizeDelegationName(deleg.deleg_name)
      const govName = normalizeGovernorateName(deleg.gov_name)
      const agg = aggregateCells(scoped, delegName)
      return { ...deleg, deleg_name: delegName, gov_name: govName, ...agg, id: deleg.deleg_id, name: delegName, value: metricValue(agg, metricMode) }
    })
    .sort((a, b) => b.value - a.value)
}

export function getSitesForScope(cells, scope) {
  const names = new Set(getScopedCellNames(scope, Object.fromEntries(cells.filter((c) => c.admin).map((c) => [c.cell_name, c.admin]))))
  const selectedCells = cells.filter((cell) => names.has(cell.cell_name))
  const grouped = new Map()
  selectedCells.forEach((cell) => {
    const key = cell.site_name || cell.cell_name
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key).push(cell)
  })
  return Array.from(grouped.entries()).map(([site_name, siteCells]) => ({ site_name, cells: siteCells, ...aggregateCells(siteCells, site_name) }))
}

export function metricValue(agg, metricMode) {
  if (!agg) return 0
  return num(agg[metricMode], 0)
}

export function formatMetric(value, digits = 1) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  if (Math.abs(n) >= 1000000) return `${(n / 1000000).toFixed(1)}M`
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}K`
  return n.toFixed(digits).replace(/\.0$/, '')
}

export function diagnoseCell(cell) {
  if (!cell) return 'Selectionnez une cellule pour calculer le diagnostic multi-KPI.'
  const highPrb = cell.prb_load >= 80
  const lowThroughput = cell.throughput > 0 && cell.throughput < 15
  const lowCqi = cell.cqi > 0 && cell.cqi < 8
  const goodThroughput = cell.throughput >= 15
  const goodCqi = cell.cqi >= 9
  const highTa = cell.ta >= 2.5
  if (highPrb && lowThroughput && lowCqi && highTa) return 'PRB eleve, debit faible, CQI faible et TA eleve : verifier couverture de bord de cellule ou interference.'
  if (highPrb && lowThroughput && !lowCqi) return 'PRB eleve avec debit faible et CQI acceptable : pression capacitaire probable.'
  if (highPrb && goodThroughput && goodCqi) return 'Cellule chargee, mais debit et CQI restent acceptables sur cette tranche.'
  if (highPrb) return 'PRB eleve : comparer avec les heures critiques recurrentes avant de conclure a une congestion structurelle.'
  if (lowThroughput && lowCqi) return 'Debit et CQI degraderes : revue qualite radio ou interference recommandee.'
  return 'Aucun defaut multi-KPI severe detecte sur cette tranche.'
}

export function classifyRanIssue(cellOrScope) {
  if (!cellOrScope) return { issue: 'No data', severity: 'unknown', evidence: [] }
  
  const prb = num(cellOrScope.prb_load || cellOrScope.avg_prb)
  const throughput = num(cellOrScope.throughput || cellOrScope.avg_throughput)
  const throughputKbps = num(cellOrScope.throughput_kbps) || (throughput > 0 ? throughput * 1000 : 0)
  const cqi = num(cellOrScope.cqi || cellOrScope.avg_cqi)
  const ta = num(cellOrScope.ta || cellOrScope.avg_ta)
  const activeUsers = num(cellOrScope.active_users || cellOrScope.active_users_at_peak)
  const recurrence = num(cellOrScope.recurrence_ratio || 0)
  const congestedByRules = inferCongestedFromKpis({ prbLoad: prb, throughputKbps, activeUsers })
  
  const evidence = []
  let issue = 'Normal'
  let severity = 'low'
  
  if (!prb && !throughput && !cqi && !activeUsers) {
    issue = 'Telemetry/Data Gap'
    severity = 'unknown'
    evidence.push('Missing PRB, throughput, CQI or user samples')
  } else if (prb >= 80 && (!throughput || !cqi)) {
    issue = 'Telemetry/Data Gap'
    severity = 'unknown'
    evidence.push('PRB is high but throughput or CQI evidence is missing')
  } else if (congestedByRules && throughput < 15 && cqi < 8 && ta >= 2.5) {
    issue = 'Edge/Interference Pressure'
    severity = 'critical'
    evidence.push('High PRB', 'Low throughput', 'Low CQI', 'Elevated TA')
  } else if (recurrence > 0.6 && prb >= 70) {
    issue = 'Structural Busy-Hour Pattern'
    severity = 'high'
    evidence.push(`Recurrent ${Math.round(recurrence * 100)}% of observations`, 'Busy-hour pressure repeats')
  } else if (congestedByRules && throughput < 15 && cqi >= 8) {
    issue = 'Capacity Pressure'
    severity = 'high'
    evidence.push('High PRB', 'Low throughput', 'CQI acceptable')
  } else if (congestedByRules && throughput >= 15 && cqi >= 8) {
    issue = 'Loaded but Acceptable'
    severity = 'medium'
    evidence.push('High PRB', 'Throughput acceptable', 'CQI acceptable')
  } else if (recurrence < 0.2 && prb >= 80) {
    issue = 'Temporary Spike / Anomaly'
    severity = 'medium'
    evidence.push(`Low recurrence ${Math.round(recurrence * 100)}%`, 'High load is not persistent')
  } else if (prb > 60 && throughput < 15 && cqi < 8) {
    issue = 'QoS Degradation Trend'
    severity = 'medium'
    evidence.push('Moderate PRB elevation', 'Low throughput', 'Low CQI')
  } else if (prb > 60 && throughput >= 15 && cqi >= 8) {
    issue = 'Loaded but Acceptable'
    severity = 'low'
    evidence.push('Moderate PRB elevation', 'Throughput acceptable', 'CQI acceptable')
  }
  
  return { issue, severity, evidence }
}

export function computeRecurrenceMetrics(rows = []) {
  if (!rows.length) return { recurrence_ratio: 0, peak_days_count: 0, structural_flag: false }
  const withRecurrence = rows.filter((r) => r.recurrence_ratio > 0.6)
  return {
    recurrence_ratio: rows.reduce((sum, r) => sum + (r.recurrence_ratio || 0), 0) / rows.length,
    peak_days_count: rows.filter((r) => r.samples > 1).length,
    structural_flag: withRecurrence.length / rows.length > 0.4,
  }
}

export function buildWhyCritical({ summary = {}, peakPayload = {}, peakRows = [], issue = null, warnings = [] } = {}) {
  const rows = []
  const congestionRate = num(summary.congestion_rate)
  const prb = num(summary.avg_prb)
  const throughput = num(summary.avg_throughput)
  const cqi = num(summary.avg_cqi)
  const peak = peakPayload?.summary || peakRows?.[0] || null
  const recurrence = peakRows?.length ? computeRecurrenceMetrics(peakRows).recurrence_ratio : num(peak?.recurrence_ratio)

  if (congestionRate > 0) rows.push(`${formatMetric(congestionRate)}% congested cells`)
  if (prb >= 70) rows.push(`PRB pressure at ${formatMetric(prb)}%`)
  if (throughput > 0 && throughput < 15) rows.push(`Low throughput at ${formatMetric(throughput)} Mbps`)
  if (cqi > 0 && cqi < 8) rows.push(`CQI degradation at ${formatMetric(cqi)}`)
  if (peak?.peak_hour) rows.push(`Peak at ${peak.peak_hour}`)
  if (recurrence > 0) rows.push(`${formatMetric(recurrence * 100, 0)}% busy-hour recurrence`)
  if (summary.congested_cells || summary.delegations) rows.push(`${summary.congested_cells || 0} affected cells across ${summary.delegations || 0} zones`)
  if (issue?.issue && issue.issue !== 'Normal') rows.push(`Likely cause: ${issue.issue}`)
  for (const warning of warnings.slice(0, 2)) rows.push(`Data warning: ${warning}`)

  return rows.length ? rows : ['No critical pattern detected for the current scope.']
}

export function computeConfidence({ cells = [], summary = {}, peakRows = [], dataMode = 'real', timeIndex = [], reconciliation = {} } = {}) {
  const total = Math.max(1, cells.length || summary.observed_cells || 0)
  const missingKpi = cells.filter((cell) => !num(cell.prb_load) || !num(cell.throughput) || !num(cell.cqi)).length
  const unmatched = cells.filter((cell) => !cell.admin || cell.admin.match_confidence === 'low' || cell.admin.match_method === 'unmatched').length
  const lowSpatial = cells.filter((cell) => cell.admin?.match_confidence === 'low' || cell.admin?.match_confidence === 'medium').length
  const recurrence = peakRows.length ? computeRecurrenceMetrics(peakRows).recurrence_ratio : 0
  const timeCoverage = Array.isArray(timeIndex) ? Math.min(1, timeIndex.length / 24) : 0
  let score = 100
  score -= Math.min(35, (missingKpi / total) * 100)
  score -= Math.min(25, (unmatched / total) * 100)
  score -= Math.min(10, (lowSpatial / total) * 50)
  if (timeCoverage < 1) score -= 15
  if (dataMode === 'mock') score -= 15
  if (peakRows.length && recurrence < 0.15) score -= 5
  if (reconciliation?.warnings?.length) score -= Math.min(10, reconciliation.warnings.length * 2)
  score = Math.max(0, Math.min(100, score))

  const reasons = []
  reasons.push(`${formatMetric(total, 0)} scoped cells`)
  if (missingKpi) reasons.push(`${formatMetric((missingKpi / total) * 100, 0)}% missing KPI fields`)
  if (unmatched) reasons.push(`${unmatched} cells need spatial review`)
  if (dataMode === 'mock') reasons.push('Mock demo mode reduces operational confidence')
  if (Array.isArray(timeIndex)) reasons.push(`${timeIndex.length} time slices available`)
  if (peakRows.length) reasons.push(`${formatMetric(recurrence * 100, 0)}% recurrence consistency`)

  return { score, label: score >= 75 ? 'High' : score >= 50 ? 'Medium' : 'Low', reasons }
}

export function computeDataQuality({ data = {}, cells = [], timeIndex = [], peakPayload = {}, dataMode = 'real' } = {}) {
  const reconciliation = data?.reconciliation || {}
  const baselineCount = Object.keys(data?.baseline || {}).length
  const matched = cells.filter((cell) => cell.admin).length
  const unmatched = Math.max(0, baselineCount - matched)
  const lowSpatial = cells.filter((cell) => cell.admin?.match_confidence === 'low' || cell.admin?.match_confidence === 'medium').length
  const missingKpi = cells.filter((cell) => !num(cell.prb_load) || !num(cell.throughput) || !num(cell.cqi)).length
  const withoutObs = cells.filter((cell) => !num(cell.prb_load) && !num(cell.active_users) && !num(cell.traffic)).length
  const missingNames = (reconciliation?.missing_names || reconciliation?.registry_gaps || []).length
  return {
    dataMode,
    baselineCount,
    matched,
    unmatched,
    lowSpatial,
    missingNames,
    missingKpi,
    missingKpiRatio: baselineCount ? missingKpi / baselineCount : 0,
    withoutObs,
    timeSlices: Array.isArray(timeIndex) ? timeIndex.length : 0,
    lastPeakComputation: peakPayload?.generated_at || peakPayload?.summary?.peak_hour || (peakPayload?.available ? 'available' : 'unavailable'),
    warnings: reconciliation?.warnings || [],
  }
}

export function computeSliceDelta(currentCells = [], previousCells = []) {
  if (!previousCells.length) {
    return { available: false, reason: 'No previous time slice available for comparison.' }
  }
  const prevByName = new Map(previousCells.map((cell) => [cell.cell_name, cell]))
  const comparable = currentCells.map((cell) => ({ current: cell, previous: prevByName.get(cell.cell_name) })).filter((pair) => pair.previous)
  if (!comparable.length) return { available: false, reason: 'Previous slice has no comparable cells for this scope.' }
  const becameCongested = comparable.filter(({ current, previous }) => current.congested && !previous.congested)
  const recovered = comparable.filter(({ current, previous }) => !current.congested && previous.congested)
  const worsened = comparable.filter(({ current, previous }) => num(current.prb_load) - num(previous.prb_load) >= 10 || num(previous.throughput) - num(current.throughput) >= 5)
  const improved = comparable.filter(({ current, previous }) => num(previous.prb_load) - num(current.prb_load) >= 10 || num(current.throughput) - num(previous.throughput) >= 5)
  const maxBy = (fn) => comparable.reduce((best, pair) => !best || fn(pair) > fn(best) ? pair : best, null)
  const positiveDelta = (pair, fn) => pair && fn(pair) > 0 ? { cell: pair.current.cell_name, value: fn(pair) } : null
  const prbInc = maxBy(({ current, previous }) => num(current.prb_load) - num(previous.prb_load))
  const throughputDrop = maxBy(({ current, previous }) => num(previous.throughput) - num(current.throughput))
  const cqiDrop = maxBy(({ current, previous }) => num(previous.cqi) - num(current.cqi))
  return {
    available: true,
    comparable: comparable.length,
    newCongested: becameCongested.length,
    recovered: recovered.length,
    worsened: worsened.length,
    improved: improved.length,
    biggestPrbIncrease: positiveDelta(prbInc, ({ current, previous }) => num(current.prb_load) - num(previous.prb_load)),
    biggestThroughputDrop: positiveDelta(throughputDrop, ({ current, previous }) => num(previous.throughput) - num(current.throughput)),
    biggestCqiDrop: positiveDelta(cqiDrop, ({ current, previous }) => num(previous.cqi) - num(current.cqi)),
  }
}

export function buildAnalyticalReport({ scope = {}, timestamp = '', summary = {}, peakPayload = {}, peakRows = [], issue = {}, whyCritical = [], dataQuality = {}, topRows = [] } = {}) {
  return {
    title: 'NetVision analytical scope report',
    generated_at: new Date().toISOString(),
    scope: {
      level: scope.level,
      label: scope.selectedCellName || scope.delegationName || scope.governorateName || 'Tunisia',
      governorateId: scope.governorateId,
      delegationId: scope.delegationId,
      selectedSite: scope.selectedSite,
      selectedCellName: scope.selectedCellName,
    },
    timestamp,
    kpis: summary,
    peak_hours: {
      available: peakPayload?.available !== false,
      summary: peakPayload?.summary || null,
      top: (peakRows || []).slice(0, 8),
    },
    qos_diagnosis: issue,
    why_critical: whyCritical,
    data_quality_warnings: dataQuality?.warnings || [],
    top_affected: topRows.slice(0, 8),
  }
}
