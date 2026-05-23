const path = require('path')

function getRuntimeDataRoot(projectRoot = process.cwd()) {
  const mode = String(process.env.DATA_MODE || 'real').trim().toLowerCase()
  const normalizedMode = mode === 'mock' ? 'mock' : 'real'
  return {
    mode: normalizedMode,
    root: path.resolve(projectRoot, normalizedMode === 'mock' ? 'runtime_data_mock' : 'runtime_data'),
  }
}

module.exports = { getRuntimeDataRoot }

