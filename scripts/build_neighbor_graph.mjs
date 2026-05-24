import fs from 'fs/promises'
import path from 'path'

const projectRoot = process.cwd()
const modes = process.argv.slice(2).length ? process.argv.slice(2) : ['runtime_data', 'runtime_data_mock']
const MAX_NEAREST = 8
const MAX_OVERLAP = 6
const MAX_CANDIDATE_OFFLOAD = 6

for (const modePath of modes) {
  const runtimeRoot = path.resolve(projectRoot, modePath)
  const baseline = await readJson(path.resolve(runtimeRoot, 'baseline.json'))
  const firstSlice = await loadFirstSlice(runtimeRoot)
  const observations = firstSlice?.observations || {}
  const cells = Object.entries(baseline).map(([name, cell]) => ({ name, ...cell }))
  const graph = {
    __meta: {
      generated_at: new Date().toISOString(),
      source: 'inferred',
      method: 'same_site + haversine distance + delegation + azimuth overlap + PRB headroom',
      cells: cells.length,
      time_slice: firstSlice?.timestamp || null,
    },
  }

  for (const cell of cells) {
    const scored = cells
      .filter((candidate) => candidate.name !== cell.name && hasCoordinates(cell) && hasCoordinates(candidate))
      .map((candidate) => scoreCandidate(cell, candidate, observations[candidate.name]))
      .sort((a, b) => a.distance_km - b.distance_km)

    const sameSite = scored.filter((entry) => entry.same_site).map((entry) => entry.cell_name)
    const nearest = scored.slice(0, MAX_NEAREST).map((entry) => entry.cell_name)
    const overlapping = scored
      .filter((entry) => entry.same_delegation && entry.azimuth_delta <= 90)
      .slice(0, MAX_OVERLAP)
      .map((entry) => entry.cell_name)
    const candidateOffload = scored
      .filter((entry) => entry.headroom >= 15 && (entry.same_delegation || entry.distance_km <= 8))
      .slice(0, MAX_CANDIDATE_OFFLOAD)
      .map((entry) => entry.cell_name)

    graph[cell.name] = {
      same_site: unique(sameSite),
      nearest: unique(nearest),
      overlapping: unique(overlapping),
      candidate_offload: unique(candidateOffload),
    }
  }

  const outputPath = path.resolve(runtimeRoot, 'neighbor_graph.json')
  await fs.writeFile(outputPath, JSON.stringify(graph, null, 2), 'utf8')
  console.log(`Wrote ${path.relative(projectRoot, outputPath)} (${cells.length} cells)`)
}

function scoreCandidate(cell, candidate, obs = {}) {
  const distance = haversineKm(cell.latitude, cell.longitude, candidate.latitude, candidate.longitude)
  const sameSite = cell.site_name && candidate.site_name && cell.site_name === candidate.site_name
  const sameDelegation = cell.admin?.deleg_id && candidate.admin?.deleg_id && cell.admin.deleg_id === candidate.admin.deleg_id
  const load = Number(obs.prb_load ?? obs.load ?? 75) || 75
  return {
    cell_name: candidate.name,
    distance_km: sameSite ? Math.max(0.01, distance) : distance,
    same_site: Boolean(sameSite),
    same_delegation: Boolean(sameDelegation),
    azimuth_delta: azimuthDelta(Number(cell.azimuth || 0), Number(candidate.azimuth || 0)),
    headroom: Math.max(0, 85 - load),
  }
}

async function loadFirstSlice(runtimeRoot) {
  try {
    const index = await readJson(path.resolve(runtimeRoot, 'time_index.json'))
    const first = Array.isArray(index.timestamps) ? index.timestamps[0] : null
    if (!first?.filename) return null
    return await readJson(path.resolve(runtimeRoot, 'time_data', first.filename))
  } catch {
    return null
  }
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, 'utf8')
  return JSON.parse(raw)
}

function hasCoordinates(cell) {
  return Number.isFinite(Number(cell?.latitude)) && Number.isFinite(Number(cell?.longitude))
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)))
}

function azimuthDelta(a, b) {
  const diff = Math.abs(((a - b + 540) % 360) - 180)
  return Number.isFinite(diff) ? diff : 180
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const radius = 6371
  const dLat = toRad(Number(lat2) - Number(lat1))
  const dLon = toRad(Number(lon2) - Number(lon1))
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(Number(lat1))) * Math.cos(toRad(Number(lat2))) * Math.sin(dLon / 2) ** 2
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function toRad(degrees) {
  return Number(degrees) * Math.PI / 180
}
