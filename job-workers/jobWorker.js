const fs = require('fs')
const fsPromises = require('fs/promises')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')
const IORedis = require('ioredis')
const { Worker } = require('bullmq')
const { getRedisUrl, getRedisConnectionOptions } = require('./redisConfig.cjs')
const { runNs3Job } = require('../simulation/ns3/adapter/ns3JobAdapter.js')

const JOB_QUEUE_NAME = (process.env.JOB_QUEUE_NAME || 'netvision-jobs').trim()
const REDIS_URL = getRedisUrl()

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

let db = null

function ensureRuntimeDirectories() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true })
  fs.mkdirSync(JOB_RESULTS_DIR, { recursive: true })
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
      request_hash TEXT,
      result_json TEXT,
      result_path TEXT,
      error_text TEXT,
      queue_job_id TEXT,
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );
  `)
  const columns = db.prepare('PRAGMA table_info(jobs)').all().map((column) => column.name)
  if (!columns.includes('idempotency_key')) {
    db.exec('ALTER TABLE jobs ADD COLUMN idempotency_key TEXT')
  }
  if (!columns.includes('request_hash')) {
    db.exec('ALTER TABLE jobs ADD COLUMN request_hash TEXT')
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idempotency_key ON jobs(idempotency_key);')
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
    const engine = String(payload?.engine || 'ns3').trim().toLowerCase()
    if (engine === 'ns3') {
      return runNs3Job({ projectRoot: PROJECT_ROOT, jobId: payload.__jobId, payload })
    }
    throw new Error(`Unsupported simulation engine: ${engine}. Only ns3 is enabled.`)
  }
  throw new Error(`Unsupported job type: ${type}`)
}

const connection = new IORedis(REDIS_URL, {
  ...getRedisConnectionOptions({ healthCheck: false }),
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
      const result = await executeJobByType(jobRow.type, { ...payload, __jobId: jobId })
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

async function shutdown(signal) {
  console.log(`[job-worker] Received ${signal}, shutting down...`)
  try {
    await worker.close()
  } catch (err) {
    console.error('[job-worker] Worker close failed:', err)
  }
  try {
    await connection.quit()
  } catch (err) {
    console.error('[job-worker] Redis connection close failed:', err)
  }
  process.exit(0)
}

process.on('SIGINT', () => { void shutdown('SIGINT') })
process.on('SIGTERM', () => { void shutdown('SIGTERM') })
