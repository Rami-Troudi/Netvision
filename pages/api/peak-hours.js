import path from 'path'
import { access, readFile, writeFile } from 'fs/promises'
import { ParquetReader } from 'parquetjs-lite'
import { enforceRateLimit, requireAuthenticatedRequest } from './_lib/security'
import { getRuntimeDataRoot } from './_lib/dataMode'

const LOAD_COLUMN_CANDIDATES = ['load', 'prb_load', 'ft_physical_resource_blocks_load_dl']

let cachedPayload = null
let cachedMode = null

function getDataPaths() {
  const { root: dataDir, mode } = getRuntimeDataRoot()
  return {
    mode,
    timeIndexPath: path.resolve(dataDir, 'time_index.json'),
    timeDataDir: path.resolve(dataDir, 'time_data'),
    peakJsonPath: path.resolve(dataDir, 'peak_hours.json'),
    peakCsvPath: path.resolve(dataDir, 'peak_hours.csv'),
  }
}

export const config = {
  api: {
    bodyParser: false,
    responseLimit: false,
  },
}

function parseTimestampHour(timestamp) {
  const text = String(timestamp || '').trim()
  const match = text.match(/(\d{2}):(\d{2})$/)
  if (!match) return null
  const hour = Number.parseInt(match[1], 10)
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null
  return hour
}

function formatHour(hour) {
  const normalized = Math.max(0, Math.min(23, Number(hour) || 0))
  return `${String(normalized).padStart(2, '0')}:00`
}

async function fileExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function getNumericLoad(record) {
  for (const key of LOAD_COLUMN_CANDIDATES) {
    const raw = record?.[key]
    const value = Number(raw)
    if (Number.isFinite(value)) {
      return value
    }
  }
  return null
}

function toCsv(rows) {
  const header = 'cell_name,peak_hour,peak_avg_prb,samples'
  const lines = rows.map((row) => {
    const avg = Number.isFinite(row.peak_avg_prb) ? row.peak_avg_prb.toFixed(4) : ''
    return `${row.cell_name},${row.peak_hour},${avg},${row.samples}`
  })
  return [header, ...lines].join('\n')
}

function computeHourlyProfile(cellData) {
  const profile = Array(24).fill(null).map(() => ({ hour: 0, prb: 0, throughput: 0, cqi: 0, users: 0, count: 0 }))
  if (!cellData || !cellData.hourly) return profile
  for (const [hour, bucket] of Object.entries(cellData.hourly)) {
    const h = Number.parseInt(hour, 10)
    if (h >= 0 && h < 24 && bucket) {
      profile[h] = {
        hour: h,
        prb: Number(bucket.avg_prb) || 0,
        throughput: Number(bucket.avg_throughput) || 0,
        cqi: Number(bucket.avg_cqi) || 0,
        users: Number(bucket.avg_users) || 0,
        count: Number(bucket.count) || 0,
      }
    }
  }
  return profile
}

function computeRecurrenceRatio(cellData) {
  if (!cellData || !cellData.peak_days || cellData.peak_days.length === 0) return 0
  if (!cellData.total_days || cellData.total_days === 0) return 0
  return Math.min(1, cellData.peak_days.length / cellData.total_days)
}

function normalizeMetricValue(cell, metric) {
  const val = Number(cell?.[metric]) || 0
  if (metric === 'prb') return Math.max(0, Math.min(100, val))
  if (metric === 'active_users') return Math.max(0, val)
  if (metric === 'traffic') return Math.max(0, val)
  if (metric === 'congestion_rate') return cell?.prb >= 85 ? 100 : Math.max(0, Math.min(100, (cell?.prb || 0)))
  if (metric === 'throughput_drop') return cell?.throughput < 15 ? 100 - (cell?.throughput || 0) : 0
  if (metric === 'cqi_drop') return cell?.cqi < 8 ? 100 - ((cell?.cqi || 0) * 12.5) : 0
  if (metric === 'qos_degradation') {
    const factors = [
      (cell?.prb >= 85 ? 40 : 0),
      (cell?.throughput < 15 ? 30 : 0),
      (cell?.cqi < 8 ? 30 : 0),
    ]
    return Math.max(0, Math.min(100, factors.reduce((a, b) => a + b, 0)))
  }
  return 0
}

async function computePeakHoursFromTimeData() {
  const paths = getDataPaths()
  const rawIndex = await readFile(paths.timeIndexPath, 'utf8')
  const parsed = JSON.parse(rawIndex)
  const timestamps = Array.isArray(parsed?.timestamps) ? parsed.timestamps : []

  if (!timestamps.length) {
    throw new Error('time_index.json has no timestamps')
  }

  const aggregateByCell = new Map()

  for (const entry of timestamps) {
    const hour = parseTimestampHour(entry?.timestamp)
    const filename = String(entry?.filename || '').trim()
    if (hour === null || !filename) continue

    const slicePath = path.resolve(paths.timeDataDir, filename)
    if (!await fileExists(slicePath)) continue

    const records = []
    if (path.extname(slicePath).toLowerCase() === '.json') {
      const payload = JSON.parse(await readFile(slicePath, 'utf8'))
      for (const [cellName, obs] of Object.entries(payload?.observations || {})) {
        records.push({ ...obs, cell_name: cellName })
      }
    } else {
      const reader = await ParquetReader.openFile(slicePath)
      try {
        const cursor = reader.getCursor()
        let record = await cursor.next()
        while (record) {
          records.push(record)
          record = await cursor.next()
        }
      } finally {
        await reader.close()
      }
    }

    for (const record of records) {
      const cellName = String(record?.cell_name || '').trim()
      const load = getNumericLoad(record)
      if (cellName && load !== null) {
        let hourMap = aggregateByCell.get(cellName)
        if (!hourMap) {
          hourMap = new Map()
          aggregateByCell.set(cellName, hourMap)
        }
        const slot = hourMap.get(hour) || { sum: 0, count: 0 }
        slot.sum += load
        slot.count += 1
        hourMap.set(hour, slot)
      }
    }
  }

  const rows = []
  for (const [cellName, hourMap] of aggregateByCell.entries()) {
    let bestHour = null
    let bestAvg = Number.NEGATIVE_INFINITY
    let bestSamples = 0

    for (const [hour, bucket] of hourMap.entries()) {
      if (!bucket.count) continue
      const avg = bucket.sum / bucket.count
      if (
        avg > bestAvg ||
        (avg === bestAvg && bucket.count > bestSamples) ||
        (avg === bestAvg && bucket.count === bestSamples && (bestHour === null || hour < bestHour))
      ) {
        bestHour = hour
        bestAvg = avg
        bestSamples = bucket.count
      }
    }

    if (bestHour !== null && Number.isFinite(bestAvg)) {
      rows.push({
        cell_name: cellName,
        peak_hour: formatHour(bestHour),
        peak_avg_prb: Number(bestAvg.toFixed(4)),
        samples: bestSamples,
      })
    }
  }

  rows.sort((a, b) => a.cell_name.localeCompare(b.cell_name))

  return {
    generated_at: new Date().toISOString(),
    source: `${paths.mode} runtime data time_index.json + time_data`,
    total_cells: rows.length,
    rows,
  }
}

async function loadPeakPayload({ refresh = false } = {}) {
  const paths = getDataPaths()
  if (cachedMode !== paths.mode) {
    cachedPayload = null
    cachedMode = paths.mode
  }
  if (!refresh && cachedPayload) {
    return cachedPayload
  }

  if (!refresh && await fileExists(paths.peakJsonPath)) {
    const raw = await readFile(paths.peakJsonPath, 'utf8')
    const payload = JSON.parse(raw)
    if (Array.isArray(payload?.rows)) {
      cachedPayload = payload
      return payload
    }
  }

  const payload = await computePeakHoursFromTimeData()
  await writeFile(paths.peakJsonPath, JSON.stringify(payload, null, 2), 'utf8')
  await writeFile(paths.peakCsvPath, toCsv(payload.rows), 'utf8')
  cachedPayload = payload
  return payload
}

function parseLimit(rawLimit) {
  const parsed = Number.parseInt(String(rawLimit || ''), 10)
  if (!Number.isInteger(parsed) || parsed <= 0) return null
  return Math.min(parsed, 5000)
}

export default async function handler(req, res) {
  if (!requireAuthenticatedRequest(req, res)) return
  if (!enforceRateLimit(req, res, { keyPrefix: 'peak-hours', maxRequests: 20, windowMs: 60_000 })) return

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const refresh = String(req.query?.refresh || '').toLowerCase() === 'true' || String(req.query?.refresh || '') === '1'
  const groupBy = String(req.query?.group_by || 'cell').trim().toLowerCase()
  const metric = String(req.query?.metric || 'congestion_rate').trim().toLowerCase()
  const cellFilter = String(req.query?.cell || '').trim().toLowerCase()
  const limit = parseLimit(req.query?.limit)

  try {
    const payload = await loadPeakPayload({ refresh })
    let rows = payload.rows || []

    if (cellFilter) {
      rows = rows.filter((row) => row.cell_name.toLowerCase().includes(cellFilter))
    }

    if (limit) {
      rows = rows.slice(0, limit)
    }

    const enrichedRows = rows.map((row) => ({
      ...row,
      id: row.cell_name,
      name: row.cell_name,
      group_by: 'cell',
      peak_window: `${row.peak_hour}-${String(Math.min(23, Number.parseInt(row.peak_hour, 10) + 1)).padStart(2, '0')}:00`,
      peak_value: normalizeMetricValue(row, metric),
      avg_prb_at_peak: Number(row.peak_avg_prb) || 0,
      avg_throughput_at_peak: Number(row.throughput || 0),
      avg_cqi_at_peak: Number(row.cqi || 0),
      active_users_at_peak: Number(row.active_users || 0),
      traffic_at_peak: Number(row.traffic || 0),
      affected_cells_at_peak: 1,
      recurrence_ratio: computeRecurrenceRatio(row),
      samples: row.samples || 1,
      hourly_profile: computeHourlyProfile(row),
    }))

    return res.status(200).json({
      ...payload,
      group_by: groupBy,
      metric,
      total_returned: enrichedRows.length,
      rows: enrichedRows,
    })
  } catch (err) {
    console.error('Failed to load peak-hours payload:', err)
    return res.status(500).json({ error: 'Failed to load peak-hours data' })
  }
}
