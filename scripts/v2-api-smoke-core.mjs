const NEXT_BASE = process.env.NEXT_BASE_URL || 'http://127.0.0.1:3000'
const BACKEND_BASE = process.env.BACKEND_API_URL || 'http://127.0.0.1:8000'
const CELL = process.env.SMOKE_CELL || 'TN1158_c01'
const TIME_ENTRY = {
  timestamp: process.env.SMOKE_TIMESTAMP || '01-12-2025 00:00',
  filename: process.env.SMOKE_TIME_FILE || '01-12-2025_00-00.json',
}
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.SMOKE_REQUEST_TIMEOUT_MS || '30000', 10)
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

const results = []

results.push(await check('Next data stats', async () => {
  const payload = await expectOk(`${NEXT_BASE}/api/data/stats.json`)
  return `keys=${Object.keys(payload || {}).length}`
}))

results.push(await check('Next data mode', async () => {
  const before = await expectOk(`${NEXT_BASE}/api/data-mode`)
  const res = await fetch(`${NEXT_BASE}/api/data-mode`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
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
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ cell_name: CELL, timestamp: TIME_ENTRY.timestamp }),
  })
  if (!Array.isArray(payload.recommended_actions)) throw new Error('recommended_actions missing')
  return `actions=${payload.recommended_actions.length}`
}))

const passed = results.filter(Boolean).length
const failed = results.length - passed
console.log(`\nCore smoke result: ${passed}/${results.length} passed, ${failed} failed`)
if (failed) process.exit(1)
