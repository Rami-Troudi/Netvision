const fs = require('fs')

const WINDOWS_PYTHON_CANDIDATES = [
  'C:\\Users\\ramit\\AppData\\Local\\Programs\\Python\\Python312\\python.exe',
  'C:\\Python312\\python.exe',
  'C:\\Program Files\\Python312\\python.exe',
]

function getPythonBin() {
  const explicit = String(process.env.PYTHON_BIN || '').trim()
  if (explicit) return explicit
  if (process.platform === 'win32') {
    const match = WINDOWS_PYTHON_CANDIDATES.find((candidate) => fs.existsSync(candidate))
    if (match) return match
  }
  return 'python3'
}

module.exports = {
  getPythonBin,
}
