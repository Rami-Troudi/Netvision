export function transitionLabel(scope) {
  if (scope.transitionState === 'focusing-governorate') return `Focusing ${scope.governorateName || 'governorate'}...`
  if (scope.transitionState === 'showing-delegations') return 'Revealing delegation boundaries...'
  if (scope.transitionState === 'focusing-delegation') return `Revealing operational radio assets...`
  if (scope.transitionState === 'showing-sites') return 'Sites and sectors are now scoped to the delegation.'
  return ''
}
