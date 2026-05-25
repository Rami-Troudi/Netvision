import { spawn } from 'child_process'
import { access, readFile } from 'fs/promises'
import path from 'path'

const projectRoot = process.cwd()
const distro = process.env.NETVISION_NS3_WSL_DISTRO || process.env.NS3_WSL_DISTRO || 'Ubuntu'
const binary = process.env.NETVISION_NS3_BINARY || process.env.NS3_BINARY || '/home/netvision/ns-3-dev/build/scratch/netvision-ran-sim'

const checks = []

await check('wsl.exe available', async () => {
  const result = await run('where.exe', ['wsl.exe'])
  if (!result.ok) throw new Error(result.stderr || result.stdout || 'wsl.exe not found')
  return clean(result.stdout).split(/\s+/)[0]
})

await check('WSL status', async () => {
  const result = await run('wsl.exe', ['--status'])
  if (!result.ok) throw new Error(clean(result.stderr || result.stdout || 'WSL unavailable'))
  return 'available'
})

await check(`WSL distro ${distro}`, async () => {
  const result = await run('wsl.exe', ['-l', '-v'])
  if (!result.ok) throw new Error(clean(result.stderr || result.stdout || 'unable to list distros'))
  const output = clean(result.stdout)
  if (!output.toLowerCase().includes(distro.toLowerCase())) {
    throw new Error(`${distro} is not installed. Output: ${output || '(empty)'}`)
  }
  return output
})

await check('Ubuntu build tools', async () => {
  const result = await run('wsl.exe', ['-d', distro, '--', 'bash', '-lc', 'command -v git g++ cmake python3 >/dev/null && printf ready'])
  if (!result.ok || !result.stdout.includes('ready')) {
    throw new Error(clean(result.stderr || result.stdout || 'git/g++/cmake/python3 missing'))
  }
  return 'git/g++/cmake/python3 ready'
})

await check('ns-3 runner binary', async () => {
  const result = await run('wsl.exe', ['-d', distro, '--', 'bash', '-lc', `test -x ${expandableShellPath(binary)} && printf ready`])
  if (!result.ok || !result.stdout.includes('ready')) {
    throw new Error(`${binary} is not executable inside ${distro}`)
  }
  return binary
})

await check('Queue Redis >= 5', async () => {
  const redisPort = process.env.REDIS_PORT || '6381'
  const result = await run('wsl.exe', ['-d', distro, '-u', 'root', '--', 'bash', '-lc', `redis-cli -p ${redisPort} INFO server | grep ^redis_version`])
  if (!result.ok) throw new Error(clean(result.stderr || result.stdout || `Redis on port ${redisPort} unavailable`))
  const match = clean(result.stdout).match(/redis_version:([0-9]+)\./)
  const major = Number(match?.[1] || 0)
  if (major < 5) throw new Error(`Redis >= 5 required for BullMQ, got ${clean(result.stdout)}`)
  return clean(result.stdout)
})

await check('NetVision scenario builder', async () => {
  await access(path.resolve(projectRoot, 'simulation/ns3/scenario-builder/build_scenario.mjs'))
  await access(path.resolve(projectRoot, 'runtime_data_mock/time_data/01-12-2025_00-00.json'))
  const scenarioModule = await import('../simulation/ns3/scenario-builder/build_scenario.mjs')
  const scenario = await scenarioModule.buildScenario({
    projectRoot,
    jobId: 'prereq-check',
    payload: {
      cell_name: 'TN1158_c01',
      action: 'add_carrier',
      params: { band: 3 },
      data_mode: 'mock',
      time_entry: { filename: '01-12-2025_00-00.json', timestamp: '01-12-2025 00:00' },
    },
  })
  if (scenario.topology.neighbors.length < 1) throw new Error('scenario has no neighbors')
  return `${scenario.topology.neighbors.length} neighbors, ${scenario.traffic_model.ue_count} UEs`
})

const passed = checks.filter((item) => item.ok).length
const failed = checks.length - passed
console.log(`\nns-3 prerequisite result: ${passed}/${checks.length} passed, ${failed} failed`)
if (failed) process.exit(1)

async function check(name, fn) {
  const started = Date.now()
  try {
    const detail = await fn()
    checks.push({ name, ok: true })
    console.log(`PASS ${name} ${Date.now() - started}ms ${detail || ''}`)
  } catch (err) {
    checks.push({ name, ok: false })
    console.error(`FAIL ${name} ${Date.now() - started}ms ${err instanceof Error ? err.message : String(err)}`)
  }
}

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: projectRoot, shell: false, timeout: 30_000 })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (err) => resolve({ ok: false, stdout, stderr: stderr || err.message }))
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout, stderr }))
  })
}

function clean(value) {
  const cleaned = String(value || '')
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.includes('�')) return 'WSL Ubuntu is unavailable or not installed.'
  return cleaned
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function expandableShellPath(value) {
  const raw = String(value || '')
  if (raw.startsWith('$HOME/')) return `$HOME/${shellQuote(raw.slice('$HOME/'.length)).slice(1, -1)}`
  if (raw.startsWith('~/')) return `$HOME/${shellQuote(raw.slice(2)).slice(1, -1)}`
  return shellQuote(raw)
}
