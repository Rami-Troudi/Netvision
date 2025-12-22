'use client'; 

import React, { useEffect, useRef } from 'react';
import { NetVisionTwin } from '../src/main'; // Update path to your class file
import 'maplibre-gl/dist/maplibre-gl.css'; // Don't forget CSS!

const NetworkMap = () => {
    // useRef ensures we only create ONE instance of your class
    const twinRef = useRef(null);
    const initializedRef = useRef(false);

    useEffect(() => {
        // Prevent double-initialization in React Strict Mode
        if (initializedRef.current) return;
        initializedRef.current = true;

        // Initialize the class logic ONLY after the component mounts
        const twin = new NetVisionTwin();
        twinRef.current = twin;
        twin.init();

        // Cleanup on unmount
        return () => {
            if (twinRef.current && twinRef.current.map) {
                twinRef.current.map.remove();
            }
        };
    }, []);

    return (
        <div style={{ position: 'relative', width: '100%', height: '100vh' }}>
            {/* The Map Container */}
            <div id="map" style={{ width: '100%', height: '100%' }} />

            {/* The Loader - Must match IDs in your class */}
            <div id="loader" className="loader-overlay">
                <div className="spinner"></div>
                <div className="msg">Initializing System...</div>
            </div>

            {/* UI Controls - Must match IDs in your class */}
            <div className="ui-overlay">
                <div className="stats-panel">
                    <h3>Network Stats</h3>
                    <div>Load: <span id="kpi-load">--</span></div>
                    <div>T-Put: <span id="kpi-throughput">--</span></div>
                    <div>Congestion: <span id="kpi-congested">--</span></div>
                    <div>Time: <span id="display-time">--</span></div>
                </div>

                <div className="controls">
                    <button id="btn-play">play_arrow</button>
                    <input type="range" id="time-slider" min="0" max="100" defaultValue="0" />
                    <div className="viz-toggles">
                        <button id="viz-std" className="viz-btn active" data-mode="standard">Standard</button>
                        <button id="viz-heat" className="viz-btn" data-mode="heatmap">Heatmap</button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default NetworkMap;
