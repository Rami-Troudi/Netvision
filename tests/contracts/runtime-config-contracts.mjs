import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const nextConfigFactory = require('../../next.config.js')

test('defaults BullMQ Redis to the local Redis 7 port used by V2', () => {
  const original = process.env.REDIS_URL
  delete process.env.REDIS_URL
  delete process.env.REDIS_PORT
  const { getRedisUrl } = require('../../job-workers/redisConfig.cjs')
  assert.equal(getRedisUrl(), 'redis://127.0.0.1:6381')
  if (original === undefined) delete process.env.REDIS_URL
  else process.env.REDIS_URL = original
})

test('resolves a usable Python binary instead of the Windows Store alias when PYTHON_BIN is unset', () => {
  const original = process.env.PYTHON_BIN
  delete process.env.PYTHON_BIN
  const { getPythonBin } = require('../../job-workers/pythonConfig.cjs')
  const resolved = getPythonBin()
  assert.match(resolved, /python|py/i)
  assert.notEqual(resolved, 'python')
  if (original === undefined) delete process.env.PYTHON_BIN
  else process.env.PYTHON_BIN = original
})

test('keeps Next dev and production build artifacts in separate directories', () => {
  const devConfig = nextConfigFactory('phase-development-server')
  const buildConfig = nextConfigFactory('phase-production-build')

  assert.equal(devConfig.distDir, '.next-dev')
  assert.equal(buildConfig.distDir, '.next-build')
  assert.notEqual(devConfig.distDir, buildConfig.distDir)
})
