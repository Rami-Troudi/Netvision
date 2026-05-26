import KpiCard from '../../dashboard/KpiCard'

export default function AdminConfigurationPanel({ dataMode, workerState }) {
  return <section className="panel-shell cockpit-panel">
    <div className="panel-heading"><div><p>Configuration</p><h1>ParamÃ¨tres actifs</h1></div></div>
    <div className="kpi-grid compact">
      <KpiCard label="Mode donnÃ©es" value={dataMode || 'mock'} />
      <KpiCard label="Simulation" value={workerState === 'ready' ? 'Disponible' : 'Indisponible'} />
    </div>
    <div className="empty-state" role="note">Les contrÃ´les principaux restent disponibles dans l&apos;en-tÃªte.</div>
  </section>
}

