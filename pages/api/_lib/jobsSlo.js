import { getJobsDb } from './jobs.js'

function p95(values = []) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))
  return sorted[idx]
}

export function computeSlo() {
  const db = getJobsDb()
  const rows = db.prepare('SELECT status, request_json, result_json, error_text, started_at, completed_at, created_at FROM jobs ORDER BY created_at DESC LIMIT 500').all()
  const total = Math.max(1, rows.length)
  const done = rows.filter((r) => r.status === 'done')
  const failed = rows.filter((r) => r.status === 'failed')
  const timeouts = failed.filter((r) => String(r.error_text || '').toLowerCase().includes('timeout')).length
  const queueLatencies = rows.map((r) => Date.parse(r.started_at || r.created_at) - Date.parse(r.created_at)).filter((v) => Number.isFinite(v) && v >= 0)
  const byAction = {}
  const actionStats = {}
  let invalidResults = 0
  for (const row of rows) {
    let action = 'unknown'
    let parsedResult = null
    try { action = JSON.parse(row.request_json || '{}')?.action || 'unknown' } catch {}
    try { parsedResult = JSON.parse(row.result_json || '{}') } catch {}
    if (action === 'add_site' || action === 'new_site') continue
    if (!actionStats[action]) actionStats[action] = { total: 0, done: 0, failed: 0, invalid: 0 }
    actionStats[action].total += 1
    if (row.status === 'done') actionStats[action].done += 1
    if (row.status === 'failed') actionStats[action].failed += 1
    const failedByCredibility = String(row.error_text || '').toLowerCase().includes('plausibility validator')
    if (parsedResult?.credibility?.valid === false || failedByCredibility) {
      invalidResults += 1
      actionStats[action].invalid += 1
    }
    if (row.status !== 'done') continue
    const runtimeMs = Date.parse(row.completed_at || row.started_at || row.created_at) - Date.parse(row.started_at || row.created_at)
    if (!Number.isFinite(runtimeMs) || runtimeMs < 0) continue
    if (!byAction[action]) byAction[action] = []
    byAction[action].push(runtimeMs)
  }
  const runtime_p95_ms_by_action = Object.fromEntries(Object.entries(byAction).map(([k, v]) => [k, p95(v)]))
  const latencyDisabled = Object.entries(runtime_p95_ms_by_action)
    .filter(([, ms]) => Number.isFinite(ms) && ms > 10000)
    .map(([action]) => ({ action, reason: 'latence p95 elevee' }))
  const reliabilityDisabled = Object.entries(actionStats)
    .filter(([, stats]) => stats.total >= 5)
    .filter(([, stats]) => (stats.done / stats.total) < 0.65 || (stats.invalid / Math.max(1, stats.done)) > 0.1)
    .map(([action, stats]) => ({ action, reason: `fiabilite faible (success=${(stats.done / stats.total).toFixed(2)}, invalid=${(stats.invalid / Math.max(1, stats.done)).toFixed(2)})` }))
  return {
    window: 'rolling_runtime',
    success_rate: Number((done.length / total).toFixed(3)),
    timeout_rate: Number((timeouts / total).toFixed(3)),
    invalid_result_rate: Number((invalidResults / total).toFixed(3)),
    queue_latency_p95_ms: p95(queueLatencies),
    runtime_p95_ms_by_action,
    disabled_actions: dedupeDisabledActions([...latencyDisabled, ...reliabilityDisabled]),
    failure_rate: Number((failed.length / total).toFixed(3)),
  }
}

function dedupeDisabledActions(entries = []) {
  const map = new Map()
  for (const entry of entries) {
    if (!entry?.action) continue
    if (!map.has(entry.action)) map.set(entry.action, entry)
  }
  return Array.from(map.values())
}
