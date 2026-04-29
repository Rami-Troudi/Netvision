import { enforceRateLimit, requireAuthenticatedRequest } from './_lib/security'
import { getJobsQueue, JOB_QUEUE_NAME } from './_lib/jobs'

export default async function handler(req, res) {
  if (!requireAuthenticatedRequest(req, res)) return
  if (!enforceRateLimit(req, res, { keyPrefix: 'jobs-health', maxRequests: 60, windowMs: 60_000 })) return
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  try {
    await getJobsQueue()
    return res.status(200).json({ ready: true, queue: JOB_QUEUE_NAME })
  } catch (err) {
    return res.status(200).json({
      ready: false,
      queue: JOB_QUEUE_NAME,
      detail: err instanceof Error ? err.message : String(err),
    })
  }
}

