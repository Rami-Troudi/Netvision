import crypto from 'crypto'
import { enforceRateLimit, requireAuthenticatedRequest } from '../_lib/security'
import {
  JOB_QUEUE_NAME,
  JOB_STATUSES,
  JOB_TYPES,
  createJobRecord,
  getJobsQueue,
  updateJobRecord,
} from '../_lib/jobs'

export const config = {
  api: {
    bodyParser: true,
    responseLimit: false,
  },
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function inferJobType(payload) {
  if (payload?.job_type === JOB_TYPES.SIMULATE || payload?.type === JOB_TYPES.SIMULATE) {
    return JOB_TYPES.SIMULATE
  }
  if (payload?.job_type === JOB_TYPES.FORECAST || payload?.type === JOB_TYPES.FORECAST) {
    return JOB_TYPES.FORECAST
  }

  if (
    typeof payload?.cell_name === 'string' ||
    typeof payload?.action === 'string' ||
    payload?.time_entry !== undefined ||
    payload?.params !== undefined
  ) {
    return JOB_TYPES.SIMULATE
  }

  return JOB_TYPES.FORECAST
}

function normalizeSimulatePayload(rawBody) {
  const payload = isPlainObject(rawBody) ? rawBody : {}
  const cellName = typeof payload.cell_name === 'string' ? payload.cell_name.trim() : ''
  const action = typeof payload.action === 'string' ? payload.action.trim() : ''
  if (!cellName || !action) {
    throw new Error('simulate jobs require non-empty cell_name and action')
  }
  if (payload.params !== undefined && !isPlainObject(payload.params)) {
    throw new Error('simulate params must be an object when provided')
  }
  if (payload.time_entry !== undefined && !isPlainObject(payload.time_entry)) {
    throw new Error('simulate time_entry must be an object when provided')
  }

  return {
    cell_name: cellName,
    action,
    params: payload.params || {},
    time_entry: payload.time_entry || {},
    mode: 'fast',
  }
}

function normalizeForecastPayload(rawBody) {
  const payload = isPlainObject(rawBody) ? rawBody : {}
  const parsedDays = Number.parseInt(payload.days, 10)
  const days = Number.isFinite(parsedDays) ? Math.min(30, Math.max(1, parsedDays)) : 7
  const startDate = typeof payload.start_date === 'string' && payload.start_date.trim()
    ? payload.start_date.trim()
    : null

  return {
    days,
    start_date: startDate,
  }
}

function normalizeJobPayload(rawBody) {
  const body = isPlainObject(rawBody) ? rawBody : {}
  const type = inferJobType(body)
  if (type === JOB_TYPES.SIMULATE) {
    return {
      type,
      payload: normalizeSimulatePayload(body),
    }
  }
  return {
    type: JOB_TYPES.FORECAST,
    payload: normalizeForecastPayload(body),
  }
}

export default async function handler(req, res) {
  if (!requireAuthenticatedRequest(req, res)) return
  if (!enforceRateLimit(req, res, { keyPrefix: 'jobs-create', maxRequests: 20, windowMs: 60_000 })) return

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  let jobDefinition
  try {
    jobDefinition = normalizeJobPayload(req.body)
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Invalid job payload' })
  }

  const jobId = crypto.randomUUID()
  try {
    createJobRecord({
      id: jobId,
      type: jobDefinition.type,
      payload: jobDefinition.payload,
    })
  } catch (err) {
    console.error('Failed to create job record:', err)
    return res.status(500).json({ error: 'Failed to create job record' })
  }

  try {
    const queue = await getJobsQueue()
    const queuedJob = await queue.add('execute-job', { jobId }, { jobId })
    updateJobRecord({
      id: jobId,
      status: JOB_STATUSES.PENDING,
      queueJobId: String(queuedJob.id),
    })
  } catch (err) {
    console.error('Failed to enqueue job:', err)
    updateJobRecord({
      id: jobId,
      status: JOB_STATUSES.FAILED,
      errorText: 'Queue unavailable',
      completedAt: new Date().toISOString(),
    })
    return res.status(503).json({ error: 'Queue unavailable', queue: JOB_QUEUE_NAME })
  }

  return res.status(202).json({
    jobId,
    type: jobDefinition.type,
    status: JOB_STATUSES.PENDING,
  })
}
