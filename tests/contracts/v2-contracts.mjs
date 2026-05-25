import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_MAP_CONTROLS,
  SIMULATION_FIDELITY_LEVELS,
  SIMULATOR_ACTIONS,
  buildSimulationPayload,
  mapRecommendationToSimulatorAction,
  normalizeOperationalCell,
  normalizeThroughputKbps,
} from '../../src/utils/v2Contracts.mjs'
import { deriveMapState } from '../../src/components/admin-map/mapState.mjs'
import { buildSearchIndex, searchAdmin } from '../../src/admin/adminSearch.js'
import { buildSystemEndpointChecks } from '../../src/hooks/useDashboardData.js'

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
  assert.equal(mapRecommendationToSimulatorAction('Tilt / Power'), 'tilt')
  assert.equal(mapRecommendationToSimulatorAction('Ajustement puissance'), 'tilt')
  assert.equal(mapRecommendationToSimulatorAction('Load Rebalancing'), 'redistribute')
  assert.equal(mapRecommendationToSimulatorAction('Equilibrage charge'), 'redistribute')
  assert.equal(mapRecommendationToSimulatorAction('Actions on Neighbors'), 'neighbor_optimization')
  assert.equal(mapRecommendationToSimulatorAction('Actions sur voisins'), 'neighbor_optimization')
  assert.equal(mapRecommendationToSimulatorAction('Carrier Extension'), 'add_carrier')
  assert.equal(mapRecommendationToSimulatorAction('Add Band'), 'add_carrier')
  assert.equal(mapRecommendationToSimulatorAction('Extension L1800'), 'add_carrier')
  assert.equal(mapRecommendationToSimulatorAction('Extension L800'), 'add_carrier')
  assert.equal(mapRecommendationToSimulatorAction('Extension LTE'), 'add_carrier')
  assert.equal(mapRecommendationToSimulatorAction('Add Sector'), 'add_sector')
  assert.equal(mapRecommendationToSimulatorAction('Ajout 4eme secteur'), 'add_sector')
  assert.equal(mapRecommendationToSimulatorAction('Add Site'), null)
  assert.equal(mapRecommendationToSimulatorAction('Check Coverage/Interference'), null)
  assert.equal(mapRecommendationToSimulatorAction('power'), null)
})

test('exposes exactly the source-truth simulator actions', () => {
  assert.deepEqual(SIMULATOR_ACTIONS.map((action) => action.id), [
    'tilt',
    'redistribute',
    'neighbor_optimization',
    'add_carrier',
    'add_sector',
  ])
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
    engine: 'ns3',
    fidelity_level: 'operations_v1',
  })
})

test('builds a calibrated simulator payload when requested', () => {
  assert.ok(SIMULATION_FIDELITY_LEVELS.some((level) => level.id === 'operations_v2_calibrated'))
  const payload = buildSimulationPayload({
    cell: { cell_name: 'TN1158_c01', frequency_band: 3 },
    action: 'add_carrier',
    currentTime: { timestamp: '01-12-2025 00:00', filename: '01-12-2025_00-00.json' },
    fidelityLevel: 'operations_v2_calibrated',
  })

  assert.equal(payload.fidelity_level, 'operations_v2_calibrated')
})

test('rejects unsupported simulator actions before they reach the UI or queue', () => {
  assert.throws(() => buildSimulationPayload({
    cell: { cell_name: 'TN1158_c01' },
    action: 'mimo_upgrade',
    currentTime: {},
  }), /Unsupported simulator action/)

  assert.equal(SIMULATOR_ACTIONS.some((action) => action.id === 'mimo_upgrade'), false)
  assert.equal(SIMULATOR_ACTIONS.some((action) => action.id === 'add_site'), false)
  assert.equal(SIMULATOR_ACTIONS.some((action) => action.id === 'new_site'), false)
  assert.throws(() => buildSimulationPayload({
    cell: { cell_name: 'TN1158_c01' },
    action: 'add_site',
    currentTime: {},
  }), /Unsupported simulator action/)
  assert.throws(() => buildSimulationPayload({
    cell: { cell_name: 'TN1158_c01' },
    action: 'new_site',
    currentTime: {},
  }), /Unsupported simulator action/)
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

test('derives deterministic map state from scope and controls', () => {
  const state = deriveMapState({
    scope: {
      level: 'cell',
      governorateId: 'gov-1',
      delegationId: 'deleg-1',
      selectedCellName: 'TN1158_c01',
    },
    mapControls: { ...DEFAULT_MAP_CONTROLS, heatmap: true, labels: true },
  })

  assert.equal(state.cameraKey, 'cell:gov-1:deleg-1')
  assert.deepEqual(state.filters.selectedCell, ['==', ['get', 'cell_name'], 'TN1158_c01'])
  assert.equal(state.visibility.sites, true)
  assert.equal(state.visibility.heatmap, true)
  assert.equal(state.visibility.labels, true)
  assert.ok(state.hoverLayers.includes('radio-sites'))
})

test('deduplicates site search entries while keeping one result per cell', () => {
  const cells = [
    { cell_name: 'TN1158_c01', site_name: 'TN1158_s01', admin: { deleg_name: 'El Menzah' } },
    { cell_name: 'TN1158_c06', site_name: 'TN1158_s01', admin: { deleg_name: 'El Menzah' } },
    { cell_name: 'TN1158_c02', site_name: 'TN1158_s02', admin: { deleg_name: 'El Menzah' } },
  ]
  const index = buildSearchIndex({ governorates: [], delegations: [] }, cells)
  assert.deepEqual(index.filter((item) => item.type === 'site').map((item) => item.id), ['TN1158_s01', 'TN1158_s02'])
  assert.deepEqual(index.filter((item) => item.type === 'cell').map((item) => item.id), ['TN1158_c01', 'TN1158_c06', 'TN1158_c02'])

  const siteResults = searchAdmin('TN1158_s01', index, 8).filter((item) => item.type === 'site')
  assert.equal(siteResults.length, 1)
  assert.equal(siteResults[0].cell.cell_name, 'TN1158_c01')
})

test('limits system health polling to admin or simulation contexts', () => {
  assert.deepEqual(buildSystemEndpointChecks({ adminToolsEnabled: false, activeTab: 'overview', hasActiveSimulationJob: false }).map((item) => item.name), [])
  assert.deepEqual(buildSystemEndpointChecks({ adminToolsEnabled: false, activeTab: 'operations', hasActiveSimulationJob: false }).map((item) => item.name), ['jobsHealth'])
  assert.deepEqual(buildSystemEndpointChecks({ adminToolsEnabled: false, activeTab: 'overview', hasActiveSimulationJob: true }).map((item) => item.name), ['jobsHealth'])
  assert.deepEqual(buildSystemEndpointChecks({ adminToolsEnabled: true, activeTab: 'system', hasActiveSimulationJob: false }).map((item) => item.name), ['data', 'backend', 'jobsHealth'])
})
