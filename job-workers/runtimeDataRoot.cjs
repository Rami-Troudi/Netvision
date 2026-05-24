const path = require('path')
const fs = require('fs')

const RUNTIME_STATE_DIR = path.resolve(process.cwd(), '.runtime')
const MODE_FILE = path.resolve(RUNTIME_STATE_DIR, 'data_mode.json')

function readModeFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(MODE_FILE, 'utf8'))
    const mode = String(raw?.mode || '').trim().toLowerCase()
    return mode === 'mock' ? 'mock' : mode === 'real' ? 'real' : null
  } catch {
    return null
  }
}

function getRuntimeDataRoot(projectRoot = process.cwd()) {
  const mode = readModeFile() || String(process.env.DATA_MODE || 'real').trim().toLowerCase()
  const normalizedMode = mode === 'mock' ? 'mock' : 'real'
  return {
    mode: normalizedMode,
    root: path.resolve(projectRoot, normalizedMode === 'mock' ? 'runtime_data_mock' : 'runtime_data'),
  }
}

module.exports = { getRuntimeDataRoot }
