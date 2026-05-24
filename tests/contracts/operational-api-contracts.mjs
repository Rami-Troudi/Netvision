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

  assert.equal(rec.title, 'Ajouter un secteur')
  assert.equal(rec.simAction, 'add_sector')
  assert.equal(rec.isSimulatable, true)
  assert.equal(rec.recoveryRate, 85)
  assert.equal(rec.priorityRank, 1)
})

test('keeps non-simulated advisory recommendations visible but not queueable', () => {
  const rec = normalizeRecommendation({
    action: 'Add Site',
    reason: 'site capacitaire requires placement study',
  })

  assert.equal(rec.title, 'Planification site hors simulateur')
  assert.equal(rec.simAction, null)
  assert.equal(rec.isSimulatable, false)
  assert.equal(rec.reason, 'site capacitaire requires placement study')
})

test('normalizes neighbor-sector actions as a distinct source-truth simulator action', () => {
  const rec = normalizeRecommendation({
    action: 'Actions on Neighbors',
    reason: 'neighbor PRB headroom available',
    recovery_rate: 35,
  })

  assert.equal(rec.title, 'Optimiser les voisins')
  assert.equal(rec.simAction, 'neighbor_optimization')
  assert.equal(rec.isSimulatable, true)
  assert.equal(rec.recoveryRate, 35)
})
