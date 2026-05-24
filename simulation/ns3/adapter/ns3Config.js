const fs = require('fs/promises')
const path = require('path')
const { spawn } = require('child_process')

const DEFAULT_WSL_DISTRO = 'Ubuntu'
const DEFAULT_NS3_BINARY = '/home/netvision/ns-3-dev/build/scratch/netvision-ran-sim'

function getNs3Config(projectRoot = process.cwd()) {
  return {
    projectRoot,
    wslDistro: process.env.NETVISION_NS3_WSL_DISTRO || process.env.NS3_WSL_DISTRO || DEFAULT_WSL_DISTRO,
    ns3Binary: process.env.NETVISION_NS3_BINARY || process.env.NS3_BINARY || DEFAULT_NS3_BINARY,
    timeoutMs: Math.max(5_000, Number.parseInt(process.env.NETVISION_NS3_TIMEOUT_MS || '180000', 10) || 180_000),
    runtimeRoot: path.resolve(projectRoot, '.runtime', 'ns3-jobs'),
  }
}

function getNs3JobDir(projectRoot, jobId) {
  return path.resolve(projectRoot, '.runtime', 'ns3-jobs', String(jobId))
}

async function ensureNs3JobDir(projectRoot, jobId) {
  const jobDir = getNs3JobDir(projectRoot, jobId)
  await fs.mkdir(jobDir, { recursive: true })
  return jobDir
}

function runCommand(command, args, { cwd, timeout = 10_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: false, timeout })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (err) => {
      resolve({ ok: false, code: null, stdout, stderr: stderr || err.message, error: err })
    })
    child.on('close', (code, signal) => {
      resolve({ ok: code === 0, code, signal, stdout, stderr })
    })
  })
}

async function wslPath(windowsPath, config = getNs3Config()) {
  const direct = windowsDrivePathToWsl(windowsPath)
  if (direct) return direct
  const converted = await runCommand('wsl.exe', ['-d', config.wslDistro, '--', 'wslpath', '-a', windowsPath], {
    cwd: config.projectRoot,
    timeout: 10_000,
  })
  if (!converted.ok) {
    throw new Error(converted.stderr || 'wslpath failed')
  }
  return converted.stdout.trim()
}

function windowsDrivePathToWsl(value) {
  const raw = String(value || '')
  const match = raw.match(/^([A-Za-z]):[\\/](.*)$/)
  if (!match) return null
  const drive = match[1].toLowerCase()
  const rest = match[2].replace(/\\/g, '/').split('/').map(encodeWslSegment).join('/')
  return `/mnt/${drive}/${rest}`
}

function encodeWslSegment(segment) {
  return segment
}

async function checkNs3Readiness(projectRoot = process.cwd()) {
  const config = getNs3Config(projectRoot)
  const wsl = await runCommand('wsl.exe', ['-d', config.wslDistro, '--', 'bash', '-lc', 'printf ready'], {
    cwd: projectRoot,
    timeout: 10_000,
  })
  if (!wsl.ok || !wsl.stdout.includes('ready')) {
    return {
      ready: false,
      service: 'ns3',
      engine: 'ns3',
      wsl_distro: config.wslDistro,
      binary: config.ns3Binary,
      reason: cleanProcessText(wsl.stderr || 'WSL Ubuntu is unavailable'),
      detail: `WSL ${config.wslDistro} ou le lanceur ns-3 est indisponible.`,
    }
  }

  const binary = await runCommand('wsl.exe', ['-d', config.wslDistro, '--', 'bash', '-lc', `test -x ${expandableShellPath(config.ns3Binary)}`], {
    cwd: projectRoot,
    timeout: 10_000,
  })
  if (!binary.ok) {
    return {
      ready: false,
      service: 'ns3',
      engine: 'ns3',
      wsl_distro: config.wslDistro,
      binary: config.ns3Binary,
      reason: cleanProcessText(binary.stderr || `ns-3 runner not executable at ${config.ns3Binary}`),
      detail: 'Le binaire ns-3 NetVision n est pas compile ou pas executable dans WSL.',
    }
  }

  return {
    ready: true,
    service: 'ns3',
    engine: 'ns3',
    wsl_distro: config.wslDistro,
    binary: config.ns3Binary,
    detail: 'ns-3 est pret pour les simulations asynchrones.',
  }
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

function cleanProcessText(value) {
  const cleaned = String(value || '')
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned || cleaned.includes('�')) {
    return 'WSL Ubuntu est indisponible ou ns-3 n est pas encore installe.'
  }
  return cleaned
}

module.exports = {
  DEFAULT_NS3_BINARY,
  DEFAULT_WSL_DISTRO,
  checkNs3Readiness,
  ensureNs3JobDir,
  expandableShellPath,
  getNs3Config,
  getNs3JobDir,
  runCommand,
  shellQuote,
  wslPath,
  windowsDrivePathToWsl,
}
