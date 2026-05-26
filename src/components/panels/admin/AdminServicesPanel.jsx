export default function AdminServicesPanel({ backendHealth, workerState, data, endpointCoverage }) {
  const byEndpoint = Object.fromEntries((endpointCoverage || []).map((item) => [item.endpoint, item]))
  const queueDetail = workerState === 'ready' ? 'prêt' : 'File de simulation indisponible - service optionnel à vérifier.'
  const services = [
    { name: 'API données Next', ok: Boolean(data) && byEndpoint['/api/data/*']?.reachable !== false, detail: 'données runtime chargées', group: 'core' },
    { name: 'Moteur carte', ok: true, detail: 'polygones MapLibre chargés localement', group: 'core' },
    { name: 'Géographie admin', ok: Boolean(data?.governorates?.features?.length && data?.delegations?.features?.length), detail: 'gouvernorats et délégations chargés', group: 'core' },
    { name: 'API heures critiques', ok: byEndpoint['/api/peak-hours']?.reachable !== false, detail: byEndpoint['/api/peak-hours']?.detail || 'prêt', group: 'core' },
    { name: 'Backend FastAPI', ok: backendHealth?.available || backendHealth?.status === 'ok', detail: backendHealth?.status || backendHealth?.detail || 'optionnel sur cette phase', group: 'optional' },
    { name: 'Redis / worker', ok: workerState === 'ready', detail: queueDetail, group: 'optional' },
    { name: 'File simulation', ok: workerState === 'ready', detail: queueDetail, group: 'optional' },
  ]
  const readyCount = services.filter((service) => service.ok).length

  return (
    <section className="panel-shell cockpit-panel workflow-panel admin-workspace services-workspace">
      <div className="workflow-hero"><div><p className="eyebrow">Services</p><h1>Les services sont-ils prêts ?</h1><span className="hero-subtitle">État technique des services cœur et optionnels.</span></div></div>
      <div className="admin-readiness-band"><strong>{readyCount}/{services.length} services prêts</strong><span>Les services cœur portent l’affichage; Redis, worker et ns-3 conditionnent les simulations asynchrones.</span></div>
      <div className="section-card"><div className="section-title">Services cœur</div><div className="system-grid">{services.filter((service) => service.group === 'core').map((service) => <Service key={service.name} {...service} />)}</div></div>
      <div className="section-card"><div className="section-title">Services optionnels</div><div className="system-grid">{services.filter((service) => service.group === 'optional').map((service) => <Service key={service.name} {...service} />)}</div></div>
    </section>
  )
}

function Service({ name, ok, detail }) {
  return <div className="service-card"><span className={ok ? 'ok' : 'bad'} /> <strong>{name}</strong><em>{detail}</em></div>
}
