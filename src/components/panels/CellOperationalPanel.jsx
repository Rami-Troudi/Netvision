import { useEffect, useMemo, useRef, useState } from 'react'
import KpiCard from '../dashboard/KpiCard'
import RecommendationCard from './RecommendationCard'
import SimulationImpactCard from './SimulationImpactCard'
import { diagnoseCell } from '../../admin/adminAggregation'

const SUPPORTED_ACTIONS = [
  { id: 'tilt', label: 'Antenna Tilt' },
  { id: 'add_carrier', label: 'Add Carrier' },
  { id: 'redistribute', label: 'Redistribute Load' },
  { id: 'add_sector', label: 'Add Sector' },
  { id: 'new_site', label: 'New Site' },
  { id: 'add_site', label: 'Add Site' },
]

const ACTION_LABEL_TO_ID = {
  'Antenna Tilt': 'tilt',
  Tilt: 'tilt',
  'Add Carrier': 'add_carrier',
  'Add Band': 'add_carrier',
  'Load Balancing': 'redistribute',
  Redistribute: 'redistribute',
  'Actions on Neighbors': 'redistribute',
  'Add Sector': 'add_sector',
  'New Site': 'new_site',
  'Add Site': 'add_site',
}

const TERMINAL_JOB_STATES = new Set(['done', 'failed'])

function wait(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

export default function CellOperationalPanel({ cell, currentTime, queueReady = false, queueDetail = '' }) {
  const [recommendations, setRecommendations] = useState([])
  const [recState, setRecState] = useState('idle')
  const [action, setAction] = useState('add_carrier')
  const [simulation, setSimulation] = useState(null)
  const [simState, setSimState] = useState('idle')
  const [jobs, setJobs] = useState([])
  const [activeJobId, setActiveJobId] = useState('')
  const mountedRef = useRef(true)

  function upsertJob(jobPatch) {
    setJobs((prev) => {
      const idx = prev.findIndex((item) => item.jobId === jobPatch.jobId)
      if (idx === -1) return [{ ...jobPatch }, ...prev].slice(0, 8)
      const next = [...prev]
      next[idx] = { ...next[idx], ...jobPatch }
      return next
    })
  }

  function buildParams(nextAction) {
    if (nextAction === 'tilt') return { degrees: 2 }
    if (nextAction === 'redistribute') return { ratio: 0.15 }
    if (nextAction === 'add_carrier') return { band: cell?.frequency_band || 3 }
    return {}
  }

  function buildSimulationPayload(nextAction) {
    return {
      cell_name: cell?.cell_name,
      action: nextAction,
      params: buildParams(nextAction),
      time_entry: currentTime || {},
      mode: 'fast',
    }
  }

  async function pollJobUntilTerminal(jobId) {
    const started = Date.now()
    const timeoutMs = 60_000
    while (Date.now() - started < timeoutMs) {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`)
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(payload?.error || `jobs status returned ${res.status}`)
      }
      if (!mountedRef.current) return null
      upsertJob({
        jobId,
        status: payload.status || 'pending',
        updated_at: payload.updated_at || '',
        error: payload.error || '',
        result: payload.result || null,
      })
      if (TERMINAL_JOB_STATES.has(payload.status)) return payload
      await wait(1500)
    }
    throw new Error('Job polling timed out')
  }

  useEffect(() => {
    let cancelled = false
    async function loadRecommendation() {
      if (!cell?.cell_name) return
      setRecState('loading')
      setRecommendations([])
      try {
        const res = await fetch('/api/recommend', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cell_name: cell.cell_name, prb_load: cell.prb_load, throughput: cell.throughput, active_users: cell.active_users, cqi: cell.cqi, timestamp: currentTime?.timestamp }),
        })
        const payload = await res.json()
        if (!res.ok) throw new Error(payload?.detail || payload?.error || `recommend returned ${res.status}`)
        const raw = Array.isArray(payload?.recommended_actions) ? payload.recommended_actions : []
        const mapped = raw.map((item) => ({ ...item, simAction: ACTION_LABEL_TO_ID[item.action] || item.action })).filter((item) => SUPPORTED_ACTIONS.some((a) => a.id === item.simAction))
        if (!cancelled) {
          setRecommendations(mapped)
          if (mapped[0]?.simAction) setAction(mapped[0].simAction)
          setRecState('ready')
        }
      } catch (err) {
        if (!cancelled) setRecState(err.message || 'Recommendation unavailable')
      }
    }
    loadRecommendation()
    return () => { cancelled = true }
  }, [cell?.cell_name, cell?.prb_load, cell?.throughput, cell?.active_users, cell?.cqi, currentTime?.timestamp])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const selectedAction = useMemo(() => SUPPORTED_ACTIONS.find((item) => item.id === action), [action])

  async function runQueuedSimulation(nextAction = action) {
    if (!cell?.cell_name) return
    if (!queueReady) {
      setSimState(queueDetail || 'Queue unavailable. Redis/worker must be running.')
      return
    }
    setSimState('queued')
    setSimulation(null)
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildSimulationPayload(nextAction)),
      })
      const queued = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(queued?.error || `jobs returned ${res.status}`)
      const jobId = String(queued?.jobId || '').trim()
      if (!jobId) throw new Error('Job id missing from queue response')
      setActiveJobId(jobId)
      upsertJob({
        jobId,
        action: nextAction,
        status: queued?.status || 'pending',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        error: '',
        result: null,
      })
      setSimState('running')
      const finalJob = await pollJobUntilTerminal(jobId)
      if (!mountedRef.current || !finalJob) return
      if (finalJob.status === 'failed') {
        throw new Error(finalJob.error || 'Queued simulation failed')
      }
      setSimulation(finalJob.result || null)
      setSimState('complete')
    } catch (err) {
      if (!mountedRef.current) return
      setSimState(err.message || 'Queued simulation failed')
    }
  }

  return (
    <section className="panel-shell cell-panel" aria-busy={recState === 'loading' || simState === 'queued' || simState === 'running'}>
      <div className="panel-heading"><div><p>Cell operational view</p><h1>{cell?.cell_name || 'Select Cell'}</h1></div><span className="live-pill">Recommendation enabled</span></div>
      <div className="kpi-grid compact">
        <KpiCard label="PRB Load" value={cell?.prb_load || 0} unit="%" />
        <KpiCard label="Throughput" value={cell?.throughput || 0} unit="Mbps" />
        <KpiCard label="CQI" value={cell?.cqi || 0} />
        <KpiCard label="Active Users" value={cell?.active_users || 0} />
        <KpiCard label="TA" value={cell?.ta || 0} />
        <KpiCard label="Health" value={cell?.health || 0} unit="%" />
      </div>
      <div className="diagnosis-box"><strong>Diagnosis:</strong> {diagnoseCell(cell)}</div>
      <div className="section-title">Backend Recommendations</div>
      {recState === 'loading' ? <div className="empty-state">Requesting FastAPI recommendation...</div> : null}
      {typeof recState === 'string' && !['idle', 'loading', 'ready'].includes(recState) ? <div className="empty-state warning">{recState}</div> : null}
      <div className="recommendation-list">{recommendations.length ? recommendations.map((rec, idx) => <RecommendationCard key={idx} recommendation={rec} onSimulate={(simAction) => { setAction(simAction); runQueuedSimulation(simAction) }} />) : recState === 'ready' ? <div className="empty-state" role="note">No simulator-supported backend action was returned for this cell.</div> : null}</div>
      <div className="simulation-control">
        <label htmlFor="sim-action" className="sr-only">Simulation action</label>
        <select id="sim-action" value={action} onChange={(e) => setAction(e.target.value)}>{SUPPORTED_ACTIONS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
        <button data-testid="queue-simulation" aria-describedby={!queueReady ? 'queue-unavailable-reason' : undefined} className="primary-cta" disabled={!queueReady} onClick={() => runQueuedSimulation(action)}>Queue {selectedAction?.label || action}</button>
      </div>
      {!queueReady ? <div id="queue-unavailable-reason" className="empty-state warning" role="status">Queue-only mode is enabled. {queueDetail || 'Redis and job worker are required.'}</div> : null}
      {simState === 'queued' ? <div className="empty-state" role="status">Submitting queued simulation job...</div> : null}
      {simState === 'running' ? <div className="empty-state" role="status">Polling job {activeJobId || '...'}...</div> : null}
      {simState !== 'idle' && simState !== 'complete' && simState !== 'queued' && simState !== 'running' ? <div className="empty-state warning">{simState}</div> : null}
      <div className="section-title">Job Queue</div>
      {jobs.length ? <div className="job-queue" role="status" aria-live="polite">{jobs.map((job) => <div key={job.jobId} className="job-row"><strong>{job.action || 'simulate'}</strong><span>{job.status}</span><em>{job.jobId.slice(0, 8)}{job.error ? ` · ${job.error}` : ''}</em></div>)}</div> : <div className="empty-state" role="note">No simulation jobs queued yet.</div>}
      {simState === 'complete' ? <SimulationImpactCard result={simulation} /> : null}
    </section>
  )
}
