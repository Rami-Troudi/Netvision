const NEXT_BASE = process.env.NEXT_BASE_URL || 'http://127.0.0.1:3000'
const CELL = process.env.SMOKE_CELL || 'TN1158_c01'
const TIME_ENTRY = {
  timestamp: process.env.SMOKE_TIMESTAMP || '01-12-2025 00:00',
  filename: process.env.SMOKE_TIME_FILE || '01-12-2025_00-00.json',
}
const ACTIONS = ['tilt', 'redistribute', 'add_carrier', 'add_sector', 'add_site', 'new_site']
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.SMOKE_REQUEST_TIMEOUT_MS || '45000', 10)
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
  if (action === 'add_carrier') return { band: 3 }
  if (action === 'add_sector') return { targetSectors: 4 }
  return { siteType: 'macro' }
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

for (const action of ACTIONS) {
  results.push(await check(`Direct simulation ${action}`, async () => {
    const payload = await expectOk(`${NEXT_BASE}/api/simulate`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ cell_name: CELL, action, params: actionParams(action), time_entry: TIME_ENTRY, mode: 'fast' }),
    })
    if (!payload.before || !payload.after) throw new Error('before/after missing')
    return `confidence=${payload.confidence ?? 'n/a'}`
  }))
}

results.push(await check('Jobs health', async () => {
  const payload = await expectOk(`${NEXT_BASE}/api/jobs-health`)
  return payload.ready === false ? payload.detail || 'not ready' : 'ready'
}))

results.push(await check('Queued simulation lifecycle', async () => {
  const queued = await expectOk(`${NEXT_BASE}/api/jobs`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ cell_name: CELL, action: 'tilt', params: { degrees: 2 }, time_entry: TIME_ENTRY, mode: 'fast' }),
  })
  if (!queued.jobId) throw new Error('jobId missing')
  const finalJob = await pollJob(queued.jobId)
  if (!finalJob.result?.before || !finalJob.result?.after) throw new Error('queued result missing before/after')
  return `job=${queued.jobId}`
}))

const passed = results.filter(Boolean).length
const failed = results.length - passed
console.log(`\nSimulation smoke result: ${passed}/${results.length} passed, ${failed} failed`)
if (failed) process.exit(1)
