import fs from 'fs'
import path from 'path'
import { readFile, stat } from 'fs/promises'
import { requireAuthenticatedRequest } from '../_lib/security'
import { getRuntimeDataRoot } from '../_lib/dataMode'

if (!BigInt.prototype.toJSON) {
  BigInt.prototype.toJSON = function () { return Number(this) }
}

const ALLOWED_ROOT_FILES = new Set([
  'baseline.json',
  'time_index.json',
  'stats.json',
  'admin_registry.json',
  'admin_cell_index.json',
  'admin_reconciliation_report.json',
])

const ALLOWED_DATA_DIRS = new Set([
  'time_data',
])

const OBSERVATION_BOOLEAN_KEYS = new Set(['congested'])

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
  const { root: dataRoot, mode } = getRuntimeDataRoot()
  const [head, ...tail] = slugParts

  if (!tail.length) {
    if (!ALLOWED_ROOT_FILES.has(head)) {
      throw new Error(`Data file "${head}" is not allowed. Allowed files: ${Array.from(ALLOWED_ROOT_FILES).join(', ')}`)
    }
    return {
      filePath: path.resolve(dataRoot, head),
      kind: 'json',
      dataDir: null,
      dataRoot,
      mode,
      requestPath: head,
    }
  }

  if (!ALLOWED_DATA_DIRS.has(head)) {
    throw new Error(`Data directory "${head}" is not allowed. Allowed directories: ${Array.from(ALLOWED_DATA_DIRS).join(', ')}`)
  }

  const baseDir = path.resolve(dataRoot, head)
  const targetPath = path.resolve(baseDir, ...tail)
  if (!isPathInsideDirectory(targetPath, baseDir)) {
    throw new Error('Invalid data path. Path traversal is not allowed.')
  }

  const ext = path.extname(targetPath).toLowerCase()
  if (ext !== '.json' && ext !== '.parquet') {
    throw new Error('Only JSON and Parquet time_data files are allowed.')
  }

  return {
    filePath: targetPath,
    kind: ext === '.parquet' ? 'parquet' : 'json',
    dataDir: head,
    dataRoot,
    mode,
    requestPath: [head, ...tail].join('/'),
  }
}

async function readParquetObservations(filePath) {
  const parquetModule = await import('parquetjs-lite')
  const ParquetReader = parquetModule?.ParquetReader || parquetModule?.default?.ParquetReader
  if (!ParquetReader) {
    throw new Error('Parquet reader is unavailable')
  }

  const reader = await ParquetReader.openFile(filePath)
  try {
    const observations = {}
    const cursor = reader.getCursor()
    let record = await cursor.next()
    while (record) {
      const cellName = String(record?.cell_name || '').trim()
      if (cellName) {
        const observation = {}
        for (const [key, value] of Object.entries(record)) {
          if (key === 'cell_name') continue
          observation[key] = normalizeObservationValue(key, value)
        }
        observations[cellName] = observation
      }
      record = await cursor.next()
    }
    return observations
  } finally {
    try {
      await reader.close()
    } catch (ignore) {
      // Ignore errors on close
    }
  }
}


function normalizeObservationValue(key, value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' && Number.isNaN(value)) return null
  if (typeof value === 'bigint') return Number(value)

  if (OBSERVATION_BOOLEAN_KEYS.has(key)) {
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase()
      return normalized === 'true' || normalized === '1' || normalized === 'yes'
    }
    return Boolean(value)
  }

  return value
}

// Module-level metadata cache
const _metadataCache = {
  time_data: { mtime: 0, entries: [] },
}

async function loadSliceMetadata(projectRoot, dataDir, filename) {
  const { root: dataRoot } = getRuntimeDataRoot()
  if (dataDir === 'time_data') {
    const indexFileName = 'time_index.json'
    const indexPath = path.resolve(dataRoot, indexFileName)
    
    let currentMtime = 0
    try {
      const indexStat = await stat(indexPath)
      currentMtime = indexStat.mtimeMs
    } catch {
      throw new Error(indexFileName + ' not found')
    }

    if (_metadataCache[dataDir].mtime !== currentMtime) {
      const raw = await readFile(indexPath, 'utf8')
      const parsed = JSON.parse(raw)
      _metadataCache[dataDir].entries = Array.isArray(parsed?.timestamps || parsed) 
        ? (parsed.timestamps || parsed) : []
      _metadataCache[dataDir].mtime = currentMtime
    }

    const match = _metadataCache[dataDir].entries.find((entry) => entry?.filename === filename)
    if (!match) throw new Error(indexFileName + ' metadata not found')
    
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
  } catch (err) {
    return res.status(400).json({ error: 'Invalid data path', detail: err instanceof Error ? err.message : String(err) })
  }

  const { filePath, kind, dataDir, dataRoot, mode, requestPath } = resolvedPath

  try {
    const info = await stat(filePath)
    if (!info.isFile()) {
      return res.status(404).json({
        error: 'Data file not found',
        detail: `${requestPath} exists but is not a file in ${mode} runtime data.`,
        mode,
        data_root: dataRoot,
        action: 'Verify runtime_data generation or run the relevant data preparation script.',
      })
    }
  } catch (err) {
    return res.status(404).json({
      error: 'Data file not found',
      detail: `${requestPath} was not found in ${mode} runtime data.`,
      mode,
      data_root: dataRoot,
      action: requestPath.startsWith('admin_')
        ? 'Run scripts/prepare_admin_boundaries.py and scripts/build_admin_cell_index.py.'
        : 'Run the runtime data processing pipeline or check the selected data mode.',
    })
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')

  if (kind === 'parquet') {
    try {
      const [rows, metadata] = await Promise.all([
        readParquetObservations(filePath),
        loadSliceMetadata(projectRoot, dataDir, path.basename(filePath)),
      ])

      const payload = {
        timestamp: metadata.timestamp,
        stats: metadata.stats,
        observations: rows,
      }

      if (metadata.confidence !== undefined) {
        payload.confidence = metadata.confidence
      }

      return res.status(200).json(payload)
    } catch (err) {
      console.error('Failed to read parquet data file:', err)
      return res.status(500).json({ error: 'Failed to read data file', detail: err instanceof Error ? err.message : String(err), mode, data_root: dataRoot })
    }
  }

  const stream = fs.createReadStream(filePath)
  stream.on('error', (err) => {
    console.error('Failed to stream data file:', err)
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to read data file', detail: err instanceof Error ? err.message : String(err), mode, data_root: dataRoot })
    } else {
      res.destroy(err)
    }
  })
  stream.pipe(res)
}
