export function buildSearchIndex(registry, cells) {
  const items = []
  for (const gov of registry?.governorates || []) {
    const name = gov.display_name || gov.gov_name || gov.gov_id || 'Unknown governorate'
    items.push({ type: 'governorate', label: `${name} — Governorate`, searchName: name, id: gov.gov_id, gov })
  }
  for (const deleg of registry?.delegations || []) {
    const name = deleg.display_name || deleg.deleg_name || 'Unknown delegation'
    const gov = deleg.gov_name || deleg.gov_id || 'Unknown governorate'
    items.push({ type: 'delegation', label: `${name} — Delegation, ${gov}`, searchName: name, id: deleg.deleg_id, deleg })
  }
  for (const cell of cells || []) {
    if (cell.site_name) items.push({ type: 'site', label: `${cell.site_name} — Site, ${cell.admin?.deleg_name || 'Unmatched'}`, searchName: cell.site_name, id: cell.site_name, cell })
    items.push({ type: 'cell', label: `${cell.cell_name} — Cell`, searchName: cell.cell_name, id: cell.cell_name, cell })
  }
  return items
}

export function searchAdmin(query, index, limit = 8) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return []
  const scored = []
  for (const item of index || []) {
    const label = item.label.toLowerCase()
    const searchName = String(item.searchName || '').toLowerCase()
    if (!label.includes(q)) continue
    const typeRank = { governorate: 0, delegation: 1, site: 2, cell: 3 }[item.type] ?? 4
    const score = searchName === q ? 0 : label.startsWith(q) ? 1 : label.indexOf(q) + 10
    scored.push({ ...item, score, typeRank })
  }
  return scored.sort((a, b) => a.score - b.score || a.typeRank - b.typeRank || a.label.localeCompare(b.label)).slice(0, limit)
}
