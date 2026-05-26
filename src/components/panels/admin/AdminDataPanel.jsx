import KpiCard from '../../dashboard/KpiCard'
import { formatMetric } from '../../../admin/adminAggregation'
import { downloadRecommendationsCsv } from '../../../services/operationalApi.mjs'

export default function AdminDataPanel({ data, reconciliation, importState, onImportFile, onImportTypeChange, onImportProfileChange, onRestoreRuntime, onExportJson, onExportReport, dataMode, onDataModeChange, dataQuality, currentTime }) {
  const warnings = (reconciliation?.warnings || []).map((warning) => String(warning)
    .replace('Mock data is calibrated on runtime_data KPI distributions and kept for development/testing only.', 'Le jeu de démonstration est dérivé des distributions KPI runtime et reste réservé au développement et aux tests.'))
  const schemaDiff = importState.dryRun?.schema_diff
  const missingRequired = schemaDiff?.missing_required || []
  const unknownFields = schemaDiff?.unknown || []
  const dryRunWarnings = importState.dryRun?.sample_warnings || []
  const importStatusMessage = importState.status === 'error'
    ? importState.error
    : `${importState.fileName} - ${importState.result?.imported_cells ?? importState.preview?.totalRows ?? 0} lignes/cellules traitées`

  return (
    <section className="panel-shell cockpit-panel workflow-panel admin-workspace" aria-busy={importState.status === 'parsing'}>
      <div className="workflow-hero">
        <div>
          <p className="eyebrow">Données</p>
          <h1>Les données sont-elles utilisables ?</h1>
          <span className="hero-subtitle">Qualité runtime, import contrôlé, export contextualisé.</span>
        </div>
        <span className="status-pill">{dataMode === 'mock' ? 'runtime_data_mock' : 'runtime_data'}</span>
      </div>

      <div className="kpi-grid compact command-kpis">
        <KpiCard label="Cellules runtime" value={dataQuality?.baselineCount ?? Object.keys(data?.baseline || {}).length} />
        <KpiCard label="Cellules rapprochées" value={dataQuality?.matched ?? reconciliation?.cell_spatial_join?.matched_cells ?? 'N/A'} />
        <KpiCard label="Non rapprochées" value={dataQuality?.unmatched ?? 'N/A'} />
        <KpiCard label="Confiance spatiale faible" value={dataQuality?.lowSpatial ?? 'N/A'} />
        <KpiCard label="KPI manquants" value={formatMetric((dataQuality?.missingKpiRatio || 0) * 100, 0)} unit="%" />
        <KpiCard label="Tranches horaires" value={dataQuality?.timeSlices ?? 0} />
      </div>

      <div className="section-card ingestion-card">
        <div className="section-title">Dataset</div>
        <div className="ingestion-row">
          <label htmlFor="data-mode">Mode</label>
          <select id="data-mode" value={dataMode || 'real'} onChange={(e) => onDataModeChange?.(e.target.value)}><option value="real">Données réelles</option><option value="mock">Jeu de démonstration</option></select>
        </div>
      </div>

      <div className="section-card ingestion-card">
        <div className="section-title">Import dry-run</div>
        <div className="ingestion-row">
          <label htmlFor="import-type" className="sr-only">Type import</label>
          <select id="import-type" value={importState.importType} onChange={(e) => onImportTypeChange(e.target.value)}><option value="reference">Référentiel CSV</option><option value="kpi">KPI horaires CSV</option></select>
          <label htmlFor="import-profile" className="sr-only">Profil import</label>
          <select id="import-profile" value={importState.selectedProfileId || ''} onChange={(e) => onImportProfileChange?.(e.target.value)}><option value="">Mapping automatique</option>{(importState.profiles || []).map((profile) => <option key={profile.id} value={profile.id}>{profile.dataset_name} ({profile.source_type})</option>)}</select>
          <label className="file-pill">Choisir CSV<input aria-label="Choisir un fichier CSV à importer" type="file" accept=".csv,text/csv" onChange={(e) => onImportFile(e.target.files?.[0], importState.importType)} /></label>
          <button data-testid="restore-runtime" className="ghost-button" onClick={onRestoreRuntime}>Restaurer runtime</button>
        </div>
        {importState.status !== 'idle' ? <div className={`empty-state ${importState.status === 'error' ? 'warning' : ''}`} role="status">{importStatusMessage}</div> : <div className="empty-state" role="note">Le dry-run signale colonnes acceptées, inconnues et obligatoires avant toute mutation. Le jeu de démonstration sert uniquement au développement et aux tests.</div>}
        {schemaDiff ? <div className="delta-grid"><span>Acceptées <strong>{schemaDiff.accepted?.length || 0}</strong></span><span>Inconnues <strong>{unknownFields.length}</strong></span><span>Obligatoires manquantes <strong>{missingRequired.length}</strong></span></div> : null}
        {missingRequired.length ? <div className="empty-state warning" role="note">Import bloqué : colonnes obligatoires manquantes ({missingRequired.join(', ')}).</div> : null}
        {unknownFields.length ? <div className="empty-state warning" role="note">Champs ignorés non autorisés : {unknownFields.slice(0, 8).join(', ')}{unknownFields.length > 8 ? ' ...' : ''}.</div> : null}
        {dryRunWarnings.map((w) => <div key={w} className="empty-state warning" role="note">{w}</div>)}
        {importState.result?.warnings?.map((w) => <div key={w} className="empty-state warning" role="note">{w}</div>)}
      </div>

      {warnings.map((w) => <div key={w} className="empty-state warning" role="note">{w}</div>)}

      <div className="section-card export-actions">
        <div className="section-title">Export</div>
        <button data-testid="export-json" className="primary-cta" onClick={onExportJson}>Exporter JSON contextualisé</button>
        <button data-testid="export-report" className="ghost-button" onClick={onExportReport}>Télécharger rapport TXT</button>
        <button data-testid="export-recommendations-csv" className="ghost-button" onClick={() => downloadRecommendationsCsv(currentTime?.timestamp)}>Propositions CSV complètes</button>
        <button data-testid="export-congested-csv" className="ghost-button" onClick={() => downloadRecommendationsCsv(currentTime?.timestamp)}>Propositions CSV congestion</button>
      </div>
    </section>
  )
}
