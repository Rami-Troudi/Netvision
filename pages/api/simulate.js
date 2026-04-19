import { spawn } from 'child_process'
import crypto from 'crypto'
import path from 'path'
import { access, readFile } from 'fs/promises'
import { enforceRateLimit, requireAuthenticatedRequest } from './_lib/security'

const ALLOWED_ACTIONS = new Set([
  'tilt',
  'add_carrier',
  'redistribute',
  'new_site',
  'add_sector',
  'add_site'
])
const ALLOWED_MODES = new Set(['fast']) // fast is the only supported mode

let allowedTimeFiles = null

function getTimeIndexPath(projectRoot) {
  return path.resolve(projectRoot, 'runtime_data', 'time_index.json')
}

function getTimeDataRoot(projectRoot) {
  return path.resolve(projectRoot, 'runtime_data', 'time_data')
}

function isPathInsideDirectory(targetPath, directoryPath) {
  const relative = path.relative(directoryPath, targetPath)
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

async function loadAllowedTimeFiles() {
  if (allowedTimeFiles) return allowedTimeFiles

  const projectRoot = process.cwd()
  const timeIndexPath = getTimeIndexPath(projectRoot)
  const raw = await readFile(timeIndexPath, 'utf8')
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

  allowedTimeFiles = new Set(filenames)
  return allowedTimeFiles
}

function isPlainObject(val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val)
}

async function validateRequest(body) {
  const { cell_name, action, params, time_entry, mode } = body || {}

  if (typeof cell_name !== 'string' || !cell_name.trim()) {
    return { status: 400, error: 'cell_name must be a non-empty string' }
  }
  if (!ALLOWED_ACTIONS.has(action)) {
    return { status: 400, error: `action must be one of: ${Array.from(ALLOWED_ACTIONS).join(', ')}` }
  }
  if (mode && !ALLOWED_MODES.has(mode)) {
    return { status: 400, error: `mode must be one of: ${Array.from(ALLOWED_MODES).join(', ')}` }
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
  if (time_entry && time_entry.filename) {
    let allowList
    try {
      allowList = await loadAllowedTimeFiles()
    } catch (err) {
      console.error('Failed to load time whitelist:', err)
      return { status: 503, error: 'Simulation whitelist is unavailable' }
    }
    if (!allowList.has(time_entry.filename)) {
      return { status: 400, error: 'time_entry.filename is not in allowed time_index.json' }
    }
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
  if (!requireAuthenticatedRequest(req, res)) return
  if (!enforceRateLimit(req, res, { keyPrefix: 'simulate', maxRequests: 10, windowMs: 60_000 })) return

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const validationError = await validateRequest(req.body)
  if (validationError) {
    return res.status(validationError.status).json({ error: validationError.error })
  }

  const { 
    cell_name: cellName, 
    action, 
    params = {}, 
    time_entry: timeEntry = {},
  } = req.body || {}

  const mode = 'fast'

  if (!cellName || !action) {
    return res.status(400).json({ error: 'Missing cell_name or action' })
  }

  const projectRoot = process.cwd()
  const scriptPath = path.join(projectRoot, 'simulation', 'simulator.py')
  const requestedTimeFile = typeof timeEntry.filename === 'string' ? timeEntry.filename.trim() : ''
  const timeDataRoot = getTimeDataRoot(projectRoot)
  let resolvedTimeFilePath = null

  if (requestedTimeFile) {
    resolvedTimeFilePath = path.resolve(timeDataRoot, requestedTimeFile)
    if (!isPathInsideDirectory(resolvedTimeFilePath, timeDataRoot)) {
      return res.status(400).json({ error: 'Invalid time_entry.filename path' })
    }
    try {
      await access(resolvedTimeFilePath)
    } catch {
      return res.status(400).json({ error: 'time_entry.filename does not exist' })
    }
  }

  const args = [
    scriptPath, 
    '--cell', `${cellName}`.trim(), 
    '--action', action, 
    '--params', JSON.stringify(params),
    '--mode', mode
  ]
  
  if (resolvedTimeFilePath) {
    args.push('--time-file', resolvedTimeFilePath)
  }

  const timeout = 30000

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
            const ref = crypto.randomUUID()
            console.error('JSON Parse Error:', err)
            console.error('Stdout:', stdout)
            console.error('Stderr:', stderr)
            res.status(500).json({ error: 'Simulation failed', ref })
          }
        } else {
          const ref = crypto.randomUUID()
          console.error('Simulation failed with code:', code)
          console.error('Stderr:', stderr)
          console.error('Stdout:', stdout)
          res.status(500).json({ error: 'Simulation failed', ref })
        }
        resolve()
      })

      python.on('error', (err) => {
        const ref = crypto.randomUUID()
        console.error('Spawn Error:', err)
        res.status(500).json({ error: 'Simulation failed', ref })
        resolve()
      })
    })
  } catch (err) {
    if (!res.headersSent) {
      const ref = crypto.randomUUID()
      console.error('Simulation request failed:', err)
      return res.status(500).json({ error: 'Simulation failed', ref })
    }
  }
}
