import { enforceRateLimit, requireAuthenticatedRequest } from './_lib/security'
import { appendAudit, auditActor } from './_lib/audit'

const BACKEND_BASE_URL = (process.env.BACKEND_API_URL || 'http://127.0.0.1:8000').trim()
const BACKEND_TIMEOUT_MS = Number.parseInt(process.env.BACKEND_API_TIMEOUT_MS || '420000', 10)
const BACKEND_RETRY_ATTEMPTS = Math.max(1, Number.parseInt(process.env.BACKEND_API_RETRY_ATTEMPTS || '3', 10))
const BACKEND_RETRY_DELAY_MS = Math.max(100, Number.parseInt(process.env.BACKEND_API_RETRY_DELAY_MS || '1500', 10))

export const config = {
  api: {
    bodyParser: false,
    responseLimit: false,
  },
}

function getTimestampQuery(req) {
  const raw = req?.query?.timestamp
  if (Array.isArray(raw)) {
    return raw[0] ? String(raw[0]).trim() : ''
  }
  return typeof raw === 'string' ? raw.trim() : ''
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function isRetryableBackendError(err) {
  const message = String(err?.message || err || '').toLowerCase()
  return (
    message.includes('fetch failed')
    || message.includes('econnrefused')
    || message.includes('econnreset')
    || message.includes('ehostunreach')
    || message.includes('etimedout')
    || message.includes('connect timeout')
    || message.includes('socket hang up')
  )
}

async function fetchBackendExport(timestamp = '') {
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    Number.isFinite(BACKEND_TIMEOUT_MS) ? BACKEND_TIMEOUT_MS : 30000
  )

  try {
    const query = timestamp ? `?timestamp=${encodeURIComponent(timestamp)}` : ''
    const response = await fetch(`${BACKEND_BASE_URL}/recommendations/export${query}`, {
      method: 'GET',
      signal: controller.signal,
    })

    const contentType = response.headers.get('content-type') || 'text/csv; charset=utf-8'
    const contentDisposition = response.headers.get('content-disposition') || 'attachment; filename=recommendations_export.csv'
    const csvText = await response.text()

    return {
      ok: response.ok,
      status: response.status,
      contentType,
      contentDisposition,
      csvText,
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchBackendExportWithRetry(timestamp = '') {
  let lastError = null

  for (let attempt = 1; attempt <= BACKEND_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const payload = await fetchBackendExport(timestamp)
      return { ...payload, attempts: attempt }
    } catch (err) {
      lastError = err
      if (!isRetryableBackendError(err) || attempt >= BACKEND_RETRY_ATTEMPTS) {
        break
      }

      await delay(BACKEND_RETRY_DELAY_MS * attempt)
    }
  }

  throw lastError || new Error('Unknown backend export failure')
}

export default async function handler(req, res) {
  if (!requireAuthenticatedRequest(req, res)) return
  if (!enforceRateLimit(req, res, { keyPrefix: 'recommendations-export', maxRequests: 30, windowMs: 60_000 })) return

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const timestamp = getTimestampQuery(req)
  const startedAt = Date.now()

  try {
    const backend = await fetchBackendExportWithRetry(timestamp)
    if (!backend.ok) {
      appendAudit({ actor: auditActor(req), endpoint: '/api/recommendations-export', action: 'export', result: 'backend_error', detail: String(backend.status || 502) })
      return res.status(backend.status || 502).json({
        error: 'Failed to export recommendations from backend',
        attempts: backend.attempts,
        elapsedMs: Date.now() - startedAt,
        backend: BACKEND_BASE_URL,
      })
    }

    res.setHeader('X-Backend-Elapsed-Ms', String(Date.now() - startedAt))
    res.setHeader('X-Backend-Attempts', String(backend.attempts))
    res.setHeader('Content-Type', backend.contentType)
    res.setHeader('Content-Disposition', backend.contentDisposition)
    appendAudit({ actor: auditActor(req), endpoint: '/api/recommendations-export', action: 'export', result: 'ok', detail: timestamp || 'latest' })
    return res.status(200).send(backend.csvText)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    const isConnectionError = /fetch failed|econnrefused|econnreset|etimedout/i.test(detail)
    appendAudit({ actor: auditActor(req), endpoint: '/api/recommendations-export', action: 'export', result: 'error', detail })
    return res.status(502).json({
      error: isConnectionError
        ? 'Python backend is not reachable — make sure it is running on the configured port'
        : 'Recommendations export unavailable',
      detail,
      attempts: BACKEND_RETRY_ATTEMPTS,
      elapsedMs: Date.now() - startedAt,
      backend: BACKEND_BASE_URL,
    })
  }
}
