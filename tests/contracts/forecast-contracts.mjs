import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  FORECAST_MODEL_VERSION,
  buildForecastForRuntime,
  parseTimestamp,
  validateForecastArtifact,
} from '../../src/analytics/qosForecast.mjs'
import { buildInsightNarrative } from '../../src/analytics/qosInsightNarratives.mjs'
import forecastHandler from '../../pages/api/forecast.js'
const execFileAsync = promisify(execFile)

function runtimeFixture({ slices = 5 } = {}) {
  const timestamps = Array.from({ length: slices }, (_, idx) => ({
    timestamp: `01-12-2025 ${String(idx).padStart(2, '0')}:00`,
    filename: `slice-${idx}.json`,
  }))
  const timeSlices = timestamps.map((entry, idx) => ({
    timestamp: entry.timestamp,
    observations: {
      TN1158_c01: {
        prb_load: 66 + idx * 5,
        throughput: 28 - idx * 2.7,
        cqi: 10.8 - idx * 0.2,
        active_users: 80 + idx * 12,
        rrc_users: 60 + idx * 8,
        traffic: 22 + idx * 4,
        ta: 3,
      },
      TN1158_c02: {
        prb_load: 42,
        throughput: 38,
        cqi: 11,
        active_users: 40,
        traffic: 12,
      },
    },
  }))
  return {
    mode: 'mock',
    baseline: {
      TN1158_c01: {
        cell_name: 'TN1158_c01',
        site_name: 'TN1158_s01',
        frequency_band: 'L1800',
        admin: { gov_id: 'TN11', gov_name: 'Tunis', deleg_id: 'TN1158', deleg_name: 'El Menzah' },
      },
      TN1158_c02: {
        cell_name: 'TN1158_c02',
        site_name: 'TN1158_s01',
        frequency_band: 'L1800',
        admin: { gov_id: 'TN11', gov_name: 'Tunis', deleg_id: 'TN1158', deleg_name: 'El Menzah' },
      },
    },
    timeIndex: { timestamps },
    timeSlices,
  }
}

test('forecast engine produces bounded explainable risk rows', () => {
  const artifact = buildForecastForRuntime(runtimeFixture(), { horizon: 1, includeLow: true })
  assert.equal(artifact.model_version, FORECAST_MODEL_VERSION)
  assert.equal(artifact.horizon, 1)
  assert.ok(artifact.rows.length >= 2)
  for (const row of artifact.rows) {
    assert.ok(row.risk_score >= 0 && row.risk_score <= 100)
    assert.match(row.risk_level, /^(low|medium|high|critical)$/)
    assert.match(row.confidence, /^(low|medium|high)$/)
    assert.ok(Array.isArray(row.evidence))
    assert.ok(row.current_kpis)
    assert.ok(row.trend_features)
  }
  const risky = artifact.rows.find((row) => row.cell_name === 'TN1158_c01')
  assert.ok(risky.risk_score >= 60)
  assert.notEqual(risky.predicted_issue, 'Risque faible')
  assert.ok(risky.evidence.some((item) => item.includes('PRB') || item.includes('débit')))
})

test('forecast confidence stays low when there are too few slices', () => {
  const artifact = buildForecastForRuntime(runtimeFixture({ slices: 2 }), { horizon: 1, includeLow: true })
  const row = artifact.rows.find((item) => item.cell_name === 'TN1158_c01')
  assert.equal(row.confidence, 'low')
  assert.ok(row.confidence_score < 60)
  assert.ok(row.warnings.some((warning) => warning.includes('historique')))
})

test('forecast scope filtering and horizon validation are deterministic', () => {
  const artifact = buildForecastForRuntime(runtimeFixture(), {
    horizon: 3,
    scope: { scope_level: 'cell', cell_name: 'TN1158_c02' },
    includeLow: true,
  })
  assert.equal(artifact.horizon, 3)
  assert.deepEqual(artifact.rows.map((row) => row.cell_name), ['TN1158_c02'])
  assert.equal(artifact.summary.total_cells, 1)
  assert.throws(() => buildForecastForRuntime(runtimeFixture(), { horizon: 2 }), /horizon/)
})

test('forecast artifact validator catches malformed prediction output', () => {
  const artifact = buildForecastForRuntime(runtimeFixture(), { horizon: 1, includeLow: true })
  assert.deepEqual(validateForecastArtifact(artifact).errors, [])
  const broken = { ...artifact, rows: [{ ...artifact.rows[0], risk_score: 150 }] }
  assert.ok(validateForecastArtifact(broken).errors.some((error) => error.includes('risk_score')))
})

test('assisted narrative explains forecast without autonomous wording', () => {
  const artifact = buildForecastForRuntime(runtimeFixture(), { horizon: 1, includeLow: true })
  const row = artifact.rows.find((item) => item.cell_name === 'TN1158_c01')
  const narrative = buildInsightNarrative(row)
  assert.match(narrative.summary, /risque/i)
  assert.ok(narrative.recommended_inspection.length >= 2)
  const serialized = JSON.stringify(narrative).toLowerCase()
  assert.equal(serialized.includes('autonomous'), false)
  assert.equal(serialized.includes('closed loop'), false)
})

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this },
    setHeader(key, value) { this.headers[key] = value },
  }
}

test('forecast API returns the public schema and validates horizon', async () => {
  process.env.AUTH_BYPASS = 'true'
  process.env.NODE_ENV = 'development'
  process.env.DATA_MODE = 'mock'
  const okReq = { method: 'GET', headers: {}, query: { horizon: '1', limit: '5', include_low: 'true' }, socket: { remoteAddress: '127.0.0.1' } }
  const okRes = makeRes()
  await forecastHandler(okReq, okRes)
  assert.equal(okRes.statusCode, 200)
  assert.equal(okRes.body.ok, true)
  assert.equal(okRes.body.horizon, 1)
  assert.ok(Array.isArray(okRes.body.rows))
  assert.ok(okRes.body.summary)

  const badReq = { ...okReq, query: { horizon: '2' } }
  const badRes = makeRes()
  await forecastHandler(badReq, badRes)
  assert.equal(badRes.statusCode, 400)
  assert.ok(badRes.body.error)
})

test('timestamp parser supports dd-mm, iso and parseable strings', () => {
  assert.ok(parseTimestamp('01-12-2025 00:00') instanceof Date)
  assert.ok(parseTimestamp('2025-12-01T00:00:00Z') instanceof Date)
  assert.ok(parseTimestamp('Mon, 01 Dec 2025 00:00:00 GMT') instanceof Date)
})

test('zero active_users is not treated as missing KPI data', () => {
  const fixture = runtimeFixture()
  fixture.timeSlices = fixture.timeSlices.map((slice) => ({
    ...slice,
    observations: {
      ...slice.observations,
      TN1158_c01: { ...slice.observations.TN1158_c01, active_users: 0 },
    },
  }))
  const artifact = buildForecastForRuntime(fixture, { horizon: 1, includeLow: true })
  const row = artifact.rows.find((item) => item.cell_name === 'TN1158_c01')
  assert.ok(row.trend_features.missing_kpi_ratio < 0.3)
})

test('forecast evaluation script writes a valid metrics file', async () => {
  process.env.DATA_MODE = 'mock'
  await execFileAsync('node', ['scripts/forecast-evaluate.mjs'], { cwd: process.cwd() })
  const outputPath = path.resolve(process.cwd(), '.runtime', 'forecast', 'forecast-evaluation.json')
  const payload = JSON.parse(await fs.readFile(outputPath, 'utf8'))
  assert.equal(payload.ok, true)
  assert.ok(Number.isFinite(payload.precision))
  assert.ok(Number.isFinite(payload.recall))
  assert.ok(Number.isFinite(payload.sample_count))
})
