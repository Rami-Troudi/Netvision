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
  { id: 'overview', label: 'Vue réseau', short: 'État' },
  { id: 'priorities', label: 'Priorités', short: 'File' },
  { id: 'cell-dossier', label: 'Dossier cellule', short: 'Dossier' },
  { id: 'simulation', label: 'Simulation', short: 'Test' },
])

export const ADMIN_TABS = Object.freeze([
  { id: 'data', label: 'Données', short: 'Données' },
  { id: 'services', label: 'Services', short: 'Services' },
  { id: 'validation', label: 'Validation', short: 'Validation' },
  { id: 'configuration', label: 'Configuration', short: 'Config.' },
])

const MAP_POLICY = Object.freeze({
  operator: {
    overview: { visible: true, density: 'full' },
    priorities: { visible: true, density: 'compact' },
    'cell-dossier': { visible: true, density: 'compact' },
    simulation: { visible: false, density: 'hidden' },
  },
  admin: {
    data: { visible: false, density: 'hidden' },
    services: { visible: false, density: 'hidden' },
    validation: { visible: false, density: 'hidden' },
    configuration: { visible: false, density: 'hidden' },
  },
})

export function getMapPolicy(role, tabId) {
  const mode = role === 'admin' ? 'admin' : 'operator'
  const fallback = mode === 'admin'
    ? { visible: false, density: 'hidden' }
    : { visible: true, density: 'full' }
  return MAP_POLICY[mode]?.[tabId] || fallback
}

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
