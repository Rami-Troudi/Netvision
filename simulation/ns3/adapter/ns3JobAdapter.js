const fs = require('fs/promises')
const path = require('path')
const { spawn } = require('child_process')
const { adaptNs3Result } = require('./ns3ResultAdapter.js')
const {
  checkNs3Readiness,
  ensureNs3JobDir,
  expandableShellPath,
  getNs3Config,
  shellQuote,
  wslPath,
} = require('./ns3Config.js')

async function runNs3Job({ projectRoot = process.cwd(), jobId, payload = {} }) {
  if (!jobId) throw new Error('ns-3 job requires jobId')
  const config = getNs3Config(projectRoot)
  const jobDir = await ensureNs3JobDir(projectRoot, jobId)
  const { buildScenario } = await import('../scenario-builder/build_scenario.mjs')
  const scenario = await buildScenario({ projectRoot, payload: { ...payload, engine: 'ns3' }, jobId })

  const scenarioPath = path.resolve(jobDir, 'scenario.json')
  const stdoutPath = path.resolve(jobDir, 'stdout.log')
  const stderrPath = path.resolve(jobDir, 'stderr.log')
  const metricsPath = path.resolve(jobDir, 'metrics.json')
  const resultPath = path.resolve(jobDir, 'result.json')

  await fs.writeFile(scenarioPath, JSON.stringify(scenario, null, 2), 'utf8')
  await fs.writeFile(stdoutPath, '', 'utf8')
  await fs.writeFile(stderrPath, '', 'utf8')

  const readiness = await checkNs3Readiness(projectRoot)
  if (!readiness.ready) {
    const message = `ns-3 runner unavailable: ${readiness.detail} ${readiness.reason || ''}`.trim()
    await fs.writeFile(stderrPath, `${message}\n`, 'utf8')
    throw new Error(message)
  }

  const scenarioWslPath = await wslPath(scenarioPath, config)
  const outputWslPath = await wslPath(jobDir, config)
  const seed = String(scenario.scenario.random_seed || 42)
  const command = [
    expandableShellPath(config.ns3Binary),
    `--scenario=${shellQuote(scenarioWslPath)}`,
    `--output=${shellQuote(outputWslPath)}`,
    `--seed=${shellQuote(seed)}`,
  ].join(' ')

  const execution = await runWslCommand(command, { projectRoot, config })
  await fs.writeFile(stdoutPath, execution.stdout || '', 'utf8')
  await fs.writeFile(stderrPath, execution.stderr || '', 'utf8')
  if (!execution.ok) {
    throw new Error(`ns-3 simulation failed (code=${execution.code}, signal=${execution.signal || 'none'}): ${execution.stderr || execution.stdout}`)
  }

  const metrics = await readMetrics(metricsPath, scenario)
  validateMetricsGuardrails(metrics)
  const result = adaptNs3Result({
    scenario,
    metrics,
    artifacts: {
      scenario: scenarioPath,
      stdout: stdoutPath,
      stderr: stderrPath,
      metrics: metricsPath,
      result: resultPath,
    },
  })
  assertCredibleResult(result)
  await fs.writeFile(resultPath, JSON.stringify(result, null, 2), 'utf8')
  return result
}

function assertCredibleResult(result = {}) {
  if (result?.credibility?.valid !== false) return
  const reason = Array.isArray(result.credibility.reasons) && result.credibility.reasons.length
    ? result.credibility.reasons.join('; ')
    : 'resultat non plausible'
  throw new Error(`ns-3 result rejected by plausibility validator: ${reason}`)
}

function validateMetricsGuardrails(metrics = {}) {
  const before = metrics?.before || {}
  const after = metrics?.after || {}
  const checks = [
    ['before.avg_throughput_mbps', before.avg_throughput_mbps, 0, 5000],
    ['before.estimated_prb_load', before.estimated_prb_load, 0, 100],
    ['before.avg_cqi', before.avg_cqi, 0, 30],
    ['before.served_users', before.served_users, 0, 5000],
    ['after.avg_throughput_mbps', after.avg_throughput_mbps, 0, 5000],
    ['after.estimated_prb_load', after.estimated_prb_load, 0, 100],
    ['after.avg_cqi', after.avg_cqi, 0, 30],
    ['after.served_users', after.served_users, 0, 5000],
  ]

  for (const [name, rawValue, min, max] of checks) {
    const value = Number(rawValue)
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(`ns-3 metrics guardrail violation: ${name}=${rawValue} outside [${min}, ${max}]`)
    }
  }

  if (!Array.isArray(metrics?.affected_neighbors)) {
    throw new Error('ns-3 metrics guardrail violation: affected_neighbors must be an array')
  }
}

function runWslCommand(command, { projectRoot, config }) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn('wsl.exe', ['-d', config.wslDistro, '--', 'bash', '-lc', command], {
      cwd: projectRoot,
      timeout: config.timeoutMs,
      shell: false,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (err) => {
      resolve({ ok: false, code: null, signal: null, stdout, stderr: stderr || err.message, runtime_seconds: (Date.now() - started) / 1000 })
    })
    child.on('close', (code, signal) => {
      resolve({ ok: code === 0, code, signal, stdout, stderr, runtime_seconds: (Date.now() - started) / 1000 })
    })
  })
}

async function readMetrics(metricsPath, scenario) {
  try {
    const raw = await fs.readFile(metricsPath, 'utf8')
    return JSON.parse(raw)
  } catch (err) {
    throw new Error(`ns-3 metrics missing or invalid at ${metricsPath}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

module.exports = {
  assertCredibleResult,
  checkNs3Readiness,
  runNs3Job,
}
