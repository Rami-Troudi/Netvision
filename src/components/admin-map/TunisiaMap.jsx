import { useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import { metricColor, boundsForFeature, featureCenter } from '../../admin/adminMapLayers'
import { metricValue } from '../../admin/adminAggregation'
import { buildSiteSummaries, stateColor } from '../../admin/adminOps'

function decorateFeatures(fc, rows, idKey, metricMode) {
  const byId = new Map(rows.map((row) => [row.id, row]))
  return { ...fc, features: (fc?.features || []).map((feature) => {
    const id = feature.properties?.[idKey]
    const row = byId.get(id)
    const value = metricValue(row, metricMode)
    return { ...feature, properties: { ...(feature.properties || {}), metric_value: value, fill_color: metricColor(value, metricMode), observed_cells: row?.observed_cells || 0, congestion_rate: row?.congestion_rate || 0, avg_prb: row?.avg_prb || 0, avg_throughput: row?.avg_throughput || 0, status: row?.status || 'stable' } }
  }) }
}

function siteFeatureCollection(sites = []) {
  return { type: 'FeatureCollection', features: sites.filter((site) => Number.isFinite(site.longitude) && Number.isFinite(site.latitude)).map((site) => ({
    type: 'Feature',
    properties: {
      site_name: site.site_name,
      worst_cell: site.worst_cell,
      state: site.state,
      state_label: site.state_label,
      state_color: site.state_color,
      avg_prb: site.avg_prb,
      avg_throughput: site.avg_throughput,
      avg_cqi: site.avg_cqi,
      active_users: site.active_users,
      cell_count: site.cells.length,
      gov_id: site.admin?.gov_id || '',
      deleg_id: site.admin?.deleg_id || '',
    },
    geometry: { type: 'Point', coordinates: [site.longitude, site.latitude] },
  })) }
}

export default function TunisiaMap({ governoratesGeo, delegationsGeo, governorateRows, delegationRows, cells, filteredCells, scope, metricMode, metric, layerVisibility, onGovernorateClick, onDelegationClick, onCellClick }) {
  const mapNode = useRef(null)
  const mapRef = useRef(null)
  const transitionRef = useRef([])
  const [hover, setHover] = useState(null)
  const [mapError, setMapError] = useState(null)

  const govSource = useMemo(() => decorateFeatures(governoratesGeo, governorateRows, 'gov_id', metricMode), [governoratesGeo, governorateRows, metricMode])
  const delSource = useMemo(() => decorateFeatures(delegationsGeo, delegationRows, 'deleg_id', metricMode), [delegationsGeo, delegationRows, metricMode])
  const scopedCells = useMemo(() => {
    if (scope.level === 'national') return []
    if (scope.level === 'governorate') return filteredCells.filter((cell) => cell.admin?.gov_id === scope.governorateId)
    if (scope.level === 'delegation' || scope.level === 'cell') return filteredCells.filter((cell) => cell.admin?.deleg_id === scope.delegationId)
    return []
  }, [filteredCells, scope])
  const siteSource = useMemo(() => siteFeatureCollection(buildSiteSummaries(scopedCells)), [scopedCells])

  useEffect(() => {
    if (!mapNode.current || mapRef.current) return
    let map
    try {
      map = new maplibregl.Map({
        container: mapNode.current,
        style: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#f7f3ea' } }] },
        center: [9.55, 34.1],
        zoom: 5.35,
        attributionControl: false,
        preserveDrawingBuffer: true,
      })
    } catch (error) {
      setMapError(error?.message || 'MapLibre could not initialize WebGL.')
      return undefined
    }
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-left')
    mapRef.current = map
    window.__netvisionMap = map
    map.on('load', () => {
      map.addSource('admin-governorates', { type: 'geojson', data: govSource })
      map.addSource('admin-delegations', { type: 'geojson', data: delSource })
      map.addSource('radio-sites', { type: 'geojson', data: siteSource })
      map.addLayer({ id: 'admin-governorates-fill', type: 'fill', source: 'admin-governorates', paint: { 'fill-color': ['get', 'fill_color'], 'fill-opacity': 0.94 } })
      map.addLayer({ id: 'admin-governorates-line', type: 'line', source: 'admin-governorates', paint: { 'line-color': '#b99b77', 'line-width': 1.25 } })
      map.addLayer({ id: 'admin-governorates-selected', type: 'line', source: 'admin-governorates', filter: ['==', ['get', 'gov_id'], ''], paint: { 'line-color': '#ff7900', 'line-width': 4 } })
      map.addLayer({ id: 'admin-delegations-fill', type: 'fill', source: 'admin-delegations', paint: { 'fill-color': ['get', 'fill_color'], 'fill-opacity': 0.0 } })
      map.addLayer({ id: 'admin-delegations-line', type: 'line', source: 'admin-delegations', paint: { 'line-color': '#cc6c18', 'line-width': 1.0, 'line-opacity': 0.0 } })
      map.addLayer({ id: 'admin-delegations-selected', type: 'line', source: 'admin-delegations', filter: ['==', ['get', 'deleg_id'], ''], paint: { 'line-color': '#b13f00', 'line-width': 3, 'line-opacity': 0.0 } })
      map.addLayer({ id: 'radio-sites', type: 'circle', source: 'radio-sites', paint: { 'circle-radius': ['interpolate', ['linear'], ['get', 'active_users'], 0, 7, 20, 14], 'circle-color': ['get', 'state_color'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5, 'circle-opacity': 0.0 } })
      map.addLayer({ id: 'selected-cell', type: 'circle', source: 'radio-sites', filter: ['==', ['get', 'worst_cell'], ''], paint: { 'circle-radius': 17, 'circle-color': '#ff7900', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 4, 'circle-opacity': 0.95 } })
      map.on('click', 'admin-governorates-fill', (e) => e.features?.[0] && onGovernorateClick(e.features[0].properties))
      map.on('click', 'admin-delegations-fill', (e) => e.features?.[0] && onDelegationClick(e.features[0].properties))
      map.on('click', 'radio-sites', (e) => e.features?.[0] && onCellClick(e.features[0].properties.worst_cell))
      ;['admin-governorates-fill', 'admin-delegations-fill', 'radio-sites'].forEach((layer) => {
        map.on('mouseenter', layer, (e) => { map.getCanvas().style.cursor = 'pointer'; setHover({ layer, props: e.features?.[0]?.properties || {} }) })
        map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; setHover(null) })
      })
    })
    return () => { transitionRef.current.forEach(clearTimeout); map.remove(); mapRef.current = null }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map?.isStyleLoaded()) return
    map.getSource('admin-governorates')?.setData(govSource)
    map.getSource('admin-delegations')?.setData(delSource)
    map.getSource('radio-sites')?.setData(siteSource)
  }, [govSource, delSource, siteSource])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    transitionRef.current.forEach(clearTimeout)
    transitionRef.current = []
    const applyScope = () => {
      if (!map.getLayer('admin-governorates-fill')) {
        transitionRef.current.push(window.setTimeout(applyScope, 100))
        return
      }
      map.resize()
      const govFilter = scope.level === 'national' ? null : ['==', ['get', 'gov_id'], scope.governorateId || '']
      const delFilter = scope.level === 'governorate' ? ['==', ['get', 'gov_id'], scope.governorateId || ''] : (scope.level === 'delegation' || scope.level === 'cell') ? ['==', ['get', 'deleg_id'], scope.delegationId || ''] : ['==', ['get', 'deleg_id'], '__none__']
      const showDelegations = scope.level === 'governorate' || scope.level === 'delegation' || scope.level === 'cell'
      const showSites = (scope.level === 'delegation' || scope.level === 'cell') && layerVisibility?.sites !== false
      map.setFilter('admin-governorates-fill', govFilter)
      map.setFilter('admin-governorates-line', govFilter)
      map.setFilter('admin-governorates-selected', ['==', ['get', 'gov_id'], scope.governorateId || ''])
      map.setFilter('admin-delegations-fill', delFilter)
      map.setFilter('admin-delegations-line', delFilter)
      map.setFilter('admin-delegations-selected', ['==', ['get', 'deleg_id'], scope.delegationId || ''])
      map.setFilter('selected-cell', ['==', ['get', 'worst_cell'], scope.selectedCellName || ''])
      map.setPaintProperty('admin-delegations-fill', 'fill-opacity', showDelegations && layerVisibility?.delegations !== false ? 0.62 : 0)
      map.setPaintProperty('admin-delegations-line', 'line-opacity', showDelegations && layerVisibility?.delegations !== false ? 0.78 : 0)
      map.setPaintProperty('admin-delegations-selected', 'line-opacity', showDelegations ? 1 : 0)
      map.setPaintProperty('radio-sites', 'circle-opacity', showSites ? 0.95 : 0)
      if (scope.level === 'national') {
        map.fitBounds([[7.4, 30.2], [11.7, 37.6]], { padding: 42, duration: 800, easing: (t) => 1 - Math.pow(1 - t, 3) })
      } else if (scope.level === 'governorate' && scope.governorateId) {
        const feature = governoratesGeo.features.find((f) => f.properties.gov_id === scope.governorateId)
        if (feature) map.fitBounds(boundsForFeature(feature), { padding: { top: 96, bottom: 96, left: 96, right: 120 }, duration: 900, maxZoom: 8 })
      } else if ((scope.level === 'delegation' || scope.level === 'cell') && scope.delegationId) {
        const feature = delegationsGeo.features.find((f) => f.properties.deleg_id === scope.delegationId)
        if (feature) map.flyTo({ center: featureCenter(feature), zoom: 9.6, duration: 900, essential: true })
      }
    }
    applyScope()
  }, [scope, governoratesGeo, delegationsGeo, layerVisibility])

  const hoverTitle = hover?.props?.site_name || hover?.props?.gov_name || hover?.props?.deleg_name
  return (
    <div className="map-card">
      <div ref={mapNode} className="netvision-map-container" />
      {mapError ? <div className="map-fallback">
        <strong>Map rendering unavailable</strong>
        <span>MapLibre could not start WebGL in this browser session. Use the regional rankings and search to navigate operational scopes.</span>
        <code>{mapError}</code>
      </div> : null}
      <div className="map-toolbar"><strong>{metric.label}</strong><span>Scoped polygons + colored site dots</span></div>
      <div className="site-state-legend">
        {['critical','watch','degraded','healthy','no_data','unmatched'].map((state) => <span key={state}><i style={{ background: stateColor(state) }} />{state.replace('_', ' ')}</span>)}
      </div>
      <div className="map-legend"><div /><span>Low</span><span>High</span></div>
      {hover ? <div className="hover-card"><strong>{hoverTitle}</strong>{hover.props.site_name ? <><span>{hover.props.state_label} · {hover.props.cell_count} cells</span><span>PRB {Number(hover.props.avg_prb || 0).toFixed(1)}% · Throughput {Number(hover.props.avg_throughput || 0).toFixed(1)} Mbps · CQI {Number(hover.props.avg_cqi || 0).toFixed(1)}</span><em>Click to inspect worst cell {hover.props.worst_cell}</em></> : <><span>{metric.label}: {Number(hover.props.metric_value || 0).toFixed(1)}{metric.unit}</span><em>Click to focus</em></>}</div> : null}
    </div>
  )
}
