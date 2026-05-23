function getRedisUrl() {
  const explicitUrl = String(process.env.REDIS_URL || '').trim()
  if (explicitUrl) return explicitUrl
  const host = String(process.env.REDIS_HOST || '127.0.0.1').trim() || '127.0.0.1'
  const port = String(process.env.REDIS_PORT || '6381').trim() || '6381'
  return `redis://${host}:${port}`
}

function getRedisConnectionTimeoutMs() {
  const parsed = Number.parseInt(process.env.REDIS_CONNECTION_TIMEOUT_MS || process.env.JOB_QUEUE_READY_TIMEOUT_MS || '1000', 10)
  return Math.max(250, Number.isFinite(parsed) ? parsed : 1000)
}

function getRedisConnectionOptions({ healthCheck = false } = {}) {
  const timeout = getRedisConnectionTimeoutMs()
  return {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    connectTimeout: timeout,
    retryStrategy: healthCheck ? (() => null) : ((times) => Math.min(times * 500, 5000)),
  }
}

module.exports = {
  getRedisUrl,
  getRedisConnectionTimeoutMs,
  getRedisConnectionOptions,
}
