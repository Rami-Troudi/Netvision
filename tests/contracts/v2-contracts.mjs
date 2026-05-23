import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_MAP_CONTROLS,
  SIMULATOR_ACTIONS,
  buildSimulationPayload,
  mapRecommendationToSimulatorAction,
  normalizeOperationalCell,
  normalizeThroughputKbps,
} from '../../src/utils/v2Contracts.mjs'

test('normalizes old and new runtime cell fields into the V2 operational cell contract', () => {
  const cell = normalizeOperationalCell(
    {
      enodeb_name: 'TN1158_s01',
      frequency_band: '3',
      longitude: '10.17',
      latitude: '36.83',
    },
    {
      cell_name: 'TN1158_c01',
      load: '86.8',
      throughput: 12900,
      traffic: '46',
      rrc_users: '44',
      cqi: '11.6',
      ta: '6.3',
      congested: 'true',
    },
    { gov_name: 'Tunis', deleg_name: 'El Menzah' },
  )

  assert.equal(cell.cell_name, 'TN1158_c01')
  assert.equal(cell.site_name, 'TN1158_s01')
  assert.equal(cell.frequency_band, '3')
  assert.equal(cell.prb_load, 86.8)
  assert.equal(cell.throughput_kbps, 12900)
  assert.equal(cell.throughput, 12.9)
  assert.equal(cell.active_users, 46)
  assert.equal(cell.rrc_users, 44)
  assert.equal(cell.cqi, 11.6)
  assert.equal(cell.ta, 6.3)
  assert.equal(cell.congested, true)
  assert.equal(cell.admin.gov_name, 'Tunis')
})

test('normalizes throughput units without silently relabeling Mbps as kbps', () => {
  assert.equal(normalizeThroughputKbps(48), 48)
  assert.equal(normalizeThroughputKbps(12900), 12900)
  assert.equal(normalizeThroughputKbps(null), 0)
})

test('maps backend recommendation labels to supported simulator actions only', () => {
  assert.equal(mapRecommendationToSimulatorAction('Tilt Adjustment'), 'tilt')
  assert.equal(mapRecommendationToSimulatorAction('Load Rebalancing'), 'redistribute')
  assert.equal(mapRecommendationToSimulatorAction('Actions on Neighbors'), 'redistribute')
  assert.equal(mapRecommendationToSimulatorAction('Carrier Extension'), 'add_carrier')
  assert.equal(mapRecommendationToSimulatorAction('Add Band'), 'add_carrier')
  assert.equal(mapRecommendationToSimulatorAction('Add Sector'), 'add_sector')
  assert.equal(mapRecommendationToSimulatorAction('Add Site'), 'add_site')
  assert.equal(mapRecommendationToSimulatorAction('Check Coverage/Interference'), null)
  assert.equal(mapRecommendationToSimulatorAction('power'), null)
})

test('builds a simulator payload with supported action defaults and current time entry', () => {
  const payload = buildSimulationPayload({
    cell: { cell_name: 'TN1158_c01', frequency_band: 3 },
    action: 'tilt',
    currentTime: { timestamp: '01-12-2025 00:00', filename: '01-12-2025_00-00.json' },
  })

  assert.deepEqual(payload, {
    cell_name: 'TN1158_c01',
    action: 'tilt',
    params: { degrees: 2 },
    time_entry: { timestamp: '01-12-2025 00:00', filename: '01-12-2025_00-00.json' },
    mode: 'fast',
  })
})

test('rejects unsupported simulator actions before they reach the UI or queue', () => {
  assert.throws(() => buildSimulationPayload({
    cell: { cell_name: 'TN1158_c01' },
    action: 'mimo_upgrade',
    currentTime: {},
  }), /Unsupported simulator action/)

  assert.equal(SIMULATOR_ACTIONS.some((action) => action.id === 'mimo_upgrade'), false)
})

test('keeps map controls serializable and complete for browser persistence', () => {
  const copy = JSON.parse(JSON.stringify(DEFAULT_MAP_CONTROLS))
  assert.deepEqual(copy, DEFAULT_MAP_CONTROLS)
  assert.equal(DEFAULT_MAP_CONTROLS.basemap, 'admin')
  assert.equal(DEFAULT_MAP_CONTROLS.viewMode, '2d')
  assert.equal(DEFAULT_MAP_CONTROLS.heatmap, false)
  assert.equal(DEFAULT_MAP_CONTROLS.delegations, true)
  assert.equal(DEFAULT_MAP_CONTROLS.sites, true)
  assert.equal(DEFAULT_MAP_CONTROLS.labels, false)
})
