import { aggregateCells, formatMetric } from './adminAggregation'
import { inferCongestedFromKpis } from '../utils/v2Contracts.mjs'
import { OPERATOR_TABS, ADMIN_TABS, stateLabelFr } from '../utils/uiPolicy.mjs'

export const COCKPIT_TABS = OPERATOR_TABS
export const ADMIN_COCKPIT_TABS = ADMIN_TABS

export const DEFAULT_FILTERS = {
  critical: true,
  watch: true,
  degraded: true,
  healthy: true,
  no_data: true,
  unmatched: true,
  minPrb: 0,
  maxPrb: 100,
  bands: {},
}

export function getCellState(cell) {
  if (!cell?.admin) return 'unmatched'
  const hasKpi = Number(cell.prb_load) > 0 || Number(cell.throughput) > 0 || Number(cell.cqi) > 0 || Number(cell.active_users) > 0
  if (!hasKpi) return 'no_data'
  if (
    cell.congested
    || inferCongestedFromKpis({
      prbLoad: Number(cell.prb_load) || 0,
      throughputKbps: Number(cell.throughput_kbps) || (Number(cell.throughput) || 0) * 1000,
      activeUsers: Number(cell.active_users) || 0,
    })
  ) return 'critical'
  if (Number(cell.prb_load) >= 70) return 'watch'
  if ((Number(cell.throughput) > 0 && Number(cell.throughput) < 10) || (Number(cell.cqi) > 0 && Number(cell.cqi) < 8)) return 'degraded'
  return 'healthy'
}

export function stateRank(state) {
  return { critical: 5, watch: 4, degraded: 3, healthy: 2, no_data: 1, unmatched: 0 }[state] ?? 0
}

export function stateLabel(state) {
  return stateLabelFr(state)
}

export function stateColor(state) {
  return {
    critical: '#d9480f',
    watch: '#f59f00',
    degraded: '#1971c2',
    healthy: '#2b8a3e',
    no_data: '#868e96',
    unmatched: '#5c6773',
  }[state] || '#868e96'
}

export function buildSiteSummaries(cells = []) {
  const grouped = new Map()
  cells.forEach((cell) => {
    const key = cell.site_name || cell.cell_name
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key).push(cell)
  })
  return Array.from(grouped.entries()).map(([site_name, siteCells]) => {
    const agg = aggregateCells(siteCells, site_name)
    const worst = siteCells.map(getCellState).sort((a, b) => stateRank(b) - stateRank(a))[0] || 'no_data'
    const first = siteCells.find((cell) => Number.isFinite(cell.longitude) && Number.isFinite(cell.latitude)) || siteCells[0]
    return {
      ...agg,
      site_name,
      id: site_name,
      name: site_name,
      cells: siteCells,
      longitude: first?.longitude,
      latitude: first?.latitude,
      state: worst,
      state_label: stateLabel(worst),
      state_color: stateColor(worst),
      worst_cell: siteCells.find((cell) => getCellState(cell) === worst)?.cell_name || siteCells[0]?.cell_name || '',
      admin: first?.admin || null,
    }
  }).sort((a, b) => stateRank(b.state) - stateRank(a.state) || b.avg_prb - a.avg_prb)
}

export function applyCellFilters(cells = [], filters = DEFAULT_FILTERS) {
  return cells.filter((cell) => {
    const state = getCellState(cell)
    if (!filters[state]) return false
    if (!cell.admin && !filters.unmatched) return false
    const prb = Number(cell.prb_load) || 0
    if (prb < Number(filters.minPrb ?? 0) || prb > Number(filters.maxPrb ?? 100)) return false
    const bands = filters.bands || {}
    const activeBandKeys = Object.keys(bands).filter((band) => bands[band])
    if (activeBandKeys.length && !activeBandKeys.includes(String(cell.frequency_band))) return false
    return true
  })
}

export function summarizeAlerts(cells = []) {
  return cells
    .filter((cell) => ['critical', 'watch', 'degraded', 'unmatched'].includes(getCellState(cell)))
    .sort((a, b) => stateRank(getCellState(b)) - stateRank(getCellState(a)) || (Number(b.prb_load) || 0) - (Number(a.prb_load) || 0))
    .slice(0, 20)
}

export function buildActionNarrative(scope, summary, alerts) {
  if (!summary?.observed_cells) return 'Aucun actif radio associe dans ce perimetre. Verifiez la qualite des donnees et le rapprochement administratif.'
  if (alerts?.length) return `${alerts.length} cellules exigent une revue QoS. Commencez par ${alerts[0].cell_name} (${stateLabel(getCellState(alerts[0]))}, PRB ${formatMetric(alerts[0].prb_load)}%).`
  if (scope.level === 'cell') return 'Cellule selectionnee. Verifiez les preuves QoS avant toute action operationnelle.'
  return 'Aucun incident QoS majeur sur cette tranche. Utilisez la timeline ou les filtres pour explorer d autres conditions.'
}
