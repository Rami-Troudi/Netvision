import fs from 'fs/promises'
import path from 'path'

import { validateForecastArtifact } from '../src/analytics/qosForecast.mjs'

async function main() {
  const outDir = path.resolve(process.cwd(), '.runtime', 'forecast')
  const files = ['forecast-h1.json', 'forecast-h3.json']
  const results = []
  let failed = false
  for (const file of files) {
    const filePath = path.resolve(outDir, file)
    try {
      const artifact = JSON.parse(await fs.readFile(filePath, 'utf8'))
      const validation = validateForecastArtifact(artifact)
      results.push({ file: filePath, ok: validation.ok, errors: validation.errors, rows: artifact.rows?.length || 0 })
      if (!validation.ok) failed = true
    } catch (err) {
      failed = true
      results.push({ file: filePath, ok: false, errors: [err instanceof Error ? err.message : String(err)], rows: 0 })
    }
  }
  console.log(JSON.stringify({ ok: !failed, results }, null, 2))
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
