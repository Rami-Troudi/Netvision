import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'

export const config = {
  api: {
    bodyParser: true,
    responseLimit: false,
  },
}

function clearForecastData(projectRoot) {
  // Clear old forecast data on each generate
  const forecastDir = path.join(projectRoot, 'public', 'forecast_data')
  const forecastIndex = path.join(projectRoot, 'public', 'forecast_index.json')
  
  // Remove forecast_index.json
  if (fs.existsSync(forecastIndex)) {
    fs.unlinkSync(forecastIndex)
  }
  
  // Remove forecast_data directory contents
  if (fs.existsSync(forecastDir)) {
    const files = fs.readdirSync(forecastDir)
    for (const file of files) {
      fs.unlinkSync(path.join(forecastDir, file))
    }
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    // Return existing forecast data
    const projectRoot = process.cwd()
    const forecastIndexPath = path.join(projectRoot, 'public', 'forecast_index.json')
    
    if (fs.existsSync(forecastIndexPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(forecastIndexPath, 'utf8'))
        return res.status(200).json({
          success: true,
          available: true,
          forecasts: data,
          generated_at: fs.statSync(forecastIndexPath).mtime
        })
      } catch (err) {
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to read forecast index',
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
    // Generate new forecast
    const { days = 7, start_date = null } = req.body || {}
    
    // Validate days (1-30) while preserving explicit values
    const parsedDays = Number.parseInt(days, 10)
    const validDays = Number.isFinite(parsedDays)
      ? Math.min(30, Math.max(1, parsedDays))
      : 7
    
    const projectRoot = process.cwd()
    
    // Clear old forecast data first
    clearForecastData(projectRoot)
    
    // Use the new HuggingFace-based forecast script (fixes Windows encoding issues)
    let scriptPath = path.join(projectRoot, 'scripts', 'forecast_hf.py')
    
    // Fallback to original if new script doesn't exist
    if (!fs.existsSync(scriptPath)) {
      scriptPath = path.join(projectRoot, 'scripts', 'forecast.py')
    }
    
    if (!fs.existsSync(scriptPath)) {
      return res.status(500).json({ error: 'Forecast script not found' })
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
            reject(new Error(`Forecast generation failed: ${stderr || stdout}`))
          }
        })
        
        python.on('error', (err) => {
          reject(err)
        })
      })
      
      // Load the generated forecast index
      const forecastIndexPath = path.join(projectRoot, 'public', 'forecast_index.json')
      let forecasts = []
      
      if (fs.existsSync(forecastIndexPath)) {
        forecasts = JSON.parse(fs.readFileSync(forecastIndexPath, 'utf8'))
      }
      
      return res.status(200).json({
        success: true,
        ...result,
        forecasts_count: forecasts.length,
        forecasts: forecasts.slice(0, 10)  // Return first 10 as preview
      })
      
    } catch (err) {
      console.error('Forecast generation error:', err)
      return res.status(500).json({
        success: false,
        error: 'Forecast generation failed',
        detail: err.message
      })
    }
  }
  
  // DELETE method - clear forecast data
  if (req.method === 'DELETE') {
    const projectRoot = process.cwd()
    clearForecastData(projectRoot)
    return res.status(200).json({ success: true, message: 'Forecast data cleared' })
  }
  
  return res.status(405).json({ error: 'Method not allowed' })
}
