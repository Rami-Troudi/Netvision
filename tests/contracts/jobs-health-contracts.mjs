import assert from 'node:assert/strict'
import test from 'node:test'

import { getJobsDb } from '../../pages/api/_lib/jobs.js'
import { computeSlo } from '../../pages/api/_lib/jobsSlo.js'

test('jobs-health disables unreliable actions from rolling job history', () => {
  const db = getJobsDb()
  const prefix = `contract-slo-${Date.now()}`
  const now = new Date().toISOString()
  const insert = db.prepare(`
    INSERT INTO jobs (id, idempotency_key, type, status, request_json, result_json, error_text, created_at, updated_at, started_at, completed_at)
    VALUES (?, ?, 'simulate', ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const action = `contract_unstable_${Date.now()}`
  try {
    for (let i = 0; i < 5; i += 1) {
      insert.run(
        `${prefix}-${i}`,
        `${prefix}-key-${i}`,
        i === 0 ? 'done' : 'failed',
        JSON.stringify({ action }),
        i === 0 ? JSON.stringify({ credibility: { valid: true } }) : null,
        i === 0 ? null : 'engine failure',
        now,
        now,
        now,
        now,
      )
    }

    const slo = computeSlo()
    const disabled = slo.disabled_actions.find((entry) => entry.action === action)
    assert.ok(disabled)
    assert.match(disabled.reason, /fiabilite faible/i)
  } finally {
    db.prepare('DELETE FROM jobs WHERE id LIKE ?').run(`${prefix}%`)
  }
})

test('jobs-health filters unsupported historical site actions from current SLOs', () => {
  const db = getJobsDb()
  const prefix = `contract-legacy-${Date.now()}`
  const now = new Date().toISOString()
  const insert = db.prepare(`
    INSERT INTO jobs (id, idempotency_key, type, status, request_json, result_json, created_at, updated_at, started_at, completed_at)
    VALUES (?, ?, 'simulate', 'done', ?, ?, ?, ?, ?, ?)
  `)
  try {
    insert.run(
      `${prefix}-add-site`,
      `${prefix}-key`,
      JSON.stringify({ action: 'add_site' }),
      JSON.stringify({ credibility: { valid: true } }),
      now,
      now,
      now,
      now,
    )

    const slo = computeSlo()
    assert.equal(Object.hasOwn(slo.runtime_p95_ms_by_action, 'add_site'), false)
    assert.equal(slo.disabled_actions.some((entry) => entry.action === 'add_site'), false)
  } finally {
    db.prepare('DELETE FROM jobs WHERE id LIKE ?').run(`${prefix}%`)
  }
})
