import { enforceRateLimit, requireAuthenticatedRequest } from '../_lib/security'
import { formatJobApiResponse, getJobRecord } from '../_lib/jobs'
import { ERROR_TYPES, sendApiError } from '../_lib/apiErrors'

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
    return sendApiError(res, 405, ERROR_TYPES.VALIDATION, 'Method not allowed')
  }

  const jobId = normalizeId(req.query.id)
  if (!jobId) {
    return sendApiError(res, 400, ERROR_TYPES.VALIDATION, 'Missing job id')
  }

  const jobRow = getJobRecord(jobId)
  if (!jobRow) {
    return sendApiError(res, 404, ERROR_TYPES.DATA, 'Job not found')
  }

  return res.status(200).json(formatJobApiResponse(jobRow))
}
