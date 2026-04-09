import fs from 'fs'
import path from 'path'
import { stat } from 'fs/promises'
import { requireAuthenticatedRequest } from '../_lib/security'

const ALLOWED_ROOT_FILES = new Set([
  'baseline.json',
  'time_index.json',
  'stats.json',
  'forecast_index.json',
])

const ALLOWED_DATA_DIRS = new Set([
  'time_data',
  'forecast_data',
])

function isPathInsideDirectory(targetPath, directoryPath) {
  const relative = path.relative(directoryPath, targetPath)
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function sanitizeSlugParts(rawParts) {
  return rawParts
    .map((part) => String(part || '').trim())
    .filter(Boolean)
}

function resolveDataPath(projectRoot, slugParts) {
  const [head, ...tail] = slugParts

  if (!tail.length) {
    if (!ALLOWED_ROOT_FILES.has(head)) {
      throw new Error('File is not allowed')
    }
    return path.resolve(projectRoot, head)
  }

  if (!ALLOWED_DATA_DIRS.has(head)) {
    throw new Error('Directory is not allowed')
  }

  const baseDir = path.resolve(projectRoot, head)
  const targetPath = path.resolve(baseDir, ...tail)
  if (!isPathInsideDirectory(targetPath, baseDir)) {
    throw new Error('Invalid path')
  }
  if (path.extname(targetPath).toLowerCase() !== '.json') {
    throw new Error('Only JSON files are allowed')
  }
  return targetPath
}

export default async function handler(req, res) {
  if (!requireAuthenticatedRequest(req, res)) return

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const slugRaw = req.query.slug
  const slugParts = sanitizeSlugParts(Array.isArray(slugRaw) ? slugRaw : [slugRaw])
  if (!slugParts.length) {
    return res.status(400).json({ error: 'Missing data path' })
  }

  const projectRoot = process.cwd()
  let filePath
  try {
    filePath = resolveDataPath(projectRoot, slugParts)
  } catch {
    return res.status(400).json({ error: 'Invalid data path' })
  }

  try {
    const info = await stat(filePath)
    if (!info.isFile()) {
      return res.status(404).json({ error: 'Data file not found' })
    }
  } catch {
    return res.status(404).json({ error: 'Data file not found' })
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')

  const stream = fs.createReadStream(filePath)
  stream.on('error', (err) => {
    console.error('Failed to stream data file:', err)
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to read data file' })
    } else {
      res.destroy(err)
    }
  })
  stream.pipe(res)
}
