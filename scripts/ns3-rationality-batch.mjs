import fs from 'fs/promises'
import path from 'path'

const NEXT_BASE = process.env.NEXT_BASE_URL || 'http://127.0.0.1:3000'
const AUTH_TOKEN =
  process.env.API_AUTH_TOKEN
  || process.env.API_TOKEN
  || process.env.AUTH_TOKEN
  || process.env.SESSION_TOKEN
  || ''
const RUNS_PER_ACTION = Number.parseInt(process.env.NS3_BATCH_RUNS || '5', 10)
const CELLS_COUNT = Number.parseInt(process.env.NS3_BATCH_CELLS || '10', 10)
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.NS3_BATCH_TIMEOUT_MS || '45000', 10)
const RATE_LIMIT_BACKOFF_MS = Number.parseInt(process.env.NS3_BATCH_BACKOFF_MS || '3500', 10)
const MAX_RETRIES = Number.parseInt(process.env.NS3_BATCH_RETRIES || '6', 10)
const ACTIONS = ['tilt', 'redistribute', 'neighbor_optimization', 'add_carrier', 'add_sector']
const TIME_ENTRY = {
  timestamp: process.env.NS3_BATCH_TIMESTAMP || '01-12-2025 00:00',
  filename: process.env.NS3_BATCH_TIME_FILE || '01-12-2025_00-00.json',
}

function authHeaders() {
  if (!AUTH_TOKEN) return {}
  return { Authorization: `Bearer ${AUTH_TOKEN}`, 'x-api-token': AUTH_TOKEN }
}

function actionParams(action) {
  if (action === 'tilt') return { degrees: 2, power_delta_db: 0 }
  if (action === 'redistribute') return { ratio: 0.15 }
  if (action === 'neighbor_optimization') return { interference_relief: 0.12 }
  if (action === 'add_carrier') return { band: 3, bandwidth_mhz: 10 }
  if (action === 'add_sector') return { target_sectors: 4 }
  return {}
}

async function readBody(res) {
  const contentType = res.headers.get('content-type') || ''
  if (contentType.includes('application/json')) return res.json().catch(() => ({}))
  return res.text().catch(() => '')
}

async function fetchJson(url, options, label) {
  let attempt = 0
  while (attempt <= MAX_RETRIES) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    const nextOptions = options || {}
    const res = await fetch(url, {
      ...nextOptions,
      headers: { ...authHeaders(), ...(nextOptions.headers || {}) },
      signal: controller.signal,
    })
    clearTimeout(timeout)
    const body = await readBody(res)
    if (res.ok) return body
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const waitMs = RATE_LIMIT_BACKOFF_MS * (attempt + 1)
      await new Promise((resolve) => setTimeout(resolve, waitMs))
      attempt += 1
      continue
    }
    throw new Error(`${label || url} returned ${res.status}: ${typeof body === 'string' ? body.slice(0, 220) : JSON.stringify(body).slice(0, 220)}`)
  }
  throw new Error(`${label || url} exceeded retry budget`)
}

async function pollJob(jobId) {
  const started = Date.now()
  while (Date.now() - started < 120000) {
    const payload = await fetchJson(`${NEXT_BASE}/api/jobs/${encodeURIComponent(jobId)}`, undefined, 'job status')
    if (payload.status === 'done') return payload
    if (payload.status === 'failed') throw new Error(payload.error || `job ${jobId} failed`)
    await new Promise((resolve) => setTimeout(resolve, 1200))
  }
  throw new Error(`job ${jobId} polling timeout`)
}

function evalRationality(result, action) {
  const before = result?.before || {}
  const after = result?.after || {}
  const impact = result?.impact || {}

  const findings = []
  if (!(Number(after.prb_load) <= Number(before.prb_load) + 0.001)) findings.push('prb_not_improved')
  if (!(Number(after.throughput_mbps) >= Number(before.throughput_mbps) - 0.001)) findings.push('throughput_not_improved')
  if (!(Number(after.cqi) >= Number(before.cqi) - 1.0)) findings.push('cqi_regression')
  if (!(Number(after.active_users) >= Number(before.active_users) - 0.001)) findings.push('served_users_regression')
  if (!['low', 'medium', 'high'].includes(String(result.confidence || '').toLowerCase())) findings.push('confidence_missing')
  if (!Number.isFinite(Number(result.confidence_pct))) findings.push('confidence_pct_missing')
  if (!Array.isArray(result.confidence_explain)) findings.push('confidence_explain_missing')
  if (!Array.isArray(impact.affected_neighbors)) findings.push('neighbors_missing')
  if (action === 'redistribute' || action === 'neighbor_optimization') {
    if (!(impact.affected_neighbors || []).length) findings.push('neighbors_expected_for_action')
  }

  return {
    rational: findings.length === 0,
    findings,
  }
}

function aggregateRows(rows) {
  const summary = {
    total_runs: rows.length,
    rational_runs: 0,
    irrational_runs: 0,
    by_action: {},
    by_cell: {},
    findings: {},
    confidence_pct: { min: null, max: null, avg: null },
  }

  let confidenceSum = 0
  let confidenceCount = 0

  for (const row of rows) {
    const actionBucket = summary.by_action[row.action] || { total: 0, rational: 0, irrational: 0 }
    actionBucket.total += 1
    if (row.rational) actionBucket.rational += 1
    else actionBucket.irrational += 1
    summary.by_action[row.action] = actionBucket

    const cellBucket = summary.by_cell[row.cell] || { total: 0, rational: 0, irrational: 0 }
    cellBucket.total += 1
    if (row.rational) cellBucket.rational += 1
    else cellBucket.irrational += 1
    summary.by_cell[row.cell] = cellBucket

    if (row.rational) summary.rational_runs += 1
    else summary.irrational_runs += 1

    for (const f of row.findings) summary.findings[f] = (summary.findings[f] || 0) + 1

    if (Number.isFinite(Number(row.confidence_pct))) {
      const v = Number(row.confidence_pct)
      confidenceSum += v
      confidenceCount += 1
      summary.confidence_pct.min = summary.confidence_pct.min === null ? v : Math.min(summary.confidence_pct.min, v)
      summary.confidence_pct.max = summary.confidence_pct.max === null ? v : Math.max(summary.confidence_pct.max, v)
    }
  }

  if (confidenceCount) summary.confidence_pct.avg = Math.round((confidenceSum / confidenceCount) * 100) / 100
  return summary
}

async function main() {
  const jobsHealth = await fetchJson(`${NEXT_BASE}/api/jobs-health`)
  if (jobsHealth.ready === false) {
    throw new Error(`ns3 not ready: ${jobsHealth.detail || jobsHealth.reason || 'unknown'}`)
  }

  const baselinePath = path.resolve(process.cwd(), 'runtime_data_mock', 'baseline.json')
  const baselineRaw = await fs.readFile(baselinePath, 'utf8')
  const baseline = JSON.parse(baselineRaw)
  const cells = Object.keys(baseline).slice(0, CELLS_COUNT)
  if (cells.length < CELLS_COUNT) {
    throw new Error(`insufficient cells in baseline, found ${cells.length}, requested ${CELLS_COUNT}`)
  }

  const rows = []
  for (const cell of cells) {
    for (const action of ACTIONS) {
      for (let i = 0; i < RUNS_PER_ACTION; i += 1) {
        const queued = await fetchJson(`${NEXT_BASE}/api/jobs`, {
          method: 'POST',
          headers: { ...authHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cell_name: cell,
            action,
            params: actionParams(action),
            time_entry: TIME_ENTRY,
            engine: 'ns3',
            fidelity_level: 'operations_v1',
            scenario_id: `batch-${cell}-${action}-r${i + 1}`,
          }),
        }, 'queue simulation')
        await new Promise((resolve) => setTimeout(resolve, 250))
        const finalJob = await pollJob(queued.jobId)
        const result = finalJob.result || {}
        const rationality = evalRationality(result, action)
        rows.push({
          cell,
          action,
          run: i + 1,
          job_id: queued.jobId,
          rational: rationality.rational,
          findings: rationality.findings,
          confidence: result.confidence,
          confidence_pct: result.confidence_pct,
          prb_before: result?.before?.prb_load ?? null,
          prb_after: result?.after?.prb_load ?? null,
          thp_before: result?.before?.throughput_mbps ?? null,
          thp_after: result?.after?.throughput_mbps ?? null,
          cqi_before: result?.before?.cqi ?? null,
          cqi_after: result?.after?.cqi ?? null,
        })
      }
    }
  }

  const summary = aggregateRows(rows)
  const outDir = path.resolve(process.cwd(), '.runtime', 'qa')
  await fs.mkdir(outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = path.resolve(outDir, `ns3-rationality-${stamp}.json`)
  await fs.writeFile(outPath, JSON.stringify({ config: { cells, actions: ACTIONS, runs_per_action: RUNS_PER_ACTION, time_entry: TIME_ENTRY }, summary, rows }, null, 2), 'utf8')

  console.log(JSON.stringify({ outPath, summary }, null, 2))
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
