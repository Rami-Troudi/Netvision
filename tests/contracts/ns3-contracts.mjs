import assert from 'node:assert/strict'
import test from 'node:test'
import { access, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'

import {
  DEFAULT_SIMULATION_ENGINE,
  FAST_SIM_FALLBACK_ENABLED,
  resolveValidatedTimeEntry,
  validateSimulationRequest,
} from '../../pages/api/_lib/simulationContract.js'
import path from 'node:path'
const require = createRequire(import.meta.url)
const { canSimulate } = require('../../pages/api/_lib/simGuardrails.js')

test('defaults simulation requests to the ns3 engine', () => {
  assert.equal(DEFAULT_SIMULATION_ENGINE, 'ns3')
})

test('accepts operations_v2_calibrated fidelity level', async () => {
  const validation = await validateSimulationRequest({
    cell_name: 'TN1158_c01',
    action: 'tilt',
    fidelity_level: 'operations_v2_calibrated',
    params: { degrees: 2 },
    time_entry: { filename: '01-12-2025_00-00.json' },
  })
  assert.equal(validation, null)
})

test('rejects fast simulation engine unless explicit fallback is enabled', async () => {
  assert.equal(FAST_SIM_FALLBACK_ENABLED, false)
  const validation = await validateSimulationRequest({
    cell_name: 'TN1158_c01',
    action: 'tilt',
    engine: 'fast',
    params: { degrees: 2 },
    time_entry: { filename: '01-12-2025_00-00.json' },
  })

  assert.equal(validation.status, 400)
  assert.match(validation.error, /engine must be one of: ns3/i)
})

test('builds an ns3 scenario with bounded local topology', async () => {
  const { buildScenario } = await import('../../simulation/ns3/scenario-builder/build_scenario.mjs')
  const scenario = await buildScenario({
    projectRoot: process.cwd(),
    payload: {
      cell_name: 'TN1158_c01',
      action: 'add_carrier',
      params: { band: 3, bandwidth_mhz: 10 },
      time_entry: { timestamp: '01-12-2025 00:00', filename: '01-12-2025_00-00.json' },
      engine: 'ns3',
      data_mode: 'mock',
    },
    jobId: 'contract-ns3',
  })

  assert.equal(scenario.engine, 'ns3')
  assert.equal(scenario.fidelity_level, 'operations_v1')
  assert.equal(scenario.scenario.target_cell, 'TN1158_c01')
  assert.equal(scenario.action.type, 'add_carrier')
  assert.ok(scenario.topology.target)
  assert.ok(scenario.topology.neighbors.length <= 12)
  assert.ok(scenario.traffic_model.ue_count <= 300)
  assert.ok(scenario.scenario.duration_seconds <= 30)
  assert.equal(scenario.guardrails.valid, true)
  assert.ok(Array.isArray(scenario.guardrails.warnings))
})

test('adapts ns3 metrics to the NetVision before-after contract', async () => {
  const { adaptNs3Result } = await import('../../simulation/ns3/adapter/ns3ResultAdapter.js')
  const result = adaptNs3Result({
    scenario: {
      job_id: 'contract-ns3',
      action: { type: 'add_carrier' },
      observed_kpis: { prb_load: 95, throughput_mbps: 2, cqi: 8, active_users: 73 },
    },
    metrics: {
      before: { avg_throughput_mbps: 2.1, estimated_prb_load: 95, avg_cqi: 8.1, served_users: 80 },
      after: { avg_throughput_mbps: 6.4, estimated_prb_load: 72, avg_cqi: 9.2, served_users: 105 },
      runtime_seconds: 12.4,
    },
    artifacts: { scenario: '.runtime/ns3-jobs/contract-ns3/scenario.json' },
  })

  assert.equal(result.engine, 'ns3')
  assert.equal(result.fidelity_level, 'operations_v1')
  assert.ok(result.before)
  assert.ok(result.after)
  assert.ok(result.impact)
  assert.equal(result.action, 'add_carrier')
  assert.ok(['low', 'medium', 'high'].includes(result.confidence))
  assert.ok(Number.isFinite(Number(result.confidence_pct)))
  assert.ok(Array.isArray(result.confidence_explain))
  assert.ok(Array.isArray(result.scenario_assumptions))
  assert.ok(result.calibration)
})

test('adapts calibrated fidelity contract when requested', async () => {
  const { adaptNs3Result } = await import('../../simulation/ns3/adapter/ns3ResultAdapter.js')
  const result = adaptNs3Result({
    scenario: {
      job_id: 'contract-ns3-calibrated',
      fidelity_level: 'operations_v2_calibrated',
      action: { type: 'redistribute' },
      observed_kpis: { prb_load: 92, throughput_mbps: 4, cqi: 9, active_users: 66 },
    },
    metrics: {
      before: { avg_throughput_mbps: 4.1, estimated_prb_load: 92, avg_cqi: 9.1, served_users: 66 },
      after: { avg_throughput_mbps: 6.2, estimated_prb_load: 78, avg_cqi: 10.1, served_users: 80 },
      runtime_seconds: 9.2,
    },
    artifacts: {},
  })
  assert.equal(result.fidelity_level, 'operations_v2_calibrated')
  assert.equal(result.calibration.profile, 'operations_v2_calibrated')
  assert.equal(result.calibration.quality, 'medium')
})

test('marks implausible ns3 outcomes as invalid credibility', async () => {
  const { adaptNs3Result } = await import('../../simulation/ns3/adapter/ns3ResultAdapter.js')
  const result = adaptNs3Result({
    scenario: {
      job_id: 'contract-ns3-implausible',
      action: { type: 'add_carrier' },
      observed_kpis: { prb_load: 95, throughput_mbps: 3, cqi: 9, active_users: 70 },
    },
    metrics: {
      before: { avg_throughput_mbps: 3, estimated_prb_load: 95, avg_cqi: 9, served_users: 70 },
      after: { avg_throughput_mbps: 150, estimated_prb_load: 15, avg_cqi: 25, served_users: 250 },
      runtime_seconds: 8.5,
    },
    artifacts: {},
  })
  assert.equal(result.credibility.valid, false)
  assert.ok(Array.isArray(result.credibility.reasons))
  assert.ok(result.credibility.reasons.length >= 1)
})

test('ns3 job adapter rejects invalid credibility before returning success', async () => {
  const { assertCredibleResult } = await import('../../simulation/ns3/adapter/ns3JobAdapter.js')
  assert.throws(() => assertCredibleResult({
    credibility: {
      valid: false,
      reasons: ['Delta PRB improbable > 70 points.'],
    },
  }), /plausibility validator/i)
})

test('enforces simulator action parameter guardrails at request validation', async () => {
  const invalidTilt = await validateSimulationRequest({
    cell_name: 'TN1158_c01',
    action: 'tilt',
    params: { degrees: 99 },
    time_entry: { filename: '01-12-2025_00-00.json' },
  })
  assert.equal(invalidTilt?.status, 400)
  assert.match(invalidTilt?.error || '', /params\.degrees/i)

  const invalidRedistribute = await validateSimulationRequest({
    cell_name: 'TN1158_c01',
    action: 'redistribute',
    params: { ratio: 0.9 },
    time_entry: { filename: '01-12-2025_00-00.json' },
  })
  assert.equal(invalidRedistribute?.status, 400)
  assert.match(invalidRedistribute?.error || '', /params\.ratio/i)
})

test('rejects unknown time_entry.filename at request validation', async () => {
  const validation = await validateSimulationRequest({
    cell_name: 'TN1158_c01',
    action: 'tilt',
    params: { degrees: 2 },
    time_entry: { filename: 'does-not-exist.json' },
  })
  assert.equal(validation?.status, 400)
  assert.match(validation?.error || '', /time_entry\.filename/i)
})

test('canSimulate blocks missing time slice observation context', async () => {
  const runtimeRoot = path.resolve(process.cwd(), 'runtime_data_mock')
  const feasibility = canSimulate({
    runtimeRoot,
    payload: { cell_name: 'TN1158_c01', action: 'add_carrier', params: {} },
    observation: null,
    hasTimeFile: false,
  })
  assert.equal(feasibility.ok, false)
  assert.ok(feasibility.blocked_reasons.some((v) => /tranche temporelle/i.test(v)))
})

test('keeps ns3 recovery priors aligned with DATASET Radio 2 source truth', async () => {
  const { RECOVERY_RATE_PRIORS } = await import('../../simulation/ns3/adapter/ns3ResultAdapter.js')
  assert.deepEqual(RECOVERY_RATE_PRIORS, {
    tilt: 15,
    redistribute: 40,
    neighbor_optimization: 35,
    add_carrier: 50,
    add_sector: 85,
  })
  assert.equal(Object.hasOwn(RECOVERY_RATE_PRIORS, 'add_site'), false)
  assert.equal(Object.hasOwn(RECOVERY_RATE_PRIORS, 'new_site'), false)

  const sourceTruth = await readFile('docs/source-truth/DATASET-Radio-2-extracted.txt', 'utf8')
  assert.match(sourceTruth, /Tilt \/ Ajustement puissance/i)
  assert.match(sourceTruth, /Ajout secteur/i)
  assert.match(sourceTruth, /Ajout site/i)
  assert.match(sourceTruth, /[EÉ]quilibrage \/ Rebalancing charge/i)
  assert.match(sourceTruth, /Action sur secteurs voisins/i)
  assert.match(sourceTruth, /Ajout de bande \(carrier\)/i)
})

test('runs the WSL ns3 runner with non-zero operational metrics and artifacts when ready', async (t) => {
  const { checkNs3Readiness, runNs3Job } = await import('../../simulation/ns3/adapter/ns3JobAdapter.js')
  const readiness = await checkNs3Readiness(process.cwd())
  if (!readiness.ready) {
    t.skip(`ns3 unavailable: ${readiness.detail || readiness.reason || 'not ready'}`)
    return
  }

  const result = await runNs3Job({
    projectRoot: process.cwd(),
    jobId: 'contract-ns3-live-runner',
    payload: {
      cell_name: 'TN1158_c01',
      action: 'add_carrier',
      params: { band: 3, bandwidth_mhz: 10 },
      time_entry: { timestamp: '01-12-2025 00:00', filename: '01-12-2025_00-00.json' },
      engine: 'ns3',
      data_mode: 'mock',
      fidelity_level: 'operations_v1',
    },
  })

  assert.equal(result.engine, 'ns3')
  assert.equal(result.action, 'add_carrier')
  assert.ok(result.before.throughput_mbps > 0)
  assert.ok(result.before.prb_load > 0)
  assert.ok(result.after.throughput_mbps > result.before.throughput_mbps)
  assert.ok(result.after.prb_load < result.before.prb_load)
  assert.ok(result.calibration.baseline_error.throughput_mape !== null)
  assert.ok(result.calibration.baseline_error.cqi_error !== null)
  assert.ok(result.calibration.baseline_error.load_error !== null)

  for (const artifactPath of Object.values(result.artifacts || {})) {
    await access(artifactPath)
  }
  const metrics = JSON.parse(await readFile(result.artifacts.metrics, 'utf8'))
  assert.ok(Array.isArray(metrics.affected_neighbors))
})
