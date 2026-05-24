import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

const AUDIT_DIR = path.resolve(process.cwd(), '.runtime', 'audit')
const AUDIT_FILE = path.resolve(AUDIT_DIR, 'audit.jsonl')

function ensureAuditDir() {
  fs.mkdirSync(AUDIT_DIR, { recursive: true })
}

export function auditActor(req) {
  const token = String(req.headers?.authorization || req.headers?.['x-api-token'] || '')
  if (!token) return 'dev-bypass'
  return `token:${crypto.createHash('sha256').update(token).digest('hex').slice(0, 12)}`
}

export function appendAudit(entry) {
  ensureAuditDir()
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`
  fs.appendFileSync(AUDIT_FILE, line, 'utf8')
}

