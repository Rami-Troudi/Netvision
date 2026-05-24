import fs from 'fs/promises'
import path from 'path'

const DEFAULT_DURATION_SECONDS = 15
const MAX_DURATION_SECONDS = 30
const DEFAULT_MAX_NEIGHBORS = 12
const DEFAULT_MAX_UES = 300
const MIN_NEIGHBORS = 2

export async function buildScenario({ projectRoot = process.cwd(), payload = {}, jobId = `ns3-${Date.now()}` } = {}) {
  const dataMode = payload.data_mode === 'mock' ? 'mock' : 'real'
  const runtimeRoot = path.resolve(projectRoot, dataMode === 'mock' ? 'runtime_data_mock' : 'runtime_data')
  const baseline = await readJson(path.resolve(runtimeRoot, 'baseline.json'))
  const timeSlice = await loadTimeSlice(runtimeRoot, payload.time_entry)
  const observations = timeSlice?.observations || {}
  const targetCellName = String(payload.cell_name || payload.target_cell || '').trim()
  const target = baseline[targetCellName]
  if (!target) {
    throw new Error(`Target cell ${targetCellName || '(missing)'} not found in baseline.json`)
  }

  const observed = observations[targetCellName] || {}
  const neighborGraph = await readOptionalJson(path.resolve(runtimeRoot, 'neighbor_graph.json'))
  const calibrationProfiles = await readOptionalJson(path.resolve(runtimeRoot, 'calibration_profiles.json'))
  const neighborNames = chooseNeighborNames({ targetCellName, target, baseline, observations, neighborGraph })
  const neighbors = neighborNames.map((name) => normalizeCellForNs3(baseline[name], observations[name], name)).filter(Boolean)
  const sameSite = Object.entries(baseline)
    .filter(([name, cell]) => name !== targetCellName && cell?.site_name === target.site_name)
    .map(([name]) => name)

  const durationSeconds = Math.min(
    MAX_DURATION_SECONDS,
    Math.max(1, Number(payload.duration_seconds || payload?.limits?.duration_seconds || DEFAULT_DURATION_SECONDS) || DEFAULT_DURATION_SECONDS),
  )
  const maxUes = Math.min(DEFAULT_MAX_UES, Math.max(10, Number(payload?.limits?.max_ues || DEFAULT_MAX_UES) || DEFAULT_MAX_UES))

  const observedKpis = normalizeObservedKpis(observed)
  const guardrails = evaluateScenarioGuardrails({ targetCellName, observedKpis, neighbors, sameSite, maxUes })

  if (!guardrails.valid) {
    throw new Error(`Scenario guardrail violation: ${guardrails.errors.join('; ')}`)
  }

  return {
    job_id: jobId,
    engine: 'ns3',
    fidelity_level: payload.fidelity_level || 'operations_v1',
    scenario: {
      scope: 'cell',
      target_cell: targetCellName,
      timestamp: timeSlice?.timestamp || payload?.time_entry?.timestamp || null,
      duration_seconds: durationSeconds,
      random_seed: Number(payload.random_seed || 42) || 42,
      data_mode: dataMode,
      scenario_id: payload.scenario_id || `${targetCellName}-${payload.action}`,
    },
    action: {
      type: String(payload.action || '').trim(),
      params: isPlainObject(payload.params) ? payload.params : {},
    },
    topology: {
      target: normalizeCellForNs3(target, observed, targetCellName),
      same_site: sameSite,
      neighbors,
      neighbor_graph_source: neighborGraph ? (neighborGraph.__meta?.source || 'inferred') : 'inferred',
    },
    observed_kpis: observedKpis,
    traffic_model: inferTrafficModel(observed, maxUes),
    calibration: {
      profile: calibrationProfileKey({ target, action: payload.action }),
      apply: true,
      profiles: calibrationProfiles?.profiles || calibrationProfiles || {},
    },
    limits: {
      max_neighbors: DEFAULT_MAX_NEIGHBORS,
      max_ues: maxUes,
      timeout_seconds: Math.min(180, Math.max(5, Number(payload?.limits?.timeout_seconds || 180) || 180)),
    },
    guardrails,
  }
}

function calibrationProfileKey({ target = {}, action = '' } = {}) {
  const admin = target.admin || {}
  const zone = admin.deleg_id || admin.gov_id || 'national'
  const band = String(target.frequency_band || 'unknown').replace(/\s+/g, '_')
  return `${zone}:${band}:${String(action || 'unknown')}`
}

async function loadTimeSlice(runtimeRoot, timeEntry = {}) {
  const filename = typeof timeEntry?.filename === 'string' ? timeEntry.filename.trim() : ''
  if (filename) {
    return readJson(path.resolve(runtimeRoot, 'time_data', filename))
  }
  const index = await readJson(path.resolve(runtimeRoot, 'time_index.json'))
  const first = Array.isArray(index.timestamps) ? index.timestamps[0] : null
  if (first?.filename) {
    return readJson(path.resolve(runtimeRoot, 'time_data', first.filename))
  }
  return { timestamp: null, observations: {} }
}

function chooseNeighborNames({ targetCellName, target, baseline, observations, neighborGraph }) {
  const graphEntry = neighborGraph?.[targetCellName]
  if (graphEntry) {
    return unique([
      ...(graphEntry.same_site || []),
      ...(graphEntry.candidate_offload || []),
      ...(graphEntry.overlapping || []),
      ...(graphEntry.nearest || []),
    ]).filter((name) => name !== targetCellName && baseline[name]).slice(0, DEFAULT_MAX_NEIGHBORS)
  }

  return Object.entries(baseline)
    .filter(([name, cell]) => name !== targetCellName && hasCoordinates(cell))
    .map(([name, cell]) => {
      const sameDelegation = cell?.admin?.deleg_id && cell.admin.deleg_id === target?.admin?.deleg_id
      const sameGov = cell?.admin?.gov_id && cell.admin.gov_id === target?.admin?.gov_id
      const sameSite = cell?.site_name === target?.site_name
      const headroom = Math.max(0, 85 - Number(observations[name]?.prb_load ?? observations[name]?.load ?? 75))
      const distanceKm = haversineKm(target.latitude, target.longitude, cell.latitude, cell.longitude)
      const priority = (sameSite ? -100 : 0) + (sameDelegation ? -30 : sameGov ? -10 : 0) - headroom
      return { name, score: distanceKm + priority / 100 }
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, DEFAULT_MAX_NEIGHBORS)
    .map((entry) => entry.name)
}

function normalizeCellForNs3(cell, obs = {}, fallbackName = '') {
  if (!cell) return null
  const band = String(cell.frequency_band || obs.frequency_band || 'L1800')
  return {
    cell_name: cell.cell_name || fallbackName,
    site_name: cell.site_name || cell.enodeb_name || '',
    lat: Number(cell.latitude ?? obs.latitude ?? 0),
    lon: Number(cell.longitude ?? obs.longitude ?? 0),
    azimuth: Number(cell.azimuth ?? obs.azimuth ?? 0) || 0,
    frequency_band: band,
    bandwidth_mhz: bandwidthForBand(band),
    tx_power_dbm: 43,
    antenna_height_m: 30,
    downtilt_deg: Number(cell.downtilt_deg ?? 4) || 4,
    prb_load: Number(obs.prb_load ?? obs.load ?? 0) || 0,
    throughput_mbps: Number(obs.throughput ?? obs.throughput_mbps ?? ((obs.throughput_kbps || 0) / 1000)) || 0,
    active_users: Number(obs.active_users ?? obs.rrc_users ?? 0) || 0,
    cqi: Number(obs.cqi ?? 0) || 0,
    ta: Number(obs.ta ?? 0) || 0,
    admin: cell.admin || null,
  }
}

function normalizeObservedKpis(obs = {}) {
  const throughputMbps = Number(obs.throughput ?? obs.throughput_mbps ?? ((obs.throughput_kbps || 0) / 1000)) || 0
  return {
    prb_load: Number(obs.prb_load ?? obs.load ?? 0) || 0,
    throughput_mbps: throughputMbps,
    cqi: Number(obs.cqi ?? 0) || 0,
    active_users: Number(obs.active_users ?? obs.rrc_users ?? 0) || 0,
    traffic_gb: Number(obs.traffic ?? 0) || 0,
    ta: Number(obs.ta ?? 0) || 0,
    congested: Boolean(obs.congested),
  }
}

function inferTrafficModel(obs = {}, maxUes = DEFAULT_MAX_UES) {
  const activeUsers = Number(obs.active_users ?? obs.rrc_users ?? 0) || 0
  const throughputMbps = Number(obs.throughput ?? ((obs.throughput_kbps || 0) / 1000)) || 0
  const trafficGb = Number(obs.traffic ?? 0) || 0
  const ueCount = Math.min(maxUes, Math.max(30, Math.round(activeUsers * 1.25)))
  return {
    ue_count: ueCount,
    distribution: 'sector_weighted',
    dl_demand_mbps_total: Math.max(throughputMbps * 1.35, trafficGb * 4, ueCount * 0.4),
    application: 'full_buffer_downlink',
  }
}

function evaluateScenarioGuardrails({ targetCellName, observedKpis, neighbors, sameSite, maxUes }) {
  const errors = []
  const warnings = []

  if (!targetCellName) errors.push('target cell is missing')
  if (!Array.isArray(neighbors) || neighbors.length < MIN_NEIGHBORS) {
    warnings.push(`neighbor set is sparse (${Array.isArray(neighbors) ? neighbors.length : 0} < ${MIN_NEIGHBORS})`)
  }
  if (!Array.isArray(sameSite) || sameSite.length < 1) {
    warnings.push('same-site sector context is missing')
  }

  const prb = Number(observedKpis?.prb_load)
  const cqi = Number(observedKpis?.cqi)
  const users = Number(observedKpis?.active_users)
  const throughput = Number(observedKpis?.throughput_mbps)

  if (!Number.isFinite(prb) || prb < 0 || prb > 100) errors.push('observed prb_load must be within [0,100]')
  if (!Number.isFinite(cqi) || cqi < 0 || cqi > 30) errors.push('observed cqi must be within [0,30]')
  if (!Number.isFinite(users) || users < 0 || users > 2000) errors.push('observed active_users must be within [0,2000]')
  if (!Number.isFinite(throughput) || throughput < 0 || throughput > 2000) errors.push('observed throughput_mbps must be within [0,2000]')
  if (!Number.isFinite(maxUes) || maxUes < 10 || maxUes > DEFAULT_MAX_UES) errors.push(`max_ues must be within [10,${DEFAULT_MAX_UES}]`)

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

function bandwidthForBand(band) {
  if (/2600|L2600/i.test(band)) return 20
  if (/2100|L2100/i.test(band)) return 15
  if (/800|L800/i.test(band)) return 10
  return 10
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8')
  return JSON.parse(raw)
}

async function readOptionalJson(filePath) {
  try {
    return await readJson(filePath)
  } catch {
    return null
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasCoordinates(cell) {
  return Number.isFinite(Number(cell?.latitude)) && Number.isFinite(Number(cell?.longitude))
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)))
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const radius = 6371
  const dLat = toRad(Number(lat2) - Number(lat1))
  const dLon = toRad(Number(lon2) - Number(lon1))
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(Number(lat1))) * Math.cos(toRad(Number(lat2))) * Math.sin(dLon / 2) ** 2
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function toRad(degrees) {
  return Number(degrees) * Math.PI / 180
}
