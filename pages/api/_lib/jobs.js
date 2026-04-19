import fs from 'fs'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'
import { Queue } from 'bullmq'
import IORedis from 'ioredis'

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
const REDIS_URL = process.env.REDIS_URL?.trim() || 'redis://127.0.0.1:6379'
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

export function createJobRecord({ id, type, payload }) {
  const now = getNowIso()
  const database = getJobsDb()
  const stmt = database.prepare(`
    INSERT INTO jobs (id, type, status, request_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
  stmt.run(id, type, JOB_STATUSES.PENDING, JSON.stringify(payload), now, now)
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
  queueConnection = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  })
  return queueConnection
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
  await queue.waitUntilReady()
  return queue
}
