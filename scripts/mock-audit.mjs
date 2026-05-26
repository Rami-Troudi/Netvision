import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const ROOT = process.cwd()
const REAL_ROOT = path.resolve(ROOT, 'runtime_data')
const MOCK_ROOT = path.resolve(ROOT, 'runtime_data_mock')
const OUT_DIR = path.resolve(ROOT, '.runtime', 'mock-audit')

async function readJson(p) {
  return JSON.parse(await readFile(p, 'utf8'))
}

function parseHour(ts) {
  const s = String(ts || '')
  if (s.length >= 13 && /^\d{2}$/.test(s.slice(11, 13))) return Number(s.slice(11, 13))
  if (/^\d{2}/.test(s)) return Number(s.slice(0, 2)) % 24
  return 0
}

function avg(arr) {
  if (!arr.length) return 0
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

function std(arr, mean) {
  if (!arr.length) return 0
  return Math.sqrt(avg(arr.map((x) => (x - mean) ** 2)))
}

function corr(a, b) {
  if (a.length !== b.length || a.length < 2) return 0
  const ma = avg(a)
  const mb = avg(b)
  const sa = std(a, ma)
  const sb = std(b, mb)
  if (!sa || !sb) return 0
  let num = 0
  for (let i = 0; i < a.length; i += 1) num += (a[i] - ma) * (b[i] - mb)
  return num / (a.length * sa * sb)
}

function quantiles(arr) {
  if (!arr.length) return { p50: 0, p90: 0, p99: 0 }
  const s = [...arr].sort((a, b) => a - b)
  const pick = (q) => s[Math.floor((s.length - 1) * q)]
  return { p50: pick(0.5), p90: pick(0.9), p99: pick(0.99) }
}

async function collect(root) {
  const index = await readJson(path.resolve(root, 'time_index.json'))
  const hourly = Array.from({ length: 24 }, () => ({ prb: [], thr: [], cqi: [], users: [], cong: [] }))
  const all = { prb: [], thr: [], cqi: [], users: [], cong: [] }
  const byDay = new Map()
  for (const entry of index.timestamps || []) {
    if (!entry.filename) continue
    const slice = await readJson(path.resolve(root, 'time_data', entry.filename))
    const hour = parseHour(slice.timestamp || entry.timestamp)
    const day = String(slice.timestamp || entry.timestamp).split(' ')[0]
    const obs = Object.values(slice.observations || {})
    const prbValues = obs.map((o) => Number(o.prb_load ?? o.load ?? 0)).filter(Number.isFinite)
    const meanPrb = avg(prbValues)
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day).push({ hour, meanPrb })
    for (const row of obs) {
      const prb = Number(row.prb_load ?? row.load ?? 0)
      const thr = Number(row.throughput ?? 0)
      const cqi = Number(row.cqi ?? 0)
      const users = Number(row.active_users ?? row.rrc_users ?? 0)
      const cong = row.congested ? 1 : 0
      if (Number.isFinite(prb)) { hourly[hour].prb.push(prb); all.prb.push(prb) }
      if (Number.isFinite(thr)) { hourly[hour].thr.push(thr); all.thr.push(thr) }
      if (Number.isFinite(cqi)) { hourly[hour].cqi.push(cqi); all.cqi.push(cqi) }
      if (Number.isFinite(users)) { hourly[hour].users.push(users); all.users.push(users) }
      hourly[hour].cong.push(cong); all.cong.push(cong)
    }
  }
  const hourlySeries = {
    prb: hourly.map((h) => avg(h.prb)),
    throughput: hourly.map((h) => avg(h.thr)),
    cqi: hourly.map((h) => avg(h.cqi)),
    active_users: hourly.map((h) => avg(h.users)),
    congested_rate: hourly.map((h) => avg(h.cong)),
  }
  const dailyBusyHours = []
  for (const vals of byDay.values()) {
    if (!vals.length) continue
    dailyBusyHours.push(vals.reduce((best, cur) => (cur.meanPrb > best.meanPrb ? cur : best)).hour)
  }
  const nocturnalShare = dailyBusyHours.length ? dailyBusyHours.filter((h) => h <= 4).length / dailyBusyHours.length : 0
  return {
    all,
    hourlySeries,
    quantiles: {
      prb: quantiles(all.prb),
      throughput: quantiles(all.thr),
      cqi: quantiles(all.cqi),
      active_users: quantiles(all.users),
    },
    busy_hour: {
      mean: avg(dailyBusyHours),
      nocturnal_share: nocturnalShare,
      sample_count: dailyBusyHours.length,
    },
  }
}

function summarize(real, mock) {
  const kpis = ['prb', 'throughput', 'cqi', 'active_users', 'congested_rate']
  const hourlyCorr = {}
  for (const k of kpis) {
    const rk = k === 'prb' ? real.hourlySeries.prb : real.hourlySeries[k]
    const mk = k === 'prb' ? mock.hourlySeries.prb : mock.hourlySeries[k]
    hourlyCorr[k] = Number(corr(rk, mk).toFixed(4))
  }
  const quantileDeltas = {}
  for (const k of ['prb', 'throughput', 'cqi', 'active_users']) {
    const r = real.quantiles[k]
    const m = mock.quantiles[k]
    quantileDeltas[k] = {
      p50_delta: Number((m.p50 - r.p50).toFixed(2)),
      p90_delta: Number((m.p90 - r.p90).toFixed(2)),
      p99_delta: Number((m.p99 - r.p99).toFixed(2)),
    }
  }
  const bhDrift = Number((mock.busy_hour.mean - real.busy_hour.mean).toFixed(2))
  const nocturnalDrift = Number((mock.busy_hour.nocturnal_share - real.busy_hour.nocturnal_share).toFixed(4))
  return { hourlyCorr, quantileDeltas, bhDrift, nocturnalDrift }
}

function buildMarkdown(report) {
  return `# Mock vs Real Audit\n\n- Generated at: ${report.generated_at}\n- Real root: ${report.real_root}\n- Mock root: ${report.mock_root}\n\n## KPI hourly correlation\n\n${Object.entries(report.metrics.hourlyCorr).map(([k, v]) => `- ${k}: **${v}**`).join('\n')}\n\n## Quantile deltas (mock - real)\n\n${Object.entries(report.metrics.quantileDeltas).map(([k, q]) => `- ${k}: p50 ${q.p50_delta}, p90 ${q.p90_delta}, p99 ${q.p99_delta}`).join('\n')}\n\n## Busy-hour drift\n\n- mean hour drift: **${report.metrics.bhDrift}h**\n- nocturnal share drift: **${report.metrics.nocturnalDrift}**\n\n## Acceptance hints\n\n- corr(prb, users, throughput) should remain high.\n- nocturnal busy-hour share should stay close to real.\n`
}

async function main() {
  const [real, mock] = await Promise.all([collect(REAL_ROOT), collect(MOCK_ROOT)])
  const metrics = summarize(real, mock)
  const report = {
    generated_at: new Date().toISOString(),
    real_root: 'runtime_data',
    mock_root: 'runtime_data_mock',
    metrics,
    real_busy_hour: real.busy_hour,
    mock_busy_hour: mock.busy_hour,
  }
  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(path.resolve(OUT_DIR, 'mock_vs_real_report.json'), JSON.stringify(report, null, 2))
  await writeFile(path.resolve(OUT_DIR, 'mock_vs_real_report.md'), buildMarkdown(report))
  console.log(JSON.stringify({ ok: true, out: path.relative(ROOT, OUT_DIR), metrics }, null, 2))
}

main().catch((error) => {
  console.error('[mock-audit] failed:', error?.message || error)
  process.exit(1)
})
