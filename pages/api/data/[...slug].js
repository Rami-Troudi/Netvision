import fs from 'fs'
import path from 'path'
import { readFile, stat } from 'fs/promises'
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

const OBSERVATION_BOOLEAN_KEYS = new Set(['congested', 'is_forecast'])

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
    return {
      filePath: path.resolve(projectRoot, head),
      kind: 'json',
      dataDir: null,
    }
  }

  if (!ALLOWED_DATA_DIRS.has(head)) {
    throw new Error('Directory is not allowed')
  }

  const baseDir = path.resolve(projectRoot, head)
  const targetPath = path.resolve(baseDir, ...tail)
  if (!isPathInsideDirectory(targetPath, baseDir)) {
    throw new Error('Invalid path')
  }

  const ext = path.extname(targetPath).toLowerCase()
  if (ext !== '.json' && ext !== '.parquet') {
    throw new Error('Only JSON and Parquet files are allowed')
  }

  return {
    filePath: targetPath,
    kind: ext === '.parquet' ? 'parquet' : 'json',
    dataDir: head,
  }
}

async function readParquetRows(filePath) {
  const parquetModule = await import('parquetjs-lite')
  const ParquetReader = parquetModule?.ParquetReader || parquetModule?.default?.ParquetReader
  if (!ParquetReader) {
    throw new Error('Parquet reader is unavailable')
  }

  const reader = await ParquetReader.openFile(filePath)
  try {
    const rows = []
    const cursor = reader.getCursor()
    let record = await cursor.next()
    while (record) {
      rows.push(record)
      record = await cursor.next()
    }
    return rows
  } finally {
    await reader.close()
  }
}

function normalizeObservationValue(key, value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' && Number.isNaN(value)) return null

  if (OBSERVATION_BOOLEAN_KEYS.has(key)) {
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase()
      return normalized === 'true' || normalized === '1' || normalized === 'yes'
    }
    return Boolean(value)
  }

  return value
}

function rowsToObservations(rows) {
  const observations = {}

  for (const row of rows) {
    const cellName = String(row?.cell_name || '').trim()
    if (!cellName) continue

    const observation = {}
    for (const [key, value] of Object.entries(row)) {
      if (key === 'cell_name') continue
      observation[key] = normalizeObservationValue(key, value)
    }

    observations[cellName] = observation
  }

  return observations
}

async function loadSliceMetadata(projectRoot, dataDir, filename) {
  if (dataDir === 'time_data') {
    const raw = await readFile(path.resolve(projectRoot, 'time_index.json'), 'utf8')
    const parsed = JSON.parse(raw)
    const entries = Array.isArray(parsed?.timestamps) ? parsed.timestamps : []
    const match = entries.find((entry) => entry?.filename === filename)
    if (!match) throw new Error('Time index metadata not found')
    return {
      timestamp: match.timestamp || filename,
      stats: match.stats || {},
    }
  }

  if (dataDir === 'forecast_data') {
    const raw = await readFile(path.resolve(projectRoot, 'forecast_index.json'), 'utf8')
    const parsed = JSON.parse(raw)
    const entries = Array.isArray(parsed) ? parsed : []
    const match = entries.find((entry) => entry?.filename === filename)
    if (!match) throw new Error('Forecast index metadata not found')
    return {
      timestamp: match.timestamp || filename,
      stats: match.stats || {},
      confidence: match.confidence,
    }
  }

  throw new Error('Unsupported Parquet directory')
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
  let resolvedPath
  try {
    resolvedPath = resolveDataPath(projectRoot, slugParts)
  } catch {
    return res.status(400).json({ error: 'Invalid data path' })
  }

  const { filePath, kind, dataDir } = resolvedPath

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

  if (kind === 'parquet') {
    try {
      const [rows, metadata] = await Promise.all([
        readParquetRows(filePath),
        loadSliceMetadata(projectRoot, dataDir, path.basename(filePath)),
      ])

      const payload = {
        timestamp: metadata.timestamp,
        stats: metadata.stats,
        observations: rowsToObservations(rows),
      }

      if (metadata.confidence !== undefined) {
        payload.confidence = metadata.confidence
      }

      return res.status(200).json(payload)
    } catch (err) {
      console.error('Failed to read parquet data file:', err)
      return res.status(500).json({ error: 'Failed to read data file' })
    }
  }

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
