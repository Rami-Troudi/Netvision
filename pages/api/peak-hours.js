import path from 'path'
import { access, readFile } from 'fs/promises'
import { ParquetReader } from 'parquetjs-lite'
import { enforceRateLimit, requireAuthenticatedRequest } from './_lib/security'
import { getRuntimeDataRoot } from './_lib/dataMode'
import { inferCongestedFromKpis } from '../../src/utils/v2Contracts.mjs'

const GROUPS = new Set(['cell', 'site', 'delegation', 'governorate', 'national'])
const METRICS = new Set(['prb', 'active_users', 'traffic', 'congestion_rate', 'throughput_drop', 'cqi_drop', 'qos_degradation'])

let cachedRaw = null
let cachedMode = null

export const config = {
  api: { bodyParser: false, responseLimit: false },
}

function paths() {
  const { root, mode } = getRuntimeDataRoot()
  return {
    mode,
    root,
    baseline: path.resolve(root, 'baseline.json'),
    timeIndex: path.resolve(root, 'time_index.json'),
    timeData: path.resolve(root, 'time_data'),
    adminIndex: path.resolve(root, 'admin_cell_index.json'),
  }
}

async function exists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function n(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseHour(timestamp) {
  const match = String(timestamp || '').match(/(\d{2}):(\d{2})$/)
  if (!match) return null
  const hour = Number.parseInt(match[1], 10)
  return hour >= 0 && hour <= 23 ? hour : null
}

function hourLabel(hour) {
  return `${String(Math.max(0, Math.min(23, hour))).padStart(2, '0')}:00`
}

function normalizeObs(record = {}) {
  const prb = n(record.prb_load ?? record.prb ?? record.dl_prb_load ?? record.load ?? record.ft_physical_resource_blocks_load_dl)
  const throughputRaw = n(record.throughput_kbps ?? record.throughput ?? record.dl_throughput ?? record.user_throughput ?? record.avg_throughput)
  const throughputKbps = throughputRaw > 1000 ? throughputRaw : throughputRaw * 1000
  const throughput = throughputKbps / 1000
  const cqi = n(record.cqi ?? record.avg_cqi)
  const activeUsers = n(record.active_users ?? record.rrc_connected_users ?? record.users ?? record.rrc_users)
  const traffic = n(record.traffic ?? record.data_traffic ?? record.dl_traffic_gb)
  const ta = n(record.ta ?? record.avg_ta ?? record.timing_advance)
  const congested = Boolean(record.congested) || inferCongestedFromKpis({ prbLoad: prb, throughputKbps, activeUsers })
  const qosDegraded = congested || throughput < 15 || cqi < 8
  return {
    prb,
    throughput_kbps: throughputKbps,
    throughput,
    cqi,
    active_users: activeUsers,
    traffic,
    ta,
    congested,
    qos_degraded: qosDegraded,
  }
}

function metricValue(bucket, metric) {
  if (metric === 'prb') return bucket.avg_prb
  if (metric === 'active_users') return bucket.active_users
  if (metric === 'traffic') return bucket.traffic
  if (metric === 'congestion_rate') return bucket.congestion_rate
  if (metric === 'throughput_drop') return Math.max(0, 25 - bucket.avg_throughput)
  if (metric === 'cqi_drop') return Math.max(0, 10 - bucket.avg_cqi) * 10
  if (metric === 'qos_degradation') {
    return Math.min(100, (bucket.avg_prb >= 85 ? 35 : 0) + (bucket.avg_throughput < 15 ? 35 : 0) + (bucket.avg_cqi < 8 ? 30 : 0))
  }
  return bucket.congestion_rate
}

function emptyPayload(groupBy, metric, reason) {
  return {
    available: false,
    reason,
    group_by: groupBy,
    metric,
    total_returned: 0,
    summary: null,
    rows: [],
  }
}

async function readSlice(slicePath) {
  if (path.extname(slicePath).toLowerCase() === '.json') {
    const payload = JSON.parse(await readFile(slicePath, 'utf8'))
    return Object.entries(payload?.observations || {}).map(([cellName, obs]) => ({ cell_name: cellName, ...obs }))
  }

  const rows = []
  const reader = await ParquetReader.openFile(slicePath)
  try {
    const cursor = reader.getCursor()
    let record = await cursor.next()
    while (record) {
      rows.push(record)
      record = await cursor.next()
    }
  } finally {
    await reader.close()
  }
  return rows
}

async function loadRaw(refresh = false) {
  const p = paths()
  if (!refresh && cachedRaw && cachedMode === p.mode) return cachedRaw
  cachedMode = p.mode

  if (!await exists(p.timeIndex)) {
    cachedRaw = { mode: p.mode, generated_at: new Date().toISOString(), observations: [], unavailable_reason: `time_index.json is missing in ${p.root}. Run the runtime data processing pipeline or switch data mode.` }
    return cachedRaw
  }

  const [timeIndexRaw, baselineRaw, adminRaw] = await Promise.all([
    readFile(p.timeIndex, 'utf8'),
    readFile(p.baseline, 'utf8').catch(() => '{}'),
    readFile(p.adminIndex, 'utf8').catch(() => '{}'),
  ])
  const timeIndex = JSON.parse(timeIndexRaw)
  const baseline = JSON.parse(baselineRaw)
  const adminIndex = JSON.parse(adminRaw)
  const timestamps = Array.isArray(timeIndex?.timestamps) ? timeIndex.timestamps : []
  if (!timestamps.length) {
    cachedRaw = { mode: p.mode, generated_at: new Date().toISOString(), observations: [], unavailable_reason: `time_index.json has no timestamps in ${p.root}.` }
    return cachedRaw
  }
  const observations = []

  for (const entry of timestamps) {
    const hour = parseHour(entry.timestamp)
    const filename = String(entry.filename || '').trim()
    if (hour === null || !filename) continue
    const slicePath = path.resolve(p.timeData, filename)
    if (!await exists(slicePath)) continue
    const rows = await readSlice(slicePath)
    for (const row of rows) {
      const cellName = String(row.cell_name || '').trim()
      if (!cellName) continue
      const base = baseline[cellName] || {}
      const admin = adminIndex[cellName] || base.admin || {}
      observations.push({
        cell_name: cellName,
        site_name: base.site_name || base.enodeb_name || row.site_name || cellName,
        gov_id: admin.gov_id || '',
        gov_name: admin.gov_name || '',
        deleg_id: admin.deleg_id || '',
        deleg_name: admin.deleg_name || '',
        timestamp: entry.timestamp,
        hour,
        ...normalizeObs(row),
      })
    }
  }

  cachedRaw = { mode: p.mode, generated_at: new Date().toISOString(), observations, unavailable_reason: observations.length ? '' : `No readable time_data slices were found from ${p.timeData}.` }
  return cachedRaw
}

function passFilters(row, query) {
  if (query.gov_id && row.gov_id !== query.gov_id) return false
  if (query.deleg_id && row.deleg_id !== query.deleg_id) return false
  if (query.site_name && row.site_name !== query.site_name) return false
  if (query.cell_name && row.cell_name !== query.cell_name) return false
  return true
}

function groupIdentity(row, groupBy) {
  if (groupBy === 'national') return { id: 'TN', name: 'Tunisia' }
  if (groupBy === 'governorate') return { id: row.gov_id || 'unknown-governorate', name: row.gov_name || row.gov_id || 'Unknown governorate' }
  if (groupBy === 'delegation') return { id: row.deleg_id || 'unknown-delegation', name: row.deleg_name || row.deleg_id || 'Unknown delegation' }
  if (groupBy === 'site') return { id: row.site_name || 'unknown-site', name: row.site_name || 'Unknown site' }
  return { id: row.cell_name, name: row.cell_name }
}

function makeEmptyHourly() {
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    label: hourLabel(hour),
    samples: 0,
    avg_prb: 0,
    avg_throughput: 0,
    avg_cqi: 0,
    active_users: 0,
    traffic: 0,
    congestion_rate: 0,
    affected_cells: 0,
    metric_value: 0,
  }))
}

function finalizeBucket(bucket, metric) {
  const samples = bucket.samples || 0
  const affected = bucket.affectedCells.size
  const avgPrb = samples ? bucket.prbSum / samples : 0
  const avgThroughput = samples ? bucket.throughputSum / samples : 0
  const avgCqi = samples ? bucket.cqiSum / samples : 0
  const out = {
    hour: bucket.hour,
    label: hourLabel(bucket.hour),
    samples,
    avg_prb: avgPrb,
    avg_throughput: avgThroughput,
    avg_cqi: avgCqi,
    active_users: bucket.activeUsers,
    traffic: bucket.traffic,
    congestion_rate: bucket.cells.size ? (affected / bucket.cells.size) * 100 : 0,
    affected_cells: affected,
  }
  out.metric_value = metricValue(out, metric)
  return out
}

function analyzeGroups(rows, groupBy, metric) {
  const groups = new Map()

  for (const row of rows) {
    const identity = groupIdentity(row, groupBy)
    if (!groups.has(identity.id)) {
      groups.set(identity.id, {
        id: identity.id,
        name: identity.name,
        group_by: groupBy,
        buckets: Array.from({ length: 24 }, (_, hour) => ({
          hour,
          samples: 0,
          prbSum: 0,
          throughputSum: 0,
          cqiSum: 0,
          activeUsers: 0,
          traffic: 0,
          cells: new Set(),
          affectedCells: new Set(),
        })),
        observedCells: new Set(),
      })
    }
    const group = groups.get(identity.id)
    const bucket = group.buckets[row.hour]
    bucket.samples += 1
    bucket.prbSum += row.prb
    bucket.throughputSum += row.throughput
    bucket.cqiSum += row.cqi
    bucket.activeUsers += row.active_users
    bucket.traffic += row.traffic
    bucket.cells.add(row.cell_name)
    group.observedCells.add(row.cell_name)
    if (row.qos_degraded) bucket.affectedCells.add(row.cell_name)
  }

  return Array.from(groups.values()).map((group) => {
    const profile = group.buckets.map((bucket) => finalizeBucket(bucket, metric))
    const populated = profile.filter((bucket) => bucket.samples > 0)
    if (!populated.length) {
      return { id: group.id, name: group.name, group_by: groupBy, peak_hour: null, peak_window: null, peak_value: 0, hourly_profile: makeEmptyHourly(), samples: 0 }
    }
    const peak = populated.slice().sort((a, b) => b.metric_value - a.metric_value || b.samples - a.samples || a.hour - b.hour)[0]
    const threshold = Math.max(1, peak.metric_value * 0.8)
    const recurrentBuckets = populated.filter((bucket) => bucket.metric_value >= threshold && bucket.affected_cells > 0)
    const recurrenceRatio = populated.length ? recurrentBuckets.length / populated.length : 0
    const consecutive = longestConsecutive(recurrentBuckets.map((bucket) => bucket.hour))
    return {
      id: group.id,
      name: group.name,
      group_by: groupBy,
      peak_hour: peak.label,
      peak_window: `${peak.label}-${hourLabel(Math.min(23, peak.hour + 1))}`,
      peak_value: peak.metric_value,
      avg_prb_at_peak: peak.avg_prb,
      avg_throughput_at_peak: peak.avg_throughput,
      avg_cqi_at_peak: peak.avg_cqi,
      active_users_at_peak: peak.active_users,
      traffic_at_peak: peak.traffic,
      affected_cells_at_peak: peak.affected_cells,
      recurrence_ratio: recurrenceRatio,
      peak_days_count: recurrentBuckets.length,
      consecutive_peak_hours: consecutive,
      structural_busy_hour_flag: recurrenceRatio > 0.6,
      samples: populated.reduce((sum, bucket) => sum + bucket.samples, 0),
      hourly_profile: profile,
    }
  }).sort((a, b) => b.peak_value - a.peak_value || b.affected_cells_at_peak - a.affected_cells_at_peak)
}

function longestConsecutive(hours) {
  const set = new Set(hours)
  let best = 0
  for (const hour of set) {
    if (set.has(hour - 1)) continue
    let length = 1
    while (set.has(hour + length)) length += 1
    best = Math.max(best, length)
  }
  return best
}

function summarize(rows, metric) {
  if (!rows.length) return null
  const top = rows[0]
  return {
    peak_hour: top.peak_hour,
    peak_window: top.peak_window,
    peak_value: top.peak_value,
    avg_prb_at_peak: top.avg_prb_at_peak,
    peak_congestion_rate: top.hourly_profile?.find((h) => h.label === top.peak_hour)?.congestion_rate || 0,
    active_users_at_peak: top.active_users_at_peak,
    affected_cells_at_peak: top.affected_cells_at_peak,
    recurrence_ratio: rows.reduce((sum, row) => sum + (row.recurrence_ratio || 0), 0) / rows.length,
    structural_busy_hour_count: rows.filter((row) => row.structural_busy_hour_flag).length,
    metric,
  }
}

export default async function handler(req, res) {
  if (!requireAuthenticatedRequest(req, res)) return
  if (!enforceRateLimit(req, res, { keyPrefix: 'peak-hours', maxRequests: 60, windowMs: 60_000 })) return
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const groupBy = GROUPS.has(String(req.query.group_by || '').toLowerCase()) ? String(req.query.group_by).toLowerCase() : 'cell'
  const metric = METRICS.has(String(req.query.metric || '').toLowerCase()) ? String(req.query.metric).toLowerCase() : 'congestion_rate'
  const limit = Math.min(5000, Math.max(1, Number.parseInt(String(req.query.limit || '100'), 10) || 100))
  const refresh = ['true', '1'].includes(String(req.query.refresh || '').toLowerCase())
  const query = {
    gov_id: String(req.query.gov_id || '').trim(),
    deleg_id: String(req.query.deleg_id || '').trim(),
    site_name: String(req.query.site_name || '').trim(),
    cell_name: String(req.query.cell_name || req.query.cell || '').trim(),
  }

  try {
    const raw = await loadRaw(refresh)
    if (!raw.observations.length) return res.status(200).json(emptyPayload(groupBy, metric, raw.unavailable_reason || 'No peak-hour samples are available.'))
    const scoped = raw.observations.filter((row) => passFilters(row, query))
    if (!scoped.length) return res.status(200).json(emptyPayload(groupBy, metric, 'No peak-hour samples match the selected scope.'))
    const rows = analyzeGroups(scoped, groupBy, metric).slice(0, limit)
    return res.status(200).json({
      available: true,
      generated_at: raw.generated_at,
      source: `${raw.mode} runtime data time_index.json + time_data`,
      group_by: groupBy,
      metric,
      filters: query,
      total_returned: rows.length,
      summary: summarize(rows, metric),
      rows,
    })
  } catch (err) {
    console.error('Failed to load peak-hours payload:', err)
    return res.status(200).json(emptyPayload(groupBy, metric, err.message || 'Failed to load peak-hours data.'))
  }
}
