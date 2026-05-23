export const initialAdminScope = {
  level: 'national',
  governorateId: null,
  governorateName: null,
  delegationId: null,
  delegationName: null,
  selectedSite: null,
  selectedCellName: null,
  transitionState: 'idle',
}

export function setAdminScope(current, patch) {
  const next = { ...current, ...patch }
  if (next.level === 'national') {
    return { ...initialAdminScope, transitionState: next.transitionState || 'idle' }
  }
  if (next.level === 'governorate') {
    next.delegationId = null
    next.delegationName = null
    next.selectedSite = null
    next.selectedCellName = null
  }
  if (next.level === 'delegation') {
    next.selectedSite = null
    next.selectedCellName = null
  }
  return next
}

export function getAdminScope(scope) {
  return { ...scope }
}

export function backToNational() {
  return { ...initialAdminScope }
}

export function backToGovernorate(scope) {
  if (!scope?.governorateId) return backToNational()
  return {
    ...initialAdminScope,
    level: 'governorate',
    governorateId: scope.governorateId,
    governorateName: scope.governorateName,
  }
}

export function backToDelegation(scope) {
  if (!scope?.delegationId) return backToGovernorate(scope)
  return {
    ...initialAdminScope,
    level: 'delegation',
    governorateId: scope.governorateId,
    governorateName: scope.governorateName,
    delegationId: scope.delegationId,
    delegationName: scope.delegationName,
  }
}

export function getCurrentScopeLabel(scope) {
  if (scope.level === 'cell') return scope.selectedCellName || 'Cellule selectionnee'
  if (scope.level === 'delegation') return scope.delegationName || 'Delegation'
  if (scope.level === 'governorate') return scope.governorateName || 'Gouvernorat'
  return 'Vue nationale Tunisie'
}

export function getScopedCellNames(scope, adminCellIndex) {
  const entries = Object.entries(adminCellIndex || {})
  if (scope.level === 'national') return entries.map(([cell]) => cell)
  if (scope.level === 'governorate') {
    return entries.filter(([, meta]) => meta.gov_id === scope.governorateId).map(([cell]) => cell)
  }
  if (scope.level === 'delegation') {
    return entries.filter(([, meta]) => meta.deleg_id === scope.delegationId).map(([cell]) => cell)
  }
  if (scope.level === 'cell' && scope.selectedCellName) return [scope.selectedCellName]
  return []
}
