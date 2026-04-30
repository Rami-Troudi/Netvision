import { enforceRateLimit, requireAuthenticatedRequest } from './_lib/security'

const BACKEND_BASE_URL = (process.env.BACKEND_API_URL || 'http://127.0.0.1:8000').trim()
const BACKEND_TIMEOUT_MS = Math.min(1500, Math.max(250, Number.parseInt(process.env.BACKEND_API_TIMEOUT_MS || '900', 10)))

function unavailablePayload(detail) {
  return {
    available: false,
    optional: true,
    scope: 'out_of_current_phase',
    status: 'unavailable',
    backend: BACKEND_BASE_URL,
    detail: detail ? `FastAPI backend unavailable. Core dashboard remains usable. (${detail})` : 'FastAPI backend unavailable. Core dashboard remains usable.',
  }
}

export default async function handler(req, res) {
  if (!requireAuthenticatedRequest(req, res)) return
  if (!enforceRateLimit(req, res, { keyPrefix: 'backend-health', maxRequests: 60, windowMs: 60_000 })) return
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS)
  try {
    const response = await fetch(`${BACKEND_BASE_URL}/health`, { signal: controller.signal })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      return res.status(200).json(unavailablePayload(payload?.detail || payload?.error || `FastAPI health returned ${response.status}`))
    }
    return res.status(200).json({ available: true, optional: true, scope: 'out_of_current_phase', backend: BACKEND_BASE_URL, ...payload })
  } catch (err) {
    return res.status(200).json(unavailablePayload(err instanceof Error ? err.message : String(err)))
  } finally {
    clearTimeout(timeout)
  }
}
