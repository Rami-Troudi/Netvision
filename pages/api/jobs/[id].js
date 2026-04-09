import { enforceRateLimit, requireAuthenticatedRequest } from '../_lib/security'
import { formatJobApiResponse, getJobRecord } from '../_lib/jobs'

export const config = {
  api: {
    bodyParser: true,
    responseLimit: false,
  },
}

function normalizeId(rawValue) {
  if (Array.isArray(rawValue)) {
    return String(rawValue[0] || '').trim()
  }
  return String(rawValue || '').trim()
}

export default async function handler(req, res) {
  if (!requireAuthenticatedRequest(req, res)) return
  if (!enforceRateLimit(req, res, { keyPrefix: 'jobs-status', maxRequests: 120, windowMs: 60_000 })) return

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const jobId = normalizeId(req.query.id)
  if (!jobId) {
    return res.status(400).json({ error: 'Missing job id' })
  }

  const jobRow = getJobRecord(jobId)
  if (!jobRow) {
    return res.status(404).json({ error: 'Job not found' })
  }

  return res.status(200).json(formatJobApiResponse(jobRow))
}
