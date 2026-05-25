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

function buildSchemaDiff(headers = [], inferredMapping = {}, importType = 'reference') {
  const accepted = Object.entries(inferredMapping || {})
    .filter(([field, header]) => KNOWN_FIELDS.has(field) && headers.includes(header))
    .map(([field, header]) => ({ field, header }))
  const acceptedHeaders = new Set(accepted.map((item) => item.header))
  const unknown = headers.filter((header) => !acceptedHeaders.has(header))
  const requiredReference = ['cell_name', 'longitude', 'latitude']
  const hasTimestamp = Boolean(inferredMapping.timestamp || inferredMapping.date || inferredMapping.time)
  const hasAnyKpi = Boolean(inferredMapping.load || inferredMapping.throughput || inferredMapping.cqi || inferredMapping.active_users || inferredMapping.rrc_users || inferredMapping.traffic || inferredMapping.ta)
  const requiredKpi = ['cell_name']
  if (!hasTimestamp) requiredKpi.push('timestamp|date|time')
  if (!hasAnyKpi) requiredKpi.push('kpi(load|throughput|cqi|active_users)')
  const required = importType === 'kpi' ? requiredKpi : requiredReference
  const missingRequired = required.filter((field) => !Object.prototype.hasOwnProperty.call(inferredMapping || {}, field))
  return { accepted, unknown, missing_required: missingRequired }
}

function computeCoverage(rows = [], mapping = {}) {
  const mappedHeaders = Object.values(mapping || {}).filter(Boolean)
  const present = (field) => {
    const header = mapping[field]
    if (!header) return 0
    return rows.filter((row) => String(row?.[header] ?? '').trim()).length
  }
  const total = Math.max(1, rows.length)
  const cellHeader = mapping.cell_name
  const timestampHeader = mapping.timestamp || mapping.date || mapping.time
  return {
    accepted_field_count: mappedHeaders.length,
    total_rows: rows.length,
    cell_count: cellHeader ? new Set(rows.map((row) => String(row?.[cellHeader] || '').trim()).filter(Boolean)).size : 0,
    timestamp_count: timestampHeader ? new Set(rows.map((row) => String(row?.[timestampHeader] || '').trim()).filter(Boolean)).size : 0,
    kpi_coverage: {
      prb: present('load') / total,
      throughput: present('throughput') / total,
      cqi: present('cqi') / total,
      active_users: present('active_users') / total,
    },
  }
}

export default async function handler(req, res) {
  if (!requireAuthenticatedRequest(req, res)) return
  if (!enforceRateLimit(req, res, { keyPrefix: 'import-dry-run', maxRequests: 8, windowMs: 60_000 })) return
  if (req.method !== 'POST') return sendApiError(res, 405, ERROR_TYPES.VALIDATION, 'Méthode non autorisée')

  const importType = String(req.body?.import_type || 'reference').trim().toLowerCase()
  const csvText = String(req.body?.csv_text || '')
  if (!csvText.trim()) {
    appendAudit({ actor: auditActor(req), endpoint: '/api/import-dry-run', action: 'dry_run', result: 'invalid_payload' })
    return sendApiError(res, 400, ERROR_TYPES.VALIDATION, 'Le contenu CSV (csv_text) est obligatoire.')
  }

  try {
    const preview = parseCsvPreview({ csvText, maxPreviewRows: 10 })
    const normalizedImportType = importType === 'kpi' ? 'kpi' : 'reference'
    const schemaDiff = buildSchemaDiff(preview.headers || [], preview.inferredMapping || {}, normalizedImportType)
    const coverage = computeCoverage(preview.allRows || [], preview.inferredMapping || {})
    const warnings = []
    if (normalizedImportType === 'reference' && schemaDiff.missing_required.length) {
      warnings.push('Import reference bloque: cellule + coordonnees (longitude, latitude) sont obligatoires.')
    }
    if (normalizedImportType === 'kpi') {
      if (schemaDiff.missing_required.includes('timestamp|date|time')) warnings.push('Import KPI bloque: horodatage requis (timestamp/date/time).')
      if (schemaDiff.missing_required.includes('kpi(load|throughput|cqi|active_users)')) warnings.push('Import KPI bloque: au moins un KPI radio est requis.')
    }
    const response = {
      mode: 'dry_run',
      import_type: normalizedImportType,
      mapping: preview.inferredMapping || {},
      schema_diff: schemaDiff,
      sample_warnings: warnings,
      coverage,
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
    return sendApiError(res, 500, ERROR_TYPES.DATA, 'Échec de la prévalidation import.', { detail: err instanceof Error ? err.message : String(err) })
  }
}
