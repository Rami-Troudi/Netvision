import { getScopedCellNames } from './adminScope'

export const METRIC_MODES = [
  { id: 'congestion_rate', label: 'Congestion Rate', unit: '%' },
  { id: 'avg_prb', label: 'Avg PRB Load', unit: '%' },
  { id: 'avg_throughput', label: 'Avg Throughput', unit: 'Mbps' },
  { id: 'avg_cqi', label: 'Avg CQI', unit: '' },
  { id: 'lost_traffic', label: 'Lost Traffic', unit: 'GB' },
  { id: 'recoverable_traffic', label: 'Recoverable Traffic', unit: 'GB' },
]

function num(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function normalizeObservation(base = {}, obs = {}) {
  const prb = num(obs.prb_load ?? obs.prb ?? obs.dl_prb_load ?? obs.load, 0)
  const throughputRaw = num(obs.throughput ?? obs.dl_throughput ?? obs.user_throughput ?? obs.avg_throughput, 0)
  return {
    cell_name: obs.cell_name,
    site_name: base.enodeb_name || base.site_name || '',
    longitude: num(base.longitude, null),
    latitude: num(base.latitude, null),
    azimuth: num(base.azimuth, 0),
    frequency_band: base.frequency_band ?? null,
    localcell_id: base.localcell_id ?? null,
    prb_load: prb,
    throughput: throughputRaw > 1000 ? throughputRaw / 1000 : throughputRaw,
    cqi: num(obs.cqi ?? obs.avg_cqi, 0),
    active_users: num(obs.active_users ?? obs.rrc_connected_users ?? obs.users ?? obs.rrc_users ?? obs.traffic, 0),
    rrc_users: num(obs.rrc_users ?? obs.rrc_connected_users ?? obs.active_users, 0),
    ta: num(obs.ta ?? obs.avg_ta ?? obs.timing_advance, 0),
    traffic: num(obs.traffic ?? obs.data_traffic ?? obs.dl_traffic_gb, 0),
    congested: Boolean(obs.congested) || prb >= 85,
    health: num(obs.health ?? obs.health_score, Math.max(0, 100 - Math.max(0, prb - 50) * 1.4)),
    lost_traffic: num(obs.lost_traffic ?? obs.lost_gb ?? obs.potential_lost_gb, 0),
    recoverable_traffic: num(obs.recoverable_traffic ?? obs.recoverable_gb, 0),
  }
}

export function buildCells(baseline = {}, observations = {}, adminCellIndex = {}) {
  return Object.entries(baseline).map(([cellName, base]) => ({
    ...normalizeObservation(base, { ...(observations[cellName] || {}), cell_name: cellName }),
    cell_name: cellName,
    admin: adminCellIndex[cellName] || null,
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
  const congested = cells.filter((cell) => cell.congested || num(cell.prb_load) >= 85).length
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
    return { ...gov, ...aggregateCells(scoped, gov.gov_name), id: gov.gov_id, name: gov.gov_name, value: metricValue(aggregateCells(scoped), metricMode) }
  }).sort((a, b) => b.value - a.value)
}

export function rankDelegations(cells, registry, governorateId, metricMode = 'congestion_rate') {
  return (registry?.delegations || [])
    .filter((deleg) => !governorateId || deleg.gov_id === governorateId)
    .map((deleg) => {
      const scoped = cells.filter((cell) => cell.admin?.deleg_id === deleg.deleg_id)
      const agg = aggregateCells(scoped, deleg.deleg_name)
      return { ...deleg, ...agg, id: deleg.deleg_id, name: deleg.deleg_name, value: metricValue(agg, metricMode) }
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
  if (!cell) return 'Select a cell to calculate multi-KPI diagnosis.'
  const highPrb = cell.prb_load >= 85
  const lowThroughput = cell.throughput > 0 && cell.throughput < 15
  const lowCqi = cell.cqi > 0 && cell.cqi < 8
  const goodThroughput = cell.throughput >= 15
  const goodCqi = cell.cqi >= 9
  const highTa = cell.ta >= 2.5
  if (highPrb && lowThroughput && lowCqi && highTa) return 'High PRB, low throughput, low CQI and elevated TA indicate edge coverage or interference pressure.'
  if (highPrb && lowThroughput && !lowCqi) return 'High PRB with low throughput and acceptable CQI indicates capacity pressure.'
  if (highPrb && goodThroughput && goodCqi) return 'The cell is loaded but throughput and CQI remain acceptable in this slice.'
  if (highPrb) return 'PRB is elevated; compare with recurring busy-hour patterns before treating it as structural congestion.'
  if (lowThroughput && lowCqi) return 'Throughput and CQI degradation suggest radio quality or interference review.'
  return 'No severe multi-KPI fault pattern detected in the selected time slice.'
}
