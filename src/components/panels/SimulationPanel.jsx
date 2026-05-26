import CellOperationalPanel from './CellOperationalPanel'
import StatusBadge from '../dashboard/StatusBadge'
import { stateLabel, getCellState } from '../../admin/adminOps'
import { formatMetric } from '../../admin/adminAggregation'
import { EmptyState, SectionCard } from './shared/PanelPrimitives'

function EmptySimulation({ alerts = [], onSelectCell, onTabChange }) {
  return (
    <section className="panel-shell cockpit-panel workflow-panel simulation-workspace">
      <div className="workflow-hero">
        <div>
          <p className="eyebrow">Simulation</p>
          <h1>Sélectionner une cellule</h1>
          <span className="hero-subtitle">Une simulation se prépare depuis un dossier cellule validé.</span>
        </div>
        <StatusBadge status="watch" />
      </div>
      <EmptyState title="Aucune cellule sélectionnée" action={<button className="primary-cta" type="button" onClick={() => onTabChange?.('priorities')}>Voir les priorités</button>}>
        Sélectionnez une cellule avant de préparer une simulation.
      </EmptyState>
      {alerts?.length ? (
        <div className="site-table-card section-card">
          <div className="section-title">Cellules prioritaires</div>
          <table><caption className="sr-only">Cellules à traiter</caption><tbody>{alerts.slice(0, 8).map((cell) => <tr key={cell.cell_name} onClick={() => onSelectCell?.(cell.cell_name, { activeTab: 'cell-dossier' })}><td>{cell.cell_name}</td><td>{stateLabel(getCellState(cell))}</td><td>{formatMetric(cell.prb_load)}%</td></tr>)}</tbody></table>
        </div>
      ) : null}
    </section>
  )
}

export default function SimulationPanel({ selectedCell, currentTime, workerState, backendHealth, jobsHealth, onSelectCell, alerts, adminToolsEnabled, onTabChange }) {
  const queueReady = workerState === 'ready'
  const simulationDetail = queueReady
    ? 'Simulation disponible'
    : adminToolsEnabled
      ? (typeof workerState === 'string' && workerState !== 'unavailable' ? workerState : 'Simulation ns-3 indisponible : vérifier WSL Ubuntu, ns-3 et Redis dans Admin.')
      : 'Simulation indisponible : vérifier les services dans le mode Admin.'

  if (!selectedCell) return <EmptySimulation alerts={alerts} onSelectCell={onSelectCell} onTabChange={onTabChange} />

  const state = getCellState(selectedCell)
  return (
    <section className="panel-shell cockpit-panel workflow-panel simulation-workspace">
      <div className="workflow-hero">
        <div>
          <p className="eyebrow">Simulation</p>
          <h1>Tester une action avant intervention</h1>
          <span className="hero-subtitle">Scénario simulé sur {selectedCell.cell_name} · {currentTime?.timestamp || 'tranche courante'}</span>
        </div>
        <StatusBadge status={queueReady ? 'stable' : 'watch'} />
      </div>
      <div className="context-strip">
        <span>Cellule : <strong>{selectedCell.cell_name}</strong></span>
        <span>État : <strong>{stateLabel(state)}</strong></span>
        <span>Préconditions : <strong>{queueReady ? 'prêtes' : 'à vérifier'}</strong></span>
      </div>
      <div className="simulation-stepper">
        <div className="done"><strong>1</strong><span>Contexte cellule</span></div>
        <div className={queueReady ? 'done' : 'blocked'}><strong>2</strong><span>Préconditions</span></div>
        <div><strong>3</strong><span>Choix d&apos;action</span></div>
        <div><strong>4</strong><span>Résultat indicatif</span></div>
      </div>
      <SectionCard title="Préconditions de simulation">
        <div className="simulation-readiness">
          <span className={queueReady ? 'readiness-ok' : 'readiness-warn'}>{queueReady ? 'Services prêts' : 'Services à vérifier'}</span>
          <p>{simulationDetail}</p>
        </div>
      </SectionCard>
      {!queueReady ? <div className="empty-state warning" role="status">{simulationDetail}</div> : null}
      <CellOperationalPanel cell={selectedCell} currentTime={currentTime} queueReady={queueReady} queueDetail={simulationDetail} backendHealth={backendHealth} disabledActions={jobsHealth?.slo?.disabled_actions || []} />
    </section>
  )
}
