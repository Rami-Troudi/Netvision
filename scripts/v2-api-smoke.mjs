const NEXT_BASE = process.env.NEXT_BASE_URL || 'http://127.0.0.1:3000'
const BACKEND_BASE = process.env.BACKEND_API_URL || 'http://127.0.0.1:8000'
const CELL = process.env.SMOKE_CELL || 'TN1158_c01'
const TIME_ENTRY = {
  timestamp: process.env.SMOKE_TIMESTAMP || '01-12-2025 00:00',
  filename: process.env.SMOKE_TIME_FILE || '01-12-2025_00-00.json',
}
const ACTIONS = ['tilt', 'redistribute', 'add_carrier', 'add_sector', 'add_site', 'new_site']

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
  const res = await fetch(url, options)
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

results.push(await check('Next data stats', async () => {
  const payload = await expectOk(`${NEXT_BASE}/api/data/stats.json`)
  return `keys=${Object.keys(payload || {}).length}`
}))

results.push(await check('Next data mode', async () => {
  const before = await expectOk(`${NEXT_BASE}/api/data-mode`)
  const res = await fetch(`${NEXT_BASE}/api/data-mode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: before.mode || 'mock' }),
  })
  if (!res.ok) throw new Error(`data-mode POST returned ${res.status}`)
  return `mode=${before.mode || 'unknown'}`
}))

results.push(await check('Next backend health proxy', async () => {
  const payload = await expectOk(`${NEXT_BASE}/api/backend-health`)
  return payload.status || payload.detail || ''
}))

results.push(await check('FastAPI health', async () => {
  const payload = await expectOk(`${BACKEND_BASE}/health`)
  if (payload.status !== 'ok') throw new Error(`unexpected backend status ${payload.status}`)
  return `cells=${payload.n_cells_loaded}`
}))

results.push(await check('Peak-hours API', async () => {
  const payload = await expectOk(`${NEXT_BASE}/api/peak-hours?group_by=cell&cell_name=${encodeURIComponent(CELL)}`)
  return `rows=${payload.rows?.length || 0}`
}))

results.push(await check('Recommendation API', async () => {
  const payload = await expectOk(`${NEXT_BASE}/api/recommend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cell_name: CELL, timestamp: TIME_ENTRY.timestamp }),
  })
  if (!Array.isArray(payload.recommended_actions)) throw new Error('recommended_actions missing')
  return `actions=${payload.recommended_actions.length}`
}))

for (const action of ACTIONS) {
  results.push(await check(`Direct simulation ${action}`, async () => {
    const payload = await expectOk(`${NEXT_BASE}/api/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cell_name: CELL, action: 'tilt', params: { degrees: 2 }, time_entry: TIME_ENTRY, mode: 'fast' }),
  })
  if (!queued.jobId) throw new Error('jobId missing')
  const finalJob = await pollJob(queued.jobId)
  if (!finalJob.result?.before || !finalJob.result?.after) throw new Error('queued result missing before/after')
  return `job=${queued.jobId}`
}))

results.push(await check('Recommendations CSV export', async () => {
  const res = await fetch(`${NEXT_BASE}/api/recommendations-export?timestamp=${encodeURIComponent(TIME_ENTRY.timestamp)}`)
  const text = await res.text()
  if (!res.ok) throw new Error(`CSV export returned ${res.status}: ${text.slice(0, 180)}`)
  if (!text.includes('cell_name') || text.length < 1000) throw new Error('CSV export is empty or malformed')
  return `bytes=${text.length}`
}))

results.push(await check('FastAPI recommendations summary', async () => {
  const payload = await expectOk(`${BACKEND_BASE}/recommendations/summary`)
  return `cells=${payload.total_cells}`
}))

results.push(await check('FastAPI cell history', async () => {
  const payload = await expectOk(`${BACKEND_BASE}/cell/${encodeURIComponent(CELL)}/history`)
  if (!Array.isArray(payload)) throw new Error('history is not an array')
  return `rows=${payload.length}`
}))

const passed = results.filter(Boolean).length
const failed = results.length - passed
console.log(`\nV2 smoke result: ${passed}/${results.length} passed, ${failed} failed`)
if (failed) process.exit(1)
