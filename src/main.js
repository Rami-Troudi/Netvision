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
import { getNetvisionRole, isAdminToolsEnabled, setNetvisionRole } from './utils/uiPolicy.mjs'
import { getRestorationFlags } from './utils/restorationFlags.mjs'
import { useSystemEndpoints, usePeakHours } from './hooks/useDashboardData'

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
  const [busyMetric, setBusyMetric] = useState('congestion_rate')
  const [backendHealth, setBackendHealth] = useState(null)
  const [theme, setTheme] = useState('light')
  const [importState, setImportState] = useState({ status: 'idle', fileName: '', importType: 'reference', preview: null, dryRun: null, selectedProfileId: '', profiles: [], result: null, error: '' })
  const [dataMode, setDataMode] = useState('real')
  const [interfaceRole, setInterfaceRole] = useState(() => getNetvisionRole())
  const restorationFlags = useMemo(() => getRestorationFlags(), [])
  const [forecastState, setForecastState] = useState({ available: false, rows: [], assumptions: [], confidence: 'low' })
  const [driftState, setDriftState] = useState({ available: false, rows: [], summary: {} })
  const [watchlist, setWatchlist] = useState([])
  const [savedViews, setSavedViews] = useState([])

  const { endpointStatus, workerState, jobsHealth } = useSystemEndpoints()
  const { peakRows, peakPayload } = usePeakHours({ data, scope, busyMetric, dataMode })
  
  const [previousObservations, setPreviousObservations] = useState({})
  const [delegationVariationRows, setDelegationVariationRows] = useState([])
  const [demoStep, setDemoStep] = useState(null)
  const [timelinePlayback, setTimelinePlayback] = useState({ isPlaying: false, speedMs: 1500, startMode: 'current' })
  const dataRef = useRef(null)
  const timeIndexRef = useRef(0)
  const timeIndexEntriesRef = useRef([])
  const loadingSliceRef = useRef(false)
  const pendingSliceIndexRef = useRef(null)
  const sliceCacheRef = useRef(new Map())
  const adminToolsEnabled = interfaceRole === 'admin' || isAdminToolsEnabled()
  const showRoleSwitch = typeof window !== 'undefined' && (process.env.NODE_ENV !== 'production' || adminToolsEnabled)
  const visibleTabs = useMemo(() => adminToolsEnabled ? [...COCKPIT_TABS, ...ADMIN_COCKPIT_TABS] : COCKPIT_TABS, [adminToolsEnabled])

  useEffect(() => {
    if (!adminToolsEnabled && ['analytics', 'data', 'system'].includes(activeTab)) setActiveTab('overview')
  }, [adminToolsEnabled, activeTab])

  useEffect(() => {
    let cancelled = false
    fetchJson('/api/data-mode').then((payload) => !cancelled && setDataMode(payload.mode || 'real')).catch(() => {})
    loadDashboardData().then((payload) => { if (!cancelled) setData(payload) }).catch((err) => { if (!cancelled) setLoadError(err.message || String(err)) })
    fetchJson('/api/backend-health').then((payload) => !cancelled && setBackendHealth(payload)).catch(() => !cancelled && setBackendHealth({ status: 'unavailable' }))
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!adminToolsEnabled) return
    fetch('/api/import-profiles')
      .then((res) => res.ok ? res.json() : Promise.resolve({ profiles: [] }))
      .then((payload) => {
        const profiles = Array.isArray(payload?.profiles) ? payload.profiles : []
        setImportState((prev) => ({ ...prev, profiles }))
      })
      .catch(() => {})
  }, [adminToolsEnabled])

  useEffect(() => {
    try {
      setWatchlist(JSON.parse(localStorage.getItem('netvision.watchlist') || '[]'))
      setSavedViews(JSON.parse(localStorage.getItem('netvision.savedViews') || '[]'))
    } catch {}
  }, [])
  useEffect(() => { localStorage.setItem('netvision.watchlist', JSON.stringify(watchlist)) }, [watchlist])
  useEffect(() => { localStorage.setItem('netvision.savedViews', JSON.stringify(savedViews)) }, [savedViews])

  useEffect(() => {
    if (!adminToolsEnabled || !restorationFlags.forecast || activeTab !== 'system') {
      setForecastState({ available: false, rows: [], assumptions: [], confidence: 'low' })
      return
    }
    fetchJson('/api/forecast?limit=10').then((p) => setForecastState(p)).catch(() => setForecastState({ available: false, rows: [], reason: 'API forecast indisponible' }))
  }, [adminToolsEnabled, restorationFlags.forecast, activeTab])
  useEffect(() => {
    if (!adminToolsEnabled || !restorationFlags.drift || !['forecast', 'system'].includes(activeTab)) {
      setDriftState({ available: false, rows: [], summary: {} })
      return
    }
    fetchJson('/api/drift').then((p) => setDriftState(p)).catch(() => setDriftState({ available: false, rows: [], reason: 'API drift indisponible' }))
  }, [adminToolsEnabled, restorationFlags.drift, activeTab])

  useEffect(() => { timeIndexRef.current = timeIndex }, [timeIndex])
  useEffect(() => { dataRef.current = data }, [data])
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

  async function reloadRuntimeData() {
    const payload = await loadDashboardData()
    setData(payload)
    setDelegationVariationRows([])
    sliceCacheRef.current.clear()
    setTimeIndex(0)
    setScope(initialAdminScope)
    setActiveTab('overview')
    setLoadError('')
    setImportState({ status: 'idle', fileName: '', importType: 'reference', preview: null, dryRun: null, selectedProfileId: '', profiles: [], result: null, error: '' })
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
    const runtimeData = dataRef.current
    if (!runtimeData?.timeIndex?.[index]) return
    if (loadingSliceRef.current) {
      pendingSliceIndexRef.current = index
      return
    }
    loadingSliceRef.current = true
    const entry = runtimeData.timeIndex[index]
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
      if (index > 0 && runtimeData.timeIndex[index - 1]?.filename) {
        previousSlice = await readSlice(runtimeData.timeIndex[index - 1]).catch(() => null)
        setPreviousObservations(previousSlice?.observations || {})
      } else {
        setPreviousObservations({})
        setDelegationVariationRows([])
      }
      const slice = await readSlice(entry)
      if (previousSlice?.observations && slice?.observations) {
        const prevCells = buildCells(runtimeData.baseline, previousSlice.observations, runtimeData.adminCellIndex)
        const currentCellsForVariation = buildCells(runtimeData.baseline, slice.observations, runtimeData.adminCellIndex)
        const prevRows = rankDelegations(prevCells, runtimeData.registry, null, metricMode)
        const currentRows = rankDelegations(currentCellsForVariation, runtimeData.registry, null, metricMode)
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
      const nextEntry = runtimeData.timeIndex[Math.min(runtimeData.timeIndex.length - 1, index + 1)]
      if (nextEntry?.filename && !sliceCacheRef.current.has(nextEntry.filename)) {
        readSlice(nextEntry).catch(() => {})
      }
      for (let i = index + 2; i <= Math.min(runtimeData.timeIndex.length - 1, index + 5); i += 1) {
        const ahead = runtimeData.timeIndex[i]
        if (!ahead?.filename || sliceCacheRef.current.has(ahead.filename)) continue
        readSlice(ahead).catch(() => {})
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
  }, [metricMode])

  useEffect(() => {
    if (!timelinePlayback.isPlaying || !timeIndexEntriesRef.current.length) return undefined
    const timer = window.setInterval(() => {
      const lastIndex = Math.max(0, timeIndexEntriesRef.current.length - 1)
      const nextIndex = timeIndexRef.current >= lastIndex ? 0 : timeIndexRef.current + 1
      loadTimeSlice(nextIndex)
    }, timelinePlayback.speedMs)
    return () => window.clearInterval(timer)
  }, [timelinePlayback.isPlaying, timelinePlayback.speedMs, loadTimeSlice])

  const baseline = data?.baseline
  const observations = data?.observations
  const adminCellIndex = data?.adminCellIndex
  const registry = data?.registry
  const cells = useMemo(() => baseline ? buildCells(baseline, observations, adminCellIndex) : [], [baseline, observations, adminCellIndex])
  const previousCells = useMemo(() => baseline && Object.keys(previousObservations || {}).length ? buildCells(baseline, previousObservations, adminCellIndex) : [], [baseline, previousObservations, adminCellIndex])
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
  const governorateRows = useMemo(() => registry ? rankGovernorates(filteredCells, registry, metricMode) : [], [filteredCells, registry, metricMode])
  const previousGovernorateRows = useMemo(() => registry && previousCells.length ? rankGovernorates(previousCells, registry, metricMode) : [], [registry, previousCells, metricMode])
  const delegationRows = useMemo(() => registry ? rankDelegations(filteredCells, registry, scope.governorateId, metricMode) : [], [filteredCells, registry, scope.governorateId, metricMode])
  const allDelegationRows = useMemo(() => registry ? rankDelegations(filteredCells, registry, null, metricMode) : [], [filteredCells, registry, metricMode])
  const searchIndex = useMemo(() => registry ? buildSearchIndex(registry, cells) : [], [registry, cells])
  const searchResults = useMemo(() => searchAdmin(query, searchIndex), [query, searchIndex])

  const selectedGovernorate = useMemo(() => registry?.governorates?.find((gov) => gov.gov_id === scope.governorateId) || null, [registry, scope.governorateId])
  const selectedDelegation = useMemo(() => registry?.delegations?.find((deleg) => deleg.deleg_id === scope.delegationId) || null, [registry, scope.delegationId])
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
  const dataQuality = useMemo(() => computeDataQuality({ data, cells, timeIndex: data?.timeIndex || [], peakPayload, dataMode }), [data, cells, peakPayload, dataMode])
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
    if (!cell) return
    const admin = cell.admin || {}
    if (options.activeTab) setActiveTab(options.activeTab)
    else setActiveTab('qos')
    setScope({
      ...initialAdminScope,
      level: 'cell',
      governorateId: admin.gov_id || '',
      governorateName: admin.gov_name || '',
      delegationId: admin.deleg_id || '',
      delegationName: admin.deleg_name || '',
      selectedSite: cell.site_name,
      selectedCellName: cell.cell_name,
      transitionState: 'idle',
    })
  }
  function saveCurrentView() {
    const id = `view_${Date.now()}`
    const name = `${scope.level}:${scope.selectedCellName || scope.delegationName || scope.governorateName || 'national'}`
    setSavedViews((prev) => [{ id, name, scope, activeTab, timeIndex, filters }, ...prev].slice(0, 20))
  }
  function restoreView(id) {
    const v = savedViews.find((x) => x.id === id)
    if (!v) return
    setScope(v.scope); setActiveTab(v.activeTab); setFilters(v.filters); loadTimeSlice(v.timeIndex || 0)
  }
  function removeView(id) { setSavedViews((prev) => prev.filter((v) => v.id !== id)) }
  function pinSelectedCell() {
    if (!selectedCell) return
    setWatchlist((prev) => [{ cell_name: selectedCell.cell_name, note: 'Prioritaire' }, ...prev.filter((w) => w.cell_name !== selectedCell.cell_name)].slice(0, 30))
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

  function changeInterfaceRole(role) {
    const next = role === 'admin' ? 'admin' : 'operator'
    setNetvisionRole(next)
    setInterfaceRole(next)
    if (next !== 'admin' && ['analytics', 'data', 'system'].includes(activeTab)) setActiveTab('overview')
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
    const payload = {
      scope,
      time_window: { current_slice: data?.currentTimeEntry?.timestamp || null },
      filters,
      data_mode: dataMode,
      summary: report,
      rows: scope.level === 'national' ? governorateRows.slice(0, 50) : delegationRows.slice(0, 50),
    }
    fetch('/api/export-scoped', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format: 'json', payload }) })
      .then((res) => res.json())
      .then((json) => {
        const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'netvision-scoped-export.json'
        a.click()
        URL.revokeObjectURL(url)
      })
      .catch((err) => setLoadError(err.message || String(err)))
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
    setImportState((prev) => ({ ...prev, status: 'parsing', fileName: file.name, error: '', dryRun: null, result: null }))
    try {
      const csvText = await file.text()
      const preview = await callImportWorker('parseCsvPreview', { csvText, maxPreviewRows: 8 })
      const selectedProfile = importState.profiles.find((profile) => profile.id === importState.selectedProfileId)
      const mapping = selectedProfile?.mapping || buildAutoMapping(preview.headers, preview.inferredMapping)
      const dryRunRes = await fetch('/api/import-dry-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ import_type: importType, csv_text: csvText, mapping }),
      })
      const dryRunPayload = await dryRunRes.json().catch(() => null)
      if (!dryRunRes.ok || !dryRunPayload?.can_apply) throw new Error(dryRunPayload?.error?.message || 'Dry-run import invalide')
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
      setImportState((prev) => ({ ...prev, status: 'loaded', fileName: file.name, importType, preview, dryRun: dryRunPayload, result: payload, error: '' }))
      fetch('/api/import-profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dataset_name: file.name,
          source_type: importType,
          mapping,
          strict_congestion_flag: Boolean(mapping?.congested),
        }),
      }).then(() => fetch('/api/import-profiles'))
        .then((res) => res.ok ? res.json() : Promise.resolve({ profiles: [] }))
        .then((res) => setImportState((prev) => ({ ...prev, profiles: Array.isArray(res?.profiles) ? res.profiles : prev.profiles })))
        .catch(() => {})
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
      'Qualité des données:',
      ...dataQuality.warnings.slice(0, 8).map((line) => `- Warning: ${line}`),
      '',
      'Top affected:',
      ...report.top_affected.map((row) => `- ${row.name}: congestion ${Number(row.congestion_rate || 0).toFixed(1)}%, PRB ${Number(row.avg_prb || 0).toFixed(1)}%`),
    ]
    const payload = {
      scope,
      time_window: { current_slice: data?.currentTimeEntry?.timestamp || null },
      filters,
      data_mode: dataMode,
      summary: { lines },
      rows: scope.level === 'national' ? governorateRows.slice(0, 50) : delegationRows.slice(0, 50),
    }
    fetch('/api/export-scoped', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format: 'txt', payload }) })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Export failed: ${res.status}`)
        const text = await res.text()
        const blob = new Blob([text], { type: 'text/plain' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'netvision-scoped-report.txt'
        a.click()
        URL.revokeObjectURL(url)
      })
      .catch((err) => setLoadError(err.message || String(err)))
  }

  const endpointCoverage = useMemo(() => ([
    { endpoint: '/api/data/*', ...(endpointStatus.data || { wired: true, reachable: false, degraded: false, detail: '' }) },
    { endpoint: '/api/data-mode', wired: true, reachable: true, degraded: false, detail: dataMode },
    { endpoint: '/api/peak-hours', wired: true, reachable: Boolean(peakPayload?.available), degraded: peakPayload?.available === false, detail: peakPayload?.reason || '' },
    { endpoint: '/api/backend-health', ...(endpointStatus.backend || { wired: true, reachable: false, degraded: false, detail: '' }) },
    { endpoint: '/api/jobs', ...(endpointStatus.jobsHealth || { wired: true, reachable: false, degraded: false, detail: '' }) },
    { endpoint: '/api/jobs/[id]', ...(endpointStatus.jobsHealth || { wired: true, reachable: false, degraded: false, detail: '' }) },
    { endpoint: '/api/recommend-context', wired: true, reachable: true, degraded: false, detail: 'invoked during import/restore' },
    { endpoint: '/api/recommend', wired: true, reachable: true, degraded: false, detail: 'invoked at cell scope' },
    { endpoint: '/api/simulate', wired: true, reachable: true, degraded: false, detail: 'compat route preserved' },
    { endpoint: '/api/forecast', wired: restorationFlags.forecast, reachable: forecastState?.available !== false, degraded: forecastState?.available === false, detail: forecastState?.reason || '' },
    { endpoint: '/api/drift', wired: restorationFlags.drift, reachable: driftState?.available !== false, degraded: driftState?.available === false, detail: driftState?.reason || '' },
  ]), [endpointStatus, dataMode, peakPayload, restorationFlags.forecast, restorationFlags.drift, forecastState?.available, forecastState?.reason, driftState?.available, driftState?.reason])

  let panel = null
  if (!data && !loadError) panel = <div className="panel-shell"><div className="loading-block">Chargement des donnees runtime NetVision et de la geographie administrative...</div></div>
  else if (loadError) panel = <div className="panel-shell"><div className="empty-state warning">{loadError}. Verifiez les fichiers de geographie administrative.</div></div>
  else panel = <CockpitPanel activeTab={activeTab} onTabChange={setActiveTab} adminToolsEnabled={adminToolsEnabled} scope={scope} data={data} dataMode={dataMode} onDataModeChange={changeDataMode} nationalSummary={nationalSummary} governorateSummary={governorateSummary} delegationSummary={delegationSummary} summary={currentSummary} governorateRows={governorateRows} previousGovernorateRows={previousGovernorateRows} delegationRows={delegationRows} delegationVariationRows={delegationVariationRows} selectedGovernorate={selectedGovernorate} selectedDelegation={selectedDelegation} selectedCell={selectedCell} siteRows={siteRows} scopedCells={scopedCells} alerts={alerts} metric={metric} currentTime={data.currentTimeEntry} filters={filters} onFilterChange={updateFilters} bands={bands} onSelectGovernorate={selectGovernorate} onSelectDelegation={selectDelegation} onSelectCell={selectCell} reconciliation={data.reconciliation} peakRows={peakRows} peakPayload={peakPayload} busyMetric={busyMetric} onBusyMetricChange={setBusyMetric} onPeakRowSelect={selectPeakRow} backendHealth={backendHealth} workerState={workerState} jobsHealth={jobsHealth} importState={importState} endpointCoverage={endpointCoverage} onImportFile={handleImportFile} onImportTypeChange={(importType) => setImportState((prev) => ({ ...prev, importType }))} onImportProfileChange={(profileId) => setImportState((prev) => ({ ...prev, selectedProfileId: profileId }))} onRestoreRuntime={restoreRuntimeData} onExportJson={exportScopedJson} onExportReport={exportReport} whyCritical={whyCritical} dataQuality={dataQuality} sliceDelta={sliceDelta} forecastState={forecastState} driftState={driftState} watchlist={watchlist} savedViews={savedViews} onRestoreView={restoreView} onRemoveView={removeView} />

  return (
    <div className={`app-shell ${focusMode ? 'focus-mode' : ''} ${theme === 'dark' ? 'theme-dark' : ''}`}>
      <a href="#main-content" className="skip-link">Aller au contenu principal</a>
      <TopHeader metricMode={metricMode} metricModes={METRIC_MODES} onMetricModeChange={setMetricMode} query={query} onQueryChange={setQuery} searchResults={searchResults} onSearchSelect={selectSearchResult} dataMode={dataMode} onSecondaryPanel={setActiveTab} adminToolsEnabled={adminToolsEnabled} theme={theme} onToggleTheme={() => setTheme((t) => t === 'dark' ? 'light' : 'dark')} focusMode={focusMode} onToggleFocus={() => setFocusMode((v) => !v)} onRunDemo={() => setDemoStep(0)} role={interfaceRole} onRoleChange={changeInterfaceRole} showRoleSwitch={showRoleSwitch} />
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
          <div className="scope-footer map-control-strip"><span>{currentSummary.observed_cells || 0} cellules</span><span>{data?.currentTimeEntry?.timestamp || 'Aucune tranche'}</span>{(scope.level === 'delegation' || scope.level === 'cell') ? <button data-testid="toggle-heatmap" onClick={() => setMapControls((v) => ({ ...v, heatmap: !v.heatmap }))}>{mapControls.heatmap ? 'Voir les sites' : 'Voir la chaleur'}</button> : null}{(scope.level === 'delegation' || scope.level === 'cell') ? <button data-testid="toggle-labels" onClick={() => setMapControls((v) => ({ ...v, labels: !v.labels }))}>{mapControls.labels ? 'Masquer libelles' : 'Afficher libelles'}</button> : null}{selectedCell ? <button className="ghost-button" onClick={pinSelectedCell}>Epingler cellule</button> : null}<button className="ghost-button" onClick={saveCurrentView}>Sauvegarder vue</button></div>
        </section>
        <aside className="insight-column">{panel}</aside>
      </main>
      {demoStep !== null ? <div className="transition-overlay">Parcours de demonstration</div> : transitionLabel(scope) ? <div className="transition-overlay">{transitionLabel(scope)}</div> : null}
    </div>
  )
}
