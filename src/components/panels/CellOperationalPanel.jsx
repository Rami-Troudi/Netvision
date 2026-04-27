import { useEffect, useMemo, useState } from 'react'
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

export default function CellOperationalPanel({ cell, currentTime }) {
  const [recommendations, setRecommendations] = useState([])
  const [recState, setRecState] = useState('idle')
  const [action, setAction] = useState('add_carrier')
  const [simulation, setSimulation] = useState(null)
  const [simState, setSimState] = useState('idle')

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
  }, [cell?.cell_name, currentTime?.timestamp])

  const selectedAction = useMemo(() => SUPPORTED_ACTIONS.find((item) => item.id === action), [action])

  async function runSimulation(nextAction = action) {
    if (!cell?.cell_name) return
    setSimState('running')
    setSimulation(null)
    try {
      const params = nextAction === 'tilt' ? { degrees: 2 } : nextAction === 'redistribute' ? { ratio: 0.15 } : nextAction === 'add_carrier' ? { band: cell.frequency_band || 3 } : {}
      const res = await fetch('/api/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cell_name: cell.cell_name, action: nextAction, params, time_entry: currentTime || {}, mode: 'fast' }),
      })
      const payload = await res.json()
      if (!res.ok) throw new Error(payload?.error || `simulate returned ${res.status}`)
      setSimulation(payload)
      setSimState('complete')
    } catch (err) {
      setSimState(err.message || 'Simulation failed')
    }
  }

  return (
    <section className="panel-shell cell-panel">
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
      <div className="recommendation-list">{recommendations.length ? recommendations.map((rec, idx) => <RecommendationCard key={idx} recommendation={rec} onSimulate={(simAction) => { setAction(simAction); runSimulation(simAction) }} />) : recState === 'ready' ? <div className="empty-state">No simulator-supported backend action was returned for this cell.</div> : null}</div>
      <div className="simulation-control"><select value={action} onChange={(e) => setAction(e.target.value)}>{SUPPORTED_ACTIONS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select><button className="primary-cta" onClick={() => runSimulation(action)}>Run {selectedAction?.label || action}</button></div>
      {simState !== 'idle' && simState !== 'complete' && simState !== 'running' ? <div className="empty-state warning">{simState}</div> : null}
      {simState === 'running' ? <div className="empty-state">Running fast simulator...</div> : <SimulationImpactCard result={simulation} />}
    </section>
  )
}
