import fs from 'fs'
import path from 'path'

const RUNTIME_STATE_DIR = path.resolve(process.cwd(), '.runtime')
const MODE_FILE = path.resolve(RUNTIME_STATE_DIR, 'data_mode.json')

export const DATA_MODES = ['real', 'mock']

export function getDataMode() {
  const envMode = (process.env.DATA_MODE || '').trim().toLowerCase()
  if (DATA_MODES.includes(envMode)) return envMode
  try {
    const raw = JSON.parse(fs.readFileSync(MODE_FILE, 'utf-8'))
    if (DATA_MODES.includes(raw?.mode)) return raw.mode
  } catch {}
  return 'real'
}

export function setDataMode(mode) {
  if (!DATA_MODES.includes(mode)) throw new Error('Unsupported data mode')
  fs.mkdirSync(RUNTIME_STATE_DIR, { recursive: true })
  fs.writeFileSync(MODE_FILE, JSON.stringify({ mode, updated_at: new Date().toISOString() }, null, 2))
  return { mode }
}

export function getRuntimeDataRoot() {
  const mode = getDataMode()
  if (mode === 'mock') {
    return {
      mode,
      root: path.resolve(process.cwd(), 'runtime_data_mock')
    }
  }
  return {
    mode,
    root: path.resolve(process.cwd(), 'runtime_data')
  }
}
