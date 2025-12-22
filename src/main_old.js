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

    // Large dataset handling
    LARGE_DATASET_THRESHOLD: 80000,
    MAX_SECTOR_RENDER: 20000,
    MAX_SECTOR_SAMPLE_LARGE: 5000,
    SECTOR_MIN_ZOOM: 5,
    MAX_ALERTS_RENDER: 200,
    SEARCH_MAX_RESULTS: 30,
    
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
        },
        light: {
            tiles: ['https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png'],
            attribution: '&copy; Stadia Maps'
        }
    }
};

// --- State Management ---
const state = {
    data: [],
    filteredData: [],
    features: [],
    pointFeatures: [],
    sectorFeatures: [],
    sectorSampleFeatures: [],
    siteMarkers: [],
    stats: null,
    isLargeDataset: false,
    selectedCellId: null,
    charts: {},
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
        issueTypes: {},
        bands: {},
        loadRange: [0, 100],
        severityRange: [0, 100]
    },
    layers: {
        sectors: true,
        sites: true,
        labels: false,
        clusters: true,
        heatmap: false
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

function clampNumber(value, min, max) {
    if (value === null || value === undefined) return null;
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    return Math.min(max, Math.max(min, num));
}

function safeString(value, fallback = '') {
    if (value === null || value === undefined) return fallback;
    return String(value);
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

function getIssueType(item) {
    return item.issue_type || 'Normal';
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
    const sectorFeatures = [];
    const sectorSampleFeatures = [];
    const pointFeatures = [];
    const sites = new Map();
    const bands = new Set();
    const issueTypes = new Set();

    state.isLargeDataset = rawData.length >= CONFIG.LARGE_DATASET_THRESHOLD;
    const stride = state.isLargeDataset ? Math.max(1, Math.floor(rawData.length / CONFIG.MAX_SECTOR_SAMPLE_LARGE)) : 1;

    for (let index = 0; index < rawData.length; index++) {
        const item = rawData[index];
        if (!item || item.longitude_sector == null || item.latitude_sector == null) continue;

        const lon = Number(item.longitude_sector);
        const lat = Number(item.latitude_sector);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

        const center = [lon, lat];
        const azimuth = Number(item.azimuth) || 0;
        const load = item.ft_physical_resource_blocks_load_dl;
        const band = item.frequency_band;
        const issueType = getIssueType(item);

        if (band != null && band !== '') bands.add(band);
        if (issueType) issueTypes.add(issueType);

        const status = getCellStatus(item);
        const color = getLoadColor(load, item.congested);

        let opacity = 0.7;
        if (item.referencesignalpwr != null) {
            const norm = Math.max(0, Math.min(1, (Number(item.referencesignalpwr) - 140) / 50));
            opacity = 0.5 + (norm * 0.35);
        }
        if (status === 'no-data') opacity = 0.4;

        // Lightweight point feature always (fast rendering + clustering + heatmap)
        pointFeatures.push({
            type: 'Feature',
            id: index,
            properties: {
                id: index,
                cell_name: item.cell_name || `Cell_${index}`,
                enodeb_name: item.enodeb_name,
                status,
                color,
                opacity,
                load,
                congested: !!item.congested,
                root_cause: item.root_cause || '-',
                issue_type: issueType,
                severity: item.severity ?? null,
                health_score: item.health_score ?? null,
                traffic: item.l_traffic_activeuser_dl_avg,
                throughput: item.ft_ave_4g_lte_dl_user_thrput_without_last_tti_all___kbps__kbit_,
                cqi: item.ft_4g_lte_average_reported_cqi,
                ta: item.ot_average_ta,
                band,
                signal_power: item.referencesignalpwr,
                azimuth
            },
            geometry: {
                type: 'Point',
                coordinates: center
            }
        });

        // Radius from TA (bounded) for sector shape
        let radius = CONFIG.DEFAULT_RADIUS_METERS;
        if (item.ot_average_ta != null && Number(item.ot_average_ta) > 0) {
            radius = Math.max(CONFIG.MIN_RADIUS, Math.min(CONFIG.MAX_RADIUS, Number(item.ot_average_ta) * CONFIG.TA_TO_METERS));
        }
        const geometry = createSectorPolygon(center, radius, azimuth, CONFIG.DEFAULT_BEAMWIDTH);

        // Full set for smaller datasets (guarded by cap)
        if (!state.isLargeDataset && sectorFeatures.length < CONFIG.MAX_SECTOR_RENDER) {
            sectorFeatures.push({
                type: 'Feature',
                id: index,
                properties: {
                    id: index,
                    cell_name: item.cell_name || `Cell_${index}`,
                    enodeb_name: item.enodeb_name,
                    status,
                    color,
                    opacity,
                    load,
                    congested: !!item.congested,
                    root_cause: item.root_cause || '-',
                    issue_type: issueType,
                    severity: item.severity ?? null,
                    health_score: item.health_score ?? null,
                    traffic: item.l_traffic_activeuser_dl_avg,
                    throughput: item.ft_ave_4g_lte_dl_user_thrput_without_last_tti_all___kbps__kbit_,
                    cqi: item.ft_4g_lte_average_reported_cqi,
                    ta: item.ot_average_ta,
                    band,
                    signal_power: item.referencesignalpwr,
                    azimuth
                },
                geometry: {
                    type: 'Polygon',
                    coordinates: geometry
                }
            });
        }

        // LOD sampled sectors for large datasets (keep triangles visible without killing perf)
        if (state.isLargeDataset && sectorSampleFeatures.length < CONFIG.MAX_SECTOR_SAMPLE_LARGE && (index % stride === 0)) {
            sectorSampleFeatures.push({
                type: 'Feature',
                id: index,
                properties: {
                    id: index,
                    cell_name: item.cell_name || `Cell_${index}`,
                    enodeb_name: item.enodeb_name,
                    status,
                    color,
                    opacity,
                    load,
                    congested: !!item.congested,
                    root_cause: item.root_cause || '-',
                    issue_type: issueType,
                    severity: item.severity ?? null,
                    health_score: item.health_score ?? null,
                    traffic: item.l_traffic_activeuser_dl_avg,
                    throughput: item.ft_ave_4g_lte_dl_user_thrput_without_last_tti_all___kbps__kbit_,
                    cqi: item.ft_4g_lte_average_reported_cqi,
                    ta: item.ot_average_ta,
                    band,
                    signal_power: item.referencesignalpwr,
                    azimuth
                },
                geometry: {
                    type: 'Polygon',
                    coordinates: geometry
                }
            });
        }

        // Track unique sites (use coordinate key)
        const siteKey = `${center[0].toFixed(5)}_${center[1].toFixed(5)}`;
        if (!sites.has(siteKey)) {
            sites.set(siteKey, {
                name: item.enodeb_name,
                coordinates: center,
                cells: []
            });
        }
        sites.get(siteKey).cells.push(item.cell_name);
    }

    return {
        sectorFeatures,
        sectorSampleFeatures,
        pointFeatures,
        sites: Array.from(sites.values()),
        bands: Array.from(bands).sort((a, b) => a - b),
        issueTypes: Array.from(issueTypes).sort()
    };
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
        dataCoverage: total > 0 ? ((total - noData) / total) * 100 : 0,
        avgHealthScore: features.length > 0
            ? features.reduce((acc, f) => acc + (Number(f.properties.health_score) || 0), 0) / features.length
            : 0
    };
}

// --- UI Updates ---
// Update overview stats using pre-computed stats.json (full dataset)
function updateOverviewStatsUI() {
    const s = state.stats;
    if (!s) return;
    
    // Use pre-computed totals from stats.json
    document.querySelector('#stat-total .stat-value').textContent = formatLargeNumber(s.total_cells);
    document.querySelector('#stat-congested .stat-value').textContent = formatLargeNumber(s.congested_cells);
    
    // Calculate high-load and healthy from severity distribution
    const sevDist = s.severity_distribution || {};
    const highLoad = (sevDist['High'] || 0) + (sevDist['Medium'] || 0);
    const healthy = (sevDist['Normal'] || 0) + (sevDist['Low'] || 0);
    document.querySelector('#stat-high-load .stat-value').textContent = formatLargeNumber(highLoad);
    document.querySelector('#stat-healthy .stat-value').textContent = formatLargeNumber(healthy);
    
    // Performance metrics from pre-computed stats
    document.getElementById('metric-avg-load').textContent = s.avg_load.toFixed(1) + '%';
    document.getElementById('progress-load').style.width = Math.min(s.avg_load, 100) + '%';
    document.getElementById('metric-avg-throughput').textContent = formatThroughput(s.avg_throughput);
    document.getElementById('metric-avg-cqi').textContent = s.avg_cqi.toFixed(1);
    document.getElementById('metric-coverage').textContent = s.data_completeness.toFixed(0) + '%';

    // Health gauge from pre-computed score
    const gaugeValue = document.getElementById('gauge-value');
    const gaugeFill = document.getElementById('gauge-fill');
    if (gaugeValue && gaugeFill) {
        const hs = clampNumber(s.avg_health_score, 0, 100) ?? 0;
        gaugeValue.textContent = hs.toFixed(0);
        const length = 157;
        const dash = (hs / 100) * length;
        gaugeFill.style.strokeDasharray = `${dash} ${length}`;
    }
}

// Format large numbers with K/M suffix
function formatLargeNumber(num) {
    if (num === null || num === undefined) return '--';
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return String(num);
}

// Update stats from filtered features (for filter mode)
function updateStatsUI(stats) {
    document.querySelector('#stat-total .stat-value').textContent = formatLargeNumber(stats.total);
    document.querySelector('#stat-congested .stat-value').textContent = formatLargeNumber(stats.congested);
    document.querySelector('#stat-high-load .stat-value').textContent = formatLargeNumber(stats.highLoad);
    document.querySelector('#stat-healthy .stat-value').textContent = formatLargeNumber(stats.healthy);
    
    document.getElementById('metric-avg-load').textContent = stats.avgLoad.toFixed(1) + '%';
    document.getElementById('progress-load').style.width = Math.min(stats.avgLoad, 100) + '%';
    document.getElementById('metric-avg-throughput').textContent = formatThroughput(stats.avgThroughput);
    document.getElementById('metric-avg-cqi').textContent = stats.avgCqi.toFixed(1);
    document.getElementById('metric-coverage').textContent = stats.dataCoverage.toFixed(0) + '%';

    // Health gauge (0-100)
    const gaugeValue = document.getElementById('gauge-value');
    const gaugeFill = document.getElementById('gauge-fill');
    if (gaugeValue && gaugeFill) {
        const hs = clampNumber(stats.avgHealthScore, 0, 100) ?? 0;
        gaugeValue.textContent = hs.toFixed(0);
        // Stroke-dasharray trick for partial arc
        const length = 157; // approx arc length for the path in CSS
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
    
    alertsList.innerHTML = congested.slice(0, state.isLargeDataset ? 10 : 25).map(f => `
        <div class="alert-item" data-cell-id="${f.properties.id}">
            <span class="material-symbols-outlined">error</span>
            <div class="alert-item-content">
                <div class="alert-item-title">${f.properties.cell_name}</div>
                <div class="alert-item-desc">${f.properties.issue_type || ''} • ${f.properties.root_cause} • Sev: ${formatNumber(f.properties.severity, 0)}</div>
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

    const healthEl = document.getElementById('cell-health');
    if (healthEl) {
        const hs = props.health_score != null ? Number(props.health_score) : null;
        healthEl.textContent = hs != null && Number.isFinite(hs) ? `Health: ${hs.toFixed(0)}` : 'Health: --';
    }
    
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
            <span class="info-label">Issue Type</span>
            <span class="info-value">${props.issue_type || 'Normal'}</span>
        </div>
        <div class="info-row">
            <span class="info-label">Severity</span>
            <span class="info-value ${props.severity >= 80 ? 'danger' : (props.severity >= 60 ? 'warning' : 'success')}">${props.severity != null ? formatNumber(props.severity, 0) : 'N/A'}</span>
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

function setLoading(isLoading, progressText = '') {
    const overlay = document.getElementById('loading-overlay');
    if (!overlay) return;
    if (isLoading) {
        overlay.classList.remove('hidden');
        if (progressText) {
            const p = document.getElementById('loading-progress');
            if (p) p.textContent = progressText;
        }
    } else {
        overlay.classList.add('hidden');
    }
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
// Check if any filters are active (not in default state)
function isFiltersActive() {
    // Check if any status is unchecked
    const statusActive = Object.values(state.filters.status).some(v => v === false);
    
    // Check if any band is unchecked
    const bandsActive = Object.values(state.filters.bands).some(v => v === false);
    
    // Check if any issue type is unchecked  
    const issueTypesActive = Object.values(state.filters.issueTypes).some(v => v === false);
    
    // Check if load range is not default
    const loadRangeActive = state.filters.loadRange[0] !== 0 || state.filters.loadRange[1] !== 100;
    
    // Check if severity range is not default
    const severityRangeActive = state.filters.severityRange[0] !== 0 || state.filters.severityRange[1] !== 100;
    
    return statusActive || bandsActive || issueTypesActive || loadRangeActive || severityRangeActive;
}

function applyFilters() {
    const filtered = (state.isLargeDataset ? state.pointFeatures : state.features).filter(f => {
        const p = f.properties;
        
        // Status filter
        if (!state.filters.status[p.status]) return false;
        
        // Band filter
        if (Object.keys(state.filters.bands).length > 0 && p.band) {
            if (!state.filters.bands[p.band]) return false;
        }

        // Issue type filter
        if (Object.keys(state.filters.issueTypes).length > 0) {
            const t = p.issue_type || 'Normal';
            if (state.filters.issueTypes[t] === false) return false;
        }
        
        // Load range filter
        if (p.load !== null && p.load !== undefined) {
            if (p.load < state.filters.loadRange[0] || p.load > state.filters.loadRange[1]) {
                return false;
            }
        }

        // Severity range
        if (p.severity !== null && p.severity !== undefined) {
            const s = Number(p.severity);
            if (Number.isFinite(s)) {
                if (s < state.filters.severityRange[0] || s > state.filters.severityRange[1]) {
                    return false;
                }
            }
        }
        
        return true;
    });
    
    state.filteredData = filtered;
    
    if (state.map) {
        if (!state.isLargeDataset && state.map.getSource('sectors')) {
            state.map.getSource('sectors').setData({ type: 'FeatureCollection', features: filtered });
        }
        if (state.map.getSource('cells')) {
            state.map.getSource('cells').setData({ type: 'FeatureCollection', features: filtered });
        }
    }
    
    // Check if filters are active (not default)
    const filtersActive = isFiltersActive();
    
    if (filtersActive) {
        // Show filtered stats when filters are applied
        const stats = calculateStats(filtered);
        updateStatsUI(stats);
    } else {
        // Show full dataset stats when no filters
        updateOverviewStatsUI();
    }
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

function addMapLayers(map, sectorsGeojson, sectorsLodGeojson, pointsGeojson, sites) {
    // Points source with clustering
    map.addSource('cells', {
        type: 'geojson',
        data: pointsGeojson,
        cluster: true,
        clusterRadius: 40,
        clusterMaxZoom: 14
    });

    // Heatmap (GPU-accelerated WebGL layer - rendered last for visibility)
    // Note: We add this first but will reorder it to top after all layers are added
    map.addLayer({
        id: 'cells-heatmap',
        type: 'heatmap',
        source: 'cells',
        maxzoom: 24,
        layout: { 'visibility': 'none' },
        paint: {
            'heatmap-weight': [
                'interpolate', ['linear'],
                ['coalesce', ['get', 'load'], ['get', 'severity'], 50],
                0, 0,
                25, 0.25,
                50, 0.5,
                75, 0.75,
                100, 1
            ],
            'heatmap-intensity': [
                'interpolate', ['exponential', 1.5], ['zoom'],
                0, 0.1,
                5, 0.3,
                8, 0.6,
                10, 1.0,
                12, 1.5,
                14, 2.0,
                16, 2.5,
                18, 3.0
            ],
            'heatmap-radius': [
                'interpolate', ['exponential', 1.5], ['zoom'],
                0, 2,
                5, 8,
                8, 20,
                10, 35,
                12, 50,
                14, 70,
                16, 90,
                18, 120
            ],
            'heatmap-opacity': [
                'interpolate', ['linear'], ['zoom'],
                0, 0.9,
                8, 0.85,
                12, 0.8,
                16, 0.75,
                20, 0.7
            ],
            'heatmap-color': [
                'interpolate', ['linear'], ['heatmap-density'],
                0, 'rgba(0,0,0,0)',
                0.05, 'rgba(0,50,100,0.4)',
                0.1, 'rgba(0,100,150,0.5)',
                0.2, 'rgba(50,150,150,0.6)',
                0.3, 'rgba(100,180,120,0.65)',
                0.4, 'rgba(150,200,80,0.7)',
                0.5, 'rgba(200,220,50,0.75)',
                0.6, 'rgba(240,200,30,0.8)',
                0.7, 'rgba(255,160,20,0.85)',
                0.8, 'rgba(255,100,20,0.9)',
                0.9, 'rgba(240,50,20,0.95)',
                1, 'rgba(200,0,0,1)'
            ]
        }
    });

    // Cluster circles
    map.addLayer({
        id: 'cells-clusters',
        type: 'circle',
        source: 'cells',
        filter: ['has', 'point_count'],
        paint: {
            'circle-color': [
                'step',
                ['get', 'point_count'],
                CONFIG.COLORS.LOW_LOAD,
                50, CONFIG.COLORS.MEDIUM_LOAD,
                200, CONFIG.COLORS.HIGH_LOAD,
                800, CONFIG.COLORS.CONGESTED
            ],
            'circle-radius': [
                'step',
                ['get', 'point_count'],
                14,
                50, 18,
                200, 24,
                800, 30
            ],
            'circle-opacity': [
                'interpolate', ['linear'], ['zoom'],
                6, 0.95,
                10, 0.8,
                13, 0.4,
                14.5, 0.15
            ],
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2
        }
    });

    // Cluster count labels (rendered on top of cluster circles)
    map.addLayer({
        id: 'cells-cluster-count',
        type: 'symbol',
        source: 'cells',
        filter: ['has', 'point_count'],
        layout: {
            'text-field': ['get', 'point_count_abbreviated'],
            'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
            'text-size': [
                'step',
                ['get', 'point_count'],
                11,
                50, 12,
                200, 13,
                800, 14
            ],
            'text-allow-overlap': true,
            'text-ignore-placement': true
        },
        paint: {
            'text-color': '#ffffff',
            'text-halo-color': 'rgba(0,0,0,0.5)',
            'text-halo-width': 1
        }
    });

    // Individual points
    map.addLayer({
        id: 'cells-points',
        type: 'circle',
        source: 'cells',
        filter: ['!', ['has', 'point_count']],
        paint: {
            'circle-radius': [
                'interpolate', ['linear'], ['zoom'],
                7, 3.2,
                12, 5.2,
                15, 7.5
            ],
            'circle-color': ['get', 'color'],
            'circle-opacity': ['get', 'opacity'],
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 1
        }
    });

    // Congested ring overlay
    map.addLayer({
        id: 'cells-congested-ring',
        type: 'circle',
        source: 'cells',
        filter: ['all', ['!', ['has', 'point_count']], ['==', ['get', 'congested'], true]],
        paint: {
            'circle-radius': [
                'interpolate', ['linear'], ['zoom'],
                9, 5,
                14, 9
            ],
            'circle-color': 'rgba(0,0,0,0)',
            'circle-stroke-color': CONFIG.COLORS.CONGESTED,
            'circle-stroke-width': 2,
            'circle-opacity': 0.9
        }
    });

    // Sector polygons: full for small datasets, LOD sample for large
    if (!state.isLargeDataset) {
        map.addSource('sectors', { type: 'geojson', data: sectorsGeojson });

        map.addLayer({
            id: 'sectors-fill',
            type: 'fill',
            source: 'sectors',
            minzoom: CONFIG.SECTOR_MIN_ZOOM,
            paint: {
                'fill-color': ['get', 'color'],
                'fill-opacity': [
                    'interpolate', ['linear'], ['zoom'],
                    CONFIG.SECTOR_MIN_ZOOM, 0.55,
                    10, ['get', 'opacity'],
                    14, 0.7
                ]
            }
        });

        map.addLayer({
            id: 'sectors-outline',
            type: 'line',
            source: 'sectors',
            paint: {
                'line-color': '#ffffff',
                'line-width': [
                    'interpolate', ['linear'], ['zoom'],
                    5, 1.1,
                    10, 1.4,
                    14, 2.2
                ],
                'line-opacity': 0.6
            }
        });

        // Halo to keep triangles visible at far zooms
        map.addLayer({
            id: 'sectors-halo',
            type: 'line',
            source: 'sectors',
            paint: {
                'line-color': 'rgba(255,255,255,0.2)',
                'line-width': [
                    'interpolate', ['linear'], ['zoom'],
                    4, 1.6,
                    8, 1.2,
                    12, 0.8
                ],
                'line-blur': 0.5,
                'line-opacity': [
                    'interpolate', ['linear'], ['zoom'],
                    4, 0.35,
                    9, 0.2,
                    12, 0.1
                ]
            }
        });

        map.addLayer({
            id: 'sectors-congested',
            type: 'line',
            source: 'sectors',
            filter: ['==', ['get', 'congested'], true],
            paint: {
                'line-color': CONFIG.COLORS.CONGESTED,
                'line-width': 3,
                'line-opacity': 0.9
            }
        });
    } else if (sectorsLodGeojson && sectorsLodGeojson.features.length > 0) {
        map.addSource('sectors-lod', { type: 'geojson', data: sectorsLodGeojson });

        map.addLayer({
            id: 'sectors-lod-fill',
            type: 'fill',
            source: 'sectors-lod',
            minzoom: CONFIG.SECTOR_MIN_ZOOM,
            paint: {
                'fill-color': ['get', 'color'],
                'fill-opacity': [
                    'interpolate', ['linear'], ['zoom'],
                    CONFIG.SECTOR_MIN_ZOOM, 0.45,
                    10, ['get', 'opacity'],
                    14, 0.6
                ]
            }
        });

        map.addLayer({
            id: 'sectors-lod-outline',
            type: 'line',
            source: 'sectors-lod',
            paint: {
                'line-color': '#ffffff',
                'line-width': [
                    'interpolate', ['linear'], ['zoom'],
                    5, 1.0,
                    10, 1.3,
                    14, 2.0
                ],
                'line-opacity': 0.55
            }
        });

        map.addLayer({
            id: 'sectors-lod-halo',
            type: 'line',
            source: 'sectors-lod',
            paint: {
                'line-color': 'rgba(255,255,255,0.18)',
                'line-width': [
                    'interpolate', ['linear'], ['zoom'],
                    4, 1.4,
                    8, 1.0,
                    12, 0.7
                ],
                'line-blur': 0.5,
                'line-opacity': [
                    'interpolate', ['linear'], ['zoom'],
                    4, 0.3,
                    9, 0.18,
                    12, 0.1
                ]
            }
        });

        map.addLayer({
            id: 'sectors-lod-congested',
            type: 'line',
            source: 'sectors-lod',
            filter: ['==', ['get', 'congested'], true],
            paint: {
                'line-color': CONFIG.COLORS.CONGESTED,
                'line-width': 3,
                'line-opacity': 0.85
            }
        });
    }
    
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
        source: state.isLargeDataset ? 'cells' : 'sectors',
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
    // Fade clusters out at closer zooms so triangles stay meaningful
    // But respect heatmap mode - don't show anything when heatmap is active
    map.on('zoom', () => {
        // Skip zoom-based visibility changes if heatmap is active
        if (state.layers.heatmap) return;
        
        const z = map.getZoom();
        const clusterVisibility = z >= 13 ? 'none' : 'visible';
        if (map.getLayer('cells-clusters')) map.setLayoutProperty('cells-clusters', 'visibility', clusterVisibility);
        if (map.getLayer('cells-cluster-count')) map.setLayoutProperty('cells-cluster-count', 'visibility', clusterVisibility);
        const sectorVisibility = z >= CONFIG.SECTOR_MIN_ZOOM ? 'visible' : 'none';
        const sectorIds = state.isLargeDataset
            ? ['sectors-lod-fill', 'sectors-lod-outline', 'sectors-lod-halo', 'sectors-lod-congested']
            : ['sectors-fill', 'sectors-outline', 'sectors-halo', 'sectors-congested'];
        sectorIds.forEach(id => {
            if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', sectorVisibility);
        });
    });

    // Cluster click to zoom
    map.on('click', 'cells-clusters', (e) => {
        const features = map.queryRenderedFeatures(e.point, { layers: ['cells-clusters'] });
        if (!features.length) return;
        const clusterId = features[0].properties.cluster_id;
        map.getSource('cells').getClusterExpansionZoom(clusterId, (err, zoom) => {
            if (err) return;
            map.easeTo({ center: features[0].geometry.coordinates, zoom });
        });
    });

    // Point hover
    map.on('mousemove', 'cells-points', (e) => {
        map.getCanvas().style.cursor = 'pointer';
        if (e.features.length > 0) {
            const props = e.features[0].properties;
            updateCellInfoPanel(props);
        }
    });

    map.on('mouseleave', 'cells-points', () => {
        map.getCanvas().style.cursor = '';
        if (state.selectedCellId == null) hideCellInfoPanel();
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

function setVisualizationMode(mode) {
    if (!state.map) return;
    state.layers.heatmap = mode === 'heatmap';

    // Move heatmap layer to top when visible
    if (state.map.getLayer('cells-heatmap')) {
        // Reorder heatmap to be on top of everything
        state.map.moveLayer('cells-heatmap');
    }

    // Heatmap visibility
    ['cells-heatmap'].forEach(id => {
        if (state.map.getLayer(id)) state.map.setLayoutProperty(id, 'visibility', state.layers.heatmap ? 'visible' : 'none');
    });

    // In heatmap mode: hide all other layers for clean visualization
    // In sectors mode: show points/clusters normally
    if (state.layers.heatmap) {
        // Hide clusters and their labels
        ['cells-clusters', 'cells-cluster-count'].forEach(id => {
            if (state.map.getLayer(id)) state.map.setLayoutProperty(id, 'visibility', 'none');
        });
        // Hide individual points completely in heatmap mode
        ['cells-points', 'cells-congested-ring'].forEach(id => {
            if (state.map.getLayer(id)) state.map.setLayoutProperty(id, 'visibility', 'none');
        });
        // Hide site markers in heatmap mode for cleaner view
        ['sites-circle', 'sites-labels'].forEach(id => {
            if (state.map.getLayer(id)) state.map.setLayoutProperty(id, 'visibility', 'none');
        });
    } else {
        // Show all layers in normal mode
        ['cells-points', 'cells-congested-ring', 'cells-clusters', 'cells-cluster-count'].forEach(id => {
            if (state.map.getLayer(id)) state.map.setLayoutProperty(id, 'visibility', 'visible');
        });
        if (state.map.getLayer('cells-points')) {
            state.map.setPaintProperty('cells-points', 'circle-opacity', ['get', 'opacity']);
        }
        // Restore site markers
        if (state.map.getLayer('sites-circle')) {
            state.map.setLayoutProperty('sites-circle', 'visibility', 'visible');
        }
    }

    // Sector visibility depends on dataset size and mode - hide completely in heatmap mode
    const sectorIds = state.isLargeDataset
        ? ['sectors-lod-fill', 'sectors-lod-outline', 'sectors-lod-halo', 'sectors-lod-congested']
        : ['sectors-fill', 'sectors-outline', 'sectors-halo', 'sectors-congested'];
    const sectorVis = mode === 'heatmap' ? 'none' : 'visible';
    sectorIds.forEach(id => {
        if (state.map.getLayer(id)) state.map.setLayoutProperty(id, 'visibility', sectorVis);
    });

    const btns = document.querySelectorAll('.toggle-btn[data-viz]');
    btns.forEach(b => b.classList.toggle('active', b.dataset.viz === mode));
}

function toggleMapFullscreen() {
    document.body.classList.toggle('map-fullscreen');
    if (state.map) {
        setTimeout(() => state.map.resize(), 200);
    }
}

function toggleSidebar(side) {
    const el = document.getElementById(side === 'left' ? 'sidebar-left' : 'sidebar-right');
    if (!el) return;
    el.classList.toggle('collapsed');
    if (state.map) {
        setTimeout(() => state.map.resize(), 200);
    }
}

function setupModals() {
    const analyticsModal = document.getElementById('analytics-modal');
    const exportModal = document.getElementById('export-modal');

    function openModal(modal) {
        if (!modal) return;
        modal.classList.remove('hidden');
    }

    function closeModal(modal) {
        if (!modal) return;
        modal.classList.add('hidden');
    }

    document.getElementById('btn-analytics')?.addEventListener('click', () => {
        openModal(analyticsModal);
        renderCharts();
    });

    document.getElementById('analytics-close')?.addEventListener('click', () => closeModal(analyticsModal));

    document.getElementById('btn-export')?.addEventListener('click', () => openModal(exportModal));
    document.getElementById('export-close')?.addEventListener('click', () => closeModal(exportModal));

    ;[analyticsModal, exportModal].forEach(modal => {
        modal?.addEventListener('click', (e) => {
            if (e.target === modal) closeModal(modal);
        });
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeModal(analyticsModal);
            closeModal(exportModal);
        }
    });

    // Export actions
    document.getElementById('export-json')?.addEventListener('click', () => downloadBlob(JSON.stringify(state.data, null, 2), 'network-data.json', 'application/json'));
    document.getElementById('export-congested')?.addEventListener('click', () => {
        const congested = state.data.filter(r => r.congested);
        downloadBlob(JSON.stringify(congested, null, 2), 'congested-cells.json', 'application/json');
    });
    document.getElementById('export-csv')?.addEventListener('click', () => downloadCSV(state.data, 'network-data.csv'));
    document.getElementById('export-report')?.addEventListener('click', () => downloadBlob(generateReport(), 'network-report.txt', 'text/plain'));
}

function attachClickAnimations() {
    const selectors = [
        'button',
        '.btn-primary',
        '.btn-secondary',
        '.export-btn',
        '.toggle-btn',
        '.legend-toggle',
        '.sidebar-toggle',
        '.map-fullscreen-btn',
        '.checkbox-item'
    ];
    const elements = document.querySelectorAll(selectors.join(','));
    elements.forEach((el) => {
        el.addEventListener('click', () => {
            el.classList.remove('click-animate');
            // force reflow to restart animation
            void el.offsetWidth;
            el.classList.add('click-animate');
        });
    });
}

function downloadBlob(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function downloadCSV(rows, filename) {
    if (!rows || rows.length === 0) return;
    const columns = Object.keys(rows[0]);
    const escape = (v) => {
        if (v == null) return '';
        const s = String(v);
        if (s.includes('"') || s.includes(',') || s.includes('\n')) {
            return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
    };
    const csv = [columns.join(',')].concat(rows.map(r => columns.map(c => escape(r[c])).join(','))).join('\n');
    downloadBlob(csv, filename, 'text/csv');
}

function generateReport() {
    const s = state.stats;
    const lines = [];
    lines.push('NetVision Digital Twin - Network Report');
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');
    if (s) {
        lines.push(`Total cells: ${s.total_cells}`);
        lines.push(`Congested cells: ${s.congested_cells} (${s.congestion_rate}%)`);
        lines.push(`Average PRB load: ${s.avg_load}%`);
        lines.push(`Average throughput: ${(s.avg_throughput / 1000).toFixed(2)} Mbps`);
        lines.push(`Average CQI: ${s.avg_cqi}`);
        lines.push(`Average health score: ${s.avg_health_score}`);
        lines.push('');
        lines.push('Issue distribution:');
        Object.entries(s.issue_distribution || {}).forEach(([k, v]) => lines.push(`- ${k}: ${v}`));
        lines.push('');
        lines.push('Severity distribution:');
        Object.entries(s.severity_distribution || {}).forEach(([k, v]) => lines.push(`- ${k}: ${v}`));
    } else {
        lines.push('No stats.json available; report is limited.');
    }
    return lines.join('\n');
}

function applyTheme(theme) {
    document.body.classList.toggle('theme-dark', theme === 'dark');
    document.body.classList.toggle('theme-light', theme === 'light');
    const icon = document.querySelector('#btn-theme .material-symbols-outlined');
    if (icon) icon.textContent = theme === 'dark' ? 'dark_mode' : 'light_mode';
}

function toggleTheme() {
    const current = document.body.classList.contains('theme-light') ? 'light' : 'dark';
    const next = current === 'dark' ? 'light' : 'dark';
    localStorage.setItem('netvision_theme', next);
    applyTheme(next);
}

function renderIssueLegend(issueTypes) {
    const legend = document.getElementById('issue-legend');
    if (!legend) return;
    legend.innerHTML = issueTypes
        .filter(t => t && t !== 'Normal')
        .slice(0, 8)
        .map(t => `
            <div class="legend-item">
                <div class="legend-color" style="background: var(--orange-primary);"></div>
                <span>${t}</span>
            </div>
        `).join('') || '<div class="legend-item"><span style="color: var(--text-muted);">No issues detected</span></div>';
}

function setupLegendToggle() {
    const btn = document.getElementById('legend-toggle');
    const content = document.getElementById('legend-content');
    btn?.addEventListener('click', () => {
        content?.classList.toggle('collapsed');
        const icon = btn.querySelector('.material-symbols-outlined');
        if (icon) icon.textContent = content?.classList.contains('collapsed') ? 'expand_more' : 'expand_less';
    });
}

let ChartJS = null;

async function loadChartJS() {
    if (ChartJS) return ChartJS;
    const module = await import('https://cdn.jsdelivr.net/npm/chart.js@4.4.1/+esm');
    ChartJS = module.Chart;
    return ChartJS;
}

async function renderCharts() {
    if (!state.stats) return;
    const Chart = await loadChartJS();
    if (!Chart) return;
    const issueDist = state.stats.issue_distribution || {};
    const severityDist = state.stats.severity_distribution || {};
    const bandStats = state.stats.band_statistics || {};

    const destroy = (key) => {
        if (state.charts[key]) {
            state.charts[key].destroy();
            delete state.charts[key];
        }
    };

    // Issue pie
    destroy('issues');
    const issuesCtx = document.getElementById('chart-issues');
    if (issuesCtx) {
        state.charts.issues = new Chart(issuesCtx, {
            type: 'doughnut',
            data: {
                labels: Object.keys(issueDist),
                datasets: [{
                    data: Object.values(issueDist),
                    backgroundColor: [
                        CONFIG.COLORS.CONGESTED,
                        CONFIG.COLORS.HIGH_LOAD,
                        CONFIG.COLORS.MEDIUM_LOAD,
                        CONFIG.COLORS.LOW_LOAD,
                        CONFIG.COLORS.HEALTHY,
                        CONFIG.COLORS.NO_DATA
                    ]
                }]
            },
            options: { responsive: true, plugins: { legend: { labels: { color: '#fff' } } } }
        });
    }

    // Severity bar
    destroy('severity');
    const sevCtx = document.getElementById('chart-severity');
    if (sevCtx) {
        state.charts.severity = new Chart(sevCtx, {
            type: 'bar',
            data: {
                labels: Object.keys(severityDist),
                datasets: [{
                    data: Object.values(severityDist),
                    backgroundColor: CONFIG.COLORS.HIGH_LOAD
                }]
            },
            options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#b3b3b3' } }, y: { ticks: { color: '#b3b3b3' } } } }
        });
    }

    // Band chart
    destroy('bands');
    const bandCtx = document.getElementById('chart-bands');
    if (bandCtx) {
        const labels = Object.keys(bandStats);
        const values = labels.map(k => bandStats[k].congested || 0);
        state.charts.bands = new Chart(bandCtx, {
            type: 'bar',
            data: { labels, datasets: [{ label: 'Congested', data: values, backgroundColor: CONFIG.COLORS.CONGESTED }] },
            options: { responsive: true, scales: { x: { ticks: { color: '#b3b3b3' } }, y: { ticks: { color: '#b3b3b3' } } } }
        });
    }

    // Load histogram (approx)
    destroy('load');
    const loadCtx = document.getElementById('chart-load');
    if (loadCtx) {
        const buckets = new Array(10).fill(0);
        const data = state.data;
        const step = Math.max(1, Math.floor(data.length / 20000));
        for (let i = 0; i < data.length; i += step) {
            const v = Number(data[i].ft_physical_resource_blocks_load_dl);
            if (!Number.isFinite(v)) continue;
            const b = Math.min(9, Math.max(0, Math.floor(v / 10)));
            buckets[b] += 1;
        }
        state.charts.load = new Chart(loadCtx, {
            type: 'bar',
            data: { labels: buckets.map((_, i) => `${i * 10}-${i * 10 + 9}%`), datasets: [{ data: buckets, backgroundColor: CONFIG.COLORS.LOW_LOAD }] },
            options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#b3b3b3' } }, y: { ticks: { color: '#b3b3b3' } } } }
        });
    }

    const summary = document.getElementById('analytics-summary');
    if (summary) {
        summary.innerHTML = `
            <div class="analytics-summary-row"><strong>Total Cells</strong><span>${state.stats.total_cells?.toLocaleString?.() || state.stats.total_cells}</span></div>
            <div class="analytics-summary-row"><strong>Congestion Rate</strong><span>${state.stats.congestion_rate}%</span></div>
            <div class="analytics-summary-row"><strong>Avg Health</strong><span>${state.stats.avg_health_score}</span></div>
        `;
    }
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

    // Theme toggle
    document.getElementById('btn-theme')?.addEventListener('click', toggleTheme);

    // Legend collapse
    setupLegendToggle();

    // Sidebars
    document.getElementById('toggle-left')?.addEventListener('click', () => toggleSidebar('left'));
    document.getElementById('toggle-right')?.addEventListener('click', () => toggleSidebar('right'));

    // Map fullscreen
    document.getElementById('btn-map-fullscreen')?.addEventListener('click', toggleMapFullscreen);
    
    // View toggle (3D/2D) — only buttons with data-view
    document.querySelectorAll('.toggle-btn[data-view]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.toggle-btn[data-view]').forEach(b => b.classList.remove('active'));
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

    // Visualization toggle (sectors / heatmap)
    document.querySelectorAll('.toggle-btn[data-viz]').forEach(btn => {
        btn.addEventListener('click', () => {
            setVisualizationMode(btn.dataset.viz);
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

    // Severity sliders
    const severityMin = document.getElementById('severity-min');
    const severityMax = document.getElementById('severity-max');
    const severityDisplay = document.getElementById('severity-range-display');
    function updateSeverityRange() {
        if (!severityMin || !severityMax || !severityDisplay) return;
        const min = parseInt(severityMin.value);
        const max = parseInt(severityMax.value);
        state.filters.severityRange = [Math.min(min, max), Math.max(min, max)];
        severityDisplay.textContent = `${state.filters.severityRange[0]} - ${state.filters.severityRange[1]}`;
    }
    severityMin?.addEventListener('input', updateSeverityRange);
    severityMax?.addEventListener('input', updateSeverityRange);
    
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
        Object.keys(state.filters.issueTypes).forEach(k => state.filters.issueTypes[k] = true);
        state.filters.loadRange = [0, 100];
        state.filters.severityRange = [0, 100];
        loadDisplay.textContent = '0% - 100%';
        const sevDisplay = document.getElementById('severity-range-display');
        if (sevDisplay) sevDisplay.textContent = '0 - 100';
        const sevMin = document.getElementById('severity-min');
        const sevMax = document.getElementById('severity-max');
        if (sevMin) sevMin.value = 0;
        if (sevMax) sevMax.value = 100;
        
        applyFilters();
    });
    
    // Layer toggles
    document.getElementById('layer-sectors').addEventListener('change', (e) => {
        if (!state.map) return;
        const visible = e.target.checked ? 'visible' : 'none';
        const ids = state.isLargeDataset
            ? ['sectors-lod-fill', 'sectors-lod-outline', 'sectors-lod-halo', 'sectors-lod-congested']
            : ['sectors-fill', 'sectors-outline', 'sectors-halo', 'sectors-congested'];
        ids.forEach(id => {
            if (state.map.getLayer(id)) state.map.setLayoutProperty(id, 'visibility', visible);
        });
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

    // Cluster layer toggle
    document.getElementById('layer-clusters')?.addEventListener('change', (e) => {
        state.layers.clusters = e.target.checked;
        if (!state.map) return;
        state.map.setLayoutProperty('cells-clusters', 'visibility', e.target.checked ? 'visible' : 'none');
        state.map.setLayoutProperty('cells-cluster-count', 'visibility', e.target.checked ? 'visible' : 'none');
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
            const dataset = state.isLargeDataset ? state.pointFeatures : state.features;
            const matches = dataset.filter(f => 
                f.properties.cell_name.toLowerCase().includes(query) ||
                (f.properties.enodeb_name && f.properties.enodeb_name.toLowerCase().includes(query))
            ).slice(0, CONFIG.SEARCH_MAX_RESULTS);
            
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
    
    // App fullscreen button
    document.getElementById('btn-fullscreen-app')?.addEventListener('click', () => {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen();
        } else {
            document.exitFullscreen();
        }
    });

    // Close cell info
    document.getElementById('cell-info-close')?.addEventListener('click', () => {
        state.selectedCellId = null;
        hideCellInfoPanel();
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
            case 'm':
                toggleMapFullscreen();
                break;
            case 't':
                toggleTheme();
                break;
            case 'a':
                document.getElementById('btn-analytics')?.click();
                break;
            case 'e':
                document.getElementById('btn-export')?.click();
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
        setLoading(true, '0%');

        // Theme init
        const savedTheme = localStorage.getItem('netvision_theme') || 'dark';
        applyTheme(savedTheme);

        // Fetch data + stats in parallel to reduce wait time
        const [dataRes, statsRes] = await Promise.all([
            fetch('/data.json?t=' + Date.now()),
            fetch('/stats.json?t=' + Date.now()).catch(() => null)
        ]);

        const rawData = await dataRes.json();
        if (statsRes && statsRes.ok) {
            state.stats = await statsRes.json();
        }
        state.data = rawData;
        setLoading(true, '25%');
        
        // Process data
        const { sectorFeatures, sectorSampleFeatures, pointFeatures, sites, bands, issueTypes } = processData(rawData);
        state.sectorFeatures = sectorFeatures;
        state.sectorSampleFeatures = sectorSampleFeatures;
        state.pointFeatures = pointFeatures;
        state.features = state.isLargeDataset ? pointFeatures : sectorFeatures;
        state.filteredData = state.isLargeDataset ? pointFeatures : sectorFeatures;
        setLoading(true, '55%');
        
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

        // Issue type filters
        const issueFilters = document.getElementById('issue-type-filters');
        if (issueFilters) {
            issueTypes.forEach(t => {
                state.filters.issueTypes[t] = true;
                issueFilters.innerHTML += `
                    <label class="checkbox-item">
                        <input type="checkbox" data-issue-type="${t}" checked>
                        <span class="checkmark"></span>
                        <span>${t}</span>
                    </label>
                `;
            });
        }
        setTimeout(() => {
            document.querySelectorAll('[data-issue-type]').forEach(cb => {
                cb.addEventListener('change', (e) => {
                    state.filters.issueTypes[e.target.dataset.issueType] = e.target.checked;
                });
            });
        }, 0);

        renderIssueLegend(issueTypes);
        
        // Band filter event listeners
        setTimeout(() => {
            document.querySelectorAll('[data-band]').forEach(cb => {
                cb.addEventListener('change', (e) => {
                    state.filters.bands[e.target.dataset.band] = e.target.checked;
                });
            });
        }, 0);
        
        // Display stats from pre-computed stats.json (full dataset)
        updateOverviewStatsUI();
        
        // Update alerts from features (limited for performance)
        const baseFeatures = state.isLargeDataset ? pointFeatures : sectorFeatures;
        updateAlertsUI(baseFeatures);
        setLoading(true, '70%');
        
        // Initialize map
        const map = initMap();
        
        map.on('load', () => {
            const sectorsGeojson = { type: 'FeatureCollection', features: sectorFeatures };
            const sectorsLodGeojson = { type: 'FeatureCollection', features: sectorSampleFeatures };
            const pointsGeojson = { type: 'FeatureCollection', features: pointFeatures };
            
            addMapLayers(map, sectorsGeojson, sectorsLodGeojson, pointsGeojson, sites);
            setupMapInteractions(map);
            
            // Fit to data bounds
            if (pointFeatures.length > 0) {
                const bounds = new maplibregl.LngLatBounds();
                const step = state.isLargeDataset ? Math.max(1, Math.floor(pointFeatures.length / 20000)) : 1;
                for (let i = 0; i < pointFeatures.length; i += step) {
                    bounds.extend(pointFeatures[i].geometry.coordinates);
                }
                map.fitBounds(bounds, { padding: 50, maxZoom: 14 });
            }
        });
        
        // Setup UI event handlers
        setupEventHandlers();
        setupModals();
        attachClickAnimations();
        setVisualizationMode('sectors');
        setLoading(true, '100%');
        setTimeout(() => setLoading(false), 250);
        
        console.log(`✓ NetVision Digital Twin initialized with ${state.data.length} cells and ${sites.length} sites`);
        
    } catch (error) {
        console.error('Failed to initialize Digital Twin:', error);
        setLoading(false);
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
