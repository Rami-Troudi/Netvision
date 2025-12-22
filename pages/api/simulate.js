import { spawn } from 'child_process'
import path from 'path'

const ALLOWED_ACTIONS = new Set(['tilt', 'power', 'add_carrier', 'redistribute'])
const ALLOWED_MODES = new Set(['fast', 'precise'])

function isPlainObject(val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val)
}

function validateRequest(body) {
  const { cell_name, action, params, time_entry, mode } = body || {}

  if (typeof cell_name !== 'string' || !cell_name.trim()) {
    return 'cell_name must be a non-empty string'
  }
  if (!ALLOWED_ACTIONS.has(action)) {
    return `action must be one of: ${Array.from(ALLOWED_ACTIONS).join(', ')}`
  }
  if (mode && !ALLOWED_MODES.has(mode)) {
    return `mode must be one of: ${Array.from(ALLOWED_MODES).join(', ')}`
  }
  if (params !== undefined && !isPlainObject(params)) {
    return 'params must be an object'
  }
  if (time_entry !== undefined && !isPlainObject(time_entry)) {
    return 'time_entry must be an object'
  }
  if (time_entry && time_entry.filename && typeof time_entry.filename !== 'string') {
    return 'time_entry.filename must be a string when provided'
  }
  return null
}

export const config = {
  api: {
    bodyParser: true,
    responseLimit: false,
  },
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST'])
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const validationError = validateRequest(req.body)
  if (validationError) {
    return res.status(400).json({ error: validationError })
  }

  const { 
    cell_name: cellName, 
    action, 
    params = {}, 
    time_entry: timeEntry = {},
    mode = 'fast'  // 'fast' or 'precise' (ns-3)
  } = req.body || {}

  if (!cellName || !action) {
    return res.status(400).json({ error: 'Missing cell_name or action' })
  }

  // Keep site deployment separate from per-cell remediation actions
  if (action === 'new_site') {
    return res.status(400).json({ error: 'Deploy new site is handled in the site planning tool, not inline actions' })
  }

  // Redistribute not yet modeled in ns-3 precise mode
  if (action === 'redistribute' && mode === 'precise') {
    return res.status(400).json({ error: 'Precise mode is not available for redistribute. Use fast mode.' })
  }

  const projectRoot = process.cwd()
  const scriptPath = path.join(projectRoot, 'simulation', 'simulator.py')
  const timeFile = timeEntry.filename || null

  const args = [
    scriptPath, 
    '--cell', `${cellName}`.trim(), 
    '--action', action, 
    '--params', JSON.stringify(params),
    '--mode', mode
  ]
  
  if (timeFile) {
    args.push('--time-file', timeFile)
  }

  // Longer timeout for precise mode (ns-3)
  const timeout = mode === 'precise' ? 120000 : 30000

  try {
    await new Promise((resolve, reject) => {
      const python = spawn('python', args, { 
        cwd: projectRoot,
        timeout: timeout,
        shell: false  // let spawn handle quoting; avoids PowerShell eating JSON braces
      })
      let stdout = ''
      let stderr = ''

      python.stdout.on('data', (data) => {
        stdout += data.toString()
      })

      python.stderr.on('data', (data) => {
        stderr += data.toString()
      })

      python.on('close', (code) => {
        if (code === 0) {
          try {
            const payload = JSON.parse(stdout.trim())
            res.status(200).json(payload)
          } catch (err) {
            console.error('JSON Parse Error:', err)
            console.error('Stdout:', stdout)
            console.error('Stderr:', stderr)
            res.status(500).json({ error: 'Failed to parse simulator output', detail: err.message, stderr, stdout })
          }
        } else {
          console.error('Simulation failed with code:', code)
          console.error('Stderr:', stderr)
          console.error('Stdout:', stdout)
          res.status(500).json({ error: 'Simulation failed', code, stderr, stdout })
        }
        resolve()
      })

      python.on('error', (err) => {
        console.error('Spawn Error:', err)
        res.status(500).json({ error: 'Failed to spawn simulator', detail: err.message })
        resolve()
      })
    })
  } catch (err) {
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Failed to spawn simulator', detail: err.message })
    }
  }
}
