import NationalPanel from './NationalPanel'
import GovernoratePanel from './GovernoratePanel'
import DelegationPanel from './DelegationPanel'
import StatusBadge from '../dashboard/StatusBadge'

function SincePreviousCard({ delta, compact = false }) {
  if (!delta?.available) return null
  if (compact && !delta.newCongested && !delta.recovered && !delta.worsened && !delta.improved) return null
  return <div className="comparison-card"><div className="section-title">Ã‰volution tranche prÃ©cÃ©dente</div><div className="delta-grid"><span>Nouvelles congestions <strong>{delta.newCongested}</strong></span><span>RÃ©cupÃ©rÃ©es <strong>{delta.recovered}</strong></span><span>AggravÃ©es <strong>{delta.worsened}</strong></span><span>AmÃ©liorÃ©es <strong>{delta.improved}</strong></span></div></div>
}

export default function OverviewPanel(props) {
  const { scope, nationalSummary, governorateRows, delegationRows, delegationVariationRows, metric, selectedGovernorate, selectedDelegation, delegationSummary, governorateSummary, onSelectGovernorate, onSelectDelegation, reconciliation, sliceDelta, watchlist = [], savedViews = [], onRestoreView, onRemoveView } = props
  const summary = scope.level === 'delegation' || scope.level === 'cell' ? delegationSummary : scope.level === 'governorate' ? governorateSummary : nationalSummary
  return <section className="panel-shell cockpit-panel"><div className="panel-heading"><div><p>Vue rÃ©seau</p><h1>{scope.level === 'national' ? 'RÃ©seau mobile Tunisie' : scope.delegationName || scope.governorateName}</h1></div><StatusBadge status={summary.status} /></div><SincePreviousCard delta={sliceDelta} compact />{scope.level === 'national' ? <NationalPanel compact summary={nationalSummary} governorates={governorateRows} delegationVariations={delegationVariationRows} metric={metric} onSelectGovernorate={onSelectGovernorate} reconciliation={reconciliation} /> : null}{scope.level === 'governorate' ? <GovernoratePanel governorate={selectedGovernorate} summary={governorateSummary} delegations={delegationRows} metric={metric} currentTime={props.currentTime} onSelectDelegation={onSelectDelegation} /> : null}{(scope.level === 'delegation' || scope.level === 'cell') ? <DelegationPanel delegation={selectedDelegation} summary={delegationSummary} sites={props.siteRows} onSelectCell={props.onSelectCell} /> : null}
  {watchlist.length ? <div className="site-table-card"><div className="section-title">Watchlist NOC</div><table><tbody>{watchlist.slice(0, 8).map((w) => <tr key={w.cell_name}><td>{w.cell_name}</td><td>{w.note || 'Surveillance'}</td></tr>)}</tbody></table></div> : null}
  {savedViews.length ? <div className="site-table-card"><div className="section-title">Vues sauvegardees</div><table><tbody>{savedViews.slice(0, 8).map((v) => <tr key={v.id}><td>{v.name}</td><td><button className="ghost-button" onClick={() => onRestoreView?.(v.id)}>Restaurer</button><button className="ghost-button" onClick={() => onRemoveView?.(v.id)}>Supprimer</button></td></tr>)}</tbody></table></div> : null}
  </section>
}

