import { spawn } from 'child_process'
import crypto from 'crypto'
import path from 'path'
import { access, readdir, readFile, stat, unlink } from 'fs/promises'
import { enforceRateLimit, requireAuthenticatedRequest } from './_lib/security'

export const config = {
  api: {
    bodyParser: true,
    responseLimit: false,
  },
}

function getForecastDir(projectRoot) {
  return path.resolve(projectRoot, 'forecast_data')
}

function getForecastIndexPath(projectRoot) {
  return path.resolve(projectRoot, 'forecast_index.json')
}

async function fileExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function clearForecastData(projectRoot) {
  const forecastDir = getForecastDir(projectRoot)
  const forecastIndex = getForecastIndexPath(projectRoot)

  if (await fileExists(forecastIndex)) {
    await unlink(forecastIndex)
  }

  if (await fileExists(forecastDir)) {
    const files = await readdir(forecastDir)
    await Promise.all(files.map((file) => unlink(path.join(forecastDir, file))))
  }
}

export default async function handler(req, res) {
  if (!requireAuthenticatedRequest(req, res)) return
  if (!enforceRateLimit(req, res, { keyPrefix: 'forecast', maxRequests: 10, windowMs: 60_000 })) return

  if (req.method === 'GET') {
    const projectRoot = process.cwd()
    const forecastIndexPath = getForecastIndexPath(projectRoot)
    
    if (await fileExists(forecastIndexPath)) {
      try {
        const [raw, info] = await Promise.all([
          readFile(forecastIndexPath, 'utf8'),
          stat(forecastIndexPath),
        ])
        const data = JSON.parse(raw)
        return res.status(200).json({
          success: true,
          available: true,
          forecasts: data,
          generated_at: info.mtime
        })
      } catch (err) {
        const ref = crypto.randomUUID()
        console.error('Failed to read forecast index:', ref, err)
        return res.status(500).json({ 
          success: false, 
          error: 'Forecast data unavailable',
          ref,
          available: false
        })
      }
    } else {
      return res.status(200).json({
        success: true,
        available: false,
        forecasts: [],
        message: 'No forecast data available. Generate forecast first.'
      })
    }
  }
  
  if (req.method === 'POST') {
    const { days = 7, start_date = null } = req.body || {}
    
    // Validate days (1-30) while preserving explicit values
    const parsedDays = Number.parseInt(days, 10)
    const validDays = Number.isFinite(parsedDays)
      ? Math.min(30, Math.max(1, parsedDays))
      : 7
    
    const projectRoot = process.cwd()
    
    await clearForecastData(projectRoot)
    
    const scriptPath = path.join(projectRoot, 'scripts', 'forecast_hf.py')
    if (!(await fileExists(scriptPath))) {
      const ref = crypto.randomUUID()
      console.error('Forecast script missing:', ref, scriptPath)
      return res.status(500).json({ success: false, error: 'Forecast generation failed', ref })
    }
    
    const args = [scriptPath, '--days', String(validDays)]
    
    if (start_date) {
      args.push('--start-date', start_date)
    }
    
    try {
      const result = await new Promise((resolve, reject) => {
        const python = spawn('python', args, {
          cwd: projectRoot,
          timeout: 120000,  // 2 minute timeout for forecast generation
          shell: false,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' }  // Fix Windows encoding
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
            // Try to parse the last JSON line from stdout
            const lines = stdout.trim().split('\n')
            const lastLine = lines[lines.length - 1]
            
            try {
              const summary = JSON.parse(lastLine)
              resolve(summary)
            } catch {
              resolve({ success: true, output: stdout })
            }
          } else {
            reject(new Error(`Forecast generation failed with code ${code}: ${stderr || stdout}`))
          }
        })
        
        python.on('error', (err) => {
          reject(err)
        })
      })
      
      // Load the generated forecast index
      const forecastIndexPath = getForecastIndexPath(projectRoot)
      let forecasts = []
      
      if (await fileExists(forecastIndexPath)) {
        const raw = await readFile(forecastIndexPath, 'utf8')
        forecasts = JSON.parse(raw)
      }
      
      return res.status(200).json({
        success: true,
        ...result,
        forecasts_count: forecasts.length,
        forecasts: forecasts.slice(0, 10)  // Return first 10 as preview
      })
      
    } catch (err) {
      const ref = crypto.randomUUID()
      console.error('Forecast generation error:', ref, err)
      return res.status(500).json({
        success: false,
        error: 'Forecast generation failed',
        ref
      })
    }
  }
  
  // DELETE method - clear forecast data
  if (req.method === 'DELETE') {
    const projectRoot = process.cwd()
    await clearForecastData(projectRoot)
    return res.status(200).json({ success: true, message: 'Forecast data cleared' })
  }
  
  return res.status(405).json({ error: 'Method not allowed' })
}
