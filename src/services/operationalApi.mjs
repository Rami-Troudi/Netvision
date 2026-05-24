import { buildSimulationPayload, mapRecommendationToSimulatorAction } from '../utils/v2Contracts.mjs'
import { ACTION_LABELS_FR } from '../utils/uiPolicy.mjs'

export const TERMINAL_JOB_STATES = new Set(['done', 'failed'])

const NON_SIM_ACTION_LABELS_FR = Object.freeze({
  'No Action Required': 'Aucune action requise',
  'Check Coverage/Interference': 'Verifier couverture / interferences',
  'Add Site': 'Planification site hors simulateur',
})

export function normalizeRecommendation(raw = {}) {
  const title = String(raw.action_name || raw.action || raw.title || 'Recommendation').trim()
  const simAction = mapRecommendationToSimulatorAction(title)
  const displayTitle = ACTION_LABELS_FR[simAction] || NON_SIM_ACTION_LABELS_FR[title] || title
  return {
    ...raw,
    title: displayTitle,
    action: title,
    simAction,
    isSimulatable: Boolean(simAction),
    reason: localizeRecommendationReason(String(raw.reason || '')),
    tier: String(raw.tier || raw.timeline || 'none'),
    recoveryRate: Number(raw.recovery_rate ?? raw.estimated_recovery_pct ?? 0) || 0,
    priorityRank: Number(raw.priority_rank ?? raw.priorityRank ?? 99) || 99,
    gainUe: Number(raw.gain_ue ?? raw.estimated_gain_ue ?? 0) || 0,
    gainGb: Number(raw.gain_gb ?? raw.estimated_gain_gb ?? 0) || 0,
    confidencePct: Number(raw.confidence_pct ?? raw.confidencePct ?? (raw.confidence === 'high' ? 85 : 70)) || 0,
  }
}

function localizeRecommendationReason(reason) {
  if (!reason) return ''
  return reason
    .replace(/Congestion thresholds are not jointly met/gi, 'Les seuils de congestion ne sont pas confirmes ensemble')
    .replace(/No Action Required/gi, 'Aucune action requise')
    .replace(/Check Coverage\/Interference/gi, 'Verifier couverture / interferences')
    .replace(/active users above/gi, 'utilisateurs actifs au-dessus de')
    .replace(/RRC users above/gi, 'utilisateurs RRC au-dessus de')
    .replace(/structural congestion ratio/gi, 'taux de congestion structurelle')
    .replace(/with no rebalancing\/carrier candidate/gi, 'sans candidat clair de reequilibrage ou de porteuse')
    .replace(/neighbor/gi, 'voisin')
    .replace(/carrier/gi, 'porteuse')
    .replace(/rebalancing/gi, 'reequilibrage')
}

async function readJsonResponse(res, fallbackMessage) {
  const payload = await res.json().catch(() => ({}))
  if (!res.ok) {
    let errMsg = fallbackMessage || `Request failed with ${res.status}`
    if (typeof payload?.error === 'object' && payload?.error !== null) {
      errMsg = payload.error.detail || payload.error.message || errMsg
    } else if (typeof payload?.error === 'string') {
      errMsg = payload.error
    } else if (typeof payload?.detail === 'string') {
      errMsg = payload.detail
    }
    throw new Error(errMsg)
  }
  return payload
}

export async function fetchRecommendations({ cell, currentTime }) {
  const res = await fetch('/api/recommend', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cell_name: cell?.cell_name,
      prb_load: cell?.prb_load,
      throughput: cell?.throughput_kbps ?? cell?.throughput,
      active_users: cell?.active_users,
      rrc_users: cell?.rrc_users,
      cqi: cell?.cqi,
      timestamp: currentTime?.timestamp,
    }),
  })
  const payload = await readJsonResponse(res, 'Recommendation request failed')
  const raw = Array.isArray(payload?.recommended_actions) ? payload.recommended_actions : []
  return {
    payload,
    recommendations: raw.map(normalizeRecommendation).sort((a, b) => a.priorityRank - b.priorityRank),
  }
}

export async function queueSimulation({ cell, action, currentTime, params, fidelityLevel }) {
  const res = await fetch('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildSimulationPayload({ cell, action, currentTime, params, fidelityLevel })),
  })
  return readJsonResponse(res, 'Simulation queue request failed')
}

export async function fetchJob(jobId) {
  const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`)
  return readJsonResponse(res, 'Job status request failed')
}

export async function runDirectSimulation({ cell, action, currentTime, params, fidelityLevel }) {
  const res = await fetch('/api/simulate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildSimulationPayload({ cell, action, currentTime, params, fidelityLevel })),
  })
  return readJsonResponse(res, 'Direct simulation failed')
}

export async function pollJobUntilTerminal(jobId, { onUpdate, timeoutMs = 90000, intervalMs = 1500 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const payload = await fetchJob(jobId)
    onUpdate?.(payload)
    if (TERMINAL_JOB_STATES.has(payload.status)) return payload
    await new Promise((resolve) => { window.setTimeout(resolve, intervalMs) })
  }
  throw new Error('Job polling timed out')
}

export function downloadRecommendationsCsv(timestamp = '') {
  const query = timestamp ? `?timestamp=${encodeURIComponent(timestamp)}` : ''
  window.location.assign(`/api/recommendations-export${query}`)
}
