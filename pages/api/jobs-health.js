import { enforceRateLimit, requireAuthenticatedRequest } from './_lib/security'
import { checkRedisConnection, JOB_QUEUE_NAME, REDIS_URL } from './_lib/jobs'
import { computeSlo } from './_lib/jobsSlo.js'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { checkNs3Readiness } = require('../../simulation/ns3/adapter/ns3JobAdapter.js')

export default async function handler(req, res) {
  if (!requireAuthenticatedRequest(req, res)) return
  if (!enforceRateLimit(req, res, { keyPrefix: 'jobs-health', maxRequests: 120, windowMs: 60_000 })) return
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const ns3 = await checkNs3Readiness(process.cwd())
    await checkRedisConnection()
    const slo = computeSlo()
    return res.status(200).json({
      ready: Boolean(ns3.ready),
      optional: false,
      service: 'simulation-worker',
      engine: 'ns3',
      queue: JOB_QUEUE_NAME,
      redis_url: REDIS_URL,
      ns3,
      detail: ns3.ready
        ? 'Redis, worker queue and ns-3 are ready.'
        : ns3.detail || 'ns-3 is unavailable.',
      slo,
    })
  } catch (err) {
    const ns3 = await checkNs3Readiness(process.cwd()).catch((ns3Err) => ({
      ready: false,
      service: 'ns3',
      engine: 'ns3',
      detail: 'La verification ns-3 a echoue.',
      reason: ns3Err instanceof Error ? ns3Err.message : String(ns3Err),
    }))
    return res.status(200).json({
      ready: false,
      optional: false,
      service: 'simulation-worker',
      engine: 'ns3',
      queue: JOB_QUEUE_NAME,
      redis_url: REDIS_URL,
      ns3,
      detail: `Simulation indisponible : Redis, worker ou ns-3 n’est pas prêt.`,
      reason: err instanceof Error ? err.message : String(err),
      slo: computeSlo(),
    })
  }
}
