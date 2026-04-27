export function buildSearchIndex(registry, cells) {
  const items = []
  for (const gov of registry?.governorates || []) {
    items.push({ type: 'governorate', label: gov.gov_name, id: gov.gov_id, gov })
  }
  for (const deleg of registry?.delegations || []) {
    items.push({ type: 'delegation', label: `${deleg.deleg_name}, ${deleg.gov_name}`, id: deleg.deleg_id, deleg })
  }
  for (const cell of cells || []) {
    if (cell.site_name) items.push({ type: 'site', label: `${cell.site_name}, ${cell.admin?.deleg_name || 'Unmatched'}`, id: cell.site_name, cell })
    items.push({ type: 'cell', label: `${cell.cell_name}, ${cell.admin?.deleg_name || 'Unmatched'}`, id: cell.cell_name, cell })
  }
  return items
}

export function searchAdmin(query, index, limit = 8) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return []
  const scored = []
  for (const item of index || []) {
    const label = item.label.toLowerCase()
    if (!label.includes(q)) continue
    const score = label.startsWith(q) ? 0 : label.indexOf(q)
    scored.push({ ...item, score })
  }
  return scored.sort((a, b) => a.score - b.score || a.label.localeCompare(b.label)).slice(0, limit)
}
