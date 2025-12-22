import maplibregl from 'maplibre-gl';

// ============================================
// NETVISION DIGITAL TWIN - TIME-SERIES EDITION
// ============================================

// --- Configuration ---
const CONFIG = {
    DEFAULT_BEAMWIDTH: 60,
    DEFAULT_RADIUS_METERS: 400,
    TA_TO_METERS: 78,
    MIN_RADIUS: 150,
    MAX_RADIUS: 2000,
    MAP_CENTER: [10.58, 35.82],
    MAP_ZOOM: 11,
    SECTOR_MIN_ZOOM: 10,
    MAX_ALERTS_RENDER: 50,
    
    COLORS: {
        CONGESTED: '#FF7900',
        HIGH_LOAD: '#FFB74D',
        MEDIUM_LOAD: '#FDD835',
        LOW_LOAD: '#AED581',
        HEALTHY: '#66BB6A',
        IDLE: '#90CAF9',
        NO_DATA: '#9E9E9E',
        SITE_MARKER: '#FF7900'
    },
    
    BASEMAPS: {
        satellite: {
            tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
            attribution: '&copy; Esri'
        },
        dark: {
            tiles: ['https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png'],
            attribution: '&copy; Stadia Maps'
        },
        streets: {
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            attribution: '&copy; OpenStreetMap'
        },
        light: {
            tiles: ['https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png'],
            attribution: '&copy; Stadia Maps'
        }
    }
};

// --- State Management ---
const state = {
    baseline: {},           // Static cell info (coordinates, azimuth, band)
    timeIndex: [],          // List of available timestamps
    currentTimeIndex: 0,    // Currently selected time index
    currentObservations: {},// Current time slice observations
    currentStats: null,     // Stats for current time slice
    globalStats: null,      // Global stats
    
    features: [],           // GeoJSON features for current time
    pointFeatures: [],
    sectorFeatures: [],
    
    map: null,
    popup: null,
    isPlaying: false,
    playInterval: null,
    
    filters: {
        status: { congested: true, 'high-load': true, normal: true, idle: true, 'no-data': true },
        bands: {},
        loadRange: [0, 100]
    },
    layers: {
        sectors: true,
        sites: true,
        heatmap: false
    }
};

let hasInitialized = false;

// --- Utility Functions ---
function createSectorPolygon(center, radiusMeters, azimuth, beamwidth) {
    const steps = 24;
    const earthRadius = 6378137;
    const latRad = (center[1] * Math.PI) / 180;
    const startAzimuth = azimuth - beamwidth / 2;
    const endAzimuth = azimuth + beamwidth / 2;
    const coordinates = [center];
    
    for (let i = 0; i <= steps; i++) {
        const currentAzimuth = startAzimuth + (i / steps) * (endAzimuth - startAzimuth);
        const angleRad = ((90 - currentAzimuth) * Math.PI) / 180;
        const dx = radiusMeters * Math.cos(angleRad);
        const dy = radiusMeters * Math.sin(angleRad);
        const dLon = dx / (earthRadius * Math.cos(latRad) * (Math.PI / 180));
        const dLat = dy / (earthRadius * (Math.PI / 180));
        coordinates.push([center[0] + dLon, center[1] + dLat]);
    }
    coordinates.push(center);
    return [coordinates];
}

function getLoadColor(load, isCongested) {
    if (isCongested) return CONFIG.COLORS.CONGESTED;
    if (load === null || load === undefined) return CONFIG.COLORS.NO_DATA;
    if (load === 0) return CONFIG.COLORS.IDLE;
    if (load < 30) return CONFIG.COLORS.HEALTHY;
    if (load < 50) return CONFIG.COLORS.LOW_LOAD;
    if (load < 70) return CONFIG.COLORS.MEDIUM_LOAD;
    if (load < 85) return CONFIG.COLORS.HIGH_LOAD;
    return CONFIG.COLORS.CONGESTED;
}

function getCellStatus(obs) {
    if (!obs) return 'no-data';
    if (obs.congested) return 'congested';
    if (obs.load === null) return 'no-data';
    if (obs.load === 0) return 'idle';
    if (obs.load >= 70) return 'high-load';
    return 'normal';
}

function formatNumber(num, decimals = 1) {
    if (num === null || num === undefined) return 'N/A';
    return Number(num).toFixed(decimals);
}

function formatThroughput(kbps) {
    if (kbps === null || kbps === undefined) return 'N/A';
    if (kbps >= 1000) return (kbps / 1000).toFixed(1) + ' Mbps';
    return kbps.toFixed(0) + ' Kbps';
}

function formatLargeNumber(num) {
    if (num === null || num === undefined) return '--';
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return String(num);
}

// --- Data Processing ---
function buildFeaturesForTime(observations) {
    const pointFeatures = [];
    const sectorFeatures = [];
    const sites = new Map();
    
    let index = 0;
    for (const [cellName, baseInfo] of Object.entries(state.baseline)) {
        const obs = observations[cellName] || null;
        const center = [baseInfo.longitude, baseInfo.latitude];
        const azimuth = baseInfo.azimuth || 0;
        const band = baseInfo.frequency_band;
        
        const status = getCellStatus(obs);
        const load = obs?.load ?? null;
        const color = getLoadColor(load, obs?.congested);
        const opacity = obs ? 0.7 : 0.4;
        
        // Point feature
        pointFeatures.push({
            type: 'Feature',
            id: index,
            properties: {
                id: index,
                cell_name: cellName,
                enodeb_name: baseInfo.enodeb_name,
                status,
                color,
                opacity,
                load,
                congested: obs?.congested || false,
                issue_type: obs?.issue_type || 'Normal',
                root_cause: obs?.root_cause || '-',
                severity: obs?.severity ?? 0,
                health_score: obs?.health_score ?? 100,
                throughput: obs?.throughput,
                cqi: obs?.cqi,
                traffic: obs?.traffic,
                ta: obs?.ta,
                signal_power: obs?.signal_power,
                band,
                azimuth
            },
            geometry: { type: 'Point', coordinates: center }
        });
        
        // Sector feature
        let radius = CONFIG.DEFAULT_RADIUS_METERS;
        if (obs?.ta && obs.ta > 0) {
            radius = Math.max(CONFIG.MIN_RADIUS, Math.min(CONFIG.MAX_RADIUS, obs.ta * CONFIG.TA_TO_METERS));
        }
        const geometry = createSectorPolygon(center, radius, azimuth, CONFIG.DEFAULT_BEAMWIDTH);
        
        sectorFeatures.push({
            type: 'Feature',
            id: index,
            properties: {
                id: index,
                cell_name: cellName,
                enodeb_name: baseInfo.enodeb_name,
                status,
                color,
                opacity,
                load,
                congested: obs?.congested || false,
                band,
                azimuth
            },
            geometry: { type: 'Polygon', coordinates: geometry }
        });
        
        // Track sites
        const siteName = baseInfo.enodeb_name;
        if (!sites.has(siteName)) {
            sites.set(siteName, { name: siteName, coordinates: center, cells: [] });
        }
        sites.get(siteName).cells.push(cellName);
        
        index++;
    }
    
    return { pointFeatures, sectorFeatures, sites: Array.from(sites.values()) };
}

// --- Time Navigation ---
async function loadTimeSlice(index) {
    if (index < 0 || index >= state.timeIndex.length) return;
    
    const timeEntry = state.timeIndex[index];
    state.currentTimeIndex = index;
    
    // Fetch time slice data
    try {
        const res = await fetch(`/time_data/${timeEntry.filename}?t=${Date.now()}`);
        const data = await res.json();
        
        state.currentObservations = data.observations;
        state.currentStats = data.stats;
        
        // Rebuild features
        const { pointFeatures, sectorFeatures, sites } = buildFeaturesForTime(data.observations);
        state.pointFeatures = pointFeatures;
        state.sectorFeatures = sectorFeatures;
        state.features = pointFeatures;
        
        // Update map
        updateMapData();
        
        // Update UI
        updateStatsUI(data.stats);
        updateAlertsUI(pointFeatures);
        updateTimeSliderUI();
        
    } catch (err) {
        console.error('Failed to load time slice:', err);
    }
}

function updateMapData() {
    if (!state.map) return;
    
    const pointsGeojson = { type: 'FeatureCollection', features: state.pointFeatures };
    const sectorsGeojson = { type: 'FeatureCollection', features: state.sectorFeatures };
    
    if (state.map.getSource('cells')) {
        state.map.getSource('cells').setData(pointsGeojson);
    }
    if (state.map.getSource('cells-heatmap-source')) {
        state.map.getSource('cells-heatmap-source').setData(pointsGeojson);
    }
    if (state.map.getSource('sectors')) {
        state.map.getSource('sectors').setData(sectorsGeojson);
    }
}

function updateTimeSliderUI() {
    const slider = document.getElementById('time-slider');
    const currentLabel = document.getElementById('time-current-label');
    const timestampEl = document.getElementById('timestamp');
    
    if (slider) {
        slider.value = state.currentTimeIndex;
    }
    
    const currentTime = state.timeIndex[state.currentTimeIndex]?.timestamp || '--';
    if (currentLabel) currentLabel.textContent = currentTime;
    if (timestampEl) timestampEl.textContent = currentTime;
}

function setupTimeControls() {
    const slider = document.getElementById('time-slider');
    const prevBtn = document.getElementById('time-prev');
    const nextBtn = document.getElementById('time-next');
    const playBtn = document.getElementById('time-play');
    const startLabel = document.getElementById('time-start-label');
    const endLabel = document.getElementById('time-end-label');
    
    if (slider && state.timeIndex.length > 0) {
        slider.min = 0;
        slider.max = state.timeIndex.length - 1;
        slider.value = 0;
        
        slider.addEventListener('input', (e) => {
            loadTimeSlice(parseInt(e.target.value));
        });
    }
    
    if (startLabel && state.timeIndex.length > 0) {
        startLabel.textContent = state.timeIndex[0]?.timestamp || '--';
    }
    if (endLabel && state.timeIndex.length > 0) {
        endLabel.textContent = state.timeIndex[state.timeIndex.length - 1]?.timestamp || '--';
    }
    
    prevBtn?.addEventListener('click', () => {
        if (state.currentTimeIndex > 0) {
            loadTimeSlice(state.currentTimeIndex - 1);
        }
    });
    
    nextBtn?.addEventListener('click', () => {
        if (state.currentTimeIndex < state.timeIndex.length - 1) {
            loadTimeSlice(state.currentTimeIndex + 1);
        }
    });
    
    playBtn?.addEventListener('click', () => {
        state.isPlaying = !state.isPlaying;
        const icon = playBtn.querySelector('.material-symbols-outlined');
        
        if (state.isPlaying) {
            playBtn.classList.add('playing');
            icon.textContent = 'pause';
            state.playInterval = setInterval(() => {
                if (state.currentTimeIndex < state.timeIndex.length - 1) {
                    loadTimeSlice(state.currentTimeIndex + 1);
                } else {
                    loadTimeSlice(0); // Loop back
                }
            }, 500);
        } else {
            playBtn.classList.remove('playing');
            icon.textContent = 'play_arrow';
            clearInterval(state.playInterval);
        }
    });
}

// --- UI Updates ---
function updateStatsUI(stats) {
    const totalCells = Object.keys(state.baseline).length;
    
    document.querySelector('#stat-total .stat-value').textContent = formatLargeNumber(totalCells);
    document.querySelector('#stat-congested .stat-value').textContent = formatLargeNumber(stats?.congested || 0);
    document.querySelector('#stat-high-load .stat-value').textContent = formatLargeNumber(
        Math.round((stats?.avg_load || 0) > 70 ? stats?.cells_observed * 0.3 : stats?.cells_observed * 0.15)
    );
    document.querySelector('#stat-healthy .stat-value').textContent = formatLargeNumber(
        (stats?.cells_observed || 0) - (stats?.congested || 0)
    );
    
    document.getElementById('metric-avg-load').textContent = (stats?.avg_load || 0).toFixed(1) + '%';
    document.getElementById('progress-load').style.width = Math.min(stats?.avg_load || 0, 100) + '%';
    document.getElementById('metric-avg-throughput').textContent = formatThroughput(stats?.avg_throughput);
    document.getElementById('metric-avg-cqi').textContent = (stats?.avg_cqi || 0).toFixed(1);
    document.getElementById('metric-coverage').textContent = 
        Math.round(((stats?.cells_observed || 0) / totalCells) * 100) + '%';
    
    // Health gauge
    const gaugeValue = document.getElementById('gauge-value');
    const gaugeFill = document.getElementById('gauge-fill');
    if (gaugeValue && gaugeFill) {
        const hs = stats?.avg_health || 75;
        gaugeValue.textContent = Math.round(hs);
        const length = 157;
        const dash = (hs / 100) * length;
        gaugeFill.style.strokeDasharray = `${dash} ${length}`;
    }
}

function updateAlertsUI(features) {
    const alertsList = document.getElementById('alerts-list');
    const congested = features.filter(f => f.properties.congested);
    
    const badge = document.getElementById('alert-count');
    if (badge) badge.textContent = String(congested.length);
    
    if (congested.length === 0) {
        alertsList.innerHTML = '<div class="alert-placeholder">✓ No active alerts</div>';
        return;
    }
    
    alertsList.innerHTML = congested.slice(0, CONFIG.MAX_ALERTS_RENDER).map(f => `
        <div class="alert-item" data-cell-id="${f.properties.id}">
            <span class="material-symbols-outlined">error</span>
            <div class="alert-item-content">
                <div class="alert-item-title">${f.properties.cell_name}</div>
                <div class="alert-item-desc">${f.properties.issue_type} • Load: ${formatNumber(f.properties.load)}%</div>
            </div>
        </div>
    `).join('');
}

// --- Map Initialization ---
function initMap() {
    const map = new maplibregl.Map({
        container: 'map',
        style: {
            version: 8,
            sources: {
                'basemap': {
                    type: 'raster',
                    tiles: CONFIG.BASEMAPS.satellite.tiles,
                    tileSize: 256,
                    attribution: CONFIG.BASEMAPS.satellite.attribution
                }
            },
            layers: [{
                id: 'basemap-layer',
                type: 'raster',
                source: 'basemap',
                minzoom: 0,
                maxzoom: 22
            }]
        },
        center: CONFIG.MAP_CENTER,
        zoom: CONFIG.MAP_ZOOM,
        pitch: 45,
        bearing: 0,
        antialias: true
    });
    
    map.addControl(new maplibregl.NavigationControl(), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    
    state.map = map;
    state.popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 15 });
    
    return map;
}

function addMapLayers(map, sites) {
    const pointsGeojson = { type: 'FeatureCollection', features: state.pointFeatures };
    const sectorsGeojson = { type: 'FeatureCollection', features: state.sectorFeatures };
    
    // Sectors source
    map.addSource('sectors', { type: 'geojson', data: sectorsGeojson });
    
    // Sector fill
    map.addLayer({
        id: 'sectors-fill',
        type: 'fill',
        source: 'sectors',
        minzoom: CONFIG.SECTOR_MIN_ZOOM,
        paint: {
            'fill-color': ['get', 'color'],
            'fill-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.4, 14, 0.6]
        }
    });
    
    // Sector outline
    map.addLayer({
        id: 'sectors-outline',
        type: 'line',
        source: 'sectors',
        minzoom: CONFIG.SECTOR_MIN_ZOOM,
        paint: {
            'line-color': '#ffffff',
            'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1, 14, 2],
            'line-opacity': 0.5
        }
    });
    
    // Separate source for heatmap (no clustering)
    map.addSource('cells-heatmap-source', {
        type: 'geojson',
        data: pointsGeojson
    });
    
    // Points source with clustering
    map.addSource('cells', {
        type: 'geojson',
        data: pointsGeojson,
        cluster: true,
        clusterRadius: 50,
        clusterMaxZoom: 12
    });
    
    // Heatmap layer
    map.addLayer({
        id: 'cells-heatmap',
        type: 'heatmap',
        source: 'cells-heatmap-source',
        maxzoom: 24,
        layout: { 'visibility': 'none' },
        paint: {
            'heatmap-weight': ['interpolate', ['linear'], ['coalesce', ['get', 'load'], 50], 0, 0, 50, 0.5, 100, 1],
            'heatmap-intensity': [
    'interpolate',
    ['linear'],
    ['zoom'],
    10, 3,  // Higher intensity when zoomed OUT
    15, 1   // Lower intensity when zoomed IN
],
            'heatmap-opacity': 0.8,
            'heatmap-color': [
                'interpolate', ['linear'], ['heatmap-density'],
                0, 'rgba(0,0,0,0)',
                0.1, 'rgba(30,60,150,0.6)',
                0.2, 'rgba(0,120,180,0.7)',
                0.3, 'rgba(0,180,150,0.75)',
                0.4, 'rgba(100,200,80,0.8)',
                0.5, 'rgba(180,220,50,0.82)',
                0.6, 'rgba(240,200,30,0.85)',
                0.7, 'rgba(255,150,20,0.88)',
                0.8, 'rgba(255,80,20,0.92)',
                0.9, 'rgba(240,30,30,0.96)',
                1, 'rgba(180,0,50,1)'
            ]
        }
    });
    
    // Cluster circles - Scaled by zoom
    map.addLayer({
        id: 'cells-clusters',
        type: 'circle',
        source: 'cells',
        filter: ['has', 'point_count'],
        paint: {
            'circle-color': [
                'step', 
                ['get', 'point_count'],
                CONFIG.COLORS.HEALTHY, 
                20, CONFIG.COLORS.LOW_LOAD,
                50, CONFIG.COLORS.MEDIUM_LOAD,
                100, CONFIG.COLORS.HIGH_LOAD,
                200, CONFIG.COLORS.CONGESTED
            ],
            'circle-radius': [
                '*',
                [
                    'interpolate', ['linear'], ['zoom'],
                    10, 0.6,
                    13, 0.8,
                    16, 1.2
                ],
                [
                    'step',
                    ['get', 'point_count'],
                    15,   // 0-19 points: 15px
                    20, 18,   // 20-49 points: 18px
                    50, 22,   // 50-99 points: 22px
                    100, 26   // 100+ points: 26px
                ]
            ],
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2
        }
    });
    
    // Cluster labels
    map.addLayer({
        id: 'cells-cluster-count',
        type: 'symbol',
        source: 'cells',
        filter: ['has', 'point_count'],
        layout: {
            'text-field': ['get', 'point_count_abbreviated'],
            'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
            'text-size': [
                'interpolate', ['linear'], ['zoom'],
                10, 9,
                13, 12,
                16, 14
            ],
            'text-allow-overlap': true
        },
        paint: {
            'text-color': '#ffffff',
            'text-halo-color': 'rgba(0,0,0,0.5)',
            'text-halo-width': 1
        }
    });
    
    // Individual points - Scaled by zoom
    map.addLayer({
        id: 'cells-points',
        type: 'circle',
        source: 'cells',
        filter: ['!', ['has', 'point_count']],
        paint: {
            'circle-radius': [
                'interpolate', ['linear'], ['zoom'],
                10, 2,
                13, 5,
                16, 8
            ],
            'circle-color': ['get', 'color'],
            'circle-opacity': 0.8,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 1.5
        }
    });
    
    // Congested ring - Scaled by zoom
    map.addLayer({
        id: 'cells-congested-ring',
        type: 'circle',
        source: 'cells',
        filter: ['all', ['!', ['has', 'point_count']], ['==', ['get', 'congested'], true]],
        paint: {
            'circle-radius': [
                'interpolate', ['linear'], ['zoom'],
                10, 3,
                13, 8,
                16, 12
            ],
            'circle-color': 'rgba(0,0,0,0)',
            'circle-stroke-color': CONFIG.COLORS.CONGESTED,
            'circle-stroke-width': 2.5
        }
    });
    
    // Sites source
    const sitesGeojson = {
        type: 'FeatureCollection',
        features: sites.map((site, i) => ({
            type: 'Feature',
            id: i,
            properties: { name: site.name, cellCount: site.cells.length },
            geometry: { type: 'Point', coordinates: site.coordinates }
        }))
    };
    
    map.addSource('sites', { type: 'geojson', data: sitesGeojson });
    
    // Site markers - Scaled by zoom
    map.addLayer({
        id: 'sites-circle',
        type: 'circle',
        source: 'sites',
        paint: {
            'circle-radius': [
                'interpolate', ['linear'], ['zoom'],
                10, 3,
                13, 6,
                16, 10
            ],
            'circle-color': CONFIG.COLORS.SITE_MARKER,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2
        }
    });
}

function setupMapInteractions(map) {
    // Click handlers
    map.on('click', 'cells-clusters', (e) => {
        const features = map.queryRenderedFeatures(e.point, { layers: ['cells-clusters'] });
        if (!features.length) return;
        const clusterId = features[0].properties.cluster_id;
        map.getSource('cells').getClusterExpansionZoom(clusterId, (err, zoom) => {
            if (err) return;
            map.easeTo({ center: features[0].geometry.coordinates, zoom: zoom + 1 });
        });
    });
    
    // Hover popup for cells
    map.on('mouseenter', 'cells-points', (e) => {
        map.getCanvas().style.cursor = 'pointer';
        const p = e.features[0].properties;
        state.popup
            .setLngLat(e.lngLat)
            .setHTML(`
                <div style="padding: 10px; font-family: Inter, sans-serif; min-width: 180px;">
                    <div style="font-weight: 600; margin-bottom: 6px; color: ${p.color};">${p.cell_name}</div>
                    <div style="font-size: 12px; color: #a0aec0;">
                        <div>Site: ${p.enodeb_name}</div>
                        <div>Load: ${formatNumber(p.load)}%</div>
                        <div>CQI: ${formatNumber(p.cqi)}</div>
                        <div>Status: ${p.status}</div>
                    </div>
                </div>
            `)
            .addTo(map);
    });
    
    map.on('mouseleave', 'cells-points', () => {
        map.getCanvas().style.cursor = '';
        state.popup.remove();
    });
}

function setVisualizationMode(mode) {
    if (!state.map) return;
    state.layers.heatmap = mode === 'heatmap';
    
    // Heatmap
    if (state.map.getLayer('cells-heatmap')) {
        state.map.setLayoutProperty('cells-heatmap', 'visibility', mode === 'heatmap' ? 'visible' : 'none');
        if (mode === 'heatmap') state.map.moveLayer('cells-heatmap');
    }
    
    // Hide everything else in heatmap mode
    const hideInHeatmap = ['cells-clusters', 'cells-cluster-count', 'cells-points', 'cells-congested-ring', 
                          'sectors-fill', 'sectors-outline', 'sites-circle'];
    hideInHeatmap.forEach(id => {
        if (state.map.getLayer(id)) {
            state.map.setLayoutProperty(id, 'visibility', mode === 'heatmap' ? 'none' : 'visible');
        }
    });
    
    document.querySelectorAll('.toggle-btn[data-viz]').forEach(b => {
        b.classList.toggle('active', b.dataset.viz === mode);
    });
}

// --- Event Handlers ---
function setupEventHandlers() {
    // Visualization toggle
    document.querySelectorAll('.toggle-btn[data-viz]').forEach(btn => {
        btn.addEventListener('click', () => setVisualizationMode(btn.dataset.viz));
    });
    
    // Basemap select
    document.getElementById('basemap-select')?.addEventListener('change', (e) => {
        const basemap = CONFIG.BASEMAPS[e.target.value];
        if (basemap && state.map) {
            state.map.getSource('basemap').tiles = basemap.tiles;
            state.map.style.sourceCaches['basemap'].clearTiles();
            state.map.style.sourceCaches['basemap'].update(state.map.transform);
            state.map.triggerRepaint();
        }
    });
    
    // Sidebar toggles
    document.getElementById('toggle-left')?.addEventListener('click', () => {
        document.getElementById('sidebar-left')?.classList.toggle('collapsed');
    });
    document.getElementById('toggle-right')?.addEventListener('click', () => {
        document.getElementById('sidebar-right')?.classList.toggle('collapsed');
    });
}

function setLoading(isLoading, progress = '') {
    const overlay = document.getElementById('loading-overlay');
    if (!overlay) return;
    overlay.classList.toggle('hidden', !isLoading);
    const p = document.getElementById('loading-progress');
    if (p && progress) p.textContent = progress;
}

// --- Main Initialization ---
async function init() {
    if (hasInitialized) return;
    hasInitialized = true;
    try {
        setLoading(true, 'Loading baseline...');
        
        // Load baseline (static cell info)
        const [baselineRes, timeIndexRes, statsRes] = await Promise.all([
            fetch('/baseline.json?t=' + Date.now()),
            fetch('/time_index.json?t=' + Date.now()),
            fetch('/stats.json?t=' + Date.now())
        ]);
        
        state.baseline = await baselineRes.json();
        const timeIndexData = await timeIndexRes.json();
        state.timeIndex = timeIndexData.timestamps;
        state.globalStats = await statsRes.json();
        
        console.log(`Loaded ${Object.keys(state.baseline).length} cells, ${state.timeIndex.length} time slices`);
        
        setLoading(true, 'Loading initial time slice...');
        
        // Load first time slice
        await loadTimeSlice(0);
        
        setLoading(true, 'Initializing map...');
        
        // Build initial features
        const { pointFeatures, sectorFeatures, sites } = buildFeaturesForTime(state.currentObservations);
        state.pointFeatures = pointFeatures;
        state.sectorFeatures = sectorFeatures;
        
        // Initialize map
        const map = initMap();
        
        map.on('load', () => {
            addMapLayers(map, sites);
            setupMapInteractions(map);
            
            // Fit bounds
            if (pointFeatures.length > 0) {
                const bounds = new maplibregl.LngLatBounds();
                pointFeatures.forEach(f => bounds.extend(f.geometry.coordinates));
                map.fitBounds(bounds, { padding: 50, maxZoom: 13 });
            }
            
            setLoading(false);
        });
        
        // Setup controls
        setupTimeControls();
        setupEventHandlers();
        
    } catch (err) {
        console.error('Initialization failed:', err);
        setLoading(false);
    }
document.addEventListener('DOMContentLoaded', init);
}

// Start
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}