import { enforceRateLimit, requireAuthenticatedRequest } from './_lib/security'
import { checkRedisConnection, JOB_QUEUE_NAME, REDIS_URL } from './_lib/jobs'

export default async function handler(req, res) {
  if (!requireAuthenticatedRequest(req, res)) return
  if (!enforceRateLimit(req, res, { keyPrefix: 'jobs-health', maxRequests: 60, windowMs: 60_000 })) return
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  try {
    await checkRedisConnection()
    return res.status(200).json({ ready: true, optional: true, service: 'redis-worker', queue: JOB_QUEUE_NAME, redis_url: REDIS_URL })
  } catch (err) {
    return res.status(200).json({
      ready: false,
      optional: true,
      scope: 'out_of_current_phase',
      service: 'redis-worker',
      queue: JOB_QUEUE_NAME,
      redis_url: REDIS_URL,
      detail: `Redis is unavailable at ${REDIS_URL}. Simulation queue is optional and outside the current phase.`,
      reason: err instanceof Error ? err.message : String(err),
    })
  }
}
