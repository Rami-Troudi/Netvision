import KpiCard from '../../dashboard/KpiCard'

export default function AdminConfigurationPanel({ dataMode, workerState, metric = 'congestion' }) {
  const metricLabel = typeof metric === 'object' ? (metric.label || metric.id || 'congestion') : metric
  return (
    <section className="panel-shell cockpit-panel workflow-panel admin-workspace configuration-workspace">
      <div className="workflow-hero"><div><p className="eyebrow">Configuration</p><h1>Quels paramètres contrôlent le système ?</h1><span className="hero-subtitle">Résumé des modes actifs, seuils opérationnels et garde-fous visibles.</span></div></div>
      <div className="kpi-grid compact command-kpis"><KpiCard label="Mode données" value={dataMode || 'mock'} /><KpiCard label="Métrique carte" value={metricLabel} /><KpiCard label="Simulation" value={workerState === 'ready' ? 'Disponible' : 'Indisponible'} /></div>
      <div className="config-grid">
        <div className="section-card"><div className="section-title">Interface</div><p>Le rôle Opérateur masque les détails techniques; le rôle Admin expose données, services, validation et configuration.</p></div>
        <div className="section-card"><div className="section-title">Seuils QoS</div><ul className="compact-list"><li>PRB élevé: pression capacitaire.</li><li>Débit faible: impact expérience utilisateur.</li><li>CQI faible: qualité radio perçue à confirmer.</li></ul></div>
        <div className="section-card"><div className="section-title">Simulation</div><p>Actions exécutables limitées aux scénarios ns-3 supportés. Les actions site planning restent non exécutables.</p></div>
        <div className="section-card"><div className="section-title">Contrôles</div><p>Les contrôles principaux restent disponibles dans l&apos;en-tête: rôle, mode opérateur/admin, thème et mode données.</p></div>
      </div>
      <details className="section-card detail-toggle">
        <summary>Voir détails techniques</summary>
        <ul className="compact-list">
          <li>Mode données actif: <strong>{dataMode || 'mock'}</strong></li>
          <li>Métrique courante: <strong>{metricLabel}</strong></li>
          <li>État simulation: <strong>{workerState === 'ready' ? 'prête' : 'indisponible'}</strong></li>
        </ul>
      </details>
    </section>
  )
}
