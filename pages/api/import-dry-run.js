import { createRequire } from 'module'
import { enforceRateLimit, requireAuthenticatedRequest } from './_lib/security.js'
import { appendAudit, auditActor } from './_lib/audit.js'
import { ERROR_TYPES, sendApiError } from './_lib/apiErrors.js'

const require = createRequire(import.meta.url)
const { parseCsvPreview } = require('../../public/workers/dataWorker.js')

const KNOWN_FIELDS = new Set([
  'cell_name', 'localcell_id', 'enodeb_name', 'longitude', 'latitude', 'azimuth', 'frequency_band', 'cell_fdd_tdd_indication',
  'timestamp', 'date', 'time', 'load', 'throughput', 'cqi', 'active_users', 'rrc_users', 'traffic', 'ta', 'signal_power',
  'congested', 'severity', 'issue_type', 'root_cause', 'health_score',
])

function buildSchemaDiff(headers = [], inferredMapping = {}) {
  const accepted = Object.entries(inferredMapping || {})
    .filter(([field, header]) => KNOWN_FIELDS.has(field) && headers.includes(header))
    .map(([field, header]) => ({ field, header }))
  const acceptedHeaders = new Set(accepted.map((item) => item.header))
  const unknown = headers.filter((header) => !acceptedHeaders.has(header))
  const missingRequired = ['cell_name'].filter((field) => !Object.prototype.hasOwnProperty.call(inferredMapping || {}, field))
  return { accepted, unknown, missing_required: missingRequired }
}

export default async function handler(req, res) {
  if (!requireAuthenticatedRequest(req, res)) return
  if (!enforceRateLimit(req, res, { keyPrefix: 'import-dry-run', maxRequests: 8, windowMs: 60_000 })) return
  if (req.method !== 'POST') return sendApiError(res, 405, ERROR_TYPES.VALIDATION, 'Method not allowed')

  const importType = String(req.body?.import_type || 'reference').trim().toLowerCase()
  const csvText = String(req.body?.csv_text || '')
  if (!csvText.trim()) {
    appendAudit({ actor: auditActor(req), endpoint: '/api/import-dry-run', action: 'dry_run', result: 'invalid_payload' })
    return sendApiError(res, 400, ERROR_TYPES.VALIDATION, 'csv_text is required')
  }

  try {
    const preview = parseCsvPreview({ csvText, maxPreviewRows: 10 })
    const schemaDiff = buildSchemaDiff(preview.headers || [], preview.inferredMapping || {})
    const response = {
      mode: 'dry_run',
      import_type: importType === 'kpi' ? 'kpi' : 'reference',
      mapping: preview.inferredMapping || {},
      schema_diff: schemaDiff,
      sample_warnings: [],
      can_apply: schemaDiff.missing_required.length === 0 && (preview.totalRows || 0) > 0,
      preview: {
        total_rows: preview.totalRows || 0,
        headers: preview.headers || [],
        sample_rows: preview.previewRows || [],
      },
    }
    appendAudit({ actor: auditActor(req), endpoint: '/api/import-dry-run', action: 'dry_run', result: 'ok', detail: `${response.preview.total_rows} rows` })
    return res.status(200).json(response)
  } catch (err) {
    appendAudit({ actor: auditActor(req), endpoint: '/api/import-dry-run', action: 'dry_run', result: 'error', detail: err instanceof Error ? err.message : String(err) })
    return sendApiError(res, 500, ERROR_TYPES.DATA, 'Import dry-run failed', { detail: err instanceof Error ? err.message : String(err) })
  }
}
