import path from 'path'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { enforceRateLimit, requireAuthenticatedRequest } from './_lib/security'
import { getRuntimeDataRoot } from './_lib/dataMode'

function n(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function hourFromTs(ts = '') {
  const m = String(ts).match(/(\d{2}):\d{2}$/)
  return m ? Number.parseInt(m[1], 10) : 0
}

function dowFromTs(ts = '') {
  const m = String(ts).match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})$/)
  if (!m) return 0
  const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]), Number(m[5]), 0))
  return d.getUTCDay()
}

async function loadRuntime() {
  const { root, mode } = getRuntimeDataRoot()
  const [baselineRaw, indexRaw] = await Promise.all([
    readFile(path.resolve(root, 'baseline.json'), 'utf8'),
    readFile(path.resolve(root, 'time_index.json'), 'utf8'),
  ])
  const baseline = JSON.parse(baselineRaw)
  const index = JSON.parse(indexRaw)
  return { root, mode, baseline, index }
}

function profileForCell(cellName, slices) {
  const byHour = new Map()
  const byDowHour = new Map()
  for (const slice of slices) {
    const obs = slice?.observations?.[cellName]
    if (!obs) continue
    const h = hourFromTs(slice.timestamp)
    const d = dowFromTs(slice.timestamp)
    const key = `${d}:${h}`
    const hourBucket = byHour.get(h) || { count: 0, prb: 0, cqi: 0, throughput: 0, users: 0 }
    hourBucket.count += 1
    hourBucket.prb += n(obs.prb_load ?? obs.prb)
    hourBucket.cqi += n(obs.cqi)
    hourBucket.throughput += n(obs.throughput ?? obs.throughput_kbps) > 1000 ? n(obs.throughput ?? obs.throughput_kbps) / 1000 : n(obs.throughput ?? obs.throughput_kbps)
    hourBucket.users += n(obs.active_users ?? obs.rrc_users ?? obs.users)
    byHour.set(h, hourBucket)
    const dowBucket = byDowHour.get(key) || { ...hourBucket, count: 0, prb: 0, cqi: 0, throughput: 0, users: 0 }
    dowBucket.count += 1
    dowBucket.prb += n(obs.prb_load ?? obs.prb)
    dowBucket.cqi += n(obs.cqi)
    dowBucket.throughput += n(obs.throughput ?? obs.throughput_kbps) > 1000 ? n(obs.throughput ?? obs.throughput_kbps) / 1000 : n(obs.throughput ?? obs.throughput_kbps)
    dowBucket.users += n(obs.active_users ?? obs.rrc_users ?? obs.users)
    byDowHour.set(key, dowBucket)
  }
  return { byHour, byDowHour }
}

function avg(bucket, key, fallback) {
  if (!bucket || !bucket.count) return fallback
  return bucket[key] / bucket.count
}

export default async function handler(req, res) {
  if (!requireAuthenticatedRequest(req, res)) return
  if (!enforceRateLimit(req, res, { keyPrefix: 'forecast', maxRequests: 10, windowMs: 60_000 })) return

  const { root, mode } = await loadRuntime().catch(() => ({ root: '', mode: 'real' }))
  const forecastDir = root ? path.resolve(root, 'forecast_data') : ''
  const forecastIndexPath = root ? path.resolve(root, 'forecast_index.json') : ''

  if (req.method === 'GET') {
    try {
      const raw = await readFile(forecastIndexPath, 'utf8')
      const parsed = JSON.parse(raw)
      return res.status(200).json({ success: true, available: true, mode, forecasts: parsed, generated_at: new Date().toISOString() })
    } catch {
      return res.status(200).json({ success: true, available: false, mode, forecasts: [], reason: 'Forecast indisponible. Lancez une generation.' })
    }
  }

  if (req.method === 'DELETE') {
    try {
      await rm(forecastDir, { recursive: true, force: true })
      await rm(forecastIndexPath, { force: true })
    } catch {}
    return res.status(200).json({ success: true, available: false, mode })
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const days = Math.max(1, Math.min(7, Number.parseInt(String(req.body?.days ?? '1'), 10) || 1))
    const runtime = await loadRuntime()
    const timestamps = Array.isArray(runtime.index?.timestamps) ? runtime.index.timestamps : []
    const recent = timestamps.slice(Math.max(0, timestamps.length - 168))
    const loaded = []
    for (const entry of recent) {
      const file = path.resolve(runtime.root, 'time_data', entry.filename || '')
      try {
        const raw = await readFile(file, 'utf8')
        const payload = JSON.parse(raw)
        loaded.push({ timestamp: entry.timestamp, observations: payload?.observations || {} })
      } catch {}
    }
    const cellNames = Object.keys(runtime.baseline || {})
    const baseTs = recent.length ? recent[recent.length - 1].timestamp : '01-01-2026 00:00'
    const [dd, mm, yyyy, hh, min] = String(baseTs).match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})$/)?.slice(1) || ['01', '01', '2026', '00', '00']
    const baseDate = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min), 0))
    const forecastRows = []
    for (const cell of cellNames) {
      const profile = profileForCell(cell, loaded)
      const lastObs = [...loaded].reverse().find((s) => s.observations?.[cell])?.observations?.[cell] || {}
      const lastPrb = n(lastObs.prb_load ?? lastObs.prb, 45)
      const lastCqi = n(lastObs.cqi, 9)
      const lastThp = n(lastObs.throughput ?? lastObs.throughput_kbps, 20)
      const lastUsers = n(lastObs.active_users ?? lastObs.users, 4)
      for (let i = 1; i <= days * 24; i += 1) {
        const dt = new Date(baseDate.getTime() + i * 3600_000)
        const h = dt.getUTCHours()
        const d = dt.getUTCDay()
        const key = `${d}:${h}`
        const bucket = profile.byDowHour.get(key) || profile.byHour.get(h)
        const prb = Math.max(0, Math.min(100, avg(bucket, 'prb', lastPrb) * 0.85 + lastPrb * 0.15))
        const cqi = Math.max(1, Math.min(15, avg(bucket, 'cqi', lastCqi) * 0.8 + lastCqi * 0.2))
        const throughput = Math.max(0.1, avg(bucket, 'throughput', lastThp))
        const users = Math.max(0, avg(bucket, 'users', lastUsers))
        const congested = prb >= 80 && (throughput < 18 || cqi < 8)
        forecastRows.push({
          cell_name: cell,
          timestamp: `${String(dt.getUTCDate()).padStart(2, '0')}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${dt.getUTCFullYear()} ${String(h).padStart(2, '0')}:00`,
          prb_load: Number(prb.toFixed(2)),
          cqi: Number(cqi.toFixed(2)),
          throughput_mbps: Number(throughput.toFixed(2)),
          active_users: Number(users.toFixed(0)),
          congested,
          confidence: bucket ? 'medium' : 'low',
          is_forecast: true,
        })
      }
    }
    await mkdir(forecastDir, { recursive: true })
    const byTs = new Map()
    for (const row of forecastRows) {
      if (!byTs.has(row.timestamp)) byTs.set(row.timestamp, [])
      byTs.get(row.timestamp).push(row)
    }
    const index = []
    for (const [timestamp, rows] of byTs.entries()) {
      const filename = `${timestamp.replace(/\s+/g, '_').replace(/:/g, '-')}.json`
      await writeFile(path.resolve(forecastDir, filename), JSON.stringify({ observations: Object.fromEntries(rows.map((r) => [r.cell_name, r])) }), 'utf8')
      index.push({ timestamp, filename, kind: 'forecast' })
    }
    await writeFile(forecastIndexPath, JSON.stringify(index, null, 2), 'utf8')
    return res.status(200).json({ success: true, available: true, mode, generated_at: new Date().toISOString(), forecasts_count: forecastRows.length, files: index.length })
  } catch (err) {
    return res.status(500).json({ success: false, available: false, error: err instanceof Error ? err.message : String(err) })
  }
}

