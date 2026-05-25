import { useEffect, useMemo, useRef, useState } from 'react'
import KpiCard from '../dashboard/KpiCard'
import RecommendationCard from './RecommendationCard'
import SimulationImpactCard from './SimulationImpactCard'
import { diagnoseCell } from '../../admin/adminAggregation'
import { SIMULATOR_ACTIONS, SIMULATION_FIDELITY_LEVELS, paramsForSimulatorAction } from '../../utils/v2Contracts.mjs'
import { fetchRecommendations, pollJobUntilTerminal, queueSimulation } from '../../services/operationalApi.mjs'

export default function CellOperationalPanel({ cell, currentTime, queueReady = false, queueDetail = '', disabledActions = [] }) {
  const [recommendations, setRecommendations] = useState([])
  const [recState, setRecState] = useState('idle')
  const [action, setAction] = useState('add_carrier')
  const [simulation, setSimulation] = useState(null)
  const [simState, setSimState] = useState('idle')
  const [jobs, setJobs] = useState([])
  const [activeJobId, setActiveJobId] = useState('')
  const [params, setParams] = useState({})
  const [fidelityLevel, setFidelityLevel] = useState('operations_v2_calibrated')
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
        if (!cancelled) setRecState(err.message || 'Proposition opérationnelle indisponible')
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
  const disabledBySlo = useMemo(() => {
    const byAction = new Map((disabledActions || []).map((entry) => [entry.action, entry.reason || 'Action temporairement désactivée']))
    return byAction
  }, [disabledActions])

  useEffect(() => {
    setParams(paramsForSimulatorAction(action, cell))
  }, [action, cell])

  function updateParam(key, value) {
    setParams((prev) => ({ ...prev, [key]: value }))
  }

  function buildParamsForSubmit() {
    if (action === 'tilt') {
      return {
        degrees: Number(params.degrees ?? 2),
        power_delta_db: Number(params.power_delta_db ?? 0),
      }
    }
    if (action === 'redistribute') {
      const next = { ratio: Number(params.ratio ?? 0.15) }
      const target = String(params.target || '').trim()
      if (target) next.target = target
      return next
    }
    if (action === 'neighbor_optimization') {
      return { interference_relief: Number(params.interference_relief ?? 0.12) }
    }
    if (action === 'add_carrier') {
      return { band: normalizeBandValue(params.band ?? cell?.frequency_band ?? 3) }
    }
    if (action === 'add_sector') {
      return { target_sectors: Number(params.target_sectors ?? 4) || 4 }
    }
    return paramsForSimulatorAction(action, cell)
  }

  async function runQueuedSimulation(nextAction = action, overrideParams = null) {
    if (!cell?.cell_name) return
    if (disabledBySlo.has(nextAction)) {
      setSimState(`Action indisponible: ${disabledBySlo.get(nextAction)}`)
      return
    }
    if (!queueReady) {
      setSimState(queueDetail || 'Simulation indisponible.')
      return
    }
    setSimState('queued')
    setSimulation(null)
    try {
        const queued = await queueSimulation({ cell, action: nextAction, currentTime, params: overrideParams || buildParamsForSubmit(), fidelityLevel })
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
      if (finalJob.status === 'failed') throw new Error(finalJob.error || 'Échec simulation en file')
      setSimulation(finalJob.result || null)
      setSimState('complete')
    } catch (err) {
      if (!mountedRef.current) return
      setSimState(err.message || 'Échec simulation en file')
    }
  }

  function jobStatusLabel(status) {
    return {
      pending: 'Préparation scénario',
      queued: 'Préparation scénario',
      running: 'Simulation ns-3',
      adapting: 'Adaptation résultats',
      done: 'Résultat prêt',
      completed: 'Résultat prêt',
      failed: 'Échec',
    }[status] || 'Suivi en cours'
  }

  function jobDetailLabel(job) {
    if (job.error) return job.error
    if (job.status === 'done' || job.status === 'completed') return 'Impact disponible'
    if (job.status === 'failed') return 'Aucun résultat exploitable'
    return 'Résultat en attente'
  }

  return (
    <section className="panel-shell cell-panel" aria-busy={recState === 'loading' || simState === 'queued' || simState === 'running'}>
      <div className="panel-heading"><div><p>Action cellule</p><h1>{cell?.cell_name || 'Sélectionner cellule'}</h1></div><span className="live-pill">Correction simulée</span></div>
      <div className="kpi-grid compact">
        <KpiCard label="Charge PRB" value={cell?.prb_load || 0} unit="%" hint="Mesure la pression capacitaire radio." />
        <KpiCard label="Débit" value={cell?.throughput || 0} unit="Mbps" hint="Mesure l’expérience utilisateur." />
        <KpiCard label="CQI" value={cell?.cqi || 0} hint="Indique la qualité radio perçue." />
        <KpiCard label="Utilisateurs actifs" value={cell?.active_users || 0} hint="Montre la demande instantanée." />
        <KpiCard label="TA" value={cell?.ta || 0} hint="Aide à détecter bord de cellule/couverture." />
        <KpiCard label="Santé" value={cell?.health || 0} unit="%" />
      </div>
      <div className="diagnosis-box"><strong>Diagnostic :</strong> {diagnoseCell(cell)}</div>
      <div className="section-title">Action proposée</div>
      {recState === 'loading' ? <div className="empty-state">Recherche de la meilleure action...</div> : null}
      {typeof recState === 'string' && !['idle', 'loading', 'ready'].includes(recState) ? <div className="empty-state warning">{recState}</div> : null}
      <div className="recommendation-list">{recommendations.length ? recommendations.slice(0, 1).map((rec, idx) => <RecommendationCard key={idx} recommendation={rec} simulationReady={queueReady} unavailableReason={queueDetail} onSimulate={(simAction) => { setAction(simAction); runQueuedSimulation(simAction) }} />) : recState === 'ready' ? <div className="empty-state" role="note">Aucune proposition opérationnelle fiable pour cette cellule.</div> : null}</div>
      <div className="simulation-control">
        <label htmlFor="sim-action" className="sr-only">Action simulation</label>
        <select id="sim-action" value={action} onChange={(e) => setAction(e.target.value)}>{SIMULATOR_ACTIONS.map((item) => <option key={item.id} value={item.id} disabled={disabledBySlo.has(item.id)}>{item.label}{disabledBySlo.has(item.id) ? ' (indisponible)' : ''}</option>)}</select>
        <label htmlFor="sim-fidelity" className="sr-only">Niveau simulation</label>
        <select id="sim-fidelity" value={fidelityLevel} onChange={(e) => setFidelityLevel(e.target.value)}>{SIMULATION_FIDELITY_LEVELS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
        <button data-testid="queue-simulation" aria-describedby={!queueReady ? 'queue-unavailable-reason' : undefined} className="primary-cta" disabled={!queueReady || disabledBySlo.has(action)} onClick={() => runQueuedSimulation(action, buildParamsForSubmit())}>Simuler : {selectedAction?.label || action}</button>
      </div>
      {disabledBySlo.has(action) ? <div className="empty-state warning" role="status">Cette action est temporairement désactivée : {disabledBySlo.get(action)}</div> : null}
      <div className="simulation-params">
        {action === 'tilt' ? <>
          <label htmlFor="param-tilt-degrees">Angle inclinaison (degrés)</label>
          <input id="param-tilt-degrees" type="number" min="-10" max="10" step="1" value={params.degrees ?? 2} onChange={(e) => updateParam('degrees', e.target.value)} />
          <label htmlFor="param-tilt-power">Delta puissance (dB)</label>
          <input id="param-tilt-power" type="number" min="-3" max="3" step="0.5" value={params.power_delta_db ?? 0} onChange={(e) => updateParam('power_delta_db', e.target.value)} />
        </> : null}
        {action === 'redistribute' ? <>
          <label htmlFor="param-redist-ratio">Ratio rééquilibrage</label>
          <input id="param-redist-ratio" type="number" min="0.05" max="0.5" step="0.05" value={params.ratio ?? 0.15} onChange={(e) => updateParam('ratio', e.target.value)} />
          <label htmlFor="param-redist-target">Cellule cible (optionnel)</label>
          <input id="param-redist-target" type="text" value={params.target ?? ''} onChange={(e) => updateParam('target', e.target.value)} placeholder="ex: TN1158_c02" />
        </> : null}
        {action === 'neighbor_optimization' ? <>
          <label htmlFor="param-neigh-relief">Soulagement interférence</label>
          <input id="param-neigh-relief" type="number" min="0.05" max="0.3" step="0.01" value={params.interference_relief ?? 0.12} onChange={(e) => updateParam('interference_relief', e.target.value)} />
        </> : null}
        {action === 'add_carrier' ? <>
          <label htmlFor="param-carrier-band">Bande cible</label>
          <input id="param-carrier-band" type="text" value={String(params.band ?? cell?.frequency_band ?? 'L1800')} onChange={(e) => updateParam('band', e.target.value)} placeholder="ex: L1800, L800, 3" />
        </> : null}
        {action === 'add_sector' ? <>
          <label htmlFor="param-sector-target">Nombre secteurs cible</label>
          <input id="param-sector-target" type="number" min="4" max="6" step="1" value={params.target_sectors ?? 4} onChange={(e) => updateParam('target_sectors', e.target.value)} />
        </> : null}
      </div>
      {!queueReady ? <div id="queue-unavailable-reason" className="empty-state warning" role="status">{queueDetail || 'Simulation indisponible.'}</div> : null}
      {simState === 'queued' ? <div className="empty-state" role="status">Préparation du scénario...</div> : null}
      {simState === 'running' ? <div className="empty-state" role="status">Simulation en cours...</div> : null}
      {simState !== 'idle' && simState !== 'complete' && simState !== 'queued' && simState !== 'running' ? <div className="empty-state warning">{simState}</div> : null}
      <div className="section-title">Historique simulations</div>
      {jobs.length ? <div className="job-queue" role="status" aria-live="polite">{jobs.map((job) => <div key={job.jobId} className="job-row"><strong>{SIMULATOR_ACTIONS.find((item) => item.id === job.action)?.label || 'Simulation'}</strong><span>{jobStatusLabel(job.status)}</span><em>{jobDetailLabel(job)}</em></div>)}</div> : <div className="empty-state" role="note">Aucune simulation lancée sur cette cellule.</div>}
      {simState === 'complete' ? <SimulationImpactCard result={simulation} /> : null}
    </section>
  )
}

function normalizeBandValue(raw) {
  const text = String(raw ?? '').trim().toUpperCase()
  if (!text) return 3
  if (text === 'L800' || text === '800') return 8
  if (text === 'L900' || text === '900') return 9
  if (text === 'L1800' || text === '1800') return 18
  if (text === 'L2100' || text === '2100') return 21
  if (text === 'L2600' || text === '2600') return 26
  const digits = Number(text.replace(/[^0-9]/g, ''))
  if (Number.isFinite(digits) && digits > 99) return Math.round(digits / 100)
  if (Number.isFinite(digits) && digits >= 1 && digits <= 99) return digits
  return 3
}
