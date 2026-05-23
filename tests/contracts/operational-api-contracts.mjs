import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeRecommendation } from '../../src/services/operationalApi.mjs'

test('normalizes simulatable backend recommendations for V2 cards', () => {
  const rec = normalizeRecommendation({
    action: 'Add Sector',
    reason: 'structural congestion',
    tier: 'long_terme',
    recovery_rate: 85,
    gain_ue: 21,
    gain_gb: 51,
    priority_rank: 1,
  })

  assert.equal(rec.title, 'Add Sector')
  assert.equal(rec.simAction, 'add_sector')
  assert.equal(rec.isSimulatable, true)
  assert.equal(rec.recoveryRate, 85)
  assert.equal(rec.priorityRank, 1)
})

test('keeps non-simulated advisory recommendations visible but not queueable', () => {
  const rec = normalizeRecommendation({
    action: 'Check Coverage/Interference',
    reason: 'coverage/interference issue',
  })

  assert.equal(rec.title, 'Check Coverage/Interference')
  assert.equal(rec.simAction, null)
  assert.equal(rec.isSimulatable, false)
  assert.equal(rec.reason, 'coverage/interference issue')
})
