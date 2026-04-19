const DEFAULT_CQI_THRESHOLD = 8
const ORANGE_CONGESTION_CONFIG = Object.freeze({
  PRB_SATURATED: 90,
  PRB_REBALANCE_HEADROOM: 70,
  THROUGHPUT_DEGRADED: 4000,
  ACTIVE_USERS_CRITICAL: 4,
  RRC_USERS_CRITICAL: 4,
  CQI_POOR: 8,
  LOST_UE_BASELINE: 50,
  LOST_GB_BASELINE: 120,
})

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

function parseCellName(cellName) {
  const parts = String(cellName || '').split('_')
  if (parts.length < 3) {
    return {
      siteName: String(cellName || '').trim(),
      antenna: '',
      cellNum: 0,
    }
  }

  const siteName = `${parts[0]}_${parts[1]}`
  const suffix = parts.slice(2).join('_')
  const match = suffix.match(/^([a-zA-Z]+)(\d+)$/)
  if (!match) {
    return {
      siteName,
      antenna: suffix.toLowerCase(),
      cellNum: 0,
    }
  }

  return {
    siteName,
    antenna: String(match[1] || '').toLowerCase(),
    cellNum: Number.parseInt(match[2], 10) || 0,
  }
}

function toFiniteNumber(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }

  let text = String(value).trim()
  if (!text) return null

  if (/^(na|n\/a|null|undefined|nan|--?)$/i.test(text)) {
    return null
  }

  let isNegativeByParentheses = false
  if (text.startsWith('(') && text.endsWith(')')) {
    isNegativeByParentheses = true
    text = text.slice(1, -1)
  }

  // Strip units/symbols while preserving number punctuation and sign.
  text = text
    .replace(/\u00a0/g, ' ')
    .replace(/[%\s']/g, '')
    .replace(/[^0-9,\.\-+]/g, '')

  if (!text) return null

  const hasComma = text.includes(',')
  const hasDot = text.includes('.')

  if (hasComma && hasDot) {
    if (text.lastIndexOf(',') > text.lastIndexOf('.')) {
      // Example: 1.234,56 -> 1234.56
      text = text.replace(/\./g, '').replace(',', '.')
    } else {
      // Example: 1,234.56 -> 1234.56
      text = text.replace(/,/g, '')
    }
  } else if (hasComma) {
    const parts = text.split(',')
    if (parts.length === 2) {
      const left = parts[0]
      const right = parts[1]
      // Heuristic: 1,234 is usually a thousands group; 17,3 is decimal comma.
      if (right.length === 3 && left.length >= 1 && !left.startsWith('+') && !left.startsWith('-')) {
        text = `${left}${right}`
      } else {
        text = `${left}.${right}`
      }
    } else {
      text = parts.join('')
    }
  } else if (hasDot) {
    const parts = text.split('.')
    if (parts.length > 2) {
      const decimalPart = parts.pop() || ''
      if (decimalPart.length === 3) {
        text = `${parts.join('')}${decimalPart}`
      } else {
        text = `${parts.join('')}.${decimalPart}`
      }
    }
  }

  const parsed = Number(text)
  if (!Number.isFinite(parsed)) return null
  return isNegativeByParentheses ? -Math.abs(parsed) : parsed
}

function toBooleanLike(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    if (value === 1) return true
    if (value === 0) return false
    return null
  }

  const text = String(value).trim().toLowerCase()
  if (!text) return null
  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false
  return null
}

function createStrictDate(year, month, day, hour = 0, minute = 0, second = 0) {
  const y = Number(year)
  const m = Number(month)
  const d = Number(day)
  const hh = Number(hour)
  const mm = Number(minute)
  const ss = Number(second)

  if (![y, m, d, hh, mm, ss].every((value) => Number.isFinite(value))) {
    return new Date(Number.NaN)
  }

  if (m < 1 || m > 12 || d < 1 || d > 31 || hh < 0 || hh > 23 || mm < 0 || mm > 59 || ss < 0 || ss > 59) {
    return new Date(Number.NaN)
  }

  const date = new Date(y, m - 1, d, hh, mm, ss, 0)
  if (
    date.getFullYear() !== y ||
    date.getMonth() !== m - 1 ||
    date.getDate() !== d ||
    date.getHours() !== hh ||
    date.getMinutes() !== mm ||
    date.getSeconds() !== ss
  ) {
    return new Date(Number.NaN)
  }

  return date
}

function parseTimestamp(ts) {
  const text = String(ts || '').trim()
  if (!text) return new Date(Number.NaN)

  // Native parsing for explicit ISO strings with timezone support.
  if (text.includes('T') || /[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) {
    const iso = new Date(text)
    if (!Number.isNaN(iso.getTime())) return iso
  }

  const normalized = text.replace(/\s+/g, ' ')
  let match = normalized.match(/^(\d{2})-(\d{2})-(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/)
  if (match) {
    return createStrictDate(match[3], match[2], match[1], match[4] ?? 0, match[5] ?? 0, match[6] ?? 0)
  }

  match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/)
  if (match) {
    return createStrictDate(match[1], match[2], match[3], match[4] ?? 0, match[5] ?? 0, match[6] ?? 0)
  }

  match = normalized.match(/^(\d{4})\/(\d{2})\/(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/)
  if (match) {
    return createStrictDate(match[1], match[2], match[3], match[4] ?? 0, match[5] ?? 0, match[6] ?? 0)
  }

  const fallback = new Date(text)
  if (!Number.isNaN(fallback.getTime())) return fallback
  return new Date(Number.NaN)
}

function isValidDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

function formatTimestampFromDate(date) {
  const value = date instanceof Date ? date : new Date(date)
  const day = String(value.getDate()).padStart(2, '0')
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const year = value.getFullYear()
  const hour = String(value.getHours()).padStart(2, '0')
  const minute = String(value.getMinutes()).padStart(2, '0')
  return `${day}-${month}-${year} ${hour}:${minute}`
}

function getCellStatus(obs, cqiThreshold = DEFAULT_CQI_THRESHOLD) {
  if (!obs) return 'no-data'
  if (obs.congested) return 'congested'
  if (obs.cqi !== null && obs.cqi !== undefined && Number(obs.cqi) < cqiThreshold) return 'poor-cqi'
  if (obs.load === null || obs.load === undefined) return 'no-data'
  if (Number(obs.load) === 0) return 'idle'
  if (Number(obs.load) >= 70) return 'high-load'
  return 'normal'
}

function getLoadColor(load, isCongested, cqi, cqiThreshold, colors) {
  if (isCongested) return colors.CONGESTED
  if (cqi !== null && cqi !== undefined && Number(cqi) < cqiThreshold) return colors.CQI_POOR
  if (load === null || load === undefined) return colors.NO_DATA
  const numericLoad = Number(load)
  if (!Number.isFinite(numericLoad)) return colors.NO_DATA
  if (numericLoad === 0) return colors.IDLE
  if (numericLoad < 30) return colors.HEALTHY
  if (numericLoad < 50) return colors.LOW_LOAD
  if (numericLoad < 70) return colors.MEDIUM_LOAD
  if (numericLoad < 85) return colors.HIGH_LOAD
  return colors.CONGESTED
}

function buildSiteHierarchy(baseline) {
  const hierarchy = {}
  for (const [cellName, info] of Object.entries(baseline || {})) {
    const { siteName, antenna, cellNum } = parseCellName(cellName)
    if (!hierarchy[siteName]) {
      hierarchy[siteName] = {
        name: siteName,
        enodeb_name: info.enodeb_name,
        longitude: info.longitude,
        latitude: info.latitude,
        antennas: {},
      }
    }

    if (!hierarchy[siteName].antennas[antenna]) {
      hierarchy[siteName].antennas[antenna] = {
        id: antenna,
        azimuth: info.azimuth,
        band: info.frequency_band,
        type: info.cell_fdd_tdd_indication || 'FDD',
        cells: [],
      }
    }

    hierarchy[siteName].antennas[antenna].cells.push({
      cellName,
      cellNum,
      frequency_band: info.frequency_band,
      localcell_id: info.localcell_id,
      azimuth: info.azimuth,
    })
  }

  Object.values(hierarchy).forEach((site) => {
    Object.values(site.antennas).forEach((antenna) => {
      antenna.cells.sort((left, right) => Number(left.cellNum) - Number(right.cellNum))
    })
  })

  return hierarchy
}

function buildFeatureUpdates(payload) {
  const {
    cellNames = [],
    observations = {},
    cqiThreshold = DEFAULT_CQI_THRESHOLD,
    colors = {},
  } = payload || {}

  return cellNames.map((cellName) => {
    const obs = observations?.[cellName] || null
    const cqi = obs?.cqi ?? null
    const hasLowCQI = cqi !== null && cqi !== undefined && Number(cqi) < cqiThreshold
    const load = obs?.load ?? null
    const congested = Boolean(obs?.congested)
    const taValue = obs?.ta ?? obs?.timing_advance ?? obs?.avg_ta ?? obs?.ta_avg ?? null
    const dynamicRadiusSupported =
      obs?.dynamic_radius_supported !== undefined && obs?.dynamic_radius_supported !== null
        ? Boolean(obs?.dynamic_radius_supported)
        : taValue !== null && taValue !== undefined
    const status = getCellStatus(obs, cqiThreshold)
    const color = getLoadColor(load, congested, cqi, cqiThreshold, colors)
    const baseUpdate = {
      cellName,
      status,
      color,
      opacity: obs ? 0.75 : 0.35,
      sector_opacity: obs ? 0.58 : 0.04,
      load,
      congested,
      issue_type: obs?.issue_type || 'Normal',
      root_cause: obs?.root_cause || '-',
      severity: obs?.severity ?? 0,
      health_score: obs?.health_score ?? 100,
      throughput: obs?.throughput ?? null,
      cqi,
      has_low_cqi: hasLowCQI,
      active_users: obs?.active_users ?? obs?.l_traffic_activeuser_dl_avg ?? null,
      rrc_users: obs?.rrc_users ?? obs?.ft_average_nb_of_users__ues_rrc_connected ?? null,
      traffic: obs?.traffic ?? null,
      traffic_loss_ue: obs?.traffic_loss_ue ?? 0,
      traffic_loss_gb: obs?.traffic_loss_gb ?? 0,
      ta: taValue,
      signal_power: obs?.signal_power ?? null,
      dynamic_radius_supported: dynamicRadiusSupported,
    }

    return baseUpdate
  })
}

function computeExploreData(payload) {
  const { duration, metric, timeIndex } = payload || {}
  const data = Array.isArray(timeIndex) ? timeIndex : []
  if (!data.length) {
    return { labels: [], values: [], insights: {} }
  }

  if (duration === 'hour') {
    const hourBuckets = Array.from({ length: 24 }, () => [])
    data.forEach((entry) => {
      const ts = String(entry?.timestamp || '')
      const match = ts.match(/(\d{2}):(\d{2})$/)
      if (!match) return
      const hour = Number.parseInt(match[1], 10)
      const value = Number(entry?.stats?.[metric] ?? 0)
      hourBuckets[hour].push(Number.isFinite(value) ? value : 0)
    })

    const labels = Array.from({ length: 24 }, (_, index) => `${String(index).padStart(2, '0')}:00`)
    const values = hourBuckets.map((bucket) => {
      if (!bucket.length) return 0
      return bucket.reduce((acc, current) => acc + current, 0) / bucket.length
    })

    const sorted = values
      .map((value, hour) => ({ hour, value }))
      .sort((left, right) => right.value - left.value)

    return {
      labels,
      values,
      insights: {
        peakHours: sorted.slice(0, 3).map((item) => `${String(item.hour).padStart(2, '0')}:00`),
        offPeakHours: sorted.slice(-3).map((item) => `${String(item.hour).padStart(2, '0')}:00`),
        maxValue: Math.max(...values),
        avgValue: values.reduce((acc, current) => acc + current, 0) / 24,
      },
    }
  }

  if (duration === 'day') {
    const dayBuckets = {}
    data.forEach((entry) => {
      const ts = String(entry?.timestamp || '')
      const match = ts.match(/^(\d{2}-\d{2}-\d{4})/)
      if (!match) return
      const day = match[1]
      const value = Number(entry?.stats?.[metric] ?? 0)
      if (!dayBuckets[day]) dayBuckets[day] = []
      dayBuckets[day].push(Number.isFinite(value) ? value : 0)
    })

    const labels = Object.keys(dayBuckets).sort((left, right) => parseTimestamp(left) - parseTimestamp(right))
    const values = labels.map((day) => {
      const bucket = dayBuckets[day]
      return bucket.reduce((acc, current) => acc + current, 0) / bucket.length
    })

    const maxIndex = values.indexOf(Math.max(...values))
    const minIndex = values.indexOf(Math.min(...values))

    return {
      labels,
      values,
      insights: {
        worstDay: labels[maxIndex] || null,
        bestDay: labels[minIndex] || null,
        maxValue: values[maxIndex] || 0,
        minValue: values[minIndex] || 0,
        avgValue: values.reduce((acc, current) => acc + current, 0) / Math.max(1, values.length),
      },
    }
  }

  if (duration === 'week') {
    const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const weekBuckets = Array.from({ length: 7 }, () => [])

    data.forEach((entry) => {
      const ts = String(entry?.timestamp || '')
      const match = ts.match(/^(\d{2})-(\d{2})-(\d{4})/)
      if (!match) return
      const date = new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]))
      const dow = date.getDay()
      const value = Number(entry?.stats?.[metric] ?? 0)
      weekBuckets[dow].push(Number.isFinite(value) ? value : 0)
    })

    const values = weekBuckets.map((bucket) => {
      if (!bucket.length) return 0
      return bucket.reduce((acc, current) => acc + current, 0) / bucket.length
    })

    const maxIndex = values.indexOf(Math.max(...values))
    const minIndex = values.indexOf(Math.min(...values))

    return {
      labels: names,
      values,
      insights: {
        worstDay: names[maxIndex],
        bestDay: names[minIndex],
        maxValue: values[maxIndex] || 0,
        minValue: values[minIndex] || 0,
      },
    }
  }

  const allValues = data.map((entry) => {
    const value = Number(entry?.stats?.[metric] ?? 0)
    return Number.isFinite(value) ? value : 0
  })

  const total = allValues.reduce((acc, current) => acc + current, 0)
  return {
    labels: ['All time total'],
    values: [total],
    insights: {
      total,
      avgValue: total / Math.max(1, allValues.length),
      maxValue: allValues.length ? Math.max(...allValues) : 0,
      minValue: allValues.length ? Math.min(...allValues) : 0,
      samples: allValues.length,
    },
  }
}

function computeTimelineData(payload) {
  const { metric, timeIndex } = payload || {}
  const data = Array.isArray(timeIndex) ? timeIndex : []
  return {
    labels: data.map((entry) => String(entry?.timestamp || '')),
    values: data.map((entry) => {
      const value = Number(entry?.stats?.[metric] ?? 0)
      return Number.isFinite(value) ? value : 0
    }),
  }
}

function parseCsvRows(csvText) {
  const rows = []
  let currentCell = ''
  let currentRow = []
  let inQuotes = false
  const text = String(csvText || '')

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]

    if (char === '"') {
      if (inQuotes && next === '"') {
        currentCell += '"'
        index += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }

    if (char === ',' && !inQuotes) {
      currentRow.push(currentCell)
      currentCell = ''
      continue
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') {
        index += 1
      }
      currentRow.push(currentCell)
      currentCell = ''
      if (currentRow.some((value) => String(value).trim().length > 0)) {
        rows.push(currentRow)
      }
      currentRow = []
      continue
    }

    currentCell += char
  }

  currentRow.push(currentCell)
  if (currentRow.some((value) => String(value).trim().length > 0)) {
    rows.push(currentRow)
  }

  return rows
}

const IMPORT_TYPE_REFERENCE = 'reference'
const IMPORT_TYPE_KPI = 'kpi'
const IMPORT_TYPE_UNKNOWN = 'unknown'
const AUTO_APPLY_CONFIDENCE = 0.86

const FIELD_ALIASES = {
  cell_name: ['cell_name', 'cellname', 'cell', 'cell id'],
  enodeb_name: ['enodeb_name', 'enodeb', 'site', 'site_name'],
  longitude: ['longitude_sector', 'longitude', 'lon', 'lng'],
  latitude: ['latitude_sector', 'latitude', 'lat'],
  azimuth: ['azimuth', 'bearing'],
  frequency_band: ['frequency_band', 'band', 'freqband'],
  localcell_id: ['localcell_id', 'local_cell_id', 'local cell id', 'localid'],
  cell_fdd_tdd_indication: ['cell_fdd_tdd_indication', 'duplex', 'fdd tdd', 'mode'],
  load: ['ft_physical_resource_blocks_load_dl', 'prb_load', 'load', 'utilization'],
  throughput: [
    'ft_ave_4g_lte_dl_user_thrput_without_last_tti_all___kbps__kbit_',
    'throughput',
    'dl throughput',
    'kbps',
  ],
  cqi: ['ft_4g_lte_average_reported_cqi', 'cqi', 'reported cqi'],
  active_users: [
    'l_traffic_activeuser_dl_avg',
    'active users',
    'dl active users',
  ],
  rrc_users: [
    'ft_average_nb_of_users__ues_rrc_connected',
    'rrc users',
    'ues rrc connected',
    'connected users',
  ],
  traffic: ['ft_4g_lte_dl_traffic_volume__gbytes', 'traffic', 'dl traffic', 'gbytes'],
  ta: ['ot_average_ta', 'timing advance', 'ta'],
  signal_power: ['referencesignalpwr', 'signal power', 'rsrp'],
  congested: ['congested', 'is_congested', 'congestion_flag', 'alarm_congestion'],
  severity: ['severity', 'alarm_severity', 'priority'],
  issue_type: ['issue_type', 'issue', 'problem_type'],
  root_cause: ['root_cause', 'rootcause', 'cause'],
  health_score: ['health_score', 'health', 'healthscore'],
  timestamp: ['timestamp', 'datetime', 'date_time', 'date time'],
  date: ['date', 'jour', 'day'],
  time: ['time', 'heure', 'hour'],
}

function tokenizeHeader(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter(Boolean)
}

function scoreTokenCoverage(headerTokens, aliasTokens) {
  if (!headerTokens.length || !aliasTokens.length) return 0

  let hitScore = 0
  aliasTokens.forEach((aliasToken) => {
    if (!aliasToken) return

    const exact = headerTokens.includes(aliasToken)
    if (exact) {
      hitScore += 1
      return
    }

    if (aliasToken.length < 4) {
      return
    }

    const partial = headerTokens.some((headerToken) => {
      if (!headerToken || headerToken.length < 3) return false
      return headerToken.includes(aliasToken) || aliasToken.includes(headerToken)
    })

    if (partial) {
      hitScore += 0.65
    }
  })

  return Math.min(1, hitScore / aliasTokens.length)
}

function scoreAliasMatch(headerRaw, aliasRaw) {
  const headerNormalized = normalizeText(headerRaw)
  const aliasNormalized = normalizeText(aliasRaw)
  if (!headerNormalized || !aliasNormalized) return 0
  if (headerNormalized === aliasNormalized) return 1

  const headerTokens = tokenizeHeader(headerRaw)
  const aliasTokens = tokenizeHeader(aliasRaw)
  const tokenCoverage = scoreTokenCoverage(headerTokens, aliasTokens)

  let score = tokenCoverage * 0.82

  if (aliasNormalized.length >= 5 && headerNormalized.includes(aliasNormalized)) {
    const ratio = aliasNormalized.length / Math.max(aliasNormalized.length, headerNormalized.length)
    score = Math.max(score, 0.82 + ratio * 0.12)
  }

  if (headerNormalized.length >= 5 && aliasNormalized.includes(headerNormalized)) {
    const ratio = headerNormalized.length / Math.max(aliasNormalized.length, headerNormalized.length)
    score = Math.max(score, 0.66 + ratio * 0.12)
  }

  const lengthSimilarity =
    Math.min(headerNormalized.length, aliasNormalized.length) /
    Math.max(headerNormalized.length, aliasNormalized.length)
  score = Math.max(score, tokenCoverage * 0.62 + lengthSimilarity * 0.18)

  return Math.min(1, score)
}

function applyFieldPenalty(fieldKey, headerNormalized, baseScore) {
  let score = baseScore
  if (!Number.isFinite(score) || score <= 0) return 0

  if (
    (headerNormalized === 'date' || headerNormalized === 'time') &&
    fieldKey !== 'date' &&
    fieldKey !== 'time' &&
    fieldKey !== 'timestamp'
  ) {
    score *= 0.2
  }

  if (fieldKey === 'longitude' && headerNormalized.includes('latitude')) {
    score *= 0.2
  }
  if (fieldKey === 'latitude' && headerNormalized.includes('longitude')) {
    score *= 0.2
  }

  if (fieldKey === 'ta') {
    const taLike =
      headerNormalized.includes('ta') ||
      headerNormalized.includes('timingadvance') ||
      headerNormalized.includes('average')
    if (!taLike) {
      score *= 0.45
    }
  }

  if (fieldKey === 'traffic' && !headerNormalized.includes('traffic') && !headerNormalized.includes('gbytes')) {
    score *= 0.35
  }

  if (fieldKey === 'cqi' && !headerNormalized.includes('cqi')) {
    score *= 0.3
  }

  if (fieldKey === 'active_users') {
    if (headerNormalized.includes('ltrafficactiveuserdlavg')) {
      score = Math.min(1, score + 0.05)
    }
    if (headerNormalized.includes('uesrrcconnected')) {
      score *= 0.45
    }
  }

  if (fieldKey === 'rrc_users') {
    if (headerNormalized.includes('uesrrcconnected')) {
      score = Math.min(1, score + 0.08)
    }
    if (headerNormalized.includes('ltrafficactiveuserdlavg')) {
      score *= 0.5
    }
  }

  return Math.max(0, Math.min(1, score))
}

function scoreFieldToHeader(fieldKey, headerRaw) {
  const aliases = FIELD_ALIASES[fieldKey] || []
  const headerNormalized = normalizeText(headerRaw)

  let best = 0
  aliases.forEach((alias) => {
    const aliasScore = scoreAliasMatch(headerRaw, alias)
    if (aliasScore > best) {
      best = aliasScore
    }
  })

  return applyFieldPenalty(fieldKey, headerNormalized, best)
}

function detectImportType(headers) {
  const normalizedHeaders = new Set((headers || []).map((header) => normalizeText(header)).filter(Boolean))
  const detectionReasons = []

  const hasLongitudeSector = normalizedHeaders.has('longitudesector')
  const hasLatitudeSector = normalizedHeaders.has('latitudesector')
  const hasTime = normalizedHeaders.has('time')
  const hasTimestamp = normalizedHeaders.has('timestamp') || normalizedHeaders.has('datetime')
  const hasTrafficVolume = normalizedHeaders.has('ft4gltedltrafficvolumegbytes')

  if (hasLongitudeSector || hasLatitudeSector) {
    if (hasLongitudeSector) detectionReasons.push('Found longitude_sector header')
    if (hasLatitudeSector) detectionReasons.push('Found latitude_sector header')
    return {
      detectedType: IMPORT_TYPE_REFERENCE,
      detectionReasons,
    }
  }

  if ((hasTime || hasTimestamp) && hasTrafficVolume) {
    detectionReasons.push(hasTimestamp ? 'Found timestamp header' : 'Found time header')
    detectionReasons.push('Found ft_4g_lte_dl_traffic_volume__gbytes header')
    return {
      detectedType: IMPORT_TYPE_KPI,
      detectionReasons,
    }
  }

  if (hasTime) {
    detectionReasons.push('Found time header (partial KPI signal)')
  }
  if (hasTimestamp) {
    detectionReasons.push('Found timestamp header (partial KPI signal)')
  }
  if (hasTrafficVolume) {
    detectionReasons.push('Found KPI traffic volume header (partial KPI signal)')
  }

  if (!detectionReasons.length) {
    detectionReasons.push('No strong type markers detected')
  }

  return {
    detectedType: IMPORT_TYPE_UNKNOWN,
    detectionReasons,
  }
}

function inferMapping(headers) {
  const scoreTable = {}
  Object.keys(FIELD_ALIASES).forEach((fieldKey) => {
    scoreTable[fieldKey] = {}
    headers.forEach((header) => {
      scoreTable[fieldKey][header] = Number(scoreFieldToHeader(fieldKey, header).toFixed(4))
    })
  })

  const mapping = {}
  const usedHeaders = new Set()

  const fieldOrder = Object.keys(FIELD_ALIASES)
    .map((fieldKey) => {
      const best = headers.reduce((maxScore, header) => Math.max(maxScore, scoreTable[fieldKey][header] || 0), 0)
      return { fieldKey, best }
    })
    .sort((left, right) => right.best - left.best)

  fieldOrder.forEach(({ fieldKey }) => {
    const rankedHeaders = headers
      .map((header) => ({ header, score: scoreTable[fieldKey][header] || 0 }))
      .sort((left, right) => right.score - left.score)

    const candidate = rankedHeaders.find(
      (entry) => entry.score >= AUTO_APPLY_CONFIDENCE && !usedHeaders.has(entry.header)
    )
    if (!candidate) return

    mapping[fieldKey] = candidate.header
    usedHeaders.add(candidate.header)
  })

  return {
    inferredMapping: mapping,
    matchScores: scoreTable,
  }
}

function parseCsvPreview(payload) {
  const { csvText = '', maxPreviewRows = 15 } = payload || {}
  const rows = parseCsvRows(csvText)
  if (!rows.length) {
    return {
      headers: [],
      previewRows: [],
      totalRows: 0,
      inferredMapping: {},
    }
  }

  const headers = rows[0].map((value, index) => {
    const text = String(value || '').trim()
    return text || `column_${index + 1}`
  })

  const bodyRows = rows.slice(1)
  const previewRows = bodyRows.slice(0, maxPreviewRows).map((row) => {
    const record = {}
    headers.forEach((header, index) => {
      record[header] = String(row[index] || '').trim()
    })
    return record
  })

  const inferred = inferMapping(headers)
  const detected = detectImportType(headers)

  return {
    headers,
    previewRows,
    totalRows: bodyRows.length,
    inferredMapping: inferred.inferredMapping,
    matchScores: inferred.matchScores,
    detectedType: detected.detectedType,
    detectionReasons: detected.detectionReasons,
    allRows: bodyRows.map((row) => {
      const record = {}
      headers.forEach((header, index) => {
        record[header] = String(row[index] || '').trim()
      })
      return record
    }),
  }
}

function estimateTrafficLoss(activeUsers, load, throughput, congested) {
  if (!congested) {
    return {
      trafficLossUe: 0,
      trafficLossGb: 0,
      throughputGap: 0,
    }
  }

  const safeThroughput = Number.isFinite(throughput) ? throughput : ORANGE_CONGESTION_CONFIG.THROUGHPUT_DEGRADED
  const throughputGap = Math.max(0, ORANGE_CONGESTION_CONFIG.THROUGHPUT_DEGRADED - safeThroughput)
  const trafficLossUe = ORANGE_CONGESTION_CONFIG.LOST_UE_BASELINE
  const trafficLossGb = ORANGE_CONGESTION_CONFIG.LOST_GB_BASELINE

  return {
    trafficLossUe,
    trafficLossGb,
    throughputGap,
  }
}

function classifyRow(metrics = {}, explicitFields = {}, options = {}) {
  const strictNoFallback = Boolean(options?.strictNoFallback)

  const loadValue = toFiniteNumber(metrics?.load)
  const throughputValue = toFiniteNumber(metrics?.throughput)
  const cqiValue = toFiniteNumber(metrics?.cqi)
  const activeUsersValue = toFiniteNumber(metrics?.active_users)
  const rrcUsersValue = toFiniteNumber(metrics?.rrc_users)

  const load = loadValue !== null ? loadValue : 0
  const throughput = throughputValue !== null ? throughputValue : ORANGE_CONGESTION_CONFIG.THROUGHPUT_DEGRADED
  const cqi = cqiValue !== null ? cqiValue : 10
  const activeUsers = activeUsersValue !== null ? activeUsersValue : 0
  const rrcUsers = rrcUsersValue !== null ? rrcUsersValue : activeUsers

  const explicitCongested = toBooleanLike(explicitFields?.congested)
  const explicitSeverityRaw = toFiniteNumber(explicitFields?.severity)
  const explicitSeverity = explicitSeverityRaw !== null ? Math.max(0, Math.min(100, explicitSeverityRaw)) : null
  const explicitIssueType = String(explicitFields?.issue_type || '').trim()
  const explicitRootCause = String(explicitFields?.root_cause || '').trim()
  const explicitHealthRaw = toFiniteNumber(explicitFields?.health_score)
  const explicitHealth = explicitHealthRaw !== null ? Math.max(0, Math.min(100, explicitHealthRaw)) : null

  if (strictNoFallback) {
    const congested = explicitCongested === true
    const severity = explicitSeverity ?? (congested ? 75 : 0)
    const issueType = explicitIssueType || (congested ? 'Congestion Confirmed' : 'Normal')
    const rootCause = explicitRootCause || (congested ? 'Capacity saturation' : 'Normal')
    const healthScore = explicitHealth ?? Math.max(0, 100 - severity)
    const trafficLoss = estimateTrafficLoss(activeUsers, load, throughput, congested)

    return {
      congestion: congested,
      severity,
      issueType,
      rootCause,
      healthScore,
      trafficLossUe: trafficLoss.trafficLossUe,
      trafficLossGb: trafficLoss.trafficLossGb,
      source: explicitCongested === null ? 'missing_explicit' : 'explicit',
    }
  }

  const prbSaturated = load > ORANGE_CONGESTION_CONFIG.PRB_SATURATED
  const throughputDegraded = throughput < ORANGE_CONGESTION_CONFIG.THROUGHPUT_DEGRADED
  const activeQueueCritical = activeUsers > ORANGE_CONGESTION_CONFIG.ACTIVE_USERS_CRITICAL
  const rrcQueueSignal = rrcUsers > ORANGE_CONGESTION_CONFIG.RRC_USERS_CRITICAL
  const cqiPoor = cqi < ORANGE_CONGESTION_CONFIG.CQI_POOR

  const congested = prbSaturated && (throughputDegraded || activeQueueCritical || cqiPoor)

  const issues = []
  if (prbSaturated) issues.push('PRB load above 90%')
  if (throughputDegraded) issues.push('throughput below 4000 kbps')
  if (activeQueueCritical) issues.push('active users above 4')
  if (rrcQueueSignal) issues.push('RRC users above 4')
  if (cqiPoor) issues.push('CQI below 8')

  let severity = 0
  if (prbSaturated) severity += 45
  if (throughputDegraded) severity += 20
  if (activeQueueCritical || rrcQueueSignal) severity += 20
  if (cqiPoor) severity += 15
  if (!congested) severity = Math.min(severity, 49)

  const issueType = congested ? 'Congestion Confirmed' : issues.length ? 'Threshold Warning' : 'Normal'
  const rootCause = issues.length ? issues.join('; ') : 'Normal'

  const healthScore = Math.max(0, 100 - severity)
  const trafficLoss = estimateTrafficLoss(activeUsers, load, throughput, congested)

  return {
    congestion: congested,
    severity,
    issueType,
    rootCause,
    healthScore,
    trafficLossUe: trafficLoss.trafficLossUe,
    trafficLossGb: trafficLoss.trafficLossGb,
    source: 'heuristic_orange',
  }
}

function deriveSiteNameFromCell(cellName) {
  const parsed = parseCellName(cellName)
  return parsed.siteName || String(cellName || '').trim()
}

function buildBaselineLookup(existingBaseline = {}) {
  const byJoin = new Map()
  const byCellName = new Map()

  Object.entries(existingBaseline || {}).forEach(([cellName, baselineCell]) => {
    const normalizedCell = normalizeText(cellName)
    const normalizedLocal = normalizeText(baselineCell?.localcell_id)
    if (normalizedCell && !byCellName.has(normalizedCell)) {
      byCellName.set(normalizedCell, cellName)
    }
    if (normalizedCell && normalizedLocal) {
      byJoin.set(`${normalizedCell}::${normalizedLocal}`, cellName)
    }
  })

  return { byJoin, byCellName }
}

function resolveKpiCellName(cellName, localCellId, lookup) {
  const normalizedCell = normalizeText(cellName)
  const normalizedLocal = normalizeText(localCellId)

  if (normalizedCell && normalizedLocal) {
    const joinedKey = `${normalizedCell}::${normalizedLocal}`
    const joinedMatch = lookup.byJoin.get(joinedKey)
    if (joinedMatch) {
      return joinedMatch
    }
  }

  if (normalizedCell) {
    const cellOnly = lookup.byCellName.get(normalizedCell)
    if (cellOnly) {
      return cellOnly
    }
  }

  return String(cellName || '').trim()
}

function findHeaderByNormalizedName(rows, expectedName) {
  const firstRow = Array.isArray(rows) && rows.length ? rows[0] : null
  if (!firstRow || typeof firstRow !== 'object') return ''

  const header = Object.keys(firstRow).find((key) => normalizeText(key) === normalizeText(expectedName))
  return header || ''
}

function buildRowTimestamp(row, timestampHeader, dateHeader, timeHeader) {
  const rawTimestamp = timestampHeader ? String(row?.[timestampHeader] || '').trim() : ''
  if (rawTimestamp) {
    return rawTimestamp
  }

  const datePart = dateHeader ? String(row?.[dateHeader] || '').trim() : ''
  const timePart = timeHeader ? String(row?.[timeHeader] || '').trim() : ''
  if (datePart && timePart) {
    return `${datePart} ${timePart}`
  }

  return ''
}

function computeObservationStats(observations, baseline = {}) {
  const rows = Object.values(observations || {})
  const loads = rows
    .map((obs) => toFiniteNumber(obs?.load))
    .filter((value) => value !== null)
  const cqis = rows
    .map((obs) => toFiniteNumber(obs?.cqi))
    .filter((value) => value !== null)
  const throughputs = rows
    .map((obs) => toFiniteNumber(obs?.throughput))
    .filter((value) => value !== null)
  const congested = rows.filter((obs) => obs?.congested).length
  const cellsObserved = Object.keys(observations || {}).length

  return {
    cells_observed: cellsObserved,
    total_cells: Object.keys(baseline || {}).length,
    congested,
    congestion_rate: cellsObserved ? Number(((congested / cellsObserved) * 100).toFixed(2)) : 0,
    avg_load: loads.length ? Number((loads.reduce((acc, current) => acc + current, 0) / loads.length).toFixed(2)) : 0,
    max_load: loads.length ? Number(Math.max(...loads).toFixed(2)) : 0,
    avg_throughput: throughputs.length
      ? Number((throughputs.reduce((acc, current) => acc + current, 0) / throughputs.length).toFixed(2))
      : 0,
    avg_cqi: cqis.length ? Number((cqis.reduce((acc, current) => acc + current, 0) / cqis.length).toFixed(2)) : 0,
    avg_health: cellsObserved
      ? Number((rows.reduce((acc, obs) => acc + Number(obs?.health_score || 0), 0) / cellsObserved).toFixed(2))
      : 0,
  }
}

function applyCsvMapping(payload) {
  const {
    rows = [],
    mapping = {},
    importType = IMPORT_TYPE_REFERENCE,
    existingBaseline = {},
    realismPolicy = {},
  } = payload || {}

  const normalizedImportType = importType === IMPORT_TYPE_KPI ? IMPORT_TYPE_KPI : IMPORT_TYPE_REFERENCE
  const strictScopeToReference =
    normalizedImportType === IMPORT_TYPE_KPI && Boolean(realismPolicy?.strictScopeToReference)
  const strictNoFallback =
    normalizedImportType === IMPORT_TYPE_KPI && Boolean(realismPolicy?.strictNoFallback)
  const effectiveStrictNoFallback = strictNoFallback && Boolean(mapping?.congested)

  const baseline = normalizedImportType === IMPORT_TYPE_KPI ? { ...(existingBaseline || {}) } : {}
  const observations = {}
  const errors = []
  const warnings = []
  const baselineLookup = buildBaselineLookup(existingBaseline)
  const observationsByTimestamp = new Map()
  const timestampHeader =
    normalizedImportType === IMPORT_TYPE_KPI
      ? String(mapping.timestamp || findHeaderByNormalizedName(rows, 'timestamp') || '').trim()
      : ''
  const dateHeader =
    normalizedImportType === IMPORT_TYPE_KPI
      ? String(mapping.date || findHeaderByNormalizedName(rows, 'date') || '').trim()
      : ''
  const timeHeader =
    normalizedImportType === IMPORT_TYPE_KPI
      ? String(mapping.time || findHeaderByNormalizedName(rows, 'time') || '').trim()
      : ''
  const canonicalActiveUsersHeader =
    normalizedImportType === IMPORT_TYPE_KPI
      ? String(findHeaderByNormalizedName(rows, 'l_traffic_activeuser_dl_avg') || '').trim()
      : ''
  const canonicalRrcUsersHeader =
    normalizedImportType === IMPORT_TYPE_KPI
      ? String(findHeaderByNormalizedName(rows, 'ft_average_nb_of_users__ues_rrc_connected') || '').trim()
      : ''
  const mappedActiveUsersHeader =
    normalizedImportType === IMPORT_TYPE_KPI ? String(mapping.active_users || '').trim() : ''
  const mappedRrcUsersHeader =
    normalizedImportType === IMPORT_TYPE_KPI ? String(mapping.rrc_users || '').trim() : ''
  const activeUsersHeaderMismatch =
    normalizedImportType === IMPORT_TYPE_KPI &&
    Boolean(canonicalActiveUsersHeader) &&
    Boolean(mappedActiveUsersHeader) &&
    normalizeText(canonicalActiveUsersHeader) !== normalizeText(mappedActiveUsersHeader)
  const rrcUsersHeaderMismatch =
    normalizedImportType === IMPORT_TYPE_KPI &&
    Boolean(canonicalRrcUsersHeader) &&
    Boolean(mappedRrcUsersHeader) &&
    normalizeText(canonicalRrcUsersHeader) !== normalizeText(mappedRrcUsersHeader)
  const hasTimestampMapping =
    normalizedImportType !== IMPORT_TYPE_KPI || Boolean(timestampHeader) || (Boolean(dateHeader) && Boolean(timeHeader))
  let unmatchedKpiRows = 0
  let droppedRowsByScope = 0
  let rowsWithTa = 0
  let rowsWithoutTa = 0
  let rowsMissingTimestamp = 0
  let rowsInvalidTimestamp = 0
  let rowsWithExplicitCongestion = 0
  let rowsWithoutExplicitCongestion = 0
  let rowsProcessed = 0
  let rowsFilteredZeroTraffic = 0

  rows.forEach((row, rowIndex) => {
    const rawCellName = String(row?.[mapping.cell_name] || '').trim()
    if (!rawCellName) {
      errors.push({
        row: rowIndex + 2,
        reason: 'Missing required mapped field (cell_name)',
      })
      return
    }

    const rawLocalCellId = String(row?.[mapping.localcell_id] || '').trim()
    let targetCellName = rawCellName

    if (normalizedImportType === IMPORT_TYPE_REFERENCE) {
      const longitude = toFiniteNumber(row?.[mapping.longitude])
      const latitude = toFiniteNumber(row?.[mapping.latitude])
      if (longitude === null || latitude === null) {
        errors.push({
          row: rowIndex + 2,
          reason: 'Missing required mapped fields for Reference Data (longitude, latitude)',
        })
        return
      }

      const siteName = String(row?.[mapping.enodeb_name] || deriveSiteNameFromCell(targetCellName)).trim()
      const azimuth = toFiniteNumber(row?.[mapping.azimuth]) ?? 0
      const frequencyBand = toFiniteNumber(row?.[mapping.frequency_band]) ?? 0
      const localCellId = rawLocalCellId || String(rowIndex + 1)
      const duplex = String(row?.[mapping.cell_fdd_tdd_indication] || 'FDD').trim() || 'FDD'

      baseline[targetCellName] = {
        enodeb_name: siteName,
        longitude,
        latitude,
        azimuth,
        frequency_band: frequencyBand,
        localcell_id: localCellId,
        cell_fdd_tdd_indication: duplex,
      }
    } else {
      targetCellName = resolveKpiCellName(rawCellName, rawLocalCellId, baselineLookup)
      if (!baseline[targetCellName]) {
        unmatchedKpiRows += 1
        if (strictScopeToReference) {
          droppedRowsByScope += 1
          return
        }
      }
    }

    let rowTimestamp = ''
    if (normalizedImportType === IMPORT_TYPE_KPI) {
      if (!hasTimestampMapping) {
        rowsMissingTimestamp += 1
        return
      }

      const rawRowTimestamp = buildRowTimestamp(row, timestampHeader, dateHeader, timeHeader)
      if (!rawRowTimestamp) {
        rowsMissingTimestamp += 1
        return
      }

      const parsedTimestamp = parseTimestamp(rawRowTimestamp)
      if (!isValidDate(parsedTimestamp)) {
        rowsInvalidTimestamp += 1
        return
      }

      rowTimestamp = formatTimestampFromDate(parsedTimestamp)
    }

    const load = toFiniteNumber(row?.[mapping.load])
    const throughput = toFiniteNumber(row?.[mapping.throughput])
    const cqi = toFiniteNumber(row?.[mapping.cqi])
    const mappedActiveUsers = toFiniteNumber(row?.[mapping.active_users])
    const canonicalActiveUsers = canonicalActiveUsersHeader ? toFiniteNumber(row?.[canonicalActiveUsersHeader]) : null
    const mappedRrcUsers = toFiniteNumber(row?.[mapping.rrc_users])
    const canonicalRrcUsers = canonicalRrcUsersHeader ? toFiniteNumber(row?.[canonicalRrcUsersHeader]) : null
    const activeUsers = canonicalActiveUsers !== null ? canonicalActiveUsers : mappedActiveUsers
    const rrcUsers = canonicalRrcUsers !== null ? canonicalRrcUsers : mappedRrcUsers
    const traffic = toFiniteNumber(row?.[mapping.traffic])
    const ta = toFiniteNumber(row?.[mapping.ta])
    const signalPower = toFiniteNumber(row?.[mapping.signal_power])
    const explicitCongested = mapping.congested ? row?.[mapping.congested] : null
    const parsedExplicitCongested = toBooleanLike(explicitCongested)
    const explicitFields = {
      congested: explicitCongested,
      severity: mapping.severity ? row?.[mapping.severity] : null,
      issue_type: mapping.issue_type ? row?.[mapping.issue_type] : null,
      root_cause: mapping.root_cause ? row?.[mapping.root_cause] : null,
      health_score: mapping.health_score ? row?.[mapping.health_score] : null,
    }

    if (normalizedImportType === IMPORT_TYPE_KPI) {
      if (ta !== null) rowsWithTa += 1
      else rowsWithoutTa += 1
      if (parsedExplicitCongested === null) rowsWithoutExplicitCongestion += 1
      else rowsWithExplicitCongestion += 1
    }

    const isZeroTrafficRow = [load, throughput, cqi, activeUsers, rrcUsers, traffic]
      .every((value) => value === null || Number(value) <= 0)
    if (isZeroTrafficRow) {
      rowsFilteredZeroTraffic += 1
      return
    }

    const classification = classifyRow(
      {
        load,
        throughput,
        cqi,
        active_users: activeUsers,
        rrc_users: rrcUsers,
      },
      explicitFields,
      {
        strictNoFallback: effectiveStrictNoFallback,
      }
    )

    rowsProcessed += 1

    const mappedObservation = {
      load,
      throughput,
      cqi,
      active_users: activeUsers,
      rrc_users: rrcUsers,
      traffic,
      ta,
      signal_power: signalPower,
      dynamic_radius_supported: ta !== null,
      congested: classification.congestion,
      severity: classification.severity,
      issue_type: classification.issueType,
      root_cause: classification.rootCause,
      health_score: classification.healthScore,
      traffic_loss_ue: classification.trafficLossUe,
      traffic_loss_gb: classification.trafficLossGb,
    }

    observations[targetCellName] = mappedObservation

    if (normalizedImportType === IMPORT_TYPE_KPI) {
      const existingSlice = observationsByTimestamp.get(rowTimestamp) || {}
      existingSlice[targetCellName] = mappedObservation
      observationsByTimestamp.set(rowTimestamp, existingSlice)
    }
  })

  if (normalizedImportType === IMPORT_TYPE_KPI) {
    if (!Object.keys(existingBaseline || {}).length) {
      warnings.push(
        'KPI Hourly Data imported without Reference Data. Cells will not appear on the map until Reference Data is imported.'
      )
    }

    if (unmatchedKpiRows > 0) {
      warnings.push(`${unmatchedKpiRows} KPI rows did not match existing Reference Data by cell_name/localcell_id.`)
    }

    if (!hasTimestampMapping) {
      warnings.push('KPI import requires timestamp mapping (timestamp or date + time). No KPI rows were loaded.')
    }

    if (rowsMissingTimestamp > 0) {
      warnings.push(`${rowsMissingTimestamp} KPI rows were skipped because timestamp values were missing.`)
    }

    if (rowsInvalidTimestamp > 0) {
      warnings.push(`${rowsInvalidTimestamp} KPI rows were skipped because timestamp values were invalid.`)
    }

    if (activeUsersHeaderMismatch) {
      warnings.push(
        `Active Users congestion rule used "${canonicalActiveUsersHeader}" (Orange queue KPI) instead of mapped "${mappedActiveUsersHeader}".`
      )
    }

    if (rrcUsersHeaderMismatch) {
      warnings.push(
        `RRC Users congestion rule used "${canonicalRrcUsersHeader}" instead of mapped "${mappedRrcUsersHeader}".`
      )
    }

    if (rowsFilteredZeroTraffic > 0) {
      warnings.push(`${rowsFilteredZeroTraffic} KPI rows were filtered because all traffic KPIs were empty or zero.`)
    }

    if (strictScopeToReference && droppedRowsByScope > 0) {
      warnings.push(
        `${droppedRowsByScope} KPI rows were dropped because they did not match active Reference Data (strict scope enabled).`
      )
    }

    if (effectiveStrictNoFallback && rowsWithoutExplicitCongestion > 0) {
      warnings.push(
        `${rowsWithoutExplicitCongestion} KPI rows had no explicit congestion label; strict mode treated them as non-congested.`
      )
    }

    if (strictNoFallback && !mapping.congested) {
      warnings.push('Strict mode was requested but no Congestion Flag mapping was provided. Heuristic mode was used instead.')
    }

    if (!mapping.ta) {
      warnings.push('Timing Advance (TA) is not mapped. Sector radius will remain static across timestamps.')
    } else if (rowsWithoutTa > 0 && rowsWithTa === 0) {
      warnings.push('No valid Timing Advance (TA) values were parsed. Sector radius will remain static; check TA column formatting.')
    }

    if (!observationsByTimestamp.size) {
      warnings.push('No valid KPI timestamps were imported. Timeline was not updated.')
    }
  }

  const stats = computeObservationStats(observations, baseline)

  const slices = Array.from(observationsByTimestamp.entries())
    .map(([timestamp, sliceObservations]) => {
      return {
        timestamp,
        observations: sliceObservations,
        stats: computeObservationStats(sliceObservations, baseline),
        import_type: normalizedImportType,
      }
    })
    .sort((left, right) => parseTimestamp(left.timestamp) - parseTimestamp(right.timestamp))

  const effectiveSlices =
    normalizedImportType === IMPORT_TYPE_REFERENCE
      ? slices.length
        ? slices
        : [
            {
              timestamp: 'Reference import snapshot',
              observations,
              stats,
              import_type: normalizedImportType,
            },
          ]
      : slices

  const latestSlice = effectiveSlices.length ? effectiveSlices[effectiveSlices.length - 1] : null
  const latestObservations = latestSlice?.observations || (normalizedImportType === IMPORT_TYPE_REFERENCE ? observations : {})
  const latestStats = latestSlice?.stats || computeObservationStats(latestObservations, baseline)

  const importedCells = normalizedImportType === IMPORT_TYPE_KPI
    ? Object.keys(latestObservations).length
    : Object.keys(baseline).length
  const responseTimestamp = latestSlice?.timestamp || ''

  return {
    baseline,
    observations: latestObservations,
    stats: latestStats,
    slices: effectiveSlices,
    errors,
    warnings,
    imported_cells: importedCells,
    timestamp: responseTimestamp,
    import_type: normalizedImportType,
    data_quality:
      normalizedImportType === IMPORT_TYPE_KPI
        ? {
            rows_total: rows.length,
            rows_processed: rowsProcessed,
            rows_unmatched_reference: unmatchedKpiRows,
            rows_dropped_by_scope: droppedRowsByScope,
            rows_with_ta: rowsWithTa,
            rows_without_ta: rowsWithoutTa,
            rows_missing_timestamp: rowsMissingTimestamp,
            rows_invalid_timestamp: rowsInvalidTimestamp,
            timestamp_mapping_available: hasTimestampMapping,
            rows_with_explicit_congestion: rowsWithExplicitCongestion,
            rows_without_explicit_congestion: rowsWithoutExplicitCongestion,
            rows_filtered_zero_traffic: rowsFilteredZeroTraffic,
            scope_to_reference_enforced: strictScopeToReference,
            strict_no_fallback: effectiveStrictNoFallback,
          }
        : null,
  }
}

const actions = {
  buildSiteHierarchy,
  buildFeatureUpdates,
  computeExploreData,
  computeTimelineData,
  parseCsvPreview,
  applyCsvMapping,
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = (event) => {
    const { id, action, payload } = event.data || {}
    const handler = actions[action]
    if (!handler) {
      self.postMessage({ id, ok: false, error: `Unknown worker action: ${String(action)}` })
      return
    }

    try {
      const data = handler(payload)
      self.postMessage({ id, ok: true, data })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      self.postMessage({ id, ok: false, error: message })
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    createStrictDate,
    parseTimestamp,
    isValidDate,
    formatTimestampFromDate,
    classifyRow,
    buildFeatureUpdates,
    applyCsvMapping,
  }
}
