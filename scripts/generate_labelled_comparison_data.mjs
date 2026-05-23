import fs from 'node:fs/promises'
import path from 'node:path'

const ROOT = process.cwd()
const SOURCES = ['runtime_data', 'runtime_data_mock']
const OUT_DIR = path.join(ROOT, 'artifacts', 'labelled-comparison')

function toNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function classify({ prbLoad, throughputMbps, cqi, activeUsers }) {
  const highPrb = prbLoad >= 85
  const lowThroughput = throughputMbps > 0 && throughputMbps < 15
  const lowCqi = cqi > 0 && cqi < 8
  const highUsers = activeUsers >= 40
  const congested = highPrb && (lowThroughput || lowCqi || highUsers)
  const severity = congested ? 'critical' : (highPrb || lowThroughput || lowCqi ? 'watch' : 'healthy')
  let issue = 'Normal'
  if (congested) issue = 'Congestion Confirmed'
  else if (highPrb && lowThroughput) issue = 'Capacity Pressure'
  else if (lowCqi) issue = 'Radio Quality'
  else if (highPrb) issue = 'High PRB'
  const health = congested ? 45 : severity === 'watch' ? 70 : 92
  return { congested, severity, issue, health }
}

async function safeReadJson(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function csvEscape(value) {
  const text = String(value ?? '')
  return /[,"\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function toCsv(rows) {
  if (!rows.length) return ''
  const headers = Object.keys(rows[0])
  const lines = [headers.join(',')]
  for (const row of rows) {
    lines.push(headers.map((key) => csvEscape(row[key])).join(','))
  }
  return lines.join('\n')
}

async function buildForSource(sourceName) {
  const sourceRoot = path.join(ROOT, sourceName)
  const baseline = await safeReadJson(path.join(sourceRoot, 'baseline.json'), {})
  const timeIndexPayload = await safeReadJson(path.join(sourceRoot, 'time_index.json'), { timestamps: [] })
  const timeEntries = Array.isArray(timeIndexPayload?.timestamps) ? timeIndexPayload.timestamps : []
  const rows = []

  for (const entry of timeEntries) {
    const fileName = entry?.filename
    if (!fileName) continue
    const timeSlice = await safeReadJson(path.join(sourceRoot, 'time_data', fileName), {})
    const observations = timeSlice?.observations || {}
    const timestamp = String(timeSlice?.timestamp || entry?.timestamp || '')
    for (const [cellName, obs] of Object.entries(observations)) {
      const base = baseline[cellName] || {}
      const prbLoad = toNumber(obs.prb_load ?? obs.load, 0)
      const throughputMbps = toNumber(obs.throughput, 0)
      const throughputKbps = toNumber(obs.throughput_kbps, throughputMbps * 1000)
      const cqi = toNumber(obs.cqi, 0)
      const activeUsers = toNumber(obs.active_users ?? obs.traffic, 0)
      const rrcUsers = toNumber(obs.rrc_users, 0)
      const trafficGb = toNumber(obs.traffic, 0)
      const ta = toNumber(obs.ta, 0)
      const label = classify({ prbLoad, throughputMbps, cqi, activeUsers })
      rows.push({
        source: sourceName,
        timestamp,
        cell_name: cellName,
        site_name: String(base.site_name || obs.site_name || ''),
        frequency_band: String(base.frequency_band || obs.frequency_band || ''),
        prb_load: prbLoad.toFixed(2),
        throughput: throughputMbps.toFixed(2),
        throughput_kbps: throughputKbps.toFixed(2),
        active_users: String(activeUsers),
        rrc_users: String(rrcUsers),
        traffic: trafficGb.toFixed(3),
        cqi: cqi.toFixed(2),
        ta: ta.toFixed(2),
        health: String(label.health),
        congested: String(label.congested),
        issue_type: label.issue,
        severity: label.severity,
        root_cause: obs.root_cause || label.issue,
        old_load: prbLoad.toFixed(2),
        old_traffic: String(activeUsers),
        old_status_label: label.severity,
      })
    }
  }

  return rows
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true })
  const allRows = []
  for (const sourceName of SOURCES) {
    const rows = await buildForSource(sourceName)
    if (!rows.length) continue
    for (const row of rows) allRows.push(row)
    await fs.writeFile(path.join(OUT_DIR, `${sourceName}-labelled-comparison.csv`), toCsv(rows), 'utf8')
    await fs.writeFile(path.join(OUT_DIR, `${sourceName}-labelled-comparison.json`), JSON.stringify(rows, null, 2), 'utf8')
  }

  const summary = {
    generated_at: new Date().toISOString(),
    sources: SOURCES,
    rows: allRows.length,
    cells: new Set(allRows.map((row) => row.cell_name)).size,
    timestamps: new Set(allRows.map((row) => row.timestamp)).size,
    congested_rows: allRows.filter((row) => row.congested === 'true').length,
  }
  await fs.writeFile(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8')
  console.log(`Generated labelled comparison data in ${OUT_DIR} (${summary.rows} rows)`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
