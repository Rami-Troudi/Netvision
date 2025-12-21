import './style.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import maplibregl from 'maplibre-gl';

// ============================================
// NETVISION DIGITAL TWIN - MAIN APPLICATION
// ============================================

// --- Configuration ---
const CONFIG = {
    DEFAULT_BEAMWIDTH: 60,
    DEFAULT_RADIUS_METERS: 400,
    TA_TO_METERS: 78,
    MIN_RADIUS: 150,
    MAX_RADIUS: 2000,
    MAP_CENTER: [10.58, 35.82],
    MAP_ZOOM: 12,
    
    // Color scheme - Orange Brand Palette
    COLORS: {
        CONGESTED: '#FF7900',      // Orange primary for congestion
        HIGH_LOAD: '#FFB74D',      // Soft orange
        MEDIUM_LOAD: '#FDD835',    // Yellow
        LOW_LOAD: '#AED581',       // Light green
        HEALTHY: '#66BB6A',        // Green
        IDLE: '#90CAF9',           // Soft blue
        NO_DATA: '#9E9E9E',        // Gray
        SITE_MARKER: '#FF7900'     // Orange primary
    },
    
    // Basemaps
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
        }
    }
};

// --- State Management ---
const state = {
    data: [],
    filteredData: [],
    features: [],
    siteMarkers: [],
    map: null,
    popup: null,
    filters: {
        status: {
            congested: true,
            'high-load': true,
            normal: true,
            idle: true,
            'no-data': true
        },
        bands: {},
        loadRange: [0, 100]
    },
    layers: {
        sectors: true,
        sites: true,
        labels: false
    }
};

// --- Utility Functions ---
function createSectorPolygon(center, radiusMeters, azimuth, beamwidth) {
    const steps = 36;
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

function getCellStatus(item) {
    if (item.congested) return 'congested';
    if (item.ft_physical_resource_blocks_load_dl === null) return 'no-data';
    if (item.ft_physical_resource_blocks_load_dl === 0) return 'idle';
    if (item.ft_physical_resource_blocks_load_dl >= 70) return 'high-load';
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

// --- Data Processing ---
function processData(rawData) {
    const features = [];
    const sites = new Map();
    const bands = new Set();
    
    rawData.forEach((item, index) => {
        if (!item.longitude_sector || !item.latitude_sector) return;
        
        const center = [parseFloat(item.longitude_sector), parseFloat(item.latitude_sector)];
        const azimuth = parseFloat(item.azimuth) || 0;
        const load = item.ft_physical_resource_blocks_load_dl;
        const band = item.frequency_band;
        
        // Track frequency bands
        if (band) bands.add(band);
        
        // Calculate radius from TA
        let radius = CONFIG.DEFAULT_RADIUS_METERS;
        if (item.ot_average_ta != null && item.ot_average_ta > 0) {
            radius = Math.max(CONFIG.MIN_RADIUS, Math.min(CONFIG.MAX_RADIUS, item.ot_average_ta * CONFIG.TA_TO_METERS));
        }
        
        // Create sector geometry
        const geometry = createSectorPolygon(center, radius, azimuth, CONFIG.DEFAULT_BEAMWIDTH);
        
        // Determine color and status
        const status = getCellStatus(item);
        const color = getLoadColor(load, item.congested);
        
        // Calculate opacity based on signal power
        let opacity = 0.7;
        if (item.referencesignalpwr) {
            const norm = Math.max(0, Math.min(1, (item.referencesignalpwr - 140) / 50));
            opacity = 0.5 + (norm * 0.35);
        }
        if (status === 'no-data') opacity = 0.4;
        
        // Create feature
        features.push({
            type: 'Feature',
            id: index,
            properties: {
                id: index,
                cell_name: item.cell_name || `Cell_${index}`,
                enodeb_name: item.enodeb_name,
                status: status,
                color: color,
                opacity: opacity,
                load: load,
                congested: item.congested,
                root_cause: item.root_cause || '-',
                traffic: item.l_traffic_activeuser_dl_avg,
                throughput: item.ft_ave_4g_lte_dl_user_thrput_without_last_tti_all___kbps__kbit_,
                cqi: item.ft_4g_lte_average_reported_cqi,
                ta: item.ot_average_ta,
                band: band,
                signal_power: item.referencesignalpwr
            },
            geometry: {
                type: 'Polygon',
                coordinates: geometry
            }
        });
        
        // Track unique sites
        const siteKey = `${center[0]}_${center[1]}`;
        if (!sites.has(siteKey)) {
            sites.set(siteKey, {
                name: item.enodeb_name,
                coordinates: center,
                cells: []
            });
        }
        sites.get(siteKey).cells.push(item.cell_name);
    });
    
    return { features, sites: Array.from(sites.values()), bands: Array.from(bands).sort((a, b) => a - b) };
}

// --- Statistics Calculation ---
function calculateStats(features) {
    const total = features.length;
    let congested = 0, highLoad = 0, healthy = 0, noData = 0, idle = 0;
    let totalLoad = 0, loadCount = 0;
    let totalThroughput = 0, throughputCount = 0;
    let totalCqi = 0, cqiCount = 0;
    
    features.forEach(f => {
        const p = f.properties;
        
        switch (p.status) {
            case 'congested': congested++; break;
            case 'high-load': highLoad++; break;
            case 'idle': idle++; break;
            case 'no-data': noData++; break;
            default: healthy++;
        }
        
        if (p.load !== null && p.load !== undefined) {
            totalLoad += p.load;
            loadCount++;
        }
        
        if (p.throughput !== null && p.throughput !== undefined) {
            totalThroughput += p.throughput;
            throughputCount++;
        }
        
        if (p.cqi !== null && p.cqi !== undefined) {
            totalCqi += p.cqi;
            cqiCount++;
        }
    });
    
    return {
        total,
        congested,
        highLoad,
        healthy: healthy + idle,
        noData,
        avgLoad: loadCount > 0 ? totalLoad / loadCount : 0,
        avgThroughput: throughputCount > 0 ? totalThroughput / throughputCount : 0,
        avgCqi: cqiCount > 0 ? totalCqi / cqiCount : 0,
        dataCoverage: ((total - noData) / total) * 100
    };
}

// --- UI Updates ---
function updateStatsUI(stats) {
    document.querySelector('#stat-total .stat-value').textContent = stats.total;
    document.querySelector('#stat-congested .stat-value').textContent = stats.congested;
    document.querySelector('#stat-high-load .stat-value').textContent = stats.highLoad;
    document.querySelector('#stat-healthy .stat-value').textContent = stats.healthy;
    
    document.getElementById('metric-avg-load').textContent = stats.avgLoad.toFixed(1) + '%';
    document.getElementById('progress-load').style.width = stats.avgLoad + '%';
    document.getElementById('metric-avg-throughput').textContent = formatThroughput(stats.avgThroughput);
    document.getElementById('metric-avg-cqi').textContent = stats.avgCqi.toFixed(1);
    document.getElementById('metric-coverage').textContent = stats.dataCoverage.toFixed(0) + '%';
}

function updateAlertsUI(features) {
    const alertsList = document.getElementById('alerts-list');
    const congested = features.filter(f => f.properties.congested);
    
    if (congested.length === 0) {
        alertsList.innerHTML = '<div class="alert-placeholder">✓ No active alerts</div>';
        return;
    }
    
    alertsList.innerHTML = congested.slice(0, 5).map(f => `
        <div class="alert-item" data-cell-id="${f.properties.id}">
            <span class="material-symbols-outlined">error</span>
            <div class="alert-item-content">
                <div class="alert-item-title">${f.properties.cell_name}</div>
                <div class="alert-item-desc">${f.properties.root_cause} • Load: ${formatNumber(f.properties.load)}%</div>
            </div>
        </div>
    `).join('');
    
    // Click handler for alerts
    alertsList.querySelectorAll('.alert-item').forEach(item => {
        item.addEventListener('click', () => {
            const cellId = parseInt(item.dataset.cellId);
            const feature = features.find(f => f.properties.id === cellId);
            if (feature && state.map) {
                state.map.flyTo({
                    center: feature.geometry.coordinates[0][0],
                    zoom: 15,
                    pitch: 60
                });
            }
        });
    });
}

function updateCellInfoPanel(props) {
    const panel = document.getElementById('cell-info-panel');
    const nameEl = document.getElementById('cell-info-name');
    const statusEl = document.getElementById('cell-status');
    const bodyEl = document.getElementById('cell-info-body');
    
    panel.classList.remove('hidden');
    nameEl.textContent = props.cell_name;
    
    // Status badge
    statusEl.textContent = props.congested ? 'Congested' : (props.status === 'high-load' ? 'High Load' : 'Normal');
    statusEl.className = 'cell-status ' + (props.congested ? 'congested' : (props.status === 'high-load' ? 'warning' : 'normal'));
    
    // Info rows
    const loadClass = props.load >= 80 ? 'danger' : (props.load >= 60 ? 'warning' : 'success');
    
    bodyEl.innerHTML = `
        <div class="info-row">
            <span class="info-label">Site</span>
            <span class="info-value">${props.enodeb_name || 'N/A'}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Frequency Band</span>
            <span class="info-value">${props.band ? 'B' + props.band : 'N/A'}</span>
        </div>
        <div class="info-row">
            <span class="info-label">PRB Load</span>
            <span class="info-value ${props.load !== null ? loadClass : ''}">${props.load !== null ? formatNumber(props.load) + '%' : 'No Data'}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Throughput</span>
            <span class="info-value">${formatThroughput(props.throughput)}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Active Users</span>
            <span class="info-value">${formatNumber(props.traffic, 2)}</span>
        </div>
        <div class="info-row">
            <span class="info-label">CQI</span>
            <span class="info-value">${formatNumber(props.cqi)}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Timing Advance</span>
            <span class="info-value">${formatNumber(props.ta)}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Signal Power</span>
            <span class="info-value">${props.signal_power ? props.signal_power + ' dBm' : 'N/A'}</span>
        </div>
        ${props.congested ? `
        <div class="info-row" style="margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border-color);">
            <span class="info-label">Root Cause</span>
            <span class="info-value danger">${props.root_cause}</span>
        </div>
        ` : ''}
    `;
}

function hideCellInfoPanel() {
    document.getElementById('cell-info-panel').classList.add('hidden');
}

function updateTimestamp() {
    const now = new Date();
    document.getElementById('timestamp').textContent = now.toLocaleString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

// --- Filtering ---
function applyFilters() {
    const filtered = state.features.filter(f => {
        const p = f.properties;
        
        // Status filter
        if (!state.filters.status[p.status]) return false;
        
        // Band filter
        if (Object.keys(state.filters.bands).length > 0 && p.band) {
            if (!state.filters.bands[p.band]) return false;
        }
        
        // Load range filter
        if (p.load !== null && p.load !== undefined) {
            if (p.load < state.filters.loadRange[0] || p.load > state.filters.loadRange[1]) {
                return false;
            }
        }
        
        return true;
    });
    
    state.filteredData = filtered;
    
    if (state.map && state.map.getSource('sectors')) {
        state.map.getSource('sectors').setData({
            type: 'FeatureCollection',
            features: filtered
        });
    }
    
    // Update stats with filtered data
    const stats = calculateStats(filtered);
    updateStatsUI(stats);
    updateAlertsUI(filtered);
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
        pitch: 50,
        bearing: -15,
        antialias: true
    });
    
    map.addControl(new maplibregl.NavigationControl(), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    
    state.map = map;
    state.popup = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 15
    });
    
    return map;
}

function addMapLayers(map, geojson, sites) {
    // Sectors source
    map.addSource('sectors', {
        type: 'geojson',
        data: geojson
    });
    
    // Sectors fill layer
    map.addLayer({
        id: 'sectors-fill',
        type: 'fill',
        source: 'sectors',
        paint: {
            'fill-color': ['get', 'color'],
            'fill-opacity': ['get', 'opacity']
        }
    });
    
    // Sectors outline
    map.addLayer({
        id: 'sectors-outline',
        type: 'line',
        source: 'sectors',
        paint: {
            'line-color': '#ffffff',
            'line-width': [
                'interpolate', ['linear'], ['zoom'],
                10, 0.5,
                14, 1.5
            ],
            'line-opacity': 0.6
        }
    });
    
    // Congestion highlight layer (pulsing effect for congested cells)
    map.addLayer({
        id: 'sectors-congested',
        type: 'line',
        source: 'sectors',
        filter: ['==', ['get', 'congested'], true],
        paint: {
            'line-color': '#FF7900',
            'line-width': 3,
            'line-opacity': 0.9
        }
    });
    
    // Site markers source
    const sitesGeojson = {
        type: 'FeatureCollection',
        features: sites.map((site, i) => ({
            type: 'Feature',
            id: i,
            properties: {
                name: site.name,
                cellCount: site.cells.length
            },
            geometry: {
                type: 'Point',
                coordinates: site.coordinates
            }
        }))
    };
    
    map.addSource('sites', {
        type: 'geojson',
        data: sitesGeojson
    });
    
    // Site marker circles
    map.addLayer({
        id: 'sites-circle',
        type: 'circle',
        source: 'sites',
        paint: {
            'circle-radius': [
                'interpolate', ['linear'], ['zoom'],
                10, 4,
                14, 8
            ],
            'circle-color': CONFIG.COLORS.SITE_MARKER,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2,
            'circle-opacity': 0.9
        }
    });
    
    // Site labels
    map.addLayer({
        id: 'sites-labels',
        type: 'symbol',
        source: 'sites',
        layout: {
            'text-field': ['get', 'name'],
            'text-size': 11,
            'text-offset': [0, 1.5],
            'text-anchor': 'top',
            'visibility': 'none'
        },
        paint: {
            'text-color': '#ffffff',
            'text-halo-color': 'rgba(0,0,0,0.7)',
            'text-halo-width': 1
        }
    });
    
    // Cell labels (hidden by default)
    map.addLayer({
        id: 'cell-labels',
        type: 'symbol',
        source: 'sectors',
        layout: {
            'text-field': ['get', 'cell_name'],
            'text-size': 10,
            'visibility': 'none'
        },
        paint: {
            'text-color': '#ffffff',
            'text-halo-color': 'rgba(0,0,0,0.7)',
            'text-halo-width': 1
        }
    });
}

function setupMapInteractions(map) {
    // Sector hover
    map.on('mousemove', 'sectors-fill', (e) => {
        map.getCanvas().style.cursor = 'pointer';
        
        if (e.features.length > 0) {
            const props = e.features[0].properties;
            updateCellInfoPanel(props);
            
            // Highlight effect
            map.setPaintProperty('sectors-fill', 'fill-opacity', [
                'case',
                ['==', ['get', 'id'], props.id],
                0.95,
                ['get', 'opacity']
            ]);
        }
    });
    
    map.on('mouseleave', 'sectors-fill', () => {
        map.getCanvas().style.cursor = '';
        hideCellInfoPanel();
        map.setPaintProperty('sectors-fill', 'fill-opacity', ['get', 'opacity']);
    });
    
    // Site hover
    map.on('mouseenter', 'sites-circle', (e) => {
        map.getCanvas().style.cursor = 'pointer';
        const props = e.features[0].properties;
        
        state.popup
            .setLngLat(e.lngLat)
            .setHTML(`
                <div style="padding: 10px; font-family: Inter, sans-serif;">
                    <div style="font-weight: 600; margin-bottom: 4px;">${props.name}</div>
                    <div style="font-size: 12px; color: #a0aec0;">${props.cellCount} cells</div>
                </div>
            `)
            .addTo(map);
    });
    
    map.on('mouseleave', 'sites-circle', () => {
        map.getCanvas().style.cursor = '';
        state.popup.remove();
    });
    
    // Click to fly to site
    map.on('click', 'sites-circle', (e) => {
        map.flyTo({
            center: e.lngLat,
            zoom: 15,
            pitch: 60
        });
    });
}

// --- Event Handlers ---
function setupEventHandlers() {
    // Timestamp update
    updateTimestamp();
    setInterval(updateTimestamp, 1000);
    
    // Basemap selector
    document.getElementById('basemap-select').addEventListener('change', (e) => {
        const basemap = CONFIG.BASEMAPS[e.target.value];
        if (basemap && state.map) {
            state.map.getSource('basemap').setTiles(basemap.tiles);
        }
    });
    
    // View toggle (3D/2D)
    document.querySelectorAll('.toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            if (state.map) {
                const is3D = btn.dataset.view === '3d';
                state.map.easeTo({
                    pitch: is3D ? 50 : 0,
                    bearing: is3D ? -15 : 0,
                    duration: 1000
                });
            }
        });
    });
    
    // Filter checkboxes
    document.querySelectorAll('[data-filter]').forEach(checkbox => {
        checkbox.addEventListener('change', (e) => {
            state.filters.status[e.target.dataset.filter] = e.target.checked;
        });
    });
    
    // Load range sliders
    const loadMin = document.getElementById('load-min');
    const loadMax = document.getElementById('load-max');
    const loadDisplay = document.getElementById('load-range-display');
    
    function updateLoadRange() {
        const min = parseInt(loadMin.value);
        const max = parseInt(loadMax.value);
        state.filters.loadRange = [Math.min(min, max), Math.max(min, max)];
        loadDisplay.textContent = `${state.filters.loadRange[0]}% - ${state.filters.loadRange[1]}%`;
    }
    
    loadMin.addEventListener('input', updateLoadRange);
    loadMax.addEventListener('input', updateLoadRange);
    
    // Apply filters button
    document.getElementById('btn-apply-filters').addEventListener('click', applyFilters);
    
    // Reset filters button
    document.getElementById('btn-reset-filters').addEventListener('click', () => {
        document.querySelectorAll('[data-filter]').forEach(cb => cb.checked = true);
        document.querySelectorAll('#frequency-filters input').forEach(cb => cb.checked = true);
        loadMin.value = 0;
        loadMax.value = 100;
        
        state.filters.status = { congested: true, 'high-load': true, normal: true, idle: true, 'no-data': true };
        Object.keys(state.filters.bands).forEach(k => state.filters.bands[k] = true);
        state.filters.loadRange = [0, 100];
        loadDisplay.textContent = '0% - 100%';
        
        applyFilters();
    });
    
    // Layer toggles
    document.getElementById('layer-sectors').addEventListener('change', (e) => {
        if (state.map) {
            state.map.setLayoutProperty('sectors-fill', 'visibility', e.target.checked ? 'visible' : 'none');
            state.map.setLayoutProperty('sectors-outline', 'visibility', e.target.checked ? 'visible' : 'none');
            state.map.setLayoutProperty('sectors-congested', 'visibility', e.target.checked ? 'visible' : 'none');
        }
    });
    
    document.getElementById('layer-sites').addEventListener('change', (e) => {
        if (state.map) {
            state.map.setLayoutProperty('sites-circle', 'visibility', e.target.checked ? 'visible' : 'none');
            state.map.setLayoutProperty('sites-labels', 'visibility', e.target.checked && document.getElementById('layer-labels').checked ? 'visible' : 'none');
        }
    });
    
    document.getElementById('layer-labels').addEventListener('change', (e) => {
        if (state.map) {
            state.map.setLayoutProperty('sites-labels', 'visibility', e.target.checked ? 'visible' : 'none');
            state.map.setLayoutProperty('cell-labels', 'visibility', e.target.checked ? 'visible' : 'none');
        }
    });
    
    // Search with debounce
    const searchInput = document.getElementById('cell-search');
    const searchResults = document.getElementById('search-results');
    let searchTimeout;
    
    searchInput.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        const query = e.target.value.toLowerCase().trim();
        
        if (query.length < 2) {
            searchResults.innerHTML = '';
            return;
        }
        
        searchTimeout = setTimeout(() => {
            const matches = state.features.filter(f => 
                f.properties.cell_name.toLowerCase().includes(query) ||
                (f.properties.enodeb_name && f.properties.enodeb_name.toLowerCase().includes(query))
            ).slice(0, 8);
            
            if (matches.length === 0) {
                searchResults.innerHTML = '<div class="search-result-item" style="color: var(--text-muted);">No results found</div>';
                return;
            }
            
            searchResults.innerHTML = matches.map(f => `
                <div class="search-result-item" data-cell-id="${f.properties.id}">
                    <strong>${f.properties.cell_name}</strong>
                    <span style="color: var(--text-muted);"> • ${f.properties.enodeb_name}</span>
                </div>
            `).join('');
            
            searchResults.querySelectorAll('.search-result-item').forEach(item => {
                if (!item.dataset.cellId) return;
                item.addEventListener('click', () => {
                    const cellId = parseInt(item.dataset.cellId);
                    const feature = state.features.find(f => f.properties.id === cellId);
                    if (feature && state.map) {
                        state.map.flyTo({
                            center: feature.geometry.coordinates[0][0],
                            zoom: 16,
                            pitch: 60
                        });
                        updateCellInfoPanel(feature.properties);
                        searchInput.value = '';
                        searchResults.innerHTML = '';
                    }
                });
            });
        }, 200);
    });
    
    // Clear search on Escape
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            searchInput.value = '';
            searchResults.innerHTML = '';
            searchInput.blur();
        }
    });
    
    // Refresh button
    document.getElementById('btn-refresh').addEventListener('click', () => {
        const btn = document.getElementById('btn-refresh');
        btn.querySelector('.material-symbols-outlined').style.animation = 'spin 0.5s linear';
        setTimeout(() => {
            location.reload();
        }, 300);
    });
    
    // Fullscreen button
    document.getElementById('btn-fullscreen').addEventListener('click', () => {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen();
        } else {
            document.exitFullscreen();
        }
    });
    
    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        // Only if not typing in an input
        if (e.target.tagName === 'INPUT') return;
        
        switch(e.key.toLowerCase()) {
            case 'f':
                // Focus search
                e.preventDefault();
                searchInput.focus();
                break;
            case 'r':
                // Reset view
                if (state.map) {
                    state.map.flyTo({
                        center: CONFIG.MAP_CENTER,
                        zoom: CONFIG.MAP_ZOOM,
                        pitch: 50,
                        bearing: -15
                    });
                }
                break;
            case '2':
                // 2D view
                document.querySelector('[data-view="2d"]').click();
                break;
            case '3':
                // 3D view
                document.querySelector('[data-view="3d"]').click();
                break;
            case 'escape':
                hideCellInfoPanel();
                break;
        }
    });
    
    // Double-click to zoom in on map
    if (state.map) {
        state.map.on('dblclick', (e) => {
            e.preventDefault();
            state.map.flyTo({
                center: e.lngLat,
                zoom: state.map.getZoom() + 2
            });
        });
    }
}

// --- Main Initialization ---
async function init() {
    try {
        // Fetch data
        const response = await fetch('/data.json');
        const rawData = await response.json();
        
        // Process data
        const { features, sites, bands } = processData(rawData);
        state.features = features;
        state.filteredData = features;
        
        // Initialize frequency band filters
        const bandFiltersContainer = document.getElementById('frequency-filters');
        bands.forEach(band => {
            state.filters.bands[band] = true;
            bandFiltersContainer.innerHTML += `
                <label class="checkbox-item">
                    <input type="checkbox" data-band="${band}" checked>
                    <span class="checkmark"></span>
                    <span>Band ${band}</span>
                </label>
            `;
        });
        
        // Band filter event listeners
        setTimeout(() => {
            document.querySelectorAll('[data-band]').forEach(cb => {
                cb.addEventListener('change', (e) => {
                    state.filters.bands[e.target.dataset.band] = e.target.checked;
                });
            });
        }, 0);
        
        // Calculate and display stats
        const stats = calculateStats(features);
        updateStatsUI(stats);
        updateAlertsUI(features);
        
        // Initialize map
        const map = initMap();
        
        map.on('load', () => {
            const geojson = {
                type: 'FeatureCollection',
                features: features
            };
            
            addMapLayers(map, geojson, sites);
            setupMapInteractions(map);
            
            // Fit to data bounds
            if (features.length > 0) {
                const bounds = new maplibregl.LngLatBounds();
                features.forEach(f => {
                    f.geometry.coordinates[0].forEach(coord => {
                        bounds.extend(coord);
                    });
                });
                map.fitBounds(bounds, { padding: 50, maxZoom: 14 });
            }
        });
        
        // Setup UI event handlers
        setupEventHandlers();
        
        console.log(`✓ NetVision Digital Twin initialized with ${features.length} cells and ${sites.length} sites`);
        
    } catch (error) {
        console.error('Failed to initialize Digital Twin:', error);
        document.getElementById('alerts-list').innerHTML = `
            <div class="alert-item">
                <span class="material-symbols-outlined">error</span>
                <div class="alert-item-content">
                    <div class="alert-item-title">Initialization Error</div>
                    <div class="alert-item-desc">${error.message}</div>
                </div>
            </div>
        `;
    }
}

// Start the application
init();
