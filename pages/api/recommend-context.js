import { enforceRateLimit, requireAuthenticatedRequest } from './_lib/security'

const BACKEND_BASE_URL = (process.env.BACKEND_API_URL || 'http://127.0.0.1:8000').trim()
const BACKEND_TIMEOUT_MS = Number.parseInt(process.env.BACKEND_API_TIMEOUT_MS || '30000', 10)

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '30mb',
    },
    responseLimit: false,
  },
}

function normalizePayload(body) {
  const baseline = body?.baseline
  const slices = body?.slices

  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
    throw new Error('baseline must be an object')
  }

  if (!Array.isArray(slices)) {
    throw new Error('slices must be an array')
  }

  return {
    baseline,
    slices,
    source: typeof body?.source === 'string' && body.source.trim() ? body.source.trim() : 'uploaded',
  }
}

async function callBackend(path, method, payload = null) {
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    Number.isFinite(BACKEND_TIMEOUT_MS) ? BACKEND_TIMEOUT_MS : 30000
  )

  try {
    const response = await fetch(`${BACKEND_BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: controller.signal,
    })

    let data = null
    try {
      data = await response.json()
    } catch {
      data = null
    }

    if (!response.ok) {
      const detail = data?.detail || data?.error || `Backend returned ${response.status}`
      const err = new Error(String(detail))
      err.statusCode = response.status
      throw err
    }

    return data || { success: true }
  } finally {
    clearTimeout(timeout)
  }
}

export default async function handler(req, res) {
  if (!requireAuthenticatedRequest(req, res)) return
  if (!enforceRateLimit(req, res, { keyPrefix: 'recommend-context', maxRequests: 10, windowMs: 60_000 })) return

  if (req.method === 'POST') {
    let payload
    try {
      payload = normalizePayload(req.body)
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
    }

    try {
      const backendData = await callBackend('/context/upload', 'POST', payload)
      return res.status(200).json({ success: true, ...backendData })
    } catch (err) {
      const statusCode = Number.isInteger(err?.statusCode) ? err.statusCode : 502
      return res.status(statusCode).json({
        error: 'Failed to upload recommendation context',
        detail: err instanceof Error ? err.message : String(err),
        backend: BACKEND_BASE_URL,
      })
    }
  }

  if (req.method === 'DELETE') {
    try {
      const backendData = await callBackend('/context/reset', 'DELETE')
      return res.status(200).json({ success: true, ...backendData })
    } catch (err) {
      const statusCode = Number.isInteger(err?.statusCode) ? err.statusCode : 502
      return res.status(statusCode).json({
        error: 'Failed to reset recommendation context',
        detail: err instanceof Error ? err.message : String(err),
        backend: BACKEND_BASE_URL,
      })
    }
  }

  return res.status(405).json({ error: 'Method not allowed' })
}
