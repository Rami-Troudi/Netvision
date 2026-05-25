import fs from 'fs/promises'
import path from 'path'

import { buildForecastForRuntime, loadRuntimeForForecast } from '../src/analytics/qosForecast.mjs'

function dataMode() {
  const value = String(process.env.DATA_MODE || '').trim().toLowerCase()
  return value === 'mock' ? 'mock' : 'real'
}

async function main() {
  const mode = dataMode()
  const root = path.resolve(process.cwd(), mode === 'mock' ? 'runtime_data_mock' : 'runtime_data')
  const outDir = path.resolve(process.cwd(), '.runtime', 'forecast')
  await fs.mkdir(outDir, { recursive: true })
  const runtime = await loadRuntimeForForecast(root, mode, 24)
  const requested = process.argv.slice(2).map((arg) => Number.parseInt(arg, 10)).filter((value) => [1, 3].includes(value))
  const horizons = requested.length ? requested : [1, 3]
  const outputs = []
  for (const horizon of horizons) {
    const artifact = buildForecastForRuntime(runtime, { horizon, includeLow: true, limit: 500 })
    artifact.warnings = [...(runtime.warnings || []), ...(artifact.warnings || [])]
    const filePath = path.resolve(outDir, `forecast-h${horizon}.json`)
    await fs.writeFile(filePath, JSON.stringify(artifact, null, 2), 'utf8')
    outputs.push({ horizon, file: filePath, rows: artifact.rows.length })
  }
  console.log(JSON.stringify({ ok: true, model: 'netvision-qos-forecast-rules-v1', outputs }, null, 2))
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
