export function isAdminToolsEnabled() {
  if (typeof window === 'undefined') return process.env.NEXT_PUBLIC_NETVISION_ADMIN_TOOLS === 'true'
  const params = new URLSearchParams(window.location.search)
  const role = window.localStorage?.getItem('netvision_role')
  return process.env.NEXT_PUBLIC_NETVISION_ADMIN_TOOLS === 'true' || params.get('admin') === '1' || role === 'admin'
}

export function getNetvisionRole() {
  if (typeof window === 'undefined') return 'operator'
  const params = new URLSearchParams(window.location.search)
  if (params.get('admin') === '1' || process.env.NEXT_PUBLIC_NETVISION_ADMIN_TOOLS === 'true') return 'admin'
  return window.localStorage?.getItem('netvision_role') === 'admin' ? 'admin' : 'operator'
}

export function setNetvisionRole(role) {
  if (typeof window === 'undefined') return
  const next = role === 'admin' ? 'admin' : 'operator'
  window.localStorage?.setItem('netvision_role', next)
}

export const OPERATOR_TABS = Object.freeze([
  { id: 'overview', label: 'Vue réseau', short: 'VR' },
  { id: 'priorities', label: 'Priorités', short: 'PR' },
  { id: 'cell-dossier', label: 'Dossier cellule', short: 'DC' },
  { id: 'simulation', label: 'Simulation', short: 'SM' },
])

export const ADMIN_TABS = Object.freeze([
  { id: 'data', label: 'Données', short: 'DN' },
  { id: 'services', label: 'Services', short: 'SV' },
  { id: 'validation', label: 'Validation', short: 'VL' },
  { id: 'configuration', label: 'Configuration', short: 'CF' },
])

export const ACTION_LABELS_FR = Object.freeze({
  tilt: 'Ajuster inclinaison / puissance',
  redistribute: 'Rééquilibrer la charge',
  neighbor_optimization: 'Optimiser les voisins',
  add_carrier: 'Ajouter une porteuse',
  add_sector: 'Ajouter un secteur',
})

export const STATE_LABELS_FR = Object.freeze({
  critical: 'Critique',
  watch: 'Sous surveillance',
  degraded: 'Qualité dégradée',
  healthy: 'Normal',
  no_data: 'Sans KPI',
  unmatched: 'Non rapproché',
  stable: 'Normal',
})

export function stateLabelFr(state) {
  return STATE_LABELS_FR[state] || 'Inconnu'
}

export function diagnosisLabelFr(issue = {}) {
  const key = String(issue.issue || '').toLowerCase()
  if (key.includes('capacity') || key.includes('congestion') || key.includes('load')) return 'Congestion capacitaire'
  if (key.includes('radio') || key.includes('interference') || key.includes('edge') || key.includes('cqi')) return 'Qualité radio dégradée'
  if (key.includes('data') || key.includes('telemetry')) return 'Données insuffisantes'
  if (key.includes('normal') || key.includes('acceptable')) return 'Charge élevée mais acceptable'
  return 'Diagnostic radio à confirmer'
}
