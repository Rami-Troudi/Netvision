import { enforceRateLimit, requireAuthenticatedRequest } from './_lib/security'
import { validateSimulationRequest } from './_lib/simulationContract.js'

export const config = {
  api: {
    bodyParser: true,
    responseLimit: false,
  },
}

export default async function handler(req, res) {
  if (!requireAuthenticatedRequest(req, res)) return
  if (!enforceRateLimit(req, res, { keyPrefix: 'simulate', maxRequests: 10, windowMs: 60_000 })) return

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const validationError = await validateSimulationRequest(req.body)
  if (validationError) {
    return res.status(validationError.status).json({ error: validationError.error })
  }

  return res.status(409).json({
    error: 'Direct simulation endpoint is disabled. Submit ns-3 simulations through /api/jobs.',
  })
}
