export async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`${url} returned ${res.status}`)
  return res.json()
}

export async function loadDashboardData() {
  const [baseline, timeIndexPayload, stats, governorates, delegations, registry, cellIndex, reconciliation] = await Promise.all([
    fetchJson('/api/data/baseline.json'),
    fetchJson('/api/data/time_index.json'),
    fetchJson('/api/data/stats.json').catch(() => ({})),
    fetchJson('/geo/tunisia_governorates.geojson'),
    fetchJson('/geo/tunisia_delegations.geojson'),
    fetchJson('/api/data/admin_registry.json').catch(() => fetchJson('/geo/admin_registry.json')),
    fetchJson('/api/data/admin_cell_index.json').catch(() => fetchJson('/geo/admin_cell_index.json')),
    fetchJson('/api/data/admin_reconciliation_report.json').catch(() => fetchJson('/geo/admin_reconciliation_report.json').catch(() => null)),
  ])
  const timestamps = Array.isArray(timeIndexPayload?.timestamps) ? timeIndexPayload.timestamps : []
  const first = timestamps[0]
  const slice = first?.filename ? await fetchJson(`/api/data/time_data/${encodeURIComponent(first.filename)}`) : { observations: {} }
  return {
    baseline,
    timeIndex: timestamps,
    currentTimeEntry: first || null,
    stats,
    observations: slice?.observations || {},
    governorates,
    delegations,
    registry,
    adminCellIndex: cellIndex,
    reconciliation,
  }
}
