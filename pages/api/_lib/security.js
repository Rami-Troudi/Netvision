import crypto from 'crypto'

const AUTH_ENV_KEYS = ['API_AUTH_TOKEN', 'API_TOKEN', 'AUTH_TOKEN', 'SESSION_TOKEN']
const TOKEN_HEADER_KEYS = ['x-api-token', 'x-session-token']
const TOKEN_COOKIE_KEYS = ['api_token', 'auth_token', 'session_token', 'token', 'session']
const RATE_LIMIT_STORE = new Map()

let warnedMissingToken = false

function getConfiguredToken() {
  for (const key of AUTH_ENV_KEYS) {
    const value = process.env[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return null
}

function extractBearerToken(req) {
  const header = req.headers?.authorization
  if (typeof header !== 'string') return null
  if (!header.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  return token || null
}

function extractHeaderToken(req) {
  for (const key of TOKEN_HEADER_KEYS) {
    const value = req.headers?.[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return null
}

function extractCookieToken(req) {
  const cookies = req.cookies || {}
  for (const key of TOKEN_COOKIE_KEYS) {
    const value = cookies[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return null
}

function extractRequestToken(req) {
  return (
    extractBearerToken(req) ||
    extractHeaderToken(req) ||
    extractCookieToken(req)
  )
}

function safeTokenEquals(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const leftBuf = Buffer.from(left)
  const rightBuf = Buffer.from(right)
  if (leftBuf.length !== rightBuf.length) return false
  return crypto.timingSafeEqual(leftBuf, rightBuf)
}

export function isAuthenticatedRequest(req) {
  const configuredToken = getConfiguredToken()
  if (!configuredToken) {
    if (!warnedMissingToken) {
      warnedMissingToken = true
      console.warn('Auth token is not configured; auth checks are currently bypassed')
    }
    return true
  }

  const requestToken = extractRequestToken(req)
  if (!requestToken) return false
  return safeTokenEquals(requestToken, configuredToken)
}

export function requireAuthenticatedRequest(req, res) {
  if (!isAuthenticatedRequest(req)) {
    res.status(401).json({ error: 'Unauthorized' })
    return false
  }
  return true
}

export function getClientIp(req) {
  const forwarded = req.headers?.['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim()
  }
  const realIp = req.headers?.['x-real-ip']
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim()
  }
  return req.socket?.remoteAddress || 'unknown'
}

function pruneRateLimitStore(now) {
  if (RATE_LIMIT_STORE.size < 1024) return
  for (const [key, bucket] of RATE_LIMIT_STORE.entries()) {
    if (!bucket || bucket.resetAt <= now) {
      RATE_LIMIT_STORE.delete(key)
    }
  }
}

export function enforceRateLimit(req, res, options = {}) {
  const {
    keyPrefix = 'api',
    maxRequests = 10,
    windowMs = 60_000,
  } = options

  const now = Date.now()
  pruneRateLimitStore(now)

  const ip = getClientIp(req)
  const key = `${keyPrefix}:${ip}`

  let bucket = RATE_LIMIT_STORE.get(key)
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs }
  }

  bucket.count += 1
  RATE_LIMIT_STORE.set(key, bucket)

  if (bucket.count > maxRequests) {
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
    res.setHeader('Retry-After', String(retryAfterSeconds))
    res.status(429).json({ error: 'Too many requests' })
    return false
  }

  return true
}
