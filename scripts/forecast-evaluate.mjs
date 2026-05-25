import fs from 'fs/promises'
import path from 'path'

import { QOS_THRESHOLDS } from '../src/analytics/qosThresholds.mjs'
import { buildForecastForRuntime, loadRuntimeForForecast } from '../src/analytics/qosForecast.mjs'

function isActualDegraded(obs = {}) {
  const prb = Number(obs.prb_load ?? obs.load ?? 0)
  const cqi = Number(obs.cqi ?? 0)
  const throughput = Number(obs.throughput_mbps ?? (obs.throughput_kbps !== undefined ? Number(obs.throughput_kbps) / 1000 : obs.throughput ?? 0))
  return prb >= QOS_THRESHOLDS.prb_high && (throughput < QOS_THRESHOLDS.throughput_low_mbps || cqi < QOS_THRESHOLDS.cqi_low)
}

async function main() {
  const mode = String(process.env.DATA_MODE || '').trim().toLowerCase() === 'mock' ? 'mock' : 'real'
  const root = path.resolve(process.cwd(), mode === 'mock' ? 'runtime_data_mock' : 'runtime_data')
  const runtime = await loadRuntimeForForecast(root, mode, 72)
  const slices = runtime.timeSlices || []
  const outDir = path.resolve(process.cwd(), '.runtime', 'forecast')
  await fs.mkdir(outDir, { recursive: true })

  let tp = 0
  let fp = 0
  let fn = 0
  let tn = 0
  let sampleCount = 0

  for (let idx = 3; idx < slices.length - 1; idx += 1) {
    const train = slices.slice(0, idx + 1)
    const nextSlice = slices[idx + 1]
    const artifact = buildForecastForRuntime({ ...runtime, timeSlices: train }, { horizon: 1, includeLow: true, limit: 5000 })
    const byCell = new Map(artifact.rows.map((row) => [row.cell_name, row]))
    for (const [cellName, obs] of Object.entries(nextSlice.observations || {})) {
      const predictedHighRisk = (byCell.get(cellName)?.risk_score || 0) >= 60
      const actual = isActualDegraded(obs)
      sampleCount += 1
      if (predictedHighRisk && actual) tp += 1
      else if (predictedHighRisk && !actual) fp += 1
      else if (!predictedHighRisk && actual) fn += 1
      else tn += 1
    }
  }

  const precision = tp + fp ? tp / (tp + fp) : 0
  const recall = tp + fn ? tp / (tp + fn) : 0
  const result = {
    ok: true,
    generated_at: new Date().toISOString(),
    model_version: 'netvision-qos-forecast-rules-v1',
    data_mode: mode,
    sample_count: sampleCount,
    precision: Number(precision.toFixed(4)),
    recall: Number(recall.toFixed(4)),
    false_positives: fp,
    false_negatives: fn,
    true_positives: tp,
    true_negatives: tn,
    limitations: [
      'Evaluation offline basee sur des regles KPI et des tranches historiques.',
      'Cette mesure ne constitue pas une validation terrain des previsions.',
    ],
  }
  const outputPath = path.resolve(outDir, 'forecast-evaluation.json')
  await fs.writeFile(outputPath, JSON.stringify(result, null, 2), 'utf8')
  console.log(JSON.stringify({ ok: true, output: outputPath, metrics: { precision: result.precision, recall: result.recall, sample_count: sampleCount } }, null, 2))
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
