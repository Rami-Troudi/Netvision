export default function AdminValidationPanel() {
  return <section className="panel-shell cockpit-panel">
    <div className="panel-heading"><div><p>Validation</p><h1>ContrÃ´les qualitÃ©</h1></div></div>
    <div className="empty-state" role="note">Aucun rapport de validation chargÃ©.</div>
    <div className="site-table-card">
      <div className="section-title">Commandes recommandÃ©es</div>
      <ul className="compact-list">
        <li><code>npm run test:contracts</code></li>
        <li><code>npm run qa:browser</code></li>
        <li><code>npm run ui:audit</code></li>
        <li><code>npm run forecast:check</code></li>
        <li><code>npm run ns3:check</code></li>
      </ul>
    </div>
  </section>
}

