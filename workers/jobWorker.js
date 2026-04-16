const { spawn } = require('child_process')
const fs = require('fs')
const fsPromises = require('fs/promises')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')
const IORedis = require('ioredis')
const { Queue, Worker } = require('bullmq')

const JOB_QUEUE_NAME = (process.env.JOB_QUEUE_NAME || 'netvision-jobs').trim()
const MAINTENANCE_QUEUE_NAME = (process.env.MAINTENANCE_QUEUE_NAME || 'netvision-maintenance').trim()
const REDIS_URL = (process.env.REDIS_URL || 'redis://127.0.0.1:6379').trim()
const ENABLE_WEEKLY_RETRAIN = String(process.env.ENABLE_WEEKLY_RETRAIN || 'true').trim().toLowerCase() !== 'false'
const WEEKLY_RETRAIN_CRON = (process.env.WEEKLY_RETRAIN_CRON || '0 3 * * 1').trim()
const WEEKLY_RETRAIN_TZ = (process.env.WEEKLY_RETRAIN_TZ || 'UTC').trim()
const JOB_STATUSES = {
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
}

const PROJECT_ROOT = process.cwd()
const RUNTIME_DIR = path.resolve(PROJECT_ROOT, '.runtime')
const DB_PATH = path.resolve(RUNTIME_DIR, 'jobs.sqlite')
const JOB_RESULTS_DIR = path.resolve(RUNTIME_DIR, 'job-results')
const FORECAST_DIR = path.resolve(PROJECT_ROOT, 'runtime_data', 'forecast_data')
const FORECAST_INDEX_PATH = path.resolve(PROJECT_ROOT, 'runtime_data', 'forecast_index.json')
const RETRAIN_RESULTS_DIR = path.resolve(PROJECT_ROOT, 'runtime_data', 'retraining')
const RETRAIN_SUMMARY_PATH = path.resolve(RETRAIN_RESULTS_DIR, 'last_retrain_summary.json')

let db = null
let allowTimeFileSet = null
let maintenanceQueue = null

function ensureRuntimeDirectories() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true })
  fs.mkdirSync(JOB_RESULTS_DIR, { recursive: true })
}

function ensureRetrainDirectories() {
  fs.mkdirSync(RETRAIN_RESULTS_DIR, { recursive: true })
}

function getNowIso() {
  return new Date().toISOString()
}

function getDb() {
  if (db) return db
  ensureRuntimeDirectories()
  db = new DatabaseSync(DB_PATH)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      request_json TEXT NOT NULL,
      result_json TEXT,
      result_path TEXT,
      error_text TEXT,
      queue_job_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );
  `)
  return db
}

function getJobRow(id) {
  return getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id)
}

function updateJobRow({
  id,
  status,
  resultJson,
  resultPath,
  errorText,
  queueJobId,
  startedAt,
  completedAt,
}) {
  const database = getDb()
  const current = database.prepare('SELECT * FROM jobs WHERE id = ?').get(id)
  if (!current) return false

  const stmt = database.prepare(`
    UPDATE jobs
    SET status = ?,
        result_json = ?,
        result_path = ?,
        error_text = ?,
        queue_job_id = ?,
        started_at = ?,
        completed_at = ?,
        updated_at = ?
    WHERE id = ?
  `)

  stmt.run(
    status ?? current.status,
    resultJson === undefined ? current.result_json : resultJson,
    resultPath === undefined ? current.result_path : resultPath,
    errorText === undefined ? current.error_text : errorText,
    queueJobId === undefined ? current.queue_job_id : queueJobId,
    startedAt === undefined ? current.started_at : startedAt,
    completedAt === undefined ? current.completed_at : completedAt,
    getNowIso(),
    id
  )
  return true
}

function parseJsonString(raw, fallbackValue = null) {
  if (typeof raw !== 'string' || !raw.trim()) return fallbackValue
  try {
    return JSON.parse(raw)
  } catch {
    return fallbackValue
  }
}

function parseLastJsonLine(raw) {
  const lines = String(raw || '').split('\n').map((line) => line.trim()).filter(Boolean)
  if (!lines.length) return null
  return parseJsonString(lines[lines.length - 1], null)
}

async function fileExists(filePath) {
  try {
    await fsPromises.access(filePath)
    return true
  } catch {
    return false
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPathInsideDirectory(targetPath, directoryPath) {
  const relative = path.relative(directoryPath, targetPath)
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

async function loadAllowedTimeFiles() {
  if (allowTimeFileSet) return allowTimeFileSet

  const indexPath = path.resolve(PROJECT_ROOT, 'runtime_data', 'time_index.json')
  const raw = await fsPromises.readFile(indexPath, 'utf8')
  const parsed = parseJsonString(raw, {})
  const timestamps = Array.isArray(parsed?.timestamps) ? parsed.timestamps : []
  const filenames = timestamps
    .map((entry) => (entry && typeof entry.filename === 'string' ? entry.filename.trim() : ''))
    .filter(Boolean)

  allowTimeFileSet = new Set(filenames)
  return allowTimeFileSet
}

function runPython({ args, timeout, env = null }) {
  return new Promise((resolve, reject) => {
    const child = spawn('python', args, {
      cwd: PROJECT_ROOT,
      timeout,
      shell: false,
      env: env ? { ...process.env, ...env } : process.env,
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.on('error', (err) => {
      reject(err)
    })

    child.on('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr })
    })
  })
}

async function resolveSimulationTimeFile(timeEntry) {
  const requestedTimeFile = typeof timeEntry?.filename === 'string' ? timeEntry.filename.trim() : ''
  if (!requestedTimeFile) return null

  const allowList = await loadAllowedTimeFiles()
  if (!allowList.has(requestedTimeFile)) {
    throw new Error('time_entry.filename is not in allowed time_index.json')
  }

  const timeDataRoot = path.resolve(PROJECT_ROOT, 'runtime_data', 'time_data')
  const resolved = path.resolve(timeDataRoot, requestedTimeFile)
  if (!isPathInsideDirectory(resolved, timeDataRoot)) {
    throw new Error('Invalid time_entry.filename path')
  }
  if (!(await fileExists(resolved))) {
    throw new Error('time_entry.filename does not exist')
  }

  return resolved
}

async function runSimulationJob(payload) {
  const cellName = typeof payload?.cell_name === 'string' ? payload.cell_name.trim() : ''
  const action = typeof payload?.action === 'string' ? payload.action.trim() : ''
  const params = isPlainObject(payload?.params) ? payload.params : {}
  const timeEntry = isPlainObject(payload?.time_entry) ? payload.time_entry : {}

  if (!cellName || !action) {
    throw new Error('Missing cell_name or action')
  }

  const scriptPath = path.resolve(PROJECT_ROOT, 'simulation', 'simulator.py')
  if (!(await fileExists(scriptPath))) {
    throw new Error('Simulation script missing')
  }

  const args = [
    scriptPath,
    '--cell', cellName,
    '--action', action,
    '--params', JSON.stringify(params),
    '--mode', 'fast',
  ]

  const resolvedTimeFile = await resolveSimulationTimeFile(timeEntry)
  if (resolvedTimeFile) {
    args.push('--time-file', resolvedTimeFile)
  }

  const { code, signal, stdout, stderr } = await runPython({ args, timeout: 30_000 })
  if (code !== 0) {
    throw new Error(`Simulation failed (code=${code}, signal=${signal || 'none'}): ${stderr || stdout}`)
  }

  const parsed = parseJsonString(stdout.trim(), null)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Simulation output is not valid JSON')
  }

  return parsed
}

async function clearForecastData() {
  if (await fileExists(FORECAST_INDEX_PATH)) {
    await fsPromises.unlink(FORECAST_INDEX_PATH)
  }

  if (await fileExists(FORECAST_DIR)) {
    await fsPromises.rm(FORECAST_DIR, { recursive: true, force: true })
  }
}

async function runForecastJob(payload) {
  const scriptPath = path.resolve(PROJECT_ROOT, 'scripts', 'forecast_hf.py')
  if (!(await fileExists(scriptPath))) {
    throw new Error('Forecast script missing')
  }

  const parsedDays = Number.parseInt(payload?.days, 10)
  const validDays = Number.isFinite(parsedDays) ? Math.min(30, Math.max(1, parsedDays)) : 7
  const startDate = typeof payload?.start_date === 'string' && payload.start_date.trim()
    ? payload.start_date.trim()
    : null

  await clearForecastData()

  const args = [scriptPath, '--days', String(validDays)]
  if (startDate) {
    args.push('--start-date', startDate)
  }

  const { code, signal, stdout, stderr } = await runPython({
    args,
    timeout: 120_000,
    env: { PYTHONIOENCODING: 'utf-8' },
  })

  if (code !== 0) {
    throw new Error(`Forecast generation failed (code=${code}, signal=${signal || 'none'}): ${stderr || stdout}`)
  }

  const lines = stdout.trim().split('\n').filter(Boolean)
  const parsedSummary = lines.length ? parseJsonString(lines[lines.length - 1], null) : null
  const summary = parsedSummary && typeof parsedSummary === 'object'
    ? parsedSummary
    : { success: true, output: stdout }

  let forecasts = []
  if (await fileExists(FORECAST_INDEX_PATH)) {
    const raw = await fsPromises.readFile(FORECAST_INDEX_PATH, 'utf8')
    const parsed = parseJsonString(raw, [])
    forecasts = Array.isArray(parsed) ? parsed : []
  }

  return {
    success: true,
    ...summary,
    forecasts_count: forecasts.length,
    forecasts: forecasts.slice(0, 10),
  }
}

async function runWeeklyRetrainJob() {
  const scriptPath = path.resolve(PROJECT_ROOT, 'scripts', 'train_forecast_model.py')
  if (!(await fileExists(scriptPath))) {
    throw new Error('Retraining script missing')
  }

  ensureRetrainDirectories()
  const args = [scriptPath, '--history-limit', '0']
  const startedAt = getNowIso()

  const { code, signal, stdout, stderr } = await runPython({
    args,
    timeout: 300_000,
    env: { PYTHONIOENCODING: 'utf-8' },
  })

  if (code !== 0) {
    throw new Error(`Weekly retrain failed (code=${code}, signal=${signal || 'none'}): ${stderr || stdout}`)
  }

  const parsedSummary = parseLastJsonLine(stdout)
  const summary = {
    success: true,
    started_at: startedAt,
    finished_at: getNowIso(),
    model_path: 'models/forecast_model.pkl',
    script: 'scripts/train_forecast_model.py',
    details: parsedSummary || { output: stdout },
  }

  await fsPromises.writeFile(RETRAIN_SUMMARY_PATH, JSON.stringify(summary, null, 2), 'utf8')
  return summary
}

async function writeResultArtifact(jobId, type, result) {
  ensureRuntimeDirectories()
  const artifactPath = path.resolve(JOB_RESULTS_DIR, `${jobId}.json`)
  const artifactPayload = {
    jobId,
    type,
    generated_at: getNowIso(),
    result,
  }
  await fsPromises.writeFile(artifactPath, JSON.stringify(artifactPayload, null, 2), 'utf8')
  return artifactPath
}

async function executeJobByType(type, payload) {
  if (type === 'simulate') {
    return runSimulationJob(payload)
  }
  if (type === 'forecast') {
    return runForecastJob(payload)
  }
  throw new Error(`Unsupported job type: ${type}`)
}

const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
})

const maintenanceConnection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
})

const worker = new Worker(
  JOB_QUEUE_NAME,
  async (bullJob) => {
    const jobId = typeof bullJob?.data?.jobId === 'string' ? bullJob.data.jobId : String(bullJob.id || '')
    if (!jobId) {
      throw new Error('Queued job is missing jobId')
    }

    const jobRow = getJobRow(jobId)
    if (!jobRow) {
      throw new Error(`Job row not found for id ${jobId}`)
    }

    updateJobRow({
      id: jobId,
      status: JOB_STATUSES.RUNNING,
      startedAt: getNowIso(),
      queueJobId: String(bullJob.id),
      errorText: null,
    })

    const payload = parseJsonString(jobRow.request_json, null)
    if (!payload || typeof payload !== 'object') {
      updateJobRow({
        id: jobId,
        status: JOB_STATUSES.FAILED,
        errorText: 'Stored request payload is invalid',
        completedAt: getNowIso(),
      })
      throw new Error(`Invalid payload for job ${jobId}`)
    }

    try {
      const result = await executeJobByType(jobRow.type, payload)
      const artifactPath = await writeResultArtifact(jobId, jobRow.type, result)
      updateJobRow({
        id: jobId,
        status: JOB_STATUSES.DONE,
        resultJson: JSON.stringify(result),
        resultPath: artifactPath,
        errorText: null,
        completedAt: getNowIso(),
      })
      return { jobId, status: JOB_STATUSES.DONE }
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err)
      updateJobRow({
        id: jobId,
        status: JOB_STATUSES.FAILED,
        errorText,
        completedAt: getNowIso(),
      })
      throw err
    }
  },
  {
    connection,
    concurrency: Math.max(1, Number.parseInt(process.env.JOB_WORKER_CONCURRENCY || '2', 10) || 2),
  }
)

const maintenanceWorker = ENABLE_WEEKLY_RETRAIN
  ? new Worker(
      MAINTENANCE_QUEUE_NAME,
      async (job) => {
        if (job?.name !== 'weekly-retrain') {
          throw new Error(`Unsupported maintenance job: ${job?.name || 'unknown'}`)
        }
        const result = await runWeeklyRetrainJob()
        return {
          ok: true,
          ...result,
        }
      },
      {
        connection: maintenanceConnection,
        concurrency: 1,
      }
    )
  : null

async function scheduleWeeklyRetraining() {
  if (!ENABLE_WEEKLY_RETRAIN) {
    console.log('[job-worker] Weekly retraining scheduler disabled via ENABLE_WEEKLY_RETRAIN=false')
    return
  }

  if (!maintenanceQueue) {
    maintenanceQueue = new Queue(MAINTENANCE_QUEUE_NAME, {
      connection: maintenanceConnection,
      defaultJobOptions: {
        removeOnComplete: 50,
        removeOnFail: 50,
      },
    })
  }

  await maintenanceQueue.waitUntilReady()
  await maintenanceQueue.add(
    'weekly-retrain',
    {
      schedule: 'weekly',
      created_at: getNowIso(),
    },
    {
      jobId: 'weekly-retrain',
      repeat: {
        pattern: WEEKLY_RETRAIN_CRON,
        tz: WEEKLY_RETRAIN_TZ,
      },
      removeOnComplete: 50,
      removeOnFail: 50,
    }
  )

  console.log(
    `[job-worker] Weekly retraining scheduled on queue ${MAINTENANCE_QUEUE_NAME} with cron "${WEEKLY_RETRAIN_CRON}" (${WEEKLY_RETRAIN_TZ})`
  )
}

worker.on('ready', () => {
  console.log(`[job-worker] Ready. Queue=${JOB_QUEUE_NAME}`)
})

worker.on('completed', (job) => {
  console.log(`[job-worker] Completed job ${job.id}`)
})

worker.on('failed', (job, err) => {
  const id = job?.id ?? 'unknown'
  console.error(`[job-worker] Failed job ${id}:`, err)
})

if (maintenanceWorker) {
  maintenanceWorker.on('ready', () => {
    console.log(`[job-worker] Maintenance worker ready. Queue=${MAINTENANCE_QUEUE_NAME}`)
  })

  maintenanceWorker.on('completed', (job) => {
    console.log(`[job-worker] Completed maintenance job ${job.id}`)
  })

  maintenanceWorker.on('failed', (job, err) => {
    const id = job?.id ?? 'unknown'
    console.error(`[job-worker] Failed maintenance job ${id}:`, err)
  })
}

scheduleWeeklyRetraining().catch((err) => {
  console.error('[job-worker] Failed to schedule weekly retraining:', err)
})

async function shutdown(signal) {
  console.log(`[job-worker] Received ${signal}, shutting down...`)
  try {
    await worker.close()
  } catch (err) {
    console.error('[job-worker] Worker close failed:', err)
  }
  if (maintenanceWorker) {
    try {
      await maintenanceWorker.close()
    } catch (err) {
      console.error('[job-worker] Maintenance worker close failed:', err)
    }
  }
  if (maintenanceQueue) {
    try {
      await maintenanceQueue.close()
    } catch (err) {
      console.error('[job-worker] Maintenance queue close failed:', err)
    }
  }
  try {
    await connection.quit()
  } catch (err) {
    console.error('[job-worker] Redis connection close failed:', err)
  }
  try {
    await maintenanceConnection.quit()
  } catch (err) {
    console.error('[job-worker] Maintenance redis connection close failed:', err)
  }
  process.exit(0)
}

process.on('SIGINT', () => { void shutdown('SIGINT') })
process.on('SIGTERM', () => { void shutdown('SIGTERM') })
