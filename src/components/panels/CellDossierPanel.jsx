import KpiCard from '../dashboard/KpiCard'
import StatusBadge from '../dashboard/StatusBadge'
import { diagnoseCell, formatMetric, classifyRanIssue } from '../../admin/adminAggregation'
import { stateLabel, getCellState } from '../../admin/adminOps'
import { diagnosisLabelFr } from '../../utils/uiPolicy.mjs'
import { confidenceLabelFr } from '../../analytics/qosInsightNarratives.mjs'
import { ActionBar, EmptyState, SectionCard } from './shared/PanelPrimitives'

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

function EmptyDossier({ alerts = [], onSelectCell, onTabChange }) {
  return (
    <section className="panel-shell cockpit-panel workflow-panel dossier-workspace">
      <div className="workflow-hero">
        <div>
          <p className="eyebrow">Dossier cellule</p>
          <h1>Sélectionner une cellule</h1>
          <span className="hero-subtitle">Le dossier rassemble KPI, diagnostic, tendance et contexte radio.</span>
        </div>
        <StatusBadge status="watch" />
      </div>
      <EmptyState title="Aucune cellule sélectionnée" action={<button className="primary-cta" type="button" onClick={() => onTabChange?.('priorities')}>Voir les priorités</button>}>
        Sélectionnez une cellule depuis la carte, la recherche ou les priorités.
      </EmptyState>
      {alerts.length ? (
        <div className="site-table-card section-card">
          <div className="section-title">Cellules à traiter maintenant</div>
          <table><tbody>{alerts.slice(0, 8).map((cell) => <tr key={cell.cell_name} onClick={() => onSelectCell?.(cell.cell_name, { activeTab: 'cell-dossier' })}><td>{cell.cell_name}</td><td>{stateLabel(getCellState(cell))}</td><td>{formatMetric(cell.prb_load)}%</td></tr>)}</tbody></table>
        </div>
      ) : null}
    </section>
  )
}

function findForecastRow(cell, forecastState) {
  const rows = Array.isArray(forecastState?.rows) ? forecastState.rows : []
  return rows.find((row) => row.cell_name === cell?.cell_name)
}

function findPeakRow(cell, peakRows = []) {
  return peakRows.find((row) => row.cell_name === cell?.cell_name || row.id === cell?.cell_name || row.site_name === cell?.site_name)
}

export default function CellDossierPanel(props) {
  const { selectedCell, alerts = [], onSelectCell, onTabChange, currentTime, workerState, sliceDelta, forecastState, peakRows = [] } = props
  if (!selectedCell) return <EmptyDossier alerts={alerts} onSelectCell={onSelectCell} onTabChange={onTabChange} />

  const cell = selectedCell
  const state = getCellState(cell)
  const issue = classifyRanIssue(cell)
  const forecastRow = findForecastRow(cell, forecastState)
  const peakRow = findPeakRow(cell, peakRows)
  const queueReady = workerState === 'ready'
  const diagnosisText = diagnoseCell(cell)
  const nextActionText = queueReady
    ? 'Préparer une simulation si l’action est justifiée par le diagnostic.'
    : 'Lire le dossier puis vérifier les services dans le mode Admin avant toute simulation.'
  const missingSignals = [
    cell.prb_load == null ? 'PRB absent' : null,
    cell.throughput == null ? 'Débit absent' : null,
    cell.cqi == null ? 'CQI absent' : null,
    !cell.admin?.deleg_name ? 'Rapprochement administratif incomplet' : null,
  ].filter(Boolean)

  return (
    <section className="panel-shell cockpit-panel workflow-panel dossier-workspace">
      <div className="workflow-hero dossier-identity">
        <div>
          <p className="eyebrow">Dossier cellule</p>
          <h1>{cell.cell_name}</h1>
          <span className="hero-subtitle">{cell.site_name || 'Site inconnu'} · {cell.admin?.deleg_name || 'Délégation non rapprochée'} · {cell.admin?.gov_name || 'Gouvernorat non rapproché'}</span>
        </div>
        <StatusBadge status={state === 'critical' ? 'critical' : state === 'watch' ? 'watch' : 'stable'} />
      </div>

      <div className="context-strip">
        <span>Tranche : <strong>{currentTime?.timestamp || 'courante'}</strong></span>
        <span>État : <strong>{stateLabel(state)}</strong></span>
        <span>Simulation : <strong>{queueReady ? 'disponible' : 'à vérifier'}</strong></span>
      </div>

      <SectionCard title="Conclusion opérateur" className="dossier-conclusion-card">
        <strong>{diagnosisLabelFr(issue)}</strong>
        <p>{diagnosisText}</p>
        <div className="operator-next-step">
          <span>Pourquoi c’est prioritaire</span>
          <em>{stateLabel(state)} · PRB {formatMetric(cell.prb_load)}% · Débit {formatMetric(cell.throughput)} Mbps</em>
        </div>
        <div className="operator-next-step">
          <span>Action suivante</span>
          <em>{nextActionText}</em>
        </div>
      </SectionCard>

      <div className="kpi-grid compact command-kpis">
        <KpiCard label="Charge PRB" value={cell.prb_load} unit="%" hint="Mesure la pression capacitaire radio." />
        <KpiCard label="Débit" value={cell.throughput} unit="Mbps" hint="Mesure l'expérience utilisateur." />
        <KpiCard label="CQI" value={cell.cqi} hint="Indique la qualité radio perçue." />
        <KpiCard label="Utilisateurs actifs" value={cell.active_users} hint="Montre la demande instantanée." />
        <KpiCard label="TA" value={cell.ta} hint="Aide à détecter bord de cellule/couverture." />
        <KpiCard label="Santé" value={cell.health} />
      </div>

      <SectionCard title="Diagnostic multi-KPI" className="diagnosis-box">
        <strong>{diagnosisLabelFr(issue)}</strong>
        <p>{diagnosisText}</p>
        <ul className="evidence-list">{(issue.evidence?.length ? issue.evidence : ['Preuves limitées sur ce périmètre.']).map((item) => <li key={item}>{item}</li>)}</ul>
      </SectionCard>

      <SincePreviousCard delta={sliceDelta} compact />

      <div className="two-column-stack">
        <div className="section-card">
          <div className="section-title">Risque indicatif prochain horizon</div>
          {forecastRow ? (
            <>
              <strong>{forecastRow.predicted_issue || 'Prévision indicative'}</strong>
              <p>Risque estimé : {forecastRow.risk_score}/100 · Confiance {confidenceLabelFr(forecastRow.confidence)}</p>
              <ul className="evidence-list">{(forecastRow.evidence || []).slice(0, 3).map((item) => <li key={item}>{item}</li>)}</ul>
            </>
          ) : <div className="empty-state compact-state">Aucun risque indicatif disponible pour cette cellule.</div>}
        </div>
        <div className="section-card">
          <div className="section-title">Heures critiques</div>
          {peakRow ? (
            <p>Pic observé vers <strong>{peakRow.peak_hour || 'heure inconnue'}</strong>, PRB moyen {formatMetric(peakRow.avg_prb_at_peak)}%.</p>
          ) : <div className="empty-state compact-state">Pas de récurrence horaire détectée sur cette cellule.</div>}
        </div>
      </div>

      <div className="site-table-card section-card">
        <div className="section-title">Contexte radio</div>
        <table>
          <caption className="sr-only">Détails de la cellule sélectionnée</caption>
          <tbody>
            <tr><th scope="row">Site</th><td>{cell.site_name || 'Site inconnu'}</td></tr>
            <tr><th scope="row">Délégation</th><td>{cell.admin?.deleg_name || 'Non rapprochée'}</td></tr>
            <tr><th scope="row">Gouvernorat</th><td>{cell.admin?.gov_name || 'Non rapproché'}</td></tr>
            <tr><th scope="row">État</th><td>{stateLabel(state)}</td></tr>
          </tbody>
        </table>
      </div>

      <SectionCard title="Qualité des données">
        {missingSignals.length ? <ul className="evidence-list">{missingSignals.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="micro-copy">Les KPI essentiels et le contexte administratif sont disponibles pour ce dossier.</p>}
      </SectionCard>

      <ActionBar title="Action suivante" description="Tester un scénario uniquement après lecture du dossier.">
        <button type="button" className="primary-cta" onClick={() => onTabChange?.('simulation')}>Préparer simulation</button>
      </ActionBar>
    </section>
  )
}
