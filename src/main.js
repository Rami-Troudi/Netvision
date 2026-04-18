import maplibregl from 'maplibre-gl';
import { destination } from '@turf/turf';
import Chart from 'chart.js/auto';
import { parseTimestampValue } from './utils/timestampParsing';
import { buildFeatureUpdateMapFromPayload } from './utils/featureUpdateContract';

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
    HEATMAP_OPACITY: 0.8,
    PLAY_INTERVAL_MS: 500,
    SECTOR_ARC_STEPS_DEFAULT: 16,
    SECTOR_ARC_STEPS_PLAYBACK: 6,

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

const IMPORT_REALISM_POLICY = Object.freeze({
    strictScopeToReference: true,
    strictNoFallback: false,
    hideSectorsWithoutTa: true,
});

// --- State Management ---
const state = {
    baseline: {},
    timeIndex: [],
    currentTimeIndex: 0,
    currentObservations: {},
    currentStats: null,
    globalStats: null,
    peakHoursByCell: {},
    driftByCell: {},
    driftAlerts: [],
    driftThresholds: {
        absPrbDelta: 15,
        pctPrbDelta: 30,
    },
    customDataset: {
        active: false,
        sessionId: '',
        createdAt: '',
        importedFiles: [],
        slices: [],
        realismPolicy: { ...IMPORT_REALISM_POLICY },
        dataQuality: null,
    },
    liveDatasetSnapshot: null,
    
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
    isLoadingSlice: false,
    analyticsModalOpen: false,
    currentSectorArcSteps: 24,
    
    filters: {
        status: { congested: true, 'high-load': true, normal: true, idle: true, 'no-data': false, 'poor-cqi': true },
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
    },
    cellGeometryMeta: {},
    needsPointGeometrySync: false,
    needsSectorGeometrySync: false,
    lastCongestedCount: null,
    lastVisibleFilterSignature: null
};

const importState = {
    headers: [],
    allRows: [],
    previewRows: [],
    inferredMapping: {},
    matchScores: {},
    mapping: {},
    mappingSource: {},
    columnAssignments: {},
    columnSource: {},
    selectedFileName: '',
    detectedType: 'unknown',
    selectedType: 'reference',
    detectionReasons: [],
    totalRows: 0,
    profileSuggestion: null,
    profileBannerDismissed: false,
    sessionMode: 'new',
    strictNoFallback: false,
    pendingImportPayload: null,
    pendingImportOptions: null,
    parseInProgress: false,
};

const dataWorkerBridge = {
    worker: null,
    requestSeq: 0,
    pending: new Map(),
    disabled: false,
};

let hasInitialized = false;
const geometryCache = {};
const MAX_GEOMETRY_CACHE_ENTRIES = 10000;
const REQUIRED_OBSERVATION_KEYS = ['load', 'throughput', 'traffic', 'ta', 'cqi'];
let hasObservationSchemaWarning = false;
const featureStateCache = {
    cells: new Map()
};

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
    return parseTimestampValue(ts);
}

function createSectorPolygon(center, radiusMeters, azimuth, beamwidth, steps = CONFIG.SECTOR_ARC_STEPS_DEFAULT) {
    // Use geodesic destination for each point on the sector arc for higher accuracy
    const stepsCount = Math.max(3, Number(steps) || CONFIG.SECTOR_ARC_STEPS_DEFAULT);
    const startAzimuth = azimuth - beamwidth / 2;
    const endAzimuth = azimuth + beamwidth / 2;
    const coordinates = [center];

    for (let i = 0; i <= stepsCount; i++) {
        const currentAzimuth = startAzimuth + (i / stepsCount) * (endAzimuth - startAzimuth);
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
    const taMetersRaw = Number(ta) * CONFIG.TA_TO_METERS;
    if (Number.isFinite(taMetersRaw) && taMetersRaw > 0) {
        // Blend static band footprint with live TA so radius changes stay visible but stable.
        const blended = baseRadius * 0.55 + taMetersRaw * 0.9;
        baseRadius = Math.round(blended / 10) * 10;
    }
    return Math.max(CONFIG.MIN_RADIUS, Math.min(CONFIG.MAX_RADIUS, baseRadius));
}

function getObservationTA(obs) {
    const taCandidate = obs?.ta ?? obs?.timing_advance ?? obs?.avg_ta ?? obs?.ta_avg ?? null;
    const ta = Number(taCandidate);
    return Number.isFinite(ta) ? ta : null;
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

function formatTimestampFromDate(date) {
    const d = date instanceof Date ? date : new Date(date);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    const hour = String(d.getHours()).padStart(2, '0');
    const minute = String(d.getMinutes()).padStart(2, '0');
    return `${day}-${month}-${year} ${hour}:${minute}`;
}

function ensureDataWorker() {
    if (dataWorkerBridge.disabled || typeof window === 'undefined' || typeof Worker === 'undefined') {
        return null;
    }

    if (dataWorkerBridge.worker) {
        return dataWorkerBridge.worker;
    }

    try {
        const worker = new Worker('/workers/dataWorker.js');
        worker.onmessage = (event) => {
            const { id, ok, data, error } = event.data || {};
            const pending = dataWorkerBridge.pending.get(id);
            if (!pending) return;
            clearTimeout(pending.timer);
            dataWorkerBridge.pending.delete(id);
            if (ok) pending.resolve(data);
            else pending.reject(new Error(error || 'Worker request failed'));
        };
        worker.onerror = (event) => {
            console.error('Data worker crashed:', event?.message || event);
            dataWorkerBridge.disabled = true;
            dataWorkerBridge.pending.forEach((pending) => {
                clearTimeout(pending.timer);
                pending.reject(new Error('Data worker is unavailable'));
            });
            dataWorkerBridge.pending.clear();
            try {
                worker.terminate();
            } catch {
                // ignore
            }
            dataWorkerBridge.worker = null;
        };
        dataWorkerBridge.worker = worker;
        return worker;
    } catch (err) {
        dataWorkerBridge.disabled = true;
        console.warn('Web Worker is unavailable in this browser context:', err);
        return null;
    }
}

async function callDataWorker(action, payload = {}, timeoutMs = 30000) {
    const worker = ensureDataWorker();
    if (!worker) {
        throw new Error('Web Worker unavailable');
    }

    const id = `${Date.now()}_${++dataWorkerBridge.requestSeq}`;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            dataWorkerBridge.pending.delete(id);
            reject(new Error(`Worker request timed out (${action})`));
        }, timeoutMs);

        dataWorkerBridge.pending.set(id, { resolve, reject, timer });
        worker.postMessage({ id, action, payload });
    });
}

async function loadPeakHoursIndex() {
    try {
        const res = await fetchWithAuth('/api/peak-hours');
        const payload = await res.json();
        if (!res.ok) {
            throw new Error(payload?.error || `Peak-hours API error (${res.status})`);
        }
        const rows = Array.isArray(payload?.rows) ? payload.rows : [];
        const map = {};
        rows.forEach((row) => {
            const cellName = String(row?.cell_name || '').trim();
            if (!cellName) return;
            map[cellName] = {
                peak_hour: row?.peak_hour || null,
                peak_avg_prb: Number.isFinite(Number(row?.peak_avg_prb)) ? Number(row.peak_avg_prb) : null,
                samples: Number.isFinite(Number(row?.samples)) ? Number(row.samples) : 0,
            };
        });
        state.peakHoursByCell = map;
        return map;
    } catch (err) {
        console.warn('Peak-hours index unavailable:', err?.message || err);
        state.peakHoursByCell = {};
        return {};
    }
}

function applyPeakAndDriftMetadataToFeatures() {
    state.pointFeatures.forEach((feature) => {
        const cellName = feature?.properties?.cell_name;
        if (!cellName) return;

        const peak = state.peakHoursByCell[cellName] || null;
        const drift = state.driftByCell[cellName] || null;

        feature.properties.peak_hour = peak?.peak_hour || null;
        feature.properties.peak_avg_prb = Number.isFinite(Number(peak?.peak_avg_prb)) ? Number(peak.peak_avg_prb) : null;
        feature.properties.drift_abs_delta = Number.isFinite(Number(drift?.last_abs_delta)) ? Number(drift.last_abs_delta) : null;
        feature.properties.drift_pct_delta = Number.isFinite(Number(drift?.last_pct_delta)) ? Number(drift.last_pct_delta) : null;
        feature.properties.has_drift_alert = Boolean(drift?.is_alert);
    });
}

function buildDriftAlertCellMap(alerts) {
    const byCell = {};
    (alerts || []).forEach((alert) => {
        const cellName = String(alert?.cell_name || '').trim();
        if (!cellName) return;
        byCell[cellName] = alert;
    });
    return byCell;
}

async function loadDriftAlerts() {
    const abs = Number(state.driftThresholds.absPrbDelta || 15);
    const pct = Number(state.driftThresholds.pctPrbDelta || 30);
    const query = new URLSearchParams({
        abs_threshold: String(abs),
        pct_threshold: String(pct),
        limit: '150',
    });

    try {
        const res = await fetchWithAuth(`/api/drift?${query.toString()}`);
        const payload = await res.json();
        if (!res.ok) {
            throw new Error(payload?.error || `Drift API error (${res.status})`);
        }
        const alerts = Array.isArray(payload?.alerts) ? payload.alerts : [];
        state.driftAlerts = alerts;
        state.driftByCell = buildDriftAlertCellMap(alerts);
        applyPeakAndDriftMetadataToFeatures();
        updateDriftAlertsUI();
        return alerts;
    } catch (err) {
        console.warn('Drift alerts unavailable:', err?.message || err);
        state.driftAlerts = [];
        state.driftByCell = {};
        applyPeakAndDriftMetadataToFeatures();
        updateDriftAlertsUI();
        return [];
    }
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

async function buildSiteHierarchy() {
    const hierarchy = await callDataWorker('buildSiteHierarchy', { baseline: state.baseline }, 60000);
    if (!hierarchy || typeof hierarchy !== 'object') {
        throw new Error('Worker returned invalid site hierarchy payload');
    }
    state.siteHierarchy = hierarchy;
}

function getLivePointProperties(mapFeature) {
    const featureId = Number(mapFeature?.id ?? mapFeature?.properties?.id);
    if (!Number.isInteger(featureId) || featureId < 0 || featureId >= state.pointFeatures.length) {
        return mapFeature?.properties || {};
    }
    return state.pointFeatures[featureId]?.properties || mapFeature?.properties || {};
}

function computeSiteLiveStats(site) {
    let totalCells = 0;
    let congestedCells = 0;
    let lowCQI = 0;
    let avgLoad = 0;
    let avgCQI = 0;
    let loadCount = 0;
    let cqiCount = 0;

    Object.values(site.antennas).forEach(ant => {
        ant.cells.forEach(cell => {
            totalCells++;
            const obs = state.currentObservations[cell.cellName];
            if (obs) {
                if (obs.congested) congestedCells++;
                if (obs.cqi !== null && obs.cqi < CONFIG.CQI_THRESHOLD) lowCQI++;
                if (obs.load !== null && obs.load !== undefined) {
                    avgLoad += obs.load;
                    loadCount++;
                }
                if (obs.cqi !== null && obs.cqi !== undefined) {
                    avgCQI += obs.cqi;
                    cqiCount++;
                }
            }
        });
    });

    return {
        totalCells,
        congestedCells,
        lowCQI,
        avgLoad: loadCount ? avgLoad / loadCount : 0,
        avgCQI: cqiCount ? avgCQI / cqiCount : 0
    };
}

// --- Data Processing ---
function buildFeaturesForTime() {
    const pointFeatures = [];
    const sectorFeatures = [];
    const sites = new Map();
    state.cellGeometryMeta = {};
    
    let index = 0;
    for (const [cellName, baseInfo] of Object.entries(state.baseline)) {
        const center = [baseInfo.longitude, baseInfo.latitude];
        const azimuth = baseInfo.azimuth || 0;
        const band = baseInfo.frequency_band;
        const peak = state.peakHoursByCell[cellName] || null;
        const drift = state.driftByCell[cellName] || null;
        const { siteName, antenna, cellNum } = parseCellName(cellName);
        const radius = calculateCellRadius(band, null);
        const cacheKey = `${cellName}_${radius}_${CONFIG.SECTOR_ARC_STEPS_DEFAULT}`;
        const geometry = geometryCache[cacheKey] || createSectorPolygon(
            center,
            radius,
            azimuth,
            CONFIG.DEFAULT_BEAMWIDTH,
            CONFIG.SECTOR_ARC_STEPS_DEFAULT
        );
        geometryCache[cacheKey] = geometry;

        state.cellGeometryMeta[cellName] = {
            center,
            azimuth,
            radius,
            band,
            siteName,
            antenna,
            cellNum
        };
        
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
                status: 'no-data',
                color: CONFIG.COLORS.NO_DATA,
                opacity: 0.4,
                load: null,
                congested: false,
                issue_type: 'Normal',
                root_cause: '-',
                severity: 0,
                health_score: 100,
                throughput: null,
                cqi: null,
                has_low_cqi: false,
                traffic: null,
                traffic_loss_ue: 0,
                traffic_loss_gb: 0,
                ta: null,
                dynamic_radius_supported: true,
                signal_power: null,
                peak_hour: peak?.peak_hour || null,
                peak_avg_prb: Number.isFinite(Number(peak?.peak_avg_prb)) ? Number(peak.peak_avg_prb) : null,
                drift_abs_delta: Number.isFinite(Number(drift?.last_abs_delta)) ? Number(drift.last_abs_delta) : null,
                drift_pct_delta: Number.isFinite(Number(drift?.last_pct_delta)) ? Number(drift.last_pct_delta) : null,
                has_drift_alert: Boolean(drift?.is_alert),
                band,
                azimuth,
                localcell_id: baseInfo.localcell_id,
                duplex: baseInfo.cell_fdd_tdd_indication || 'FDD',
                is_forecast: false
            },
            geometry: { type: 'Point', coordinates: center }
        });
        
        sectorFeatures.push({
            type: 'Feature',
            id: index,
            properties: {
                id: index,
                cell_name: cellName,
                site_name: siteName,
                antenna_id: antenna,
                enodeb_name: baseInfo.enodeb_name,
                status: 'no-data',
                color: CONFIG.COLORS.NO_DATA,
                opacity: 0.4,
                load: null,
                cqi: null,
                has_low_cqi: false,
                congested: false,
                band,
                azimuth,
                radius,
                arc_steps: CONFIG.SECTOR_ARC_STEPS_DEFAULT,
                dynamic_radius_supported: true,
                severity: 0,
                issue_type: 'Normal',
                is_forecast: false
            },
            geometry: { type: 'Polygon', coordinates: geometry }
        });
        
        if (!sites.has(siteName)) {
            sites.set(siteName, { name: siteName, coordinates: center, cells: [] });
        }
        sites.get(siteName).cells.push(cellName);
        
        index++;
    }

    pruneGeometryCache();
    
    return { pointFeatures, sectorFeatures, sites: Array.from(sites.values()) };
}

function syncSectorGeometryForObservations(observations = {}) {
    let geometryChanged = false;
    const steps = Math.max(3, Number(state.currentSectorArcSteps) || CONFIG.SECTOR_ARC_STEPS_DEFAULT);

    state.sectorFeatures.forEach((feature) => {
        const cellName = feature?.properties?.cell_name;
        const meta = cellName ? state.cellGeometryMeta[cellName] : null;
        if (!meta) return;

        const obs = observations[cellName] || null;
        const radius = calculateCellRadius(meta.band, getObservationTA(obs));
        const previousRadius = Number(feature?.properties?.radius);
        const previousSteps = Number(feature?.properties?.arc_steps);
        const mustRebuild =
            !Number.isFinite(previousRadius) ||
            previousRadius !== radius ||
            !Number.isFinite(previousSteps) ||
            previousSteps !== steps;

        if (!mustRebuild) {
            return;
        }

        const cacheKey = `${cellName}_${radius}_${steps}`;
        const geometry = geometryCache[cacheKey] || createSectorPolygon(
            meta.center,
            radius,
            meta.azimuth,
            CONFIG.DEFAULT_BEAMWIDTH,
            steps
        );

        geometryCache[cacheKey] = geometry;
        feature.geometry.coordinates = geometry;
        feature.properties.radius = radius;
        feature.properties.arc_steps = steps;
        geometryChanged = true;
    });

    if (geometryChanged) {
        pruneGeometryCache();
    }

    return geometryChanged;
}

function buildFeatureUpdateMap(featureUpdates = []) {
    return buildFeatureUpdateMapFromPayload(featureUpdates);
}

function applyWorkerFeatureUpdates(featureUpdates = []) {
    const updatesByCellName = buildFeatureUpdateMap(featureUpdates);
    const featuresCount = Math.min(state.pointFeatures.length, state.sectorFeatures.length);
    for (let i = 0; i < featuresCount; i++) {
        const pointFeature = state.pointFeatures[i];
        const sectorFeature = state.sectorFeatures[i];
        const cellName = String(pointFeature?.properties?.cell_name || sectorFeature?.properties?.cell_name || '').trim();
        const update = cellName ? updatesByCellName.get(cellName) : null;
        if (!pointFeature || !sectorFeature || !update) continue;

        pointFeature.properties.status = update.status;
        pointFeature.properties.color = update.color;
        pointFeature.properties.opacity = update.opacity;
        pointFeature.properties.load = update.load;
        pointFeature.properties.congested = update.congested;
        pointFeature.properties.issue_type = update.issue_type;
        pointFeature.properties.root_cause = update.root_cause;
        pointFeature.properties.severity = update.severity;
        pointFeature.properties.health_score = update.health_score;
        pointFeature.properties.throughput = update.throughput;
        pointFeature.properties.cqi = update.cqi;
        pointFeature.properties.has_low_cqi = update.has_low_cqi;
        pointFeature.properties.traffic = update.traffic;
        pointFeature.properties.traffic_loss_ue = update.traffic_loss_ue ?? 0;
        pointFeature.properties.traffic_loss_gb = update.traffic_loss_gb ?? 0;
        pointFeature.properties.ta = update.ta;
        pointFeature.properties.dynamic_radius_supported = update.dynamic_radius_supported !== false;
        pointFeature.properties.signal_power = update.signal_power;
        pointFeature.properties.is_forecast = update.is_forecast;
        if (update.confidence !== null && update.confidence !== undefined) {
            pointFeature.properties.confidence = update.confidence;
        } else {
            delete pointFeature.properties.confidence;
        }

        sectorFeature.properties.status = update.status;
        sectorFeature.properties.color = update.color;
        sectorFeature.properties.opacity = update.sector_opacity;
        sectorFeature.properties.load = update.load;
        sectorFeature.properties.cqi = update.cqi;
        sectorFeature.properties.has_low_cqi = update.has_low_cqi;
        sectorFeature.properties.congested = update.congested;
        sectorFeature.properties.severity = update.severity;
        sectorFeature.properties.issue_type = update.issue_type;
        sectorFeature.properties.dynamic_radius_supported = update.dynamic_radius_supported !== false;
        sectorFeature.properties.is_forecast = update.is_forecast;
        if (update.confidence !== null && update.confidence !== undefined) {
            sectorFeature.properties.confidence = update.confidence;
        } else {
            delete sectorFeature.properties.confidence;
        }
    }

    applyPeakAndDriftMetadataToFeatures();
    syncSectorGeometryForObservations(state.currentObservations);
    state.needsSectorGeometrySync = true;
}

async function updateFeaturesForTime(observations = {}, options = {}) {
    const cellNames = state.pointFeatures.map((feature) => feature?.properties?.cell_name || '');
    const updates = await callDataWorker(
        'buildFeatureUpdates',
        {
            cellNames,
            observations,
            cqiThreshold: CONFIG.CQI_THRESHOLD,
            colors: CONFIG.COLORS,
            isForecast: options?.isForecast || false,
            confidence: options?.confidence ?? null,
        },
        45000
    );

    const isArrayPayload = Array.isArray(updates);
    const isObjectPayload = updates !== null && typeof updates === 'object';
    if (!isArrayPayload && !isObjectPayload) {
        throw new Error('Worker returned invalid feature update payload');
    }
    applyWorkerFeatureUpdates(updates);
}

function setSectorGeometryResolution(steps) {
    const targetSteps = Math.max(3, Number(steps) || CONFIG.SECTOR_ARC_STEPS_DEFAULT);
    if (state.currentSectorArcSteps === targetSteps) return;

    state.currentSectorArcSteps = targetSteps;
    syncSectorGeometryForObservations(state.currentObservations);
    state.needsSectorGeometrySync = true;
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

    const {
        totalCells,
        congestedCells,
        lowCQI,
        avgLoad,
        avgCQI
    } = computeSiteLiveStats(site);

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
            <div class="site-info-row"><span>Avg Load</span><span id="site-avg-load">${avgLoad.toFixed(1)}%</span></div>
            <div class="site-info-row"><span>Avg CQI</span><span id="site-avg-cqi" class="${avgCQI < CONFIG.CQI_THRESHOLD ? 'text-danger' : ''}">${avgCQI.toFixed(1)}</span></div>
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

function refreshSiteInfoStats(siteName) {
    if (!siteName || state.selectedSite !== siteName) return;
    const panel = document.getElementById('cell-info-panel');
    if (!panel || panel.classList.contains('hidden')) return;
    const site = state.siteHierarchy[siteName];
    if (!site) return;

    const {
        totalCells,
        congestedCells,
        lowCQI,
        avgLoad,
        avgCQI
    } = computeSiteLiveStats(site);

    const statusEl = document.getElementById('cell-status');
    if (statusEl) {
        let statusClass = 'normal';
        let statusText = 'Normal';
        if (congestedCells > 0) {
            statusClass = 'congested';
            statusText = `${congestedCells} congested`;
        } else if (lowCQI > 0) {
            statusClass = 'poor-cqi';
            statusText = `${lowCQI} low CQI`;
        }
        statusEl.className = `cell-status ${statusClass}`;
        statusEl.textContent = statusText;
    }

    const healthEl = document.getElementById('cell-health');
    if (healthEl) healthEl.textContent = `Cells: ${totalCells}`;

    const avgLoadEl = document.getElementById('site-avg-load');
    if (avgLoadEl) avgLoadEl.textContent = `${avgLoad.toFixed(1)}%`;

    const avgCqiEl = document.getElementById('site-avg-cqi');
    if (avgCqiEl) {
        avgCqiEl.textContent = avgCQI.toFixed(1);
        avgCqiEl.classList.toggle('text-danger', avgCQI < CONFIG.CQI_THRESHOLD);
    }
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

function toFiniteNumberOrNull(value) {
    if (value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function getCustomSessionObservation(cellName) {
    if (!state.customDataset.active) return null;

    const currentIndex = Number.isInteger(state.currentTimeIndex) ? state.currentTimeIndex : 0;
    const currentSlice = state.customDataset?.slices?.[currentIndex] || null;
    const sliceObservation = currentSlice?.observations?.[cellName];
    if (sliceObservation && typeof sliceObservation === 'object' && !Array.isArray(sliceObservation)) {
        return sliceObservation;
    }

    const fallbackObservation = state.currentObservations?.[cellName];
    if (fallbackObservation && typeof fallbackObservation === 'object' && !Array.isArray(fallbackObservation)) {
        return fallbackObservation;
    }

    return null;
}

function buildRecommendRequestBody(cellName) {
    const requestBody = { cell_name: cellName };
    const currentObservation = getCustomSessionObservation(cellName);
    if (!currentObservation) {
        return requestBody;
    }

    const prbLoad = toFiniteNumberOrNull(currentObservation?.load);
    const throughput = toFiniteNumberOrNull(currentObservation?.throughput);
    const activeUsers = toFiniteNumberOrNull(currentObservation?.active_users ?? currentObservation?.traffic);
    const cqi = toFiniteNumberOrNull(currentObservation?.cqi);

    if (prbLoad !== null) requestBody.prb_load = prbLoad;
    if (throughput !== null) requestBody.throughput = throughput;
    if (activeUsers !== null) requestBody.active_users = activeUsers;
    if (cqi !== null) requestBody.cqi = cqi;

    return requestBody;
}

function getRecommendationCacheKey(cellName) {
    if (!state.customDataset.active) return cellName;
    const currentIndex = Number.isInteger(state.currentTimeIndex) ? state.currentTimeIndex : 0;
    return `${cellName}::custom::${currentIndex}`;
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
    const currentLossUeRaw = Number(payload?.current_loss?.ue ?? payload?.current_kpis?.traffic_loss_ue ?? 0);
    const currentLossGbRaw = Number(payload?.current_loss?.gb ?? payload?.current_kpis?.traffic_loss_gb ?? 0);
    const currentLossUe = Number.isFinite(currentLossUeRaw) ? Math.max(0, Math.round(currentLossUeRaw)) : 0;
    const currentLossGb = Number.isFinite(currentLossGbRaw) ? Number(Math.max(0, currentLossGbRaw).toFixed(1)) : 0;
    const recoveryPct = toRecoveryPercent(
        recommendation?.recovery_rate ?? recommendation?.estimated_recovery_pct,
        actionMeta?.recoveryRate || 0
    );
    const gainUeRaw = Number(recommendation?.gain_ue);
    const gainGbRaw = Number(recommendation?.gain_gb);
    const gainUe = Number.isFinite(gainUeRaw)
        ? Math.max(0, Math.round(gainUeRaw))
        : Math.round(currentLossUe * (recoveryPct / 100));
    const gainGb = Number.isFinite(gainGbRaw)
        ? Number(Math.max(0, gainGbRaw).toFixed(1))
        : Number((currentLossGb * (recoveryPct / 100)).toFixed(1));

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
        currentLossUe,
        currentLossGb,
        gainUe,
        gainGb,
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
        body: JSON.stringify(buildRecommendRequestBody(cellName)),
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
        const cacheKey = getRecommendationCacheKey(cellName);
        const payload = recommendationCache.get(cacheKey) || await fetchBackendDecision(cellName);
        recommendationCache.set(cacheKey, payload);

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
            const currentLossUe = Number.isFinite(Number(recommendation.currentLossUe))
                ? Math.max(0, Math.round(Number(recommendation.currentLossUe)))
                : 0;
            const currentLossGb = Number.isFinite(Number(recommendation.currentLossGb))
                ? Number(Math.max(0, Number(recommendation.currentLossGb)).toFixed(1))
                : 0;
            const gainUe = Number.isFinite(Number(recommendation.gainUe))
                ? Math.max(0, Math.round(Number(recommendation.gainUe)))
                : 0;
            const gainGb = Number.isFinite(Number(recommendation.gainGb))
                ? Number(Math.max(0, Number(recommendation.gainGb)).toFixed(1))
                : 0;

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
                        <div class="reco-metric"><span class="reco-metric-label">Perte actuelle:</span><span class="reco-metric-value">${escapeHtml(String(currentLossUe))} UE / ${escapeHtml(currentLossGb.toFixed(1))} GB</span></div>
                        <div class="reco-metric"><span class="reco-metric-label">Taux récupération:</span><span class="reco-metric-value">${escapeHtml(String(recommendation.recoveryRate))}%</span></div>
                        <div class="reco-metric"><span class="reco-metric-label">Gain estimé:</span><span class="reco-metric-value">${escapeHtml(String(gainUe))} UE / ${escapeHtml(gainGb.toFixed(1))} GB</span></div>
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

function getActiveUsersMetric(metrics = {}) {
    const candidate = metrics.active_users ?? metrics.traffic;
    const parsed = Number(candidate);
    return Number.isFinite(parsed) ? parsed : 0;
}

function renderSitePlanningPanel(cellName) {
    const panel = document.getElementById('site-planning-panel');
    const selectedCellEl = document.getElementById('site-planning-selected-cell');
    const runBtn = document.getElementById('site-planning-run');
    const resultEl = document.getElementById('site-planning-result');
    if (!panel || !selectedCellEl || !runBtn || !resultEl) return;

    if (!cellName) {
        panel.classList.add('disabled');
        runBtn.disabled = true;
        selectedCellEl.textContent = 'Select a cell on the map to run site planning.';
        resultEl.innerHTML = '<div class="action-hint">Choose a cell first, then run new site simulation.</div>';
        return;
    }

    const obs = state.currentObservations[cellName] || {};
    const load = Number(obs.load);
    const throughput = Number(obs.throughput);
    const activeUsers = getActiveUsersMetric(obs);

    panel.classList.remove('disabled');
    runBtn.disabled = false;
    selectedCellEl.innerHTML = sanitizeRichHtml(`<strong>${escapeHtml(cellName)}</strong>`);

    const loadText = Number.isFinite(load) ? `${formatNumber(load)}%` : 'N/A';
    const throughputText = Number.isFinite(throughput) ? formatThroughput(throughput) : 'N/A';
    const usersText = formatNumber(activeUsers, 2);
    resultEl.innerHTML = sanitizeRichHtml(
        `<div class="action-hint">Current snapshot → Load: ${loadText} | Throughput: ${throughputText} | Active users: ${usersText}</div>`
    );
}

function displaySitePlanningResults(result) {
    const container = document.getElementById('site-planning-result');
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
    const confidence = result.confidence ?? 0.75;
    const confidencePct = Math.round(confidence * 100);
    const beforeUsers = getActiveUsersMetric(before);
    const afterUsers = getActiveUsersMetric(after);
    const usersDelta = Number.isFinite(Number(impact.active_users_change))
        ? Number(impact.active_users_change)
        : afterUsers - beforeUsers;

    const neighbors = (impact.affected_cells || []).map((n) => {
        const delta = n.load_change ?? n.change ?? 0;
        return { name: n.name || n.cell_name, delta };
    }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 8);

    const neighborsText = neighbors.length
        ? `Affected: ${neighbors.map((c) => `${escapeHtml(c.name)} (${escapeHtml(formatNumber(c.delta))}%)`).join(', ')}`
        : '';

    container.innerHTML = sanitizeRichHtml(`
        <div class="action-mode-badge">⚡ Fast (${confidencePct}% confidence)</div>
        <div class="action-comparison">
            <div>
                <div class="action-label">Before</div>
                <div>Load: ${formatNumber(before.load)}%</div>
                <div>Throughput: ${formatThroughput(before.throughput || 0)}</div>
                <div>Active users: ${formatNumber(beforeUsers, 2)}</div>
            </div>
            <div class="action-arrow">→</div>
            <div>
                <div class="action-label">After</div>
                <div>Load: ${formatNumber(after.load)}%</div>
                <div>Throughput: ${formatThroughput(after.throughput || 0)}</div>
                <div>Active users: ${formatNumber(afterUsers, 2)}</div>
            </div>
        </div>
        <div class="action-impact">
            Load: ${impact.load_change >= 0 ? '+' : ''}${formatNumber(impact.load_change ?? 0, 2)}% |
            Throughput: ${impact.throughput_change >= 0 ? '+' : ''}${formatNumber(impact.throughput_change ?? 0, 2)} kbps |
            Active users: ${usersDelta >= 0 ? '+' : ''}${formatNumber(usersDelta, 2)}
        </div>
        <div class="action-reco">${escapeHtml(result.recommendation || '')}</div>
        ${neighborsText ? `<div class="action-affected">${neighborsText}</div>` : ''}
    `);
}

async function runSitePlanningSimulation(cellName) {
    const resultEl = document.getElementById('site-planning-result');
    const runBtn = document.getElementById('site-planning-run');
    const siteTypeSelect = document.getElementById('site-planning-site-type');

    if (!resultEl || !runBtn || !siteTypeSelect) return;
    if (!cellName) {
        resultEl.innerHTML = '<div class="action-error">Select a cell first.</div>';
        return;
    }

    const siteType = String(siteTypeSelect.value || 'macro').trim();
    const timeEntry = state.timeIndex[state.currentTimeIndex] || {};
    const requestBody = {
        cell_name: cellName,
        action: 'new_site',
        params: { siteType },
        time_entry: timeEntry,
        mode: 'fast',
    };

    try {
        resultEl.innerHTML = '<div class="action-hint">⚡ Simulating new site...</div>';
        runBtn.disabled = true;
        runBtn.innerHTML = '<span class="material-symbols-outlined">hourglass_top</span> Running...';

        const response = await fetch('/api/simulate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload || typeof payload !== 'object') {
            throw new Error(payload?.error || 'Site planning simulation failed');
        }
        if (payload.error) {
            throw new Error(payload.error);
        }

        displaySitePlanningResults(payload);
    } catch (err) {
        resultEl.innerHTML = `<div class="action-error">Simulation failed: ${escapeHtml(err.message)}</div>`;
    } finally {
        runBtn.disabled = false;
        runBtn.innerHTML = '<span class="material-symbols-outlined">play_arrow</span> Run Simulation';
    }
}

// --- Action Simulator ---
function renderActionPanel(cellName) {
    renderSitePlanningPanel(cellName);

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
            ['Lost UEs / month', formatNumber(p.traffic_loss_ue, 0)],
            ['Lost GB / month', formatNumber(p.traffic_loss_gb, 1)],
            ['Peak Hour', p.peak_hour || 'N/A'],
            ['Peak Avg PRB', p.peak_avg_prb !== null && p.peak_avg_prb !== undefined ? `${formatNumber(p.peak_avg_prb, 1)}%` : 'N/A'],
            ['Drift Delta', p.drift_abs_delta !== null && p.drift_abs_delta !== undefined ? `${formatNumber(p.drift_abs_delta, 1)} PRB` : 'N/A'],
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
    const hideSectorsWithoutTa =
        state.customDataset.active &&
        Boolean(state.customDataset.realismPolicy?.hideSectorsWithoutTa);
    
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
    const visibleSectors = state.sectorFeatures.filter((f) => {
        if (!visiblePointIds.has(f.id)) return false;
        return true;
    });

    const sectorsWithTa = visibleSectors.filter((f) => f?.properties?.dynamic_radius_supported !== false);
    const shouldFallbackToStaticSectors = hideSectorsWithoutTa && sectorsWithTa.length === 0;

    const sectors = visibleSectors.filter((f) => {
        if (hideSectorsWithoutTa && f?.properties?.dynamic_radius_supported === false) {
            return shouldFallbackToStaticSectors;
        }
        return true;
    });
    state.filteredPointFeatures = points;
    state.filteredSectorFeatures = sectors;
    updateMapData();
    if (state.analyticsModalOpen) {
        updateAnalyticsCharts(points);
    }
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
    state.filters.status['no-data'] = false;
    const noDataFilter = document.querySelector('input[data-filter="no-data"]');
    if (noDataFilter instanceof HTMLInputElement) noDataFilter.checked = false;
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
    const header = ['cell_name','site_name','band','load','cqi','throughput','issue_type','severity','congested','peak_hour','peak_avg_prb','drift_abs_delta','drift_pct_delta'];
    const lines = [header.join(',')];
    rows.forEach(f => {
        const p = f.properties;
        lines.push([
            p.cell_name,
            p.site_name,
            p.band,
            p.load ?? '',
            p.cqi ?? '',
            p.throughput ?? '',
            p.issue_type ?? '',
            p.severity ?? '',
            p.congested ? 'true' : 'false',
            p.peak_hour ?? '',
            p.peak_avg_prb ?? '',
            p.drift_abs_delta ?? '',
            p.drift_pct_delta ?? '',
        ].join(','));
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

async function computeExploreDataWithWorker(duration, metric) {
    const result = await callDataWorker(
        'computeExploreData',
        { duration, metric, timeIndex: state.timeIndex },
        30000
    );
    if (!result || !Array.isArray(result.labels) || !Array.isArray(result.values)) {
        throw new Error('Worker returned invalid explore data payload');
    }
    return result;
}

async function computeTimelineDataWithWorker(metric) {
    const result = await callDataWorker(
        'computeTimelineData',
        { metric, timeIndex: state.timeIndex },
        30000
    );
    if (!result || !Array.isArray(result.labels) || !Array.isArray(result.values)) {
        throw new Error('Worker returned invalid timeline data payload');
    }
    return result;
}

async function renderExploreCharts() {
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
    
    const { labels, values, insights } = await computeExploreDataWithWorker(duration, metric);
    const timeline = await computeTimelineDataWithWorker(metric);
    
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

const IMPORT_TYPE_REFERENCE = 'reference';
const IMPORT_TYPE_KPI = 'kpi';
const IMPORT_TYPE_UNKNOWN = 'unknown';
const IMPORT_PROFILE_STORAGE_KEY = 'netvision_csv_import_profiles_v1';
const IMPORT_AUTO_MATCH_THRESHOLD = 0.56;
const IMPORT_PREVIEW_ROW_LIMIT = 7;
const IMPORT_MAX_SAVED_PROFILES = 20;

const IMPORT_FIELD_CONFIG = {
    [IMPORT_TYPE_REFERENCE]: [
        { key: 'cell_name', label: 'Cell Identifier', required: true },
        { key: 'longitude', label: 'Longitude', required: true },
        { key: 'latitude', label: 'Latitude', required: true },
        { key: 'enodeb_name', label: 'Site / eNodeB', required: false },
        { key: 'azimuth', label: 'Azimuth', required: false },
        { key: 'frequency_band', label: 'Frequency Band', required: false },
        { key: 'localcell_id', label: 'Local Cell ID', required: false },
        { key: 'cell_fdd_tdd_indication', label: 'Duplex Mode', required: false },
        { key: 'load', label: 'PRB Load', required: false },
        { key: 'throughput', label: 'Throughput', required: false },
        { key: 'cqi', label: 'CQI', required: false },
        { key: 'active_users', label: 'Active Users', required: false },
        { key: 'ta', label: 'Timing Advance', required: false },
        { key: 'signal_power', label: 'Signal Power', required: false },
    ],
    [IMPORT_TYPE_KPI]: [
        { key: 'cell_name', label: 'Cell Identifier', required: true },
        { key: 'localcell_id', label: 'Local Cell ID', required: false },
        { key: 'enodeb_name', label: 'Site / eNodeB', required: false },
        { key: 'cell_fdd_tdd_indication', label: 'Duplex Mode', required: false },
        { key: 'timestamp', label: 'Timestamp', required: false },
        { key: 'date', label: 'Date', required: false },
        { key: 'time', label: 'Time', required: false },
        { key: 'traffic', label: 'Traffic', required: false },
        { key: 'active_users', label: 'Active Users', required: false },
        { key: 'load', label: 'PRB Load', required: false },
        { key: 'throughput', label: 'Throughput', required: false },
        { key: 'cqi', label: 'CQI', required: false },
        { key: 'congested', label: 'Congestion Flag', required: false },
        { key: 'severity', label: 'Severity', required: false },
        { key: 'issue_type', label: 'Issue Type', required: false },
        { key: 'root_cause', label: 'Root Cause', required: false },
        { key: 'health_score', label: 'Health Score', required: false },
    ],
};

function normalizeImportType(type, allowUnknown = false) {
    const value = String(type || '').trim().toLowerCase();
    if (value === IMPORT_TYPE_KPI) return IMPORT_TYPE_KPI;
    if (value === IMPORT_TYPE_REFERENCE) return IMPORT_TYPE_REFERENCE;
    return allowUnknown ? IMPORT_TYPE_UNKNOWN : IMPORT_TYPE_REFERENCE;
}

function getImportTypeLabel(type) {
    const normalizedType = normalizeImportType(type, true);
    if (normalizedType === IMPORT_TYPE_KPI) return 'KPI Hourly Data';
    if (normalizedType === IMPORT_TYPE_REFERENCE) return 'Reference Data';
    return 'Unknown';
}

function getImportFieldsForType(type = importState.selectedType) {
    const normalizedType = normalizeImportType(type);
    return IMPORT_FIELD_CONFIG[normalizedType] || IMPORT_FIELD_CONFIG[IMPORT_TYPE_REFERENCE];
}

function normalizeImportSessionMode(mode) {
    return String(mode || '').trim().toLowerCase() === 'current' ? 'current' : 'new';
}

function deepClone(value) {
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(value);
        } catch {
            // fallback to JSON clone below
        }
    }
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return value;
    }
}

function createLiveDatasetSnapshot() {
    return {
        baseline: deepClone(state.baseline),
        timeIndex: deepClone(state.timeIndex),
        currentTimeIndex: Number.isInteger(state.currentTimeIndex) ? state.currentTimeIndex : 0,
        currentObservations: deepClone(state.currentObservations),
        currentStats: deepClone(state.currentStats),
        globalStats: deepClone(state.globalStats),
        peakHoursByCell: deepClone(state.peakHoursByCell),
        driftByCell: deepClone(state.driftByCell),
        driftAlerts: deepClone(state.driftAlerts),
        forecastIndex: deepClone(forecastState.forecastIndex),
        forecastAvailable: Boolean(forecastState.available),
        capturedAt: new Date().toISOString(),
    };
}

function captureLiveDatasetSnapshot(force = false) {
    if (!force && state.liveDatasetSnapshot) return;
    if (!force && state.customDataset.active) return;
    state.liveDatasetSnapshot = createLiveDatasetSnapshot();
}

function getBaselineForImportSession(importType, sessionMode = importState.sessionMode) {
    if (normalizeImportType(importType) !== IMPORT_TYPE_KPI) {
        return {};
    }

    const mode = normalizeImportSessionMode(sessionMode);
    if (mode === 'current' && state.customDataset.active) {
        return state.baseline || {};
    }

    // New import sessions must start empty and not inherit the live baseline.
    return {};
}

function normalizeSliceTimestamp(value) {
    const raw = String(value || '').trim();
    if (!raw) {
        return '';
    }

    const parsed = parseTimestamp(raw);
    if (parsed instanceof Date && !Number.isNaN(parsed.getTime())) {
        return formatTimestampFromDate(parsed);
    }
    return raw;
}

function getTimestampSortValue(timestamp) {
    const parsed = parseTimestamp(String(timestamp || ''));
    if (!(parsed instanceof Date)) {
        return Number.POSITIVE_INFINITY;
    }
    const timeValue = parsed.getTime();
    return Number.isFinite(timeValue) ? timeValue : Number.POSITIVE_INFINITY;
}

function normalizeImportSlices(datasetPayload = {}) {
    const rawSlices = Array.isArray(datasetPayload?.slices) ? datasetPayload.slices : [];

    return rawSlices
        .map((slice) => {
            const timestamp = normalizeSliceTimestamp(slice?.timestamp);
            return {
                timestamp,
                observations: slice?.observations && typeof slice.observations === 'object' ? slice.observations : {},
                stats: slice?.stats && typeof slice.stats === 'object' ? slice.stats : {},
            };
        })
        .filter((slice) => String(slice.timestamp || '').trim().length > 0)
        .sort((left, right) => {
            const leftTime = getTimestampSortValue(left.timestamp);
            const rightTime = getTimestampSortValue(right.timestamp);
            if (leftTime !== rightTime) {
                return leftTime - rightTime;
            }
            return String(left.timestamp).localeCompare(String(right.timestamp));
        });
}

function mergeImportSlices(existingSlices = [], incomingSlices = []) {
    const mergedByTimestamp = new Map();

    existingSlices.forEach((slice) => {
        const timestamp = normalizeSliceTimestamp(slice?.timestamp);
        if (!timestamp) return;
        mergedByTimestamp.set(timestamp, {
            timestamp,
            observations: slice?.observations && typeof slice.observations === 'object' ? slice.observations : {},
            stats: slice?.stats && typeof slice.stats === 'object' ? slice.stats : {},
        });
    });

    incomingSlices.forEach((slice) => {
        const timestamp = normalizeSliceTimestamp(slice?.timestamp);
        if (!timestamp) return;
        mergedByTimestamp.set(timestamp, {
            timestamp,
            observations: slice?.observations && typeof slice.observations === 'object' ? slice.observations : {},
            stats: slice?.stats && typeof slice.stats === 'object' ? slice.stats : {},
        });
    });

    return Array.from(mergedByTimestamp.values()).sort((left, right) => {
        const leftTime = getTimestampSortValue(left.timestamp);
        const rightTime = getTimestampSortValue(right.timestamp);
        if (leftTime !== rightTime) {
            return leftTime - rightTime;
        }
        return String(left.timestamp).localeCompare(String(right.timestamp));
    });
}

function getSliceMetricSampleCount(observations = {}) {
    const rows = Object.values(observations || {});
    let count = 0;

    rows.forEach((obs) => {
        if (!obs || typeof obs !== 'object') return;
        const hasMetric = [
            obs.load,
            obs.throughput,
            obs.cqi,
            obs.traffic,
            obs.active_users,
            obs.ta,
            obs.signal_power,
        ].some((value) => Number.isFinite(Number(value)));

        if (hasMetric) {
            count += 1;
        }
    });

    return count;
}

function normalizeImportToken(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
}

function hasReferenceDataForKpiImport() {
    let baselineForCheck = {};
    const sessionMode = normalizeImportSessionMode(importState.sessionMode);

    // Only the current import session baseline should be used for KPI imports.
    if (sessionMode === 'current' && state.customDataset.active) {
        baselineForCheck = state.baseline || {};
    }

    const baselineCells = Object.values(baselineForCheck || {});
    if (!baselineCells.length) {
        return false;
    }
    return baselineCells.some((cell) => {
        const lon = Number(cell?.longitude);
        const lat = Number(cell?.latitude);
        return Number.isFinite(lon) && Number.isFinite(lat);
    });
}

function getImportHeaderFingerprint(headers = []) {
    return headers
        .map((header) => normalizeImportToken(header))
        .filter(Boolean)
        .sort()
        .join('|');
}

function createEmptyImportAssignments(headers = importState.headers) {
    const assignments = {};
    headers.forEach((header) => {
        assignments[header] = '';
    });
    return assignments;
}

function syncImportMappingFromColumns() {
    const mapping = {};
    const mappingSource = {};

    importState.headers.forEach((header) => {
        const fieldKey = String(importState.columnAssignments?.[header] || '').trim();
        if (!fieldKey) return;
        mapping[fieldKey] = header;

        const source = String(importState.columnSource?.[header] || '').trim();
        if (source) {
            mappingSource[fieldKey] = source;
        }
    });

    importState.mapping = mapping;
    importState.mappingSource = mappingSource;
}

function setImportColumnAssignment(header, fieldKey, source = 'manual') {
    if (!importState.headers.includes(header)) {
        return;
    }

    const nextField = String(fieldKey || '').trim();
    if (!importState.columnAssignments || typeof importState.columnAssignments !== 'object') {
        importState.columnAssignments = createEmptyImportAssignments();
    }
    if (!importState.columnSource || typeof importState.columnSource !== 'object') {
        importState.columnSource = createEmptyImportAssignments();
    }

    if (nextField) {
        Object.keys(importState.columnAssignments).forEach((headerKey) => {
            if (headerKey !== header && importState.columnAssignments[headerKey] === nextField) {
                importState.columnAssignments[headerKey] = '';
                importState.columnSource[headerKey] = '';
            }
        });
    }

    importState.columnAssignments[header] = nextField;
    importState.columnSource[header] = nextField ? source : '';
    syncImportMappingFromColumns();
}

function buildAutoImportAssignments(type = importState.selectedType) {
    const fields = getImportFieldsForType(type);
    const headerSet = new Set(importState.headers);
    const validFieldKeys = new Set(fields.map((field) => field.key));
    const assignments = createEmptyImportAssignments();
    const sources = createEmptyImportAssignments();
    const usedHeaders = new Set();
    const usedFields = new Set();

    Object.entries(importState.inferredMapping || {}).forEach(([fieldKey, header]) => {
        if (!validFieldKeys.has(fieldKey)) return;
        if (!headerSet.has(header)) return;
        if (usedHeaders.has(header) || usedFields.has(fieldKey)) return;
        assignments[header] = fieldKey;
        sources[header] = 'auto';
        usedHeaders.add(header);
        usedFields.add(fieldKey);
    });

    const candidates = [];
    fields.forEach((field) => {
        importState.headers.forEach((header) => {
            const score = Number(importState.matchScores?.[field.key]?.[header] ?? 0);
            if (!Number.isFinite(score) || score <= 0) return;
            candidates.push({
                fieldKey: field.key,
                header,
                score,
                required: field.required,
            });
        });
    });

    candidates
        .sort((left, right) => {
            if (right.score !== left.score) return right.score - left.score;
            if (left.required !== right.required) return Number(right.required) - Number(left.required);
            if (left.fieldKey !== right.fieldKey) return left.fieldKey.localeCompare(right.fieldKey);
            return left.header.localeCompare(right.header);
        })
        .forEach((candidate) => {
            if (candidate.score < IMPORT_AUTO_MATCH_THRESHOLD) return;
            if (usedHeaders.has(candidate.header) || usedFields.has(candidate.fieldKey)) return;
            assignments[candidate.header] = candidate.fieldKey;
            sources[candidate.header] = 'auto';
            usedHeaders.add(candidate.header);
            usedFields.add(candidate.fieldKey);
        });

    return { assignments, sources };
}

function applyAutoImportAssignments(type = importState.selectedType) {
    if (!importState.headers.length) {
        importState.columnAssignments = createEmptyImportAssignments();
        importState.columnSource = createEmptyImportAssignments();
        importState.mapping = {};
        importState.mappingSource = {};
        return;
    }

    const auto = buildAutoImportAssignments(type);
    importState.columnAssignments = auto.assignments;
    importState.columnSource = auto.sources;
    syncImportMappingFromColumns();
}

function getImportMappingValidation(mapping = importState.mapping, type = importState.selectedType) {
    const fields = getImportFieldsForType(type);
    const missingRequired = fields.filter((field) => field.required && !mapping[field.key]);
    const extraErrors = [];

    if (normalizeImportType(type) === IMPORT_TYPE_KPI) {
        const hasTimestamp = Boolean(mapping?.timestamp);
        const hasDateTime = Boolean(mapping?.date) && Boolean(mapping?.time);
        if (!hasTimestamp && !hasDateTime) {
            extraErrors.push('KPI Hourly Data requires a Timestamp mapping, or both Date and Time mappings.');
        }
    }

    return {
        fields,
        missingRequired,
        extraErrors,
        isValid: missingRequired.length === 0 && extraErrors.length === 0,
    };
}

function validateImportMapping(mapping) {
    const validation = getImportMappingValidation(mapping);
    if (validation.isValid) return null;
    const messages = [];
    if (validation.missingRequired.length) {
        messages.push(`Missing required field mapping: ${validation.missingRequired.map((field) => field.label).join(', ')}`);
    }
    if (validation.extraErrors.length) {
        messages.push(validation.extraErrors.join(' '));
    }
    return messages.join(' ');
}

function updateImportTypeUI() {
    const typeSelect = document.getElementById('import-type-select');
    if (typeSelect instanceof HTMLSelectElement) {
        typeSelect.value = importState.selectedType;
    }

    const detectedPill = document.getElementById('import-detected-pill');
    if (detectedPill) {
        detectedPill.classList.remove('is-reference', 'is-kpi', 'is-unknown');
        const detectedType = normalizeImportType(importState.detectedType, true);

        if (!importState.selectedFileName) {
            detectedPill.textContent = 'Detected Type: Awaiting file';
            detectedPill.classList.add('is-unknown');
        } else if (detectedType === IMPORT_TYPE_UNKNOWN) {
            detectedPill.textContent = `Detected Type: Unknown • Using ${getImportTypeLabel(importState.selectedType)}`;
            detectedPill.classList.add('is-unknown');
        } else if (detectedType !== importState.selectedType) {
            detectedPill.textContent = `Detected Type: ${getImportTypeLabel(detectedType)} • Using ${getImportTypeLabel(importState.selectedType)}`;
            detectedPill.classList.add(importState.selectedType === IMPORT_TYPE_KPI ? 'is-kpi' : 'is-reference');
        } else {
            detectedPill.textContent = `Detected Type: ${getImportTypeLabel(detectedType)}`;
            detectedPill.classList.add(detectedType === IMPORT_TYPE_KPI ? 'is-kpi' : 'is-reference');
        }
    }

    const reason = document.getElementById('import-detection-reason');
    if (reason) {
        if (!importState.selectedFileName) {
            reason.textContent = 'Upload a CSV to auto-detect format.';
        } else if (Array.isArray(importState.detectionReasons) && importState.detectionReasons.length) {
            reason.textContent = importState.detectionReasons.join(' • ');
        } else {
            reason.textContent = 'Type detection complete. Review column mapping before importing.';
        }
    }
}

function updateImportFileInfo() {
    const fileInfo = document.getElementById('import-file-info');
    if (fileInfo) {
        if (!importState.selectedFileName) {
            fileInfo.textContent = 'No file loaded';
        } else if (importState.totalRows > 0) {
            fileInfo.textContent = `${importState.selectedFileName} • ${importState.totalRows} rows detected`;
        } else {
            fileInfo.textContent = `${importState.selectedFileName} • scanning rows...`;
        }
    }

    const resetButton = document.getElementById('btn-import-reset');
    if (resetButton) {
        resetButton.classList.toggle('import-hidden', !importState.selectedFileName);
    }
}

function updateImportSessionUI() {
    const sessionModeSelect = document.getElementById('import-session-mode');
    const sessionState = document.getElementById('import-session-state');
    const exitSessionButton = document.getElementById('btn-import-exit-session');
    const customSessionActive = Boolean(state.customDataset?.active);

    importState.sessionMode = normalizeImportSessionMode(importState.sessionMode);
    if (!customSessionActive && importState.sessionMode === 'current') {
        importState.sessionMode = 'new';
    }

    if (sessionModeSelect instanceof HTMLSelectElement) {
        const currentOption = Array.from(sessionModeSelect.options).find((option) => option.value === 'current');
        if (currentOption) {
            currentOption.disabled = !customSessionActive;
        }

        sessionModeSelect.value = importState.sessionMode;
    }

    if (sessionState) {
        sessionState.classList.toggle('is-custom', customSessionActive);
        if (!customSessionActive) {
            sessionState.textContent = 'Session: Live Dataset';
        } else {
            const importedFiles = Array.isArray(state.customDataset?.importedFiles)
                ? state.customDataset.importedFiles.filter((name) => String(name || '').trim())
                : [];
            const importedLabel = importedFiles.length === 1 ? '1 file' : `${importedFiles.length} files`;
            sessionState.textContent = `Session: Import Dataset (${importedLabel})`;
        }
    }

    if (exitSessionButton instanceof HTMLButtonElement) {
        exitSessionButton.classList.toggle('import-hidden', !customSessionActive);
        exitSessionButton.disabled = !customSessionActive || importState.parseInProgress;
    }
}

function updateImportCrossFileWarning() {
    const warningBanner = document.getElementById('import-crossfile-warning');
    if (!warningBanner) return;

    const shouldWarn = importState.selectedType === IMPORT_TYPE_KPI && !hasReferenceDataForKpiImport();
    if (!shouldWarn) {
        warningBanner.classList.add('import-hidden');
        warningBanner.textContent = '';
        return;
    }

    warningBanner.textContent = 'Reference Data is required in this session before KPI rows can be loaded because scope-to-reference validation is enabled.';
    warningBanner.classList.remove('import-hidden');
}

function canEnableStrictCongestionMode(mapping = importState.mapping) {
    if (normalizeImportType(importState.selectedType) !== IMPORT_TYPE_KPI) {
        return false;
    }
    return Boolean(mapping?.congested);
}

function buildCurrentImportRealismPolicy(mapping = importState.mapping) {
    const strictNoFallbackEnabled = Boolean(importState.strictNoFallback) && canEnableStrictCongestionMode(mapping);
    return {
        ...IMPORT_REALISM_POLICY,
        strictNoFallback: strictNoFallbackEnabled,
    };
}

function updateImportStrictModeUI() {
    const toggle = document.getElementById('import-strict-mode-toggle');
    const helper = document.getElementById('import-strict-mode-help');
    if (!(toggle instanceof HTMLInputElement)) return;

    const isKpi = normalizeImportType(importState.selectedType) === IMPORT_TYPE_KPI;
    const canEnable = canEnableStrictCongestionMode(importState.mapping);

    if (!isKpi || !canEnable) {
        importState.strictNoFallback = false;
    }

    toggle.checked = isKpi && canEnable && importState.strictNoFallback;
    toggle.disabled = !isKpi || !canEnable || importState.parseInProgress;

    if (!helper) return;
    if (!isKpi) {
        helper.textContent = 'Reference Data imports do not use congestion classification mode.';
    } else if (!canEnable) {
        helper.textContent = 'Map a CSV column to Congestion Flag to enable strict mode.';
    } else if (importState.strictNoFallback) {
        helper.textContent = 'Strict mode enabled: only mapped Congestion Flag values are used.';
    } else {
        helper.textContent = 'Heuristic mode enabled: congestion is derived from PRB, throughput, queue, and CQI.';
    }
}

function updateImportConfirmButtonState() {
    const confirmButton = document.getElementById('btn-import-confirm');
    if (!(confirmButton instanceof HTMLButtonElement)) return;

    const hasPendingPayload = Boolean(importState.pendingImportPayload);
    confirmButton.innerHTML = hasPendingPayload
        ? '<span class="material-symbols-outlined">map</span>Load Imported Session'
        : '<span class="material-symbols-outlined">check_circle</span>Confirm Import';
}

function resetPendingImportPreview() {
    importState.pendingImportPayload = null;
    importState.pendingImportOptions = null;
    updateImportConfirmButtonState();
}

function setImportSummaryVisible(show) {
    const summarySection = document.getElementById('import-summary-section');
    const mappingSection = document.getElementById('import-mapping-section');
    const previewSection = document.getElementById('import-preview-section');
    const primaryActions = document.getElementById('import-primary-actions');

    summarySection?.classList.toggle('import-hidden', !show);
    mappingSection?.classList.toggle('import-hidden', show);
    previewSection?.classList.toggle('import-hidden', show);
    primaryActions?.classList.toggle('import-hidden', show);
}

function setImportBusyState(isBusy) {
    [
        'btn-apply-import',
        'btn-import-back',
        'btn-import-confirm',
        'btn-import-save-profile',
        'btn-import-profile-confirm',
        'btn-import-profile-dismiss',
        'btn-import-reset',
        'btn-import-exit-session',
        'import-type-select',
        'import-session-mode',
        'import-strict-mode-toggle',
    ].forEach((id) => {
        const element = document.getElementById(id);
        if (
            !(element instanceof HTMLButtonElement) &&
            !(element instanceof HTMLSelectElement) &&
            !(element instanceof HTMLInputElement)
        ) return;
        element.disabled = isBusy;
    });
}

function setImportParsingState(active, copy = 'Parsing CSV, please wait...', rowCount = null) {
    const loading = document.getElementById('import-loading');
    const loadingText = document.getElementById('import-loading-text');
    const loadingRows = document.getElementById('import-loading-rows');

    importState.parseInProgress = Boolean(active);
    loading?.classList.toggle('import-hidden', !active);
    if (loadingText) {
        loadingText.textContent = copy;
    }
    if (loadingRows) {
        if (Number.isFinite(Number(rowCount)) && Number(rowCount) >= 0) {
            loadingRows.textContent = `${Number(rowCount)} rows detected`;
        } else {
            loadingRows.textContent = 'Counting rows...';
        }
    }

    updateImportSessionUI();
    updateImportStrictModeUI();
}

function readImportMappingFromUI() {
    syncImportMappingFromColumns();
    return { ...(importState.mapping || {}) };
}

function renderImportMappingUI() {
    const mappingGrid = document.getElementById('import-mapping-grid');
    if (!mappingGrid) return;

    mappingGrid.innerHTML = '';

    if (!importState.headers.length) {
        mappingGrid.innerHTML = '<div class="alert-placeholder">Upload a CSV to start column mapping</div>';
        return;
    }

    const validation = getImportMappingValidation(importState.mapping);
    const statusRow = document.createElement('div');
    statusRow.className = `import-mapping-status-row ${validation.isValid ? 'is-valid' : 'is-warning'}`;
    statusRow.textContent = validation.isValid
        ? 'All required fields are mapped. Ready to review the import summary.'
        : `Missing required fields: ${validation.missingRequired.map((field) => field.label).join(', ')}`;
    mappingGrid.appendChild(statusRow);

    const chipList = document.createElement('div');
    chipList.className = 'import-field-chip-list';

    validation.fields.forEach((field) => {
        const mappedHeader = importState.mapping?.[field.key] || '';
        const source = importState.mappingSource?.[field.key] || '';

        const chip = document.createElement('div');
        chip.className = 'import-field-chip';
        if (field.required && !mappedHeader) {
            chip.classList.add('is-required-missing');
        } else if (mappedHeader) {
            chip.classList.add('is-mapped');
        }

        const label = document.createElement('span');
        label.className = 'import-field-chip-label';
        label.textContent = field.required ? `${field.label} *` : field.label;

        const value = document.createElement('span');
        value.className = 'import-field-chip-value';
        value.textContent = mappedHeader || 'Unassigned';

        chip.appendChild(label);
        chip.appendChild(value);

        if (mappedHeader && source) {
            const badge = document.createElement('span');
            badge.className = 'import-field-chip-source';
            badge.textContent = source === 'profile' ? 'profile' : source === 'auto' ? 'auto' : 'manual';
            chip.appendChild(badge);
        }

        chipList.appendChild(chip);
    });

    mappingGrid.appendChild(chipList);
}

function renderImportPreviewRows() {
    const container = document.getElementById('import-preview-table');
    if (!container) return;

    if (!importState.previewRows.length || !importState.headers.length) {
        container.innerHTML = '<div class="alert-placeholder">Upload a CSV to preview rows</div>';
        return;
    }

    const headers = importState.headers;
    const fields = getImportFieldsForType(importState.selectedType);
    const validation = getImportMappingValidation(importState.mapping, importState.selectedType);
    const hasMissingRequired = !validation.isValid;

    const fieldLabelByKey = fields.reduce((acc, field) => {
        acc[field.key] = field.label;
        return acc;
    }, {});

    const table = document.createElement('table');
    table.className = 'import-preview-grid';

    const thead = document.createElement('thead');

    const mappingRow = document.createElement('tr');
    mappingRow.className = 'import-preview-mapping-row';

    headers.forEach((header) => {
        const th = document.createElement('th');
        th.className = 'import-preview-map-cell';

        const select = document.createElement('select');
        select.className = 'import-column-map-select';
        select.dataset.header = header;

        const ignoreOption = document.createElement('option');
        ignoreOption.value = '';
        ignoreOption.textContent = 'Ignore';
        select.appendChild(ignoreOption);

        fields.forEach((field) => {
            const option = document.createElement('option');
            option.value = field.key;
            option.textContent = field.required ? `${field.label} *` : field.label;
            select.appendChild(option);
        });

        const selectedField = String(importState.columnAssignments?.[header] || '').trim();
        select.value = selectedField;

        if (hasMissingRequired && !selectedField) {
            select.classList.add('is-missing');
        } else if (!hasMissingRequired) {
            select.classList.add('is-valid');
        }

        select.addEventListener('change', (event) => {
            const selectEl = event.target;
            if (!(selectEl instanceof HTMLSelectElement)) return;

            setImportColumnAssignment(header, selectEl.value, 'manual');
            resetPendingImportPreview();
            updateImportStrictModeUI();
            setImportSummaryVisible(false);
            renderImportMappingUI();
            renderImportPreviewRows();
        });

        const mapHint = document.createElement('div');
        mapHint.className = 'import-map-hint';
        const source = importState.columnSource?.[header] || '';
        if (selectedField) {
            const sourceLabel = source === 'profile' ? 'profile' : source === 'auto' ? 'auto' : 'manual';
            mapHint.textContent = `${fieldLabelByKey[selectedField] || selectedField} (${sourceLabel})`;
        } else {
            mapHint.textContent = 'Ignored';
        }

        th.appendChild(select);
        th.appendChild(mapHint);
        mappingRow.appendChild(th);
    });

    thead.appendChild(mappingRow);

    const headRow = document.createElement('tr');
    headRow.className = 'import-preview-header-row';
    headers.forEach((header) => {
        const th = document.createElement('th');
        th.textContent = header;
        headRow.appendChild(th);
    });
    thead.appendChild(headRow);

    const tbody = document.createElement('tbody');
    importState.previewRows.slice(0, IMPORT_PREVIEW_ROW_LIMIT).forEach((row) => {
        const tr = document.createElement('tr');
        headers.forEach((header) => {
            const td = document.createElement('td');
            td.textContent = row?.[header] || '';
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });

    table.appendChild(thead);
    table.appendChild(tbody);

    const sampleNote = document.createElement('div');
    sampleNote.className = 'import-preview-note';
    sampleNote.textContent = `Showing ${Math.min(importState.previewRows.length, IMPORT_PREVIEW_ROW_LIMIT)} sample rows from ${importState.totalRows || importState.previewRows.length} total rows.`;

    container.innerHTML = '';
    container.appendChild(table);
    container.appendChild(sampleNote);
}

function readImportProfiles() {
    try {
        const raw = localStorage.getItem(IMPORT_PROFILE_STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function writeImportProfiles(profiles) {
    try {
        localStorage.setItem(IMPORT_PROFILE_STORAGE_KEY, JSON.stringify(profiles));
    } catch (err) {
        console.warn('Could not save import profile:', err);
    }
}

function findBestImportProfileSuggestion() {
    if (!importState.headers.length) return null;

    const profiles = readImportProfiles();
    const selectedType = normalizeImportType(importState.selectedType);
    const fields = getImportFieldsForType(selectedType);
    const validFieldKeys = new Set(fields.map((field) => field.key));
    const requiredFieldKeys = new Set(fields.filter((field) => field.required).map((field) => field.key));

    const normalizedHeaderMap = new Map();
    importState.headers.forEach((header) => {
        normalizedHeaderMap.set(normalizeImportToken(header), header);
    });

    let best = null;

    profiles
        .filter((profile) => normalizeImportType(profile?.type) === selectedType)
        .forEach((profile) => {
            const profileMapping = profile?.mapping && typeof profile.mapping === 'object' ? profile.mapping : {};
            const entries = Object.entries(profileMapping).filter(([fieldKey, header]) => {
                return validFieldKeys.has(fieldKey) && typeof header === 'string' && header.trim().length > 0;
            });

            if (!entries.length) return;

            const resolvedMapping = {};
            let matched = 0;
            let requiredMatched = 0;

            entries.forEach(([fieldKey, header]) => {
                const normalizedHeader = normalizeImportToken(header);
                const matchedHeader = normalizedHeaderMap.get(normalizedHeader);
                if (!matchedHeader) return;

                resolvedMapping[fieldKey] = matchedHeader;
                matched += 1;
                if (requiredFieldKeys.has(fieldKey)) {
                    requiredMatched += 1;
                }
            });

            if (!matched) return;

            const requiredTotal = Math.max(1, requiredFieldKeys.size);
            const mappingCoverage = matched / entries.length;
            const requiredCoverage = requiredMatched / requiredTotal;
            const score = mappingCoverage * 0.72 + requiredCoverage * 0.28;

            if (!best || score > best.score) {
                best = {
                    profile,
                    score,
                    matched,
                    total: entries.length,
                    requiredMatched,
                    requiredTotal,
                    resolvedMapping,
                };
            }
        });

    if (!best) return null;
    if (best.score < 0.6 || best.matched < 2) return null;
    return best;
}

function renderImportProfileBanner() {
    const banner = document.getElementById('import-profile-banner');
    const copy = document.getElementById('import-profile-copy');
    if (!banner || !copy) return;

    const suggestion = importState.profileSuggestion;
    if (!suggestion || importState.profileBannerDismissed || !importState.headers.length) {
        banner.classList.add('import-hidden');
        copy.textContent = '';
        return;
    }

    const profileName = String(suggestion.profile?.name || 'Saved profile').trim() || 'Saved profile';
    const confidencePct = Math.round(suggestion.score * 100);
    copy.innerHTML = sanitizeRichHtml(
        `<strong>${escapeHtml(profileName)}</strong> matches this file (${escapeHtml(confidencePct)}% confidence, ${escapeHtml(suggestion.matched)}/${escapeHtml(suggestion.total)} mapped columns).`
    );
    banner.classList.remove('import-hidden');
}

function refreshImportProfileSuggestion() {
    if (!importState.headers.length) {
        importState.profileSuggestion = null;
        renderImportProfileBanner();
        return;
    }

    importState.profileSuggestion = findBestImportProfileSuggestion();
    renderImportProfileBanner();
}

function applySuggestedImportProfile() {
    const suggestion = importState.profileSuggestion;
    if (!suggestion) return;

    const fields = getImportFieldsForType(importState.selectedType);
    const validFieldKeys = new Set(fields.map((field) => field.key));

    const assignments = createEmptyImportAssignments();
    const sources = createEmptyImportAssignments();
    const usedFields = new Set();

    Object.entries(suggestion.resolvedMapping || {}).forEach(([fieldKey, header]) => {
        if (!validFieldKeys.has(fieldKey)) return;
        if (!importState.headers.includes(header)) return;
        if (usedFields.has(fieldKey)) return;
        assignments[header] = fieldKey;
        sources[header] = 'profile';
        usedFields.add(fieldKey);
    });

    importState.columnAssignments = assignments;
    importState.columnSource = sources;
    syncImportMappingFromColumns();
    resetPendingImportPreview();
    updateImportStrictModeUI();

    importState.profileBannerDismissed = true;
    renderImportProfileBanner();
    renderImportMappingUI();
    renderImportPreviewRows();
    setImportSummaryVisible(false);

    const profileId = String(suggestion.profile?.id || '').trim();
    if (profileId) {
        const profiles = readImportProfiles();
        const nextProfiles = profiles.map((profile) => {
            if (String(profile?.id || '').trim() !== profileId) return profile;
            return {
                ...profile,
                lastUsedAt: new Date().toISOString(),
            };
        });
        writeImportProfiles(nextProfiles);
    }

    showNotification('Applied saved profile mapping', 'success');
}

function dismissImportProfileSuggestion() {
    importState.profileBannerDismissed = true;
    renderImportProfileBanner();
}

function saveCurrentImportProfile() {
    if (!importState.headers.length || !importState.allRows.length) {
        showNotification('Upload and map a CSV before saving a profile', 'error');
        return;
    }

    const mapping = readImportMappingFromUI();
    const validationMessage = validateImportMapping(mapping);
    if (validationMessage) {
        showNotification(`${validationMessage}.`, 'error');
        return;
    }

    const mappedEntries = Object.entries(mapping).filter(([, header]) => String(header || '').trim());
    if (!mappedEntries.length) {
        showNotification('No mapped fields to save', 'error');
        return;
    }

    const now = new Date().toISOString();
    const selectedType = normalizeImportType(importState.selectedType);
    const headerFingerprint = getImportHeaderFingerprint(importState.headers);
    const profileName = `${getImportTypeLabel(selectedType)} Mapping`;

    const nextProfilePayload = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        name: profileName,
        type: selectedType,
        headerFingerprint,
        mapping,
        createdAt: now,
        updatedAt: now,
        lastUsedAt: now,
    };

    const profiles = readImportProfiles();
    const existingIndex = profiles.findIndex((profile) => {
        return (
            normalizeImportType(profile?.type) === selectedType &&
            String(profile?.headerFingerprint || '').trim() === headerFingerprint
        );
    });

    if (existingIndex >= 0) {
        const existing = profiles[existingIndex];
        profiles[existingIndex] = {
            ...existing,
            name: existing?.name || profileName,
            mapping,
            updatedAt: now,
            lastUsedAt: now,
        };
    } else {
        profiles.unshift(nextProfilePayload);
    }

    const trimmedProfiles = profiles
        .sort((left, right) => {
            const leftDate = Date.parse(left?.updatedAt || '') || 0;
            const rightDate = Date.parse(right?.updatedAt || '') || 0;
            return rightDate - leftDate;
        })
        .slice(0, IMPORT_MAX_SAVED_PROFILES);

    writeImportProfiles(trimmedProfiles);
    importState.profileBannerDismissed = false;
    refreshImportProfileSuggestion();
    showNotification('Mapping profile saved successfully', 'success');
}

function renderImportSummary(mapping, parityPayload = null) {
    const container = document.getElementById('import-summary-content');
    if (!container) return;

    const validation = getImportMappingValidation(mapping, importState.selectedType);
    const realismPolicy = buildCurrentImportRealismPolicy(mapping);
    const congestionModeLabel = realismPolicy.strictNoFallback
        ? 'Strict (pre-labeled congestion only)'
        : 'Heuristic (Orange thresholds)';
    const mappedRows = validation.fields
        .filter((field) => mapping[field.key])
        .map((field) => {
            const source = importState.mappingSource?.[field.key] || 'manual';
            const sourceLabel = source === 'profile' ? 'profile' : source === 'auto' ? 'auto' : 'manual';
            return `<tr>
                <td>${escapeHtml(field.label)}</td>
                <td>${escapeHtml(mapping[field.key])}</td>
                <td>${escapeHtml(sourceLabel)}</td>
            </tr>`;
        })
        .join('');

    const warnings = [];
    if (importState.selectedType === IMPORT_TYPE_KPI && !hasReferenceDataForKpiImport()) {
        warnings.push('Reference Data has not been loaded. KPI-only imports will not place unmatched cells on the map.');
    }

    const warningHtml = warnings.length
        ? `<div class="import-summary-warning">${warnings.map((warning) => `<div>${escapeHtml(warning)}</div>`).join('')}</div>`
        : '';

    let parityHtml = '';
    if (parityPayload && normalizeImportType(importState.selectedType) === IMPORT_TYPE_KPI) {
        const quality = parityPayload?.data_quality && typeof parityPayload.data_quality === 'object'
            ? parityPayload.data_quality
            : {};

        const rowsProcessed = Math.max(0, Number(quality?.rows_processed ?? 0));
        const rowsDroppedByScope = Math.max(0, Number(quality?.rows_dropped_by_scope ?? 0));
        const rowsWithTa = Math.max(0, Number(quality?.rows_with_ta ?? 0));
        const taCoveragePct = rowsProcessed > 0 ? ((rowsWithTa / rowsProcessed) * 100).toFixed(1) : '0.0';
        const congestedCells = Math.max(0, Number(parityPayload?.stats?.congested ?? 0));

        parityHtml = `
            <div class="import-parity-report">
                <div class="import-parity-title">Parity Report (before map load)</div>
                <div class="import-parity-grid">
                    <div><span>Rows Processed</span><strong>${escapeHtml(rowsProcessed)}</strong></div>
                    <div><span>Dropped By Scope</span><strong>${escapeHtml(rowsDroppedByScope)}</strong></div>
                    <div><span>TA Coverage</span><strong>${escapeHtml(taCoveragePct)}%</strong></div>
                    <div><span>Congestion Mode</span><strong>${escapeHtml(congestionModeLabel)}</strong></div>
                    <div><span>Congested Cells</span><strong>${escapeHtml(congestedCells)}</strong></div>
                </div>
            </div>
        `;
    }

    const sessionCopy = importState.sessionMode === 'current' && state.customDataset.active
        ? 'Current Import Session'
        : 'New Import Session';

    container.innerHTML = sanitizeRichHtml(`
        <div class="import-summary-metrics">
            <div><span>File</span><strong>${escapeHtml(importState.selectedFileName || '-')}</strong></div>
            <div><span>Import Type</span><strong>${escapeHtml(getImportTypeLabel(importState.selectedType))}</strong></div>
            <div><span>Target Session</span><strong>${escapeHtml(sessionCopy)}</strong></div>
            <div><span>Rows</span><strong>${escapeHtml(importState.totalRows || 0)}</strong></div>
            <div><span>Congestion Mode</span><strong>${escapeHtml(congestionModeLabel)}</strong></div>
            <div><span>Mapped Fields</span><strong>${escapeHtml(Object.keys(mapping).length)} / ${escapeHtml(validation.fields.length)}</strong></div>
        </div>
        ${warningHtml}
        <div class="import-summary-table-wrap">
            <table class="import-summary-table">
                <thead>
                    <tr>
                        <th>NetVision Field</th>
                        <th>CSV Column</th>
                        <th>Source</th>
                    </tr>
                </thead>
                <tbody>
                    ${mappedRows || '<tr><td colspan="3">No mapped fields.</td></tr>'}
                </tbody>
            </table>
        </div>
        ${parityHtml}
    `);
}

async function readCsvTextWithProgress(file, onProgress) {
    if (!file) return { csvText: '', rowCount: 0 };

    if (typeof file.stream !== 'function') {
        const csvText = await file.text();
        const lineCount = csvText.split(/\r\n|\n|\r/g).filter((line) => line.trim().length > 0).length;
        const rowCount = Math.max(0, lineCount - 1);
        onProgress?.({ rows: rowCount, done: true, bytesRead: file.size, totalBytes: file.size });
        return { csvText, rowCount };
    }

    const reader = file.stream().getReader();
    const decoder = new TextDecoder();

    let csvText = '';
    let carry = '';
    let lineCount = 0;
    let bytesRead = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        bytesRead += value.byteLength;
        const chunk = decoder.decode(value, { stream: true });
        csvText += chunk;

        const merged = carry + chunk;
        const lines = merged.split(/\r\n|\n|\r/g);
        carry = lines.pop() || '';
        lineCount += lines.filter((line) => line.trim().length > 0).length;

        const bodyRows = Math.max(0, lineCount - 1);
        onProgress?.({ rows: bodyRows, done: false, bytesRead, totalBytes: file.size });
    }

    const tail = decoder.decode();
    if (tail) {
        csvText += tail;
        carry += tail;
    }
    if (carry.trim().length > 0) {
        lineCount += 1;
    }

    const rowCount = Math.max(0, lineCount - 1);
    onProgress?.({ rows: rowCount, done: true, bytesRead: file.size, totalBytes: file.size });
    return { csvText, rowCount };
}

function clearImportSession(options = {}) {
    const keepSelectedType = options.keepSelectedType !== false;
    const clearInput = options.clearInput === true;

    if (!keepSelectedType) {
        importState.selectedType = IMPORT_TYPE_REFERENCE;
    }

    importState.headers = [];
    importState.allRows = [];
    importState.previewRows = [];
    importState.inferredMapping = {};
    importState.matchScores = {};
    importState.mapping = {};
    importState.mappingSource = {};
    importState.columnAssignments = {};
    importState.columnSource = {};
    importState.selectedFileName = '';
    importState.detectedType = IMPORT_TYPE_UNKNOWN;
    importState.detectionReasons = [];
    importState.totalRows = 0;
    importState.profileSuggestion = null;
    importState.profileBannerDismissed = false;
    importState.strictNoFallback = false;
    importState.pendingImportPayload = null;
    importState.pendingImportOptions = null;

    setImportParsingState(false);
    setImportSummaryVisible(false);
    updateImportFileInfo();
    updateImportTypeUI();
    updateImportCrossFileWarning();
    updateImportSessionUI();
    updateImportStrictModeUI();
    updateImportConfirmButtonState();
    renderImportProfileBanner();
    renderImportMappingUI();
    renderImportPreviewRows();

    if (clearInput) {
        const fileInput = document.getElementById('import-csv-file');
        if (fileInput instanceof HTMLInputElement) {
            fileInput.value = '';
        }
    }
}

async function restoreLiveDatasetSession() {
    if (!state.customDataset.active) {
        return true;
    }

    const snapshot = state.liveDatasetSnapshot;
    if (!snapshot) {
        showNotification('Cannot exit import session because no live snapshot is available.', 'warning');
        return false;
    }

    stopUnifiedPlayback();
    if (activeSliceAbortController) {
        activeSliceAbortController.abort();
    }

    state.customDataset = {
        active: false,
        sessionId: '',
        createdAt: '',
        importedFiles: [],
        slices: [],
        realismPolicy: { ...IMPORT_REALISM_POLICY },
        dataQuality: null,
    };

    state.baseline = deepClone(snapshot.baseline || {});
    state.timeIndex = deepClone(snapshot.timeIndex || []);
    state.currentTimeIndex = Number.isInteger(snapshot.currentTimeIndex) ? snapshot.currentTimeIndex : 0;
    state.currentObservations = deepClone(snapshot.currentObservations || {});
    state.currentStats = deepClone(snapshot.currentStats || null);
    state.globalStats = deepClone(snapshot.globalStats || null);
    state.peakHoursByCell = deepClone(snapshot.peakHoursByCell || {});
    state.driftByCell = deepClone(snapshot.driftByCell || {});
    state.driftAlerts = Array.isArray(snapshot.driftAlerts) ? deepClone(snapshot.driftAlerts) : [];
    state.lastVisibleFilterSignature = null;
    state.lastCongestedCount = null;

    forecastState.forecastIndex = deepClone(snapshot.forecastIndex || []);
    forecastState.available = Boolean(snapshot.forecastAvailable);

    await buildSiteHierarchy();

    const frequencyBands = Array.from(new Set(
        Object.values(state.baseline || {})
            .map((cell) => Number(cell?.frequency_band))
            .filter((band) => Number.isFinite(band))
    )).sort((a, b) => a - b);

    populateFrequencyFilters(frequencyBands);

    const { pointFeatures, sectorFeatures } = buildFeaturesForTime();
    state.pointFeatures = pointFeatures;
    state.sectorFeatures = sectorFeatures;
    state.features = pointFeatures;
    state.filteredPointFeatures = pointFeatures;
    state.filteredSectorFeatures = sectorFeatures;
    state.needsPointGeometrySync = true;
    state.needsSectorGeometrySync = true;
    featureStateCache.cells.clear();

    if (state.selectedSite && !state.siteHierarchy[state.selectedSite]) {
        state.selectedSite = null;
    }
    if (state.selectedCellName && !state.baseline[state.selectedCellName]) {
        state.selectedCellName = null;
        renderActionPanel(state.selectedCellName);
    }
    recommendationCache.clear();

    updateDriftAlertsUI();

    await checkForecastAvailability();
    updateUnifiedTimeline();

    if (unifiedTimeline.totalCount > 0) {
        const maxIndex = Math.max(0, unifiedTimeline.totalCount - 1);
        const targetIndex = Math.min(state.currentTimeIndex, maxIndex);
        await loadUnifiedTimeSlice(targetIndex);
    } else {
        applyFilters();
        updateStatsUI(state.currentStats || {});
        updateAlertsUI(state.filteredPointFeatures);
        updateMapData();
    }

    populateIssueFilters(collectIssueTypesFromCurrent());
    applyFilters();

    importState.sessionMode = 'new';
    state.liveDatasetSnapshot = null;
    updateImportSessionUI();
    return true;
}

async function applyImportedDataset(datasetPayload, options = {}) {
    const sessionMode = normalizeImportSessionMode(options.sessionMode || importState.sessionMode);
    const sourceFileName = String(options.sourceFileName || importState.selectedFileName || '').trim();
    const realismPolicy = {
        ...IMPORT_REALISM_POLICY,
        ...(state.customDataset?.realismPolicy || {}),
        ...(options.realismPolicy || {}),
    };

    if (sessionMode === 'new') {
        if (!state.customDataset.active) {
            captureLiveDatasetSnapshot();
        } else if (!state.liveDatasetSnapshot) {
            showNotification('Live snapshot is unavailable, continuing from current import state.', 'warning');
        }
    } else if (!state.customDataset.active) {
        captureLiveDatasetSnapshot();
    }

    stopUnifiedPlayback();
    if (activeSliceAbortController) {
        activeSliceAbortController.abort();
    }

    const incomingSlices = normalizeImportSlices(datasetPayload);
    const incomingImportType = normalizeImportType(datasetPayload?.import_type, true);
    const canMergeWithCurrentSession = sessionMode === 'current' && state.customDataset.active;
    let finalSlices = canMergeWithCurrentSession
        ? mergeImportSlices(state.customDataset.slices, incomingSlices)
        : incomingSlices;

    if (incomingImportType === IMPORT_TYPE_KPI) {
        finalSlices = finalSlices.filter((slice) => String(slice?.timestamp || '').trim() !== 'Reference import snapshot');
    }

    if (!finalSlices.length) {
        showNotification('Import produced no valid timestamped slices. Timeline was not updated.', 'error');
        return false;
    }

    const safeSlices = finalSlices;

    const incomingBaseline = datasetPayload?.baseline && typeof datasetPayload.baseline === 'object'
        ? datasetPayload.baseline
        : {};
    const baseline = canMergeWithCurrentSession
        ? { ...(state.baseline || {}), ...incomingBaseline }
        : incomingBaseline;

    const sessionId = canMergeWithCurrentSession && state.customDataset.sessionId
        ? state.customDataset.sessionId
        : `import_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const sessionCreatedAt = canMergeWithCurrentSession && state.customDataset.createdAt
        ? state.customDataset.createdAt
        : new Date().toISOString();

    const importedFiles = canMergeWithCurrentSession && Array.isArray(state.customDataset.importedFiles)
        ? [...state.customDataset.importedFiles]
        : [];
    if (sourceFileName && !importedFiles.includes(sourceFileName)) {
        importedFiles.push(sourceFileName);
    }

    const latestSlice = safeSlices[safeSlices.length - 1];

    let preferredSliceIndex = Math.max(0, safeSlices.length - 1);
    const latestMetricSamples = getSliceMetricSampleCount(latestSlice?.observations || {});
    if (latestMetricSamples === 0 && safeSlices.length > 1) {
        for (let index = safeSlices.length - 2; index >= 0; index -= 1) {
            const metricSamples = getSliceMetricSampleCount(safeSlices[index]?.observations || {});
            if (metricSamples > 0) {
                preferredSliceIndex = index;
                break;
            }
        }
    }

    const preferredSlice = safeSlices[preferredSliceIndex] || latestSlice;

    state.baseline = baseline;
    state.customDataset.active = true;
    state.customDataset.sessionId = sessionId;
    state.customDataset.createdAt = sessionCreatedAt;
    state.customDataset.importedFiles = importedFiles;
    state.customDataset.slices = safeSlices;
    state.customDataset.realismPolicy = realismPolicy;
    state.customDataset.dataQuality = datasetPayload?.data_quality && typeof datasetPayload.data_quality === 'object'
        ? datasetPayload.data_quality
        : null;

    state.timeIndex = safeSlices.map((slice, index) => ({
        timestamp: slice.timestamp,
        filename: `__custom_import__${index}`,
        stats: slice.stats || {},
    }));
    state.currentTimeIndex = preferredSliceIndex;
    state.currentObservations = preferredSlice?.observations || {};
    state.currentStats = preferredSlice?.stats || {};
    state.lastVisibleFilterSignature = null;
    state.lastCongestedCount = null;

    if (state.selectedCellName && !baseline[state.selectedCellName]) {
        state.selectedCellName = null;
        renderActionPanel(state.selectedCellName);
    }
    recommendationCache.clear();

    forecastState.forecastIndex = [];
    forecastState.available = false;

    const frequencyBands = Array.from(new Set(
        Object.values(baseline)
            .map((cell) => Number(cell?.frequency_band))
            .filter((band) => Number.isFinite(band))
    )).sort((a, b) => a - b);

    state.globalStats = {
        total_timestamps: state.timeIndex.length,
        total_cells: Object.keys(baseline).length,
        frequency_bands: frequencyBands,
    };

    await buildSiteHierarchy();
    if (state.selectedSite && !state.siteHierarchy[state.selectedSite]) {
        state.selectedSite = null;
    }

    populateFrequencyFilters(frequencyBands);
    const { pointFeatures, sectorFeatures } = buildFeaturesForTime();
    state.pointFeatures = pointFeatures;
    state.sectorFeatures = sectorFeatures;
    state.features = pointFeatures;
    state.filteredPointFeatures = pointFeatures;
    state.filteredSectorFeatures = sectorFeatures;
    state.needsPointGeometrySync = true;
    state.needsSectorGeometrySync = true;
    featureStateCache.cells.clear();

    updateDriftAlertsUI();
    updateUnifiedTimeline();

    const maxIndex = Math.max(0, unifiedTimeline.totalCount - 1);
    const targetIndex = Math.min(Math.max(0, state.currentTimeIndex), maxIndex);
    if (unifiedTimeline.totalCount > 0) {
        await loadUnifiedTimeSlice(targetIndex);
    } else {
        applyFilters();
        updateStatsUI(state.currentStats || {});
        updateAlertsUI(state.filteredPointFeatures);
        updateMapData();
    }

    populateIssueFilters(collectIssueTypesFromCurrent());
    applyFilters();

    importState.sessionMode = 'current';
    updateImportSessionUI();

    const importedCells = Number(
        datasetPayload?.imported_cells ||
        Object.keys(latestSlice?.observations || {}).length ||
        Object.keys(baseline || {}).length
    );
    const errorCount = Array.isArray(datasetPayload?.errors) ? datasetPayload.errors.length : 0;
    const sessionCopy = canMergeWithCurrentSession ? 'updated current import session' : 'started new import session';

    showNotification(
        `Imported ${importedCells} cells and ${sessionCopy}${errorCount ? ` (${errorCount} row warnings)` : ''}`,
        'success'
    );

    const taHiddenCount = Number(state.customDataset.dataQuality?.rows_without_ta ?? 0);
    if (realismPolicy.hideSectorsWithoutTa && taHiddenCount > 0) {
        showNotification(
            `${taHiddenCount} KPI rows are missing TA. Sector radius stays static for those cells.`,
            'info'
        );
    }

    if (safeSlices.length <= 1) {
        showNotification('Only one timestamp is available in this import. Playback and date stepping are limited.', 'info');
    }

    return true;
}

async function parseImportCsvFile(file) {
    if (!file) return;

    clearImportSession({ keepSelectedType: true, clearInput: false });

    importState.selectedFileName = file.name;
    updateImportFileInfo();
    setImportBusyState(true);
    setImportParsingState(true, 'Parsing CSV, please wait...', 0);

    try {
        const readResult = await readCsvTextWithProgress(file, (progress) => {
            const rows = Number(progress?.rows || 0);
            importState.totalRows = Math.max(importState.totalRows, rows);
            updateImportFileInfo();
            setImportParsingState(true, 'Parsing CSV, please wait...', importState.totalRows);
        });

        const parsed = await callDataWorker(
            'parseCsvPreview',
            { csvText: readResult.csvText, maxPreviewRows: IMPORT_PREVIEW_ROW_LIMIT },
            120000
        );

        importState.headers = Array.isArray(parsed?.headers) ? parsed.headers : [];
        importState.previewRows = Array.isArray(parsed?.previewRows) ? parsed.previewRows : [];
        importState.allRows = Array.isArray(parsed?.allRows) ? parsed.allRows : [];
        importState.inferredMapping = parsed?.inferredMapping || {};
        importState.matchScores = parsed?.matchScores || {};
        importState.detectedType = normalizeImportType(parsed?.detectedType, true);
        importState.detectionReasons = Array.isArray(parsed?.detectionReasons) ? parsed.detectionReasons : [];
        importState.totalRows = Number(parsed?.totalRows) || readResult.rowCount || 0;

        if (importState.detectedType === IMPORT_TYPE_REFERENCE || importState.detectedType === IMPORT_TYPE_KPI) {
            importState.selectedType = importState.detectedType;
        } else {
            importState.selectedType = IMPORT_TYPE_REFERENCE;
        }

        applyAutoImportAssignments(importState.selectedType);
        importState.profileBannerDismissed = false;

        updateImportFileInfo();
        updateImportTypeUI();
        updateImportCrossFileWarning();
        updateImportStrictModeUI();
        updateImportConfirmButtonState();
        refreshImportProfileSuggestion();
        renderImportMappingUI();
        renderImportPreviewRows();
    } finally {
        setImportParsingState(false);
        setImportBusyState(false);
    }
}

function runCsvImport() {
    if (!importState.allRows.length) {
        showNotification('Upload a CSV file before importing', 'error');
        return;
    }

    const mapping = readImportMappingFromUI();
    const validationError = validateImportMapping(mapping);
    if (validationError) {
        showNotification(validationError, 'error');
        renderImportMappingUI();
        renderImportPreviewRows();
        return;
    }

    resetPendingImportPreview();
    updateImportStrictModeUI();
    renderImportSummary(mapping);
    setImportSummaryVisible(true);
}

async function confirmCsvImport() {
    if (!importState.allRows.length) {
        showNotification('Upload a CSV file before importing', 'error');
        setImportSummaryVisible(false);
        return;
    }

    const mapping = readImportMappingFromUI();
    const validationError = validateImportMapping(mapping);
    if (validationError) {
        showNotification(validationError, 'error');
        setImportSummaryVisible(false);
        renderImportMappingUI();
        renderImportPreviewRows();
        return;
    }

    const realismPolicy = buildCurrentImportRealismPolicy(mapping);

    if (
        importState.selectedType === IMPORT_TYPE_KPI &&
        realismPolicy.strictScopeToReference &&
        !hasReferenceDataForKpiImport()
    ) {
        showNotification(
            'Reference Data must exist in this import session before KPI Hourly Data can be loaded.',
            'error'
        );
        setImportSummaryVisible(false);
        return;
    }

    setImportBusyState(true);

    try {
        const stagedPayload = importState.pendingImportPayload;
        const stagedOptions = importState.pendingImportOptions;
        if (stagedPayload && stagedOptions) {
            const applied = await applyImportedDataset(stagedPayload, stagedOptions);
            if (!applied) {
                return;
            }
            clearImportSession({ keepSelectedType: true, clearInput: true });
            toggleModal('import-modal', false);
            return;
        }

        const existingBaseline = getBaselineForImportSession(importState.selectedType, importState.sessionMode);

        const payload = await callDataWorker(
            'applyCsvMapping',
            {
                rows: importState.allRows,
                mapping,
                importType: importState.selectedType,
                existingBaseline,
                realismPolicy,
            },
            90000
        );

        const warnings = Array.isArray(payload?.warnings) ? payload.warnings : [];
        warnings.forEach((warning) => showNotification(String(warning), 'warning'));

        if (importState.selectedType === IMPORT_TYPE_KPI) {
            const rowsProcessed = Number(payload?.data_quality?.rows_processed ?? 0);
            const hasSlices = Array.isArray(payload?.slices) && payload.slices.length > 0;
            if (!hasSlices || rowsProcessed <= 0) {
                showNotification(
                    'KPI import has no valid timestamped rows after strict validation. Check timestamp mapping and reference scope.',
                    'error'
                );
                return;
            }

            importState.pendingImportPayload = payload;
            importState.pendingImportOptions = {
                sessionMode: importState.sessionMode,
                sourceFileName: importState.selectedFileName,
                realismPolicy,
            };
            renderImportSummary(mapping, payload);
            updateImportConfirmButtonState();
            showNotification('Parity report generated. Review it, then click Load Imported Session.', 'info');
            return;
        }

        const applied = await applyImportedDataset(payload, {
            sessionMode: importState.sessionMode,
            sourceFileName: importState.selectedFileName,
            realismPolicy,
        });
        if (!applied) {
            return;
        }
        clearImportSession({ keepSelectedType: true, clearInput: true });
        toggleModal('import-modal', false);
    } catch (err) {
        console.error('CSV import failed:', err);
        showNotification('CSV import failed. Verify mapping and numeric fields.', 'error');
    } finally {
        setImportBusyState(false);
    }
}

function openImportModal() {
    resetPendingImportPreview();
    setImportSummaryVisible(false);
    updateImportTypeUI();
    updateImportCrossFileWarning();
    updateImportSessionUI();
    updateImportStrictModeUI();
    updateImportConfirmButtonState();
    renderImportMappingUI();
    renderImportPreviewRows();
    toggleModal('import-modal', true);
}

function setupImportModal() {
    document.getElementById('btn-import')?.addEventListener('click', openImportModal);
    document.getElementById('import-close')?.addEventListener('click', () => {
        resetPendingImportPreview();
        setImportSummaryVisible(false);
        toggleModal('import-modal', false);
    });

    const fileInput = document.getElementById('import-csv-file');
    fileInput?.addEventListener('change', async (event) => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || !input.files || !input.files[0]) {
            return;
        }

        const selectedFile = input.files[0];
        input.value = '';

        try {
            await parseImportCsvFile(selectedFile);
        } catch (err) {
            console.error('Failed to parse CSV file:', err);
            showNotification('CSV parsing failed. Please verify the file format.', 'error');
            setImportParsingState(false);
            setImportBusyState(false);
        }
    });

    document.getElementById('import-type-select')?.addEventListener('change', (event) => {
        const select = event.target;
        if (!(select instanceof HTMLSelectElement)) return;

        importState.selectedType = normalizeImportType(select.value);
        resetPendingImportPreview();
        setImportSummaryVisible(false);

        if (importState.headers.length) {
            applyAutoImportAssignments(importState.selectedType);
            importState.profileBannerDismissed = false;
            refreshImportProfileSuggestion();
        }

        updateImportTypeUI();
        updateImportCrossFileWarning();
        updateImportStrictModeUI();
        renderImportMappingUI();
        renderImportPreviewRows();
    });

    document.getElementById('import-session-mode')?.addEventListener('change', (event) => {
        const select = event.target;
        if (!(select instanceof HTMLSelectElement)) return;
        importState.sessionMode = normalizeImportSessionMode(select.value);
        resetPendingImportPreview();
        setImportSummaryVisible(false);
        updateImportSessionUI();
        updateImportCrossFileWarning();
    });

    document.getElementById('import-strict-mode-toggle')?.addEventListener('change', (event) => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement)) return;

        importState.strictNoFallback = input.checked;
        resetPendingImportPreview();
        updateImportStrictModeUI();

        const summarySection = document.getElementById('import-summary-section');
        if (summarySection && !summarySection.classList.contains('import-hidden')) {
            const mapping = readImportMappingFromUI();
            renderImportSummary(mapping);
        }
    });

    document.getElementById('btn-import-reset')?.addEventListener('click', () => {
        clearImportSession({ keepSelectedType: true, clearInput: true });
        showNotification('Current import has been cleared', 'success');
    });

    document.getElementById('btn-import-exit-session')?.addEventListener('click', async () => {
        if (!state.customDataset.active) {
            updateImportSessionUI();
            showNotification('Live dataset is already active', 'info');
            return;
        }

        setImportBusyState(true);
        try {
            const restored = await restoreLiveDatasetSession();
            if (restored) {
                clearImportSession({ keepSelectedType: true, clearInput: true });
                showNotification('Returned to live dataset session', 'success');
            }
        } catch (err) {
            console.error('Failed to restore live dataset session:', err);
            showNotification('Failed to exit import session', 'error');
        } finally {
            setImportBusyState(false);
            updateImportSessionUI();
        }
    });

    document.getElementById('btn-import-save-profile')?.addEventListener('click', saveCurrentImportProfile);
    document.getElementById('btn-import-profile-confirm')?.addEventListener('click', applySuggestedImportProfile);
    document.getElementById('btn-import-profile-dismiss')?.addEventListener('click', dismissImportProfileSuggestion);

    document.getElementById('btn-import-back')?.addEventListener('click', () => {
        resetPendingImportPreview();
        setImportSummaryVisible(false);
    });

    document.getElementById('btn-import-confirm')?.addEventListener('click', confirmCsvImport);
    document.getElementById('btn-apply-import')?.addEventListener('click', runCsvImport);

    clearImportSession({ keepSelectedType: true, clearInput: true });
    updateImportSessionUI();
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
    if (state.customDataset.active) {
        forecastState.available = false;
        forecastState.forecastIndex = [];
        updateUnifiedTimeline();
        return { available: false, reason: 'custom-dataset-active' };
    }

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
    updateUnifiedTimelineControlsState();
}

function updateUnifiedTimelineControlsState() {
    const slider = document.getElementById('time-slider');
    const prevBtn = document.getElementById('time-prev');
    const nextBtn = document.getElementById('time-next');
    const playBtn = document.getElementById('time-play');

    const total = Number(unifiedTimeline.totalCount || 0);
    const hasTimeline = total > 0;
    const canStep = total > 1;
    const current = Math.max(0, Math.min(unifiedTimeline.currentIndex, Math.max(0, total - 1)));

    if (slider) {
        slider.min = 0;
        slider.max = Math.max(0, total - 1);
        slider.value = current;
        slider.disabled = !hasTimeline;
    }

    if (prevBtn instanceof HTMLButtonElement) {
        prevBtn.disabled = !canStep || current <= 0;
    }
    if (nextBtn instanceof HTMLButtonElement) {
        nextBtn.disabled = !canStep || current >= total - 1;
    }
    if (playBtn instanceof HTMLButtonElement) {
        playBtn.disabled = !canStep;
    }
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
    if (startLabel) {
        startLabel.textContent = state.timeIndex.length > 0
            ? state.timeIndex[0]?.timestamp || '--'
            : '--';
    }
    
    // End label from forecast (if available) or historical
    if (endLabel) {
        if (forecastState.forecastIndex.length > 0) {
            endLabel.textContent = forecastState.forecastIndex[forecastState.forecastIndex.length - 1]?.timestamp || '--';
        } else if (state.timeIndex.length > 0) {
            endLabel.textContent = state.timeIndex[state.timeIndex.length - 1]?.timestamp || '--';
        } else {
            endLabel.textContent = '--';
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
    return loadUnifiedTimeSliceInternal(index, { skipIfLoading: false });
}

async function loadUnifiedTimeSliceInternal(index, options = {}) {
    const { skipIfLoading = false } = options;
    if (index < 0 || index >= unifiedTimeline.totalCount) return;

    if (skipIfLoading && state.isLoadingSlice) {
        return;
    }
    
    if (activeSliceAbortController) {
        activeSliceAbortController.abort();
    }
    activeSliceAbortController = new AbortController();
    const requestId = ++activeSliceRequestId;
    const { signal } = activeSliceAbortController;
    state.isLoadingSlice = true;

    try {
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
        updateUnifiedTimelineControlsState();
    } finally {
        if (requestId === activeSliceRequestId) {
            state.isLoadingSlice = false;
        }
    }
}

async function loadHistoricalSliceInternal(timeEntry, localIndex, requestContext = {}) {
    if (!timeEntry) return;
    const { signal, requestId } = requestContext;

    if (state.customDataset.active) {
        const customSlice = state.customDataset.slices[localIndex] || null;
        if (!customSlice) return;
        state.currentTimeIndex = localIndex;
        state.currentObservations = customSlice.observations || {};
        state.currentStats = customSlice.stats || null;

        await updateFeaturesForTime(state.currentObservations, { isForecast: false });
        applyFilters();
        updateTimeSliderUI();
        updateStatsUI(customSlice.stats || {});
        updateAlertsUI(state.filteredPointFeatures);
        if (state.selectedSite) {
            refreshSiteInfoStats(state.selectedSite);
        }
        return;
    }
    
    try {
        const res = await fetchWithAuth(buildDataUrl('time_data', timeEntry.filename), { signal });
        const sliceData = await res.json();
        if (!res.ok) {
            throw new Error(sliceData.error || `HTTP error ${res.status}`);
        }
        if (signal?.aborted || requestId !== activeSliceRequestId) return;
        
        state.currentTimeIndex = localIndex;
        warnIfObservationSchemaMismatch(sliceData.observations, `historical slice ${timeEntry.timestamp || timeEntry.filename}`);
        state.currentObservations = sliceData.observations;
        state.currentStats = sliceData.stats;

        await updateFeaturesForTime(sliceData.observations, { isForecast: false });
        applyFilters();
        
        updateTimeSliderUI();
        updateStatsUI(sliceData.stats);
        updateAlertsUI(state.filteredPointFeatures);
        
        if (state.selectedSite) {
            refreshSiteInfoStats(state.selectedSite);
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
        const res = await fetchWithAuth(buildDataUrl('forecast_data', forecastEntry.filename), { signal });
        const sliceData = await res.json();
        if (!res.ok) {
            throw new Error(sliceData.error || `HTTP error ${res.status}`);
        }
        if (signal?.aborted || requestId !== activeSliceRequestId) return;
        
        warnIfObservationSchemaMismatch(sliceData.observations || {}, `forecast slice ${forecastEntry.timestamp || forecastEntry.filename}`);
        state.currentObservations = sliceData.observations || {};
        state.currentStats = sliceData.stats || forecastEntry.stats;
        
        const confidence = sliceData.confidence || forecastEntry.confidence || 0.75;

        await updateFeaturesForTime(sliceData.observations || {}, { isForecast: true, confidence });
        applyFilters();
        
        updateTimeSliderUI();
        updateStatsUI(sliceData.stats || forecastEntry.stats);
        updateAlertsUI(state.filteredPointFeatures);
        
        if (state.selectedSite) {
            refreshSiteInfoStats(state.selectedSite);
        }
    } catch (err) {
        if (err?.name === 'AbortError') return;
        console.error('Failed to load forecast slice:', err);
        showNotification('Failed to load forecast data', 'error');
    }
}

async function generateForecast() {
    if (forecastState.isGenerating) return;
    if (state.customDataset.active) {
        showNotification('Forecast generation is disabled for imported CSV snapshots.', 'info');
        return;
    }
    
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
    if (state.customDataset.active) {
        showNotification('No generated forecast is attached to imported CSV snapshots.', 'info');
        return;
    }
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

function stopUnifiedPlayback() {
    if (state.playInterval) {
        clearInterval(state.playInterval);
        state.playInterval = null;
    }
    state.isPlaying = false;

    const playBtn = document.getElementById('time-play');
    const icon = playBtn?.querySelector('.material-symbols-outlined');
    playBtn?.classList.remove('playing');
    if (icon) {
        icon.textContent = 'play_arrow';
    }

    setSectorGeometryResolution(CONFIG.SECTOR_ARC_STEPS_DEFAULT);
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
        if (unifiedTimeline.totalCount <= 1) {
            showNotification('Playback requires at least two timestamps.', 'info');
            return;
        }

        state.isPlaying = !state.isPlaying;
        const icon = playBtn.querySelector('.material-symbols-outlined');
        
        if (state.isPlaying) {
            playBtn.classList.add('playing');
            if (icon) icon.textContent = 'pause';
            setSectorGeometryResolution(CONFIG.SECTOR_ARC_STEPS_PLAYBACK);
            const interval = CONFIG.PLAY_INTERVAL_MS / Math.max(0.25, state.playSpeed);
            state.playInterval = setInterval(() => {
                if (state.isLoadingSlice) return;
                if (unifiedTimeline.currentIndex < unifiedTimeline.totalCount - 1) {
                    loadUnifiedTimeSliceInternal(unifiedTimeline.currentIndex + 1, { skipIfLoading: true });
                } else {
                    loadUnifiedTimeSliceInternal(0, { skipIfLoading: true });  // Loop back
                }
            }, interval);
        } else {
            playBtn.classList.remove('playing');
            if (icon) icon.textContent = 'play_arrow';
            clearInterval(state.playInterval);
            state.playInterval = null;
            setSectorGeometryResolution(CONFIG.SECTOR_ARC_STEPS_DEFAULT);
            updateMapData();
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

    const cellsSource = state.map.getSource('cells');
    const sectorsSource = state.map.getSource('sectors');
    if (!cellsSource || !sectorsSource) return;

    if (state.needsPointGeometrySync) {
        const pointsGeojson = { type: 'FeatureCollection', features: state.pointFeatures };
        cellsSource.setData(pointsGeojson);
        state.needsPointGeometrySync = false;
        state.lastVisibleFilterSignature = null;
    }

    const sectorsVisible = !state.layers.heatmap;
    if (sectorsVisible || state.needsSectorGeometrySync) {
        const sectorsGeojson = { type: 'FeatureCollection', features: state.filteredSectorFeatures };
        sectorsSource.setData(sectorsGeojson);
        state.needsSectorGeometrySync = false;
    }

    const visibleIds = state.filteredPointFeatures
        .map(feature => Number(feature.id))
        .filter(id => Number.isInteger(id));

    const visibleSignature = visibleIds.join(',');
    if (state.lastVisibleFilterSignature !== visibleSignature) {
        state.lastVisibleFilterSignature = visibleSignature;
        const filterExpr = visibleIds.length
            ? ['in', ['id'], ['literal', visibleIds]]
            : ['==', ['id'], -1];

        ['cells-heatmap', 'cells-points', 'cells-labels', 'cells-congested-ring']
            .forEach((layerId) => {
                if (state.map.getLayer(layerId)) {
                    state.map.setFilter(layerId, filterExpr);
                }
            });
    }

    state.pointFeatures.forEach((feature) => {
        const id = Number(feature?.id);
        if (!Number.isInteger(id)) return;
        const props = feature?.properties || {};
        const nextState = {
            color: props.color ?? CONFIG.COLORS.NO_DATA,
            opacity: Number.isFinite(Number(props.opacity)) ? Number(props.opacity) : 0.4,
            congested: Boolean(props.congested),
            load: Number.isFinite(Number(props.load)) ? Number(props.load) : 0
        };

        const prevState = featureStateCache.cells.get(id);
        if (
            prevState &&
            prevState.color === nextState.color &&
            prevState.opacity === nextState.opacity &&
            prevState.congested === nextState.congested &&
            prevState.load === nextState.load
        ) {
            return;
        }

        state.map.setFeatureState({ source: 'cells', id }, nextState);
        featureStateCache.cells.set(id, nextState);
    });
}

function updateTimeSliderUI() {
    // Update the current time label in the slider
    const data = getDataForIndex(unifiedTimeline.currentIndex);
    const isForecast = data.type === 'forecast';
    
    const currentLabel = document.getElementById('time-current-label');
    if (currentLabel) {
        if (data.entry) {
            const label = isForecast 
                ? `${data.entry.timestamp} (Forecast)` 
                : data.entry.timestamp;
            currentLabel.textContent = label || '--';
        } else {
            currentLabel.textContent = '--';
        }
    }
    
    const timestampEl = document.getElementById('timestamp');
    if (timestampEl) {
        timestampEl.textContent = data?.entry?.timestamp || '--';
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
    const observedCells = Number(stats?.cells_observed || 0);
    const congestedCells = Number(stats?.congested || 0);
    const avgLoad = Number(stats?.avg_load || 0);
    const highLoadEstimate = Math.round((avgLoad > 70 ? observedCells * 0.3 : observedCells * 0.15));
    const coveragePct = totalCells > 0 ? Math.round((observedCells / totalCells) * 100) : 0;
    
    document.querySelector('#stat-total .stat-value').textContent = formatLargeNumber(totalCells);
    document.querySelector('#stat-congested .stat-value').textContent = formatLargeNumber(congestedCells);
    document.querySelector('#stat-high-load .stat-value').textContent = formatLargeNumber(highLoadEstimate);
    document.querySelector('#stat-healthy .stat-value').textContent = formatLargeNumber(
        observedCells - congestedCells
    );
    
    document.getElementById('metric-avg-load').textContent = (stats?.avg_load || 0).toFixed(1) + '%';
    document.getElementById('progress-load').style.width = Math.min(stats?.avg_load || 0, 100) + '%';
    document.getElementById('metric-avg-throughput').textContent = formatThroughput(stats?.avg_throughput);
    document.getElementById('metric-avg-cqi').textContent = (stats?.avg_cqi || 0).toFixed(1);
    document.getElementById('metric-coverage').textContent = `${coveragePct}%`;
    
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

    if (state.lastCongestedCount === congested.length) {
        return;
    }
    state.lastCongestedCount = congested.length;
    
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

function updateDriftAlertsUI() {
    const list = document.getElementById('drift-alerts-list');
    const badge = document.getElementById('drift-alert-count');
    if (!list) return;

    const alerts = Array.isArray(state.driftAlerts) ? state.driftAlerts : [];
    if (badge) badge.textContent = String(alerts.length);

    if (!alerts.length) {
        list.innerHTML = '<div class="alert-placeholder">No forecast drift above threshold</div>';
        return;
    }

    list.innerHTML = '';
    const fragment = document.createDocumentFragment();
    alerts.slice(0, 40).forEach((alert) => {
        const item = document.createElement('div');
        item.className = 'alert-item drift-alert-item';
        item.dataset.cellName = String(alert?.cell_name || '');

        const icon = document.createElement('span');
        icon.className = 'material-symbols-outlined';
        icon.textContent = alert?.severity === 'critical' ? 'crisis_alert' : 'monitoring';

        const content = document.createElement('div');
        content.className = 'alert-item-content';

        const title = document.createElement('div');
        title.className = 'alert-item-title';
        title.textContent = String(alert?.cell_name || 'Unknown cell');

        const desc = document.createElement('div');
        desc.className = 'alert-item-desc';
        desc.textContent = `Delta ${formatNumber(alert?.last_abs_delta, 1)} PRB (${formatNumber(alert?.last_pct_delta, 1)}%)`;

        content.appendChild(title);
        content.appendChild(desc);
        item.appendChild(icon);
        item.appendChild(content);
        fragment.appendChild(item);
    });

    list.appendChild(fragment);
    list.querySelectorAll('.drift-alert-item').forEach((item) => {
        const cellName = item.dataset.cellName;
        if (cellName) {
            item.addEventListener('click', () => selectCell(cellName, true));
        }
    });
}

async function refreshDriftAlertsFromUI() {
    const absInput = document.getElementById('drift-threshold-abs');
    const pctInput = document.getElementById('drift-threshold-pct');
    const absRaw = absInput instanceof HTMLInputElement ? Number(absInput.value) : NaN;
    const pctRaw = pctInput instanceof HTMLInputElement ? Number(pctInput.value) : NaN;

    state.driftThresholds.absPrbDelta = Number.isFinite(absRaw) && absRaw > 0 ? absRaw : state.driftThresholds.absPrbDelta;
    state.driftThresholds.pctPrbDelta = Number.isFinite(pctRaw) && pctRaw > 0 ? pctRaw : state.driftThresholds.pctPrbDelta;

    if (absInput instanceof HTMLInputElement) {
        absInput.value = String(state.driftThresholds.absPrbDelta);
    }
    if (pctInput instanceof HTMLInputElement) {
        pctInput.value = String(state.driftThresholds.pctPrbDelta);
    }

    await loadDriftAlerts();
}

function destroyCharts() {
    Object.keys(state.charts).forEach(k => {
        if (state.charts[k]) {
            state.charts[k].destroy();
            state.charts[k] = null;
        }
    });
}

function upsertAnalyticsChart(chartKey, ctx, config) {
    const existing = state.charts[chartKey];
    if (existing) {
        existing.config.type = config.type;
        existing.data = config.data;
        existing.options = config.options;
        existing.update('none');
        return;
    }
    state.charts[chartKey] = new Chart(ctx, config);
}

function updateAnalyticsCharts(features) {
    const issueCtx = document.getElementById('chart-issues');
    const sevCtx = document.getElementById('chart-severity');
    const bandCtx = document.getElementById('chart-bands');
    const loadCtx = document.getElementById('chart-load');
    if (!issueCtx || !sevCtx || !bandCtx || !loadCtx) return;

    // Issue distribution
    const issueCounts = {};
    features.forEach(f => {
        const type = f.properties.issue_type || 'Normal';
        issueCounts[type] = (issueCounts[type] || 0) + 1;
    });

    upsertAnalyticsChart('issues', issueCtx, {
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

    upsertAnalyticsChart('severity', sevCtx, {
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

    upsertAnalyticsChart('bands', bandCtx, {
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

    upsertAnalyticsChart('load', loadCtx, {
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
    if (id === 'analytics-modal') {
        state.analyticsModalOpen = !!show;
        if (state.analyticsModalOpen) {
            updateAnalyticsCharts(state.filteredPointFeatures);
        }
    }
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
        antialias: false
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
            'fill-opacity': ['coalesce', ['get', 'opacity'], 0.45]
        }
    });
    
    map.addLayer({
        id: 'sectors-outline',
        type: 'line',
        source: 'sectors',
        minzoom: 12,
        paint: {
            'line-color': '#f3f3f3',
            'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.5, 15, 1.1],
            'line-opacity': [
                'case',
                ['==', ['get', 'status'], 'no-data'],
                0.03,
                ['interpolate', ['linear'], ['zoom'], 12, 0.09, 15, 0.2]
            ]
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
            'heatmap-weight': ['interpolate', ['linear'], ['coalesce', ['feature-state', 'load'], ['get', 'load'], 0], 0, 0.1, 100, 1],
            'heatmap-radius': [
                'interpolate',
                ['exponential', 2],
                ['zoom'],
                0, 1,
                10, 10,
                15, 100
            ],
            'heatmap-intensity': [
                'interpolate',
                ['linear'],
                ['zoom'],
                10, 1,
                15, 5
            ],
            'heatmap-opacity': [
                'interpolate',
                ['linear'],
                ['zoom'],
                8, CONFIG.HEATMAP_OPACITY,
                15, 0.95
            ],
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
            'circle-color': ['coalesce', ['feature-state', 'color'], ['get', 'color'], CONFIG.COLORS.NO_DATA],
            'circle-opacity': ['coalesce', ['feature-state', 'opacity'], ['get', 'opacity'], 0.8],
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
        paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 6, 12, 9, 16, 14],
            'circle-color': 'rgba(0,0,0,0)',
            'circle-stroke-color': CONFIG.COLORS.CONGESTED,
            'circle-stroke-width': 3,
            'circle-stroke-opacity': [
                'case',
                ['coalesce', ['feature-state', 'congested'], ['get', 'congested'], false],
                1,
                0
            ]
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
        const p = getLivePointProperties(feature);
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
        const feature = e.features?.[0];
        if (!feature) return;
        const p = getLivePointProperties(feature);
        const popupRoot = document.createElement('div');
        popupRoot.style.padding = '10px';
        popupRoot.style.fontFamily = 'IBM Plex Sans, Segoe UI, sans-serif';
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
            `Peak Hour: ${p.peak_hour || 'N/A'}`,
            `Drift: ${p.drift_abs_delta !== null && p.drift_abs_delta !== undefined ? `${formatNumber(p.drift_abs_delta, 1)} PRB` : 'N/A'}`,
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

    updateMapData();
}

function switchBasemap(basemapKey) {
    const basemap = CONFIG.BASEMAPS[basemapKey];
    if (!basemap || !state.map) return;

    const source = state.map.getSource('basemap');
    if (!source) {
        console.warn('Basemap source is not available yet');
        return;
    }

    if (typeof source.setTiles !== 'function') {
        console.warn('Basemap source does not support dynamic tile switching');
        return;
    }

    source.setTiles(basemap.tiles);
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
        const selectedKey = e.target instanceof HTMLSelectElement ? e.target.value : '';
        switchBasemap(selectedKey);
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

    const driftAbsInput = document.getElementById('drift-threshold-abs');
    const driftPctInput = document.getElementById('drift-threshold-pct');
    if (driftAbsInput instanceof HTMLInputElement) {
        driftAbsInput.value = String(state.driftThresholds.absPrbDelta);
    }
    if (driftPctInput instanceof HTMLInputElement) {
        driftPctInput.value = String(state.driftThresholds.pctPrbDelta);
    }
    document.getElementById('btn-refresh-drift')?.addEventListener('click', () => {
        refreshDriftAlertsFromUI();
    });

    document.getElementById('btn-refresh')?.addEventListener('click', () => window.location.reload());

    const actionSelect = document.getElementById('action-select');
    actionSelect?.addEventListener('change', () => buildActionParamsUI(actionSelect.value));
    document.getElementById('action-run')?.addEventListener('click', () => runSimulation(state.selectedCellName, actionSelect?.value));
    document.getElementById('site-planning-run')?.addEventListener('click', () => runSitePlanningSimulation(state.selectedCellName));
    document.getElementById('site-planning-site-type')?.addEventListener('change', () => renderSitePlanningPanel(state.selectedCellName));
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
            case 'i': e.preventDefault(); openImportModal(); break;
        }
    });

    // Data Exploration Modal
    setupExploreModal();
    setupImportModal();
    
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
            fetchWithAuth(buildDataUrl('baseline.json')),
            fetchWithAuth(buildDataUrl('time_index.json')),
            fetchWithAuth(buildDataUrl('stats.json'))
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

        await Promise.all([
            loadPeakHoursIndex(),
            loadDriftAlerts(),
        ]);

        await buildSiteHierarchy();

        populateFrequencyFilters(state.globalStats?.frequency_bands || []);
        const { pointFeatures, sectorFeatures, sites } = buildFeaturesForTime();
        state.pointFeatures = pointFeatures;
        state.sectorFeatures = sectorFeatures;
        state.features = pointFeatures;
        state.filteredPointFeatures = pointFeatures;
        state.filteredSectorFeatures = sectorFeatures;
        applyPeakAndDriftMetadataToFeatures();
        updateDriftAlertsUI();
        state.currentSectorArcSteps = CONFIG.SECTOR_ARC_STEPS_DEFAULT;
        
        console.log(`Loaded ${Object.keys(state.baseline).length} cells, ${state.timeIndex.length} time slices`);
        
        // Initialize unified timeline with historical data first
        unifiedTimeline.historicalCount = state.timeIndex.length;
        unifiedTimeline.totalCount = state.timeIndex.length;
        unifiedTimeline.dividerIndex = state.timeIndex.length;
        
        setLoading(true, 'Loading initial time slice...');
        
        // Load first slice using unified system
        await loadUnifiedTimeSlice(0);
        
        setLoading(true, 'Initializing map...');
        
        const map = initMap();
        
        map.on('load', () => {
            try {
                addMapLayers(map, sites);
                setupMapInteractions(map);
                updateMapData();
                
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
