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
    currentRecommendations: [],

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
const REQUIRED_OBSERVATION_KEYS = ['load', 'throughput', 'traffic', 'ta', 'cqi'];
let hasObservationSchemaWarning = false;

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

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function sanitizeRichHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = String(html ?? '');
    template.content.querySelectorAll('script, iframe, object, embed').forEach(el => el.remove());
    template.content.querySelectorAll('*').forEach(el => {
        Array.from(el.attributes).forEach(attr => {
            const name = attr.name.toLowerCase();
            const value = attr.value || '';
            if (name.startsWith('on')) {
                el.removeAttribute(attr.name);
            } else if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(value)) {
                el.removeAttribute(attr.name);
            }
        });
    });
    return template.innerHTML;
}

function getAuthToken() {
    try {
        return (
            localStorage.getItem('netvision_api_token') ||
            localStorage.getItem('api_token') ||
            localStorage.getItem('auth_token') ||
            ''
        );
    } catch {
        return '';
    }
}

async function fetchWithAuth(url, init = {}) {
    const headers = new Headers(init.headers || {});
    const token = getAuthToken();
    if (token && !headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${token}`);
    }
    return fetch(url, {
        ...init,
        headers,
        credentials: 'same-origin',
    });
}

function buildDataUrl(...segments) {
    const pathSegments = segments
        .map(seg => String(seg ?? '').trim())
        .filter(Boolean)
        .map(seg => encodeURIComponent(seg));
    return `/api/data/${pathSegments.join('/')}`;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function enqueueJob(jobType, payload) {
    const body = { ...(payload || {}), job_type: jobType };
    const res = await fetchWithAuth('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    let data = null;
    try {
        data = await res.json();
    } catch {
        data = null;
    }

    if (!res.ok) {
        const message = data?.error || `Failed to enqueue ${jobType} job`;
        throw new Error(message);
    }

    const jobId = data?.jobId;
    if (typeof jobId !== 'string' || !jobId.trim()) {
        throw new Error('Invalid job response: missing jobId');
    }

    return { jobId, status: data?.status || 'pending' };
}

async function fetchJobStatus(jobId) {
    const res = await fetchWithAuth(`/api/jobs/${encodeURIComponent(jobId)}`);
    let payload = null;
    try {
        payload = await res.json();
    } catch {
        payload = null;
    }

    if (!res.ok) {
        const message = payload?.error || `Failed to fetch job status (${res.status})`;
        throw new Error(message);
    }

    return payload || {};
}

function toJobStatusLabel(status) {
    const normalized = String(status || '').toLowerCase();
    if (normalized === 'running') return 'running';
    if (normalized === 'done') return 'done';
    if (normalized === 'failed') return 'failed';
    return 'queued';
}

async function waitForJobResult(jobId, options = {}) {
    const pollIntervalMs = Number.isFinite(options.pollIntervalMs) ? options.pollIntervalMs : 2000;
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 180000;
    const onStatus = typeof options.onStatus === 'function' ? options.onStatus : null;
    const startedAt = Date.now();

    while (Date.now() - startedAt <= timeoutMs) {
        const statusPayload = await fetchJobStatus(jobId);
        const status = String(statusPayload?.status || '').toLowerCase();

        if (onStatus) {
            onStatus(toJobStatusLabel(status));
        }

        if (status === 'done') {
            return statusPayload;
        }
        if (status === 'failed') {
            throw new Error(statusPayload?.error || 'Job execution failed');
        }

        await sleep(pollIntervalMs);
    }

    throw new Error('Job polling timed out');
}

function warnIfObservationSchemaMismatch(observations, sourceLabel = 'observation payload') {
    if (hasObservationSchemaWarning) return;
    const sample = Object.values(observations || {}).find(v => v && typeof v === 'object' && !Array.isArray(v));
    if (!sample) return;
    const missing = REQUIRED_OBSERVATION_KEYS.filter(key => !(key in sample));
    if (missing.length === 0) return;

    hasObservationSchemaWarning = true;
    const message = `[DATA SCHEMA WARNING] Missing keys in ${sourceLabel}: ${missing.join(', ')}. Expected keys: ${REQUIRED_OBSERVATION_KEYS.join(', ')}`;
    console.error(message, { sample });
    showNotification('Data schema mismatch detected. See console for missing KPI keys.', 'error');
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
    if (!observations) observations = {};
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
    resEl.innerHTML = '';
    const fragment = document.createDocumentFragment();
    limited.forEach((r) => {
        const item = document.createElement('div');
        item.className = 'search-item';
        item.dataset.type = r.type;
        item.dataset.name = r.name;

        const type = document.createElement('span');
        type.className = 'search-type';
        type.textContent = r.type === 'cell' ? 'Cell' : 'Site';

        const name = document.createElement('span');
        name.className = 'search-name';
        name.textContent = r.name;

        item.appendChild(type);
        item.appendChild(name);
        fragment.appendChild(item);
    });
    resEl.appendChild(fragment);
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
    const safeSiteId = String(siteName).replace(/[^a-zA-Z0-9_-]/g, '_');
    let html = `
        <div class="site-info-section">
            <div class="site-info-row"><span>Location</span><span>${escapeHtml(site.latitude.toFixed(5))}, ${escapeHtml(site.longitude.toFixed(5))}</span></div>
            <div class="site-info-row"><span>Avg Load</span><span>${avgLoad.toFixed(1)}%</span></div>
            <div class="site-info-row"><span>Avg CQI</span><span class="${avgCQI < CONFIG.CQI_THRESHOLD ? 'text-danger' : ''}">${avgCQI.toFixed(1)}</span></div>
        </div>
        <div class="site-antennas">
    `;

    antennaEntries.forEach(([antennaId, ant]) => {
        const safeAntennaId = String(antennaId).replace(/[^a-zA-Z0-9_-]/g, '_');
        html += `
            <div class="antenna-block" data-antenna="${escapeHtml(antennaId)}">
                <div class="antenna-header" data-site-name="${escapeHtml(siteName)}" data-antenna-id="${escapeHtml(antennaId)}">
                    <span class="material-symbols-outlined">cell_tower</span>
                    <div class="antenna-title">
                        <div>${escapeHtml(antennaId.toUpperCase())} • Band ${escapeHtml(ant.band)}</div>
                        <div class="antenna-sub">Azimuth ${escapeHtml(ant.azimuth)} deg - ${escapeHtml(ant.type)}</div>
                    </div>
                    <span class="material-symbols-outlined expand-icon" id="expand-icon-${safeSiteId}-${safeAntennaId}">expand_more</span>
                </div>
                <div class="antenna-cells" id="antenna-cells-${safeSiteId}-${safeAntennaId}">
        `;
        ant.cells.forEach(cell => {
            const obs = state.currentObservations[cell.cellName];
            const status = getCellStatus(obs);
            const cqiVal = obs?.cqi;
            const low = cqiVal !== null && cqiVal !== undefined && cqiVal < CONFIG.CQI_THRESHOLD;
            html += `
                <div class="cell-item" data-cell-name="${escapeHtml(cell.cellName)}">
                    <div class="cell-item-main">
                        <span class="cell-dot status-${status}"></span>
                        <span class="cell-name">${escapeHtml(cell.cellName)}</span>
                        <span class="cell-band">${escapeHtml(cell.frequency_band)}</span>
                    </div>
                    <div class="cell-item-stats">
                        <span>Load: ${escapeHtml(formatNumber(obs?.load))}%</span>
                        <span class="${low ? 'text-danger' : ''}">CQI: ${escapeHtml(formatNumber(cqiVal))}</span>
                    </div>
                </div>
            `;
        });
        html += `</div></div>`;
    });

    html += '</div>';
    body.innerHTML = sanitizeRichHtml(html);
    body.querySelectorAll('.antenna-header[data-site-name][data-antenna-id]').forEach((header) => {
        header.addEventListener('click', () => {
            const selectedSiteName = header.dataset.siteName;
            const selectedAntennaId = header.dataset.antennaId;
            if (selectedSiteName && selectedAntennaId) {
                window.toggleAntennaDropdown(selectedSiteName, selectedAntennaId);
            }
        });
    });
    body.querySelectorAll('.cell-item[data-cell-name]').forEach((cellEl) => {
        cellEl.addEventListener('click', () => {
            const selectedCellName = cellEl.dataset.cellName;
            if (selectedCellName) {
                window.selectCell(selectedCellName);
            }
        });
    });

    renderActionPanel(state.selectedCellName);

    if (focusCell) selectCell(focusCell, false);
}

function hideSiteInfoPanel() {
    state.selectedSite = null;
    document.getElementById('cell-info-panel')?.classList.add('hidden');
    applyFilters();
}

// --- Backend Recommendation Engine ---

const BACKEND_ACTION_TO_SIM_ACTION = Object.freeze({
    'Équilibrage MLB': 'redistribute',
    'Ajustement Tilt': 'tilt',
    'Ajustement Puissance': 'power',
    'Activation carrier (CA)': 'add_carrier',
    'Tuning paramètres radio': 'parameter_tuning',
    'Upgrade MIMO': 'mimo_upgrade',
    'Small Cell / Micro': 'small_cell',
    'Ajout 4ème secteur': 'add_sector',
    'Nouveau site macro': 'add_site',
    'Cell Split': 'split_cell',
    'Aucune action requise': null,
    'Data too stale for decision': null,
});

const ACTION_UI_METADATA = Object.freeze({
    tilt: { name: 'Ajustement Tilt', timeline: 'court_terme', recoveryRate: 15, capex: false, effect: 'Optimisation couverture et interférences' },
    power: { name: 'Ajustement Puissance', timeline: 'court_terme', recoveryRate: 20, capex: false, effect: 'Réduction interférence et empreinte radio' },
    redistribute: { name: 'Équilibrage MLB', timeline: 'court_terme', recoveryRate: 40, capex: false, effect: 'Déplacement charge vers voisins moins chargés' },
    parameter_tuning: { name: 'Tuning paramètres radio', timeline: 'court_terme', recoveryRate: 25, capex: false, effect: 'Ajustement paramètres handover/scheduler' },
    add_carrier: { name: 'Activation carrier (CA)', timeline: 'moyen_terme', recoveryRate: 50, capex: true, effect: 'Ajout capacité spectrale' },
    mimo_upgrade: { name: 'Upgrade MIMO', timeline: 'moyen_terme', recoveryRate: 35, capex: true, effect: 'Amélioration efficacité spectrale' },
    small_cell: { name: 'Small Cell / Micro', timeline: 'moyen_terme', recoveryRate: 45, capex: true, effect: 'Décharge locale hotspot' },
    add_sector: { name: 'Ajout 4ème secteur', timeline: 'long_terme', recoveryRate: 85, capex: true, effect: 'Augmentation capacité sectorielle' },
    add_site: { name: 'Nouveau site macro', timeline: 'long_terme', recoveryRate: 90, capex: true, effect: 'Nouvelle capacité de zone' },
    split_cell: { name: 'Cell Split', timeline: 'long_terme', recoveryRate: 70, capex: true, effect: 'Subdivision cellule haute charge' },
});

const TIER_TO_UI = Object.freeze({
    court_terme: { label: 'Court terme', className: 'timeline-short' },
    moyen_terme: { label: 'Moyen terme', className: 'timeline-medium' },
    long_terme: { label: 'Long terme', className: 'timeline-long' },
    none: { label: 'Info', className: '' },
});

let recommendationRequestSeq = 0;
const recommendationCache = new Map();

function toRecoveryPercent(rawValue, fallbackValue = 0) {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) {
        return Math.max(0, Math.min(100, Number(fallbackValue) || 0));
    }
    return Math.max(0, Math.min(100, Math.round(parsed)));
}

function confidenceToPercent(confidence) {
    const normalized = String(confidence || '').trim().toLowerCase();
    if (normalized === 'high') return 85;
    if (normalized === 'medium') return 65;
    if (normalized === 'low') return 45;
    return 50;
}

function getSuggestedCarrierBand(cellName) {
    const bands = (state.globalStats?.frequency_bands || []).map(b => String(b));
    if (!bands.length) return '';

    const { siteName } = parseCellName(cellName || '');
    const site = state.siteHierarchy[siteName];
    const existingBands = new Set();
    if (site?.antennas) {
        Object.values(site.antennas).forEach(ant => existingBands.add(String(ant.band)));
    }

    return bands.find(b => !existingBands.has(String(b))) || bands[0];
}

function getRecommendationDefaultParams(simAction, cellName) {
    switch (simAction) {
        case 'tilt':
            return { degrees: 2 };
        case 'redistribute':
            return { ratio: 0.2 };
        case 'add_carrier':
            return { band: getSuggestedCarrierBand(cellName) };
        case 'power':
            return { reduction: 3 };
        case 'parameter_tuning':
            return { cio: -3, hysteresis: 2 };
        case 'mimo_upgrade':
            return { targetMimo: '4T4R' };
        case 'small_cell':
            return { type: 'micro' };
        case 'add_sector':
            return { targetSectors: 4 };
        case 'add_site':
            return { siteType: 'macro' };
        case 'split_cell':
            return { newCellCount: 2 };
        default:
            return {};
    }
}

function mapBackendRecommendation(payload, recommendation, cellName, idx) {
    const actionLabel = String(recommendation?.action || '').trim();
    const simAction = BACKEND_ACTION_TO_SIM_ACTION[actionLabel] ?? null;
    const actionMeta = simAction ? ACTION_UI_METADATA[simAction] : null;
    const recoveryPct = toRecoveryPercent(
        recommendation?.estimated_recovery_pct,
        actionMeta?.recoveryRate || 0
    );

    return {
        id: `${cellName}-${idx}-${simAction || 'none'}`,
        cellName,
        actionLabel,
        simAction,
        title: actionMeta?.name || actionLabel || 'Recommendation',
        reason: String(recommendation?.reason || '').trim() || 'No reason provided by backend',
        confidence: String(recommendation?.confidence || 'medium').toLowerCase(),
        confidencePct: confidenceToPercent(recommendation?.confidence),
        timeline: String(recommendation?.tier || actionMeta?.timeline || 'none'),
        recoveryRate: recoveryPct,
        estimatedRecoveryPct: recoveryPct,
        priorityRank: Number.parseInt(recommendation?.priority_rank, 10) || idx + 1,
        currentMetrics: payload?.current_kpis || {},
        predictedMetrics: payload?.predicted_next_hour || {},
        computedParams: getRecommendationDefaultParams(simAction, cellName),
    };
}

async function fetchBackendDecision(cellName) {
    const response = await fetchWithAuth('/api/recommend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cell_name: cellName }),
    });

    let payload = null;
    try {
        payload = await response.json();
    } catch {
        payload = null;
    }

    if (!response.ok) {
        const message = payload?.detail || payload?.error || `Recommendation API failed (${response.status})`;
        throw new Error(message);
    }

    if (!payload || typeof payload !== 'object') {
        throw new Error('Recommendation API returned an invalid payload');
    }

    return payload;
}

async function renderRecommendationsPanel(cellName) {
    const container = document.getElementById('reco-list');
    const badge = document.getElementById('reco-count');
    if (!container) return;

    if (!cellName) {
        state.currentRecommendations = [];
        container.innerHTML = '<div class="reco-placeholder">Sélectionner une cellule pour les recommandations</div>';
        if (badge) badge.textContent = '0';
        return;
    }

    const requestSeq = ++recommendationRequestSeq;
    container.innerHTML = '<div class="reco-placeholder">Chargement des recommandations backend…</div>';

    try {
        const payload = recommendationCache.get(cellName) || await fetchBackendDecision(cellName);
        recommendationCache.set(cellName, payload);

        if (requestSeq !== recommendationRequestSeq) {
            return;
        }

        const rawRecommendations = Array.isArray(payload?.recommended_actions) ? payload.recommended_actions : [];
        const recommendations = rawRecommendations
            .map((recommendation, idx) => mapBackendRecommendation(payload, recommendation, cellName, idx))
            .sort((a, b) => a.priorityRank - b.priorityRank);

        state.currentRecommendations = recommendations;
        if (badge) badge.textContent = String(recommendations.length);

        if (!recommendations.length) {
            container.innerHTML = '<div class="reco-placeholder">Aucune recommandation disponible</div>';
            return;
        }

        container.innerHTML = sanitizeRichHtml(recommendations.map((recommendation, idx) => {
            const timeline = TIER_TO_UI[recommendation.timeline] || TIER_TO_UI.none;
            const isSimulatable = Boolean(recommendation.simAction);
            const currentLoad = Number(recommendation.currentMetrics?.prb_load);
            const predictedLoad = Number(recommendation.predictedMetrics?.prb_load);
            const hasLoadDelta = Number.isFinite(currentLoad) && Number.isFinite(predictedLoad);

            const kpiSummary = hasLoadDelta
                ? `<div class="reco-metric"><span class="reco-metric-label">PRB:</span><span class="reco-metric-value">${escapeHtml(currentLoad.toFixed(1))}% → ${escapeHtml(predictedLoad.toFixed(1))}%</span></div>`
                : '';

            const buttonHtml = isSimulatable
                ? `<button class="reco-apply-btn" data-reco-idx="${idx}"><span class="material-symbols-outlined">bolt</span>Simuler cette action</button>`
                : '<div class="reco-capex-note">Aucune simulation requise</div>';

            return `
                <div class="reco-item" data-reco-idx="${idx}">
                    <div class="reco-header">
                        <div class="reco-icon">
                            <span class="material-symbols-outlined">${escapeHtml(getRecoIcon(recommendation.simAction))}</span>
                        </div>
                        <div class="reco-header-content">
                            <div class="reco-title">${escapeHtml(recommendation.title)}</div>
                            <div class="reco-badges">
                                <span class="reco-priority-badge">#${escapeHtml(recommendation.priorityRank)}</span>
                                <span class="reco-timeline-badge ${escapeHtml(timeline.className)}">${escapeHtml(timeline.label)}</span>
                                <span class="reco-recovery-badge">↑${escapeHtml(recommendation.recoveryRate)}%</span>
                            </div>
                        </div>
                    </div>
                    <div class="reco-body">${escapeHtml(recommendation.reason)}</div>
                    <div class="reco-metrics">
                        ${kpiSummary}
                        <div class="reco-metric"><span class="reco-metric-label">Confiance:</span><span class="reco-metric-value">${escapeHtml(recommendation.confidencePct)}%</span></div>
                    </div>
                    ${buttonHtml}
                </div>
            `;
        }).join(''));

        container.querySelectorAll('.reco-apply-btn[data-reco-idx]').forEach((button) => {
            button.addEventListener('click', () => {
                const idx = Number(button.dataset.recoIdx);
                if (!Number.isNaN(idx)) {
                    window.applyRecommendation(idx);
                }
            });
        });
    } catch (err) {
        if (requestSeq !== recommendationRequestSeq) {
            return;
        }
        state.currentRecommendations = [];
        if (badge) badge.textContent = '0';
        container.innerHTML = `<div class="reco-placeholder">Backend indisponible: ${escapeHtml(err?.message || 'unknown error')}</div>`;
    }
}

function getRecoIcon(simAction) {
    const icons = {
        tilt: 'cell_tower',
        power: 'tune',
        redistribute: 'sync_alt',
        parameter_tuning: 'tune',
        add_carrier: 'add_circle',
        mimo_upgrade: 'network_cell',
        small_cell: 'add_location_alt',
        add_sector: 'settings_input_antenna',
        add_site: 'add_location',
        split_cell: 'call_split',
    };
    return icons[simAction] || 'lightbulb';
}

window.applyRecommendation = function(idx) {
    const recommendation = state.currentRecommendations?.[idx];
    if (!recommendation) return;

    if (!recommendation.simAction) {
        const resultEl = document.getElementById('action-result');
        if (resultEl) {
            resultEl.innerHTML = '<div class="action-hint">Aucune simulation requise pour cette recommandation.</div>';
        }
        return;
    }

    const actionSelect = document.getElementById('action-select');
    if (!actionSelect) return;

    actionSelect.value = recommendation.simAction;
    buildActionParamsUI(recommendation.simAction);

    setTimeout(() => {
        const defaults = recommendation.computedParams || {};

        if (recommendation.simAction === 'tilt' && defaults.degrees !== undefined) {
            const input = document.getElementById('param-tilt-deg');
            if (input) input.value = defaults.degrees;
        }
        if (recommendation.simAction === 'redistribute' && defaults.ratio !== undefined) {
            const input = document.getElementById('param-redistribute-ratio');
            if (input) input.value = defaults.ratio;
        }
        if (recommendation.simAction === 'add_carrier' && defaults.band !== undefined) {
            const input = document.getElementById('param-carrier-band');
            if (input) input.value = defaults.band;
        }
        if (recommendation.simAction === 'power' && defaults.reduction !== undefined) {
            const input = document.getElementById('param-power-delta');
            if (input) input.value = defaults.reduction;
        }

        runSimulation(recommendation.cellName, recommendation.simAction);
    }, 100);
};

// --- Action Simulator ---
function renderActionPanel(cellName) {
    const panel = document.getElementById('action-panel');
    const select = document.getElementById('action-select');
    const runBtn = document.getElementById('action-run');
    const result = document.getElementById('action-result');
    if (!panel || !select || !runBtn || !result) return;

    // Also render recommendations
    renderRecommendationsPanel(cellName);

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
        result.innerHTML = `<div class="action-hint">Cell: ${escapeHtml(cellName)} (healthy - simulation for testing)</div>`;
    }
    buildActionParamsUI(select.value || '');
}

function buildActionParamsUI(action) {
    const container = document.getElementById('action-params');
    if (!container) return;
    if (!action) {
        container.innerHTML = '<div class="action-hint">Choisir une action pour estimer l\'impact.</div>';
        return;
    }

    // Get action info for timeline/recovery display
    const actionInfo = ACTION_UI_METADATA[action];
    const infoBox = actionInfo ? `
        <div class="action-info-box">
            <span class="timeline-badge ${actionInfo.timeline}">${
                actionInfo.timeline === 'court_terme' ? '⚡ Court terme' :
                actionInfo.timeline === 'moyen_terme' ? '📅 Moyen terme' : '🏗️ Long terme'
            }</span>
            <span class="recovery-badge">↑${Math.round(actionInfo.recoveryRate)}% récup.</span>
            ${actionInfo.capex ? '<span class="capex-badge">💰 CAPEX</span>' : '<span class="opex-badge">OPEX</span>'}
        </div>
        <div class="action-effect">${actionInfo.effect}</div>
    ` : '';

    if (action === 'tilt') {
        container.innerHTML = sanitizeRichHtml(`${infoBox}
            <label class="action-label" for="param-tilt-deg">Downtilt (degrés)</label>
            <input type="number" id="param-tilt-deg" class="action-input" value="2" min="-5" max="10" step="0.5">
            <div class="action-hint">Positif = downtilt, Négatif = uptilt</div>
        `);
        return;
    }

    if (action === 'power') {
        container.innerHTML = sanitizeRichHtml(`${infoBox}
            <label class="action-label" for="param-power-delta">Réduction puissance (dB)</label>
            <input type="number" id="param-power-delta" class="action-input" value="3" min="0" max="10" step="1">
            <div class="action-hint">Réduction Tx Power en dB (0 = pas de changement)</div>
        `);
        return;
    }

    if (action === 'add_carrier') {
        const bands = (state.globalStats?.frequency_bands || []).map(String);
        const options = bands.length
            ? bands.map(b => `<option value="${escapeHtml(b)}">Bande ${escapeHtml(b)}</option>`).join('')
            : '<option value="">Aucune bande disponible</option>';
        container.innerHTML = sanitizeRichHtml(`${infoBox}
            <label class="action-label" for="param-carrier-band">Sélectionner bande</label>
            <select id="param-carrier-band" class="action-input">${options}</select>
            <div class="action-hint">Active Carrier Aggregation si bande non présente sur site.</div>
        `);
        return;
    }

    if (action === 'redistribute') {
        container.innerHTML = sanitizeRichHtml(`${infoBox}
            <label class="action-label" for="param-redistribute-target">Cellule cible (optionnel)</label>
            <input type="text" id="param-redistribute-target" class="action-input" placeholder="nom cellule voisine">
            <label class="action-label" for="param-redistribute-ratio">Ratio redistribution (0-0.6)</label>
            <input type="number" id="param-redistribute-ratio" class="action-input" value="0.2" min="0" max="0.6" step="0.05">
            <div class="action-hint">MLB: équilibrage charge vers voisins moins chargés</div>
        `);
        return;
    }

    if (action === 'parameter_tuning') {
        container.innerHTML = sanitizeRichHtml(`${infoBox}
            <label class="action-label" for="param-cio">Cell Individual Offset (dB)</label>
            <input type="number" id="param-cio" class="action-input" value="-3" min="-6" max="6" step="1">
            <label class="action-label" for="param-hysteresis">Hysteresis (dB)</label>
            <input type="number" id="param-hysteresis" class="action-input" value="2" min="0" max="6" step="1">
            <div class="action-hint">CIO négatif = repousse UE vers voisins</div>
        `);
        return;
    }

    if (action === 'mimo_upgrade') {
        container.innerHTML = sanitizeRichHtml(`${infoBox}
            <label class="action-label" for="param-mimo-target">Configuration MIMO cible</label>
            <select id="param-mimo-target" class="action-input">
                <option value="4T4R">4T4R (Recommandé)</option>
                <option value="8T8R">8T8R (Massive MIMO)</option>
            </select>
            <div class="action-hint">Upgrade antenne pour meilleure efficacité spectrale</div>
        `);
        return;
    }

    if (action === 'small_cell') {
        container.innerHTML = sanitizeRichHtml(`${infoBox}
            <label class="action-label" for="param-sc-type">Type Small Cell</label>
            <select id="param-sc-type" class="action-input">
                <option value="micro">Micro outdoor</option>
                <option value="femto">Femto indoor</option>
                <option value="pico">Pico hotspot</option>
            </select>
            <div class="action-hint">Déploiement capacité locale ciblée</div>
        `);
        return;
    }

    if (action === 'add_sector') {
        container.innerHTML = sanitizeRichHtml(`${infoBox}
            <label class="action-label">Configuration actuelle</label>
            <div class="action-static">3 secteurs → 4 secteurs</div>
            <div class="action-hint">Sectorisation: +33% capacité site</div>
        `);
        return;
    }

    if (action === 'add_site') {
        container.innerHTML = sanitizeRichHtml(`${infoBox}
            <label class="action-label" for="param-site-type">Type de site</label>
            <select id="param-site-type" class="action-input">
                <option value="macro">Macro capacitaire</option>
                <option value="rooftop">Rooftop urbain</option>
            </select>
            <div class="action-hint">Nouveau site pour absorber trafic zone congestionnée</div>
        `);
        return;
    }

    if (action === 'split_cell') {
        container.innerHTML = sanitizeRichHtml(`${infoBox}
            <label class="action-label">Cell Split</label>
            <div class="action-static">1 cellule → 2 cellules</div>
            <div class="action-hint">Subdivision cellule haute charge en 2+ cellules</div>
        `);
        return;
    }

    container.innerHTML = sanitizeRichHtml(`${infoBox}<div class="action-hint">Action: ${escapeHtml(actionInfo?.name || action)}</div>`);
}

function collectActionParams(action) {
    if (action === 'tilt') {
        const deg = Number(document.getElementById('param-tilt-deg')?.value || 0);
        return { degrees: deg };
    }
    if (action === 'power') {
        const reduction = Number(document.getElementById('param-power-delta')?.value || 0);
        return { reduction: Math.max(0, Math.min(10, reduction)) };
    }
    if (action === 'redistribute') {
        const target = document.getElementById('param-redistribute-target')?.value || '';
        const ratio = Number(document.getElementById('param-redistribute-ratio')?.value || 0.2);
        return { target: target || undefined, ratio: Math.max(0, Math.min(0.6, ratio)) };
    }
    if (action === 'add_carrier') {
        const band = document.getElementById('param-carrier-band')?.value;
        return { band: band || undefined };
    }
    if (action === 'parameter_tuning') {
        const cio = Number(document.getElementById('param-cio')?.value || 0);
        const hysteresis = Number(document.getElementById('param-hysteresis')?.value || 0);
        return {
            cio: Math.max(-6, Math.min(6, cio)),
            hysteresis: Math.max(0, Math.min(6, hysteresis)),
        };
    }
    if (action === 'mimo_upgrade') {
        const targetMimo = document.getElementById('param-mimo-target')?.value || '4T4R';
        return { targetMimo };
    }
    if (action === 'small_cell') {
        const type = document.getElementById('param-sc-type')?.value || 'micro';
        return { type };
    }
    if (action === 'add_site') {
        const siteType = document.getElementById('param-site-type')?.value || 'macro';
        return { siteType };
    }
    if (action === 'add_sector') {
        return { targetSectors: 4 };
    }
    if (action === 'split_cell') {
        return { newCellCount: 2 };
    }
    return {};
}

function displaySimulationResults(result) {
    const container = document.getElementById('action-result');
    if (!container) return;
    if (result.error) {
        container.innerHTML = '<div class="action-error"></div>';
        const errorEl = container.querySelector('.action-error');
        if (errorEl) errorEl.textContent = result.error;
        return;
    }

    const before = result.before || {};
    const after = result.after || {};
    const impact = result.impact || {};
    const action = result.action || '';
    const defaultConfidence = action === 'redistribute' ? 0.55 : 0.65;
    const confidence = result.confidence ?? defaultConfidence;
    const confidencePct = Math.round(confidence * 100);
    const modeLabel = '⚡ Fast';

    const neighbors = (impact.affected_cells || []).map(n => {
        const delta = n.load_change ?? n.change ?? 0;
        return { name: n.name || n.cell_name, delta };
    }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 12);
    const neighborsText = neighbors.length
        ? `Neighbors affected: ${neighbors.map(c => `${escapeHtml(c.name)} (${escapeHtml(formatNumber(c.delta))}%)`).join(', ')}${impact.affected_cells.length > neighbors.length ? ', …more' : ''}`
        : '';

    container.innerHTML = sanitizeRichHtml(`
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
        <div class="action-reco">${escapeHtml(result.recommendation || '')}</div>
        ${neighborsText ? `<div class="action-affected">${neighborsText}</div>` : ''}
    `);
}

async function runSimulation(cellName, action) {
    const resultEl = document.getElementById('action-result');
    const runBtn = document.getElementById('action-run');
    
    console.log('Running simulation:', { cellName, action });
    
    if (!cellName || !action) {
        if (resultEl) resultEl.innerHTML = '<div class="action-error">Select a cell and an action.</div>';
        return;
    }

    const params = collectActionParams(action);
    const timeEntry = state.timeIndex[state.currentTimeIndex] || {};
    const mode = 'fast'; // fast estimator only

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
            if (resultEl) resultEl.innerHTML = `<div class="action-error">Site ${escapeHtml(siteName)} already has Band ${escapeHtml(params.band)}.</div>`;
            return;
        }
    }

    try {
        // Update UI for loading state (fast only)
        const loadingMsg = '<div class="action-hint">⚡ Simulating... (queued)</div>';
        if (resultEl) resultEl.innerHTML = loadingMsg;
        if (runBtn) {
            runBtn.disabled = true;
            runBtn.innerHTML = '<span class="material-symbols-outlined">hourglass_top</span> Running...';
        }

        const requestBody = { cell_name: cellName, action, params, time_entry: timeEntry, mode };
        let lastStatusLabel = '';
        const queued = await enqueueJob('simulate', requestBody);
        const statusPayload = await waitForJobResult(queued.jobId, {
            pollIntervalMs: 3000,
            timeoutMs: 120000,
            onStatus: (statusLabel) => {
                if (!resultEl || statusLabel === lastStatusLabel) return;
                lastStatusLabel = statusLabel;
                resultEl.innerHTML = `<div class="action-hint">⚡ Simulating... (${escapeHtml(statusLabel)})</div>`;
            }
        });
        const payload = statusPayload?.result || null;

        if (!payload || typeof payload !== 'object') {
            throw new Error('Simulation returned invalid payload');
        }

        displaySimulationResults(payload);
    } catch (err) {
        if (resultEl) resultEl.innerHTML = `<div class="action-error">Simulation failed: ${escapeHtml(err.message)}</div>`;
    } finally {
        if (runBtn) {
            runBtn.disabled = false;
            runBtn.innerHTML = '<span class="material-symbols-outlined">play_arrow</span> Run Simulation';
        }
    }
}

window.toggleAntennaDropdown = (siteName, antennaId) => {
    const safeSite = String(siteName || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeAntenna = String(antennaId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    const el = document.getElementById(`antenna-cells-${safeSite}-${safeAntenna}`);
    const icon = document.getElementById(`expand-icon-${safeSite}-${safeAntenna}`);
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
        const popupRoot = document.createElement('div');
        popupRoot.className = 'cell-popup';

        const popupHeader = document.createElement('div');
        popupHeader.className = 'cell-popup-header';
        popupHeader.style.borderLeft = `4px solid ${p.color}`;
        popupHeader.textContent = p.cell_name;

        const popupBody = document.createElement('div');
        popupBody.className = 'cell-popup-body';
        const rows = [
            ['Site', p.site_name],
            ['Antenna', String(p.antenna_id || '').toUpperCase()],
            ['Band', p.band],
            ['Local ID', p.localcell_id],
            ['Load', `${formatNumber(p.load)}%`],
            ['CQI', formatNumber(p.cqi)],
            ['Throughput', formatThroughput(p.throughput)],
        ];
        rows.forEach(([label, value]) => {
            const row = document.createElement('div');
            row.className = 'popup-row';
            if (label === 'CQI' && p.has_low_cqi) {
                row.classList.add('text-danger');
            }
            const labelEl = document.createElement('span');
            labelEl.textContent = label;
            const valueEl = document.createElement('span');
            valueEl.textContent = value;
            row.appendChild(labelEl);
            row.appendChild(valueEl);
            popupBody.appendChild(row);
        });

        popupRoot.appendChild(popupHeader);
        popupRoot.appendChild(popupBody);
        state.popup
            .setLngLat(feature.geometry.coordinates)
            .setDOMContent(popupRoot)
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
    const visiblePointIds = new Set(points.map(p => p.id));
    const sectors = state.sectorFeatures.filter(f => visiblePointIds.has(f.id));
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
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = id;
        checkbox.dataset.band = String(b);
        checkbox.checked = true;
        const checkmark = document.createElement('span');
        checkmark.className = 'checkmark';
        const labelText = document.createElement('span');
        labelText.textContent = `Band ${b}`;
        wrapper.appendChild(checkbox);
        wrapper.appendChild(checkmark);
        wrapper.appendChild(labelText);
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
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = safeId;
        checkbox.dataset.issue = String(type);
        checkbox.checked = true;
        const checkmark = document.createElement('span');
        checkmark.className = 'checkmark';
        const labelText = document.createElement('span');
        labelText.textContent = String(type);
        wrapper.appendChild(checkbox);
        wrapper.appendChild(checkmark);
        wrapper.appendChild(labelText);
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

// --- Data Exploration ---
const exploreCharts = { main: null, timeline: null };

function computeExploreData(duration, metric) {
    const data = state.timeIndex;
    if (!data || data.length === 0) return { labels: [], values: [], insights: {} };

    if (duration === 'hour') {
        // Aggregate by hour of day (0-23)
        const hourBuckets = Array(24).fill(null).map(() => []);
        data.forEach(entry => {
            const ts = entry.timestamp || '';
            const match = ts.match(/(\d{2}):(\d{2})$/);
            if (match) {
                const hour = parseInt(match[1], 10);
                const val = entry.stats?.[metric] ?? 0;
                hourBuckets[hour].push(val);
            }
        });
        const labels = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
        const values = hourBuckets.map(arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
        
        // Find peak hours
        const sorted = values.map((v, i) => ({ hour: i, value: v })).sort((a, b) => b.value - a.value);
        const peakHours = sorted.slice(0, 3).map(p => `${String(p.hour).padStart(2, '0')}:00`);
        const offPeakHours = sorted.slice(-3).map(p => `${String(p.hour).padStart(2, '0')}:00`);
        
        return {
            labels,
            values,
            insights: {
                peakHours,
                offPeakHours,
                maxValue: Math.max(...values),
                avgValue: values.reduce((a, b) => a + b, 0) / 24
            }
        };
    }

    if (duration === 'day') {
        // Aggregate by day
        const dayBuckets = {};
        data.forEach(entry => {
            const ts = entry.timestamp || '';
            const match = ts.match(/^(\d{2}-\d{2}-\d{4})/);
            if (match) {
                const day = match[1];
                if (!dayBuckets[day]) dayBuckets[day] = [];
                dayBuckets[day].push(entry.stats?.[metric] ?? 0);
            }
        });
        const days = Object.keys(dayBuckets).sort((a, b) => {
            const [da, ma, ya] = a.split('-').map(Number);
            const [db, mb, yb] = b.split('-').map(Number);
            return new Date(ya, ma - 1, da) - new Date(yb, mb - 1, db);
        });
        const labels = days;
        const values = days.map(d => {
            const arr = dayBuckets[d];
            return arr.reduce((a, b) => a + b, 0) / arr.length;
        });
        
        const maxIdx = values.indexOf(Math.max(...values));
        const minIdx = values.indexOf(Math.min(...values));
        
        return {
            labels,
            values,
            insights: {
                worstDay: labels[maxIdx],
                bestDay: labels[minIdx],
                maxValue: values[maxIdx],
                minValue: values[minIdx],
                avgValue: values.reduce((a, b) => a + b, 0) / values.length
            }
        };
    }

    if (duration === 'week') {
        // Aggregate by week (day of week)
        const weekDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const weekBuckets = Array(7).fill(null).map(() => []);
        data.forEach(entry => {
            const ts = entry.timestamp || '';
            const match = ts.match(/^(\d{2})-(\d{2})-(\d{4})/);
            if (match) {
                const [, d, m, y] = match;
                const date = new Date(Number(y), Number(m) - 1, Number(d));
                const dow = date.getDay();
                weekBuckets[dow].push(entry.stats?.[metric] ?? 0);
            }
        });
        const labels = weekDays;
        const values = weekBuckets.map(arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
        
        const maxIdx = values.indexOf(Math.max(...values));
        const minIdx = values.indexOf(Math.min(...values));
        
        return {
            labels,
            values,
            insights: {
                worstDay: weekDays[maxIdx],
                bestDay: weekDays[minIdx],
                maxValue: values[maxIdx],
                minValue: values[minIdx]
            }
        };
    }

    if (duration === 'all') {
        const arr = data.map(entry => entry.stats?.[metric] ?? 0);
        const total = arr.reduce((a, b) => a + b, 0);
        const avg = arr.length ? total / arr.length : 0;
        const maxValue = arr.length ? Math.max(...arr) : 0;
        const minValue = arr.length ? Math.min(...arr) : 0;
        return {
            labels: ['All time total'],
            values: [total],
            insights: { total, avgValue: avg, maxValue, minValue, samples: arr.length }
        };
    }

    return { labels: [], values: [], insights: {} };
}

function computeTimelineData(metric) {
    // Show congestion over time (all data points)
    const data = state.timeIndex;
    const labels = data.map(e => e.timestamp || '');
    const values = data.map(e => e.stats?.[metric] ?? 0);
    return { labels, values };
}

function renderExploreCharts() {
    const duration = document.getElementById('explore-duration')?.value || 'hour';
    const metric = document.getElementById('explore-metric')?.value || 'congested';
    
    const metricLabels = {
        congested: 'Congested Cells',
        avg_load: 'Average Load (%)',
        avg_cqi: 'Average CQI',
        congestion_rate: 'Congestion Rate (%)'
    };
    
    const durationLabels = {
        hour: 'Peak Hours Analysis',
        day: 'Daily Trends',
        week: 'Weekly Pattern',
        all: 'All Time Overview'
    };
    
    const titleEl = document.getElementById('explore-chart-title');
    if (titleEl) titleEl.textContent = durationLabels[duration] || 'Analysis';
    
    const mainCtx = document.getElementById('chart-explore-main');
    const timelineCtx = document.getElementById('chart-explore-timeline');
    if (!mainCtx || !timelineCtx) return;
    
    // Destroy old charts
    if (exploreCharts.main) { exploreCharts.main.destroy(); exploreCharts.main = null; }
    if (exploreCharts.timeline) { exploreCharts.timeline.destroy(); exploreCharts.timeline = null; }
    
    const { labels, values, insights } = computeExploreData(duration, metric);
    const timeline = computeTimelineData(metric);
    
    // Main chart
    const isBar = duration === 'hour' || duration === 'all';

    exploreCharts.main = new Chart(mainCtx, {
        type: isBar ? 'bar' : 'line',
        data: {
            labels,
            datasets: [{
                label: metricLabels[metric],
                data: values,
                backgroundColor: duration === 'hour' 
                    ? values.map((v) => {
                        const max = Math.max(...values);
                        return v >= max * 0.9 ? '#FF7900' : v >= max * 0.7 ? '#FFB74D' : '#42A5F5';
                    })
                    : duration === 'all'
                        ? '#FF7900'
                        : 'rgba(255, 121, 0, 0.3)',
                borderColor: '#FF7900',
                borderWidth: 2,
                fill: !isBar,
                tension: 0.3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { 
                    callbacks: {
                        label: (ctx) => `${metricLabels[metric]}: ${ctx.raw.toFixed(2)}`
                    }
                }
            },
            scales: {
                y: { beginAtZero: true, grid: { color: '#333' }, ticks: { color: '#ccc' } },
                x: { grid: { display: false }, ticks: { color: '#ccc', maxRotation: 45 } }
            }
        }
    });
    
    // Timeline chart (sampled for performance)
    const step = Math.max(1, Math.floor(timeline.labels.length / 100));
    const sampledLabels = timeline.labels.filter((_, i) => i % step === 0);
    const sampledValues = timeline.values.filter((_, i) => i % step === 0);
    
    exploreCharts.timeline = new Chart(timelineCtx, {
        type: 'line',
        data: {
            labels: sampledLabels,
            datasets: [{
                label: metricLabels[metric],
                data: sampledValues,
                borderColor: '#42A5F5',
                backgroundColor: 'rgba(66, 165, 245, 0.2)',
                borderWidth: 1.5,
                fill: true,
                tension: 0.2,
                pointRadius: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: { beginAtZero: true, grid: { color: '#333' }, ticks: { color: '#ccc' } },
                x: { display: false }
            }
        }
    });
    
    // Insights
    const insightsEl = document.getElementById('explore-insights');
    if (insightsEl) {
        let html = '<div class="insights-grid">';
        if (duration === 'hour' && insights.peakHours) {
            html += `
                <div class="insight-card insight-warning">
                    <span class="material-symbols-outlined">trending_up</span>
                    <div>
                        <div class="insight-label">Peak Hours (Heures de Pointe)</div>
                        <div class="insight-value">${insights.peakHours.join(', ')}</div>
                    </div>
                </div>
                <div class="insight-card insight-success">
                    <span class="material-symbols-outlined">trending_down</span>
                    <div>
                        <div class="insight-label">Off-Peak Hours</div>
                        <div class="insight-value">${insights.offPeakHours.join(', ')}</div>
                    </div>
                </div>
                <div class="insight-card">
                    <span class="material-symbols-outlined">analytics</span>
                    <div>
                        <div class="insight-label">Average</div>
                        <div class="insight-value">${insights.avgValue.toFixed(2)}</div>
                    </div>
                </div>
            `;
        } else if (duration === 'day' || duration === 'week') {
            html += `
                <div class="insight-card insight-warning">
                    <span class="material-symbols-outlined">warning</span>
                    <div>
                        <div class="insight-label">Worst ${duration === 'week' ? 'Day' : 'Date'}</div>
                        <div class="insight-value">${insights.worstDay || '-'} (${(insights.maxValue || 0).toFixed(2)})</div>
                    </div>
                </div>
                <div class="insight-card insight-success">
                    <span class="material-symbols-outlined">check_circle</span>
                    <div>
                        <div class="insight-label">Best ${duration === 'week' ? 'Day' : 'Date'}</div>
                        <div class="insight-value">${insights.bestDay || '-'} (${(insights.minValue || 0).toFixed(2)})</div>
                    </div>
                </div>
            `;
        } else if (duration === 'all') {
            html += `
                <div class="insight-card insight-warning">
                    <span class="material-symbols-outlined">dns</span>
                    <div>
                        <div class="insight-label">Total (all time)</div>
                        <div class="insight-value">${(insights.total || 0).toFixed(0)}</div>
                    </div>
                </div>
                <div class="insight-card">
                    <span class="material-symbols-outlined">analytics</span>
                    <div>
                        <div class="insight-label">Average per snapshot</div>
                        <div class="insight-value">${(insights.avgValue || 0).toFixed(2)}</div>
                    </div>
                </div>
                <div class="insight-card">
                    <span class="material-symbols-outlined">trending_up</span>
                    <div>
                        <div class="insight-label">Max in a snapshot</div>
                        <div class="insight-value">${(insights.maxValue || 0).toFixed(2)}</div>
                    </div>
                </div>
                <div class="insight-card">
                    <span class="material-symbols-outlined">trending_down</span>
                    <div>
                        <div class="insight-label">Min in a snapshot</div>
                        <div class="insight-value">${(insights.minValue || 0).toFixed(2)}</div>
                    </div>
                </div>
            `;
        }
        html += '</div>';
        insightsEl.innerHTML = html;
    }
}

function setupExploreModal() {
    document.getElementById('btn-explore')?.addEventListener('click', () => {
        toggleModal('explore-modal', true);
        renderExploreCharts();
    });
    document.getElementById('explore-close')?.addEventListener('click', () => toggleModal('explore-modal', false));
    document.getElementById('explore-refresh')?.addEventListener('click', renderExploreCharts);
    document.getElementById('explore-duration')?.addEventListener('change', renderExploreCharts);
    document.getElementById('explore-metric')?.addEventListener('change', renderExploreCharts);
}

// --- Forecast Mode (Unified Timeline) ---
const forecastState = {
    forecastIndex: [],
    isGenerating: false,
    available: false
};

// Unified timeline state
const unifiedTimeline = {
    historicalCount: 0,
    forecastCount: 0,
    totalCount: 0,
    currentIndex: 0,
    dividerIndex: 0  // Where historical ends and forecast begins
};
let activeSliceAbortController = null;
let activeSliceRequestId = 0;

async function checkForecastAvailability() {
    try {
        const res = await fetchWithAuth('/api/forecast');
        const data = await res.json();
        forecastState.available = data.available;
        if (data.available && data.forecasts) {
            forecastState.forecastIndex = data.forecasts;
            updateUnifiedTimeline();
        } else {
            forecastState.forecastIndex = [];
            updateUnifiedTimeline();
        }
        return data;
    } catch (err) {
        console.warn('Could not check forecast availability:', err);
        forecastState.forecastIndex = [];
        return { available: false };
    }
}

function updateUnifiedTimeline() {
    unifiedTimeline.historicalCount = state.timeIndex.length;
    unifiedTimeline.forecastCount = forecastState.forecastIndex.length;
    unifiedTimeline.totalCount = unifiedTimeline.historicalCount + unifiedTimeline.forecastCount;
    unifiedTimeline.dividerIndex = unifiedTimeline.historicalCount;
    unifiedTimeline.currentIndex = Math.min(
        unifiedTimeline.currentIndex,
        Math.max(0, unifiedTimeline.totalCount - 1)
    );
    
    // Update slider
    const slider = document.getElementById('time-slider');
    if (slider && unifiedTimeline.totalCount > 0) {
        slider.max = unifiedTimeline.totalCount - 1;
    }
    
    // Update track colors (historical vs forecast)
    updateSliderTrack();
    
    // Update labels
    updateTimelineLabels();
}

function updateSliderTrack() {
    const trackHistorical = document.getElementById('track-historical');
    const trackForecast = document.getElementById('track-forecast');
    
    if (!trackHistorical || !trackForecast) return;
    
    const total = unifiedTimeline.totalCount || 1;
    const historicalPct = (unifiedTimeline.historicalCount / total) * 100;
    const forecastPct = (unifiedTimeline.forecastCount / total) * 100;
    
    trackHistorical.style.width = `${historicalPct}%`;
    trackForecast.style.width = `${forecastPct}%`;
    
    // Show/hide forecast track
    if (unifiedTimeline.forecastCount > 0) {
        trackForecast.classList.add('visible');
    } else {
        trackForecast.classList.remove('visible');
    }
}

function updateTimelineLabels() {
    const startLabel = document.getElementById('time-start-label');
    const endLabel = document.getElementById('time-end-label');
    
    // Start label from historical
    if (startLabel && state.timeIndex.length > 0) {
        startLabel.textContent = state.timeIndex[0]?.timestamp || '--';
    }
    
    // End label from forecast (if available) or historical
    if (endLabel) {
        if (forecastState.forecastIndex.length > 0) {
            endLabel.textContent = forecastState.forecastIndex[forecastState.forecastIndex.length - 1]?.timestamp || '--';
        } else if (state.timeIndex.length > 0) {
            endLabel.textContent = state.timeIndex[state.timeIndex.length - 1]?.timestamp || '--';
        }
    }
}

function isInForecastRange(index) {
    return index >= unifiedTimeline.dividerIndex;
}

function getDataForIndex(index) {
    if (isInForecastRange(index)) {
        const forecastIndex = index - unifiedTimeline.dividerIndex;
        return {
            type: 'forecast',
            entry: forecastState.forecastIndex[forecastIndex],
            localIndex: forecastIndex
        };
    } else {
        return {
            type: 'historical',
            entry: state.timeIndex[index],
            localIndex: index
        };
    }
}

async function loadUnifiedTimeSlice(index) {
    if (index < 0 || index >= unifiedTimeline.totalCount) return;
    
    if (activeSliceAbortController) {
        activeSliceAbortController.abort();
    }
    activeSliceAbortController = new AbortController();
    const requestId = ++activeSliceRequestId;
    const { signal } = activeSliceAbortController;

    unifiedTimeline.currentIndex = index;
    const data = getDataForIndex(index);
    
    if (data.type === 'forecast') {
        await loadForecastSliceInternal(data.entry, data.localIndex, { signal, requestId });
    } else {
        await loadHistoricalSliceInternal(data.entry, data.localIndex, { signal, requestId });
    }

    if (signal.aborted || requestId !== activeSliceRequestId) return;
    
    // Update slider position
    const slider = document.getElementById('time-slider');
    if (slider) slider.value = index;
}

async function loadHistoricalSliceInternal(timeEntry, localIndex, requestContext = {}) {
    if (!timeEntry) return;
    const { signal, requestId } = requestContext;
    
    try {
        const res = await fetchWithAuth(`${buildDataUrl('time_data', timeEntry.filename)}?t=${Date.now()}`, { signal });
        const sliceData = await res.json();
        if (!res.ok) {
            throw new Error(sliceData.error || `HTTP error ${res.status}`);
        }
        if (signal?.aborted || requestId !== activeSliceRequestId) return;
        
        state.currentTimeIndex = localIndex;
        warnIfObservationSchemaMismatch(sliceData.observations, `historical slice ${timeEntry.timestamp || timeEntry.filename}`);
        state.currentObservations = sliceData.observations;
        state.currentStats = sliceData.stats;
        
        const { pointFeatures, sectorFeatures } = buildFeaturesForTime(sliceData.observations);
        state.pointFeatures = pointFeatures;
        state.sectorFeatures = sectorFeatures;
        state.features = pointFeatures;
        applyFilters();
        
        updateTimeSliderUI();
        updateStatsUI(sliceData.stats);
        updateAlertsUI(state.filteredPointFeatures);
        
        if (state.selectedSite) {
            showSiteInfoPanel(state.selectedSite);
        }
    } catch (err) {
        if (err?.name === 'AbortError') return;
        console.error('Failed to load historical slice:', err);
    }
}

async function loadForecastSliceInternal(forecastEntry, localIndex, requestContext = {}) {
    if (!forecastEntry) return;
    const { signal, requestId } = requestContext;
    
    try {
        const res = await fetchWithAuth(`${buildDataUrl('forecast_data', forecastEntry.filename)}?t=${Date.now()}`, { signal });
        const sliceData = await res.json();
        if (!res.ok) {
            throw new Error(sliceData.error || `HTTP error ${res.status}`);
        }
        if (signal?.aborted || requestId !== activeSliceRequestId) return;
        
        warnIfObservationSchemaMismatch(sliceData.observations || {}, `forecast slice ${forecastEntry.timestamp || forecastEntry.filename}`);
        state.currentObservations = sliceData.observations || {};
        state.currentStats = sliceData.stats || forecastEntry.stats;
        
        const { pointFeatures, sectorFeatures } = buildFeaturesForTime(sliceData.observations || {});
        
        // Mark features as forecast
        const confidence = sliceData.confidence || forecastEntry.confidence || 0.75;
        pointFeatures.forEach(f => {
            f.properties.is_forecast = true;
            f.properties.confidence = confidence;
        });
        sectorFeatures.forEach(f => {
            f.properties.is_forecast = true;
        });
        
        state.pointFeatures = pointFeatures;
        state.sectorFeatures = sectorFeatures;
        state.features = pointFeatures;
        applyFilters();
        
        updateTimeSliderUI();
        updateStatsUI(sliceData.stats || forecastEntry.stats);
        updateAlertsUI(state.filteredPointFeatures);
        
        if (state.selectedSite) {
            showSiteInfoPanel(state.selectedSite);
        }
    } catch (err) {
        if (err?.name === 'AbortError') return;
        console.error('Failed to load forecast slice:', err);
        showNotification('Failed to load forecast data', 'error');
    }
}

async function generateForecast() {
    if (forecastState.isGenerating) return;
    
    const btn = document.getElementById('btn-generate-forecast');
    const daysInput = document.getElementById('forecast-days');
    const parsedDays = daysInput ? parseInt(daysInput.value, 10) : 7;
    const days = Number.isFinite(parsedDays) ? Math.max(1, Math.min(30, parsedDays)) : 7;
    if (daysInput) daysInput.value = String(days);
    const originalHtml = btn?.innerHTML;
    
    try {
        forecastState.isGenerating = true;
        if (btn) {
            btn.disabled = true;
            btn.classList.add('generating');
            btn.innerHTML = '<span class="material-symbols-outlined">sync</span> Generating... (queued)';
        }

        let lastStatusLabel = '';
        const queued = await enqueueJob('forecast', { days });
        const statusPayload = await waitForJobResult(queued.jobId, {
            pollIntervalMs: 3000,
            timeoutMs: 180000,
            onStatus: (statusLabel) => {
                if (!btn || statusLabel === lastStatusLabel) return;
                lastStatusLabel = statusLabel;
                btn.innerHTML = `<span class="material-symbols-outlined">sync</span> Generating... (${escapeHtml(statusLabel)})`;
            }
        });
        const data = statusPayload?.result || null;

        if (data?.success) {
            // Reload forecast data and update unified timeline
            await checkForecastAvailability();
            showNotification(`Forecast for ${days} days generated! Slide right to view.`, 'success');
        } else {
            showNotification('Forecast generation failed: ' + (data?.error || 'Unknown error'), 'error');
        }
    } catch (err) {
        console.error('Forecast generation error:', err);
        showNotification('Forecast generation failed', 'error');
    } finally {
        forecastState.isGenerating = false;
        if (btn) {
            btn.disabled = false;
            btn.classList.remove('generating');
            btn.innerHTML = originalHtml || '<span class="material-symbols-outlined">model_training</span> Generate';
        }
    }
}

async function clearForecastDataByUser() {
    try {
        await fetchWithAuth('/api/forecast', { method: 'DELETE' });
        forecastState.forecastIndex = [];
        forecastState.available = false;
        updateUnifiedTimeline();
        const maxIndex = Math.max(0, unifiedTimeline.totalCount - 1);
        unifiedTimeline.currentIndex = Math.min(unifiedTimeline.currentIndex, maxIndex);
        await loadUnifiedTimeSlice(unifiedTimeline.currentIndex);
        showNotification('Forecast cleared', 'success');
    } catch (err) {
        console.error('Failed to clear forecast:', err);
        showNotification('Failed to clear forecast', 'error');
    }
}

function showNotification(message, type = 'info') {
    const existing = document.querySelector('.notification-toast');
    if (existing) existing.remove();
    
    const toast = document.createElement('div');
    toast.className = `notification-toast notification-${type}`;
    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined';
    icon.textContent = type === 'success' ? 'check_circle' : type === 'error' ? 'error' : 'info';
    const text = document.createElement('span');
    text.textContent = String(message ?? '');
    toast.appendChild(icon);
    toast.appendChild(text);
    document.body.appendChild(toast);
    
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

function setupUnifiedTimelineControls() {
    const slider = document.getElementById('time-slider');
    const prevBtn = document.getElementById('time-prev');
    const nextBtn = document.getElementById('time-next');
    const playBtn = document.getElementById('time-play');
    const generateBtn = document.getElementById('btn-generate-forecast');
    const clearBtn = document.getElementById('btn-clear-forecast');
    
    // Unified slider handler
    const debouncedLoad = debounce((val) => loadUnifiedTimeSlice(val), 100);
    
    slider?.addEventListener('input', (e) => {
        const val = parseInt(e.target.value, 10);
        debouncedLoad(val);
    });
    
    // Prev/Next buttons
    prevBtn?.addEventListener('click', () => {
        if (unifiedTimeline.currentIndex > 0) {
            loadUnifiedTimeSlice(unifiedTimeline.currentIndex - 1);
        }
    });
    
    nextBtn?.addEventListener('click', () => {
        if (unifiedTimeline.currentIndex < unifiedTimeline.totalCount - 1) {
            loadUnifiedTimeSlice(unifiedTimeline.currentIndex + 1);
        }
    });
    
    // Play button
    playBtn?.addEventListener('click', () => {
        state.isPlaying = !state.isPlaying;
        const icon = playBtn.querySelector('.material-symbols-outlined');
        
        if (state.isPlaying) {
            playBtn.classList.add('playing');
            if (icon) icon.textContent = 'pause';
            const interval = CONFIG.PLAY_INTERVAL_MS / Math.max(0.25, state.playSpeed);
            state.playInterval = setInterval(() => {
                if (unifiedTimeline.currentIndex < unifiedTimeline.totalCount - 1) {
                    loadUnifiedTimeSlice(unifiedTimeline.currentIndex + 1);
                } else {
                    loadUnifiedTimeSlice(0);  // Loop back
                }
            }, interval);
        } else {
            playBtn.classList.remove('playing');
            if (icon) icon.textContent = 'play_arrow';
            clearInterval(state.playInterval);
        }
    });
    
    // Generate button
    generateBtn?.addEventListener('click', generateForecast);
    clearBtn?.addEventListener('click', clearForecastDataByUser);
    
    updateUnifiedTimeline();
    loadUnifiedTimeSlice(Math.min(unifiedTimeline.currentIndex, Math.max(0, unifiedTimeline.totalCount - 1)));
}

// --- Time Navigation ---
async function loadTimeSlice(index) {
    // Use unified timeline instead
    loadUnifiedTimeSlice(index);
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
    // Update the current time label in the slider
    const data = getDataForIndex(unifiedTimeline.currentIndex);
    const isForecast = data.type === 'forecast';
    
    const currentLabel = document.getElementById('time-current-label');
    if (currentLabel && data.entry) {
        const label = isForecast 
            ? `${data.entry.timestamp} (Forecast)` 
            : data.entry.timestamp;
        currentLabel.textContent = label || '--';
    }
    
    const timestampEl = document.getElementById('timestamp');
    if (timestampEl && data.entry) {
        timestampEl.textContent = data.entry.timestamp || '--';
    }
}

function setupTimeControls() {
    // Time controls are now handled by setupUnifiedTimelineControls
    // This function just initializes labels
    const startLabel = document.getElementById('time-start-label');
    const endLabel = document.getElementById('time-end-label');
    
    if (startLabel && state.timeIndex.length > 0) {
        startLabel.textContent = state.timeIndex[0]?.timestamp || '--';
    }
    if (endLabel && state.timeIndex.length > 0) {
        endLabel.textContent = state.timeIndex[state.timeIndex.length - 1]?.timestamp || '--';
    }
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
    if (!alertsList) return;
    const congested = features.filter(f => f.properties.congested);
    
    const badge = document.getElementById('alert-count');
    if (badge) badge.textContent = String(congested.length);
    
    if (congested.length === 0) {
        alertsList.innerHTML = '<div class="alert-placeholder">✓ No active alerts</div>';
        return;
    }

    alertsList.innerHTML = '';
    const fragment = document.createDocumentFragment();
    congested.slice(0, CONFIG.MAX_ALERTS_RENDER).forEach((feature) => {
        const alertItem = document.createElement('div');
        alertItem.className = 'alert-item';
        alertItem.dataset.cellId = String(feature.properties.id ?? '');
        alertItem.dataset.cellName = String(feature.properties.cell_name ?? '');

        const icon = document.createElement('span');
        icon.className = 'material-symbols-outlined';
        icon.textContent = 'error';

        const content = document.createElement('div');
        content.className = 'alert-item-content';

        const title = document.createElement('div');
        title.className = 'alert-item-title';
        title.textContent = feature.properties.cell_name;

        const desc = document.createElement('div');
        desc.className = 'alert-item-desc';
        desc.textContent = `${feature.properties.issue_type} • Load: ${formatNumber(feature.properties.load)}%`;

        content.appendChild(title);
        content.appendChild(desc);
        alertItem.appendChild(icon);
        alertItem.appendChild(content);
        fragment.appendChild(alertItem);
    });
    alertsList.appendChild(fragment);

    // Make alerts clickable to navigate to the cell
    alertsList.querySelectorAll('.alert-item').forEach(item => {
        const cellName = item.dataset.cellName;
        if (cellName) {
            item.addEventListener('click', () => selectCell(cellName, true));
        }
    });
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
            glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
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
        const popupRoot = document.createElement('div');
        popupRoot.style.padding = '10px';
        popupRoot.style.fontFamily = 'Inter, sans-serif';
        popupRoot.style.minWidth = '180px';

        const title = document.createElement('div');
        title.style.fontWeight = '600';
        title.style.marginBottom = '6px';
        title.style.color = p.color;
        title.textContent = p.cell_name;

        const body = document.createElement('div');
        body.style.fontSize = '12px';
        body.style.color = '#a0aec0';
        [
            `Site: ${p.enodeb_name}`,
            `Load: ${formatNumber(p.load)}%`,
            `CQI: ${formatNumber(p.cqi)}`,
            `Status: ${p.status}`,
        ].forEach((line) => {
            const row = document.createElement('div');
            row.textContent = line;
            body.appendChild(row);
        });

        popupRoot.appendChild(title);
        popupRoot.appendChild(body);
        state.popup
            .setLngLat(e.lngLat)
            .setDOMContent(popupRoot)
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

    const legendToggle = document.getElementById('legend-toggle');
    const legendContent = document.getElementById('legend-content');
    if (legendToggle && legendContent) {
        legendToggle.addEventListener('click', () => {
            legendContent.classList.toggle('collapsed');
            const icon = legendToggle.querySelector('.material-symbols-outlined');
            if (icon) {
                icon.textContent = legendContent.classList.contains('collapsed') ? 'expand_more' : 'expand_less';
            }
        });
    }

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
            case 'd': e.preventDefault(); toggleModal('explore-modal', true); renderExploreCharts(); break;
            case 'e': e.preventDefault(); toggleModal('export-modal', true); break;
        }
    });

    // Data Exploration Modal
    setupExploreModal();
    
    // Unified Timeline Controls
    setupUnifiedTimelineControls();
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
            fetchWithAuth(`${buildDataUrl('baseline.json')}?t=${Date.now()}`),
            fetchWithAuth(`${buildDataUrl('time_index.json')}?t=${Date.now()}`),
            fetchWithAuth(`${buildDataUrl('stats.json')}?t=${Date.now()}`)
        ]);

        if (!baselineRes.ok || !timeIndexRes.ok) {
            throw new Error(`Data API request failed (${baselineRes.status}/${timeIndexRes.status}/${statsRes.status})`);
        }
        
        state.baseline = await baselineRes.json();
        const timeIndexData = await timeIndexRes.json();
        const timestamps = Array.isArray(timeIndexData?.timestamps) ? timeIndexData.timestamps : [];
        if (!timestamps.length) {
            throw new Error('Invalid time_index.json payload: missing timestamps array');
        }
        state.timeIndex = [...timestamps].sort((a, b) => parseTimestamp(a.timestamp) - parseTimestamp(b.timestamp));

        if (statsRes.ok) {
            state.globalStats = await statsRes.json();
        } else {
            const frequencyBands = Array.from(new Set(
                Object.values(state.baseline)
                    .map((cell) => Number(cell?.frequency_band))
                    .filter((band) => Number.isFinite(band))
            )).sort((a, b) => a - b);

            state.globalStats = {
                total_timestamps: state.timeIndex.length,
                total_cells: Object.keys(state.baseline).length,
                frequency_bands: frequencyBands,
            };
            console.warn(`stats.json unavailable (${statsRes.status}); using fallback global stats`);
        }
        buildSiteHierarchy();

        populateFrequencyFilters(state.globalStats?.frequency_bands || []);
        
        console.log(`Loaded ${Object.keys(state.baseline).length} cells, ${state.timeIndex.length} time slices`);
        
        // Initialize unified timeline with historical data first
        unifiedTimeline.historicalCount = state.timeIndex.length;
        unifiedTimeline.totalCount = state.timeIndex.length;
        unifiedTimeline.dividerIndex = state.timeIndex.length;
        
        setLoading(true, 'Loading initial time slice...');
        
        // Load first slice using unified system
        await loadUnifiedTimeSlice(0);
        
        setLoading(true, 'Initializing map...');
        
        const { pointFeatures, sectorFeatures, sites } = buildFeaturesForTime(state.currentObservations);
        state.pointFeatures = pointFeatures;
        state.sectorFeatures = sectorFeatures;
        state.filteredPointFeatures = pointFeatures;
        state.filteredSectorFeatures = sectorFeatures;
        
        const map = initMap();
        
        map.on('load', () => {
            try {
                addMapLayers(map, sites);
                setupMapInteractions(map);
                
                if (pointFeatures.length > 0) {
                    const bounds = new maplibregl.LngLatBounds();
                    pointFeatures.forEach(f => bounds.extend(f.geometry.coordinates));
                    map.fitBounds(bounds, { padding: 50, maxZoom: 13 });
                }
            } catch (e) {
                console.error('Map load error:', e);
            } finally {
                setLoading(false);
            }
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
