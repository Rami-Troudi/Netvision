import { spawn } from 'child_process'
import crypto from 'crypto'
import path from 'path'
import { createRequire } from 'module'
import { access } from 'fs/promises'
import { enforceRateLimit, requireAuthenticatedRequest } from './_lib/security'
import { getRuntimeDataRoot, validateSimulationRequest, loadAllowedTimeFiles as loadAllowedTimeFilesFromContract } from './_lib/simulationContract'

const require = createRequire(import.meta.url)
const { getPythonBin } = require('../../job-workers/pythonConfig.cjs')

const PYTHON_BIN = getPythonBin()

let allowedTimeFiles = null

function getTimeDataRoot(projectRoot) {
  const { root } = getRuntimeDataRoot()
  return path.resolve(projectRoot, path.relative(projectRoot, path.resolve(root, 'time_data')))
}

function isPathInsideDirectory(targetPath, directoryPath) {
  const relative = path.relative(directoryPath, targetPath)
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

async function loadAllowedTimeFiles() {
  if (allowedTimeFiles) return allowedTimeFiles
  allowedTimeFiles = await loadAllowedTimeFilesFromContract()
  return allowedTimeFiles
}

async function validateRequest(body) {
  const baseError = await validateSimulationRequest(body)
  if (baseError) return baseError
  const { time_entry } = body || {}
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
  const { mode: dataMode } = getRuntimeDataRoot()
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
      const python = spawn(PYTHON_BIN, args, { 
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
            res.status(200).json({ ...payload, data_mode: dataMode })
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
