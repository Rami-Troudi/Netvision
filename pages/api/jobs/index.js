import crypto from 'crypto'
import path from 'path'
import { enforceRateLimit, requireAuthenticatedRequest } from '../_lib/security'
import {
  JOB_QUEUE_NAME,
  JOB_STATUSES,
  JOB_TYPES,
  createJobRecord,
  getJobsQueue,
  updateJobRecord,
  getJobRecordByIdempotencyKey,
  formatJobApiResponse,
  hashJobPayload,
} from '../_lib/jobs'
import { ERROR_TYPES, sendApiError } from '../_lib/apiErrors'
import { canSimulate } from '../_lib/simGuardrails'
import { appendAudit, auditActor } from '../_lib/audit'
import {
  DEFAULT_FIDELITY_LEVEL,
  DEFAULT_SIMULATION_ENGINE,
  getRuntimeDataRoot,
  resolveValidatedTimeEntry,
  validateSimulationRequest,
} from '../_lib/simulationContract'

export const config = {
  api: {
    bodyParser: true,
    responseLimit: false,
  },
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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
    engine: String(payload.engine || DEFAULT_SIMULATION_ENGINE).trim().toLowerCase(),
    fidelity_level: String(payload.fidelity_level || DEFAULT_FIDELITY_LEVEL).trim(),
    scenario_id: typeof payload.scenario_id === 'string' && payload.scenario_id.trim()
      ? payload.scenario_id.trim()
      : `${cellName}-${action}`,
    data_mode: getRuntimeDataRoot().mode,
  }
}

function normalizeJobPayload(rawBody) {
  const body = isPlainObject(rawBody) ? rawBody : {}
  const requestedType = String(body?.job_type || body?.type || JOB_TYPES.SIMULATE).trim()
  if (requestedType && requestedType !== JOB_TYPES.SIMULATE) {
    throw new Error('Only simulate jobs are supported')
  }

  return {
    type: JOB_TYPES.SIMULATE,
    payload: normalizeSimulatePayload(body),
  }
}

export default async function handler(req, res) {
  if (!requireAuthenticatedRequest(req, res)) return
  if (!enforceRateLimit(req, res, { keyPrefix: 'jobs-create', maxRequests: 20, windowMs: 60_000 })) return

  if (req.method !== 'POST') {
    return sendApiError(res, 405, ERROR_TYPES.VALIDATION, 'Method not allowed')
  }

  let jobDefinition
  try {
    const validationError = await validateSimulationRequest(req.body)
    if (validationError) {
      appendAudit({ actor: auditActor(req), endpoint: '/api/jobs', action: 'create', result: 'validation_failed', detail: validationError.error })
      return sendApiError(res, validationError.status, ERROR_TYPES.VALIDATION, validationError.error)
    }
    jobDefinition = normalizeJobPayload(req.body)
  } catch (err) {
    appendAudit({ actor: auditActor(req), endpoint: '/api/jobs', action: 'create', result: 'invalid_payload', detail: err.message })
    return sendApiError(res, 400, ERROR_TYPES.VALIDATION, err.message || 'Invalid job payload')
  }

  const idempotencyKey = String(req.headers['idempotency-key'] || '').trim() || null
  const bodyIdempotency = String(req.body?.idempotency_key || '').trim()
  const finalIdempotencyKey = idempotencyKey || bodyIdempotency || null
  if (finalIdempotencyKey) {
    const existing = getJobRecordByIdempotencyKey(finalIdempotencyKey)
    if (existing) {
      const currentHash = hashJobPayload(jobDefinition.payload)
      const existingHash = existing.request_hash || hashJobPayload(JSON.parse(existing.request_json))
      if (existingHash !== currentHash) {
        appendAudit({ actor: auditActor(req), endpoint: '/api/jobs', action: 'create', result: 'idempotency_conflict' })
        return sendApiError(res, 409, ERROR_TYPES.VALIDATION, 'Cle idempotence deja utilisee avec un autre payload.', {
          action: 'Utilisez une nouvelle cle idempotence pour une requete differente.',
        })
      }
      return res.status(200).json({
        ...formatJobApiResponse(existing),
        replayed: true,
      })
    }
  }
  const runtimeRoot = getRuntimeDataRoot().root
  let observation = null
  let hasTimeFile = true
  if (jobDefinition.payload?.time_entry?.filename) {
    try {
      const validated = await resolveValidatedTimeEntry(jobDefinition.payload.time_entry)
      const filePath = path.resolve(runtimeRoot, 'time_data', validated.filename)
      const raw = await import('fs/promises').then((m) => m.readFile(filePath, 'utf8'))
      const parsed = JSON.parse(raw)
      observation = parsed?.observations?.[jobDefinition.payload.cell_name] || null
      if (!observation) hasTimeFile = false
    } catch {
      hasTimeFile = false
    }
  }
  const feasibility = canSimulate({ runtimeRoot, payload: jobDefinition.payload, observation, hasTimeFile })
  if (!feasibility.ok) {
    appendAudit({ actor: auditActor(req), endpoint: '/api/jobs', action: 'create', result: 'feasibility_rejected', detail: feasibility.blocked_reasons.join(' | ') })
    return sendApiError(res, 422, ERROR_TYPES.VALIDATION, 'Simulation bloquee: preconditions non satisfaites.', {
      detail: feasibility.blocked_reasons.join(' | '),
      action: 'Corrigez cellule/action/contexte ou consultez le mode admin.',
    })
  }
  jobDefinition.payload.feasibility = feasibility

  const jobId = crypto.randomUUID()
  try {
    createJobRecord({
      id: jobId,
      type: jobDefinition.type,
      payload: jobDefinition.payload,
      idempotencyKey: finalIdempotencyKey,
    })
  } catch (err) {
    console.error('Failed to create job record:', err)
    return sendApiError(res, 500, ERROR_TYPES.DATA, 'Failed to create job record')
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
    return sendApiError(res, 503, ERROR_TYPES.INFRA, 'Queue unavailable', { queue: JOB_QUEUE_NAME })
  }

  appendAudit({
    actor: auditActor(req),
    endpoint: '/api/jobs',
    action: 'create',
    result: 'accepted',
    job_id: jobId,
  })
  return res.status(202).json({
    jobId,
    type: jobDefinition.type,
    status: JOB_STATUSES.PENDING,
  })
}
