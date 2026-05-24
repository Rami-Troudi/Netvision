import fs from 'fs/promises'
import path from 'path'
import { enforceRateLimit, requireAuthenticatedRequest } from './_lib/security.js'
import { appendAudit, auditActor } from './_lib/audit.js'
import { ERROR_TYPES, sendApiError } from './_lib/apiErrors.js'

const STORE_DIR = path.resolve(process.cwd(), '.runtime', 'admin')
const STORE_FILE = path.resolve(STORE_DIR, 'import_profiles.json')

async function readProfiles() {
  try {
    const raw = await fs.readFile(STORE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function writeProfiles(profiles) {
  await fs.mkdir(STORE_DIR, { recursive: true })
  await fs.writeFile(STORE_FILE, JSON.stringify(profiles, null, 2), 'utf8')
}

export default async function handler(req, res) {
  if (!requireAuthenticatedRequest(req, res)) return
  if (!enforceRateLimit(req, res, { keyPrefix: 'import-profiles', maxRequests: 20, windowMs: 60_000 })) return

  if (req.method === 'GET') {
    const profiles = await readProfiles()
    return res.status(200).json({ profiles })
  }

  if (req.method === 'POST') {
    const body = req.body || {}
    const datasetName = String(body.dataset_name || '').trim()
    const sourceType = String(body.source_type || '').trim().toLowerCase()
    const mapping = body.mapping && typeof body.mapping === 'object' && !Array.isArray(body.mapping) ? body.mapping : null
    const strictCongestion = Boolean(body.strict_congestion_flag)
    if (!datasetName || !sourceType || !mapping) {
      appendAudit({ actor: auditActor(req), endpoint: '/api/import-profiles', action: 'upsert', result: 'invalid_payload' })
      return sendApiError(res, 400, ERROR_TYPES.VALIDATION, 'dataset_name, source_type and mapping are required')
    }
    const now = new Date().toISOString()
    const profiles = await readProfiles()
    const id = String(body.id || `${sourceType}:${datasetName}`.toLowerCase())
    const next = { id, dataset_name: datasetName, source_type: sourceType, mapping, strict_congestion_flag: strictCongestion, updated_at: now }
    const idx = profiles.findIndex((p) => p.id === id)
    if (idx >= 0) {
      next.created_at = profiles[idx].created_at || now
      profiles[idx] = next
    } else {
      next.created_at = now
      profiles.unshift(next)
    }
    await writeProfiles(profiles.slice(0, 100))
    appendAudit({ actor: auditActor(req), endpoint: '/api/import-profiles', action: 'upsert', result: 'ok', detail: id })
    return res.status(200).json({ profile: next })
  }

  if (req.method === 'DELETE') {
    const id = String(req.query.id || req.body?.id || '').trim()
    if (!id) return sendApiError(res, 400, ERROR_TYPES.VALIDATION, 'profile id is required')
    const profiles = await readProfiles()
    const next = profiles.filter((p) => p.id !== id)
    await writeProfiles(next)
    appendAudit({ actor: auditActor(req), endpoint: '/api/import-profiles', action: 'delete', result: 'ok', detail: id })
    return res.status(200).json({ deleted: id })
  }

  return sendApiError(res, 405, ERROR_TYPES.VALIDATION, 'Method not allowed')
}
