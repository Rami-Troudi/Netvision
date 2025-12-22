import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'

export const config = {
  api: {
    bodyParser: true,
    responseLimit: false,
  },
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
    const { days = 6, start_date = null } = req.body || {}
    
    // Validate days
    if (days < 1 || days > 14) {
      return res.status(400).json({ error: 'Days must be between 1 and 14' })
    }
    
    const projectRoot = process.cwd()
    const scriptPath = path.join(projectRoot, 'scripts', 'forecast.py')
    
    if (!fs.existsSync(scriptPath)) {
      return res.status(500).json({ error: 'Forecast script not found' })
    }
    
    const args = ['python', scriptPath, '--days', String(days)]
    
    if (start_date) {
      args.push('--start-date', start_date)
    }
    
    try {
      const result = await new Promise((resolve, reject) => {
        const python = spawn('python', [scriptPath, '--days', String(days)], {
          cwd: projectRoot,
          timeout: 120000,  // 2 minute timeout for forecast generation
          shell: false
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
  
  return res.status(405).json({ error: 'Method not allowed' })
}
