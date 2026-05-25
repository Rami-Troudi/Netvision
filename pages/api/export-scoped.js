import { enforceRateLimit, requireAuthenticatedRequest } from './_lib/security.js'
import { appendAudit, auditActor } from './_lib/audit.js'
import { ERROR_TYPES, sendApiError } from './_lib/apiErrors.js'
import { getRuntimeDataRoot } from './_lib/simulationContract.js'

function toCsv(rows = []) {
  if (!rows.length) return ''
  const headers = Object.keys(rows[0])
  const esc = (v) => {
    const s = String(v ?? '')
    if (s.includes('"') || s.includes(',') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`
    return s
  }
  return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n')
}

export default async function handler(req, res) {
  if (!requireAuthenticatedRequest(req, res)) return
  if (!enforceRateLimit(req, res, { keyPrefix: 'export-scoped', maxRequests: 20, windowMs: 60_000 })) return
  if (req.method !== 'POST') return sendApiError(res, 405, ERROR_TYPES.VALIDATION, 'Method not allowed')

  const body = req.body || {}
  const format = String(body.format || 'json').trim().toLowerCase()
  const payload = body.payload && typeof body.payload === 'object' ? body.payload : null
  if (!payload) return sendApiError(res, 400, ERROR_TYPES.VALIDATION, 'payload is required')

  const auditMeta = {
    generated_at: new Date().toISOString(),
    scope: payload.scope || {},
    time_window: payload.time_window || {},
    filters: payload.filters || {},
    data_mode: payload.data_mode || 'unknown',
    source_runtime: getRuntimeDataRoot().mode === 'mock' ? 'runtime_data_mock' : 'runtime_data',
  }
  const envelope = { ...payload, audit: auditMeta }

  appendAudit({
    actor: auditActor(req),
    endpoint: '/api/export-scoped',
    action: 'export',
    result: 'ok',
    detail: `${format}:${auditMeta.scope?.level || 'unknown'}`,
  })

  if (format === 'json') {
    return res.status(200).json(envelope)
  }
  if (format === 'csv') {
    const rows = Array.isArray(payload.rows) ? payload.rows : []
    const csv = toCsv(rows)
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename=netvision-scoped-export.csv')
    return res.status(200).send(csv)
  }
  if (format === 'txt') {
    const lines = [
      `Scope: ${auditMeta.scope?.level || 'unknown'}`,
      `Generated: ${auditMeta.generated_at}`,
      `Data mode: ${auditMeta.data_mode}`,
      '',
      JSON.stringify(payload.summary || payload, null, 2),
    ]
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename=netvision-scoped-export.txt')
    return res.status(200).send(lines.join('\n'))
  }
  return sendApiError(res, 400, ERROR_TYPES.VALIDATION, 'format must be json, csv or txt')
}
