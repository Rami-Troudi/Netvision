const VALIDATION_COMMANDS = [
  ['Contrats', 'npm run test:contracts'],
  ['Browser QA', 'npm run qa:browser'],
  ['Album UI', 'npm run ui:audit'],
  ['Prévision', 'npm run forecast:check'],
  ['ns-3', 'npm run ns3:check'],
]

export default function AdminValidationPanel() {
  return (
    <section className="panel-shell cockpit-panel workflow-panel admin-workspace validation-workspace">
      <div className="workflow-hero"><div><p className="eyebrow">Validation</p><h1>La solution est-elle saine ?</h1><span className="hero-subtitle">Commandes, preuves runtime et rapports d&apos;audit à consulter avant livraison.</span></div></div>
      <div className="validation-grid">
        {VALIDATION_COMMANDS.map(([label, command]) => (
          <div className="validation-card" key={command}>
            <span>{label}</span>
            <code>{command}</code>
            <em>À exécuter avant validation finale</em>
          </div>
        ))}
      </div>
      <div className="section-card"><div className="section-title">Artefacts attendus</div><ul className="compact-list"><li><code>.runtime/qa/browser-qa-budget.json</code></li><li><code>.runtime/ui-audit/ui-audit-report.md</code></li><li><code>.runtime/ui-audit/console-errors.json</code></li><li><code>.runtime/ui-audit/network-summary.json</code></li><li><code>.runtime/forecast/forecast-h1.json</code></li></ul></div>
      <div className="empty-state state-card" role="note"><strong>Lecture opérationnelle</strong><span>Une validation saine doit montrer 0 erreur console, 0 réponse 429 bloquante, une carte visible et un parcours recherche → dossier → simulation fonctionnel.</span></div>
    </section>
  )
}
