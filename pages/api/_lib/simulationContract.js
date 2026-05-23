import path from 'path'
import { readFile } from 'fs/promises'

export const ALLOWED_ACTIONS = Object.freeze([
  'tilt',
  'add_carrier',
  'redistribute',
  'new_site',
  'add_sector',
  'add_site',
])

export const ALLOWED_ACTIONS_SET = new Set(ALLOWED_ACTIONS)
export const ALLOWED_MODES_SET = new Set(['fast'])

function isPlainObject(val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val)
}

export function getRuntimeDataRoot() {
  const mode = String(process.env.DATA_MODE || 'real').trim().toLowerCase()
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

export async function validateSimulationRequest(body) {
  const { cell_name, action, params, time_entry, mode } = body || {}
  if (typeof cell_name !== 'string' || !cell_name.trim()) {
    return { status: 400, error: 'cell_name must be a non-empty string' }
  }
  if (!ALLOWED_ACTIONS_SET.has(action)) {
    return { status: 400, error: `action must be one of: ${ALLOWED_ACTIONS.join(', ')}` }
  }
  if (mode && !ALLOWED_MODES_SET.has(mode)) {
    return { status: 400, error: 'mode must be one of: fast' }
  }
  if (params !== undefined && !isPlainObject(params)) {
    return { status: 400, error: 'params must be an object' }
  }
  if (time_entry !== undefined && !isPlainObject(time_entry)) {
    return { status: 400, error: 'time_entry must be an object' }
  }
  if (time_entry && time_entry.filename && typeof time_entry.filename !== 'string') {
    return { status: 400, error: 'time_entry.filename must be a string when provided' }
  }
  return null
}

