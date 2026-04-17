export function buildFeatureUpdateMapFromPayload(featureUpdates = []) {
  const updatesByCellName = new Map();

  if (Array.isArray(featureUpdates)) {
    featureUpdates.forEach((update) => {
      if (!update || typeof update !== 'object') return;
      const updateCellName = String(update.cellName ?? update.cell_name ?? '').trim();
      if (!updateCellName) return;
      updatesByCellName.set(updateCellName, update);
    });
    return updatesByCellName;
  }

  if (featureUpdates && typeof featureUpdates === 'object') {
    Object.entries(featureUpdates).forEach(([cellName, update]) => {
      if (!update || typeof update !== 'object') return;
      const normalizedCellName = String(cellName || '').trim();
      if (!normalizedCellName) return;
      updatesByCellName.set(normalizedCellName, { ...update, cellName: normalizedCellName });
    });
  }

  return updatesByCellName;
}
