import path from 'path'
import { readFile } from 'fs/promises'
import { getDataMode } from './dataMode.js'

export const ALLOWED_ACTIONS = Object.freeze([
  'tilt',
  'redistribute',
  'neighbor_optimization',
  'add_carrier',
  'add_sector',
])

export const ALLOWED_ACTIONS_SET = new Set(ALLOWED_ACTIONS)
export const DEFAULT_SIMULATION_ENGINE = 'ns3'
export const DEFAULT_FIDELITY_LEVEL = 'operations_v1'
export const FAST_SIM_FALLBACK_ENABLED = false
export const ALLOWED_ENGINES = Object.freeze(['ns3'])
export const ALLOWED_ENGINES_SET = new Set(ALLOWED_ENGINES)
export const ALLOWED_MODES_SET = new Set([])
export const ALLOWED_FIDELITY_LEVELS = Object.freeze(['operations_v1', 'operations_v2_calibrated'])
export const ALLOWED_FIDELITY_LEVELS_SET = new Set(ALLOWED_FIDELITY_LEVELS)

function isPlainObject(val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val)
}

export function getRuntimeDataRoot() {
  const mode = getDataMode()
  const normalizedMode = mode === 'mock' ? 'mock' : 'real'
  return {
    mode: normalizedMode,
    root: path.resolve(process.cwd(), normalizedMode === 'mock' ? 'runtime_data_mock' : 'runtime_data'),
  }
}

export async function loadAllowedTimeFiles() {
  const { root } = getRuntimeDataRoot()
  const indexPath = path.resolve(root, 'time_index.json')
  const raw = await readFile(indexPath, 'utf8')
  const parsed = JSON.parse(raw)
  const timestamps = parsed?.timestamps
  if (!Array.isArray(timestamps)) {
    throw new Error('time_index.json has invalid schema')
  }
  const filenames = timestamps
    .map((entry) => (entry && typeof entry.filename === 'string' ? entry.filename.trim() : ''))
    .filter(Boolean)
  if (!filenames.length) {
    throw new Error('time_index.json does not include filenames')
  }
  return new Set(filenames)
}

export async function resolveValidatedTimeEntry(timeEntry = {}) {
  if (!timeEntry || typeof timeEntry !== 'object') return { filename: '', timestamp: '' }
  const filename = typeof timeEntry.filename === 'string' ? timeEntry.filename.trim() : ''
  const timestamp = typeof timeEntry.timestamp === 'string' ? timeEntry.timestamp.trim() : ''
  if (!filename) return { filename: '', timestamp }
  const allowList = await loadAllowedTimeFiles()
  if (!allowList.has(filename)) {
    throw new Error('time_entry.filename is not in allowed time_index.json')
  }
  return { filename, timestamp }
}

export async function validateSimulationRequest(body) {
  const { cell_name, action, params, time_entry, mode, fidelity_level } = body || {}
  const engine = String(body?.engine || DEFAULT_SIMULATION_ENGINE).trim().toLowerCase()
  if (typeof cell_name !== 'string' || !cell_name.trim()) {
    return { status: 400, error: 'cell_name must be a non-empty string' }
  }
  if (!ALLOWED_ACTIONS_SET.has(action)) {
    return { status: 400, error: `action must be one of: ${ALLOWED_ACTIONS.join(', ')}` }
  }
  if (!ALLOWED_ENGINES_SET.has(engine)) {
    return { status: 400, error: `engine must be one of: ${ALLOWED_ENGINES.join(', ')}` }
  }
  if (fidelity_level !== undefined) {
    const fidelity = String(fidelity_level || '').trim()
    if (!ALLOWED_FIDELITY_LEVELS_SET.has(fidelity)) {
      return { status: 400, error: `fidelity_level must be one of: ${ALLOWED_FIDELITY_LEVELS.join(', ')}` }
    }
  }
  if (engine !== 'ns3') return { status: 400, error: 'Only engine=ns3 is supported; fallback engines are disabled.' }
  if (mode !== undefined) {
    return { status: 400, error: 'mode is not supported for ns3 jobs' }
  }
  if (params !== undefined && !isPlainObject(params)) {
    return { status: 400, error: 'params must be an object' }
  }
  if (isPlainObject(params)) {
    const validationError = validateActionParams(action, params)
    if (validationError) return validationError
  }
  if (time_entry !== undefined && !isPlainObject(time_entry)) {
    return { status: 400, error: 'time_entry must be an object' }
  }
  if (time_entry && time_entry.filename && typeof time_entry.filename !== 'string') {
    return { status: 400, error: 'time_entry.filename must be a string when provided' }
  }
  if (time_entry?.filename) {
    try {
      await resolveValidatedTimeEntry(time_entry)
    } catch (err) {
      return { status: 400, error: err instanceof Error ? err.message : String(err) }
    }
  }
  return null
}

function validateActionParams(action, params) {
  const guardrails = {
    tilt: [
      ['degrees', -10, 10],
      ['power_delta_db', -3, 3],
    ],
    redistribute: [
      ['ratio', 0.05, 0.5],
    ],
    neighbor_optimization: [
      ['interference_relief', 0.05, 0.3],
    ],
    add_carrier: [
      ['bandwidth_mhz', 5, 20],
      ['band', 1, 99],
    ],
    add_sector: [
      ['target_sectors', 4, 6],
    ],
  }

  const ranges = guardrails[action] || []
  for (const [field, min, max] of ranges) {
    if (params[field] === undefined || params[field] === null || params[field] === '') continue
    const value = Number(params[field])
    if (!Number.isFinite(value)) {
      return { status: 400, error: `params.${field} must be a finite number` }
    }
    if (value < min || value > max) {
      return { status: 400, error: `params.${field} must be between ${min} and ${max}` }
    }
  }
  return null
}
