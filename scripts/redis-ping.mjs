import { createRequire } from 'module'
import { execFile } from 'child_process'

const require = createRequire(import.meta.url)
const { getRedisUrl } = require('../job-workers/redisConfig.cjs')

function parseRedisUrl(url) {
  const parsed = new URL(url)
  return {
    host: parsed.hostname || '127.0.0.1',
    port: parsed.port || '6381',
  }
}

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 4000 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim(), error })
    })
  })
}

async function main() {
  const redisUrl = getRedisUrl()
  const { host, port } = parseRedisUrl(redisUrl)
  const attempt = await run('redis-cli', ['-h', host, '-p', String(port), 'PING'])
  if (!attempt.ok) {
    console.error(`Redis ping failed on ${host}:${port}`)
    if (attempt.stderr) console.error(attempt.stderr)
    process.exit(1)
  }
  console.log(`${attempt.stdout || 'PONG'} (${host}:${port})`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
