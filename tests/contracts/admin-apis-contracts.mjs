import assert from 'node:assert/strict'
import test from 'node:test'

import importDryRunHandler from '../../pages/api/import-dry-run.js'
import importProfilesHandler from '../../pages/api/import-profiles.js'
import exportScopedHandler from '../../pages/api/export-scoped.js'

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this },
    send(payload) { this.body = payload; return this },
    setHeader(key, value) { this.headers[key] = value },
  }
}

function authReq(overrides = {}) {
  process.env.AUTH_BYPASS = 'true'
  process.env.NODE_ENV = 'development'
  return { method: 'POST', headers: {}, query: {}, body: {}, socket: { remoteAddress: '127.0.0.1' }, ...overrides }
}

test('import dry-run returns schema_diff contract', async () => {
  const req = authReq({
    method: 'POST',
    body: { import_type: 'kpi', csv_text: 'cell_name,load,throughput\nTN1,95,3000\n' },
  })
  const res = makeRes()
  await importDryRunHandler(req, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.mode, 'dry_run')
  assert.ok(res.body.schema_diff)
  assert.ok(Array.isArray(res.body.schema_diff.accepted))
  assert.ok(Array.isArray(res.body.schema_diff.unknown))
  assert.ok(Array.isArray(res.body.schema_diff.missing_required))
})

test('import profiles supports upsert and list', async () => {
  const createReq = authReq({
    method: 'POST',
    body: {
      dataset_name: 'fixture.csv',
      source_type: 'kpi',
      mapping: { cell_name: 'cell_name', load: 'load' },
      strict_congestion_flag: true,
    },
  })
  const createRes = makeRes()
  await importProfilesHandler(createReq, createRes)
  assert.equal(createRes.statusCode, 200)
  assert.equal(createRes.body.profile.dataset_name, 'fixture.csv')

  const listReq = authReq({ method: 'GET' })
  const listRes = makeRes()
  await importProfilesHandler(listReq, listRes)
  assert.equal(listRes.statusCode, 200)
  assert.ok(Array.isArray(listRes.body.profiles))
  assert.ok(listRes.body.profiles.some((p) => p.dataset_name === 'fixture.csv'))
})

test('scoped export returns audit metadata for json', async () => {
  const req = authReq({
    method: 'POST',
    body: {
      format: 'json',
      payload: {
        scope: { level: 'delegation', id: 'deleg-1' },
        time_window: { current_slice: '01-12-2025 00:00' },
        filters: { minPrb: 70 },
        data_mode: 'mock',
        summary: { ok: true },
        rows: [{ cell_name: 'TN1', prb_load: 95 }],
      },
    },
  })
  const res = makeRes()
  await exportScopedHandler(req, res)
  assert.equal(res.statusCode, 200)
  assert.ok(res.body.audit)
  assert.equal(res.body.audit.data_mode, 'mock')
  assert.equal(res.body.audit.scope.level, 'delegation')
})
