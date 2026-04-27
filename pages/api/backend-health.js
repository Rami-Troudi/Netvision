import { requireAuthenticatedRequest } from './_lib/security'

const BACKEND_BASE_URL = (process.env.BACKEND_API_URL || 'http://127.0.0.1:8000').trim()
const BACKEND_TIMEOUT_MS = Number.parseInt(process.env.BACKEND_API_TIMEOUT_MS || '5000', 10)

export default async function handler(req, res) {
  if (!requireAuthenticatedRequest(req, res)) return
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Number.isFinite(BACKEND_TIMEOUT_MS) ? BACKEND_TIMEOUT_MS : 5000)
  try {
    const response = await fetch(`${BACKEND_BASE_URL}/health`, { signal: controller.signal })
    const payload = await response.json().catch(() => ({}))
    return res.status(response.ok ? 200 : 502).json({ available: response.ok, backend: BACKEND_BASE_URL, ...payload })
  } catch (err) {
    return res.status(200).json({ available: false, status: 'unavailable', backend: BACKEND_BASE_URL, detail: err instanceof Error ? err.message : String(err) })
  } finally {
    clearTimeout(timeout)
  }
}
