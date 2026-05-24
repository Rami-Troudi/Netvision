import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { DatabaseSync } from 'node:sqlite'
import { Queue } from 'bullmq'
import IORedis from 'ioredis'

const require = createRequire(import.meta.url)
const { getRedisUrl, getRedisConnectionTimeoutMs, getRedisConnectionOptions } = require('../../../job-workers/redisConfig.cjs')

export const JOB_TYPES = Object.freeze({
  SIMULATE: 'simulate',
})

export const JOB_STATUSES = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
})

export const JOB_QUEUE_NAME = process.env.JOB_QUEUE_NAME?.trim() || 'netvision-jobs'
export const REDIS_URL = getRedisUrl()
const JOB_QUEUE_READY_TIMEOUT_MS = getRedisConnectionTimeoutMs()
const DB_DIR = path.resolve(process.cwd(), '.runtime')
const DB_PATH = path.resolve(DB_DIR, 'jobs.sqlite')
const JOB_RESULTS_DIR = path.resolve(DB_DIR, 'job-results')

let db = null
let queue = null
let queueConnection = null

function ensureDirectories() {
  fs.mkdirSync(DB_DIR, { recursive: true })
  fs.mkdirSync(JOB_RESULTS_DIR, { recursive: true })
}

function ensureSchema(database) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT,
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
  const columns = database.prepare('PRAGMA table_info(jobs)').all().map((column) => column.name)
  if (!columns.includes('idempotency_key')) {
    database.exec('ALTER TABLE jobs ADD COLUMN idempotency_key TEXT')
  }
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idempotency_key ON jobs(idempotency_key);')
}

export function getJobsDb() {
  if (db) return db
  ensureDirectories()
  db = new DatabaseSync(DB_PATH)
  ensureSchema(db)
  return db
}

export function getJobsResultsDir() {
  ensureDirectories()
  return JOB_RESULTS_DIR
}

function getNowIso() {
  return new Date().toISOString()
}

export function createJobRecord({ id, type, payload, idempotencyKey = null }) {
  const now = getNowIso()
  const database = getJobsDb()
  const stmt = database.prepare(`
    INSERT INTO jobs (id, idempotency_key, type, status, request_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  stmt.run(id, idempotencyKey, type, JOB_STATUSES.PENDING, JSON.stringify(payload), now, now)
}

export function getJobRecordByIdempotencyKey(idempotencyKey) {
  if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) return null
  const database = getJobsDb()
  return database.prepare('SELECT * FROM jobs WHERE idempotency_key = ?').get(idempotencyKey.trim())
}

export function updateJobRecord({ id, status, resultJson, resultPath, errorText, queueJobId, startedAt, completedAt }) {
  const now = getNowIso()
  const database = getJobsDb()
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
    now,
    id
  )
  return true
}

export function getJobRecord(id) {
  const database = getJobsDb()
  return database.prepare('SELECT * FROM jobs WHERE id = ?').get(id)
}

export function parseJsonValue(rawValue) {
  if (typeof rawValue !== 'string' || !rawValue.trim()) return null
  try {
    return JSON.parse(rawValue)
  } catch {
    return null
  }
}

export function formatJobApiResponse(jobRow) {
  const response = {
    jobId: jobRow.id,
    type: jobRow.type,
    status: jobRow.status,
    created_at: jobRow.created_at,
    updated_at: jobRow.updated_at,
  }

  if (jobRow.status === JOB_STATUSES.DONE) {
    const parsedResult = parseJsonValue(jobRow.result_json)
    if (parsedResult !== null) {
      response.result = parsedResult
    } else if (typeof jobRow.result_path === 'string' && jobRow.result_path.trim()) {
      try {
        const artifactRaw = fs.readFileSync(jobRow.result_path, 'utf8')
        const artifact = parseJsonValue(artifactRaw)
        const artifactResult = artifact && typeof artifact === 'object' ? artifact.result : null
        if (artifactResult !== null && artifactResult !== undefined) {
          response.result = artifactResult
        }
      } catch (err) {
        console.error('Failed to read job artifact:', err)
      }
    }
  }

  if (jobRow.status === JOB_STATUSES.FAILED && jobRow.error_text) {
    response.error = jobRow.error_text
  }

  return response
}

function createQueueConnection() {
  if (queueConnection) return queueConnection
  queueConnection = new IORedis(REDIS_URL, getRedisConnectionOptions({ healthCheck: true }))
  queueConnection.on('error', () => {
    // Health routes report Redis status explicitly; avoid noisy ECONNREFUSED logs.
  })
  return queueConnection
}

export async function checkRedisConnection() {
  const connection = new IORedis(REDIS_URL, getRedisConnectionOptions({ healthCheck: true }))
  connection.on('error', () => {
    // The caller converts connection failures into optional degraded health.
  })
  try {
    await Promise.race([
      connection.ping(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Redis health check timeout')), JOB_QUEUE_READY_TIMEOUT_MS)
      }),
    ])
    return true
  } finally {
    try {
      await connection.quit()
    } catch {
      connection.disconnect()
    }
  }
}

export async function getJobsQueue() {
  if (!queue) {
    queue = new Queue(JOB_QUEUE_NAME, {
      connection: createQueueConnection(),
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: 500,
        removeOnFail: 500,
      },
    })
  }
  await Promise.race([
    queue.waitUntilReady(),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Queue readiness timeout')), JOB_QUEUE_READY_TIMEOUT_MS)
    }),
  ])
  return queue
}
