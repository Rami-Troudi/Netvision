import { getDataMode, setDataMode, DATA_MODES } from './_lib/dataMode'
import { enforceRateLimit, requireAuthenticatedRequest } from './_lib/security'
import { appendAudit, auditActor } from './_lib/audit'

export default async function handler(req, res) {
  if (!requireAuthenticatedRequest(req, res)) return
  if (!enforceRateLimit(req, res, { keyPrefix: 'data-mode', maxRequests: 60, windowMs: 60_000 })) return
  if (req.method === 'GET') {
    return res.status(200).json({ mode: getDataMode(), allowed: DATA_MODES })
  }
  if (req.method === 'POST') {
    const mode = String(req.body?.mode || '').trim().toLowerCase()
    if (!DATA_MODES.includes(mode)) {
      appendAudit({ actor: auditActor(req), endpoint: '/api/data-mode', action: 'switch', result: 'invalid_mode', detail: mode })
      return res.status(400).json({ error: `mode must be one of: ${DATA_MODES.join(', ')}` })
    }
    const payload = setDataMode(mode)
    appendAudit({ actor: auditActor(req), endpoint: '/api/data-mode', action: 'switch', result: 'ok', detail: mode })
    return res.status(200).json(payload)
  }
  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'Method not allowed' })
}
