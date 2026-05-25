import path from 'path'
import { readFile } from 'fs/promises'
import { enforceRateLimit, requireAuthenticatedRequest } from './_lib/security'
import { getRuntimeDataRoot } from './_lib/dataMode'

function n(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function keyOf(cell, ts) {
  return `${cell}::${ts}`
}

export default async function handler(req, res) {
  if (!requireAuthenticatedRequest(req, res)) return
  if (!enforceRateLimit(req, res, { keyPrefix: 'drift', maxRequests: 20, windowMs: 60_000 })) return
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const absThreshold = Math.max(1, Number.parseFloat(String(req.query?.abs_threshold ?? '15')) || 15)
  const pctThreshold = Math.max(1, Number.parseFloat(String(req.query?.pct_threshold ?? '30')) || 30)
  const limit = Math.max(1, Math.min(2000, Number.parseInt(String(req.query?.limit ?? '200'), 10) || 200))

  try {
    const { root, mode } = getRuntimeDataRoot()
    const forecastIndexPath = path.resolve(root, 'forecast_index.json')
    const timeIndexPath = path.resolve(root, 'time_index.json')
    const [forecastIndexRaw, timeIndexRaw] = await Promise.all([
      readFile(forecastIndexPath, 'utf8'),
      readFile(timeIndexPath, 'utf8'),
    ])
    const forecastIndex = JSON.parse(forecastIndexRaw)
    const timeIndex = JSON.parse(timeIndexRaw)
    const timeSet = new Set((timeIndex?.timestamps || []).map((x) => x?.timestamp).filter(Boolean))
    const entries = (forecastIndex || []).filter((x) => timeSet.has(x.timestamp)).slice(0, limit)
    if (!entries.length) {
      return res.status(200).json({
        available: false,
        mode,
        reason: 'Aucun overlap forecast/observed pour calculer le drift.',
        thresholds: { abs_prb_delta: absThreshold, pct_prb_delta: pctThreshold },
        total_cells: 0,
        alert_cells: 0,
        alerts: [],
      })
    }
    const agg = new Map()
    for (const entry of entries) {
      const forecastPath = path.resolve(root, 'forecast_data', entry.filename)
      const observedPath = path.resolve(root, 'time_data', entry.filename.replace(/\.parquet$/i, '.json'))
      let forecastObs = {}
      let observedObs = {}
      try {
        forecastObs = JSON.parse(await readFile(forecastPath, 'utf8'))?.observations || {}
      } catch { continue }
      try {
        observedObs = JSON.parse(await readFile(observedPath, 'utf8'))?.observations || {}
      } catch { continue }
      for (const [cell, f] of Object.entries(forecastObs)) {
        const o = observedObs[cell]
        if (!o) continue
        const pred = n(f.prb_load ?? f.prb)
        const actual = n(o.prb_load ?? o.prb)
        const abs = Math.abs(actual - pred)
        const pct = (abs / Math.max(1, Math.abs(pred))) * 100
        const k = keyOf(cell, entry.timestamp)
        agg.set(k, { cell_name: cell, timestamp: entry.timestamp, last_abs_delta: abs, last_pct_delta: pct, last_actual_prb: actual, last_predicted_prb: pred })
      }
    }
    const byCell = new Map()
    for (const row of agg.values()) {
      const prev = byCell.get(row.cell_name)
      if (!prev) {
        byCell.set(row.cell_name, { ...row, samples: 1, abs_sum: row.last_abs_delta, pct_sum: row.last_pct_delta, max_abs_delta: row.last_abs_delta })
      } else {
        prev.samples += 1
        prev.abs_sum += row.last_abs_delta
        prev.pct_sum += row.last_pct_delta
        prev.max_abs_delta = Math.max(prev.max_abs_delta, row.last_abs_delta)
        if (row.timestamp >= prev.timestamp) Object.assign(prev, row)
      }
    }
    const rows = Array.from(byCell.values()).map((row) => {
      const meanAbs = row.samples ? row.abs_sum / row.samples : 0
      const meanPct = row.samples ? row.pct_sum / row.samples : 0
      const isAlert = row.last_abs_delta >= absThreshold || row.last_pct_delta >= pctThreshold
      const severity = row.last_abs_delta >= absThreshold * 2 || row.last_pct_delta >= pctThreshold * 2 ? 'critical' : (isAlert ? 'high' : 'medium')
      return {
        cell_name: row.cell_name,
        samples: row.samples,
        mean_abs_delta: Number(meanAbs.toFixed(2)),
        mean_pct_delta: Number(meanPct.toFixed(2)),
        max_abs_delta: Number(row.max_abs_delta.toFixed(2)),
        last_timestamp: row.timestamp,
        last_actual_prb: Number(row.last_actual_prb.toFixed(2)),
        last_predicted_prb: Number(row.last_predicted_prb.toFixed(2)),
        last_abs_delta: Number(row.last_abs_delta.toFixed(2)),
        last_pct_delta: Number(row.last_pct_delta.toFixed(2)),
        is_alert: isAlert,
        severity,
      }
    }).sort((a, b) => b.last_abs_delta - a.last_abs_delta)

    const alerts = rows.filter((r) => r.is_alert).slice(0, limit)
    return res.status(200).json({
      available: true,
      mode,
      source: `${root}/forecast_data + ${root}/time_data`,
      generated_at: new Date().toISOString(),
      thresholds: { abs_prb_delta: absThreshold, pct_prb_delta: pctThreshold },
      total_cells: rows.length,
      alert_cells: alerts.length,
      alerts,
    })
  } catch (err) {
    return res.status(200).json({
      available: false,
      reason: err instanceof Error ? err.message : String(err),
      thresholds: { abs_prb_delta: absThreshold, pct_prb_delta: pctThreshold },
      total_cells: 0,
      alert_cells: 0,
      alerts: [],
    })
  }
}

