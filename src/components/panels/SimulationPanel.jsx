import CellOperationalPanel from './CellOperationalPanel'
import StatusBadge from '../dashboard/StatusBadge'
import { stateLabel, getCellState } from '../../admin/adminOps'
import { formatMetric } from '../../admin/adminAggregation'

export default function SimulationPanel({ selectedCell, currentTime, workerState, backendHealth, jobsHealth, onSelectCell, alerts, adminToolsEnabled, onTabChange }) {
  const queueReady = workerState === 'ready'
  const simulationDetail = queueReady
    ? 'Simulation disponible'
    : adminToolsEnabled
      ? (typeof workerState === 'string' && workerState !== 'unavailable' ? workerState : 'Simulation ns-3 indisponible: verifier WSL Ubuntu, ns-3 et Redis dans Admin.')
      : 'Simulation indisponible : verifier les services dans le mode Admin.'
  if (!selectedCell) {
    return <section className="panel-shell cockpit-panel"><div className="panel-heading"><div><p>Simulation</p><h1>SÃ©lectionner une cellule</h1></div><StatusBadge status="watch" /></div><div className="empty-state" role="note">SÃ©lectionnez une cellule avant de prÃ©parer une simulation.</div><button className="ghost-button" type="button" onClick={() => onTabChange?.('priorities')}>Voir les prioritÃ©s</button>{alerts?.length ? <div className="site-table-card"><div className="section-title">Cellules prioritaires</div><table><caption className="sr-only">Cellules Ã  traiter</caption><tbody>{alerts.slice(0, 8).map((cell) => <tr key={cell.cell_name} onClick={() => onSelectCell?.(cell.cell_name)}><td>{cell.cell_name}</td><td>{stateLabel(getCellState(cell))}</td><td>{formatMetric(cell.prb_load)}%</td></tr>)}</tbody></table></div> : null}</section>
  }
  return <CellOperationalPanel cell={selectedCell} currentTime={currentTime} queueReady={queueReady} queueDetail={simulationDetail} backendHealth={backendHealth} disabledActions={jobsHealth?.slo?.disabled_actions || []} />
}

