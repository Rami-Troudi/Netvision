import { useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import { metricColor, boundsForFeature, featureCenter } from '../../admin/adminMapLayers'
import { metricValue } from '../../admin/adminAggregation'
import { buildSiteSummaries, stateColor } from '../../admin/adminOps'
import { DEFAULT_MAP_CONTROLS } from '../../utils/v2Contracts.mjs'
import { normalizeDelegationName, normalizeGovernorateName } from '../../admin/adminNaming'
import { stateLabelFr } from '../../utils/uiPolicy.mjs'
import { deriveMapState } from './mapState.mjs'

function decorateFeatures(fc, rows, idKey, metricMode) {
  const byId = new Map(rows.map((row) => [row.id, row]))
  return {
    ...fc,
    features: (fc?.features || []).map((feature) => {
      const id = feature.properties?.[idKey]
      const row = byId.get(id)
      const value = metricValue(row, metricMode)
      const props = feature.properties || {}
      const isDelegation = idKey === 'deleg_id'
      const fallbackName = isDelegation ? 'Delegation inconnue' : 'Gouvernorat inconnu'
      const sourceName = props.display_name || props.deleg_name || props.gov_name || row?.name || row?.deleg_name || row?.gov_name || ''
      const displayName = isDelegation ? normalizeDelegationName(sourceName, fallbackName) : normalizeGovernorateName(sourceName, fallbackName)
      const govName = normalizeGovernorateName(props.gov_name || row?.gov_name || 'Gouvernorat inconnu')
      const displayLabel = props.display_label || (isDelegation ? `${displayName} - Delegation, ${govName}` : `${displayName} - Gouvernorat`)
      return {
        ...feature,
        properties: {
          ...props,
          display_name: displayName,
          display_label: displayLabel,
          needs_registry_review: !sourceName,
          metric_value: value,
          fill_color: metricColor(value, metricMode),
          observed_cells: row?.observed_cells || 0,
          congestion_rate: row?.congestion_rate || 0,
          avg_prb: row?.avg_prb || 0,
          avg_throughput: row?.avg_throughput || 0,
          status: row?.status || 'stable',
        },
      }
    }),
  }
}

function siteFeatureCollection(sites = []) {
  return {
    type: 'FeatureCollection',
    features: sites
      .filter((site) => Number.isFinite(site.longitude) && Number.isFinite(site.latitude))
      .map((site) => ({
        type: 'Feature',
        properties: {
          site_name: site.site_name,
          cell_name: site.worst_cell,
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
      })),
  }
}

function hasSource(map, id) {
  return Boolean(map?.getSource(id))
}

function hasLayer(map, id) {
  return Boolean(map?.getLayer(id))
}

function safeSetData(map, id, data) {
  if (hasSource(map, id)) map.getSource(id).setData(data)
}

function safeSetFilter(map, id, filter) {
  if (hasLayer(map, id)) map.setFilter(id, filter)
}

function safeSetPaint(map, id, prop, value) {
  if (hasLayer(map, id)) map.setPaintProperty(id, prop, value)
}

function safeSetLayout(map, id, prop, value) {
  if (hasLayer(map, id)) map.setLayoutProperty(id, prop, value)
}

export default function TunisiaMap({ governoratesGeo, delegationsGeo, governorateRows, delegationRows, filteredCells, scope, metricMode, metric, mapControls = DEFAULT_MAP_CONTROLS, onGovernorateClick, onDelegationClick, onCellClick, densityMode = 'full' }) {
  const mapNode = useRef(null)
  const mapRef = useRef(null)
  const transitionRef = useRef([])
  const clickHandlersRef = useRef({ onGovernorateClick, onDelegationClick, onCellClick })
  const sourceRef = useRef({ govSource: null, delSource: null, siteSource: null })
  const derivedMapStateRef = useRef(deriveMapState({ scope, mapControls }))
  const lastCameraRef = useRef('')
  const [hover, setHover] = useState(null)
  const [mapError, setMapError] = useState(null)
  const [mapReady, setMapReady] = useState(false)
  const hoveredLayerRef = useRef(null)
  const rafRef = useRef(null)

  function scheduleMapUpdate(fn) {
    if (rafRef.current) window.cancelAnimationFrame(rafRef.current)
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null
      fn()
    })
  }

  const govSource = useMemo(() => decorateFeatures(governoratesGeo, governorateRows, 'gov_id', metricMode), [governoratesGeo, governorateRows, metricMode])
  const delSource = useMemo(() => decorateFeatures(delegationsGeo, delegationRows, 'deleg_id', metricMode), [delegationsGeo, delegationRows, metricMode])
  const scopedCells = useMemo(() => {
    if (scope.level === 'national') return []
    if (scope.level === 'delegation' || scope.level === 'cell') return filteredCells.filter((cell) => cell.admin?.deleg_id === scope.delegationId)
    return []
  }, [filteredCells, scope])
  const siteSource = useMemo(() => siteFeatureCollection(buildSiteSummaries(scopedCells)), [scopedCells])
  const derivedMapState = useMemo(() => deriveMapState({ scope, mapControls }), [scope, mapControls])

  useEffect(() => {
    derivedMapStateRef.current = derivedMapState
    setHover(null)
  }, [derivedMapState])

  useEffect(() => {
    clickHandlersRef.current = { onGovernorateClick, onDelegationClick, onCellClick }
  }, [onGovernorateClick, onDelegationClick, onCellClick])

  useEffect(() => {
    sourceRef.current = { govSource, delSource, siteSource }
  }, [govSource, delSource, siteSource])

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
      })
    } catch (error) {
      setMapError(error?.message || 'MapLibre ne peut pas initialiser WebGL.')
      return undefined
    }
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-left')
    mapRef.current = map
    window.__netvisionMap = map
    map.on('load', () => {
      setMapReady(true)
      map.addSource('admin-governorates', { type: 'geojson', data: sourceRef.current.govSource })
      map.addSource('admin-delegations', { type: 'geojson', data: sourceRef.current.delSource })
      map.addSource('radio-sites', { type: 'geojson', data: sourceRef.current.siteSource })
      map.addLayer({ id: 'admin-governorates-fill', type: 'fill', source: 'admin-governorates', paint: { 'fill-color': ['get', 'fill_color'], 'fill-opacity': 0.94, 'fill-color-transition': { duration: 520, delay: 0 }, 'fill-opacity-transition': { duration: 420, delay: 0 } } })
      map.addLayer({ id: 'admin-governorates-line', type: 'line', source: 'admin-governorates', paint: { 'line-color': '#b99b77', 'line-width': 1.25 } })
      map.addLayer({ id: 'admin-governorates-selected', type: 'line', source: 'admin-governorates', filter: ['==', ['get', 'gov_id'], ''], paint: { 'line-color': '#ff7900', 'line-width': 4 } })
      map.addLayer({ id: 'admin-delegations-fill', type: 'fill', source: 'admin-delegations', paint: { 'fill-color': ['get', 'fill_color'], 'fill-opacity': 0.0, 'fill-color-transition': { duration: 520, delay: 0 }, 'fill-opacity-transition': { duration: 420, delay: 0 } } })
      map.addLayer({ id: 'admin-delegations-line', type: 'line', source: 'admin-delegations', paint: { 'line-color': '#cc6c18', 'line-width': 1.0, 'line-opacity': 0.0 } })
      map.addLayer({ id: 'admin-delegations-selected', type: 'line', source: 'admin-delegations', filter: ['==', ['get', 'deleg_id'], ''], paint: { 'line-color': '#b13f00', 'line-width': 3, 'line-opacity': 0.0 } })
      map.addLayer({ id: 'radio-sites', type: 'circle', source: 'radio-sites', paint: { 'circle-radius': ['interpolate', ['linear'], ['get', 'active_users'], 0, 4, 20, 8], 'circle-color': ['get', 'state_color'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.2, 'circle-opacity': 0.0, 'circle-color-transition': { duration: 520, delay: 0 }, 'circle-radius-transition': { duration: 520, delay: 0 }, 'circle-opacity-transition': { duration: 420, delay: 0 } } })
      map.addLayer({ id: 'radio-sites-heatmap', type: 'heatmap', source: 'radio-sites', paint: { 'heatmap-weight': ['interpolate', ['linear'], ['get', 'avg_prb'], 0, 0, 100, 1], 'heatmap-intensity': 0.85, 'heatmap-radius': 34, 'heatmap-opacity': 0.0, 'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(255,255,255,0)', 0.35, '#ffd08a', 0.7, '#ff7900', 1, '#b13f00'] } })
      map.addLayer({ id: 'radio-site-labels', type: 'symbol', source: 'radio-sites', layout: { 'text-field': ['get', 'site_name'], 'text-size': 10, 'text-offset': [0, 1.35], 'text-anchor': 'top', 'text-allow-overlap': false, 'text-ignore-placement': false, 'visibility': 'none' }, paint: { 'text-color': '#18222c', 'text-halo-color': '#ffffff', 'text-halo-width': 1.25 } })
      map.addLayer({ id: 'selected-cell', type: 'circle', source: 'radio-sites', filter: ['==', ['get', 'worst_cell'], ''], paint: { 'circle-radius': 17, 'circle-color': '#ff7900', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 4, 'circle-opacity': 0.95 } })
      map.on('click', 'admin-governorates-fill', (e) => e.features?.[0] && clickHandlersRef.current.onGovernorateClick(e.features[0].properties))
      map.on('click', 'admin-delegations-fill', (e) => e.features?.[0] && clickHandlersRef.current.onDelegationClick(e.features[0].properties))
      map.on('click', 'radio-sites', (e) => e.features?.[0] && clickHandlersRef.current.onCellClick(e.features[0].properties.worst_cell))
      ;['admin-governorates-fill', 'admin-delegations-fill', 'radio-sites'].forEach((layer) => {
        map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer' })
        map.on('mousemove', layer, (e) => {
          hoveredLayerRef.current = layer
          const props = e.features?.[0]?.properties || {}
          setHover({ layer, props })
        })
        map.on('mouseleave', layer, () => {
          if (hoveredLayerRef.current === layer) hoveredLayerRef.current = null
          map.getCanvas().style.cursor = ''
          setHover(null)
        })
      })
      map.on('mousemove', (e) => {
        const features = map.queryRenderedFeatures(e.point, { layers: derivedMapStateRef.current.hoverLayers })
        if (!features?.length) {
          hoveredLayerRef.current = null
          setHover(null)
          map.getCanvas().style.cursor = ''
          return
        }
        const feature = features[0]
        const layer = feature.layer?.id
        if (!layer) return
        hoveredLayerRef.current = layer
        map.getCanvas().style.cursor = 'pointer'
        setHover({ layer, props: feature.properties || {} })
      })
    })
    return () => {
      transitionRef.current.forEach(clearTimeout)
      if (rafRef.current) window.cancelAnimationFrame(rafRef.current)
      setMapReady(false)
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map?.isStyleLoaded()) return
    setHover(null)
    scheduleMapUpdate(() => {
      safeSetData(map, 'admin-governorates', govSource)
      safeSetData(map, 'admin-delegations', delSource)
      safeSetData(map, 'radio-sites', siteSource)
    })
  }, [govSource, delSource, siteSource, mapReady])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    transitionRef.current.forEach(clearTimeout)
    transitionRef.current = []
    const applyScopeRendering = () => scheduleMapUpdate(() => {
      if (!hasLayer(map, 'admin-governorates-fill')) {
        transitionRef.current.push(window.setTimeout(applyScopeRendering, 100))
        return
      }
      const next = deriveMapState({ scope, mapControls })
      safeSetFilter(map, 'admin-governorates-fill', next.filters.governorates)
      safeSetFilter(map, 'admin-governorates-line', next.filters.governorates)
      safeSetFilter(map, 'admin-governorates-selected', next.filters.governorateSelected)
      safeSetFilter(map, 'admin-delegations-fill', next.filters.delegations)
      safeSetFilter(map, 'admin-delegations-line', next.filters.delegations)
      safeSetFilter(map, 'admin-delegations-selected', next.filters.delegationSelected)
      safeSetFilter(map, 'selected-cell', next.filters.selectedCell)
      safeSetPaint(map, 'admin-delegations-fill', 'fill-opacity', next.visibility.delegations ? 0.62 : 0)
      safeSetPaint(map, 'admin-delegations-line', 'line-opacity', next.visibility.delegations ? 0.78 : 0)
      safeSetPaint(map, 'admin-delegations-selected', 'line-opacity', next.visibility.delegations ? 1 : 0)
      const compact = densityMode === 'compact'
      safeSetPaint(map, 'radio-sites', 'circle-opacity', next.visibility.sites && !next.visibility.heatmap ? (compact ? 0.78 : 0.92) : 0.24)
      safeSetPaint(map, 'radio-sites', 'circle-stroke-width', compact ? 0.9 : 1.2)
      safeSetPaint(map, 'radio-sites-heatmap', 'heatmap-opacity', next.visibility.heatmap ? 0.8 : 0)
      safeSetPaint(map, 'selected-cell', 'circle-opacity', next.visibility.selectedCell ? 0.95 : 0)
      safeSetLayout(map, 'radio-sites', 'visibility', next.visibility.sites ? 'visible' : 'none')
      safeSetLayout(map, 'radio-sites-heatmap', 'visibility', next.visibility.heatmap ? 'visible' : 'none')
      safeSetLayout(map, 'radio-site-labels', 'visibility', next.visibility.labels && !compact ? 'visible' : 'none')
      safeSetLayout(map, 'selected-cell', 'visibility', next.visibility.selectedCell ? 'visible' : 'none')
    })
    applyScopeRendering()
  }, [scope, mapControls, mapReady, densityMode])

  useEffect(() => {
    const map = mapRef.current
    if (!mapReady || !map) return
    const cameraKey = derivedMapState.cameraKey
    if (lastCameraRef.current === cameraKey) return
    lastCameraRef.current = cameraKey
    map.resize()
    if (scope.level === 'national') {
      map.fitBounds([[7.4, 30.2], [11.7, 37.6]], { padding: 42, duration: 800, easing: (t) => 1 - Math.pow(1 - t, 3) })
      return
    }
    if (scope.level === 'governorate' && scope.governorateId) {
      const feature = governoratesGeo.features.find((f) => f.properties.gov_id === scope.governorateId)
      if (feature) map.fitBounds(boundsForFeature(feature), { padding: { top: 96, bottom: 96, left: 96, right: 120 }, duration: 900, maxZoom: 8 })
      return
    }
    if ((scope.level === 'delegation' || scope.level === 'cell') && scope.delegationId) {
      const feature = delegationsGeo.features.find((f) => f.properties.deleg_id === scope.delegationId)
      if (feature) map.flyTo({ center: featureCenter(feature), zoom: 9.6, duration: 900, essential: true })
    }
  }, [scope.level, scope.governorateId, scope.delegationId, governoratesGeo, delegationsGeo, mapReady, derivedMapState.cameraKey])

  const hoverTitle = hover?.props?.site_name || hover?.props?.display_name || hover?.props?.gov_name || hover?.props?.deleg_name || 'Zone inconnue'
  const hoverType = hover?.layer === 'admin-delegations-fill' ? 'Delegation' : hover?.layer === 'admin-governorates-fill' ? 'Gouvernorat' : 'Site'
  const legendTicks = metric?.id === 'congestion_rate'
    ? [0, 50, 70, 85, 100]
    : metric?.id === 'avg_prb'
      ? [0, 20, 40, 60, 70, 80, 85, 90, 95, 100]
      : metric?.id === 'avg_throughput'
        ? [0, 5, 10, 15, 20, 25, 30, 35, 45, 60]
        : metric?.id === 'avg_cqi'
          ? [0, 3, 5, 7, 8, 9, 10, 11, 12, 15]
          : [0, 10, 20, 30, 40, 50, 60, 70, 85, 100]
  const fallbackCells = (filteredCells || [])
    .filter((cell) => Number.isFinite(Number(cell.prb_load)))
    .sort((a, b) => Number(b.prb_load || 0) - Number(a.prb_load || 0))
    .slice(0, 8)
  return (
    <div className="map-card">
      <div ref={mapNode} className="netvision-map-container" aria-label={`Carte ${metric.label}`} />
      {mapError ? <div className="map-fallback">
        <strong>Rendu cartographique indisponible</strong>
        <span>MapLibre ne peut pas demarrer WebGL dans cette session. Utilisez les classements et la recherche pour naviguer.</span>
        <code>{mapError}</code>
        {fallbackCells.length ? <div className="map-fallback-table"><strong>Voir cellules prioritaires</strong>{fallbackCells.map((cell) => <button key={cell.cell_name} type="button" onClick={() => onCellClick?.(cell.cell_name)}>{cell.cell_name} - PRB {Number(cell.prb_load || 0).toFixed(1)}%</button>)}</div> : null}
      </div> : null}
      <div className="map-toolbar"><strong>{metric.label}</strong><span>{scope.level === 'delegation' || scope.level === 'cell' ? `${mapControls?.heatmap ? 'Chaleur radio' : 'Sites radio'}` : 'Zones administratives'}</span></div>
      <div className="site-state-legend">
        {['healthy', 'watch', 'critical', 'degraded', 'no_data'].map((state) => <span key={state}><i style={{ background: stateColor(state) }} />{stateLabelFr(state)}</span>)}
      </div>
      <div className="map-legend numeric-map-legend" role="note" aria-label={`Indice numérique ${metric.label}`}><div /><span>Faible</span><span>Fort</span><div className="legend-ticks">{legendTicks.map((tick) => <b key={tick} style={{ color: metricColor(tick, metric.id) }}>{tick}{metric.unit || ''}</b>)}</div></div>
      {hover ? <div className="hover-card"><strong>{hoverTitle}</strong>{hover.props.site_name ? <><span>{hover.props.state_label} - {hover.props.cell_count} cellules</span><span>PRB {Number(hover.props.avg_prb || 0).toFixed(1)}% - Débit {Number(hover.props.avg_throughput || 0).toFixed(1)} Mbps - CQI {Number(hover.props.avg_cqi || 0).toFixed(1)}</span><em>Cliquer pour inspecter la cellule {hover.props.worst_cell}</em></> : <><span>{hoverType}{hover.props.gov_name && hoverType === 'Delegation' ? `, ${hover.props.gov_name}` : ''}</span><span>{Number(hover.props.observed_cells || 0)} cellules - congestion {Number(hover.props.congestion_rate || 0).toFixed(1)}%</span><span>{metric.label}: {Number(hover.props.metric_value || 0).toFixed(1)}{metric.unit}</span>{hover.props.needs_registry_review ? <span>Révision registre requise - ID {hover.props.deleg_id || hover.props.gov_id || 'inconnu'}</span> : null}<em>Cliquer pour zoomer</em></>}</div> : null}
    </div>
  )
}
