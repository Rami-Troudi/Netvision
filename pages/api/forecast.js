import { enforceRateLimit, requireAuthenticatedRequest } from './_lib/security.js'
import { ERROR_TYPES, sendApiError } from './_lib/apiErrors.js'
import { getRuntimeDataRoot } from './_lib/dataMode.js'
import { buildForecastForRuntime, loadRuntimeForForecast } from '../../src/analytics/qosForecast.mjs'

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback
  return ['1', 'true', 'yes', 'oui'].includes(String(value).trim().toLowerCase())
}

function parseForecastQuery(query = {}) {
  const horizon = Number.parseInt(String(query.horizon || '1'), 10)
  if (![1, 3].includes(horizon)) {
    return { error: 'horizon doit valoir 1 ou 3.' }
  }
  const limit = Math.max(1, Math.min(500, Number.parseInt(String(query.limit || '50'), 10) || 50))
  const minRisk = Math.max(0, Math.min(100, Number.parseFloat(String(query.min_risk || '0')) || 0))
  const scope = {
    scope_level: String(query.scope_level || 'national').trim().toLowerCase(),
    gov_id: String(query.gov_id || '').trim(),
    deleg_id: String(query.deleg_id || '').trim(),
    site_name: String(query.site_name || '').trim(),
    cell_name: String(query.cell_name || '').trim(),
  }
  if (!['national', 'governorate', 'delegation', 'site', 'cell'].includes(scope.scope_level)) {
    return { error: 'scope_level invalide.' }
  }
  return {
    horizon,
    limit,
    minRisk,
    includeLow: parseBool(query.include_low, false),
    scope,
  }
}

export default async function handler(req, res) {
  if (!requireAuthenticatedRequest(req, res)) return
  if (!enforceRateLimit(req, res, { keyPrefix: 'forecast', maxRequests: 40, windowMs: 60_000 })) return
  if (req.method !== 'GET') {
    return sendApiError(res, 405, ERROR_TYPES.VALIDATION, 'Méthode non autorisée')
  }

  const parsed = parseForecastQuery(req.query || {})
  if (parsed.error) {
    return sendApiError(res, 400, ERROR_TYPES.VALIDATION, parsed.error)
  }

  try {
    const { root, mode } = getRuntimeDataRoot()
    const runtime = await loadRuntimeForForecast(root, mode, 24)
    const artifact = buildForecastForRuntime(runtime, parsed)
    artifact.warnings = [...(runtime.warnings || []), ...(artifact.warnings || [])]
    if (!runtime.timeSlices?.length) {
      artifact.warnings.push('Données temporelles insuffisantes pour produire une prévision fiable.')
    }
    return res.status(200).json(artifact)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/time_index|baseline|ENOENT|no such file/i.test(message)) {
      return res.status(200).json({
        ok: true,
        generated_at: new Date().toISOString(),
        data_mode: getRuntimeDataRoot().mode,
        horizon: parsed.horizon,
        scope: parsed.scope,
        rows: [],
        summary: {
          total_cells: 0,
          predicted_cells: 0,
          high_risk_cells: 0,
          critical_risk_cells: 0,
          average_risk_score: 0,
          confidence: 'low',
        },
        warnings: ['Données temporelles insuffisantes pour produire une prévision fiable.'],
      })
    }
    return sendApiError(res, 500, ERROR_TYPES.DATA, 'Échec de la prévision QoS.', { detail: message })
  }
}
