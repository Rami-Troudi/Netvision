export function deriveMapState({ scope = {}, mapControls = {}, selectedCellName = '', metricMode = '', timelineIndex = 0 } = {}) {
  const level = scope.level || 'national'
  const governorateId = scope.governorateId || ''
  const delegationId = scope.delegationId || ''
  const selectedCell = selectedCellName || scope.selectedCellName || ''
  const showDelegations = ['governorate', 'delegation', 'cell'].includes(level) && mapControls.delegations !== false
  const showSites = ['delegation', 'cell'].includes(level) && mapControls.sites !== false
  const showHeatmap = showSites && Boolean(mapControls.heatmap)
  const showSelectedCell = level === 'cell' && showSites && Boolean(selectedCell)

  return {
    level,
    metricMode,
    timelineIndex,
    selectedFeatureId: selectedCell || delegationId || governorateId || '',
    filters: {
      governorates: level === 'national' ? null : ['==', ['get', 'gov_id'], governorateId],
      governorateSelected: ['==', ['get', 'gov_id'], governorateId],
      delegations: level === 'governorate'
        ? ['==', ['get', 'gov_id'], governorateId]
        : (level === 'delegation' || level === 'cell')
          ? ['==', ['get', 'deleg_id'], delegationId]
          : ['==', ['get', 'deleg_id'], '__none__'],
      delegationSelected: ['==', ['get', 'deleg_id'], delegationId],
      selectedCell: showSelectedCell ? ['==', ['get', 'worst_cell'], selectedCell] : ['==', ['get', 'worst_cell'], '__none__'],
    },
    visibility: {
      delegations: showDelegations,
      sites: showSites,
      heatmap: showHeatmap,
      labels: showSites && Boolean(mapControls.labels),
      selectedCell: showSelectedCell,
    },
    cameraKey: `${level}:${governorateId}:${delegationId}`,
    cameraTarget: { level, governorateId, delegationId },
    hoverPolicy: {
      clearOnScopeChange: true,
      clearOnSourceRefresh: true,
      clearOnMouseLeave: true,
    },
    hoverLayers: showSites
      ? ['radio-sites', 'admin-delegations-fill', 'admin-governorates-fill']
      : showDelegations
        ? ['admin-delegations-fill', 'admin-governorates-fill']
        : ['admin-governorates-fill'],
  }
}
