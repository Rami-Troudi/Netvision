import NationalPanel from './NationalPanel'
import GovernoratePanel from './GovernoratePanel'
import DelegationPanel from './DelegationPanel'
import KpiCard from '../dashboard/KpiCard'
import StatusBadge from '../dashboard/StatusBadge'
import { ActionBar, SectionCard } from './shared/PanelPrimitives'

function SincePreviousCard({ delta, compact = false }) {
  if (!delta?.available) return null
  if (compact && !delta.newCongested && !delta.recovered && !delta.worsened && !delta.improved) return null
  return (
    <div className="comparison-card state-card">
      <div className="section-title">Évolution tranche précédente</div>
      <div className="delta-grid">
        <span>Nouvelles congestions <strong>{delta.newCongested}</strong></span>
        <span>Récupérées <strong>{delta.recovered}</strong></span>
        <span>Aggravées <strong>{delta.worsened}</strong></span>
        <span>Améliorées <strong>{delta.improved}</strong></span>
      </div>
    </div>
  )
}

function scopeTitle(scope) {
  if (scope.level === 'national') return 'Réseau mobile Tunisie'
  if (scope.level === 'cell') return scope.cellName || 'Cellule sélectionnée'
  return scope.delegationName || scope.governorateName || 'Périmètre réseau'
}

export default function OverviewPanel(props) {
  const {
    scope,
    nationalSummary,
    governorateRows,
    delegationRows,
    delegationVariationRows,
    metric,
    selectedGovernorate,
    selectedDelegation,
    delegationSummary,
    governorateSummary,
    onSelectGovernorate,
    onSelectDelegation,
    reconciliation,
    sliceDelta,
    watchlist = [],
    savedViews = [],
    onRestoreView,
    onRemoveView,
    onTabChange,
    dataMode,
  } = props
  const summary = scope.level === 'delegation' || scope.level === 'cell' ? delegationSummary : scope.level === 'governorate' ? governorateSummary : nationalSummary
  const spatialRows = scope.level === 'national'
    ? governorateRows.slice(0, 4).map((row) => ({ id: row.gov_id || row.name, name: row.name || row.gov_name, value: row.congestion_rate ?? row.avg_prb, meta: 'Gouvernorat' }))
    : scope.level === 'governorate'
      ? delegationRows.slice(0, 4).map((row) => ({ id: row.deleg_id || row.name, name: row.name || row.deleg_name, value: row.congestion_rate ?? row.avg_prb, meta: 'Délégation' }))
      : (props.siteRows || []).slice(0, 4).map((row) => ({ id: row.site_name, name: row.site_name, value: row.avg_prb, meta: row.worst_cell || 'Site' }))
  const topSpatial = spatialRows[0]
  const congested = Number(summary.congested_cells || 0)
  const observed = Number(summary.observed_cells || 0)
  const networkSentence = congested
    ? `${congested} cellules congestionnées sur ${observed || 'le périmètre'} ; priorité sur ${topSpatial?.name || 'la zone la plus touchée'}.`
    : `Aucune cellule critique visible sur ${observed || 'ce périmètre'} cellules observées.`

  return (
    <section className="panel-shell cockpit-panel workflow-panel overview-workspace">
      <div className="workflow-hero">
        <div>
          <p className="eyebrow">Vue réseau</p>
          <h1>{scopeTitle(scope)}</h1>
          <span className="hero-subtitle">État réseau observé sur la tranche courante.</span>
          <strong className="operator-conclusion">{networkSentence}</strong>
        </div>
        <div className="hero-actions">
          {dataMode === 'mock' ? <span className="status-pill warning">Données non réelles</span> : null}
          <StatusBadge status={summary.status} />
        </div>
      </div>

      <div className="kpi-grid compact command-kpis">
        <KpiCard label="Cellules observées" value={summary.observed_cells} />
        <KpiCard label="Cellules congestées" value={summary.congested_cells} />
        <KpiCard label="PRB moyen" value={summary.avg_prb} unit="%" />
        <KpiCard label="Débit moyen" value={summary.avg_throughput} unit="Mbps" />
        <KpiCard label="CQI moyen" value={summary.avg_cqi} />
        <KpiCard label="Utilisateurs actifs" value={summary.active_users} />
      </div>

      <SincePreviousCard delta={sliceDelta} compact />

      <SectionCard title="Aperçu spatial prioritaire" kicker={scope.level}>
        <div className="spatial-preview-list">
          {spatialRows.length ? spatialRows.map((row, index) => (
            <div className="spatial-preview-row" key={row.id || `${row.name}:${index}`}>
              <strong>{index + 1}. {row.name}</strong>
              <span>{row.meta}</span>
              <em>{Number.isFinite(Number(row.value)) ? `${Math.round(Number(row.value))}%` : 'n/a'}</em>
            </div>
          )) : <span className="micro-copy">Aucun actif prioritaire visible sur ce périmètre.</span>}
        </div>
      </SectionCard>

      <ActionBar title="Prochaine étape" description="Passer de la vision réseau aux cellules réellement à traiter.">
        <button className="primary-cta" type="button" onClick={() => onTabChange?.('priorities')}>Voir les priorités</button>
      </ActionBar>

      {scope.level === 'national' ? <NationalPanel compact summary={nationalSummary} governorates={governorateRows} delegationVariations={delegationVariationRows} metric={metric} onSelectGovernorate={onSelectGovernorate} reconciliation={reconciliation} /> : null}
      {scope.level === 'governorate' ? <GovernoratePanel governorate={selectedGovernorate} summary={governorateSummary} delegations={delegationRows} metric={metric} currentTime={props.currentTime} onSelectDelegation={onSelectDelegation} /> : null}
      {(scope.level === 'delegation' || scope.level === 'cell') ? <DelegationPanel delegation={selectedDelegation} summary={delegationSummary} sites={props.siteRows} onSelectCell={props.onSelectCell} /> : null}

      {watchlist.length || savedViews.length ? (
        <div className="two-column-stack">
          {watchlist.length ? <div className="site-table-card section-card"><div className="section-title">Surveillance NOC</div><table><tbody>{watchlist.slice(0, 8).map((w) => <tr key={w.cell_name}><td>{w.cell_name}</td><td>{w.note || 'Surveillance'}</td></tr>)}</tbody></table></div> : null}
          {savedViews.length ? <div className="site-table-card section-card"><div className="section-title">Vues sauvegardées</div><table><tbody>{savedViews.slice(0, 8).map((v) => <tr key={v.id}><td>{v.name}</td><td><button className="ghost-button" onClick={() => onRestoreView?.(v.id)}>Restaurer</button><button className="ghost-button" onClick={() => onRemoveView?.(v.id)}>Supprimer</button></td></tr>)}</tbody></table></div> : null}
        </div>
      ) : null}
    </section>
  )
}
