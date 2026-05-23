import { ACTION_LABELS_FR } from './uiPolicy.mjs'

export const SIMULATOR_ACTIONS = Object.freeze([
  { id: 'tilt', label: ACTION_LABELS_FR.tilt, params: { degrees: 2 } },
  { id: 'redistribute', label: ACTION_LABELS_FR.redistribute, params: { ratio: 0.15 } },
  { id: 'add_carrier', label: ACTION_LABELS_FR.add_carrier, params: null },
  { id: 'add_sector', label: ACTION_LABELS_FR.add_sector, params: { targetSectors: 4 } },
  { id: 'new_site', label: ACTION_LABELS_FR.new_site, params: { siteType: 'macro' } },
  { id: 'add_site', label: ACTION_LABELS_FR.add_site, params: { siteType: 'macro' } },
])

export const DEFAULT_MAP_CONTROLS = Object.freeze({
  basemap: 'admin',
  viewMode: '2d',
  heatmap: false,
  delegations: true,
  sites: true,
  labels: false,
})

const ACTION_LABEL_TO_ID = Object.freeze({
  'Antenna Tilt': 'tilt',
  'Tilt Adjustment': 'tilt',
  Tilt: 'tilt',
  'Load Rebalancing': 'redistribute',
  Redistribute: 'redistribute',
  'Actions on Neighbors': 'redistribute',
  'Carrier Extension': 'add_carrier',
  'Add Carrier': 'add_carrier',
  'Add Band': 'add_carrier',
  'Add Sector': 'add_sector',
  'New Site': 'new_site',
  'Add Site': 'add_site',
})

function num(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function bool(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return ['true', '1', 'yes', 'y'].includes(value.trim().toLowerCase())
  return Boolean(value)
}

export function normalizeThroughputKbps(value) {
  return num(value, 0)
}

export function normalizeOperationalCell(base = {}, obs = {}, admin = null) {
  const prbLoad = num(obs.prb_load ?? obs.prb ?? obs.dl_prb_load ?? obs.load, 0)
  const throughputKbps = normalizeThroughputKbps(obs.throughput_kbps ?? obs.throughput ?? obs.dl_throughput ?? obs.user_throughput ?? obs.avg_throughput)
  const activeUsers = num(obs.active_users ?? obs.rrc_connected_users ?? obs.users ?? obs.traffic ?? obs.rrc_users, 0)
  return {
    cell_name: String(obs.cell_name || base.cell_name || '').trim(),
    site_name: String(base.enodeb_name || base.site_name || obs.site_name || '').trim(),
    longitude: num(base.longitude ?? obs.longitude, null),
    latitude: num(base.latitude ?? obs.latitude, null),
    azimuth: num(base.azimuth ?? obs.azimuth, 0),
    frequency_band: base.frequency_band ?? obs.frequency_band ?? null,
    localcell_id: base.localcell_id ?? obs.localcell_id ?? null,
    prb_load: prbLoad,
    throughput_kbps: throughputKbps,
    throughput: throughputKbps > 1000 ? throughputKbps / 1000 : throughputKbps,
    active_users: activeUsers,
    rrc_users: num(obs.rrc_users ?? obs.rrc_connected_users ?? obs.active_users, activeUsers),
    traffic: num(obs.traffic ?? obs.data_traffic ?? obs.dl_traffic_gb, 0),
    cqi: num(obs.cqi ?? obs.avg_cqi, 0),
    ta: num(obs.ta ?? obs.avg_ta ?? obs.timing_advance, 0),
    congested: obs.congested === undefined ? prbLoad >= 85 : bool(obs.congested),
    health: num(obs.health ?? obs.health_score, Math.max(0, 100 - Math.max(0, prbLoad - 50) * 1.4)),
    lost_traffic: num(obs.lost_traffic ?? obs.lost_gb ?? obs.potential_lost_gb, 0),
    recoverable_traffic: num(obs.recoverable_traffic ?? obs.recoverable_gb, 0),
    admin,
  }
}

export function mapRecommendationToSimulatorAction(actionName) {
  const mapped = ACTION_LABEL_TO_ID[String(actionName || '').trim()]
  if (!mapped) return null
  return SIMULATOR_ACTIONS.some((action) => action.id === mapped) ? mapped : null
}

export function paramsForSimulatorAction(action, cell = {}) {
  const item = SIMULATOR_ACTIONS.find((candidate) => candidate.id === action)
  if (!item) {
    throw new Error(`Unsupported simulator action: ${action}`)
  }
  if (action === 'add_carrier') return { band: cell?.frequency_band || 3 }
  return { ...(item.params || {}) }
}

export function buildSimulationPayload({ cell, action, currentTime, params }) {
  const cellName = String(cell?.cell_name || '').trim()
  if (!cellName) throw new Error('Simulation requires a selected cell')
  const nextAction = String(action || '').trim()
  if (!SIMULATOR_ACTIONS.some((item) => item.id === nextAction)) {
    throw new Error(`Unsupported simulator action: ${nextAction}`)
  }
  return {
    cell_name: cellName,
    action: nextAction,
    params: params && typeof params === 'object' && !Array.isArray(params) ? params : paramsForSimulatorAction(nextAction, cell),
    time_entry: currentTime && typeof currentTime === 'object' ? currentTime : {},
    mode: 'fast',
  }
}
