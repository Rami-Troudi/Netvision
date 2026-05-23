import { useEffect, useMemo, useRef, useState } from 'react'
import KpiCard from '../dashboard/KpiCard'
import RecommendationCard from './RecommendationCard'
import SimulationImpactCard from './SimulationImpactCard'
import { diagnoseCell } from '../../admin/adminAggregation'
import { SIMULATOR_ACTIONS, paramsForSimulatorAction } from '../../utils/v2Contracts.mjs'
import { fetchRecommendations, pollJobUntilTerminal, queueSimulation } from '../../services/operationalApi.mjs'

export default function CellOperationalPanel({ cell, currentTime, queueReady = false, queueDetail = '' }) {
  const [recommendations, setRecommendations] = useState([])
  const [recState, setRecState] = useState('idle')
  const [action, setAction] = useState('add_carrier')
  const [simulation, setSimulation] = useState(null)
  const [simState, setSimState] = useState('idle')
  const [jobs, setJobs] = useState([])
  const [activeJobId, setActiveJobId] = useState('')
  const [siteType, setSiteType] = useState('macro')
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

  useEffect(() => {
    let cancelled = false
    async function loadRecommendation() {
      if (!cell?.cell_name) return
      setRecState('loading')
      setRecommendations([])
      try {
        const { recommendations: mapped } = await fetchRecommendations({ cell, currentTime })
        if (!cancelled) {
          setRecommendations(mapped)
          if (mapped[0]?.simAction) setAction(mapped[0].simAction)
          setRecState('ready')
        }
      } catch (err) {
        if (!cancelled) setRecState(err.message || 'Recommandation indisponible')
      }
    }
    loadRecommendation()
    return () => { cancelled = true }
  }, [cell, currentTime])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const selectedAction = useMemo(() => SIMULATOR_ACTIONS.find((item) => item.id === action), [action])

  async function runQueuedSimulation(nextAction = action, overrideParams = null) {
    if (!cell?.cell_name) return
    if (!queueReady) {
      setSimState(queueDetail || 'Simulation indisponible.')
      return
    }
    setSimState('queued')
    setSimulation(null)
    try {
      const queued = await queueSimulation({ cell, action: nextAction, currentTime, params: overrideParams || paramsForSimulatorAction(nextAction, cell) })
      const jobId = String(queued?.jobId || '').trim()
      if (!jobId) throw new Error('Identifiant job manquant')
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
      const finalJob = await pollJobUntilTerminal(jobId, {
        onUpdate: (payload) => upsertJob({
          jobId,
          status: payload.status || 'pending',
          updated_at: payload.updated_at || '',
          error: payload.error || '',
          result: payload.result || null,
        }),
      })
      if (!mountedRef.current || !finalJob) return
      if (finalJob.status === 'failed') throw new Error(finalJob.error || 'Echec simulation en file')
      setSimulation(finalJob.result || null)
      setSimState('complete')
    } catch (err) {
      if (!mountedRef.current) return
      setSimState(err.message || 'Echec simulation en file')
    }
  }

  function runSitePlanning() {
    const siteAction = siteType === 'rooftop' ? 'new_site' : 'add_site'
    return runQueuedSimulation(siteAction, { siteType })
  }

  function jobStatusLabel(status) {
    return {
      pending: 'Preparation',
      queued: 'Preparation',
      running: 'Simulation en cours',
      done: 'Resultat pret',
      completed: 'Resultat pret',
      failed: 'Echec',
    }[status] || 'Suivi en cours'
  }

  return (
    <section className="panel-shell cell-panel" aria-busy={recState === 'loading' || simState === 'queued' || simState === 'running'}>
      <div className="panel-heading"><div><p>Action cellule</p><h1>{cell?.cell_name || 'Selectionner cellule'}</h1></div><span className="live-pill">Correction simulee</span></div>
      <div className="kpi-grid compact">
        <KpiCard label="Charge PRB" value={cell?.prb_load || 0} unit="%" />
        <KpiCard label="Debit" value={cell?.throughput || 0} unit="Mbps" />
        <KpiCard label="CQI" value={cell?.cqi || 0} />
        <KpiCard label="Utilisateurs actifs" value={cell?.active_users || 0} />
        <KpiCard label="TA" value={cell?.ta || 0} />
        <KpiCard label="Sante" value={cell?.health || 0} unit="%" />
      </div>
      <div className="diagnosis-box"><strong>Diagnostic :</strong> {diagnoseCell(cell)}</div>
      <div className="section-title">Action recommandee</div>
      {recState === 'loading' ? <div className="empty-state">Recherche de la meilleure action...</div> : null}
      {typeof recState === 'string' && !['idle', 'loading', 'ready'].includes(recState) ? <div className="empty-state warning">{recState}</div> : null}
      <div className="recommendation-list">{recommendations.length ? recommendations.slice(0, 1).map((rec, idx) => <RecommendationCard key={idx} recommendation={rec} onSimulate={(simAction) => { setAction(simAction); runQueuedSimulation(simAction) }} />) : recState === 'ready' ? <div className="empty-state" role="note">Aucune action automatique fiable pour cette cellule.</div> : null}</div>
      <div className="simulation-control">
        <label htmlFor="sim-action" className="sr-only">Action simulation</label>
        <select id="sim-action" value={action} onChange={(e) => setAction(e.target.value)}>{SIMULATOR_ACTIONS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
        <button data-testid="queue-simulation" aria-describedby={!queueReady ? 'queue-unavailable-reason' : undefined} className="primary-cta" disabled={!queueReady} onClick={() => runQueuedSimulation(action)}>Simuler : {selectedAction?.label || action}</button>
      </div>
      {!queueReady ? <div id="queue-unavailable-reason" className="empty-state warning" role="status">{queueDetail || 'Simulation indisponible.'}</div> : null}
      {simState === 'queued' ? <div className="empty-state" role="status">Preparation de la simulation...</div> : null}
      {simState === 'running' ? <div className="empty-state" role="status">Simulation en cours...</div> : null}
      {simState !== 'idle' && simState !== 'complete' && simState !== 'queued' && simState !== 'running' ? <div className="empty-state warning">{simState}</div> : null}
      <div className="site-table-card site-planning-card">
        <div className="section-title">Planification site <span>soulagement capacite</span></div>
        <label htmlFor="site-planning-type">Type de site planifie</label>
        <select id="site-planning-type" value={siteType} onChange={(event) => setSiteType(event.target.value)}>
          <option value="macro">Site macro de capacite</option>
          <option value="rooftop">Site urbain rooftop</option>
        </select>
        <button data-testid="site-planning-run" className="primary-cta" disabled={!queueReady} onClick={runSitePlanning}>Lancer planification site</button>
      </div>
      <div className="section-title">Historique simulations</div>
      {jobs.length ? <div className="job-queue" role="status" aria-live="polite">{jobs.map((job) => <div key={job.jobId} className="job-row"><strong>{SIMULATOR_ACTIONS.find((item) => item.id === job.action)?.label || 'Simulation'}</strong><span>{jobStatusLabel(job.status)}</span><em>{job.error || 'Resultat en attente'}</em></div>)}</div> : <div className="empty-state" role="note">Aucune simulation lancee sur cette cellule.</div>}
      {simState === 'complete' ? <SimulationImpactCard result={simulation} /> : null}
    </section>
  )
}
