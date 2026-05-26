import KpiCard from '../dashboard/KpiCard'
import StatusBadge from '../dashboard/StatusBadge'
import { useState } from 'react'
import { formatMetric } from '../../admin/adminAggregation'
import { stateLabel, getCellState } from '../../admin/adminOps'
import { confidenceLabelFr } from '../../analytics/qosInsightNarratives.mjs'
import { SectionCard } from './shared/PanelPrimitives'

function PriorityCard({ rank, title, type, severity = 'watch', reason, evidence = [], confidence, selected = false, onSelect }) {
  return (
    <article className={`priority-card priority-${severity} ${selected ? 'selected' : ''}`.trim()}>
      <div className="priority-rank">#{rank}</div>
      <div className="priority-main">
        <div className="priority-title-row"><strong>{title}</strong><span className="status-pill">{type}</span></div>
        <p>{reason}</p>
        {evidence.length ? <ul className="evidence-list">{evidence.slice(0, 3).map((item) => <li key={item}>{item}</li>)}</ul> : null}
        {confidence ? <span className="micro-copy">Confiance : {confidence}</span> : null}
      </div>
      <button className="ghost-button" type="button" onClick={onSelect}>{selected ? 'Sélectionné' : 'Inspecter'}</button>
    </article>
  )
}

export default function PrioritiesPanel(props) {
  const { alerts = [], peakRows = [], forecastState = {}, onSelectCell, onPeakRowSelect } = props
  const forecastRows = Array.isArray(forecastState?.rows) ? forecastState.rows : []
  const currentItems = alerts.slice(0, 5).map((cell, index) => ({
    key: `now:${cell.cell_name}`,
    rank: index + 1,
    title: cell.cell_name,
    type: 'Critique maintenant',
    severity: getCellState(cell),
    reason: `${stateLabel(getCellState(cell))} avec PRB ${formatMetric(cell.prb_load)}%.`,
    evidence: [`Débit ${formatMetric(cell.throughput)} Mbps`, `CQI ${formatMetric(cell.cqi)}`, `Utilisateurs ${formatMetric(cell.active_users)}`],
    onOpen: () => onSelectCell?.(cell.cell_name, { activeTab: 'cell-dossier' }),
  }))
  const forecastItems = forecastRows.slice(0, 5).map((row, index) => ({
    key: `forecast:${row.cell_name}`,
    rank: currentItems.length + index + 1,
    title: row.cell_name,
    type: 'Risque indicatif prochain horizon',
    severity: row.risk_level === 'critical' ? 'critical' : row.risk_level === 'high' ? 'watch' : 'stable',
    reason: row.predicted_issue || 'Prévision indicative à confirmer.',
    evidence: row.evidence || [],
    confidence: confidenceLabelFr(row.confidence),
    onOpen: () => onSelectCell?.(row.cell_name, { activeTab: 'cell-dossier' }),
  }))
  const peakItems = peakRows.slice(0, 4).map((row, index) => ({
    key: `peak:${row.group_by}:${row.id}`,
    rank: currentItems.length + forecastItems.length + index + 1,
    title: row.name,
    type: 'Heure critique récurrente',
    severity: 'watch',
    reason: `Pic vers ${row.peak_hour || 'heure inconnue'} avec PRB ${formatMetric(row.avg_prb_at_peak)}%.`,
    evidence: [`Récurrence ${formatMetric(row.recurrence_ratio ?? row.recurring_ratio ?? 0)}%`, `Périmètre ${row.group_by || 'réseau'}`],
    onOpen: () => onPeakRowSelect?.(row),
  }))
  const items = [...currentItems, ...forecastItems, ...peakItems]
  const [selectedKey, setSelectedKey] = useState('')
  const lead = items.find((item) => item.key === selectedKey) || items[0]
  const forecastSummary = forecastState?.summary || {}

  return (
    <section className="panel-shell cockpit-panel workflow-panel priorities-workspace">
      <div className="workflow-hero">
        <div>
          <p className="eyebrow">Priorités</p>
          <h1>Priorités réseau</h1>
          <span className="hero-subtitle">Cellules et zones à traiter selon les KPI, les heures critiques et le risque indicatif prochain horizon.</span>
        </div>
        <StatusBadge status={alerts.length ? 'critical' : forecastRows.length ? 'watch' : 'stable'} />
      </div>

      <div className="kpi-grid compact command-kpis">
        <KpiCard label="Critiques maintenant" value={alerts.length} />
        <KpiCard label="Risque indicatif prochain horizon" value={forecastRows.length} />
        <KpiCard label="Heures critiques récurrentes" value={peakRows.length} />
        <KpiCard label="Fiabilité des signaux" value={confidenceLabelFr(forecastState?.summary?.confidence)} />
      </div>

      {items.length ? (
        <div className="priority-command-grid">
          <div className="priority-list">
            {items.slice(0, 12).map(({ key, ...item }) => <PriorityCard key={key} selected={(lead?.key || '') === key} onSelect={() => setSelectedKey(key)} {...item} />)}
          </div>
          <SectionCard title="À vérifier maintenant" className="priority-detail-card">
            <strong>{lead?.title || 'Aucune cellule'}</strong>
            <p>{lead?.reason || 'Aucun signal prioritaire.'}</p>
            <div className="section-title">Pourquoi c’est prioritaire</div>
            <ul className="compact-list">
              <li>Type: <strong>{lead?.type || 'Signal opérationnel'}</strong></li>
              <li>Risque indicatif prochain horizon: <strong>{forecastSummary.high_risk_cells || 0}</strong> cellules à surveiller</li>
              <li>Fiabilité des signaux: <strong>{confidenceLabelFr(forecastSummary.confidence || forecastState?.confidence)}</strong></li>
            </ul>
            <div className="section-title">Signaux observés</div>
            <ul className="evidence-list">
              {(lead?.evidence || ['Comparer PRB, débit, CQI et utilisateurs.', 'Ouvrir le dossier avant toute simulation.']).slice(0, 4).map((item) => <li key={item}>{item}</li>)}
            </ul>
            <div className="section-title">Hypothèses</div>
            <ul className="compact-list">
              <li>Prévision indicative basée sur les tranches récentes disponibles.</li>
              <li>Corrélation multi-KPI utilisée: charge, débit, CQI, utilisateurs.</li>
            </ul>
            <div className="section-title">Limites</div>
            <ul className="compact-list">
              <li>Confiance réduite si KPI manquants ou séries trop courtes.</li>
              <li>Le score de risque n’est pas une certitude terrain.</li>
            </ul>
            {lead?.onOpen ? <button className="primary-cta" type="button" onClick={lead.onOpen}>Ouvrir le dossier</button> : null}
          </SectionCard>
        </div>
      ) : (
        <div className="empty-state state-card" role="note">
          <strong>Aucune priorité opérationnelle immédiate.</strong>
          <span>Les signaux disponibles ne remontent pas de cellule urgente dans ce périmètre.</span>
        </div>
      )}

      <div className="section-card guidance-card">
        <div className="section-title">Méthode de priorisation</div>
        <ul className="evidence-list">
          <li>Signaux observés : pression PRB, débit, CQI et charge utilisateurs.</li>
          <li>À vérifier maintenant : cellule touchée, voisinage et fenêtre horaire récurrente.</li>
          <li>Action à tester : ouvrir le dossier avant toute simulation.</li>
        </ul>
      </div>
    </section>
  )
}
