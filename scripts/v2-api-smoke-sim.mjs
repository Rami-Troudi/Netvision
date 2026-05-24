const NEXT_BASE = process.env.NEXT_BASE_URL || 'http://127.0.0.1:3000'
const CELL = process.env.SMOKE_CELL || 'TN1158_c01'
const TIME_ENTRY = {
  timestamp: process.env.SMOKE_TIMESTAMP || '01-12-2025 00:00',
  filename: process.env.SMOKE_TIME_FILE || '01-12-2025_00-00.json',
}
const ACTIONS = ['tilt', 'redistribute', 'neighbor_optimization', 'add_carrier', 'add_sector']
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.SMOKE_REQUEST_TIMEOUT_MS || '45000', 10)
const FAST_FALLBACK_ENABLED = process.env.NETVISION_FAST_SIM_FALLBACK === 'true'
const AUTH_TOKEN =
  process.env.API_AUTH_TOKEN
  || process.env.API_TOKEN
  || process.env.AUTH_TOKEN
  || process.env.SESSION_TOKEN
  || ''

function authHeaders() {
  if (!AUTH_TOKEN) return {}
  return {
    Authorization: `Bearer ${AUTH_TOKEN}`,
    'x-api-token': AUTH_TOKEN,
  }
}

function actionParams(action) {
  if (action === 'tilt') return { degrees: 2 }
  if (action === 'redistribute') return { ratio: 0.15 }
  if (action === 'neighbor_optimization') return { interference_relief: 0.12 }
  if (action === 'add_carrier') return { band: 3 }
  if (action === 'add_sector') return { target_sectors: 4 }
  return {}
}

async function readBody(res) {
  const contentType = res.headers.get('content-type') || ''
  if (contentType.includes('application/json')) return res.json().catch(() => ({}))
  return res.text().catch(() => '')
}

async function check(name, fn) {
  const started = Date.now()
  try {
    const detail = await fn()
    console.log(`PASS ${name} ${Date.now() - started}ms ${detail || ''}`)
    return true
  } catch (err) {
    console.error(`FAIL ${name} ${Date.now() - started}ms ${err instanceof Error ? err.message : String(err)}`)
    return false
  }
}

async function expectOk(url, options, describe) {
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
  if (!res.ok) {
    throw new Error(`${describe || url} returned ${res.status}: ${typeof body === 'string' ? body.slice(0, 180) : JSON.stringify(body).slice(0, 180)}`)
  }
  return body
}

async function pollJob(jobId) {
  const started = Date.now()
  while (Date.now() - started < 90000) {
    const payload = await expectOk(`${NEXT_BASE}/api/jobs/${encodeURIComponent(jobId)}`, undefined, 'job status')
    if (payload.status === 'done') return payload
    if (payload.status === 'failed') throw new Error(payload.error || 'queued job failed')
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  throw new Error('queued job timed out')
}

const results = []

if (FAST_FALLBACK_ENABLED) {
  for (const action of ACTIONS) {
    results.push(await check(`Direct fast diagnostic ${action}`, async () => {
      const payload = await expectOk(`${NEXT_BASE}/api/simulate`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ cell_name: CELL, action, params: actionParams(action), time_entry: TIME_ENTRY, engine: 'fast', mode: 'fast' }),
      })
      if (!payload.before || !payload.after) throw new Error('before/after missing')
      return `confidence=${payload.confidence ?? 'n/a'}`
    }))
  }
} else {
  results.push(await check('Direct fast diagnostic disabled by default', async () => {
    const res = await fetch(`${NEXT_BASE}/api/simulate`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ cell_name: CELL, action: 'tilt', params: { degrees: 2 }, time_entry: TIME_ENTRY, engine: 'fast', mode: 'fast' }),
    })
    if (res.status < 400) throw new Error(`expected diagnostic rejection, got ${res.status}`)
    return `rejected=${res.status}`
  }))
}

let jobsHealth = null
results.push(await check('Jobs health', async () => {
  const payload = await expectOk(`${NEXT_BASE}/api/jobs-health`)
  jobsHealth = payload
  return payload.ready === false ? payload.detail || 'not ready' : 'ready'
}))

results.push(await check('Queued simulation lifecycle', async () => {
  if (jobsHealth?.ready === false) {
    return `SKIP ns3 unavailable: ${jobsHealth.detail || jobsHealth.reason || 'not ready'}`
  }
  const queued = await expectOk(`${NEXT_BASE}/api/jobs`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ cell_name: CELL, action: 'tilt', params: { degrees: 2 }, time_entry: TIME_ENTRY, engine: 'ns3', fidelity_level: 'operations_v1' }),
  })
  if (!queued.jobId) throw new Error('jobId missing')
  const finalJob = await pollJob(queued.jobId)
  if (!finalJob.result?.before || !finalJob.result?.after) throw new Error('queued result missing before/after')
  return `job=${queued.jobId}`
}))

results.push(await check('Queued ns3 source-truth actions', async () => {
  if (jobsHealth?.ready === false) {
    return `SKIP ns3 unavailable: ${jobsHealth.detail || jobsHealth.reason || 'not ready'}`
  }
  const summaries = []
  for (const action of ACTIONS) {
    const queued = await expectOk(`${NEXT_BASE}/api/jobs`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ cell_name: CELL, action, params: actionParams(action), time_entry: TIME_ENTRY, engine: 'ns3', fidelity_level: 'operations_v1' }),
    })
    if (!queued.jobId) throw new Error(`${action}: jobId missing`)
    const finalJob = await pollJob(queued.jobId)
    const result = finalJob.result || {}
    if (result.engine !== 'ns3') throw new Error(`${action}: engine is not ns3`)
    if (result.action !== action) throw new Error(`${action}: adapted action mismatch ${result.action}`)
    if (!(result.before?.throughput_mbps > 0)) throw new Error(`${action}: before throughput missing`)
    if (!(result.after?.throughput_mbps > result.before.throughput_mbps)) throw new Error(`${action}: throughput did not improve`)
    if (!(result.after?.prb_load < result.before.prb_load)) throw new Error(`${action}: PRB did not improve`)
    if (!result.artifacts?.scenario || !result.artifacts?.metrics || !result.artifacts?.result) throw new Error(`${action}: artifacts missing`)
    summaries.push(`${action}:${queued.jobId}`)
  }
  return summaries.join(',')
}))

const passed = results.filter(Boolean).length
const failed = results.length - passed
console.log(`\nSimulation smoke result: ${passed}/${results.length} passed, ${failed} failed`)
if (failed) process.exit(1)
