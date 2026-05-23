import { useMemo, useState, useEffect, useRef, useCallback } from 'react'
import TopHeader from './components/dashboard/TopHeader'
import Breadcrumb from './components/dashboard/Breadcrumb'
import CockpitRail from './components/dashboard/CockpitRail'
import TimelineBar from './components/dashboard/TimelineBar'
import TunisiaMap from './components/admin-map/TunisiaMap'
import CockpitPanel from './components/panels/CockpitPanel'
import { initialAdminScope, backToNational, backToGovernorate, backToDelegation } from './admin/adminScope'
import { fetchJson, loadDashboardData } from './admin/adminData'
import { aggregateNationalScope, aggregateGovernorateScope, aggregateDelegationScope, buildCells, rankDelegations, rankGovernorates, METRIC_MODES, classifyRanIssue, computeDataQuality, computeSliceDelta, buildWhyCritical, buildAnalyticalReport } from './admin/adminAggregation'
import { buildSearchIndex, searchAdmin } from './admin/adminSearch'
import { transitionLabel } from './admin/adminTransitions'
import { DEFAULT_FILTERS, applyCellFilters, buildSiteSummaries, summarizeAlerts, COCKPIT_TABS, ADMIN_COCKPIT_TABS } from './admin/adminOps'
import { buildAutoMapping, callImportWorker } from './admin/importWorker'
import { DEFAULT_MAP_CONTROLS } from './utils/v2Contracts.mjs'
import { isAdminToolsEnabled } from './utils/uiPolicy.mjs'

export default function NetVisionDashboard() {
  const [data, setData] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [scope, setScope] = useState(initialAdminScope)
  const [metricMode, setMetricMode] = useState('congestion_rate')
  const [focusMode, setFocusMode] = useState(false)
  const [query, setQuery] = useState('')
  const [activeTab, setActiveTab] = useState('overview')
  const [filters, setFilters] = useState(DEFAULT_FILTERS)
  const [mapControls, setMapControls] = useState(DEFAULT_MAP_CONTROLS)
  const [timeIndex, setTimeIndex] = useState(0)
  const [peakRows, setPeakRows] = useState([])
  const [peakPayload, setPeakPayload] = useState({ available: false, rows: [], summary: null, reason: '' })
  const [busyMetric, setBusyMetric] = useState('congestion_rate')
  const [backendHealth, setBackendHealth] = useState(null)
  const [workerState, setWorkerState] = useState('ready')
  const [theme, setTheme] = useState('light')
  const [importState, setImportState] = useState({ status: 'idle', fileName: '', importType: 'reference', preview: null, result: null, error: '' })
  const [endpointStatus, setEndpointStatus] = useState({})
  const [dataMode, setDataMode] = useState('real')
  const [previousObservations, setPreviousObservations] = useState({})
  const [delegationVariationRows, setDelegationVariationRows] = useState([])
  const [demoStep, setDemoStep] = useState(null)
  const [timelinePlayback, setTimelinePlayback] = useState({ isPlaying: false, speedMs: 1500, startMode: 'current' })
  const timeIndexRef = useRef(0)
  const timeIndexEntriesRef = useRef([])
  const loadingSliceRef = useRef(false)
  const pendingSliceIndexRef = useRef(null)
  const sliceCacheRef = useRef(new Map())
  const adminToolsEnabled = isAdminToolsEnabled()
  const visibleTabs = useMemo(() => adminToolsEnabled ? [...COCKPIT_TABS, ...ADMIN_COCKPIT_TABS] : COCKPIT_TABS, [adminToolsEnabled])

  useEffect(() => {
    if (!adminToolsEnabled && ['analytics', 'data', 'system'].includes(activeTab)) setActiveTab('overview')
  }, [adminToolsEnabled, activeTab])

  useEffect(() => {
    let cancelled = false
    fetchJson('/api/data-mode').then((payload) => !cancelled && setDataMode(payload.mode || 'real')).catch(() => {})
    loadDashboardData().then((payload) => { if (!cancelled) setData(payload) }).catch((err) => { if (!cancelled) setLoadError(err.message || String(err)) })
    fetchJson('/api/peak-hours').then((payload) => !cancelled && setPeakRows(payload.rows || [])).catch(() => !cancelled && setPeakRows([]))
    fetchJson('/api/backend-health').then((payload) => !cancelled && setBackendHealth(payload)).catch(() => !cancelled && setBackendHealth({ status: 'unavailable' }))
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    async function probeEndpoints() {
      async function check(name, url) {
        try {
          const res = await fetch(url, { cache: 'no-store' })
          const payload = await res.json().catch(() => ({}))
          const reachable = res.ok
          const degraded = payload?.available === false || payload?.ready === false
          return [name, { wired: true, reachable, degraded, detail: payload?.detail || payload?.reason || payload?.error || '' }]
        } catch (err) {
          return [name, { wired: true, reachable: false, degraded: true, detail: err.message || String(err) }]
        }
      }
      const coreChecks = [
        check('data', '/api/data/stats.json'),
        check('peakHours', '/api/peak-hours'),
        check('backend', '/api/backend-health'),
      ]
      const optionalChecks = [
        check('jobsHealth', '/api/jobs-health'),
      ]
      const pairs = await Promise.all([...coreChecks, ...optionalChecks])
      if (!cancelled) {
        const next = Object.fromEntries(pairs)
        setEndpointStatus(next)
        setWorkerState(next.jobsHealth?.reachable && !next.jobsHealth?.degraded ? 'ready' : (next.jobsHealth?.detail || 'unavailable'))
      }
    }
    probeEndpoints()
    const timer = window.setInterval(probeEndpoints, 15000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [activeTab])

  useEffect(() => { timeIndexRef.current = timeIndex }, [timeIndex])
  useEffect(() => { timeIndexEntriesRef.current = data?.timeIndex || [] }, [data?.timeIndex])

  useEffect(() => {
    const entries = data?.timeIndex || []
    if (!entries.length) return undefined
    let cancelled = false
    entries.slice(0, 16).forEach((entry) => {
      if (!entry?.filename || sliceCacheRef.current.has(entry.filename)) return
      fetchJson(`/api/data/time_data/${encodeURIComponent(entry.filename)}`)
        .then((slice) => { if (!cancelled) sliceCacheRef.current.set(entry.filename, slice) })
        .catch(() => {})
    })
    return () => { cancelled = true }
  }, [data?.timeIndex])

  useEffect(() => {
    if (!data) return
    let cancelled = false
    const params = new URLSearchParams({ metric: busyMetric, limit: '80' })
    if (scope.level === 'national') params.set('group_by', 'governorate')
    else if (scope.level === 'governorate') { params.set('group_by', 'delegation'); params.set('gov_id', scope.governorateId || '') }
    else if (scope.level === 'delegation') { params.set('group_by', 'site'); params.set('deleg_id', scope.delegationId || '') }
    else if (scope.level === 'cell') { params.set('group_by', 'cell'); params.set('cell_name', scope.selectedCellName || '') }
    fetchJson(`/api/peak-hours?${params.toString()}`)
      .then((payload) => { if (!cancelled) { setPeakPayload(payload); setPeakRows(payload.rows || []) } })
      .catch((err) => { if (!cancelled) setPeakPayload({ available: false, rows: [], summary: null, reason: err.message || String(err) }) })
    return () => { cancelled = true }
  }, [data, scope.level, scope.governorateId, scope.delegationId, scope.selectedCellName, busyMetric, dataMode])

  async function reloadRuntimeData() {
    const payload = await loadDashboardData()
    setData(payload)
    setDelegationVariationRows([])
    sliceCacheRef.current.clear()
    setTimeIndex(0)
    setScope(initialAdminScope)
    setActiveTab('overview')
    setLoadError('')
    setImportState({ status: 'idle', fileName: '', importType: 'reference', preview: null, result: null, error: '' })
  }

  async function changeDataMode(mode) {
    try {
      const res = await fetch('/api/data-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      })
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}))
        throw new Error(payload.error || `data-mode returned ${res.status}`)
      }
      const payload = await res.json()
      setDataMode(payload.mode || mode)
      await reloadRuntimeData()
    } catch (err) {
      setLoadError(err.message || String(err))
    }
  }

  const loadTimeSlice = useCallback(async (index) => {
    if (!data?.timeIndex?.[index]) return
    if (loadingSliceRef.current) {
      pendingSliceIndexRef.current = index
      return
    }
    loadingSliceRef.current = true
    const entry = data.timeIndex[index]
    setTimeIndex(index)
    if (!entry.filename) {
      loadingSliceRef.current = false
      return
    }
    try {
      async function readSlice(timeEntry) {
        if (!timeEntry?.filename) return null
        if (sliceCacheRef.current.has(timeEntry.filename)) return sliceCacheRef.current.get(timeEntry.filename)
        const slice = await fetchJson(`/api/data/time_data/${encodeURIComponent(timeEntry.filename)}`)
        sliceCacheRef.current.set(timeEntry.filename, slice)
        return slice
      }
      let previousSlice = null
      if (index > 0 && data.timeIndex[index - 1]?.filename) {
        previousSlice = await readSlice(data.timeIndex[index - 1]).catch(() => null)
        setPreviousObservations(previousSlice?.observations || {})
      } else {
        setPreviousObservations({})
        setDelegationVariationRows([])
      }
      const slice = await readSlice(entry)
      if (previousSlice?.observations && slice?.observations) {
        const prevCells = buildCells(data.baseline, previousSlice.observations, data.adminCellIndex)
        const currentCellsForVariation = buildCells(data.baseline, slice.observations, data.adminCellIndex)
        const prevRows = rankDelegations(prevCells, data.registry, null, metricMode)
        const currentRows = rankDelegations(currentCellsForVariation, data.registry, null, metricMode)
        const prevById = new Map(prevRows.map((row) => [row.id, row]))
        setDelegationVariationRows(currentRows.map((row) => {
          const prev = prevById.get(row.id) || {}
          const currentValue = Number(row.value || 0)
          const previousValue = Number(prev.value || 0)
          return {
            ...row,
            deltaValue: currentValue - previousValue,
            deltaPrb: Number(row.avg_prb || 0) - Number(prev.avg_prb || 0),
            deltaCongestion: Number(row.congestion_rate || 0) - Number(prev.congestion_rate || 0),
            previousValue,
          }
        }).filter((row) => Math.abs(row.deltaValue) >= 0.1 || Math.abs(row.deltaPrb) >= 0.1 || Math.abs(row.deltaCongestion) >= 0.1)
          .sort((a, b) => Math.abs(b.deltaValue) - Math.abs(a.deltaValue))
          .slice(0, 10))
      }
      setData((prev) => ({ ...prev, currentTimeEntry: entry, observations: slice?.observations || {} }))
      const nextEntry = data.timeIndex[Math.min(data.timeIndex.length - 1, index + 1)]
      if (nextEntry?.filename && !sliceCacheRef.current.has(nextEntry.filename)) {
        readSlice(nextEntry).catch(() => {})
      }
      if (timelinePlayback.isPlaying) {
        for (let i = index + 2; i <= Math.min(data.timeIndex.length - 1, index + 10); i += 1) {
          const ahead = data.timeIndex[i]
          if (!ahead?.filename || sliceCacheRef.current.has(ahead.filename)) continue
          readSlice(ahead).catch(() => {})
        }
      }
    } catch (err) {
      setLoadError(err.message || String(err))
    } finally {
      loadingSliceRef.current = false
      if (pendingSliceIndexRef.current !== null) {
        const nextRequested = pendingSliceIndexRef.current
        pendingSliceIndexRef.current = null
        if (nextRequested !== index) loadTimeSlice(nextRequested)
      }
    }
  }, [data?.timeIndex, data?.baseline, data?.adminCellIndex, data?.registry, metricMode, timelinePlayback.isPlaying])

  useEffect(() => {
    if (!timelinePlayback.isPlaying || !timeIndexEntriesRef.current.length) return undefined
    const timer = window.setInterval(() => {
      const lastIndex = Math.max(0, timeIndexEntriesRef.current.length - 1)
      const nextIndex = timeIndexRef.current >= lastIndex ? 0 : timeIndexRef.current + 1
      loadTimeSlice(nextIndex)
    }, timelinePlayback.speedMs)
    return () => window.clearInterval(timer)
  }, [timelinePlayback.isPlaying, timelinePlayback.speedMs, loadTimeSlice])

  const cells = useMemo(() => data ? buildCells(data.baseline, data.observations, data.adminCellIndex) : [], [data?.baseline, data?.observations, data?.adminCellIndex])
  const previousCells = useMemo(() => data && Object.keys(previousObservations || {}).length ? buildCells(data.baseline, previousObservations, data.adminCellIndex) : [], [data?.baseline, previousObservations, data?.adminCellIndex])
  const bands = useMemo(() => Array.from(new Set(cells.map((cell) => String(cell.frequency_band)).filter(Boolean))).sort(), [cells])
  const scopedCellsRaw = useMemo(() => {
    if (scope.level === 'governorate') return cells.filter((cell) => cell.admin?.gov_id === scope.governorateId)
    if (scope.level === 'delegation' || scope.level === 'cell') return cells.filter((cell) => cell.admin?.deleg_id === scope.delegationId)
    return cells
  }, [cells, scope])
  const filteredCells = useMemo(() => applyCellFilters(cells, filters), [cells, filters])
  const scopedCells = useMemo(() => applyCellFilters(scopedCellsRaw, filters), [scopedCellsRaw, filters])
  const siteRows = useMemo(() => buildSiteSummaries(scopedCells), [scopedCells])
  const alerts = useMemo(() => summarizeAlerts(scopedCells), [scopedCells])
  const metric = METRIC_MODES.find((item) => item.id === metricMode) || METRIC_MODES[0]
  const nationalSummary = useMemo(() => aggregateNationalScope(filteredCells), [filteredCells])
  const governorateRows = useMemo(() => data ? rankGovernorates(filteredCells, data.registry, metricMode) : [], [filteredCells, data?.registry, metricMode])
  const previousGovernorateRows = useMemo(() => data && previousCells.length ? rankGovernorates(previousCells, data.registry, metricMode) : [], [data?.registry, previousCells, metricMode])
  const delegationRows = useMemo(() => data ? rankDelegations(filteredCells, data.registry, scope.governorateId, metricMode) : [], [filteredCells, data?.registry, scope.governorateId, metricMode])
  const allDelegationRows = useMemo(() => data ? rankDelegations(filteredCells, data.registry, null, metricMode) : [], [filteredCells, data?.registry, metricMode])
  const searchIndex = useMemo(() => data ? buildSearchIndex(data.registry, cells) : [], [data?.registry, cells])
  const searchResults = useMemo(() => searchAdmin(query, searchIndex), [query, searchIndex])

  const selectedGovernorate = useMemo(() => data?.registry?.governorates?.find((gov) => gov.gov_id === scope.governorateId) || null, [data, scope.governorateId])
  const selectedDelegation = useMemo(() => data?.registry?.delegations?.find((deleg) => deleg.deleg_id === scope.delegationId) || null, [data, scope.delegationId])
  const selectedCell = useMemo(() => cells.find((cell) => cell.cell_name === scope.selectedCellName) || null, [cells, scope.selectedCellName])
  const governorateSummary = useMemo(() => aggregateGovernorateScope(filteredCells, scope.governorateId), [filteredCells, scope.governorateId])
  const delegationSummary = useMemo(() => aggregateDelegationScope(filteredCells, scope.delegationId), [filteredCells, scope.delegationId])
  const currentSummary = scope.level === 'delegation' || scope.level === 'cell' ? delegationSummary : scope.level === 'governorate' ? governorateSummary : nationalSummary
  const scopedPreviousCells = useMemo(() => {
    if (scope.level === 'governorate') return previousCells.filter((cell) => cell.admin?.gov_id === scope.governorateId)
    if (scope.level === 'delegation' || scope.level === 'cell') return previousCells.filter((cell) => cell.admin?.deleg_id === scope.delegationId)
    return previousCells
  }, [previousCells, scope])
  const ranIssue = useMemo(() => classifyRanIssue(currentSummary), [currentSummary])
  const dataQuality = useMemo(() => computeDataQuality({ data, cells, timeIndex: data?.timeIndex || [], peakPayload, dataMode }), [data?.baseline, data?.observations, data?.timeIndex, data?.reconciliation, cells, peakPayload, dataMode])
  const whyCritical = useMemo(() => buildWhyCritical({ summary: currentSummary, peakPayload, peakRows, issue: ranIssue, warnings: dataQuality.warnings }), [currentSummary, peakPayload, peakRows, ranIssue, dataQuality])
  const sliceDelta = useMemo(() => computeSliceDelta(scopedCellsRaw, scopedPreviousCells), [scopedCellsRaw, scopedPreviousCells])

  function selectGovernorate(raw, options = {}) {
    const gov = raw.gov_id ? raw : data?.registry?.governorates?.find((item) => item.gov_id === raw.id || item.gov_name === raw.name || item.gov_name === raw.gov_name)
    if (!gov) return
    if (options.activeTab) setActiveTab(options.activeTab)
    else setActiveTab('overview')
    setScope({ ...initialAdminScope, level: 'governorate', governorateId: gov.gov_id, governorateName: gov.gov_name, transitionState: 'focusing-governorate' })
    window.setTimeout(() => setScope((prev) => prev.governorateId === gov.gov_id ? { ...prev, transitionState: 'idle' } : prev), 900)
  }

  function selectDelegation(raw, options = {}) {
    const deleg = raw.deleg_id ? raw : data?.registry?.delegations?.find((item) => item.deleg_id === raw.id || item.deleg_name === raw.name || item.deleg_name === raw.deleg_name)
    if (!deleg) return
    if (options.activeTab) setActiveTab(options.activeTab)
    else setActiveTab('qos')
    setScope({ ...initialAdminScope, level: 'delegation', governorateId: deleg.gov_id, governorateName: deleg.gov_name, delegationId: deleg.deleg_id, delegationName: deleg.deleg_name, transitionState: 'focusing-delegation' })
    window.setTimeout(() => setScope((prev) => prev.delegationId === deleg.deleg_id ? { ...prev, transitionState: 'idle' } : prev), 900)
  }

  function selectCell(cellName, options = {}) {
    const cell = cells.find((item) => item.cell_name === cellName)
    if (!cell?.admin) return
    if (options.activeTab) setActiveTab(options.activeTab)
    else setActiveTab('operations')
    setScope({ ...initialAdminScope, level: 'cell', governorateId: cell.admin.gov_id, governorateName: cell.admin.gov_name, delegationId: cell.admin.deleg_id, delegationName: cell.admin.deleg_name, selectedSite: cell.site_name, selectedCellName: cell.cell_name, transitionState: 'idle' })
  }

  function toggleTimelinePlayback() {
    setTimelinePlayback((prev) => ({ ...prev, isPlaying: !prev.isPlaying }))
  }

  function changeTimelineSpeed(speedMs) {
    const allowed = [3000, 1500, 750, 350, 200]
    const next = allowed.includes(speedMs) ? speedMs : 1500
    setTimelinePlayback((prev) => ({ ...prev, speedMs: next }))
  }

  function startTimelineFrom(mode) {
    const maxIndex = Math.max(0, (data?.timeIndex?.length || 1) - 1)
    const startIndex = mode === 'start' ? 0 : mode === 'end' ? maxIndex : Math.min(timeIndex, maxIndex)
    loadTimeSlice(startIndex)
    setTimelinePlayback((prev) => ({ ...prev, isPlaying: true, startMode: mode }))
  }

  function selectSearchResult(item) {
    setQuery('')
    if (item.type === 'governorate') selectGovernorate(item.gov)
    if (item.type === 'delegation') selectDelegation(item.deleg)
    if (item.type === 'site' || item.type === 'cell') selectCell(item.cell.cell_name)
  }

  function selectPeakRow(row) {
    if (!row) return
    if (row.group_by === 'governorate') {
      const gov = data?.registry?.governorates?.find((item) => item.gov_id === row.id)
      if (gov) selectGovernorate(gov, { activeTab: 'peak-hours' })
    } else if (row.group_by === 'delegation') {
      const deleg = data?.registry?.delegations?.find((item) => item.deleg_id === row.id)
      if (deleg) selectDelegation(deleg, { activeTab: 'peak-hours' })
    } else if (row.group_by === 'site') {
      const cell = cells.find((item) => item.site_name === row.id && item.admin?.deleg_id === scope.delegationId)
      if (cell) selectCell(cell.cell_name, { activeTab: 'peak-hours' })
    } else if (row.group_by === 'cell') {
      selectCell(row.id, { activeTab: 'peak-hours' })
    }
  }

  function updateFilters(patch) {
    setFilters((prev) => ({ ...prev, ...patch }))
  }


  function exportScopedJson() {
    const report = buildReportObject()
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'netvision-analytical-report.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  function buildReportObject() {
    const topRows = scope.level === 'national' ? governorateRows : delegationRows
    return buildAnalyticalReport({
      scope,
      timestamp: data?.currentTimeEntry?.timestamp || 'N/A',
      summary: currentSummary,
      peakPayload,
      peakRows,
      issue: ranIssue,
      whyCritical,
      dataQuality,
      topRows,
    })
  }

  async function handleImportFile(file, importType = importState.importType) {
    if (!file) return
    setImportState((prev) => ({ ...prev, status: 'parsing', fileName: file.name, error: '', result: null }))
    try {
      const csvText = await file.text()
      const preview = await callImportWorker('parseCsvPreview', { csvText, maxPreviewRows: 8 })
      const mapping = buildAutoMapping(preview.headers, preview.inferredMapping)
      const payload = await callImportWorker('applyCsvMapping', {
        rows: preview.allRows,
        mapping,
        importType,
        existingBaseline: importType === 'kpi' ? data?.baseline || {} : {},
        realismPolicy: { strictScopeToReference: importType === 'kpi', strictNoFallback: false },
      })
      const nextTimeIndex = payload.slices?.length ? payload.slices.map((slice, index) => ({ timestamp: slice.timestamp, filename: '', stats: slice.stats, importIndex: index })) : [{ timestamp: payload.timestamp || 'Imported snapshot', filename: '', stats: payload.stats, importIndex: 0 }]
      const currentSlice = payload.slices?.[payload.slices.length - 1] || { observations: payload.observations, stats: payload.stats }
      setData((prev) => ({
        ...prev,
        baseline: Object.keys(payload.baseline || {}).length ? payload.baseline : prev.baseline,
        observations: currentSlice.observations || payload.observations || {},
        timeIndex: nextTimeIndex,
        currentTimeEntry: nextTimeIndex[nextTimeIndex.length - 1],
        stats: payload.stats || prev.stats,
        importedSession: { active: true, fileName: file.name, importType, slices: payload.slices || [] },
      }))
      setTimeIndex(Math.max(0, nextTimeIndex.length - 1))
      setImportState({ status: 'loaded', fileName: file.name, importType, preview, result: payload, error: '' })
      if (Object.keys(payload.baseline || {}).length && Array.isArray(payload.slices)) {
        fetch('/api/recommend-context', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ baseline: payload.baseline, slices: payload.slices, source: 'frontend-import' }) }).catch(() => {})
      }
    } catch (err) {
      setImportState((prev) => ({ ...prev, status: 'error', error: err.message || String(err) }))
    }
  }

  function restoreRuntimeData() {
    reloadRuntimeData().then(() => { fetch('/api/recommend-context', { method: 'DELETE' }).catch(() => {}) }).catch((err) => setLoadError(err.message || String(err)))
  }

  function exportReport() {
    const report = buildReportObject()
    const lines = [
      report.title,
      `Scope: ${report.scope.level} - ${report.scope.label}`,
      `Timestamp: ${report.timestamp}`,
      `Cells: ${currentSummary.observed_cells}`,
      `Congested: ${currentSummary.congested_cells}`,
      `Avg PRB: ${currentSummary.avg_prb.toFixed(1)}%`,
      `Heure de pointe: ${report.peak_hours.summary?.peak_hour || 'N/A'}`,
      `QoS diagnosis: ${ranIssue.issue}`,
      '',
      'Why critical:',
      ...whyCritical.map((line) => `- ${line}`),
      '',
      'Qualite des donnees:',
      ...dataQuality.warnings.slice(0, 8).map((line) => `- Warning: ${line}`),
      '',
      'Top affected:',
      ...report.top_affected.map((row) => `- ${row.name}: congestion ${Number(row.congestion_rate || 0).toFixed(1)}%, PRB ${Number(row.avg_prb || 0).toFixed(1)}%`),
    ]
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'netvision-scoped-report.txt'
    a.click()
    URL.revokeObjectURL(url)
  }

  const endpointCoverage = useMemo(() => ([
    { endpoint: '/api/data/*', ...(endpointStatus.data || { wired: true, reachable: false, degraded: false, detail: '' }) },
    { endpoint: '/api/data-mode', wired: true, reachable: true, degraded: false, detail: dataMode },
    { endpoint: '/api/peak-hours', ...(endpointStatus.peakHours || { wired: true, reachable: false, degraded: false, detail: '' }) },
    { endpoint: '/api/backend-health', ...(endpointStatus.backend || { wired: true, reachable: false, degraded: false, detail: '' }) },
    { endpoint: '/api/jobs', ...(endpointStatus.jobsHealth || { wired: true, reachable: false, degraded: false, detail: '' }) },
    { endpoint: '/api/jobs/[id]', ...(endpointStatus.jobsHealth || { wired: true, reachable: false, degraded: false, detail: '' }) },
    { endpoint: '/api/recommend-context', wired: true, reachable: true, degraded: false, detail: 'invoked during import/restore' },
    { endpoint: '/api/recommend', wired: true, reachable: true, degraded: false, detail: 'invoked at cell scope' },
    { endpoint: '/api/simulate', wired: true, reachable: true, degraded: false, detail: 'compat route preserved' },
  ]), [endpointStatus, dataMode])

  let panel = null
  if (!data && !loadError) panel = <div className="panel-shell"><div className="loading-block">Chargement des donnees runtime NetVision et de la geographie administrative...</div></div>
  else if (loadError) panel = <div className="panel-shell"><div className="empty-state warning">{loadError}. Verifiez les fichiers de geographie administrative.</div></div>
  else panel = <CockpitPanel activeTab={activeTab} adminToolsEnabled={adminToolsEnabled} scope={scope} data={data} dataMode={dataMode} onDataModeChange={changeDataMode} nationalSummary={nationalSummary} governorateSummary={governorateSummary} delegationSummary={delegationSummary} summary={currentSummary} governorateRows={governorateRows} previousGovernorateRows={previousGovernorateRows} delegationRows={delegationRows} delegationVariationRows={delegationVariationRows} selectedGovernorate={selectedGovernorate} selectedDelegation={selectedDelegation} selectedCell={selectedCell} siteRows={siteRows} scopedCells={scopedCells} alerts={alerts} metric={metric} currentTime={data.currentTimeEntry} filters={filters} onFilterChange={updateFilters} bands={bands} onSelectGovernorate={selectGovernorate} onSelectDelegation={selectDelegation} onSelectCell={selectCell} reconciliation={data.reconciliation} peakRows={peakRows} peakPayload={peakPayload} busyMetric={busyMetric} onBusyMetricChange={setBusyMetric} onPeakRowSelect={selectPeakRow} backendHealth={backendHealth} workerState={workerState} importState={importState} endpointCoverage={endpointCoverage} onImportFile={handleImportFile} onImportTypeChange={(importType) => setImportState((prev) => ({ ...prev, importType }))} onRestoreRuntime={restoreRuntimeData} onExportJson={exportScopedJson} onExportReport={exportReport} whyCritical={whyCritical} dataQuality={dataQuality} sliceDelta={sliceDelta} />

  return (
    <div className={`app-shell ${focusMode ? 'focus-mode' : ''} ${theme === 'dark' ? 'theme-dark' : ''}`}>
      <a href="#main-content" className="skip-link">Aller au contenu principal</a>
      <TopHeader metricMode={metricMode} metricModes={METRIC_MODES} onMetricModeChange={setMetricMode} query={query} onQueryChange={setQuery} searchResults={searchResults} onSearchSelect={selectSearchResult} dataMode={dataMode} onSecondaryPanel={setActiveTab} adminToolsEnabled={adminToolsEnabled} />
      <div className="sr-only" aria-live="polite">{`Perimetre courant ${scope.level}${scope.governorateName ? `, ${scope.governorateName}` : ''}${scope.delegationName ? `, ${scope.delegationName}` : ''}${scope.selectedCellName ? `, ${scope.selectedCellName}` : ''}`}</div>
      <main id="main-content" className="command-layout cockpit-layout">
        <CockpitRail activeTab={activeTab} onTabChange={setActiveTab} alertCount={alerts.length} tabs={visibleTabs} />
        <section className="map-column">
          <Breadcrumb scope={scope} onNational={() => { setActiveTab('overview'); setScope(backToNational()) }} onGovernorate={() => { setActiveTab('overview'); setScope(backToGovernorate(scope)) }} onDelegation={() => { setActiveTab('qos'); setScope(backToDelegation(scope)) }} />
          <TimelineBar
            timeIndex={data?.timeIndex || []}
            currentIndex={timeIndex}
            onChange={(index) => { setTimelinePlayback((prev) => ({ ...prev, isPlaying: false })); loadTimeSlice(index) }}
            onPrev={() => { setTimelinePlayback((prev) => ({ ...prev, isPlaying: false })); loadTimeSlice(Math.max(0, timeIndex - 1)) }}
            onNext={() => { setTimelinePlayback((prev) => ({ ...prev, isPlaying: false })); loadTimeSlice(Math.min((data?.timeIndex?.length || 1) - 1, timeIndex + 1)) }}
            isPlaying={timelinePlayback.isPlaying}
            speedMs={timelinePlayback.speedMs}
            onTogglePlay={toggleTimelinePlayback}
            onSpeedChange={changeTimelineSpeed}
            onStartFrom={startTimelineFrom}
          />
          {data ? <TunisiaMap governoratesGeo={data.governorates} delegationsGeo={data.delegations} governorateRows={governorateRows} delegationRows={allDelegationRows} cells={cells} filteredCells={filteredCells} scope={scope} metricMode={metricMode} metric={metric} mapControls={mapControls} onGovernorateClick={selectGovernorate} onDelegationClick={selectDelegation} onCellClick={selectCell} /> : <div className="map-card skeleton-map" />}
          <div className="scope-footer map-control-strip"><span>{currentSummary.observed_cells || 0} cellules</span><span>{data?.currentTimeEntry?.timestamp || 'Aucune tranche'}</span>{(scope.level === 'delegation' || scope.level === 'cell') ? <button data-testid="toggle-heatmap" onClick={() => setMapControls((v) => ({ ...v, heatmap: !v.heatmap }))}>{mapControls.heatmap ? 'Voir les sites' : 'Voir la chaleur'}</button> : null}{(scope.level === 'delegation' || scope.level === 'cell') ? <button data-testid="toggle-labels" onClick={() => setMapControls((v) => ({ ...v, labels: !v.labels }))}>{mapControls.labels ? 'Masquer libelles' : 'Afficher libelles'}</button> : null}</div>
        </section>
        <aside className="insight-column">{panel}</aside>
      </main>
      {demoStep !== null ? <div className="transition-overlay">Parcours de demonstration</div> : transitionLabel(scope) ? <div className="transition-overlay">{transitionLabel(scope)}</div> : null}
    </div>
  )
}
