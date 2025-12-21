import './style.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import maplibregl from 'maplibre-gl';

// --- Configuration ---
const DEFAULT_BEAMWIDTH = 60; // Degrees
const DEFAULT_RADIUS_METERS = 500; // Fallback radius if TA is missing
const TA_TO_METERS = 78; // 1 TA unit approx 78 meters

// --- Helper Functions ---
function createSectorGeoJSON(center, radiusMeters, azimuth, beamwidth) {
    const steps = 32;
    const earthRadius = 6378137;
    const latRad = (center[1] * Math.PI) / 180;
    
    const startAzimuth = azimuth - beamwidth / 2;
    const endAzimuth = azimuth + beamwidth / 2;
    
    const coordinates = [center]; // Start at center
    
    for (let i = 0; i <= steps; i++) {
        const currentAzimuth = startAzimuth + (i / steps) * (endAzimuth - startAzimuth);
        const angleRad = ((90 - currentAzimuth) * Math.PI) / 180;
        
        const dx = radiusMeters * Math.cos(angleRad);
        const dy = radiusMeters * Math.sin(angleRad);
        
        const dLon = dx / (earthRadius * Math.cos(latRad) * Math.PI / 180);
        const dLat = dy / (earthRadius * Math.PI / 180);
        
        coordinates.push([center[0] + dLon, center[1] + dLat]);
    }
    
    coordinates.push(center); // Close the loop
    return [coordinates];
}

// --- Data Processing ---
const features = [];

// Fetch and process the JSON data
fetch('/data.json')
    .then(response => response.json())
    .then(parsedData => {
        parsedData.forEach((item, index) => {
            if (item.longitude_sector && item.latitude_sector) {
                const center = [item.longitude_sector, item.latitude_sector];
                const azimuth = item.azimuth || 0;
                
                let radius = DEFAULT_RADIUS_METERS;
                if (item.ot_average_ta != null && item.ot_average_ta > 0) {
                    radius = item.ot_average_ta * TA_TO_METERS;
                    if (radius < 100) radius = 100;
                }

                const geometry = createSectorGeoJSON(center, radius, azimuth, DEFAULT_BEAMWIDTH);
                
                // Determine Load Color
                const load = item.ft_physical_resource_blocks_load_dl;
                let color = '#9E9E9E'; // Default No Data (Gray)
                let opacity = 0.4;
                
                if (load != null && !isNaN(load)) {
                    // Gradient Logic
                    if (load === 0) color = '#C8DCFF';     // Idle (Blue)
                    else if (load < 30) color = '#4CAF50'; // Green
                    else if (load < 60) color = '#FFEB3B'; // Yellow
                    else if (load < 80) color = '#FF9800'; // Orange
                    else color = '#F44336';                // Red
                    
                    // Opacity based on Signal Power
                    if (item.referencesignalpwr) {
                        const minPwr = 140;
                        const maxPwr = 190;
                        const norm = Math.max(0, Math.min(1, (item.referencesignalpwr - minPwr) / (maxPwr - minPwr)));
                        opacity = 0.5 + (norm * 0.4);
                    } else {
                        opacity = 0.7;
                    }
                } else {
                    // No Data case
                    opacity = 0.3;
                }

                features.push({
                    type: 'Feature',
                    properties: {
                        id: index,
                        cell_name: item.cell_name,
                        color: color,
                        opacity: opacity,
                        load: load,
                        congested: item.congested,
                        root_cause: item.root_cause,
                        traffic: item.l_traffic_activeuser_dl_avg,
                        throughput: item.ft_ave_4g_lte_dl_user_thrput_without_last_tti_all___kbps__kbit_,
                        cqi: item.ft_4g_lte_average_reported_cqi,
                        ta: item.ot_average_ta
                    },
                    geometry: {
                        type: 'Polygon',
                        coordinates: geometry
                    }
                });
            }
        });

        const geojson = {
            type: 'FeatureCollection',
            features: features
        };

        // Map Initialization
        const map = new maplibregl.Map({
            container: 'map',
            style: {
                version: 8,
                sources: {
                    'osm-tiles': {
                        type: 'raster',
                        tiles: [
                            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
                        ],
                        tileSize: 256,
                        attribution: '&copy; Esri'
                    }
                },
                layers: [
                    {
                        id: 'simple-tiles',
                        type: 'raster',
                        source: 'osm-tiles',
                        minzoom: 0,
                        maxzoom: 22
                    }
                ]
            },
            center: [10.6, 35.8],
            zoom: 12,
            pitch: 45, // Tilt the map
            bearing: -10, // Rotate slightly
            antialias: true
        });

        map.addControl(new maplibregl.NavigationControl());

        map.on('load', () => {
            map.addSource('sectors', {
                type: 'geojson',
                data: geojson
            });

            map.addLayer({
                id: 'sectors-fill',
                type: 'fill',
                source: 'sectors',
                paint: {
                    'fill-color': ['get', 'color'],
                    'fill-opacity': ['get', 'opacity'],
                    'fill-outline-color': '#ffffff'
                }
            });

            map.addLayer({
                id: 'sectors-line',
                type: 'line',
                source: 'sectors',
                paint: {
                    'line-color': '#ffffff',
                    'line-width': 1,
                    'line-opacity': 0.8
                }
            });

            const popup = new maplibregl.Popup({
                closeButton: false,
                closeOnClick: false
            });

            map.on('mousemove', 'sectors-fill', (e) => {
                map.getCanvas().style.cursor = 'pointer';

                const props = e.features[0].properties;
                const coordinates = e.lngLat;

                const content = `<div style='font-family: sans-serif; padding: 5px;'>
                    <h3 style='margin: 0 0 5px 0; border-bottom: 1px solid #ccc;'>${props.cell_name}</h3>
                    <div><b>Status:</b> ${props.congested ? '<span style=\"color:red\">CONGESTED</span>' : '<span style=\"color:green\">Normal</span>'}</div>
                    <div><b>Root Cause:</b> ${props.root_cause}</div>
                    <div><b>Load:</b> ${props.load != null ? props.load.toFixed(1) + '%' : '<span style=\"color:gray\">No Data</span>'}</div>
                    <div><b>Traffic:</b> ${props.traffic != null ? props.traffic.toFixed(2) : 'N/A'}</div>
                    <div><b>Avg TA:</b> ${props.ta != null ? props.ta.toFixed(1) : 'N/A'}</div>
                </div>`;

                popup.setLngLat(coordinates).setHTML(content).addTo(map);

                map.setPaintProperty('sectors-fill', 'fill-opacity', [
                    'case',
                    ['==', ['get', 'id'], props.id],
                    0.9, // Highlight opacity
                    ['get', 'opacity'] // Normal opacity
                ]);
            });

            map.on('mouseleave', 'sectors-fill', () => {
                map.getCanvas().style.cursor = '';
                popup.remove();
                map.setPaintProperty('sectors-fill', 'fill-opacity', ['get', 'opacity']);
            });
        });
    })
    .catch(error => console.error('Error fetching or processing CSV data:', error));
