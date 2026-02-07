import { state, baseMapOptions } from './state.js';
import { createLayerControls } from './layers.js';
import { createMapSelector, createModeControls, createInstructionsSection, initLanguageToggle, updateModeButtons, initCollapsibles } from './ui.js';
import { loadSchools } from './schools.js';
import { createAutoPaintControl } from './autoPaint.js';
import './editor.js';
import { initMappingTools } from './mappingTools.js';
import { initDuckDB } from './duckdb.js';

document.addEventListener('DOMContentLoaded', () => {
    const overlay = document.getElementById('loading-overlay');
    const loadingMessage = document.getElementById('loading-message');
    const retryBtn = document.getElementById('loading-retry');

    const hideOverlay = () => { if (overlay) overlay.style.display = 'none'; };
    const showOverlay = (msg) => { if (overlay) { overlay.style.display = 'flex'; if (loadingMessage) loadingMessage.textContent = msg || 'Initializing...'; } };

    // Attempt to initialize DuckDB before rendering UI. If it fails, show retry.
    const initializeAndStart = async () => {
        showOverlay('Initializing database — this may take a few seconds...');
        try {
            await initDuckDB();
            // Only hide overlay after UI is constructed
            buildUIOnce();
            hideOverlay();
        } catch (err) {
            console.error('Database initialization failed:', err);
            if (loadingMessage) loadingMessage.textContent = 'Failed to initialize database. You can retry.';
            if (retryBtn) retryBtn.style.display = '';
        }
    };

    retryBtn && retryBtn.addEventListener('click', () => {
        retryBtn.style.display = 'none';
        initializeAndStart();
    });

    // kick off initialization
    initializeAndStart();

    // Build UI only once after DB initialized
    let uiStarted = false;
    function buildUIOnce() {
        if (uiStarted) return;
        uiStarted = true;

        // Create map without the default zoom control (we'll add it at bottomright)
        state.map = L.map('map', { center: [38.4405, -122.7144], zoom: 13, zoomControl: false, layers: [L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 22, maxNativeZoom: 18 })] });
        // Add zoom control at bottom right so it does not overlap the sidebar toggle
        L.control.zoom({ position: 'bottomright' }).addTo(state.map);

        createLayerControls(state.map);
        createInstructionsSection();
        initLanguageToggle();
        initCollapsibles();
        createMapSelector();
        createModeControls();
        // create school manager UI placeholders
        const schoolManagerDiv = document.createElement('div');
        schoolManagerDiv.innerHTML = `
            <h2>Schools</h2>
            <div id="school-sections">
                <div class="school-section">
                    <div class="section-header" data-type="elementary"><span class="toggle-icon">▶</span> Elementary Schools</div>
                    <div class="section-content" style="display: none;"></div>
                </div>
                <div class="school-section">
                    <div class="section-header" data-type="middle"><span class="toggle-icon">▶</span> Middle Schools</div>
                    <div class="section-content" style="display: none;"></div>
                </div>
                <div class="school-section">
                    <div class="section-header" data-type="high"><span class="toggle-icon">▶</span> High Schools</div>
                    <div class="section-content" style="display: none;"></div>
                </div>
                <div class="school-section">
                    <div class="section-header" data-type="other"><span class="toggle-icon">▶</span> Other Schools</div>
                    <div class="section-content" style="display: none;"></div>
                </div>
            </div>
        `;
        document.getElementById('school-list').appendChild(schoolManagerDiv);

        // Toggle handlers for section headers are initialized via initCollapsibles().

        loadSchools();
        // initialize mapping tools UI (merge/export tools) first so it provides the
        // #auto-paint container where the control will insert its UI.
        try { initMappingTools(); } catch (e) { console.warn('mapping tools init failed', e); }
        createAutoPaintControl();

        // keyboard shortcuts / mode toggles
        document.addEventListener('keydown', (e) => {
            if (e.code === 'Space') e.preventDefault();
            if (e.key === 'Escape') { state.mode = 'none'; import('./ui.js').then(m=>m.updateModeButtons()); state.map.getContainer().style.cursor = ''; state.map.dragging.enable(); }
            else if (e.code === 'Space' && !e.repeat) { state.mode = state.mode === 'paint' ? 'none' : 'paint'; import('./ui.js').then(m=>m.updateModeButtons()); state.map.getContainer().style.cursor = state.mode === 'paint' ? 'crosshair' : ''; state.map.dragging.enable(); }
            else if (e.key.toLowerCase() === 'e' && !e.repeat) { state.mode = state.mode === 'eraser' ? 'none' : 'eraser'; import('./ui.js').then(m=>m.updateModeButtons()); state.map.getContainer().style.cursor = state.mode === 'eraser' ? 'not-allowed' : ''; state.map.dragging.enable(); }
        });

        // Update UI when language changes
        window.addEventListener && window.addEventListener('languagechange', () => {
            try { import('./ui.js').then(m=>m.updateLocalizedText()); } catch (e) {}
        });

        // Check URL params for preloading a map. Example: ?map=Proposal%20-%20Elementary
        try {
            const params = new URLSearchParams(window.location.search);
            const mapParam = params.get('map');
            if (mapParam) {
                // defer so the select exists and other UI init finishes
                setTimeout(() => {
                    import('./ui.js').then(m => {
                        m.loadMapByTitle(mapParam).then(found => {
                            if (!found) console.warn('Map not found for URL param map=', mapParam);
                        }).catch(e => console.warn('Error preloading map from URL param', e));
                    }).catch(e => console.warn('Failed to import ui.js for map preload', e));
                }, 100);
            }
        } catch (e) {
            // ignore URL parsing errors
        }
    }
});
