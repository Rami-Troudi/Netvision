import path from 'path'
import { stat } from 'fs/promises'
import { ParquetReader } from 'parquetjs-lite'
import { enforceRateLimit, requireAuthenticatedRequest } from './_lib/security'

const VAL_PREDICTIONS_PATH = path.resolve(process.cwd(), 'runtime_data', 'model_assets', 'val_predictions.parquet')

const DEFAULT_ABS_THRESHOLD = Number.parseFloat(process.env.DRIFT_ABS_PRB_THRESHOLD || '15')
const DEFAULT_PCT_THRESHOLD = Number.parseFloat(process.env.DRIFT_PCT_PRB_THRESHOLD || '30')
const DEFAULT_LIMIT = 100

let driftCache = {
  mtimeMs: 0,
  rows: [],
}

export const config = {
  api: {
    bodyParser: false,
    responseLimit: false,
  },
}

function parseNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function parseDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  const asDate = new Date(value)
  return Number.isNaN(asDate.getTime()) ? null : asDate
}

function isBigIntMixError(error) {
  const message = error instanceof Error ? error.message : String(error || '')
  const normalized = message.toLowerCase()
  return normalized.includes('cannot mix bigint') || normalized.includes('bigint')
}

async function safeCursorNext(cursor) {
  try {
    return await cursor.next()
  } catch (error) {
    if (!isBigIntMixError(error)) {
      throw error
    }

    console.warn('Drift parquet decode hit BigInt incompatibility; returning partial/empty alerts for this cycle.')
    return null
  }
}

function parsePositiveNumber(raw, fallbackValue) {
  const parsed = Number.parseFloat(String(raw ?? ''))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackValue
}

function parseLimit(raw) {
  const parsed = Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_LIMIT
  return Math.min(parsed, 2000)
}

function getSeverity(absDelta, pctDelta, absThreshold, pctThreshold) {
  if (absDelta >= absThreshold * 2 || pctDelta >= pctThreshold * 2) return 'critical'
  if (absDelta >= absThreshold || pctDelta >= pctThreshold) return 'high'
  return 'medium'
}

async function computeDriftRows() {
  const byCell = new Map()
  const reader = await ParquetReader.openFile(VAL_PREDICTIONS_PATH)

  try {
    const cursor = reader.getCursor()
    let record = await safeCursorNext(cursor)

    while (record) {
      const cellName = String(record?.CELLNAME || '').trim()
      const enodeb = String(record?.ENODEB_NAME || '').trim()
      const actualPrb = parseNumber(record?.y_true_prb)
      const predictedPrb = parseNumber(record?.y_pred_prb)
      const timestamp = parseDate(record?.DATE_ID)

      if (!cellName || actualPrb === null || predictedPrb === null) {
        record = await safeCursorNext(cursor)
        continue
      }

      const absDelta = Math.abs(actualPrb - predictedPrb)
      const pctDelta = (absDelta / Math.max(1, Math.abs(predictedPrb))) * 100

      let bucket = byCell.get(cellName)
      if (!bucket) {
        bucket = {
          cell_name: cellName,
          enodeb_name: enodeb,
          samples: 0,
          abs_delta_sum: 0,
          pct_delta_sum: 0,
          max_abs_delta: 0,
          max_pct_delta: 0,
          last_timestamp: null,
          last_actual_prb: null,
          last_predicted_prb: null,
          last_abs_delta: null,
          last_pct_delta: null,
        }
        byCell.set(cellName, bucket)
      }

      bucket.samples += 1
      bucket.abs_delta_sum += absDelta
      bucket.pct_delta_sum += pctDelta
      if (absDelta > bucket.max_abs_delta) bucket.max_abs_delta = absDelta
      if (pctDelta > bucket.max_pct_delta) bucket.max_pct_delta = pctDelta

      if (!timestamp || !Number.isFinite(timestamp.getTime())) {
        record = await safeCursorNext(cursor)
        continue
      }

      const lastTs = bucket.last_timestamp ? new Date(bucket.last_timestamp) : null
      if (!lastTs || timestamp.getTime() >= lastTs.getTime()) {
        bucket.last_timestamp = timestamp.toISOString()
        bucket.last_actual_prb = Number(actualPrb.toFixed(4))
        bucket.last_predicted_prb = Number(predictedPrb.toFixed(4))
        bucket.last_abs_delta = Number(absDelta.toFixed(4))
        bucket.last_pct_delta = Number(pctDelta.toFixed(4))
      }

      record = await safeCursorNext(cursor)
    }
  } finally {
    await reader.close()
  }

  const rows = Array.from(byCell.values()).map((bucket) => {
    const meanAbs = bucket.samples ? bucket.abs_delta_sum / bucket.samples : 0
    const meanPct = bucket.samples ? bucket.pct_delta_sum / bucket.samples : 0
    return {
      cell_name: bucket.cell_name,
      enodeb_name: bucket.enodeb_name,
      samples: bucket.samples,
      mean_abs_delta: Number(meanAbs.toFixed(4)),
      mean_pct_delta: Number(meanPct.toFixed(4)),
      max_abs_delta: Number(bucket.max_abs_delta.toFixed(4)),
      max_pct_delta: Number(bucket.max_pct_delta.toFixed(4)),
      last_timestamp: bucket.last_timestamp,
      last_actual_prb: bucket.last_actual_prb,
      last_predicted_prb: bucket.last_predicted_prb,
      last_abs_delta: bucket.last_abs_delta,
      last_pct_delta: bucket.last_pct_delta,
    }
  })

  rows.sort((a, b) => {
    const aDelta = Number(a.last_abs_delta || 0)
    const bDelta = Number(b.last_abs_delta || 0)
    if (bDelta !== aDelta) return bDelta - aDelta
    return b.mean_abs_delta - a.mean_abs_delta
  })

  return rows
}

async function loadDriftRows() {
  let info
  try {
    info = await stat(VAL_PREDICTIONS_PATH)
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return null
    }
    throw err
  }

  if (driftCache.rows.length && driftCache.mtimeMs === info.mtimeMs) {
    return driftCache.rows
  }

  const rows = await computeDriftRows()
  driftCache = {
    mtimeMs: info.mtimeMs,
    rows,
  }
  return rows
}

export default async function handler(req, res) {
  if (!requireAuthenticatedRequest(req, res)) return
  if (!enforceRateLimit(req, res, { keyPrefix: 'drift', maxRequests: 20, windowMs: 60_000 })) return

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const absThreshold = parsePositiveNumber(req.query?.abs_threshold, DEFAULT_ABS_THRESHOLD)
  const pctThreshold = parsePositiveNumber(req.query?.pct_threshold, DEFAULT_PCT_THRESHOLD)
  const limit = parseLimit(req.query?.limit)

  try {
    const rows = await loadDriftRows()
    if (rows === null) {
      return res.status(200).json({
        generated_at: new Date().toISOString(),
        source: 'runtime_data/model_assets/val_predictions.parquet',
        available: false,
        reason: 'Drift model artifacts are not available for this runtime dataset.',
        thresholds: {
          abs_prb_delta: absThreshold,
          pct_prb_delta: pctThreshold,
        },
        total_cells: 0,
        alert_cells: 0,
        alerts: [],
      })
    }

    const enrichedRows = rows.map((row) => {
      const absDelta = Number(row.last_abs_delta || 0)
      const pctDelta = Number(row.last_pct_delta || 0)
      const isAlert = absDelta >= absThreshold || pctDelta >= pctThreshold
      return {
        ...row,
        is_alert: isAlert,
        severity: getSeverity(absDelta, pctDelta, absThreshold, pctThreshold),
      }
    })

    const alerts = enrichedRows
      .filter((row) => row.is_alert)
      .sort((a, b) => {
        const delta = Number(b.last_abs_delta || 0) - Number(a.last_abs_delta || 0)
        if (delta !== 0) return delta
        return Number(b.mean_abs_delta || 0) - Number(a.mean_abs_delta || 0)
      })
      .slice(0, limit)

    return res.status(200).json({
      generated_at: new Date().toISOString(),
      source: 'runtime_data/model_assets/val_predictions.parquet',
      available: true,
      thresholds: {
        abs_prb_delta: absThreshold,
        pct_prb_delta: pctThreshold,
      },
      total_cells: enrichedRows.length,
      alert_cells: alerts.length,
      alerts,
    })
  } catch (err) {
    console.error('Failed to compute drift alerts:', err)
    return res.status(500).json({ error: 'Failed to compute drift alerts' })
  }
}
