import { useEffect } from 'react'
import Head from 'next/head'

const pageMarkup = `
        <!-- Header -->
        <header class="header">
            <div class="header-left">
                <div class="logo">
                    <span class="material-symbols-outlined">cell_tower</span>
                    <span class="logo-text">NetVision</span>
                </div>
                <span class="header-subtitle">Digital Twin - Network Operations Center</span>
            </div>
            <div class="header-center">
                <div class="time-mode-indicator">
                    <span class="material-symbols-outlined">history</span>
                    <span>HISTORICAL</span>
                </div>
                <div class="timestamp" id="timestamp"></div>
            </div>
            <div class="header-right">
                <button class="btn-icon" id="btn-theme" title="Toggle Theme (T)">
                    <span class="material-symbols-outlined">dark_mode</span>
                </button>
                <button class="btn-icon" id="btn-analytics" title="Analytics Panel (A)">
                    <span class="material-symbols-outlined">analytics</span>
                </button>
                <button class="btn-icon" id="btn-explore" title="Data Exploration (D)">
                    <span class="material-symbols-outlined">query_stats</span>
                </button>
                <button class="btn-icon" id="btn-export" title="Export Data (E)">
                    <span class="material-symbols-outlined">download</span>
                </button>
                <button class="btn-icon" id="btn-refresh" title="Refresh Data (Ctrl+R)">
                    <span class="material-symbols-outlined">refresh</span>
                </button>
                <button class="btn-icon" id="btn-fullscreen-app" title="Toggle Fullscreen (F11)">
                    <span class="material-symbols-outlined">fullscreen</span>
                </button>
            </div>
        </header>

        <!-- Time Slider Bar -->
        <div class="time-slider-bar" id="time-slider-bar">
            <div class="time-slider-container">
                <button class="time-nav-btn" id="time-prev" title="Previous hour">
                    <span class="material-symbols-outlined">chevron_left</span>
                </button>
                <div class="time-slider-wrapper">
                    <input type="range" id="time-slider" class="time-slider" min="0" max="100" value="0">
                    <div class="time-slider-labels">
                        <span id="time-start-label">--</span>
                        <span id="time-current-label" class="time-current">--</span>
                        <span id="time-end-label">--</span>
                    </div>
                </div>
                <button class="time-nav-btn" id="time-next" title="Next hour">
                    <span class="material-symbols-outlined">chevron_right</span>
                </button>
                <button class="time-play-btn" id="time-play" title="Play/Pause">
                    <span class="material-symbols-outlined">play_arrow</span>
                </button>
            </div>
        </div>

        <!-- Main Content -->
        <div class="main-container">
            <!-- Left Sidebar - Stats -->
            <aside class="sidebar sidebar-left" id="sidebar-left">
                <div class="sidebar-toggle sidebar-toggle-left" id="toggle-left">
                    <span class="material-symbols-outlined">chevron_left</span>
                </div>
                
                <div class="panel stats-panel">
                    <h3 class="panel-title">
                        <span class="material-symbols-outlined">analytics</span>
                        Network Overview
                    </h3>
                    <div class="stats-grid">
                        <div class="stat-card" id="stat-total">
                            <div class="stat-icon">
                                <span class="material-symbols-outlined">cell_tower</span>
                            </div>
                            <div class="stat-content">
                                <div class="stat-value">--</div>
                                <div class="stat-label">Total Cells</div>
                            </div>
                        </div>
                        <div class="stat-card stat-danger" id="stat-congested">
                            <div class="stat-icon">
                                <span class="material-symbols-outlined">warning</span>
                            </div>
                            <div class="stat-content">
                                <div class="stat-value">--</div>
                                <div class="stat-label">Congested</div>
                            </div>
                        </div>
                        <div class="stat-card stat-warning" id="stat-high-load">
                            <div class="stat-icon">
                                <span class="material-symbols-outlined">trending_up</span>
                            </div>
                            <div class="stat-content">
                                <div class="stat-value">--</div>
                                <div class="stat-label">High Load</div>
                            </div>
                        </div>
                        <div class="stat-card stat-success" id="stat-healthy">
                            <div class="stat-icon">
                                <span class="material-symbols-outlined">check_circle</span>
                            </div>
                            <div class="stat-content">
                                <div class="stat-value">--</div>
                                <div class="stat-label">Healthy</div>
                            </div>
                        </div>
                    </div>
                    
                    <!-- Health Score Gauge -->
                    <div class="health-gauge" id="health-gauge">
                        <div class="gauge-container">
                            <svg viewBox="0 0 120 70" class="gauge-svg">
                                <path class="gauge-bg" d="M 10 60 A 50 50 0 0 1 110 60"></path>
                                <path class="gauge-fill" id="gauge-fill" d="M 10 60 A 50 50 0 0 1 110 60"></path>
                            </svg>
                            <div class="gauge-value" id="gauge-value">--</div>
                            <div class="gauge-label">Network Health</div>
                        </div>
                    </div>
                </div>

                <div class="panel">
                    <h3 class="panel-title">
                        <span class="material-symbols-outlined">speed</span>
                        Performance Metrics
                    </h3>
                    <div class="metric-row">
                        <span class="metric-label">Avg Network Load</span>
                        <span class="metric-value" id="metric-avg-load">--%</span>
                    </div>
                    <div class="progress-bar">
                        <div class="progress-fill" id="progress-load"></div>
                    </div>
                    <div class="metric-row">
                        <span class="metric-label">Avg Throughput</span>
                        <span class="metric-value" id="metric-avg-throughput">-- Mbps</span>
                    </div>
                    <div class="metric-row">
                        <span class="metric-label">Avg CQI</span>
                        <span class="metric-value" id="metric-avg-cqi">--</span>
                    </div>
                    <div class="metric-row">
                        <span class="metric-label">Data Coverage</span>
                        <span class="metric-value" id="metric-coverage">--%</span>
                    </div>
                </div>

                <div class="panel">
                    <h3 class="panel-title">
                        <span class="material-symbols-outlined">warning</span>
                        Active Alerts
                        <span class="alert-badge" id="alert-count">0</span>
                    </h3>
                    <div class="alerts-list" id="alerts-list">
                        <div class="alert-placeholder">Loading...</div>
                    </div>
                </div>
            </aside>

            <!-- Map Container -->
            <main class="map-wrapper" id="map-wrapper">
                <div id="map"></div>
                
                <!-- Map Controls Overlay -->
                <div class="map-controls">
                    <div class="control-group">
                        <label class="control-label">Base Map</label>
                        <select id="basemap-select" class="control-select">
                            <option value="satellite">Satellite</option>
                            <option value="dark">Dark</option>
                            <option value="streets">Streets</option>
                            <option value="light">Light</option>
                        </select>
                    </div>
                    <div class="control-group">
                        <label class="control-label">View</label>
                        <div class="toggle-group">
                            <button class="toggle-btn active" data-view="3d">3D</button>
                            <button class="toggle-btn" data-view="2d">2D</button>
                        </div>
                    </div>
                    <div class="control-group">
                        <label class="control-label">Visualization</label>
                        <div class="toggle-group">
                            <button class="toggle-btn active" data-viz="sectors">Sectors</button>
                            <button class="toggle-btn" data-viz="heatmap">Heatmap</button>
                        </div>
                    </div>
                </div>
                
                <!-- Fullscreen Map Toggle -->
                <button class="map-fullscreen-btn" id="btn-map-fullscreen" title="Fullscreen Map (M)">
                    <span class="material-symbols-outlined">open_in_full</span>
                </button>

                <!-- Legend -->
                <div class="legend" id="legend">
                    <div class="legend-header">
                        <h4 class="legend-title">Network Status</h4>
                        <button class="legend-toggle" id="legend-toggle">
                            <span class="material-symbols-outlined">expand_less</span>
                        </button>
                    </div>
                    <div class="legend-content" id="legend-content">
                        <div class="legend-section">
                            <div class="legend-subtitle">PRB Load</div>
                            <div class="legend-gradient">
                                <div class="gradient-bar"></div>
                                <div class="gradient-labels">
                                    <span>0%</span>
                                    <span>50%</span>
                                    <span>100%</span>
                                </div>
                            </div>
                        </div>
                        <div class="legend-section">
                            <div class="legend-subtitle">Cell Status</div>
                            <div class="legend-items">
                                <div class="legend-item">
                                    <div class="legend-color congested-pulse"></div>
                                    <span>Congested</span>
                                </div>
                                <div class="legend-item">
                                    <div class="legend-color" style="background: #FFB74D;"></div>
                                    <span>High Load</span>
                                </div>
                                <div class="legend-item">
                                    <div class="legend-color" style="background: #66BB6A;"></div>
                                    <span>Healthy</span>
                                </div>
                                <div class="legend-item">
                                    <div class="legend-color" style="background: #90CAF9;"></div>
                                    <span>Idle</span>
                                </div>
                                <div class="legend-item">
                                    <div class="legend-color" style="background: #9E9E9E;"></div>
                                    <span>No Data</span>
                                </div>
                            </div>
                        </div>
                        <div class="legend-section">
                            <div class="legend-subtitle">Issue Types</div>
                            <div class="legend-items issue-legend" id="issue-legend">
                                <!-- Populated dynamically -->
                            </div>
                        </div>
                    </div>
                </div>

                    <!-- Cell Info Panel (shown on hover/click) -->
                <div class="cell-info-panel hidden" id="cell-info-panel">
                    <div class="cell-info-header">
                        <h4 id="cell-info-name">Cell Name</h4>
                        <button class="cell-info-close" id="cell-info-close">
                            <span class="material-symbols-outlined">close</span>
                        </button>
                    </div>
                    <div class="cell-info-status-bar">
                        <span class="cell-status" id="cell-status">Normal</span>
                        <span class="cell-health" id="cell-health">Health: --</span>
                    </div>
                    <div class="cell-info-body" id="cell-info-body"></div>
                </div>
                
                <!-- Loading Overlay -->
                <div class="loading-overlay" id="loading-overlay">
                    <div class="loading-spinner"></div>
                    <div class="loading-text">Loading Network Data...</div>
                    <div class="loading-progress" id="loading-progress">0%</div>
                </div>
            </main>

            <!-- Right Sidebar - Filters -->
            <aside class="sidebar sidebar-right" id="sidebar-right">
                <div class="sidebar-toggle sidebar-toggle-right" id="toggle-right">
                    <span class="material-symbols-outlined">chevron_right</span>
                </div>

                <div class="panel recommendation-panel" id="recommendation-panel">
                    <h3 class="panel-title">
                        <span class="material-symbols-outlined">lightbulb</span>
                        Smart Recommendations
                        <span class="reco-badge" id="reco-count">0</span>
                    </h3>
                    <div class="reco-list" id="reco-list">
                        <div class="reco-placeholder">Select a cell to get recommendations</div>
                    </div>
                </div>

                <div class="panel action-panel" id="action-panel">
                    <h3 class="panel-title">
                        <span class="material-symbols-outlined">engineering</span>
                        Action Simulator
                    </h3>
                    <div class="action-field">
                        <label for="action-select">Select action</label>
                        <select id="action-select">
                            <option value="">-- Choose --</option>
                            <option value="tilt">Adjust antenna tilt</option>
                            <option value="add_carrier">Add carrier</option>
                            <option value="redistribute">Redistribute traffic</option>
                        </select>
                    </div>
                    <div class="action-params" id="action-params"></div>
                    <button class="btn-primary action-run" id="action-run">
                        <span class="material-symbols-outlined">play_arrow</span>
                        Run Simulation
                    </button>
                    <div class="action-result" id="action-result"></div>
                </div>
                
                <div class="panel">
                    <h3 class="panel-title">
                        <span class="material-symbols-outlined">filter_alt</span>
                        Filters
                    </h3>
                    
                    <div class="filter-group">
                        <label class="filter-label">Cell Status</label>
                        <div class="checkbox-group">
                            <label class="checkbox-item">
                                <input type="checkbox" data-filter="congested" checked>
                                <span class="checkmark danger"></span>
                                <span>Congested</span>
                            </label>
                            <label class="checkbox-item">
                                <input type="checkbox" data-filter="high-load" checked>
                                <span class="checkmark warning"></span>
                                <span>High Load</span>
                            </label>
                            <label class="checkbox-item">
                                <input type="checkbox" data-filter="normal" checked>
                                <span class="checkmark success"></span>
                                <span>Normal</span>
                            </label>
                            <label class="checkbox-item">
                                <input type="checkbox" data-filter="idle" checked>
                                <span class="checkmark idle"></span>
                                <span>Idle</span>
                            </label>
                            <label class="checkbox-item">
                                <input type="checkbox" data-filter="no-data" checked>
                                <span class="checkmark nodata"></span>
                                <span>No Data</span>
                            </label>
                        </div>
                    </div>
                    
                    <div class="filter-group">
                        <label class="filter-label">Issue Type</label>
                        <div class="checkbox-group" id="issue-type-filters">
                            <!-- Populated dynamically -->
                        </div>
                    </div>

                    <div class="filter-group">
                        <label class="filter-label">Frequency Band</label>
                        <div class="checkbox-group" id="frequency-filters"></div>
                    </div>

                    <div class="filter-group">
                        <label class="filter-label">Load Range: <span id="load-range-display">0% - 100%</span></label>
                        <div class="range-slider">
                            <input type="range" id="load-min" min="0" max="100" value="0" class="range-input">
                            <input type="range" id="load-max" min="0" max="100" value="100" class="range-input">
                        </div>
                    </div>
                    
                    <div class="filter-group">
                        <label class="filter-label">Severity: <span id="severity-range-display">0 - 100</span></label>
                        <div class="range-slider">
                            <input type="range" id="severity-min" min="0" max="100" value="0" class="range-input">
                            <input type="range" id="severity-max" min="0" max="100" value="100" class="range-input">
                        </div>
                    </div>

                    <div class="filter-actions">
                        <button class="btn-primary" id="btn-apply-filters">
                            <span class="material-symbols-outlined">filter_alt</span>
                            Apply
                        </button>
                        <button class="btn-secondary" id="btn-reset-filters">
                            <span class="material-symbols-outlined">restart_alt</span>
                            Reset
                        </button>
                    </div>
                </div>

                <div class="panel">
                    <h3 class="panel-title">
                        <span class="material-symbols-outlined">search</span>
                        Search
                    </h3>
                    <div class="search-container">
                        <span class="material-symbols-outlined search-icon">search</span>
                        <input type="text" id="cell-search" class="search-input" placeholder="Search cells or sites... (F)">
                        <button class="search-clear hidden" id="search-clear">
                            <span class="material-symbols-outlined">close</span>
                        </button>
                    </div>
                    <div class="search-results" id="search-results"></div>
                </div>

                <div class="panel">
                    <h3 class="panel-title">
                        <span class="material-symbols-outlined">layers</span>
                        Layers
                    </h3>
                    <label class="checkbox-item">
                        <input type="checkbox" id="layer-sectors" checked>
                        <span class="checkmark"></span>
                        <span>Cell Sectors</span>
                    </label>
                    <label class="checkbox-item">
                        <input type="checkbox" id="layer-sites" checked>
                        <span class="checkmark"></span>
                        <span>Site Markers</span>
                    </label>
                    <label class="checkbox-item">
                        <input type="checkbox" id="layer-labels">
                        <span class="checkmark"></span>
                        <span>Cell Labels</span>
                    </label>
                    <label class="checkbox-item">
                        <input type="checkbox" id="layer-clusters" checked>
                        <span class="checkmark"></span>
                        <span>Clustering (performance)</span>
                    </label>
                </div>

                <div class="panel shortcuts-panel">
                    <h3 class="panel-title">
                        <span class="material-symbols-outlined">keyboard</span>
                        Shortcuts
                    </h3>
                    <div class="shortcuts-grid">
                        <div><span class="kbd">F</span> Search</div>
                        <div><span class="kbd">M</span> Map Fullscreen</div>
                        <div><span class="kbd">R</span> Reset View</div>
                        <div><span class="kbd">T</span> Theme</div>
                        <div><span class="kbd">2</span> 2D View</div>
                        <div><span class="kbd">3</span> 3D View</div>
                        <div><span class="kbd">A</span> Analytics</div>
                        <div><span class="kbd">D</span> Data Explore</div>
                        <div><span class="kbd">E</span> Export</div>
                    </div>
                </div>
            </aside>
        </div>
        
        <!-- Analytics Modal -->
        <div class="modal-overlay hidden" id="analytics-modal">
            <div class="modal analytics-modal">
                <div class="modal-header">
                    <h2>
                        <span class="material-symbols-outlined">analytics</span>
                        Network Analytics
                    </h2>
                    <button class="modal-close" id="analytics-close">
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </div>
                <div class="modal-body">
                    <div class="analytics-grid">
                        <div class="analytics-card">
                            <h4>Issue Distribution</h4>
                            <canvas id="chart-issues"></canvas>
                        </div>
                        <div class="analytics-card">
                            <h4>Severity Distribution</h4>
                            <canvas id="chart-severity"></canvas>
                        </div>
                        <div class="analytics-card">
                            <h4>Band Performance</h4>
                            <canvas id="chart-bands"></canvas>
                        </div>
                        <div class="analytics-card">
                            <h4>Load Distribution</h4>
                            <canvas id="chart-load"></canvas>
                        </div>
                    </div>
                    <div class="analytics-summary" id="analytics-summary">
                        <!-- Populated dynamically -->
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Data Exploration Modal -->
        <div class="modal-overlay hidden" id="explore-modal">
            <div class="modal explore-modal">
                <div class="modal-header">
                    <h2>
                        <span class="material-symbols-outlined">query_stats</span>
                        Data Exploration
                    </h2>
                    <button class="modal-close" id="explore-close">
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </div>
                <div class="modal-body">
                    <div class="explore-controls">
                        <div class="explore-control-group">
                            <label for="explore-duration">Time Aggregation</label>
                            <select id="explore-duration">
                                <option value="hour">By Hour of Day</option>
                                <option value="day">By Day</option>
                                <option value="week">By Week</option>
                            </select>
                        </div>
                        <div class="explore-control-group">
                            <label for="explore-metric">Metric</label>
                            <select id="explore-metric">
                                <option value="congested">Congested Cells</option>
                                <option value="avg_load">Average Load (%)</option>
                                <option value="avg_cqi">Average CQI</option>
                                <option value="congestion_rate">Congestion Rate (%)</option>
                            </select>
                        </div>
                        <button class="btn-primary" id="explore-refresh">
                            <span class="material-symbols-outlined">refresh</span>
                            Update
                        </button>
                    </div>
                    <div class="explore-charts">
                        <div class="explore-chart-card">
                            <h4 id="explore-chart-title">Peak Hours Analysis</h4>
                            <canvas id="chart-explore-main"></canvas>
                        </div>
                        <div class="explore-chart-card">
                            <h4>Congestion Timeline</h4>
                            <canvas id="chart-explore-timeline"></canvas>
                        </div>
                    </div>
                    <div class="explore-insights" id="explore-insights">
                        <!-- Populated dynamically -->
                    </div>
                </div>
            </div>
        </div>

        <!-- Export Modal -->
        <div class="modal-overlay hidden" id="export-modal">
            <div class="modal export-modal">
                <div class="modal-header">
                    <h2>
                        <span class="material-symbols-outlined">download</span>
                        Export Data
                    </h2>
                    <button class="modal-close" id="export-close">
                        <span class="material-symbols-outlined">close</span>
                    </button>
                </div>
                <div class="modal-body">
                    <div class="export-options">
                        <button class="export-btn" id="export-json">
                            <span class="material-symbols-outlined">data_object</span>
                            <span>Export JSON</span>
                            <small>Full data with all metrics</small>
                        </button>
                        <button class="export-btn" id="export-csv">
                            <span class="material-symbols-outlined">table_chart</span>
                            <span>Export CSV</span>
                            <small>Spreadsheet compatible</small>
                        </button>
                        <button class="export-btn" id="export-report">
                            <span class="material-symbols-outlined">description</span>
                            <span>Generate Report</span>
                            <small>Summary with insights</small>
                        </button>
                        <button class="export-btn" id="export-congested">
                            <span class="material-symbols-outlined">warning</span>
                            <span>Congested Cells Only</span>
                            <small>Filtered issue data</small>
                        </button>
                    </div>
                </div>
            </div>
        </div>`

export default function Home() {
  useEffect(() => {
    const load = async () => {
      await import('../src/main')
    }
    load()
  }, [])

  return (
    <>
      <Head>
        <title>NetVision Digital Twin | Orange Network Operations</title>
      </Head>
      <div id="app" dangerouslySetInnerHTML={{ __html: pageMarkup }} />
    </>
  )
}
