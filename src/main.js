import { useMemo, useState, useEffect } from 'react'
import TopHeader from './components/dashboard/TopHeader'
import Breadcrumb from './components/dashboard/Breadcrumb'
import CockpitRail from './components/dashboard/CockpitRail'
import TimelineBar from './components/dashboard/TimelineBar'
import TunisiaMap from './components/admin-map/TunisiaMap'
import CockpitPanel from './components/panels/CockpitPanel'
import { initialAdminScope, backToNational, backToGovernorate, backToDelegation } from './admin/adminScope'
import { fetchJson, loadDashboardData } from './admin/adminData'
import { aggregateNationalScope, aggregateGovernorateScope, aggregateDelegationScope, buildCells, rankDelegations, rankGovernorates, METRIC_MODES } from './admin/adminAggregation'
import { buildSearchIndex, searchAdmin } from './admin/adminSearch'
import { transitionLabel } from './admin/adminTransitions'
import { DEFAULT_FILTERS, applyCellFilters, buildSiteSummaries, summarizeAlerts } from './admin/adminOps'
import { buildAutoMapping, callImportWorker } from './admin/importWorker'

export default function NetVisionDashboard() {
  const [data, setData] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [scope, setScope] = useState(initialAdminScope)
  const [metricMode, setMetricMode] = useState('congestion_rate')
  const [focusMode, setFocusMode] = useState(false)
  const [query, setQuery] = useState('')
  const [activeTab, setActiveTab] = useState('triage')
  const [filters, setFilters] = useState(DEFAULT_FILTERS)
  const [layerVisibility, setLayerVisibility] = useState({ delegations: true, sites: true })
  const [timeIndex, setTimeIndex] = useState(0)
  const [drift, setDrift] = useState({ status: { available: null, reason: '' }, alerts: [] })
  const [peakRows, setPeakRows] = useState([])
  const [backendHealth, setBackendHealth] = useState(null)
  const [workerState, setWorkerState] = useState('ready')
  const [theme, setTheme] = useState('light')
  const [importState, setImportState] = useState({ status: 'idle', fileName: '', importType: 'reference', preview: null, result: null, error: '' })
  const [exportRecommendationsState, setExportRecommendationsState] = useState({ status: 'idle', error: '', filename: '' })
  const [endpointStatus, setEndpointStatus] = useState({})
  const [driftUi, setDriftUi] = useState({ acknowledgedUnavailable: false, collapsed: false })
  const [dataMode, setDataMode] = useState('real')

  useEffect(() => {
    let cancelled = false
    fetchJson('/api/data-mode').then((payload) => !cancelled && setDataMode(payload.mode || 'real')).catch(() => {})
    loadDashboardData().then((payload) => { if (!cancelled) setData(payload) }).catch((err) => { if (!cancelled) setLoadError(err.message || String(err)) })
    fetchJson('/api/drift').then((payload) => !cancelled && setDrift({ status: { available: payload.available, reason: payload.reason || '' }, alerts: payload.alerts || [] })).catch((err) => !cancelled && setDrift({ status: { available: false, reason: err.message }, alerts: [] }))
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
      const pairs = await Promise.all([
        check('data', '/api/data/stats.json'),
        check('drift', '/api/drift'),
        check('peakHours', '/api/peak-hours'),
        check('backend', '/api/backend-health'),
        check('jobsHealth', '/api/jobs-health'),
        check('export', '/api/recommendations-export'),
      ])
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
  }, [])

  useEffect(() => {
    if (drift.status.available === false && !driftUi.acknowledgedUnavailable) {
      setDriftUi({ acknowledgedUnavailable: true, collapsed: true })
    }
  }, [drift.status.available, driftUi.acknowledgedUnavailable])

  async function reloadRuntimeData() {
    const payload = await loadDashboardData()
    setData(payload)
    setTimeIndex(0)
    setScope(initialAdminScope)
    setActiveTab('triage')
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

  async function loadTimeSlice(index) {
    if (!data?.timeIndex?.[index]) return
    const entry = data.timeIndex[index]
    setTimeIndex(index)
    if (!entry.filename) return
    try {
      const slice = await fetchJson(`/api/data/time_data/${encodeURIComponent(entry.filename)}`)
      setData((prev) => ({ ...prev, currentTimeEntry: entry, observations: slice?.observations || {} }))
    } catch (err) {
      setLoadError(err.message || String(err))
    }
  }

  const cells = useMemo(() => data ? buildCells(data.baseline, data.observations, data.adminCellIndex) : [], [data])
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
  const governorateRows = useMemo(() => data ? rankGovernorates(filteredCells, data.registry, metricMode) : [], [filteredCells, data, metricMode])
  const delegationRows = useMemo(() => data ? rankDelegations(filteredCells, data.registry, scope.governorateId, metricMode) : [], [filteredCells, data, scope.governorateId, metricMode])
  const allDelegationRows = useMemo(() => data ? rankDelegations(filteredCells, data.registry, null, metricMode) : [], [filteredCells, data, metricMode])
  const searchIndex = useMemo(() => data ? buildSearchIndex(data.registry, cells) : [], [data, cells])
  const searchResults = useMemo(() => searchAdmin(query, searchIndex), [query, searchIndex])

  const selectedGovernorate = useMemo(() => data?.registry?.governorates?.find((gov) => gov.gov_id === scope.governorateId) || null, [data, scope.governorateId])
  const selectedDelegation = useMemo(() => data?.registry?.delegations?.find((deleg) => deleg.deleg_id === scope.delegationId) || null, [data, scope.delegationId])
  const selectedCell = useMemo(() => cells.find((cell) => cell.cell_name === scope.selectedCellName) || null, [cells, scope.selectedCellName])
  const governorateSummary = useMemo(() => aggregateGovernorateScope(filteredCells, scope.governorateId), [filteredCells, scope.governorateId])
  const delegationSummary = useMemo(() => aggregateDelegationScope(filteredCells, scope.delegationId), [filteredCells, scope.delegationId])
  const currentSummary = scope.level === 'delegation' || scope.level === 'cell' ? delegationSummary : scope.level === 'governorate' ? governorateSummary : nationalSummary
  const scopedPeakRows = useMemo(() => peakRows.filter((row) => scopedCellsRaw.some((cell) => cell.cell_name === row.cell_name)), [peakRows, scopedCellsRaw])

  function selectGovernorate(raw) {
    const gov = raw.gov_id ? raw : data?.registry?.governorates?.find((item) => item.gov_id === raw.id || item.gov_name === raw.name || item.gov_name === raw.gov_name)
    if (!gov) return
    setActiveTab('triage')
    setScope({ ...initialAdminScope, level: 'governorate', governorateId: gov.gov_id, governorateName: gov.gov_name, transitionState: 'focusing-governorate' })
    window.setTimeout(() => setScope((prev) => prev.governorateId === gov.gov_id ? { ...prev, transitionState: 'idle' } : prev), 900)
  }

  function selectDelegation(raw) {
    const deleg = raw.deleg_id ? raw : data?.registry?.delegations?.find((item) => item.deleg_id === raw.id || item.deleg_name === raw.name || item.deleg_name === raw.deleg_name)
    if (!deleg) return
    setActiveTab('operations')
    setScope({ ...initialAdminScope, level: 'delegation', governorateId: deleg.gov_id, governorateName: deleg.gov_name, delegationId: deleg.deleg_id, delegationName: deleg.deleg_name, transitionState: 'focusing-delegation' })
    window.setTimeout(() => setScope((prev) => prev.delegationId === deleg.deleg_id ? { ...prev, transitionState: 'idle' } : prev), 900)
  }

  function selectCell(cellName) {
    const cell = cells.find((item) => item.cell_name === cellName)
    if (!cell?.admin) return
    setActiveTab('actions')
    setScope({ ...initialAdminScope, level: 'cell', governorateId: cell.admin.gov_id, governorateName: cell.admin.gov_name, delegationId: cell.admin.deleg_id, delegationName: cell.admin.deleg_name, selectedSite: cell.site_name, selectedCellName: cell.cell_name, transitionState: 'idle' })
  }

  function selectSearchResult(item) {
    setQuery('')
    if (item.type === 'governorate') selectGovernorate(item.gov)
    if (item.type === 'delegation') selectDelegation(item.deleg)
    if (item.type === 'site' || item.type === 'cell') selectCell(item.cell.cell_name)
  }

  function updateFilters(patch) {
    setFilters((prev) => ({ ...prev, ...patch }))
  }

  function exportScopedJson() {
    const blob = new Blob([JSON.stringify({ scope, timestamp: data?.currentTimeEntry, cells: scopedCells }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'netvision-scoped-export.json'
    a.click()
    URL.revokeObjectURL(url)
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
    reloadRuntimeData().then(() => { setDriftUi({ acknowledgedUnavailable: false, collapsed: false }); fetch('/api/recommend-context', { method: 'DELETE' }).catch(() => {}) }).catch((err) => setLoadError(err.message || String(err)))
  }

  function exportReport() {
    const lines = [`NetVision scoped report`, `Scope: ${scope.level}`, `Label: ${scope.delegationName || scope.governorateName || 'Tunisia'}`, `Timestamp: ${data?.currentTimeEntry?.timestamp || 'N/A'}`, `Cells: ${currentSummary.observed_cells}`, `Congested: ${currentSummary.congested_cells}`, `Avg PRB: ${currentSummary.avg_prb.toFixed(1)}%`]
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'netvision-scoped-report.txt'
    a.click()
    URL.revokeObjectURL(url)
  }

  async function exportRecommendationsCsv() {
    try {
      setExportRecommendationsState({ status: 'downloading', error: '', filename: '' })
      const ts = typeof data?.currentTimeEntry?.timestamp === 'string' ? data.currentTimeEntry.timestamp.trim() : ''
      const query = ts ? `?timestamp=${encodeURIComponent(ts)}` : ''
      const res = await fetch(`/api/recommendations-export${query}`)
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}))
        throw new Error(payload?.error || payload?.detail || `recommendations-export returned ${res.status}`)
      }
      const blob = await res.blob()
      const contentDisposition = res.headers.get('content-disposition') || ''
      const match = contentDisposition.match(/filename="?([^"]+)"?/)
      const filename = match?.[1] || 'recommendations_export.csv'
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
      setExportRecommendationsState({ status: 'done', error: '', filename })
    } catch (err) {
      setExportRecommendationsState({ status: 'error', error: err.message || String(err), filename: '' })
    }
  }

  const endpointCoverage = useMemo(() => ([
    { endpoint: '/api/data/*', ...(endpointStatus.data || { wired: true, reachable: false, degraded: false, detail: '' }) },
    { endpoint: '/api/data-mode', wired: true, reachable: true, degraded: false, detail: dataMode },
    { endpoint: '/api/drift', ...(endpointStatus.drift || { wired: true, reachable: false, degraded: false, detail: '' }) },
    { endpoint: '/api/peak-hours', ...(endpointStatus.peakHours || { wired: true, reachable: false, degraded: false, detail: '' }) },
    { endpoint: '/api/backend-health', ...(endpointStatus.backend || { wired: true, reachable: false, degraded: false, detail: '' }) },
    { endpoint: '/api/jobs', ...(endpointStatus.jobsHealth || { wired: true, reachable: false, degraded: false, detail: '' }) },
    { endpoint: '/api/jobs/[id]', ...(endpointStatus.jobsHealth || { wired: true, reachable: false, degraded: false, detail: '' }) },
    { endpoint: '/api/recommendations-export', ...(endpointStatus.export || { wired: true, reachable: false, degraded: false, detail: '' }) },
    { endpoint: '/api/recommend-context', wired: true, reachable: true, degraded: false, detail: 'invoked during import/restore' },
    { endpoint: '/api/recommend', wired: true, reachable: true, degraded: false, detail: 'invoked at cell scope' },
    { endpoint: '/api/simulate', wired: true, reachable: true, degraded: false, detail: 'compat route preserved' },
  ]), [endpointStatus, dataMode])

  let panel = null
  if (!data && !loadError) panel = <div className="panel-shell"><div className="loading-block">Loading NetVision runtime data and administrative geography...</div></div>
  else if (loadError) panel = <div className="panel-shell"><div className="empty-state warning">{loadError}. If admin boundary files are missing, run scripts/prepare_admin_boundaries.py.</div></div>
  else panel = <CockpitPanel activeTab={activeTab} scope={scope} data={data} dataMode={dataMode} onDataModeChange={changeDataMode} nationalSummary={nationalSummary} governorateSummary={governorateSummary} delegationSummary={delegationSummary} summary={currentSummary} governorateRows={governorateRows} delegationRows={delegationRows} selectedGovernorate={selectedGovernorate} selectedDelegation={selectedDelegation} selectedCell={selectedCell} siteRows={siteRows} scopedCells={scopedCells} alerts={alerts} metric={metric} currentTime={data.currentTimeEntry} filters={filters} onFilterChange={updateFilters} bands={bands} onSelectGovernorate={selectGovernorate} onSelectDelegation={selectDelegation} onSelectCell={selectCell} reconciliation={data.reconciliation} driftStatus={drift.status} driftAlerts={drift.alerts} driftUi={driftUi} onExpandDrift={() => setDriftUi((prev) => ({ ...prev, collapsed: false }))} peakRows={scopedPeakRows} backendHealth={backendHealth} workerState={workerState} importState={importState} exportRecommendationsState={exportRecommendationsState} endpointCoverage={endpointCoverage} onImportFile={handleImportFile} onImportTypeChange={(importType) => setImportState((prev) => ({ ...prev, importType }))} onRestoreRuntime={restoreRuntimeData} onExportJson={exportScopedJson} onExportReport={exportReport} onExportRecommendationsCsv={exportRecommendationsCsv} />

  return (
    <div className={`app-shell ${focusMode ? 'focus-mode' : ''} ${theme === 'dark' ? 'theme-dark' : ''}`}>
      <a href="#main-content" className="skip-link">Skip to main content</a>
      <TopHeader theme={theme} onToggleTheme={() => setTheme((value) => value === 'dark' ? 'light' : 'dark')} metricMode={metricMode} metricModes={METRIC_MODES} onMetricModeChange={setMetricMode} focusMode={focusMode} onToggleFocus={() => setFocusMode((v) => !v)} query={query} onQueryChange={setQuery} searchResults={searchResults} onSearchSelect={selectSearchResult} />
      <div className="sr-only" aria-live="polite">{`Current scope ${scope.level}${scope.governorateName ? `, ${scope.governorateName}` : ''}${scope.delegationName ? `, ${scope.delegationName}` : ''}${scope.selectedCellName ? `, ${scope.selectedCellName}` : ''}`}</div>
      <main id="main-content" className="command-layout cockpit-layout">
        <CockpitRail activeTab={activeTab} onTabChange={setActiveTab} alertCount={alerts.length} />
        <section className="map-column">
          <Breadcrumb scope={scope} onNational={() => { setActiveTab('triage'); setScope(backToNational()) }} onGovernorate={() => { setActiveTab('triage'); setScope(backToGovernorate(scope)) }} onDelegation={() => { setActiveTab('operations'); setScope(backToDelegation(scope)) }} />
          <TimelineBar timeIndex={data?.timeIndex || []} currentIndex={timeIndex} onChange={loadTimeSlice} onPrev={() => loadTimeSlice(Math.max(0, timeIndex - 1))} onNext={() => loadTimeSlice(Math.min((data?.timeIndex?.length || 1) - 1, timeIndex + 1))} />
          {data ? <TunisiaMap governoratesGeo={data.governorates} delegationsGeo={data.delegations} governorateRows={governorateRows} delegationRows={allDelegationRows} cells={cells} filteredCells={filteredCells} scope={scope} metricMode={metricMode} metric={metric} layerVisibility={layerVisibility} onGovernorateClick={selectGovernorate} onDelegationClick={selectDelegation} onCellClick={selectCell} /> : <div className="map-card skeleton-map" />}
          <div className="scope-footer"><span>Mode: {dataMode}</span><span>Scope: {scope.level}</span><span>{currentSummary.observed_cells || 0} scoped cells</span><span>{data?.currentTimeEntry?.timestamp || 'No time slice'}</span><button data-testid="toggle-sites" onClick={() => setLayerVisibility((v) => ({ ...v, sites: !v.sites }))}>Sites {layerVisibility.sites ? 'on' : 'off'}</button><button data-testid="toggle-delegations" onClick={() => setLayerVisibility((v) => ({ ...v, delegations: !v.delegations }))}>Delegations {layerVisibility.delegations ? 'on' : 'off'}</button></div>
        </section>
        <aside className="insight-column">{panel}</aside>
      </main>
      {transitionLabel(scope) ? <div className="transition-overlay">{transitionLabel(scope)}</div> : null}
    </div>
  )
}
