import { enforceRateLimit, requireAuthenticatedRequest } from './_lib/security'

const BACKEND_BASE_URL = (process.env.BACKEND_API_URL || 'http://127.0.0.1:8000').trim()
const BACKEND_TIMEOUT_MS = Number.parseInt(process.env.BACKEND_API_TIMEOUT_MS || '15000', 10)

function normalizeCellName(raw) {
  if (typeof raw !== 'string') return ''
  return raw.trim()
}

async function fetchBackendRecommendation(cellName) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Number.isFinite(BACKEND_TIMEOUT_MS) ? BACKEND_TIMEOUT_MS : 15000)

  try {
    const response = await fetch(`${BACKEND_BASE_URL}/predict`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ cellname: cellName }),
      signal: controller.signal,
    })

    let payload = null
    try {
      payload = await response.json()
    } catch {
      payload = null
    }

    if (!response.ok) {
      const detail = payload?.detail || payload?.error || `Backend returned ${response.status}`
      const err = new Error(String(detail))
      err.statusCode = response.status
      throw err
    }

    if (!payload || typeof payload !== 'object') {
      throw new Error('Backend returned invalid recommendation payload')
    }

    return payload
  } finally {
    clearTimeout(timeout)
  }
}

export const config = {
  api: {
    bodyParser: true,
    responseLimit: false,
  },
}

export default async function handler(req, res) {
  if (!requireAuthenticatedRequest(req, res)) return
  if (!enforceRateLimit(req, res, { keyPrefix: 'recommend', maxRequests: 30, windowMs: 60_000 })) return

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const cellName = normalizeCellName(req.body?.cell_name)
  if (!cellName) {
    return res.status(400).json({ error: 'cell_name must be a non-empty string' })
  }

  try {
    const recommendation = await fetchBackendRecommendation(cellName)
    return res.status(200).json(recommendation)
  } catch (err) {
    const statusCode = Number.isInteger(err?.statusCode) ? err.statusCode : 502
    return res.status(statusCode).json({
      error: 'Recommendation backend unavailable',
      detail: err instanceof Error ? err.message : String(err),
      backend: BACKEND_BASE_URL,
    })
  }
}
