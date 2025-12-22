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
                        <div class="antenna-sub">Azimuth ${ant.azimuth} deg - ${ant.type}</div>
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

// --- Smart Recommendation Engine (Orange DRS Standards) ---

/**
 * Orange Action Recovery Rates (Taux de récupération)
 * Based on Orange DRS engineering guidelines
 */
const ORANGE_ACTIONS = {
    // === COURT TERME (OPEX) ===
    tilt: {
        name: 'Ajustement Tilt mécanique/électrique',
        recoveryRate: 0.15,  // 15%
        timeline: 'court_terme',
        capex: false,
        effect: 'Réduction footprint, moins d\'interférence'
    },
    power: {
        name: 'Ajustement puissance (Tx Power)',
        recoveryRate: 0.20,  // 20%
        timeline: 'court_terme',
        capex: false,
        effect: 'Optimisation RSRP/SINR, réduction interférence'
    },
    redistribute: {
        name: 'Équilibrage MLB (Mobility Load Balancing)',
        recoveryRate: 0.40,  // 40%
        timeline: 'court_terme',
        capex: false,
        effect: 'Déplacement UE vers cellules voisines moins chargées'
    },
    neighbor_optimization: {
        name: 'Optimisation voisinage (ANR/HO params)',
        recoveryRate: 0.35,  // 35%
        timeline: 'court_terme',
        capex: false,
        effect: 'Meilleur handover, réduction ping-pong'
    },
    parameter_tuning: {
        name: 'Tuning paramètres radio (CIO/Hysteresis)',
        recoveryRate: 0.25,  // 25%
        timeline: 'court_terme',
        capex: false,
        effect: 'Optimisation seuils HO, réduction RLF'
    },
    // === MOYEN TERME (OPEX/CAPEX léger) ===
    add_carrier: {
        name: 'Activation bande supplémentaire (CA)',
        recoveryRate: 0.50,  // 50%
        timeline: 'moyen_terme',
        capex: true,
        effect: 'Capacité +50%, Carrier Aggregation'
    },
    mimo_upgrade: {
        name: 'Upgrade MIMO (2T2R → 4T4R/8T8R)',
        recoveryRate: 0.35,  // 35%
        timeline: 'moyen_terme',
        capex: true,
        effect: 'Débit ×1.5-2, meilleur SINR'
    },
    small_cell: {
        name: 'Déploiement Small Cell / Micro',
        recoveryRate: 0.45,  // 45%
        timeline: 'moyen_terme',
        capex: true,
        effect: 'Capacité locale +45%, indoor/hotspot'
    },
    // === LONG TERME (CAPEX) ===
    add_sector: {
        name: 'Ajout 4ème secteur (sectorisation)',
        recoveryRate: 0.85,  // 85%
        timeline: 'long_terme',
        capex: true,
        effect: 'Capacité site ×1.33, meilleure répartition'
    },
    add_site: {
        name: 'Nouveau site macro capacitaire',
        recoveryRate: 0.90,  // 90%
        timeline: 'long_terme',
        capex: true,
        effect: 'Réduction UE/cellule, nouvelle capacité zone'
    },
    split_cell: {
        name: 'Cell Split (subdivision cellule)',
        recoveryRate: 0.70,  // 70%
        timeline: 'long_terme',
        capex: true,
        effect: 'Divise zone en 2+ cellules, capacité ×2'
    }
};

/**
 * Calculate "Manque à gagner" (Lost traffic/revenue)
 * Based on Orange model: Perte actuelle, Taux de récupération, Gain estimé
 */
function calculateTrafficLoss(obs) {
    const load = obs.load || 0;
    const throughput = obs.throughput_dl || 10000;
    const activeUsers = obs.active_users || obs.traffic_dl || 2;
    
    // Perte actuelle = excess capacity being denied
    const excessLoad = Math.max(0, load - 70);
    const throughputGap = Math.max(0, 10000 - throughput) / 10000; // Gap to 10 Mbps target
    
    // Estimated UE affected (users in queue or degraded)
    const affectedUE = Math.round(activeUsers * (excessLoad / 100) * 0.6);
    
    // Estimated GB lost per month (2.4 GB per UE average)
    const lostGB = Math.round(affectedUE * 2.4);
    
    return {
        affectedUE,
        lostGB,
        excessLoad,
        throughputGap: Math.round(throughputGap * 100)
    };
}

/**
 * Calculate optimal tilt adjustment based on cell metrics
 */
function calculateOptimalTilt(obs, baseline) {
    const load = obs.load || 0;
    const cqi = obs.cqi || 10;
    const ta = obs.ta_avg || 5;
    
    let optimalDegrees = 0;
    let direction = 'downtilt';
    
    if (cqi < CONFIG.CQI_THRESHOLD) {
        // Low CQI - interference, downtilt to reduce overlap
        optimalDegrees = Math.min(5, Math.max(1, (CONFIG.CQI_THRESHOLD - cqi) * 0.8));
        direction = 'downtilt';
    } else if (load > 80) {
        // High load - shed edge users
        const excessLoad = load - 70;
        optimalDegrees = Math.min(4, Math.max(1, excessLoad * 0.1));
        direction = 'downtilt';
    } else if (ta > 20) {
        // High TA - distant users, uptilt for better reach
        optimalDegrees = Math.min(2, (ta - 15) * 0.1);
        direction = 'uptilt';
    }
    
    optimalDegrees = Math.round(optimalDegrees * 2) / 2;
    if (optimalDegrees < 0.5) optimalDegrees = 1;
    
    const signedDegrees = direction === 'uptilt' ? -optimalDegrees : optimalDegrees;
    const loadReduction = direction === 'downtilt' ? Math.round(optimalDegrees * 4) : Math.round(optimalDegrees * -2);
    const cqiGain = direction === 'downtilt' ? Math.round(optimalDegrees * 0.4 * 10) / 10 : 0;
    const throughputGain = Math.round((loadReduction * 0.5 + cqiGain * 3) * 100) / 100;
    
    // Efficiency based on how well-suited tilt is for this problem
    let efficiency = 50;
    if (cqi < CONFIG.CQI_THRESHOLD && direction === 'downtilt') efficiency = 85;
    else if (load > 85 && direction === 'downtilt') efficiency = 70;
    else if (ta > 20 && direction === 'uptilt') efficiency = 60;
    
    return {
        degrees: signedDegrees,
        direction,
        optimalDegrees,
        expectedLoadReduction: loadReduction,
        expectedCqiGain: cqiGain,
        expectedThroughputGain: throughputGain,
        efficiency,
        recoveryRate: ORANGE_ACTIONS.tilt.recoveryRate,
        timeline: ORANGE_ACTIONS.tilt.timeline
    };
}

/**
 * Calculate optimal redistribution ratio based on load imbalance
 */
function calculateOptimalRedistribution(obs, baseline) {
    const load = obs.load || 0;
    
    // Target load after redistribution: 65%
    const targetLoad = 65;
    const excessLoad = Math.max(0, load - targetLoad);
    
    // Ratio = how much to offload (max 0.4 = 40%)
    let optimalRatio = Math.min(0.4, excessLoad / 100 * 0.8);
    optimalRatio = Math.round(optimalRatio * 100) / 100;
    if (optimalRatio < 0.1) optimalRatio = 0.15;
    
    const expectedLoadReduction = Math.round(excessLoad * optimalRatio * 1.5);
    const throughputGain = Math.round(expectedLoadReduction * 0.8);
    
    let efficiency = 60;
    if (load > 90) efficiency = 80;
    else if (load > 80) efficiency = 70;
    else if (load > 70) efficiency = 60;
    
    return {
        ratio: optimalRatio,
        expectedLoadReduction,
        expectedThroughputGain: throughputGain,
        efficiency,
        recoveryRate: ORANGE_ACTIONS.redistribute.recoveryRate,
        timeline: ORANGE_ACTIONS.redistribute.timeline
    };
}

/**
 * Calculate best carrier band to add
 */
function calculateOptimalCarrier(obs, baseline) {
    const currentBand = parseInt(obs.frequency_band) || 3;
    const load = obs.load || 0;
    
    const bandInfo = {
        7:  { name: 'L2600', capacity: 200, coverage: 'small', priority: 1 },
        3:  { name: 'L1800', capacity: 150, coverage: 'medium', priority: 2 },
        1:  { name: 'L2100', capacity: 150, coverage: 'medium', priority: 3 },
        20: { name: 'L800',  capacity: 75,  coverage: 'large', priority: 4 },
    };
    
    let bestBand = null;
    let bestScore = 0;
    
    for (const [band, info] of Object.entries(bandInfo)) {
        if (parseInt(band) === currentBand) continue;
        let score = info.capacity;
        if (currentBand === 20 && (band === '7' || band === '3')) score += 50;
        if (currentBand === 7 && band === '3') score += 30;
        if (score > bestScore) {
            bestScore = score;
            bestBand = { band, ...info };
        }
    }
    
    if (!bestBand) bestBand = { band: '7', name: 'L2600', capacity: 200 };
    
    const expectedLoadReduction = Math.round(Math.min(35, load * 0.35));
    const expectedThroughputGain = Math.round(bestBand.capacity * 0.4);
    const efficiency = load > 85 ? 90 : (load > 75 ? 80 : 70);
    
    return {
        band: bestBand.band,
        bandName: bestBand.name,
        expectedLoadReduction,
        expectedThroughputGain,
        efficiency,
        recoveryRate: ORANGE_ACTIONS.add_carrier.recoveryRate,
        timeline: ORANGE_ACTIONS.add_carrier.timeline
    };
}

/**
 * Calculate neighbor optimization potential
 */
function calculateNeighborOptimization(obs, baseline) {
    const load = obs.load || 0;
    const cqi = obs.cqi || 10;
    
    // Neighbors can absorb users if we optimize handover params
    const expectedLoadReduction = Math.round(Math.min(20, load * 0.15));
    const cqiGain = cqi < 10 ? 0.5 : 0;
    
    return {
        expectedLoadReduction,
        expectedCqiGain: cqiGain,
        efficiency: 65,
        recoveryRate: ORANGE_ACTIONS.neighbor_optimization.recoveryRate,
        timeline: ORANGE_ACTIONS.neighbor_optimization.timeline
    };
}

/**
 * Calculate add sector potential
 */
function calculateAddSector(obs, baseline) {
    const load = obs.load || 0;
    const activeUsers = obs.active_users || obs.traffic_dl || 2;
    
    // Adding a sector splits capacity
    const expectedLoadReduction = Math.round(load * 0.4);
    const userReduction = Math.round(activeUsers * 0.35);
    
    return {
        expectedLoadReduction,
        expectedUserReduction: userReduction,
        capacityMultiplier: 1.5,
        efficiency: 85,
        recoveryRate: ORANGE_ACTIONS.add_sector.recoveryRate,
        timeline: ORANGE_ACTIONS.add_sector.timeline
    };
}

/**
 * Calculate power adjustment potential
 */
function calculatePowerAdjustment(obs, baseline) {
    const load = obs.load || 0;
    const cqi = obs.cqi || 10;
    const rsrp = obs.signal_power || -85;
    
    // Power reduction helps reduce interference to neighbors
    const currentPower = 46; // dBm typical
    let optimalReduction = 0;
    
    if (load > 85 && cqi < 9) {
        // High load + moderate CQI = reduce power to limit cell edge
        optimalReduction = Math.min(6, Math.round((load - 70) * 0.15));
    } else if (cqi < 7) {
        // Poor CQI likely from interference = reduce power
        optimalReduction = Math.min(4, Math.round((10 - cqi) * 0.8));
    }
    
    const expectedLoadReduction = Math.round(optimalReduction * 2);
    const cqiGain = optimalReduction > 0 ? 0.3 : 0;
    
    return {
        reduction: optimalReduction,
        newPower: currentPower - optimalReduction,
        expectedLoadReduction,
        expectedCqiGain: cqiGain,
        efficiency: optimalReduction > 3 ? 75 : 60,
        recoveryRate: ORANGE_ACTIONS.power.recoveryRate,
        timeline: ORANGE_ACTIONS.power.timeline
    };
}

/**
 * Calculate MIMO upgrade potential
 */
function calculateMimoUpgrade(obs, baseline) {
    const load = obs.load || 0;
    const throughput = obs.throughput_dl || 10000;
    
    // MIMO upgrade doubles spectral efficiency in good conditions
    const expectedThroughputGain = Math.round(throughput * 0.4);
    const expectedLoadReduction = Math.round(load * 0.2);
    
    return {
        currentMimo: '2T2R',
        targetMimo: '4T4R',
        expectedLoadReduction,
        expectedThroughputGain,
        efficiency: 75,
        recoveryRate: ORANGE_ACTIONS.mimo_upgrade.recoveryRate,
        timeline: ORANGE_ACTIONS.mimo_upgrade.timeline
    };
}

/**
 * Calculate small cell deployment potential
 */
function calculateSmallCell(obs, baseline) {
    const load = obs.load || 0;
    const activeUsers = obs.active_users || obs.traffic_dl || 2;
    const ta = obs.ta_avg || 5;
    
    // Small cell offloads nearby high-density users
    const expectedLoadReduction = Math.round(load * 0.35);
    const userReduction = Math.round(activeUsers * 0.3);
    
    // More effective if users are close (low TA)
    const efficiency = ta < 10 ? 80 : (ta < 20 ? 70 : 55);
    
    return {
        expectedLoadReduction,
        expectedUserReduction: userReduction,
        recommendedType: ta < 5 ? 'Femto indoor' : 'Micro outdoor',
        efficiency,
        recoveryRate: ORANGE_ACTIONS.small_cell.recoveryRate,
        timeline: ORANGE_ACTIONS.small_cell.timeline
    };
}

/**
 * Calculate parameter tuning potential
 */
function calculateParameterTuning(obs, baseline) {
    const load = obs.load || 0;
    const cqi = obs.cqi || 10;
    
    // CIO and Hysteresis tuning helps balance load
    const expectedLoadReduction = Math.round(Math.min(15, load * 0.12));
    const cqiGain = cqi < 9 ? 0.4 : 0.1;
    
    return {
        expectedLoadReduction,
        expectedCqiGain: cqiGain,
        efficiency: 55,
        recoveryRate: ORANGE_ACTIONS.parameter_tuning.recoveryRate,
        timeline: ORANGE_ACTIONS.parameter_tuning.timeline
    };
}

/**
 * Calculate cell split potential
 */
function calculateCellSplit(obs, baseline) {
    const load = obs.load || 0;
    const activeUsers = obs.active_users || obs.traffic_dl || 2;
    
    // Cell split divides capacity
    const expectedLoadReduction = Math.round(load * 0.45);
    const userReduction = Math.round(activeUsers * 0.5);
    
    return {
        expectedLoadReduction,
        expectedUserReduction: userReduction,
        newCellCount: 2,
        efficiency: 80,
        recoveryRate: ORANGE_ACTIONS.split_cell.recoveryRate,
        timeline: ORANGE_ACTIONS.split_cell.timeline
    };
}

/**
 * Calculate add site potential
 */
function calculateAddSite(obs, baseline) {
    const load = obs.load || 0;
    const activeUsers = obs.active_users || obs.traffic_dl || 2;
    
    const expectedLoadReduction = Math.round(load * 0.5);
    const userReduction = Math.round(activeUsers * 0.45);
    
    return {
        expectedLoadReduction,
        expectedUserReduction: userReduction,
        efficiency: 90,
        recoveryRate: ORANGE_ACTIONS.add_site.recoveryRate,
        timeline: ORANGE_ACTIONS.add_site.timeline
    };
}

/**
 * Generate dynamic recommendations with Orange DRS-standard actions
 * Includes: recovery rates, timelines, manque à gagner
 */
function generateSmartRecommendations(cellName) {
    const obs = state.currentObservations[cellName];
    const baseline = state.baseline[cellName] || {};
    
    if (!obs) return [];
    
    const recommendations = [];
    const load = obs.load || 0;
    const cqi = obs.cqi ?? 10;
    const congested = obs.congested;
    const ta = obs.ta_avg || 5;
    const throughput = obs.throughput_dl || 10000;
    const activeUsers = obs.active_users || obs.traffic_dl || 2;
    
    // Calculate traffic loss for this cell
    const trafficLoss = calculateTrafficLoss(obs);
    
    // --- CRITICAL CONGESTION: PRB ≥90% (Saturé) ---
    if (load >= 90) {
        // Long terme: Ajout site (90%)
        const site = calculateAddSite(obs, baseline);
        const siteGain = Math.round(trafficLoss.affectedUE * site.recoveryRate);
        recommendations.push({
            action: 'add_site',
            title: ORANGE_ACTIONS.add_site.name,
            icon: 'densify',
            priority: 'critical',
            efficiency: site.efficiency,
            timeline: site.timeline,
            recoveryRate: site.recoveryRate,
            description: `Déployer un nouveau site pour absorber ${site.expectedUserReduction} UE. PRB actuel: ${load.toFixed(1)}% (saturé)`,
            expectedGain: { 
                load: -site.expectedLoadReduction, 
                users: -site.expectedUserReduction 
            },
            trafficLoss,
            estimatedRecovery: { ue: siteGain, gb: Math.round(siteGain * 2.4) },
            computedParams: {},
            cellName,
            currentMetrics: { load, cqi, congested, activeUsers }
        });
        
        // Long terme: Ajout secteur (85%)
        const sector = calculateAddSector(obs, baseline);
        const sectorGain = Math.round(trafficLoss.affectedUE * sector.recoveryRate);
        recommendations.push({
            action: 'add_sector',
            title: ORANGE_ACTIONS.add_sector.name,
            icon: 'densify',
            priority: 'critical',
            efficiency: sector.efficiency,
            timeline: sector.timeline,
            recoveryRate: sector.recoveryRate,
            description: `Ajouter un 4ème secteur pour capacité ×${sector.capacityMultiplier}. Réduction charge: ${sector.expectedLoadReduction}%`,
            expectedGain: { 
                load: -sector.expectedLoadReduction, 
                capacity: '+50%' 
            },
            trafficLoss,
            estimatedRecovery: { ue: sectorGain, gb: Math.round(sectorGain * 2.4) },
            computedParams: {},
            cellName,
            currentMetrics: { load, cqi, congested, activeUsers }
        });
        
        // Long terme: Cell Split (70%)
        const split = calculateCellSplit(obs, baseline);
        const splitGain = Math.round(trafficLoss.affectedUE * split.recoveryRate);
        recommendations.push({
            action: 'split_cell',
            title: ORANGE_ACTIONS.split_cell.name,
            icon: 'densify',
            priority: 'critical',
            efficiency: split.efficiency,
            timeline: split.timeline,
            recoveryRate: split.recoveryRate,
            description: `Subdiviser cellule saturée en ${split.splitFactor} cellules. PRB cible: ${(load / split.splitFactor).toFixed(0)}%`,
            expectedGain: { 
                load: -split.expectedLoadReduction, 
                capacity: `×${split.splitFactor}` 
            },
            trafficLoss,
            estimatedRecovery: { ue: splitGain, gb: Math.round(splitGain * 2.4) },
            computedParams: { splitFactor: split.splitFactor },
            cellName,
            currentMetrics: { load, cqi, congested, activeUsers }
        });
        
        // Moyen terme: Ajout carrier (50%)
        const carrier = calculateOptimalCarrier(obs, baseline);
        const carrierGain = Math.round(trafficLoss.affectedUE * carrier.recoveryRate);
        recommendations.push({
            action: 'add_carrier',
            title: `${ORANGE_ACTIONS.add_carrier.name} (${carrier.bandName})`,
            icon: 'carrier',
            priority: 'high',
            efficiency: carrier.efficiency,
            timeline: carrier.timeline,
            recoveryRate: carrier.recoveryRate,
            description: `Activer bande ${carrier.band} (${carrier.bandName}). Capacité +50%, PRB cible: ${(load - carrier.expectedLoadReduction).toFixed(0)}%`,
            expectedGain: { 
                load: -carrier.expectedLoadReduction, 
                throughput: carrier.expectedThroughputGain 
            },
            trafficLoss,
            estimatedRecovery: { ue: carrierGain, gb: Math.round(carrierGain * 2.4) },
            computedParams: { band: carrier.band },
            cellName,
            currentMetrics: { load, cqi, congested }
        });
        
        // Moyen terme: MIMO Upgrade (35%)
        const mimo = calculateMimoUpgrade(obs, baseline);
        const mimoGain = Math.round(trafficLoss.affectedUE * mimo.recoveryRate);
        recommendations.push({
            action: 'mimo_upgrade',
            title: ORANGE_ACTIONS.mimo_upgrade.name,
            icon: 'carrier',
            priority: 'high',
            efficiency: mimo.efficiency,
            timeline: mimo.timeline,
            recoveryRate: mimo.recoveryRate,
            description: `Upgrade ${mimo.currentConfig} → ${mimo.targetConfig}. Gain capacité: +${mimo.capacityGain}%`,
            expectedGain: { 
                throughput: mimo.expectedThroughputGain, 
                capacity: `+${mimo.capacityGain}%` 
            },
            trafficLoss,
            estimatedRecovery: { ue: mimoGain, gb: Math.round(mimoGain * 2.4) },
            computedParams: { config: mimo.targetConfig },
            cellName,
            currentMetrics: { load, cqi, congested }
        });
        
        // Moyen terme: Small Cell (45%)
        const smallCell = calculateSmallCell(obs, baseline);
        const smallCellGain = Math.round(trafficLoss.affectedUE * smallCell.recoveryRate);
        recommendations.push({
            action: 'small_cell',
            title: ORANGE_ACTIONS.small_cell.name,
            icon: 'densify',
            priority: 'high',
            efficiency: smallCell.efficiency,
            timeline: smallCell.timeline,
            recoveryRate: smallCell.recoveryRate,
            description: `Installer ${smallCell.recommendedCount} small cells pour décharger ${smallCell.offloadPercent}% du trafic`,
            expectedGain: { 
                load: -smallCell.expectedLoadReduction, 
                users: -smallCell.expectedUserReduction 
            },
            trafficLoss,
            estimatedRecovery: { ue: smallCellGain, gb: Math.round(smallCellGain * 2.4) },
            computedParams: { count: smallCell.recommendedCount },
            cellName,
            currentMetrics: { load, cqi, congested, activeUsers }
        });
        
        // Court terme: Rebalancing (40%)
        const redist = calculateOptimalRedistribution(obs, baseline);
        const redistGain = Math.round(trafficLoss.affectedUE * redist.recoveryRate);
        recommendations.push({
            action: 'redistribute',
            title: ORANGE_ACTIONS.redistribute.name,
            icon: 'redistribute',
            priority: 'high',
            efficiency: redist.efficiency,
            timeline: redist.timeline,
            recoveryRate: redist.recoveryRate,
            description: `Équilibrer ${Math.round(redist.ratio * 100)}% du trafic vers cellules voisines. Charge cible: ${(load - redist.expectedLoadReduction).toFixed(0)}%`,
            expectedGain: { 
                load: -redist.expectedLoadReduction, 
                throughput: redist.expectedThroughputGain 
            },
            trafficLoss,
            estimatedRecovery: { ue: redistGain, gb: Math.round(redistGain * 2.4) },
            computedParams: { ratio: redist.ratio },
            cellName,
            currentMetrics: { load, cqi, congested }
        });
        
        // Court terme: Power Adjustment (20%)
        const power = calculatePowerAdjustment(obs, baseline);
        const powerGain = Math.round(trafficLoss.affectedUE * power.recoveryRate);
        recommendations.push({
            action: 'power',
            title: ORANGE_ACTIONS.power.name,
            icon: 'tilt',
            priority: 'medium',
            efficiency: power.efficiency,
            timeline: power.timeline,
            recoveryRate: power.recoveryRate,
            description: `${power.adjustment > 0 ? 'Augmenter' : 'Réduire'} puissance de ${Math.abs(power.adjustment)} dB. Puissance cible: ${power.targetPower} dBm`,
            expectedGain: { 
                coverage: power.coverageChange, 
                load: power.loadChange 
            },
            trafficLoss,
            estimatedRecovery: { ue: powerGain, gb: Math.round(powerGain * 2.4) },
            computedParams: { adjustment: power.adjustment, target: power.targetPower },
            cellName,
            currentMetrics: { load, cqi, congested }
        });
        
        // Court terme: Tilt (15%)
        const tilt = calculateOptimalTilt(obs, baseline);
        const tiltGain = Math.round(trafficLoss.affectedUE * tilt.recoveryRate);
        recommendations.push({
            action: 'tilt',
            title: ORANGE_ACTIONS.tilt.name,
            icon: 'tilt',
            priority: 'medium',
            efficiency: tilt.efficiency,
            timeline: tilt.timeline,
            recoveryRate: tilt.recoveryRate,
            description: `${tilt.direction === 'downtilt' ? 'Downtilt' : 'Uptilt'} ${tilt.optimalDegrees}° pour ${tilt.direction === 'downtilt' ? 'réduire empreinte' : 'étendre couverture'}`,
            expectedGain: { 
                load: -tilt.expectedLoadReduction, 
                cqi: tilt.expectedCqiGain 
            },
            trafficLoss,
            estimatedRecovery: { ue: tiltGain, gb: Math.round(tiltGain * 2.4) },
            computedParams: { degrees: tilt.degrees },
            cellName,
            currentMetrics: { load, cqi, congested }
        });
        
        // Court terme: Parameter Tuning (25%)
        const params = calculateParameterTuning(obs, baseline);
        const paramsGain = Math.round(trafficLoss.affectedUE * params.recoveryRate);
        recommendations.push({
            action: 'parameter_tuning',
            title: ORANGE_ACTIONS.parameter_tuning.name,
            icon: 'redistribute',
            priority: 'medium',
            efficiency: params.efficiency,
            timeline: params.timeline,
            recoveryRate: params.recoveryRate,
            description: `Optimiser CIO=${params.cio}dB, Hysteresis=${params.hysteresis}dB pour améliorer handover`,
            expectedGain: { 
                load: -params.expectedLoadReduction, 
                handover: '+amélioration' 
            },
            trafficLoss,
            estimatedRecovery: { ue: paramsGain, gb: Math.round(paramsGain * 2.4) },
            computedParams: { cio: params.cio, hysteresis: params.hysteresis },
            cellName,
            currentMetrics: { load, cqi, congested }
        });
    }
    // --- HIGH CONGESTION: PRB ≥80% ---
    else if (congested && load >= 80) {
        // Moyen terme: Carrier (50%)
        const carrier = calculateOptimalCarrier(obs, baseline);
        const carrierGain = Math.round(trafficLoss.affectedUE * carrier.recoveryRate);
        recommendations.push({
            action: 'add_carrier',
            title: `${ORANGE_ACTIONS.add_carrier.name} (${carrier.bandName})`,
            icon: 'carrier',
            priority: 'high',
            efficiency: carrier.efficiency,
            timeline: carrier.timeline,
            recoveryRate: carrier.recoveryRate,
            description: `PRB ${load.toFixed(1)}% élevé. Ajouter ${carrier.bandName} pour capacité +50%`,
            expectedGain: { 
                load: -carrier.expectedLoadReduction, 
                throughput: carrier.expectedThroughputGain 
            },
            trafficLoss,
            estimatedRecovery: { ue: carrierGain, gb: Math.round(carrierGain * 2.4) },
            computedParams: { band: carrier.band },
            cellName,
            currentMetrics: { load, cqi, congested }
        });
        
        // Moyen terme: MIMO Upgrade (35%)
        const mimo = calculateMimoUpgrade(obs, baseline);
        const mimoGain = Math.round(trafficLoss.affectedUE * mimo.recoveryRate);
        recommendations.push({
            action: 'mimo_upgrade',
            title: ORANGE_ACTIONS.mimo_upgrade.name,
            icon: 'carrier',
            priority: 'medium',
            efficiency: mimo.efficiency,
            timeline: mimo.timeline,
            recoveryRate: mimo.recoveryRate,
            description: `Upgrade ${mimo.currentConfig} → ${mimo.targetConfig}. Gain débit: +${mimo.capacityGain}%`,
            expectedGain: { 
                throughput: mimo.expectedThroughputGain, 
                capacity: `+${mimo.capacityGain}%` 
            },
            trafficLoss,
            estimatedRecovery: { ue: mimoGain, gb: Math.round(mimoGain * 2.4) },
            computedParams: { config: mimo.targetConfig },
            cellName,
            currentMetrics: { load, cqi, congested }
        });
        
        // Moyen terme: Small Cell (45%) - for high user density
        if (activeUsers > 4) {
            const smallCell = calculateSmallCell(obs, baseline);
            const smallCellGain = Math.round(trafficLoss.affectedUE * smallCell.recoveryRate);
            recommendations.push({
                action: 'small_cell',
                title: ORANGE_ACTIONS.small_cell.name,
                icon: 'densify',
                priority: 'medium',
                efficiency: smallCell.efficiency,
                timeline: smallCell.timeline,
                recoveryRate: smallCell.recoveryRate,
                description: `Densité UE élevée (${activeUsers}). Installer ${smallCell.recommendedCount} small cells`,
                expectedGain: { 
                    load: -smallCell.expectedLoadReduction, 
                    users: -smallCell.expectedUserReduction 
                },
                trafficLoss,
                estimatedRecovery: { ue: smallCellGain, gb: Math.round(smallCellGain * 2.4) },
                computedParams: { count: smallCell.recommendedCount },
                cellName,
                currentMetrics: { load, cqi, congested, activeUsers }
            });
        }
        
        // Court terme: Rebalancing (40%)
        const redist = calculateOptimalRedistribution(obs, baseline);
        const redistGain = Math.round(trafficLoss.affectedUE * redist.recoveryRate);
        recommendations.push({
            action: 'redistribute',
            title: ORANGE_ACTIONS.redistribute.name,
            icon: 'redistribute',
            priority: 'high',
            efficiency: redist.efficiency,
            timeline: redist.timeline,
            recoveryRate: redist.recoveryRate,
            description: `Redistribuer ${Math.round(redist.ratio * 100)}% vers voisins. Taux récupération: ${Math.round(redist.recoveryRate * 100)}%`,
            expectedGain: { 
                load: -redist.expectedLoadReduction, 
                throughput: redist.expectedThroughputGain 
            },
            trafficLoss,
            estimatedRecovery: { ue: redistGain, gb: Math.round(redistGain * 2.4) },
            computedParams: { ratio: redist.ratio },
            cellName,
            currentMetrics: { load, cqi, congested }
        });
        
        // Court terme: Power Adjustment (20%)
        const power = calculatePowerAdjustment(obs, baseline);
        const powerGain = Math.round(trafficLoss.affectedUE * power.recoveryRate);
        recommendations.push({
            action: 'power',
            title: ORANGE_ACTIONS.power.name,
            icon: 'tilt',
            priority: 'medium',
            efficiency: power.efficiency,
            timeline: power.timeline,
            recoveryRate: power.recoveryRate,
            description: `${power.adjustment > 0 ? 'Augmenter' : 'Réduire'} puissance de ${Math.abs(power.adjustment)} dB`,
            expectedGain: { 
                coverage: power.coverageChange, 
                load: power.loadChange 
            },
            trafficLoss,
            estimatedRecovery: { ue: powerGain, gb: Math.round(powerGain * 2.4) },
            computedParams: { adjustment: power.adjustment, target: power.targetPower },
            cellName,
            currentMetrics: { load, cqi, congested }
        });
        
        // Court terme: Neighbor optimization (35%)
        const neighbor = calculateNeighborOptimization(obs, baseline);
        const neighborGain = Math.round(trafficLoss.affectedUE * neighbor.recoveryRate);
        recommendations.push({
            action: 'neighbor_optimization',
            title: ORANGE_ACTIONS.neighbor_optimization.name,
            icon: 'redistribute',
            priority: 'medium',
            efficiency: neighbor.efficiency,
            timeline: neighbor.timeline,
            recoveryRate: neighbor.recoveryRate,
            description: `Optimiser paramètres handover vers voisins. Réduction charge: ${neighbor.expectedLoadReduction}%`,
            expectedGain: { 
                load: -neighbor.expectedLoadReduction, 
                cqi: neighbor.expectedCqiGain 
            },
            trafficLoss,
            estimatedRecovery: { ue: neighborGain, gb: Math.round(neighborGain * 2.4) },
            computedParams: {},
            cellName,
            currentMetrics: { load, cqi, congested }
        });
        
        // Court terme: Parameter Tuning (25%)
        const params = calculateParameterTuning(obs, baseline);
        const paramsGain = Math.round(trafficLoss.affectedUE * params.recoveryRate);
        recommendations.push({
            action: 'parameter_tuning',
            title: ORANGE_ACTIONS.parameter_tuning.name,
            icon: 'redistribute',
            priority: 'low',
            efficiency: params.efficiency,
            timeline: params.timeline,
            recoveryRate: params.recoveryRate,
            description: `Tuning CIO/Hysteresis pour améliorer handover et réduire charge`,
            expectedGain: { 
                load: -params.expectedLoadReduction, 
                handover: '+amélioration' 
            },
            trafficLoss,
            estimatedRecovery: { ue: paramsGain, gb: Math.round(paramsGain * 2.4) },
            computedParams: { cio: params.cio, hysteresis: params.hysteresis },
            cellName,
            currentMetrics: { load, cqi, congested }
        });
        
        // Court terme: Tilt (15%)
        const tilt = calculateOptimalTilt(obs, baseline);
        const tiltGain = Math.round(trafficLoss.affectedUE * tilt.recoveryRate);
        recommendations.push({
            action: 'tilt',
            title: ORANGE_ACTIONS.tilt.name,
            icon: 'tilt',
            priority: 'medium',
            efficiency: tilt.efficiency,
            timeline: tilt.timeline,
            recoveryRate: tilt.recoveryRate,
            description: `${tilt.direction === 'downtilt' ? 'Réduire' : 'Étendre'} couverture de ${tilt.optimalDegrees}°`,
            expectedGain: { 
                load: -tilt.expectedLoadReduction, 
                cqi: tilt.expectedCqiGain 
            },
            trafficLoss,
            estimatedRecovery: { ue: tiltGain, gb: Math.round(tiltGain * 2.4) },
            computedParams: { degrees: tilt.degrees },
            cellName,
            currentMetrics: { load, cqi, congested }
        });
    }
    // --- MODERATE CONGESTION or DEGRADED QUALITY ---
    else if (congested || throughput < 4000 || activeUsers > 4) {
        // Moyen terme: MIMO for throughput issues
        if (throughput < 4000) {
            const mimo = calculateMimoUpgrade(obs, baseline);
            const mimoGain = Math.round(trafficLoss.affectedUE * mimo.recoveryRate);
            recommendations.push({
                action: 'mimo_upgrade',
                title: ORANGE_ACTIONS.mimo_upgrade.name,
                icon: 'carrier',
                priority: 'high',
                efficiency: mimo.efficiency,
                timeline: mimo.timeline,
                recoveryRate: mimo.recoveryRate,
                description: `Débit faible (${(throughput/1000).toFixed(1)} Mbps). Upgrade MIMO ${mimo.currentConfig} → ${mimo.targetConfig}`,
                expectedGain: { 
                    throughput: mimo.expectedThroughputGain, 
                    capacity: `+${mimo.capacityGain}%` 
                },
                trafficLoss,
                estimatedRecovery: { ue: mimoGain, gb: Math.round(mimoGain * 2.4) },
                computedParams: { config: mimo.targetConfig },
                cellName,
                currentMetrics: { load, cqi, congested, throughput }
            });
        }
        
        // Court terme: Rebalancing (40%)
        const redist = calculateOptimalRedistribution(obs, baseline);
        const redistGain = Math.round(trafficLoss.affectedUE * redist.recoveryRate);
        recommendations.push({
            action: 'redistribute',
            title: ORANGE_ACTIONS.redistribute.name,
            icon: 'redistribute',
            priority: 'high',
            efficiency: redist.efficiency,
            timeline: redist.timeline,
            recoveryRate: redist.recoveryRate,
            description: `Équilibrer charge vers cellules voisines (${Math.round(redist.ratio * 100)}%)`,
            expectedGain: { 
                load: -redist.expectedLoadReduction, 
                throughput: redist.expectedThroughputGain 
            },
            trafficLoss,
            estimatedRecovery: { ue: redistGain, gb: Math.round(redistGain * 2.4) },
            computedParams: { ratio: redist.ratio },
            cellName,
            currentMetrics: { load, cqi, congested }
        });
        
        // Court terme: Power Adjustment (20%)
        const power = calculatePowerAdjustment(obs, baseline);
        const powerGain = Math.round(trafficLoss.affectedUE * power.recoveryRate);
        recommendations.push({
            action: 'power',
            title: ORANGE_ACTIONS.power.name,
            icon: 'tilt',
            priority: 'medium',
            efficiency: power.efficiency,
            timeline: power.timeline,
            recoveryRate: power.recoveryRate,
            description: `Ajuster puissance Tx: ${power.adjustment > 0 ? '+' : ''}${power.adjustment} dB`,
            expectedGain: { 
                coverage: power.coverageChange, 
                load: power.loadChange 
            },
            trafficLoss,
            estimatedRecovery: { ue: powerGain, gb: Math.round(powerGain * 2.4) },
            computedParams: { adjustment: power.adjustment, target: power.targetPower },
            cellName,
            currentMetrics: { load, cqi, congested }
        });
        
        // Court terme: Tilt (15%)
        const tilt = calculateOptimalTilt(obs, baseline);
        const tiltGain = Math.round(trafficLoss.affectedUE * tilt.recoveryRate);
        recommendations.push({
            action: 'tilt',
            title: ORANGE_ACTIONS.tilt.name,
            icon: 'tilt',
            priority: 'medium',
            efficiency: tilt.efficiency,
            timeline: tilt.timeline,
            recoveryRate: tilt.recoveryRate,
            description: `Ajustement ${tilt.direction} ${tilt.optimalDegrees}° pour optimiser couverture`,
            expectedGain: { 
                load: -tilt.expectedLoadReduction, 
                cqi: tilt.expectedCqiGain 
            },
            trafficLoss,
            estimatedRecovery: { ue: tiltGain, gb: Math.round(tiltGain * 2.4) },
            computedParams: { degrees: tilt.degrees },
            cellName,
            currentMetrics: { load, cqi, congested }
        });
    }
    // --- POOR CQI (interference) ---
    else if (cqi < CONFIG.CQI_THRESHOLD) {
        const tilt = calculateOptimalTilt(obs, baseline);
        const interferenceAngle = Math.max(2, tilt.optimalDegrees);
        const expectedCqiGain = Math.round((15 - cqi) * 0.25 * 10) / 10;
        
        recommendations.push({
            action: 'tilt',
            title: `Downtilt anti-interférence`,
            icon: 'tilt',
            priority: 'high',
            efficiency: 85,
            timeline: 'court_terme',
            recoveryRate: ORANGE_ACTIONS.tilt.recoveryRate,
            description: `CQI ${cqi.toFixed(1)} dégradé. Downtilt ${interferenceAngle}° pour réduire overlap. CQI cible: ${(cqi + expectedCqiGain).toFixed(1)}`,
            expectedGain: { 
                cqi: expectedCqiGain, 
                throughput: Math.round(expectedCqiGain * 8) 
            },
            computedParams: { degrees: interferenceAngle },
            cellName,
            currentMetrics: { load, cqi, congested }
        });
        
        // Court terme: Neighbor optimization
        const neighbor = calculateNeighborOptimization(obs, baseline);
        recommendations.push({
            action: 'neighbor_optimization',
            title: ORANGE_ACTIONS.neighbor_optimization.name,
            icon: 'redistribute',
            priority: 'medium',
            efficiency: neighbor.efficiency,
            timeline: neighbor.timeline,
            recoveryRate: neighbor.recoveryRate,
            description: `Optimiser voisinage pour réduire interférences inter-cellules`,
            expectedGain: { cqi: 0.5, throughput: 10 },
            computedParams: {},
            cellName,
            currentMetrics: { load, cqi, congested }
        });
    }
    // --- HIGH LOAD (preventive) ---
    else if (load > 70) {
        const redist = calculateOptimalRedistribution(obs, baseline);
        recommendations.push({
            action: 'redistribute',
            title: 'Équilibrage préventif',
            icon: 'redistribute',
            priority: 'medium',
            efficiency: redist.efficiency - 10,
            timeline: 'court_terme',
            recoveryRate: redist.recoveryRate,
            description: `Charge ${load.toFixed(1)}% approche seuil. Préempter avec ${Math.round(redist.ratio * 100)}% redistribution`,
            expectedGain: { 
                load: -redist.expectedLoadReduction, 
                throughput: Math.round(redist.expectedThroughputGain * 0.7)
            },
            computedParams: { ratio: Math.max(0.1, redist.ratio - 0.05) },
            cellName,
            currentMetrics: { load, cqi, congested }
        });
    }
    // --- COVERAGE ISSUE (high TA) ---
    if (ta > 20) {
        const uptiltDegrees = Math.min(2, Math.round((ta - 15) * 0.15 * 2) / 2);
        recommendations.push({
            action: 'tilt',
            title: `Uptilt couverture (+${uptiltDegrees}°)`,
            icon: 'tilt',
            priority: 'medium',
            efficiency: 55,
            timeline: 'court_terme',
            recoveryRate: ORANGE_ACTIONS.tilt.recoveryRate,
            description: `TA élevé (${ta.toFixed(1)}) = utilisateurs distants. Uptilt pour meilleure portée`,
            expectedGain: { coverage: 15, throughput: 5 },
            computedParams: { degrees: -uptiltDegrees },
            cellName,
            currentMetrics: { load, cqi, ta }
        });
        
        const site = calculateAddSite(obs, baseline);
        recommendations.push({
            action: 'add_site',
            title: 'Densification couverture',
            icon: 'densify',
            priority: 'high',
            efficiency: site.efficiency,
            timeline: site.timeline,
            recoveryRate: site.recoveryRate,
            description: `TA ${ta.toFixed(1)} indique trou couverture. Nouveau site améliorerait débit +50%`,
            expectedGain: { coverage: 35, throughput: 50 },
            computedParams: {},
            cellName,
            currentMetrics: { load, cqi, ta }
        });
    }
    
    // Sort by timeline (court_terme first) then priority then efficiency
    const timelineOrder = { court_terme: 0, moyen_terme: 1, long_terme: 2 };
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    recommendations.sort((a, b) => {
        const tDiff = (timelineOrder[a.timeline] || 2) - (timelineOrder[b.timeline] || 2);
        if (tDiff !== 0) return tDiff;
        const pDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
        if (pDiff !== 0) return pDiff;
        return b.efficiency - a.efficiency;
    });
    
    return recommendations;
}

function renderRecommendationsPanel(cellName) {
    const container = document.getElementById('reco-list');
    const badge = document.getElementById('reco-count');
    if (!container) return;
    
    if (!cellName) {
        container.innerHTML = '<div class="reco-placeholder">Sélectionner une cellule pour les recommandations</div>';
        if (badge) badge.textContent = '0';
        return;
    }
    
    const recommendations = generateSmartRecommendations(cellName);
    
    if (badge) badge.textContent = recommendations.length;
    
    if (recommendations.length === 0) {
        const obs = state.currentObservations[cellName];
        container.innerHTML = `
            <div class="reco-placeholder" style="color: var(--success);">
                <span class="material-symbols-outlined" style="font-size: 24px; margin-bottom: 8px;">check_circle</span><br>
                Cellule saine. Aucune action requise.
            </div>
        `;
        return;
    }
    
    container.innerHTML = recommendations.map((reco, idx) => {
        const gains = reco.expectedGain || {};
        const metrics = reco.currentMetrics || {};
        
        // Timeline badge
        const timelineLabels = {
            court_terme: { label: 'Court terme', class: 'timeline-short' },
            moyen_terme: { label: 'Moyen terme', class: 'timeline-medium' },
            long_terme: { label: 'Long terme', class: 'timeline-long' }
        };
        const timeline = timelineLabels[reco.timeline] || { label: '', class: '' };
        
        // Build dynamic metrics display
        let metricsHtml = '';
        if (gains.load) {
            const newLoad = (metrics.load || 0) + gains.load;
            metricsHtml += `<div class="reco-metric"><span class="reco-metric-label">Charge:</span><span class="reco-metric-value">${metrics.load?.toFixed(0) || '--'}% → ${newLoad.toFixed(0)}%</span></div>`;
        }
        if (gains.cqi) {
            const newCqi = (metrics.cqi || 0) + gains.cqi;
            metricsHtml += `<div class="reco-metric"><span class="reco-metric-label">CQI:</span><span class="reco-metric-value">${metrics.cqi?.toFixed(1) || '--'} → ${newCqi.toFixed(1)}</span></div>`;
        }
        if (gains.throughput) {
            metricsHtml += `<div class="reco-metric"><span class="reco-metric-label">Débit:</span><span class="reco-metric-value">+${gains.throughput}%</span></div>`;
        }
        if (gains.coverage) {
            metricsHtml += `<div class="reco-metric"><span class="reco-metric-label">Couverture:</span><span class="reco-metric-value">+${gains.coverage}%</span></div>`;
        }
        if (gains.users) {
            metricsHtml += `<div class="reco-metric"><span class="reco-metric-label">UE:</span><span class="reco-metric-value">${gains.users} utilisateurs</span></div>`;
        }
        
        // Manque à gagner display
        let trafficLossHtml = '';
        if (reco.trafficLoss && reco.estimatedRecovery) {
            trafficLossHtml = `
                <div class="reco-traffic-loss">
                    <div class="traffic-loss-title">📉 Manque à gagner</div>
                    <div class="traffic-loss-row">
                        <span>Perte actuelle:</span>
                        <span>${reco.trafficLoss.affectedUE} UE / ${reco.trafficLoss.lostGB} Go/mois</span>
                    </div>
                    <div class="traffic-loss-row recovery">
                        <span>Gain estimé (${Math.round(reco.recoveryRate * 100)}%):</span>
                        <span class="recovery-value">+${reco.estimatedRecovery.ue} UE / +${reco.estimatedRecovery.gb} Go</span>
                    </div>
                </div>
            `;
        }
        
        // Show optimal parameter in title
        let paramHint = '';
        if (reco.action === 'tilt' && reco.computedParams.degrees !== undefined) {
            const deg = reco.computedParams.degrees;
            paramHint = `<span class="reco-param-hint">${deg > 0 ? '↓' : '↑'} ${Math.abs(deg)}°</span>`;
        } else if (reco.action === 'redistribute' && reco.computedParams.ratio) {
            paramHint = `<span class="reco-param-hint">${Math.round(reco.computedParams.ratio * 100)}%</span>`;
        } else if (reco.action === 'add_carrier' && reco.computedParams.band) {
            paramHint = `<span class="reco-param-hint">B${reco.computedParams.band}</span>`;
        }
        
        // Recovery rate badge
        const recoveryHtml = reco.recoveryRate 
            ? `<span class="reco-recovery-badge">↑${Math.round(reco.recoveryRate * 100)}%</span>` 
            : '';
        
        // Determine if action is simulatable
        const simulatable = ['tilt', 'redistribute', 'add_carrier'].includes(reco.action);
        const buttonHtml = simulatable 
            ? `<button class="reco-apply-btn" onclick="applyRecommendation(${idx})">
                <span class="material-symbols-outlined">bolt</span>
                Simuler cette action
               </button>`
            : `<div class="reco-capex-note">⚠️ Action CAPEX - Planification requise</div>`;
        
        return `
        <div class="reco-item priority-${reco.priority}" data-reco-idx="${idx}">
            <div class="reco-header">
                <div class="reco-icon ${reco.icon}">
                    <span class="material-symbols-outlined">${getRecoIcon(reco.icon)}</span>
                </div>
                <div class="reco-header-content">
                    <div class="reco-title">${reco.title} ${paramHint} ${recoveryHtml}</div>
                    <div class="reco-badges">
                        <span class="reco-priority-badge priority-${reco.priority}">${reco.priority.toUpperCase()}</span>
                        ${timeline.label ? `<span class="reco-timeline-badge ${timeline.class}">${timeline.label}</span>` : ''}
                    </div>
                </div>
            </div>
            <div class="reco-body">${reco.description}</div>
            <div class="reco-metrics">${metricsHtml}</div>
            ${trafficLossHtml}
            <div class="reco-efficiency">
                <span class="efficiency-label">Efficacité:</span>
                <div class="efficiency-bar"><div class="efficiency-fill" style="width: ${reco.efficiency}%"></div></div>
                <span class="efficiency-value">${reco.efficiency}%</span>
            </div>
            ${buttonHtml}
        </div>
    `}).join('');
    
    // Store recommendations in state for apply function
    state.currentRecommendations = recommendations;
}

function getRecoIcon(type) {
    const icons = {
        tilt: 'cell_tower',
        carrier: 'add_circle',
        redistribute: 'sync_alt',
        densify: 'add_location',
        add_site: 'add_location',
        add_sector: 'settings_input_antenna',
        neighbor_optimization: 'hub'
    };
    return icons[type] || 'lightbulb';
}

window.applyRecommendation = function(idx) {
    const reco = state.currentRecommendations?.[idx];
    if (!reco) return;
    
    // Set the action selector
    const actionSelect = document.getElementById('action-select');
    if (actionSelect && reco.action !== 'densify') {
        actionSelect.value = reco.action;
        buildActionParamsUI(reco.action);
        
        // Fill in the recommended parameters
        setTimeout(() => {
            if (reco.action === 'tilt' && reco.computedParams.degrees !== undefined) {
                const input = document.getElementById('param-tilt-deg');
                if (input) input.value = reco.computedParams.degrees;
            }
            if (reco.action === 'redistribute' && reco.computedParams.ratio !== undefined) {
                const input = document.getElementById('param-redistribute-ratio');
                if (input) input.value = reco.computedParams.ratio;
            }
            if (reco.action === 'add_carrier' && reco.computedParams.band) {
                const input = document.getElementById('param-carrier-band');
                if (input) input.value = reco.computedParams.band;
            }
            
            // Auto-run the simulation
            runSimulation(reco.cellName, reco.action);
        }, 100);
    } else if (reco.action === 'densify') {
        // Densification is a special case - show recommendation only
        const resultEl = document.getElementById('action-result');
        if (resultEl) {
            resultEl.innerHTML = `
                <div class="action-mode-badge" style="background: var(--orange-primary); color: white;">📍 Site Densification Recommended</div>
                <div style="margin-top: 10px; font-size: 13px; color: var(--text-secondary);">
                    <p><strong>Analysis:</strong> High Timing Advance values indicate users at the cell edge experiencing poor signal quality.</p>
                    <p style="margin-top: 8px;"><strong>Recommendation:</strong></p>
                    <ul style="margin: 8px 0; padding-left: 20px;">
                        <li>Deploy a new macro site in the coverage gap</li>
                        <li>Or install small cells for targeted capacity</li>
                        <li>Estimated capacity gain: +50% throughput</li>
                        <li>Estimated coverage improvement: +30%</li>
                    </ul>
                    <p style="margin-top: 8px; color: var(--warning);">⚠️ This requires CAPEX investment and site acquisition.</p>
                </div>
            `;
        }
    }
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
        result.innerHTML = '<div class="action-hint">Cell: ' + cellName + ' (healthy - simulation for testing)</div>';
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
    const actionInfo = ORANGE_ACTIONS[action];
    const infoBox = actionInfo ? `
        <div class="action-info-box">
            <span class="timeline-badge ${actionInfo.timeline}">${
                actionInfo.timeline === 'court_terme' ? '⚡ Court terme' :
                actionInfo.timeline === 'moyen_terme' ? '📅 Moyen terme' : '🏗️ Long terme'
            }</span>
            <span class="recovery-badge">↑${Math.round(actionInfo.recoveryRate * 100)}% récup.</span>
            ${actionInfo.capex ? '<span class="capex-badge">💰 CAPEX</span>' : '<span class="opex-badge">OPEX</span>'}
        </div>
        <div class="action-effect">${actionInfo.effect}</div>
    ` : '';

    if (action === 'tilt') {
        container.innerHTML = `${infoBox}
            <label class="action-label" for="param-tilt-deg">Downtilt (degrés)</label>
            <input type="number" id="param-tilt-deg" class="action-input" value="2" min="-5" max="10" step="0.5">
            <div class="action-hint">Positif = downtilt, Négatif = uptilt</div>
        `;
        return;
    }

    if (action === 'power') {
        container.innerHTML = `${infoBox}
            <label class="action-label" for="param-power-delta">Réduction puissance (dB)</label>
            <input type="number" id="param-power-delta" class="action-input" value="3" min="0" max="10" step="1">
            <div class="action-hint">Réduction Tx Power en dB (0 = pas de changement)</div>
        `;
        return;
    }

    if (action === 'add_carrier') {
        const bands = (state.globalStats?.frequency_bands || []).map(String);
        const options = bands.length
            ? bands.map(b => `<option value="${b}">Bande ${b}</option>`).join('')
            : '<option value="">Aucune bande disponible</option>';
        container.innerHTML = `${infoBox}
            <label class="action-label" for="param-carrier-band">Sélectionner bande</label>
            <select id="param-carrier-band" class="action-input">${options}</select>
            <div class="action-hint">Active Carrier Aggregation si bande non présente sur site.</div>
        `;
        return;
    }

    if (action === 'redistribute') {
        container.innerHTML = `${infoBox}
            <label class="action-label" for="param-redistribute-target">Cellule cible (optionnel)</label>
            <input type="text" id="param-redistribute-target" class="action-input" placeholder="nom cellule voisine">
            <label class="action-label" for="param-redistribute-ratio">Ratio redistribution (0-0.6)</label>
            <input type="number" id="param-redistribute-ratio" class="action-input" value="0.2" min="0" max="0.6" step="0.05">
            <div class="action-hint">MLB: équilibrage charge vers voisins moins chargés</div>
        `;
        return;
    }

    if (action === 'parameter_tuning') {
        container.innerHTML = `${infoBox}
            <label class="action-label" for="param-cio">Cell Individual Offset (dB)</label>
            <input type="number" id="param-cio" class="action-input" value="-3" min="-6" max="6" step="1">
            <label class="action-label" for="param-hysteresis">Hysteresis (dB)</label>
            <input type="number" id="param-hysteresis" class="action-input" value="2" min="0" max="6" step="1">
            <div class="action-hint">CIO négatif = repousse UE vers voisins</div>
        `;
        return;
    }

    if (action === 'mimo_upgrade') {
        container.innerHTML = `${infoBox}
            <label class="action-label" for="param-mimo-target">Configuration MIMO cible</label>
            <select id="param-mimo-target" class="action-input">
                <option value="4T4R">4T4R (Recommandé)</option>
                <option value="8T8R">8T8R (Massive MIMO)</option>
            </select>
            <div class="action-hint">Upgrade antenne pour meilleure efficacité spectrale</div>
        `;
        return;
    }

    if (action === 'small_cell') {
        container.innerHTML = `${infoBox}
            <label class="action-label" for="param-sc-type">Type Small Cell</label>
            <select id="param-sc-type" class="action-input">
                <option value="micro">Micro outdoor</option>
                <option value="femto">Femto indoor</option>
                <option value="pico">Pico hotspot</option>
            </select>
            <div class="action-hint">Déploiement capacité locale ciblée</div>
        `;
        return;
    }

    if (action === 'add_sector') {
        container.innerHTML = `${infoBox}
            <label class="action-label">Configuration actuelle</label>
            <div class="action-static">3 secteurs → 4 secteurs</div>
            <div class="action-hint">Sectorisation: +33% capacité site</div>
        `;
        return;
    }

    if (action === 'add_site') {
        container.innerHTML = `${infoBox}
            <label class="action-label" for="param-site-type">Type de site</label>
            <select id="param-site-type" class="action-input">
                <option value="macro">Macro capacitaire</option>
                <option value="rooftop">Rooftop urbain</option>
            </select>
            <div class="action-hint">Nouveau site pour absorber trafic zone congestionnée</div>
        `;
        return;
    }

    if (action === 'split_cell') {
        container.innerHTML = `${infoBox}
            <label class="action-label">Cell Split</label>
            <div class="action-static">1 cellule → 2 cellules</div>
            <div class="action-hint">Subdivision cellule haute charge en 2+ cellules</div>
        `;
        return;
    }

    container.innerHTML = `${infoBox}<div class="action-hint">Action: ${actionInfo?.name || action}</div>`;
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
    const defaultConfidence = action === 'redistribute' ? 0.55 : 0.65;
    const confidence = result.confidence ?? defaultConfidence;
    const confidencePct = Math.round(confidence * 100);
    const modeLabel = '⚡ Fast';

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
            if (resultEl) resultEl.innerHTML = `<div class="action-error">Site ${siteName} already has Band ${params.band}.</div>`;
            return;
        }
    }

    try {
        // Update UI for loading state (fast only)
        const loadingMsg = '<div class="action-hint">⚡ Simulating...</div>';
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

// --- Forecast Mode ---
const forecastState = {
    mode: 'historical',  // 'historical' or 'forecast'
    forecastIndex: [],
    forecastTimeIndex: 0,
    isGenerating: false,
    available: false
};

async function checkForecastAvailability() {
    try {
        const res = await fetch('/api/forecast');
        const data = await res.json();
        forecastState.available = data.available;
        if (data.available && data.forecasts) {
            forecastState.forecastIndex = data.forecasts;
        }
        return data;
    } catch (err) {
        console.warn('Could not check forecast availability:', err);
        return { available: false };
    }
}

async function generateForecast() {
    if (forecastState.isGenerating) return;
    
    const btn = document.getElementById('btn-generate-forecast');
    const originalHtml = btn?.innerHTML;
    
    try {
        forecastState.isGenerating = true;
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="material-symbols-outlined spinning">sync</span><span>Generating...</span>';
        }
        
        const res = await fetch('/api/forecast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ days: 6 })
        });
        
        const data = await res.json();
        
        if (data.success) {
            // Reload forecast data
            await checkForecastAvailability();
            
            // Update UI
            if (forecastState.forecastIndex.length > 0) {
                updateForecastSlider();
                loadForecastSlice(0);
            }
            
            showNotification('Forecast generated successfully!', 'success');
        } else {
            showNotification('Forecast generation failed: ' + (data.error || 'Unknown error'), 'error');
        }
    } catch (err) {
        console.error('Forecast generation error:', err);
        showNotification('Forecast generation failed', 'error');
    } finally {
        forecastState.isGenerating = false;
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalHtml || '<span class="material-symbols-outlined">auto_awesome</span><span>Generate</span>';
        }
    }
}

function showNotification(message, type = 'info') {
    // Simple notification - can be enhanced
    const existing = document.querySelector('.notification-toast');
    if (existing) existing.remove();
    
    const toast = document.createElement('div');
    toast.className = `notification-toast notification-${type}`;
    toast.innerHTML = `
        <span class="material-symbols-outlined">${type === 'success' ? 'check_circle' : type === 'error' ? 'error' : 'info'}</span>
        <span>${message}</span>
    `;
    document.body.appendChild(toast);
    
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

function switchTimeMode(mode) {
    if (mode === forecastState.mode) return;
    
    forecastState.mode = mode;
    
    const historicalBtn = document.getElementById('mode-historical');
    const forecastBtn = document.getElementById('mode-forecast');
    const generateBtn = document.getElementById('btn-generate-forecast');
    const indicator = document.getElementById('forecast-indicator');
    
    historicalBtn?.classList.toggle('active', mode === 'historical');
    forecastBtn?.classList.toggle('active', mode === 'forecast');
    
    if (mode === 'forecast') {
        generateBtn?.classList.remove('hidden');
        indicator?.classList.remove('hidden');
        document.body.classList.add('forecast-mode');
        
        // Load forecast data
        if (forecastState.forecastIndex.length > 0) {
            updateForecastSlider();
            loadForecastSlice(0);
        } else {
            // Check if forecast is available
            checkForecastAvailability().then(data => {
                if (data.available) {
                    updateForecastSlider();
                    loadForecastSlice(0);
                }
            });
        }
    } else {
        generateBtn?.classList.add('hidden');
        indicator?.classList.add('hidden');
        document.body.classList.remove('forecast-mode');
        
        // Restore historical data
        updateHistoricalSlider();
        loadTimeSlice(state.currentTimeIndex);
    }
}

function updateForecastSlider() {
    const slider = document.getElementById('time-slider');
    const startLabel = document.getElementById('time-start-label');
    const endLabel = document.getElementById('time-end-label');
    
    if (!forecastState.forecastIndex.length) return;
    
    if (slider) {
        slider.min = 0;
        slider.max = forecastState.forecastIndex.length - 1;
        slider.value = 0;
    }
    
    if (startLabel) startLabel.textContent = forecastState.forecastIndex[0]?.timestamp || '--';
    if (endLabel) endLabel.textContent = forecastState.forecastIndex[forecastState.forecastIndex.length - 1]?.timestamp || '--';
}

function updateHistoricalSlider() {
    const slider = document.getElementById('time-slider');
    const startLabel = document.getElementById('time-start-label');
    const endLabel = document.getElementById('time-end-label');
    
    if (!state.timeIndex.length) return;
    
    if (slider) {
        slider.min = 0;
        slider.max = state.timeIndex.length - 1;
        slider.value = state.currentTimeIndex;
    }
    
    if (startLabel) startLabel.textContent = state.timeIndex[0]?.timestamp || '--';
    if (endLabel) endLabel.textContent = state.timeIndex[state.timeIndex.length - 1]?.timestamp || '--';
}

async function loadForecastSlice(index) {
    if (index < 0 || index >= forecastState.forecastIndex.length) return;
    
    const forecastEntry = forecastState.forecastIndex[index];
    forecastState.forecastTimeIndex = index;
    
    try {
        const res = await fetch(`/forecast_data/${forecastEntry.filename}?t=${Date.now()}`);
        const data = await res.json();
        
        state.currentObservations = data.observations;
        state.currentStats = data.stats;
        
        const { pointFeatures, sectorFeatures } = buildFeaturesForTime(data.observations);
        
        // Mark features as forecast
        pointFeatures.forEach(f => {
            f.properties.is_forecast = true;
            f.properties.confidence = data.confidence || 0.75;
        });
        sectorFeatures.forEach(f => {
            f.properties.is_forecast = true;
        });
        
        state.pointFeatures = pointFeatures;
        state.sectorFeatures = sectorFeatures;
        state.features = pointFeatures;
        applyFilters();
        
        updateTimeSliderUI();
        updateStatsUI(data.stats);
        updateAlertsUI(state.filteredPointFeatures);
        
        // Update confidence indicator
        const confidenceEl = document.getElementById('forecast-confidence');
        if (confidenceEl) {
            const conf = Math.round((data.confidence || 0.75) * 100);
            confidenceEl.textContent = `${conf}% confidence`;
        }
        
        if (state.selectedSite) {
            showSiteInfoPanel(state.selectedSite);
        }
        
    } catch (err) {
        console.error('Failed to load forecast slice:', err);
    }
}

function setupForecastControls() {
    const historicalBtn = document.getElementById('mode-historical');
    const forecastBtn = document.getElementById('mode-forecast');
    const generateBtn = document.getElementById('btn-generate-forecast');
    const slider = document.getElementById('time-slider');
    const prevBtn = document.getElementById('time-prev');
    const nextBtn = document.getElementById('time-next');
    
    historicalBtn?.addEventListener('click', () => switchTimeMode('historical'));
    forecastBtn?.addEventListener('click', () => switchTimeMode('forecast'));
    generateBtn?.addEventListener('click', generateForecast);
    
    // Override slider behavior based on mode
    const originalSliderHandler = slider?._inputHandler;
    
    slider?.addEventListener('input', (e) => {
        if (forecastState.mode === 'forecast') {
            const val = parseInt(e.target.value, 10);
            loadForecastSlice(val);
        }
    });
    
    // Override nav buttons
    prevBtn?.addEventListener('click', () => {
        if (forecastState.mode === 'forecast') {
            if (forecastState.forecastTimeIndex > 0) {
                loadForecastSlice(forecastState.forecastTimeIndex - 1);
            }
        }
    });
    
    nextBtn?.addEventListener('click', () => {
        if (forecastState.mode === 'forecast') {
            if (forecastState.forecastTimeIndex < forecastState.forecastIndex.length - 1) {
                loadForecastSlice(forecastState.forecastTimeIndex + 1);
            }
        }
    });
    
    // Check forecast availability on load
    checkForecastAvailability();
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
        <div class="alert-item" data-cell-id="${f.properties.id}" data-cell-name="${f.properties.cell_name}">
            <span class="material-symbols-outlined">error</span>
            <div class="alert-item-content">
                <div class="alert-item-title">${f.properties.cell_name}</div>
                <div class="alert-item-desc">${f.properties.issue_type} • Load: ${formatNumber(f.properties.load)}%</div>
            </div>
        </div>
    `).join('');

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
            case 'f': if (!e.shiftKey) { e.preventDefault(); switchTimeMode(forecastState.mode === 'forecast' ? 'historical' : 'forecast'); } break;
        }
    });

    // Data Exploration Modal
    setupExploreModal();
    
    // Forecast Mode Controls
    setupForecastControls();
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
