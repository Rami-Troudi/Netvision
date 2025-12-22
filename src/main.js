import maplibregl from 'maplibre-gl';
import { destination } from '@turf/turf';
import Chart from 'chart.js/auto';

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
    CQI_THRESHOLD: 8,
    HEATMAP_RADIUS: 30,
    HEATMAP_INTENSITY: 1,
    HEATMAP_OPACITY: 0.8,
    PLAY_INTERVAL_MS: 500,

    BAND_RADIUS: {
        20: 1500,
        8: 1200,
        3: 800,
        1: 600,
        7: 500,
        38: 400,
        40: 350,
        41: 300
    },
    
    COLORS: {
        CONGESTED: '#FF7900',
        HIGH_LOAD: '#FFB74D',
        MEDIUM_LOAD: '#FDD835',
        LOW_LOAD: '#AED581',
        HEALTHY: '#66BB6A',
        IDLE: '#90CAF9',
        NO_DATA: '#9E9E9E',
        SITE_MARKER: '#FF7900',
        CQI_POOR: '#E53935'
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
    baseline: {},
    timeIndex: [],
    currentTimeIndex: 0,
    currentObservations: {},
    currentStats: null,
    globalStats: null,
    
    siteHierarchy: {},
    selectedSite: null,
    selectedCellName: null,

    features: [],
    pointFeatures: [],
    sectorFeatures: [],
    filteredPointFeatures: [],
    filteredSectorFeatures: [],
    
    map: null,
    popup: null,
    isPlaying: false,
    playInterval: null,
    playSpeed: 1,
    
    filters: {
        status: { congested: true, 'high-load': true, normal: true, idle: true, 'no-data': true, 'poor-cqi': true },
        bands: {},
        issueTypes: {},
        loadRange: [0, 100],
        severityRange: [0, 100],
        showLowCQIOnly: false
    },
    layers: {
        sectors: true,
        sites: true,
        heatmap: false
    },
    charts: {
        issues: null,
        severity: null,
        bands: null,
        load: null
    }
};

let hasInitialized = false;
const geometryCache = {};
const MAX_GEOMETRY_CACHE_ENTRIES = 10000;

function pruneGeometryCache() {
    const keys = Object.keys(geometryCache);
    if (keys.length > MAX_GEOMETRY_CACHE_ENTRIES) {
        // Simple reset strategy to avoid unbounded growth; keeps cache logic cheap.
        Object.keys(geometryCache).forEach(k => delete geometryCache[k]);
    }
}

// --- Utility Functions ---
function debounce(fn, wait) {
    let t;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), wait);
    };
}

function parseTimestamp(ts) {
    const [datePart, timePart] = ts.split(' ');
    if (!datePart || !timePart) return new Date(ts);
    const [d, m, y] = datePart.split('-').map(Number);
    const [hh, mm] = timePart.split(':').map(Number);
    return new Date(y, m - 1, d, hh, mm, 0, 0);
}

function createSectorPolygon(center, radiusMeters, azimuth, beamwidth) {
    // Use geodesic destination for each point on the sector arc for higher accuracy
    const steps = 24;
    const startAzimuth = azimuth - beamwidth / 2;
    const endAzimuth = azimuth + beamwidth / 2;
    const coordinates = [center];

    for (let i = 0; i <= steps; i++) {
        const currentAzimuth = startAzimuth + (i / steps) * (endAzimuth - startAzimuth);
        const dest = destination(center, radiusMeters / 1000, currentAzimuth, { units: 'kilometers' });
        coordinates.push(dest.geometry.coordinates);
    }
    coordinates.push(center);
    return [coordinates];
}

function getLoadColor(load, isCongested, cqi) {
    if (isCongested) return CONFIG.COLORS.CONGESTED;
    if (cqi !== null && cqi !== undefined && cqi < CONFIG.CQI_THRESHOLD) return CONFIG.COLORS.CQI_POOR;
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
    if (obs.cqi !== null && obs.cqi !== undefined && obs.cqi < CONFIG.CQI_THRESHOLD) return 'poor-cqi';
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

function calculateCellRadius(band, ta) {
    let baseRadius = CONFIG.BAND_RADIUS[band] || CONFIG.DEFAULT_RADIUS_METERS;
    if (ta && ta > 0) {
        baseRadius = Math.max(baseRadius, ta * CONFIG.TA_TO_METERS);
    }
    return Math.max(CONFIG.MIN_RADIUS, Math.min(CONFIG.MAX_RADIUS, baseRadius));
}

function parseCellName(cellName) {
    const parts = cellName.split('_');
    if (parts.length < 3) return { siteName: parts[0] || cellName, antenna: '', cellNum: 0 };
    const siteName = `${parts[0]}_${parts[1]}`;
    const suffix = parts.slice(2).join('_');
    const match = suffix.match(/^([a-zA-Z]+)(\d+)$/);
    if (match) {
        return { siteName, antenna: match[1].toLowerCase(), cellNum: parseInt(match[2], 10) };
    }
    return { siteName, antenna: suffix.toLowerCase(), cellNum: 0 };
}

function buildSiteHierarchy() {
    const hierarchy = {};
    for (const [cellName, info] of Object.entries(state.baseline)) {
        const { siteName, antenna, cellNum } = parseCellName(cellName);
        if (!hierarchy[siteName]) {
            hierarchy[siteName] = {
                name: siteName,
                enodeb_name: info.enodeb_name,
                longitude: info.longitude,
                latitude: info.latitude,
                antennas: {}
            };
        }
        if (!hierarchy[siteName].antennas[antenna]) {
            hierarchy[siteName].antennas[antenna] = {
                id: antenna,
                azimuth: info.azimuth,
                band: info.frequency_band,
                type: info.cell_fdd_tdd_indication || 'FDD',
                cells: []
            };
        }
        hierarchy[siteName].antennas[antenna].cells.push({
            cellName,
            cellNum,
            frequency_band: info.frequency_band,
            localcell_id: info.localcell_id,
            azimuth: info.azimuth
        });
    }

    Object.values(hierarchy).forEach(site => {
        Object.values(site.antennas).forEach(ant => {
            ant.cells.sort((a, b) => a.cellNum - b.cellNum);
        });
    });

    state.siteHierarchy = hierarchy;
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
        const { siteName, antenna, cellNum } = parseCellName(cellName);
        const cqi = obs?.cqi ?? null;
        const hasLowCQI = cqi !== null && cqi < CONFIG.CQI_THRESHOLD;
        
        const status = getCellStatus(obs);
        const load = obs?.load ?? null;
        const color = getLoadColor(load, obs?.congested, cqi);
        const opacity = obs ? 0.7 : 0.4;
        const severity = obs?.severity ?? 0;
        const issueType = obs?.issue_type || 'Normal';
        
        pointFeatures.push({
            type: 'Feature',
            id: index,
            properties: {
                id: index,
                cell_name: cellName,
                site_name: siteName,
                antenna_id: antenna,
                cell_num: cellNum,
                enodeb_name: baseInfo.enodeb_name,
                status,
                color,
                opacity,
                load,
                congested: obs?.congested || false,
                issue_type: issueType,
                root_cause: obs?.root_cause || '-',
                severity,
                health_score: obs?.health_score ?? 100,
                throughput: obs?.throughput,
                cqi,
                has_low_cqi: hasLowCQI,
                traffic: obs?.traffic,
                ta: obs?.ta,
                signal_power: obs?.signal_power,
                band,
                azimuth,
                localcell_id: baseInfo.localcell_id,
                duplex: baseInfo.cell_fdd_tdd_indication || 'FDD'
            },
            geometry: { type: 'Point', coordinates: center }
        });
        
        const radius = calculateCellRadius(band, obs?.ta);
        const cacheKey = `${cellName}_${radius}`;
        const geometry = geometryCache[cacheKey] || createSectorPolygon(center, radius, azimuth, CONFIG.DEFAULT_BEAMWIDTH);
        geometryCache[cacheKey] = geometry;
        pruneGeometryCache();
        
        sectorFeatures.push({
            type: 'Feature',
            id: index,
            properties: {
                id: index,
                cell_name: cellName,
                site_name: siteName,
                antenna_id: antenna,
                enodeb_name: baseInfo.enodeb_name,
                status,
                color,
                opacity,
                load,
                cqi,
                has_low_cqi: hasLowCQI,
                congested: obs?.congested || false,
                band,
                azimuth,
                radius,
                severity,
                issue_type: issueType
            },
            geometry: { type: 'Polygon', coordinates: geometry }
        });
        
        if (!sites.has(siteName)) {
            sites.set(siteName, { name: siteName, coordinates: center, cells: [] });
        }
        sites.get(siteName).cells.push(cellName);
        
        index++;
    }
    
    return { pointFeatures, sectorFeatures, sites: Array.from(sites.values()) };
}

// --- Search Functionality ---
function performSearch(term) {
    const resEl = document.getElementById('search-results');
    if (!resEl) return;
    const q = term.trim().toLowerCase();
    if (q.length < 2) {
        resEl.innerHTML = '';
        return;
    }
    const results = [];
    state.pointFeatures.forEach(f => {
        const p = f.properties;
        if (p.cell_name.toLowerCase().includes(q) || p.site_name.toLowerCase().includes(q)) {
            results.push({ type: 'cell', name: p.cell_name, site: p.site_name });
        }
    });
    Object.keys(state.siteHierarchy).forEach(site => {
        if (site.toLowerCase().includes(q)) results.push({ type: 'site', name: site });
    });
    const limited = results.slice(0, 20);
    resEl.innerHTML = limited.map(r => `
        <div class="search-item" data-type="${r.type}" data-name="${r.name}">
            <span class="search-type">${r.type === 'cell' ? 'Cell' : 'Site'}</span>
            <span class="search-name">${r.name}</span>
        </div>
    `).join('');
}

// --- Site Info Panel ---
function showSiteInfoPanel(siteName, focusCell = null) {
    const site = state.siteHierarchy[siteName];
    if (!site) return;
    state.selectedSite = siteName;
    const firstCell = focusCell || (() => {
        const antennas = Object.values(site.antennas || {});
        if (!antennas.length) return null;
        const firstCells = antennas[0].cells || [];
        return firstCells.length ? firstCells[0].cellName : null;
    })();
    state.selectedCellName = firstCell;
    applyFilters();
    
    const panel = document.getElementById('cell-info-panel');
    if (!panel) return;
    panel.classList.remove('hidden');
    document.getElementById('cell-info-name').textContent = site.name;

    let totalCells = 0, congestedCells = 0, lowCQI = 0, avgLoad = 0, avgCQI = 0, loadCount = 0, cqiCount = 0;

    Object.values(site.antennas).forEach(ant => {
        ant.cells.forEach(cell => {
            totalCells++;
            const obs = state.currentObservations[cell.cellName];
            if (obs) {
                if (obs.congested) congestedCells++;
                if (obs.cqi !== null && obs.cqi < CONFIG.CQI_THRESHOLD) lowCQI++;
                if (obs.load !== null && obs.load !== undefined) { avgLoad += obs.load; loadCount++; }
                if (obs.cqi !== null && obs.cqi !== undefined) { avgCQI += obs.cqi; cqiCount++; }
            }
        });
    });

    avgLoad = loadCount ? avgLoad / loadCount : 0;
    avgCQI = cqiCount ? avgCQI / cqiCount : 0;

    const statusEl = document.getElementById('cell-status');
    let statusClass = 'normal', statusText = 'Normal';
    if (congestedCells > 0) { statusClass = 'congested'; statusText = `${congestedCells} congested`; }
    else if (lowCQI > 0) { statusClass = 'poor-cqi'; statusText = `${lowCQI} low CQI`; }
    statusEl.className = `cell-status ${statusClass}`;
    statusEl.textContent = statusText;
    document.getElementById('cell-health').textContent = `Cells: ${totalCells}`;

    const body = document.getElementById('cell-info-body');
    const antennaEntries = Object.entries(site.antennas).sort((a, b) => a[0].localeCompare(b[0]));
    let html = `
        <div class="site-info-section">
            <div class="site-info-row"><span>Location</span><span>${site.latitude.toFixed(5)}, ${site.longitude.toFixed(5)}</span></div>
            <div class="site-info-row"><span>Avg Load</span><span>${avgLoad.toFixed(1)}%</span></div>
            <div class="site-info-row"><span>Avg CQI</span><span class="${avgCQI < CONFIG.CQI_THRESHOLD ? 'text-danger' : ''}">${avgCQI.toFixed(1)}</span></div>
        </div>
        <div class="site-antennas">
    `;

    antennaEntries.forEach(([antennaId, ant]) => {
        html += `
            <div class="antenna-block" data-antenna="${antennaId}">
                <div class="antenna-header" onclick="toggleAntennaDropdown('${siteName}','${antennaId}')">
                    <span class="material-symbols-outlined">cell_tower</span>
                    <div class="antenna-title">
                        <div>${antennaId.toUpperCase()} • Band ${ant.band}</div>
                        <div class="antenna-sub">Azimuth ${ant.azimuth}° • ${ant.type}</div>
                    </div>
                    <span class="material-symbols-outlined expand-icon" id="expand-icon-${siteName}-${antennaId}">expand_more</span>
                </div>
                <div class="antenna-cells" id="antenna-cells-${siteName}-${antennaId}">
        `;
        ant.cells.forEach(cell => {
            const obs = state.currentObservations[cell.cellName];
            const status = getCellStatus(obs);
            const cqiVal = obs?.cqi;
            const low = cqiVal !== null && cqiVal !== undefined && cqiVal < CONFIG.CQI_THRESHOLD;
            html += `
                <div class="cell-item" onclick="selectCell('${cell.cellName}')">
                    <div class="cell-item-main">
                        <span class="cell-dot status-${status}"></span>
                        <span class="cell-name">${cell.cellName}</span>
                        <span class="cell-band">${cell.frequency_band}</span>
                    </div>
                    <div class="cell-item-stats">
                        <span>Load: ${formatNumber(obs?.load)}%</span>
                        <span class="${low ? 'text-danger' : ''}">CQI: ${formatNumber(cqiVal)}</span>
                    </div>
                </div>
            `;
        });
        html += `</div></div>`;
    });

    html += '</div>';
    body.innerHTML = html;

    renderActionPanel(state.selectedCellName);

    if (focusCell) selectCell(focusCell, false);
}

function hideSiteInfoPanel() {
    state.selectedSite = null;
    document.getElementById('cell-info-panel')?.classList.add('hidden');
    applyFilters();
}

// --- Action Simulator ---
function renderActionPanel(cellName) {
    const panel = document.getElementById('action-panel');
    const select = document.getElementById('action-select');
    const runBtn = document.getElementById('action-run');
    const result = document.getElementById('action-result');
    if (!panel || !select || !runBtn || !result) return;

    if (!cellName) {
        panel.classList.add('disabled');
        runBtn.disabled = true;
        result.innerHTML = '<div class="action-hint">Select a cell to simulate.</div>';
        return;
    }

    const obs = state.currentObservations[cellName];
    const isCritical = obs && (obs.congested || (obs.cqi !== null && obs.cqi < CONFIG.CQI_THRESHOLD));

    panel.classList.remove('disabled');
    runBtn.disabled = false; // Always allow simulation on any selected cell
    
    if (isCritical) {
        result.innerHTML = '<div class="action-hint action-hint-warning">⚠️ Cell is congested or has low CQI - action recommended.</div>';
    } else {
        result.innerHTML = '<div class="action-hint">Cell: ' + cellName + ' (healthy - simulation for testing)</div>';
    }
    buildActionParamsUI(select.value || '');
}

function buildActionParamsUI(action) {
    const container = document.getElementById('action-params');
    if (!container) return;
    if (!action) {
        container.innerHTML = '<div class="action-hint">Choose an action to estimate impact.</div>';
        return;
    }

    if (action === 'tilt') {
        container.innerHTML = `
            <label class="action-label" for="param-tilt-deg">Downtilt (degrees)</label>
            <input type="number" id="param-tilt-deg" class="action-input" value="2" min="-5" max="10" step="0.5">
        `;
        return;
    }

    if (action === 'add_carrier') {
        const bands = (state.globalStats?.frequency_bands || []).map(String);
        const options = bands.length
            ? bands.map(b => `<option value="${b}">Band ${b}</option>`).join('')
            : '<option value="">No bands available</option>';
        container.innerHTML = `
            <label class="action-label" for="param-carrier-band">Select band</label>
            <select id="param-carrier-band" class="action-input">${options}</select>
            <div class="action-hint">Adds a carrier only if the site does not already host this band.</div>
        `;
        return;
    }

    if (action === 'redistribute') {
        container.innerHTML = `
            <label class="action-label" for="param-redistribute-target">Target cell (optional)</label>
            <input type="text" id="param-redistribute-target" class="action-input" placeholder="neighbor cell name">
            <label class="action-label" for="param-redistribute-ratio">Redistribution ratio (0-0.6)</label>
            <input type="number" id="param-redistribute-ratio" class="action-input" value="0.2" min="0" max="0.6" step="0.05">
        `;
        return;
    }

    container.innerHTML = '<div class="action-hint">Choose an action to estimate impact.</div>';
}

function collectActionParams(action) {
    if (action === 'tilt') {
        const deg = Number(document.getElementById('param-tilt-deg')?.value || 0);
        return { degrees: deg };
    }
    if (action === 'redistribute') {
        const target = document.getElementById('param-redistribute-target')?.value || '';
        const ratio = Number(document.getElementById('param-redistribute-ratio')?.value || 0.2);
        return { target: target || undefined, ratio };
    }
    if (action === 'add_carrier') {
        const band = document.getElementById('param-carrier-band')?.value;
        return { band: band || undefined };
    }
    return {};
}

function displaySimulationResults(result) {
    const container = document.getElementById('action-result');
    if (!container) return;
    if (result.error) {
        container.innerHTML = `<div class="action-error">${result.error}</div>`;
        return;
    }

    const before = result.before || {};
    const after = result.after || {};
    const impact = result.impact || {};
    const simMode = result.simulation_mode || 'fast';
    const action = result.action || '';
    const defaultConfidence = action === 'redistribute' && simMode.includes('ns-3') ? 0.5 : (simMode.includes('ns-3') ? 0.9 : 0.6);
    const confidence = result.confidence ?? defaultConfidence;
    const confidencePct = Math.round(confidence * 100);
    const modeLabel = simMode.includes('ns-3') ? '🎯 ns-3' : '⚡ Fast';

    const neighbors = (impact.affected_cells || []).map(n => {
        const delta = n.load_change ?? n.change ?? 0;
        return { name: n.name || n.cell_name, delta };
    }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 12);
    const neighborsText = neighbors.length
        ? `Neighbors affected: ${neighbors.map(c => `${c.name} (${formatNumber(c.delta)}%)`).join(', ')}${impact.affected_cells.length > neighbors.length ? ', …more' : ''}`
        : '';

    container.innerHTML = `
        <div class="action-mode-badge">${modeLabel} (${confidencePct}% confidence)</div>
        <div class="action-comparison">
            <div>
                <div class="action-label">Before</div>
                <div>Load: ${formatNumber(before.load)}%</div>
                <div>CQI: ${formatNumber(before.cqi)}</div>
                <div>Throughput: ${formatThroughput(before.throughput || 0)}</div>
                ${before.sinr_db ? `<div>SINR: ${formatNumber(before.sinr_db)} dB</div>` : ''}
            </div>
            <div class="action-arrow">→</div>
            <div>
                <div class="action-label">After</div>
                <div>Load: ${formatNumber(after.load)}%</div>
                <div>CQI: ${formatNumber(after.cqi)}</div>
                <div>Throughput: ${formatThroughput(after.throughput || 0)}</div>
                ${after.sinr_db ? `<div>SINR: ${formatNumber(after.sinr_db)} dB</div>` : ''}
            </div>
        </div>
        <div class="action-impact">Load: ${impact.load_change >= 0 ? '+' : ''}${impact.load_change ?? 0}% | Throughput: ${impact.throughput_change >= 0 ? '+' : ''}${impact.throughput_change ?? 0} kbps</div>
        <div class="action-reco">${result.recommendation || ''}</div>
        ${neighborsText ? `<div class="action-affected">${neighborsText}</div>` : ''}
    `;
}

async function runSimulation(cellName, action) {
    const resultEl = document.getElementById('action-result');
    const modeSelect = document.getElementById('simulation-mode');
    const runBtn = document.getElementById('action-run');
    
    console.log('Running simulation:', { cellName, action });
    
    if (!cellName || !action) {
        if (resultEl) resultEl.innerHTML = '<div class="action-error">Select a cell and an action.</div>';
        return;
    }

    const params = collectActionParams(action);
    const timeEntry = state.timeIndex[state.currentTimeIndex] || {};
    const mode = modeSelect?.value || 'fast';

    if (action === 'redistribute' && mode === 'precise') {
        if (resultEl) resultEl.innerHTML = '<div class="action-error">Precise mode is not available for redistribute. Please use Fast.</div>';
        return;
    }

    if (action === 'add_carrier') {
        if (!params.band) {
            if (resultEl) resultEl.innerHTML = '<div class="action-error">Select a band to add.</div>';
            return;
        }
        const { siteName } = parseCellName(cellName);
        const site = state.siteHierarchy[siteName];
        const existingBands = new Set();
        if (site) {
            Object.values(site.antennas || {}).forEach(ant => existingBands.add(String(ant.band)));
        }
        if (existingBands.has(String(params.band))) {
            if (resultEl) resultEl.innerHTML = `<div class="action-error">Site ${siteName} already has Band ${params.band}.</div>`;
            return;
        }
    }

    try {
        // Update UI for loading state
        const isPrecise = mode === 'precise';
        const loadingMsg = isPrecise 
            ? '<div class="action-hint">🎯 Running ns-3 simulation (this may take 10-30 seconds)...</div>' 
            : '<div class="action-hint">⚡ Simulating...</div>';
        if (resultEl) resultEl.innerHTML = loadingMsg;
        if (runBtn) {
            runBtn.disabled = true;
            runBtn.innerHTML = '<span class="material-symbols-outlined">hourglass_top</span> Running...';
        }

        const res = await fetch('/api/simulate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cell_name: cellName, action, params, time_entry: timeEntry, mode })
        });
        const payload = await res.json();
        displaySimulationResults(payload);
    } catch (err) {
        if (resultEl) resultEl.innerHTML = `<div class="action-error">Simulation failed: ${err.message}</div>`;
    } finally {
        if (runBtn) {
            runBtn.disabled = false;
            runBtn.innerHTML = '<span class="material-symbols-outlined">play_arrow</span> Run Simulation';
        }
    }
}

window.toggleAntennaDropdown = (siteName, antennaId) => {
    const el = document.getElementById(`antenna-cells-${siteName}-${antennaId}`);
    const icon = document.getElementById(`expand-icon-${siteName}-${antennaId}`);
    if (el) {
        el.classList.toggle('expanded');
        icon?.classList.toggle('rotated');
    }
};

window.selectCell = (cellName, fly = true) => {
    const feature = state.pointFeatures.find(f => f.properties.cell_name === cellName);
    if (feature && state.map && fly) {
        state.map.flyTo({ center: feature.geometry.coordinates, zoom: 15, pitch: 45 });
    }
    state.selectedCellName = cellName;
    renderActionPanel(cellName);
    if (feature && state.popup) {
        const p = feature.properties;
        state.popup
            .setLngLat(feature.geometry.coordinates)
            .setHTML(`
                <div class="cell-popup">
                    <div class="cell-popup-header" style="border-left:4px solid ${p.color}">${p.cell_name}</div>
                    <div class="cell-popup-body">
                        <div class="popup-row"><span>Site</span><span>${p.site_name}</span></div>
                        <div class="popup-row"><span>Antenna</span><span>${p.antenna_id.toUpperCase()}</span></div>
                        <div class="popup-row"><span>Band</span><span>${p.band}</span></div>
                        <div class="popup-row"><span>Local ID</span><span>${p.localcell_id}</span></div>
                        <div class="popup-row"><span>Load</span><span>${formatNumber(p.load)}%</span></div>
                        <div class="popup-row ${p.has_low_cqi ? 'text-danger' : ''}"><span>CQI</span><span>${formatNumber(p.cqi)}</span></div>
                        <div class="popup-row"><span>Throughput</span><span>${formatThroughput(p.throughput)}</span></div>
                    </div>
                </div>
            `)
            .addTo(state.map);
    }
};

// --- Filtering ---
function applyFilters() {
    const { status, loadRange, severityRange, showLowCQIOnly, bands, issueTypes } = state.filters;
    const [minLoad, maxLoad] = loadRange;
    const [minSeverity, maxSeverity] = severityRange;
    
    const points = state.pointFeatures.filter(f => {
        const p = f.properties;
        if (state.selectedSite && p.site_name !== state.selectedSite) return false;
        if (!status[p.status]) return false;
        if (showLowCQIOnly && !p.has_low_cqi) return false;
        if (Object.keys(bands).length > 0 && bands[p.band] === false) return false;
        if (Object.keys(issueTypes).length > 0) {
            const it = p.issue_type || 'Normal';
            if (issueTypes[it] === false) return false;
        }
        if (p.load !== null && (p.load < minLoad || p.load > maxLoad)) return false;
        if (p.severity !== null && p.severity !== undefined && (p.severity < minSeverity || p.severity > maxSeverity)) return false;
        return true;
    });
    const sectors = state.sectorFeatures.filter(f => points.some(p => p.id === f.id));
    state.filteredPointFeatures = points;
    state.filteredSectorFeatures = sectors;
    updateMapData();
    updateAnalyticsCharts(points);
}

function populateFrequencyFilters(bandsList = []) {
    const container = document.getElementById('frequency-filters');
    if (!container) return;
    container.innerHTML = '';
    state.filters.bands = {};
    bandsList.forEach(b => {
        const id = `band-${b}`;
        const wrapper = document.createElement('label');
        wrapper.className = 'checkbox-item';
        wrapper.innerHTML = `<input type="checkbox" id="${id}" data-band="${b}" checked><span class="checkmark"></span><span>Band ${b}</span>`;
        container.appendChild(wrapper);
        state.filters.bands[b] = true;
    });
}

function populateIssueFilters(issueTypes = []) {
    const container = document.getElementById('issue-type-filters');
    if (!container) return;
    container.innerHTML = '';
    state.filters.issueTypes = {};
    issueTypes.forEach(type => {
        const safeId = `issue-${type.replace(/\s+/g, '-').toLowerCase()}`;
        const wrapper = document.createElement('label');
        wrapper.className = 'checkbox-item';
        wrapper.innerHTML = `<input type="checkbox" id="${safeId}" data-issue="${type}" checked><span class="checkmark"></span><span>${type}</span>`;
        container.appendChild(wrapper);
        state.filters.issueTypes[type] = true;
    });
}

function collectIssueTypesFromCurrent() {
    const set = new Set();
    state.pointFeatures.forEach(f => set.add(f.properties.issue_type || 'Normal'));
    return Array.from(set).sort();
}

function resetFiltersUI() {
    document.querySelectorAll('input[data-filter]').forEach(cb => { cb.checked = true; state.filters.status[cb.dataset.filter] = true; });
    Object.keys(state.filters.bands).forEach(k => state.filters.bands[k] = true);
    document.querySelectorAll('#frequency-filters input[type="checkbox"]').forEach(cb => cb.checked = true);
    Object.keys(state.filters.issueTypes).forEach(k => state.filters.issueTypes[k] = true);
    document.querySelectorAll('#issue-type-filters input[type="checkbox"]').forEach(cb => cb.checked = true);
    state.filters.loadRange = [0, 100];
    state.filters.severityRange = [0, 100];
    const lowCqi = document.getElementById('filter-low-cqi');
    if (lowCqi) lowCqi.checked = false;
    state.filters.showLowCQIOnly = false;
    applyFilters();
}

// --- Export ---
function downloadBlob(filename, content, type = 'application/json') {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

function exportJSON(filteredOnly = false) {
    const data = filteredOnly ? state.filteredPointFeatures : state.pointFeatures;
    downloadBlob('netvision-data.json', JSON.stringify(data, null, 2));
}

function exportCSV(filteredOnly = false) {
    const rows = filteredOnly ? state.filteredPointFeatures : state.pointFeatures;
    const header = ['cell_name','site_name','band','load','cqi','throughput','issue_type','severity','congested'];
    const lines = [header.join(',')];
    rows.forEach(f => {
        const p = f.properties;
        lines.push([p.cell_name, p.site_name, p.band, p.load ?? '', p.cqi ?? '', p.throughput ?? '', p.issue_type ?? '', p.severity ?? '', p.congested ? 'true' : 'false'].join(','));
    });
    downloadBlob('netvision-data.csv', lines.join('\n'), 'text/csv');
}

function simpleReport() {
    const total = state.filteredPointFeatures.length;
    const congested = state.filteredPointFeatures.filter(f => f.properties.congested).length;
    const lowCqi = state.filteredPointFeatures.filter(f => f.properties.has_low_cqi).length;
    const summary = `NetVision Report\nCells: ${total}\nCongested: ${congested}\nLow CQI: ${lowCqi}`;
    downloadBlob('netvision-report.txt', summary, 'text/plain');
}

// --- Time Navigation ---
async function loadTimeSlice(index) {
    if (index < 0 || index >= state.timeIndex.length) return;
    
    const timeEntry = state.timeIndex[index];
    state.currentTimeIndex = index;
    
    try {
        const res = await fetch(`/time_data/${timeEntry.filename}?t=${Date.now()}`);
        const data = await res.json();
        
        state.currentObservations = data.observations;
        state.currentStats = data.stats;
        
        const { pointFeatures, sectorFeatures } = buildFeaturesForTime(data.observations);
        state.pointFeatures = pointFeatures;
        state.sectorFeatures = sectorFeatures;
        state.features = pointFeatures;
        applyFilters();
        
        updateStatsUI(data.stats);
        updateAlertsUI(pointFeatures);
        updateTimeSliderUI();

        const issueTypes = collectIssueTypesFromCurrent();
        populateIssueFilters(issueTypes);

        if (state.selectedSite) {
            showSiteInfoPanel(state.selectedSite);
        }
        
    } catch (err) {
        console.error('Failed to load time slice:', err);
    }
}

function updateMapData() {
    if (!state.map) return;
    
    const pointsGeojson = { type: 'FeatureCollection', features: state.filteredPointFeatures };
    const sectorsGeojson = { type: 'FeatureCollection', features: state.filteredSectorFeatures };
    
    if (state.map.getSource('cells')) {
        state.map.getSource('cells').setData(pointsGeojson);
    }
    if (state.map.getSource('sectors')) {
        state.map.getSource('sectors').setData(sectorsGeojson);
    }
}

function updateTimeSliderUI() {
    const slider = document.getElementById('time-slider');
    const currentLabel = document.getElementById('time-current-label');
    const timestampEl = document.getElementById('timestamp');
    
    if (slider) slider.value = state.currentTimeIndex;
    
    const currentTime = state.timeIndex[state.currentTimeIndex]?.timestamp || '--';
    if (currentLabel) currentLabel.textContent = currentTime;
    if (timestampEl) timestampEl.textContent = currentTime;
}

function setupTimeControls() {
    const slider = document.getElementById('time-slider');
    const prevBtn = document.getElementById('time-prev');
    const nextBtn = document.getElementById('time-next');
    const playBtn = document.getElementById('time-play');
    const speedSelect = document.getElementById('time-speed-select');
    const startLabel = document.getElementById('time-start-label');
    const endLabel = document.getElementById('time-end-label');
    
    if (slider && state.timeIndex.length > 0) {
        slider.min = 0;
        slider.max = state.timeIndex.length - 1;
        slider.value = 0;

        const debouncedLoad = debounce((val) => loadTimeSlice(val), 120);
        slider.addEventListener('input', (e) => {
            debouncedLoad(parseInt(e.target.value, 10));
        });
    }
    
    if (startLabel && state.timeIndex.length > 0) startLabel.textContent = state.timeIndex[0]?.timestamp || '--';
    if (endLabel && state.timeIndex.length > 0) endLabel.textContent = state.timeIndex[state.timeIndex.length - 1]?.timestamp || '--';
    
    prevBtn?.addEventListener('click', () => {
        if (state.currentTimeIndex > 0) loadTimeSlice(state.currentTimeIndex - 1);
    });
    
    nextBtn?.addEventListener('click', () => {
        if (state.currentTimeIndex < state.timeIndex.length - 1) loadTimeSlice(state.currentTimeIndex + 1);
    });
    
    playBtn?.addEventListener('click', () => {
        state.isPlaying = !state.isPlaying;
        const icon = playBtn.querySelector('.material-symbols-outlined');
        
        if (state.isPlaying) {
            playBtn.classList.add('playing');
            icon.textContent = 'pause';
            const interval = CONFIG.PLAY_INTERVAL_MS / Math.max(0.25, state.playSpeed);
            state.playInterval = setInterval(() => {
                if (state.currentTimeIndex < state.timeIndex.length - 1) {
                    loadTimeSlice(state.currentTimeIndex + 1);
                } else {
                    loadTimeSlice(0);
                }
            }, interval);
        } else {
            playBtn.classList.remove('playing');
            icon.textContent = 'play_arrow';
            clearInterval(state.playInterval);
        }
    });

    speedSelect?.addEventListener('change', (e) => {
        const val = Number(e.target.value);
        state.playSpeed = isNaN(val) ? 1 : val;
        if (state.isPlaying) {
            document.getElementById('time-play')?.click();
            document.getElementById('time-play')?.click();
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

function destroyCharts() {
    Object.keys(state.charts).forEach(k => {
        if (state.charts[k]) {
            state.charts[k].destroy();
            state.charts[k] = null;
        }
    });
}

function updateAnalyticsCharts(features) {
    const issueCtx = document.getElementById('chart-issues');
    const sevCtx = document.getElementById('chart-severity');
    const bandCtx = document.getElementById('chart-bands');
    const loadCtx = document.getElementById('chart-load');
    if (!issueCtx || !sevCtx || !bandCtx || !loadCtx) return;

    destroyCharts();

    // Issue distribution
    const issueCounts = {};
    features.forEach(f => {
        const type = f.properties.issue_type || 'Normal';
        issueCounts[type] = (issueCounts[type] || 0) + 1;
    });
    
    state.charts.issues = new Chart(issueCtx, {
        type: 'doughnut',
        data: {
            labels: Object.keys(issueCounts),
            datasets: [{
                data: Object.values(issueCounts),
                backgroundColor: [
                    '#66BB6A', '#FF7900', '#E53935', '#FFB74D', '#42A5F5', '#AB47BC'
                ],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'right', labels: { color: '#ccc', boxWidth: 12 } }
            }
        }
    });

    // Severity distribution
    const severityBuckets = { 'Low (0-30)': 0, 'Medium (30-70)': 0, 'High (70-100)': 0 };
    features.forEach(f => {
        const s = f.properties.severity || 0;
        if (s < 30) severityBuckets['Low (0-30)']++;
        else if (s < 70) severityBuckets['Medium (30-70)']++;
        else severityBuckets['High (70-100)']++;
    });

    state.charts.severity = new Chart(sevCtx, {
        type: 'bar',
        data: {
            labels: Object.keys(severityBuckets),
            datasets: [{
                label: 'Cells',
                data: Object.values(severityBuckets),
                backgroundColor: ['#66BB6A', '#FFB74D', '#E53935']
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: { beginAtZero: true, grid: { color: '#333' }, ticks: { color: '#ccc' } },
                x: { grid: { display: false }, ticks: { color: '#ccc' } }
            },
            plugins: { legend: { display: false } }
        }
    });

    // Band distribution
    const bandCounts = {};
    features.forEach(f => {
        const b = f.properties.band;
        bandCounts[b] = (bandCounts[b] || 0) + 1;
    });

    state.charts.bands = new Chart(bandCtx, {
        type: 'bar',
        data: {
            labels: Object.keys(bandCounts).map(b => 'B' + b),
            datasets: [{
                label: 'Cells',
                data: Object.values(bandCounts),
                backgroundColor: '#42A5F5'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: { beginAtZero: true, grid: { color: '#333' }, ticks: { color: '#ccc' } },
                x: { grid: { display: false }, ticks: { color: '#ccc' } }
            },
            plugins: { legend: { display: false } }
        }
    });

    // Load distribution
    const loadBuckets = { '0-30%': 0, '30-50%': 0, '50-70%': 0, '70-85%': 0, '85-100%': 0 };
    features.forEach(f => {
        const l = f.properties.load || 0;
        if (l < 30) loadBuckets['0-30%']++;
        else if (l < 50) loadBuckets['30-50%']++;
        else if (l < 70) loadBuckets['50-70%']++;
        else if (l < 85) loadBuckets['70-85%']++;
        else loadBuckets['85-100%']++;
    });

    state.charts.load = new Chart(loadCtx, {
        type: 'bar',
        data: {
            labels: Object.keys(loadBuckets),
            datasets: [{
                label: 'Cells',
                data: Object.values(loadBuckets),
                backgroundColor: [
                    '#AED581', '#66BB6A', '#FDD835', '#FFB74D', '#FF7900'
                ]
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: { beginAtZero: true, grid: { color: '#333' }, ticks: { color: '#ccc' } },
                x: { grid: { display: false }, ticks: { color: '#ccc' } }
            },
            plugins: { legend: { display: false } }
        }
    });
}

function toggleModal(id, show) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.toggle('hidden', !show);
}

function toggleTheme() {
    const body = document.body;
    const isLight = body.classList.contains('theme-light');
    body.classList.toggle('theme-light', !isLight);
    body.classList.toggle('theme-dark', isLight);
    const icon = document.querySelector('#btn-theme .material-symbols-outlined');
    if (icon) icon.textContent = isLight ? 'dark_mode' : 'light_mode';
}

function setViewMode(mode) {
    if (!state.map) return;
    if (mode === '2d') {
        state.map.easeTo({ pitch: 0, bearing: 0, duration: 400 });
    } else if (mode === '3d') {
        state.map.easeTo({ pitch: 45, duration: 400 });
    }
    document.querySelectorAll('.toggle-btn[data-view]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === mode);
    });
}

function resetView() {
    if (!state.map) return;
    const bounds = new maplibregl.LngLatBounds();
    const features = state.filteredPointFeatures.length ? state.filteredPointFeatures : state.pointFeatures;
    features.forEach(f => bounds.extend(f.geometry.coordinates));
    if (features.length > 0) {
        state.map.fitBounds(bounds, { padding: 50, maxZoom: 13 });
    } else {
        state.map.flyTo({ center: CONFIG.MAP_CENTER, zoom: CONFIG.MAP_ZOOM, pitch: 45 });
    }
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
    
    map.addSource('sectors', { type: 'geojson', data: sectorsGeojson });
    
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
    
    map.addSource('cells', { type: 'geojson', data: pointsGeojson });
    
    // Heatmap - zoom-independent with fixed radius/intensity
    map.addLayer({
        id: 'cells-heatmap',
        type: 'heatmap',
        source: 'cells',
        maxzoom: 22,
        layout: { 'visibility': 'none' },
        paint: {
            'heatmap-weight': ['interpolate', ['linear'], ['coalesce', ['get', 'load'], 0], 0, 0.1, 100, 1],
            'heatmap-radius': CONFIG.HEATMAP_RADIUS,
            'heatmap-intensity': CONFIG.HEATMAP_INTENSITY,
            'heatmap-opacity': CONFIG.HEATMAP_OPACITY,
            'heatmap-color': [
                'interpolate', ['linear'], ['heatmap-density'],
                0.0, 'rgba(0,0,0,0)',
                0.1, 'rgb(0, 0, 255)',
                0.4, 'rgb(0, 200, 100)',
                0.7, 'rgb(255, 0, 0)',
                0.95, 'rgb(128, 0, 128)'
            ]
        }
    });
    
    map.addLayer({
        id: 'cells-points',
        type: 'circle',
        source: 'cells',
        paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 4, 12, 6, 16, 10],
            'circle-color': ['get', 'color'],
            'circle-opacity': 0.8,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 1.5
        }
    });

    map.addLayer({
        id: 'cells-labels',
        type: 'symbol',
        source: 'cells',
        minzoom: 13,
        layout: {
            'text-field': ['get', 'cell_name'],
            'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
            'text-size': 11,
            'text-offset': [0, 1.2]
        },
        paint: {
            'text-color': '#ffffff',
            'text-halo-color': 'rgba(0,0,0,0.6)',
            'text-halo-width': 1
        }
    });
    
    map.addLayer({
        id: 'cells-congested-ring',
        type: 'circle',
        source: 'cells',
        filter: ['==', ['get', 'congested'], true],
        paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 6, 12, 9, 16, 14],
            'circle-color': 'rgba(0,0,0,0)',
            'circle-stroke-color': CONFIG.COLORS.CONGESTED,
            'circle-stroke-width': 3
        }
    });
    
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
    
    map.addLayer({
        id: 'sites-circle',
        type: 'circle',
        source: 'sites',
        paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 5, 14, 10],
            'circle-color': CONFIG.COLORS.SITE_MARKER,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 2
        }
    });
}

function setupMapInteractions(map) {
    map.on('click', 'cells-points', (e) => {
        const feature = e.features?.[0];
        if (!feature) return;
        const p = feature.properties;
        showSiteInfoPanel(p.site_name, p.cell_name);
        map.flyTo({ center: feature.geometry.coordinates, zoom: 14, pitch: 45 });
    });
    
    map.on('click', 'sites-circle', (e) => {
        const feature = e.features?.[0];
        if (!feature) return;
        const siteName = feature.properties.name;
        showSiteInfoPanel(siteName);
        map.flyTo({ center: feature.geometry.coordinates, zoom: 13, pitch: 30 });
    });
    
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
    
    if (state.map.getLayer('cells-heatmap')) {
        state.map.setLayoutProperty('cells-heatmap', 'visibility', mode === 'heatmap' ? 'visible' : 'none');
        if (mode === 'heatmap') state.map.moveLayer('cells-heatmap');
    }
    
    const hideInHeatmap = ['cells-points', 'cells-labels', 'cells-congested-ring', 
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
    document.querySelectorAll('.toggle-btn[data-viz]').forEach(btn => {
        btn.addEventListener('click', () => setVisualizationMode(btn.dataset.viz));
    });

    document.querySelectorAll('.toggle-btn[data-view]').forEach(btn => {
        btn.addEventListener('click', () => setViewMode(btn.dataset.view));
    });
    
    document.getElementById('basemap-select')?.addEventListener('change', (e) => {
        const basemap = CONFIG.BASEMAPS[e.target.value];
        if (basemap && state.map) {
            state.map.getSource('basemap').tiles = basemap.tiles;
            state.map.style.sourceCaches['basemap'].clearTiles();
            state.map.style.sourceCaches['basemap'].update(state.map.transform);
            state.map.triggerRepaint();
        }
    });
    
    document.getElementById('toggle-left')?.addEventListener('click', () => {
        document.getElementById('sidebar-left')?.classList.toggle('collapsed');
    });
    document.getElementById('toggle-right')?.addEventListener('click', () => {
        document.getElementById('sidebar-right')?.classList.toggle('collapsed');
    });

    document.getElementById('cell-info-close')?.addEventListener('click', hideSiteInfoPanel);

    document.getElementById('filter-low-cqi')?.addEventListener('change', (e) => {
        state.filters.showLowCQIOnly = e.target.checked;
        applyFilters();
    });

    document.querySelectorAll('input[data-filter]').forEach(cb => {
        cb.addEventListener('change', () => {
            const key = cb.dataset.filter;
            state.filters.status[key] = cb.checked;
            applyFilters();
        });
    });

    document.getElementById('frequency-filters')?.addEventListener('change', (e) => {
        if (e.target instanceof HTMLInputElement && e.target.dataset.band) {
            const band = Number(e.target.dataset.band);
            state.filters.bands[band] = e.target.checked;
            applyFilters();
        }
    });

    document.getElementById('issue-type-filters')?.addEventListener('change', (e) => {
        if (e.target instanceof HTMLInputElement && e.target.dataset.issue) {
            const issue = e.target.dataset.issue;
            state.filters.issueTypes[issue] = e.target.checked;
            applyFilters();
        }
    });

    document.getElementById('btn-apply-filters')?.addEventListener('click', applyFilters);
    document.getElementById('btn-reset-filters')?.addEventListener('click', resetFiltersUI);

    // Search
    const searchInput = document.getElementById('cell-search');
    const searchClear = document.getElementById('search-clear');
    const doSearch = debounce(() => performSearch(searchInput.value), 150);
    searchInput?.addEventListener('input', () => {
        if (searchInput.value.length > 0) searchClear?.classList.remove('hidden');
        else searchClear?.classList.add('hidden');
        doSearch();
    });
    searchClear?.addEventListener('click', () => {
        searchInput.value = '';
        document.getElementById('search-results').innerHTML = '';
        searchClear.classList.add('hidden');
    });
    document.getElementById('search-results')?.addEventListener('click', (e) => {
        const item = e.target.closest('.search-item');
        if (!item) return;
        const type = item.dataset.type;
        const name = item.dataset.name;
        if (type === 'cell') selectCell(name, true);
        else if (type === 'site') showSiteInfoPanel(name);
    });

    // Export buttons
    document.getElementById('export-json')?.addEventListener('click', () => exportJSON(false));
    document.getElementById('export-csv')?.addEventListener('click', () => exportCSV(false));
    document.getElementById('export-report')?.addEventListener('click', simpleReport);
    document.getElementById('export-congested')?.addEventListener('click', () => exportCSV(true));

    document.getElementById('btn-theme')?.addEventListener('click', toggleTheme);

    document.getElementById('btn-analytics')?.addEventListener('click', () => toggleModal('analytics-modal', true));
    document.getElementById('analytics-close')?.addEventListener('click', () => toggleModal('analytics-modal', false));

    document.getElementById('btn-export')?.addEventListener('click', () => toggleModal('export-modal', true));
    document.getElementById('export-close')?.addEventListener('click', () => toggleModal('export-modal', false));

    document.getElementById('btn-refresh')?.addEventListener('click', () => window.location.reload());

    const actionSelect = document.getElementById('action-select');
    actionSelect?.addEventListener('change', () => buildActionParamsUI(actionSelect.value));
    document.getElementById('action-run')?.addEventListener('click', () => runSimulation(state.selectedCellName, actionSelect?.value));
    renderActionPanel(state.selectedCellName);

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        const tag = (e.target instanceof HTMLElement) ? e.target.tagName.toLowerCase() : '';
        const isTyping = tag === 'input' || tag === 'textarea';
        if (isTyping) return;
        switch (e.key.toLowerCase()) {
            case 'f': e.preventDefault(); document.getElementById('cell-search')?.focus(); break;
            case 'r': e.preventDefault(); resetView(); break;
            case 't': e.preventDefault(); toggleTheme(); break;
            case '2': e.preventDefault(); setViewMode('2d'); break;
            case '3': e.preventDefault(); setViewMode('3d'); break;
            case 'a': e.preventDefault(); toggleModal('analytics-modal', true); break;
            case 'e': e.preventDefault(); toggleModal('export-modal', true); break;
        }
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
        
        const [baselineRes, timeIndexRes, statsRes] = await Promise.all([
            fetch('/baseline.json?t=' + Date.now()),
            fetch('/time_index.json?t=' + Date.now()),
            fetch('/stats.json?t=' + Date.now())
        ]);
        
        state.baseline = await baselineRes.json();
        const timeIndexData = await timeIndexRes.json();
        state.timeIndex = [...timeIndexData.timestamps].sort((a, b) => parseTimestamp(a.timestamp) - parseTimestamp(b.timestamp));
        state.globalStats = await statsRes.json();
        buildSiteHierarchy();

        populateFrequencyFilters(state.globalStats?.frequency_bands || []);
        
        console.log(`Loaded ${Object.keys(state.baseline).length} cells, ${state.timeIndex.length} time slices`);
        
        setLoading(true, 'Loading initial time slice...');
        
        await loadTimeSlice(0);
        
        setLoading(true, 'Initializing map...');
        
        const { pointFeatures, sectorFeatures, sites } = buildFeaturesForTime(state.currentObservations);
        state.pointFeatures = pointFeatures;
        state.sectorFeatures = sectorFeatures;
        state.filteredPointFeatures = pointFeatures;
        state.filteredSectorFeatures = sectorFeatures;
        
        const map = initMap();
        
        map.on('load', () => {
            addMapLayers(map, sites);
            setupMapInteractions(map);
            
            if (pointFeatures.length > 0) {
                const bounds = new maplibregl.LngLatBounds();
                pointFeatures.forEach(f => bounds.extend(f.geometry.coordinates));
                map.fitBounds(bounds, { padding: 50, maxZoom: 13 });
            }
            
            setLoading(false);
        });
        
        setupTimeControls();
        setupEventHandlers();
        renderActionPanel(state.selectedCellName);
        
    } catch (err) {
        console.error('Initialization failed:', err);
        setLoading(false);
    }
}

// Start
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
