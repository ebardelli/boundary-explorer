import { state, updateStateMapBatch, updateStateMapRow, setCurrentTable, featureStyleDefaults } from './state.js';
import { initDuckDB, getConnection, ensureFeatsView, runQuery } from './duckdb.js';
import { translate } from './i18n.js';
import { attachColorPickers, setLayerColor } from './layers.js';
import { inferTableFromGeojsonAndFilename, exportGeojson } from './fileManager.js';

// Helper: simple GeoJSON FeatureCollection -> SQL table loader and merge using DuckDB spatial.
// Exposes initMappingTools() to wire UI and mergeBySchool() to run the operation.

// Helper to obtain a stable block id for a feature. Prefer `block_of_residence`.
// If missing, try common alternatives, and finally fall back to an index-based id.
export function getBlockId(feature, fallbackIndex) {
    if (!feature) return `idx_${fallbackIndex}`;
    const p = feature.properties || {};
    // prefer explicit block_of_residence
    if (p.block_of_residence !== undefined && p.block_of_residence !== null && String(p.block_of_residence).trim() !== '') return String(p.block_of_residence);
    // common alternatives
    if (p.GEOID !== undefined && p.GEOID !== null && String(p.GEOID).trim() !== '') return String(p.GEOID);
    if (p.GEOID20 !== undefined && p.GEOID20 !== null && String(p.GEOID20).trim() !== '') return String(p.GEOID20);
    if (p.geoid !== undefined && p.geoid !== null && String(p.geoid).trim() !== '') return String(p.geoid);
    if (feature.id !== undefined && feature.id !== null && String(feature.id).trim() !== '') return String(feature.id);
    return `idx_${fallbackIndex}`;
}

// Queue for tool buttons registered before Mapping Tools initializes.
let _pendingToolButtons = [];

/**
 * Register a tool button to be inserted into the Mapping Tools controls.
 * If the controls container exists, the element will be inserted immediately.
 * Otherwise it will be queued and flushed when initMappingTools() runs.
 * @param {HTMLElement} el - The button element to insert
 * @param {string} [afterId] - Optional element ID to insert after (e.g. 'import-btn')
 */
export function registerToolButton(el, afterId) {
    if (!el) return;
    const container = typeof document !== 'undefined' ? document.getElementById('map-editor-controls') : null;
    if (container) {
        // Prefer inserting into the map-editor-row so all buttons are visually grouped
        const row = container.querySelector('.map-editor-row') || container;
        if (afterId) {
            const ref = document.getElementById(afterId);
            if (ref) {
                // If the reference is inside the row, insert after it; otherwise append to row
                if (ref.parentElement && row.contains(ref)) {
                    ref.parentElement.insertBefore(el, ref.nextSibling);
                    return;
                }
            }
        }
            row.appendChild(el);
            // keep export button visually last
            const exportBtn = row.querySelector('#export-btn');
            if (exportBtn) row.appendChild(exportBtn);
        return;
    }
    // not ready yet - queue for later
    _pendingToolButtons.push({ el, afterId });
}

// expose via window for modules that don't import mappingTools directly
if (typeof window !== 'undefined') window.registerMappingToolButton = registerToolButton;

export function initMappingTools() {
    // create a dedicated section after the Import / Export section
    const left = document.getElementById('left-column');
    if (!left) return;

    // prefer an explicit mapping-tools placeholder; fall back to the old import-export container
    const mappingPlaceholder = left.querySelector('#mapping-tools-placeholder');
    const importExportContainer = left.querySelector('#import-export');
    // build the section element (default to open so mapping tools are visible)
    const section = document.createElement('div');
    section.className = 'section open';
    section.innerHTML = `
        <div class="section-header open" role="button" aria-expanded="true">
            <span class="toggle-icon">▶</span>
            <strong>${translate('mappingTools.title')}</strong>
        </div>
        <div class="section-content">
            <div id="map-editor-controls"></div>
        </div>
    `;

    // Insert at explicit mapping placeholder if present. Otherwise insert after
    // the import/export section (legacy) or append to the left column.
    if (mappingPlaceholder && mappingPlaceholder.parentElement) {
        mappingPlaceholder.parentElement.insertBefore(section, mappingPlaceholder);
    } else if (importExportContainer && importExportContainer.parentElement && importExportContainer.parentElement.parentElement) {
        const importSection = importExportContainer.closest('.section');
        if (importSection && importSection.parentElement) importSection.parentElement.insertBefore(section, importSection.nextSibling);
        else left.appendChild(section);
    } else {
        left.appendChild(section);
    }

    const container = document.getElementById('map-editor-controls');
    container.innerHTML = `
        <div class="map-editor-row">
            <button id="import-btn" class="tool-list-button">${translate('importGeojson')}</button>
            <input type="file" id="geojson-upload" style="display:none" accept=".geojson, .json" />
            <button id="upload-layer-btn" class="tool-list-button">${translate('mappingTools.uploadLayer')}</button>
            <button id="paint-by-layer-btn" class="tool-list-button">${translate('mappingTools.paintByLayer')}</button>
            <button id="assign-by-neighbors-btn" class="tool-list-button">${translate('mappingTools.assignByNeighbors')}</button>
            <button id="merge-by-school-btn" class="tool-list-button primary">${translate('mappingTools.mergeBySchool')}</button>
            <button id="export-btn" class="tool-list-button">${translate('exportGeojson')}</button>
        </div>
    `;

    // flush any buttons that were registered before Mapping Tools initialized
    if (_pendingToolButtons && _pendingToolButtons.length > 0) {
        _pendingToolButtons.forEach(item => {
            try {
                registerToolButton(item.el, item.afterId);
            } catch (e) { console.warn('Failed to register pending tool button', e); }
        });
        _pendingToolButtons = [];
    }

    // Consume the global fallback queue created by fileManager.js when it
    // created legacy import/export buttons before Mapping Tools initialized.
    try {
        if (typeof window !== 'undefined' && Array.isArray(window._mappingToolsButtonQueue) && window._mappingToolsButtonQueue.length > 0) {
            window._mappingToolsButtonQueue.forEach(item => {
                try { registerToolButton(item.el, item.afterId); } catch (e) { console.warn('Failed to register queued fallback button', e); }
            });
            // clear queue so it won't be processed again
            window._mappingToolsButtonQueue = [];

            // remove legacy fallback container to avoid duplicate UI
            const importExportEl = document.getElementById('import-export');
            if (importExportEl) {
                try { importExportEl.innerHTML = ''; } catch (e) { /* ignore */ }
            }
        }
    } catch (e) { /* ignore */ }

    // Add Auto Paint as a nested, collapsible subsection at the bottom of Mapping Tools
    const autoSection = document.createElement('div');
    autoSection.className = 'section';
    autoSection.innerHTML = `
        <div class="section-header" role="button" aria-expanded="false">
            <span class="toggle-icon">▶</span>
            <strong>Auto Paint</strong>
        </div>
        <div class="section-content">
            <div id="auto-paint"></div>
        </div>
    `;
    // append to the container inside the Mapping Tools section
    container.appendChild(autoSection);

    // Move the status element to the bottom of the section (after auto-paint)
    // Create a single status element that all mapping tools can reuse.
    const statusWrapper = document.createElement('div');
    statusWrapper.id = 'merge-status-wrapper';
    statusWrapper.style = 'font-size:12px; color:#666; margin-top:6px;';
    statusWrapper.innerHTML = `<div id="merge-status"></div>`;
    container.appendChild(statusWrapper);

    const btn = document.getElementById('merge-by-school-btn');
    const status = document.getElementById('merge-status');
    btn.addEventListener('click', async () => {
            try {
            btn.disabled = true;
            status.textContent = translate('mappingTools.merging');
            await mergeBySchool(status);
            status.textContent = translate('mappingTools.mergeComplete');
        } catch (err) {
            console.error('Merge failed', err);
            status.textContent = translate('mappingTools.mergeFailedPrefix') + (err && err.message ? err.message : String(err));
        } finally {
            btn.disabled = false;
            setTimeout(()=>{ if (status) status.textContent = ''; }, 4000);
        }
    });

    const assignBtn = document.getElementById('assign-by-neighbors-btn');
    assignBtn.addEventListener('click', async () => {
            try {
            assignBtn.disabled = true;
            status.textContent = translate('mappingTools.assigning');
            await assignByNeighbors(status);
            status.textContent = translate('mappingTools.assignComplete');
        } catch (err) {
            console.error('Assign by neighbors failed', err);
            status.textContent = translate('mappingTools.assignFailedPrefix') + (err && err.message ? err.message : String(err));
        } finally {
            assignBtn.disabled = false;
            setTimeout(()=>{ if (status) status.textContent = ''; }, 4000);
        }
    });

    const paintByLayerBtn = document.getElementById('paint-by-layer-btn');
    paintByLayerBtn.addEventListener('click', async () => {
            try {
            paintByLayerBtn.disabled = true;
            status.textContent = translate('mappingTools.painting');
            await paintByLayer(status);
            status.textContent = translate('mappingTools.paintComplete');
        } catch (err) {
            console.error('Paint by layer failed', err);
            status.textContent = translate('mappingTools.paintFailedPrefix') + (err && err.message ? err.message : String(err));
        } finally {
            paintByLayerBtn.disabled = false;
            setTimeout(()=>{ if (status) status.textContent = ''; }, 4000);
        }
    });

    // Upload layer button handler: allow user to choose a GeoJSON file, add it as an overlay
    const uploadBtn = document.getElementById('upload-layer-btn');
    uploadBtn.addEventListener('click', async () => {
        const statusEl = document.getElementById('merge-status');
        try {
            uploadBtn.disabled = true;
            statusEl.textContent = translate('mappingTools.uploadSelectPrompt');
            await uploadLayerHandler();
            statusEl.textContent = translate('mappingTools.uploadSuccess');
        } catch (err) {
            console.error('Upload layer failed', err);
            statusEl.textContent = translate('mappingTools.uploadFailedPrefix') + (err && err.message ? err.message : String(err));
        } finally {
            uploadBtn.disabled = false;
            setTimeout(()=>{ if (statusEl) statusEl.textContent = ''; }, 4000);
        }
    });

    const importBtn = document.getElementById('import-btn');
    const exportBtn = document.getElementById('export-btn');
    const fileInput = document.getElementById('geojson-upload');

    

    // wire import button to trigger hidden file input
    importBtn && importBtn.addEventListener('click', () => fileInput && fileInput.click());

    // import file change handler: reuse logic from fileManager.js but scoped here
    if (fileInput) {
        fileInput.addEventListener('change', (event) => {
            const file = event.target.files && event.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const geojson = JSON.parse(e.target.result);

                    // Try to infer the currentTable from the imported file (centralized helper)
                    try {
                        const inferredTable = inferTableFromGeojsonAndFilename(geojson, file && file.name);
                        if (inferredTable) {
                            setCurrentTable(inferredTable);
                            console.log('Inferred state.currentTable from import:', inferredTable);
                        }
                    } catch (inferErr) {
                        console.warn('Failed to infer currentTable from import:', inferErr);
                    }

                    // Before loading a new file, flush any existing schools/state so the
                    // imported map becomes the single source of truth for schools.
                    import('./importHelpers.js').then(async (helpers) => {
                        await helpers.flushSchools({ reloadDefaults: false });

                        // load the geojson into the map
                        const paint = await import('./paint.js');
                        paint.loadGeoJSON(geojson);

                        // Use shared finalization so import and base-map loads behave the same
                        helpers.finalizeGeojsonImport(geojson);
                    });
                } catch (error) {
                    alert('Invalid GeoJSON file');
                    console.error('Error parsing GeoJSON:', error);
                }
            };
            reader.readAsText(file);
        });
    }

    // export handler: serialize state.geojsonData and prompt for filename, then download
    exportBtn && exportBtn.addEventListener('click', () => exportGeojson(state.geojsonData));

    // Keep localized labels updated when language changes
    if (typeof window !== 'undefined') {
        window.addEventListener('languagechange', () => {
            const importBtnEl = document.getElementById('import-btn');
            if (importBtnEl) importBtnEl.textContent = translate('importGeojson');
            const exportBtnEl = document.getElementById('export-btn');
            if (exportBtnEl) exportBtnEl.textContent = translate('exportGeojson');
        });
    }

    // Ensure any tool-button elements that are appended directly to the
    // container by other modules are moved into the .map-editor-row so the
    // visual list remains consistent.
    try {
        const row = container.querySelector('.map-editor-row');
        if (row && typeof MutationObserver !== 'undefined') {
            const mo = new MutationObserver(mutations => {
                for (const m of mutations) {
                    for (const n of m.addedNodes) {
                        try {
                            if (!n || n.nodeType !== 1) continue;
                            // If the added node is itself a tool-button, move it
                            if (n.matches && n.matches('.tool-list-button')) {
                                row.appendChild(n);
                                continue;
                            }
                            // If the added node contains tool-button descendants, move them
                            const descendants = n.querySelectorAll ? n.querySelectorAll('.tool-list-button') : [];
                            descendants.forEach(d => row.appendChild(d));
                        } catch (e) { /* non-fatal */ }
                    }
                }
            });
            mo.observe(container, { childList: true, subtree: false });
        }
    } catch (e) { /* ignore if MutationObserver not available */ }
}

// Helper: prompt for a single GeoJSON file, parse it, and install as an overlay
async function uploadLayerHandler() {
    return new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.geojson,application/geo+json,application/json';
        input.style.display = 'none';
        document.body.appendChild(input);

        let focusHandler = null;
        let cleanedUp = false;
        function cleanUp() {
            if (cleanedUp) return;
            cleanedUp = true;
            try { if (focusHandler) window.removeEventListener('focus', focusHandler); } catch (e) {}
            try { if (input && input.parentElement) document.body.removeChild(input); } catch (e) {}
        }

        input.addEventListener('change', async (ev) => {
            // If a change event occurs, user selected a file (or cleared selection).
            if (focusHandler) {
                try { window.removeEventListener('focus', focusHandler); } catch (e) {}
                focusHandler = null;
            }
            const f = input.files && input.files[0];
            if (!f) {
                cleanUp();
                return reject(new Error('No file selected'));
            }
            const reader = new FileReader();
            reader.onload = async (e) => {
                try {
                    const text = e.target.result;
                    let json = null;
                    try { json = JSON.parse(text); } catch (pe) { throw new Error('Invalid JSON file'); }

                    // Basic TopoJSON detection - we don't support it here
                    if (json && json.type === 'Topology') {
                        throw new Error('TopoJSON not supported. Please provide GeoJSON.');
                    }

                    // Normalize single Feature -> FeatureCollection
                    if (json && json.type === 'Feature') json = { type: 'FeatureCollection', features: [json] };
                    if (!json || (json.type !== 'FeatureCollection' && json.type !== 'GeometryCollection')) {
                        throw new Error('Uploaded file is not a GeoJSON FeatureCollection or Feature');
                    }

                    const name = (f.name || 'uploaded-layer').replace(/\.geojson$/i, '').replace(/\.[^.]+$/, '');
                    await addUploadedLayerToMap(json, name);
                    cleanUp();
                    resolve();
                } catch (err) {
                    cleanUp();
                    reject(err);
                }
            };
            reader.onerror = (err) => { cleanUp(); reject(new Error('Failed to read file')); };
            reader.readAsText(f);
        });

        // Detect cancel: when file dialog closes the window usually regains focus.
        // If that happens and no file is selected, treat it as cancel and reject so callers can re-enable UI.
        focusHandler = () => {
            // Give the browser a tick to populate input.files if user did select.
            setTimeout(() => {
                if (!(input.files && input.files.length > 0)) {
                    cleanUp();
                    reject(new Error('File selection canceled'));
                }
            }, 50);
        };
        window.addEventListener('focus', focusHandler, { once: true });

        // trigger file picker
        input.click();
    });
}

// Create a Leaflet overlay from a GeoJSON object, register it in layer control and activate it
async function addUploadedLayerToMap(geojson, displayName) {
    if (!state.map) throw new Error('Map not initialized');
    const map = state.map;

    // Ensure top-overlays pane exists (layers.createLayerControls normally ensures this)
    try { if (!map.getPane('top-overlays')) map.createPane('top-overlays'); } catch (e) {}

    // Pick an initial color from the palette
    const presetColors = ['#6a3d9a','#1f78b4','#33a02c','#e31a1c','#ff7f00','#b15928','#a6cee3'];
    const color = presetColors[Math.floor(Math.random() * presetColors.length)];

    const layer = L.geoJSON(geojson, {
        pane: 'top-overlays',
        // match style used by other overlay boundary layers: outline-only, transparent fill
        style: { color: color, weight: 4, opacity: 1, fillOpacity: 0, interactive: false },
        interactive: false,
        onEachFeature: (feature, featureLayer) => {
            // keep overlays non-interactive by default so they don't block map clicks
            try { const el = featureLayer.getElement?.(); if (el) el.setAttribute('pointer-events', 'none'); } catch (e) {}
        }
    });

    // generate a unique display name if there are conflicts
    let finalName = displayName || 'Uploaded Layer';
    const overlays = map.customLayers && map.customLayers.overlays ? map.customLayers.overlays : {};
    let suffix = 1;
    while (overlays[finalName]) {
        finalName = `${displayName} (${suffix++})`;
    }

    // annotate the layer for future reference
    layer._layerKey = 'uploaded_' + Date.now();
    layer._uploaded = true;

    // Add to the layers control if present, otherwise just add to map.customLayers
    try {
        if (!map.customLayers) map.customLayers = { base: {}, overlays: {} };
        map.customLayers.overlays = map.customLayers.overlays || {};
        map.customLayers.overlays[finalName] = layer;

        if (map.layerControl && typeof map.layerControl.addOverlay === 'function') {
            map.layerControl.addOverlay(layer, finalName);
        }
        // Activate (show) the uploaded layer
        map.addLayer(layer);

        // Persist initial color and add color picker swatch for the new layer
        try {
            if (typeof setLayerColor === 'function') setLayerColor(map, finalName, color);
            if (typeof attachColorPickers === 'function') attachColorPickers(map);
        } catch (e) {
            // non-fatal
            console.warn('Failed to attach color picker for uploaded layer', e);
        }
    } catch (e) {
        console.warn('Failed to register uploaded layer with layer control, adding directly to map', e);
        map.addLayer(layer);
    }

    // allow consumers to interact with this new overlay (for example paintByLayer will check map.customLayers.overlays)
    // no need to await anything; return immediately
    return;
}

// Assign unassigned features by majority vote of touching neighbors.
async function assignByNeighbors(statusEl) {
    if (!state.geojsonData || !Array.isArray(state.geojsonData.features)) {
        throw new Error('No geojson loaded');
    }

    // Prepare DuckDB and a temporary table with id, school, geom
    await initDuckDB();
    const conn = await getConnection();

    try {
        await runQuery(conn, 'load spatial;');

        // Ensure the __feats view is created to join the attached data.<table>.geom
        // with the in-memory stateMap so we can operate on a single source.
        try {
            await ensureFeatsView(state.currentTable);
        } catch (e) {
            console.warn('Failed to ensure __feats view; ensure state.currentTable is set and data table attached', e);
            throw e;
        }

        // Iteratively assign schools: for unassigned features, pick the most-common touching neighbor school
    let prevRemaining = Number.POSITIVE_INFINITY;
    let remainingRows = await runQuery(conn, "select count(*) as cnt from __feats where school is null or school = '';");
    // DuckDB returns integers as BigInt in the JS client; convert to Number for comparisons
    let remaining = Number(remainingRows[0].cnt || 0);
        let iter = 0;
        while (remaining > 0 && remaining < prevRemaining && iter < 100) {
            iter++;
            if (statusEl) statusEl.textContent = `Assigning... iteration ${iter}, remaining ${remaining}`;

            // Build neighbor-top and update
            // Compute the top neighbor school for each unassigned feature and
            // persist those assignments into stateMap so the __feats view will
            // reflect the changes on the next iteration.
            const neighborTopSql = `
                with neighbor_counts as (
                    select t.id as target_id, n.school as neighbor_school, count(*) as cnt
                    from __feats t
                        join __feats n on st_touches(t.geom, n.geom)
                    where (t.school is null or t.school = '') and (n.school is not null and n.school <> '')
                    group by target_id, neighbor_school
                ),
                neighbor_top as (
                    select target_id, neighbor_school from (
                        select target_id, neighbor_school, cnt,
                        row_number() over(partition by target_id order by cnt desc) as rn
                        from neighbor_counts
                    ) where rn = 1
                )
                select target_id as id, neighbor_school as school from neighbor_top;
            `;
            const topRows = await runQuery(conn, neighborTopSql);
            const updates = [];
            topRows.forEach(r => {
                try {
                    const id = r.target_id ?? r.id;
                    const s = r.neighbor_school ?? r.school ?? '';
                    if (id) updates.push({ block: String(id), school: s });
                } catch (e) {}
            });
            if (updates.length > 0) {
                await updateStateMapBatch(conn, updates);
            }

            prevRemaining = remaining;
            remainingRows = await runQuery(conn, "select count(*) as cnt from __feats where school is null or school = '';");
            remaining = Number(remainingRows[0].cnt || 0);
        }

        if (statusEl) statusEl.textContent = `Finalizing assignments (${iter} iterations). Unassigned remaining: ${remaining}`;

        // Pull back assignments and apply to state.geojsonData
    const rows = await runQuery(conn, "select id, school from __feats;");
        const assignMap = new Map();
        rows.forEach(r => assignMap.set(String(r.id), r.school));

        let changed = 0;
        state.geojsonData.features.forEach((f, idx) => {
            const id = getBlockId(f, idx);
            const newSchool = assignMap.has(id) ? assignMap.get(id) : (f.properties && f.properties.school ? f.properties.school : '');
            const old = f.properties ? f.properties.school : undefined;
            if (!f.properties) f.properties = {};
            // Ensure block_of_residence is present so other modules can find the feature by id
            if (!f.properties.block_of_residence) f.properties.block_of_residence = id;
            if (newSchool !== old) {
                f.properties.school = newSchool;
                changed++;
            }
        });

        // Refresh styles and stats on the map
        const paint = await import('./paint.js');
        const stats = await import('./stats.js');
        paint.refreshStyles();
        if (stats && typeof stats.calculateStatistics === 'function') stats.calculateStatistics();

        // Update DuckDB stateMap for the changed features so statistics reflect edits
        if (changed > 0) {
            try {
                const conn2 = await getConnection();
                const rowsToUpdate = [];
                state.geojsonData.features.forEach((f, idx) => {
                    try {
                        const id = getBlockId(f, idx);
                        const s = (f.properties && f.properties.school) ? f.properties.school : '';
                        rowsToUpdate.push({ block: id, school: s });
                    } catch (e) { /* ignore individual failures */ }
                });
                if (rowsToUpdate.length > 0) await updateStateMapBatch(conn2, rowsToUpdate);
            } catch (err) {
                console.warn('Failed to update stateMap after paintByLayer:', err);
            }
        }

        

        if (statusEl) statusEl.textContent = `Assigned ${features.length - remaining} features; ${remaining} remain unassigned.`;
        return { assigned: features.length - remaining, remaining };
    } catch (err) {
        // Do not close the shared connection here; let duckdb.js manage lifecycle.
        throw err;
    }
}

// Paint blocks by selected overlay layers: load selected overlay layers into DuckDB,
// combine Name/School columns, aggregate per layer name, then assign any block
// feature whose geometry is contained in a layer geometry.
export async function paintByLayer(statusEl) {
    if (!state.geojsonData || !Array.isArray(state.geojsonData.features)) {
        throw new Error('No geojson loaded');
    }
    if (!state.map || !state.map.customLayers || !state.map.customLayers.overlays) {
        throw new Error('No overlay layers available');
    }

    await initDuckDB();
    const conn = await getConnection();
    try {
    await runQuery(conn, 'load spatial;');
    // raw layers table: layer_name (varchar), geom (geometry)
    await runQuery(conn, 'create or replace table __layers_raw(layer_name varchar, geom geometry);');

        const overlays = state.map.customLayers.overlays || {};
        const selected = [];
        for (const [displayName, layer] of Object.entries(overlays)) {
            try {
                if (state.map.hasLayer(layer)) selected.push({ displayName, layer });
            } catch (e) {
                // defensive: if hasLayer fails, skip
            }
        }
        if (selected.length === 0) throw new Error('No overlay layers are selected (visible)');

        // Insert overlay features into __layers_raw in batches
        let totalInserted = 0;
        const batchSize = 200;
        for (const sel of selected) {
            const fc = sel.layer.toGeoJSON ? sel.layer.toGeoJSON() : (sel.layer.feature && sel.layer.feature.type === 'FeatureCollection' ? sel.layer.feature : null);
            const features = (fc && fc.features) ? fc.features : [];
            for (let i = 0; i < features.length; i += batchSize) {
                // Build rows but skip features that are not polygonal (Point/LineString) to
                // avoid st_intersection producing invalid geometries when inputs are lines.
                const rows = [];
                for (const f of features.slice(i, i + batchSize)) {
                    if (!f || !f.geometry) continue;
                    const geom = f.geometry;
                    // Accept Polygon / MultiPolygon
                    let geomToInsert = null;
                    if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
                        geomToInsert = geom;
                    } else if (geom.type === 'GeometryCollection' && Array.isArray(geom.geometries)) {
                        // Keep only polygonal parts from a GeometryCollection
                        const polyGeoms = geom.geometries.filter(g => g && (g.type === 'Polygon' || g.type === 'MultiPolygon'));
                        if (polyGeoms.length === 1) geomToInsert = polyGeoms[0];
                        else if (polyGeoms.length > 1) geomToInsert = { type: 'GeometryCollection', geometries: polyGeoms };
                    }
                    if (!geomToInsert) continue; // skip non-area feature

                    const props = f.properties || {};
                    const name = (props.School || props.Name || props.school || props.name || '') || sel.displayName;
                    const nm = String(name).replace(/'/g, "''");
                    const geojson = JSON.stringify(geomToInsert).replace(/'/g, "''");
                    rows.push(`( '${nm}', ST_GeomFromGeoJSON('${geojson}') )`);
                }
                    if (rows.length > 0) {
                    const q = `insert into __layers_raw values ${rows.join(',')};`;
                    await runQuery(conn, q);
                    totalInserted += rows.length;
                    if (statusEl) statusEl.textContent = `Loaded ${totalInserted} overlay features into DuckDB...`;
                }
            }
        }
        if (totalInserted === 0) throw new Error('Selected overlay layers contained no features');

        // Aggregate layer geometries by name (union features with the same name)
        await runQuery(conn, `
            create or replace table __layers as 
            select 
                layer_name, 
                st_union_agg(ST_MakeValid(geom)) as geom 
            from __layers_raw group by layer_name;
        `);

        // Build overlay partition pieces (__parts) by computing intersections of
        // layer geometries. Each part will be named by the union of contributing
        // layer names (e.g. "A + B" for overlap of A and B). We compute
        // intersections for all non-empty subsets of layer names, processing
        // larger subsets first and subtracting already-covered area so pieces
        // are disjoint.
    await runQuery(conn, 'create or replace table __parts(part_name varchar, geom geometry);');

    // Pull individual layer feature names (per-feature names) so we can add each
    // feature name to the school list rather than only the aggregated layer name.
    const featureNameRows = await runQuery(conn, "select distinct layer_name from __layers_raw where layer_name is not null and layer_name <> '';");
    const layerList = featureNameRows;
    const layerNames = layerList.map(r => String(r.layer_name).trim()).filter(n => n);

        // Helper: generate all non-empty subsets
        function allSubsets(arr) {
            const out = [];
            const n = arr.length;
            for (let mask = 1; mask < (1 << n); mask++) {

                const s = [];
                for (let i = 0; i < n; i++) if (mask & (1 << i)) s.push(arr[i]);
                out.push(s);
            }
            return out;
        }

        if (layerNames.length === 0) throw new Error('No layer geometries found');

        // (school name registration deferred until after __parts is created)
        // single layer -> parts = layers
        await runQuery(conn, `
            insert into __parts 
            select 
                layer_name as part_name, 
                ST_MakeValid(geom) as geom 
            from __layers;` 
        );

        // Consolidate names from per-feature layer entries and generated parts,
        // then register them once using the centralized helper.
        try {
            const namesRes = await Promise.all([
                runQuery(conn, "select distinct layer_name as name from __layers_raw where layer_name is not null and layer_name <> '';" ) ,
                runQuery(conn, "select distinct part_name as name from __parts where part_name is not null and part_name <> '';")
            ]);
            const nameRows = namesRes.flatMap(r => r || []);
            const names = nameRows.map(rr => String(rr.name || rr.layer_name || rr.part_name || '').trim()).filter(n => n);
            if (names.length > 0) {
                const helpers = await import('./importHelpers.js');
                await helpers.registerSchoolNames(names);
            }
        } catch (e) {
            console.warn('Failed to collect/register combined layer/part names:', e);
        }

        // Ensure the __feats view exists so we can intersect block geometries with overlay parts
        try {
            await ensureFeatsView(state.currentTable);
        } catch (e) {
            console.warn('Failed to ensure __feats view; ensure state.currentTable is set and data table attached', e);
            throw e;
        }

        // For features that overlap the overlay parts, compute intersection area and
        // pick the part with the largest overlapping area.
        // Build matches table with overlap area and a rank (rn = 1 is top overlap)
        await runQuery(conn, `
            create or replace table __matches as
            select id, part_name, rn from (
                select 
                    id, 
                    part_name, 
                    overlap,
                    row_number() over(partition by id order by overlap desc) as rn
                from (
                    select 
                        f.id as id, 
                        p.part_name as part_name,
                        st_area(st_intersection(f.geom, ST_Buffer(p.geom, 0.0001))) as overlap
                    from __feats f
                    join __parts p on st_intersects(p.geom, f.geom)
                )
            );
        `);

        // Instead of updating the view, read the top matches and write them to stateMap
        const topMatches = await runQuery(conn, "select id, part_name from __matches where rn = 1;");
        const updates = [];
        topMatches.forEach(r => {
            try { if (r && (r.id || r.ID)) updates.push({ block: String(r.id || r.ID), school: r.part_name || r.PART_NAME || '' }); } catch (e) {}
        });
        if (updates.length > 0) {
            await updateStateMapBatch(conn, updates);
        }

        // Pull back assignments from the canonical view
    const rows = await runQuery(conn, 'select id, school from __feats;');
        const assignMap = new Map();
        rows.forEach(r => assignMap.set(String(r.id), r.school));

        let changed = 0;
        state.geojsonData.features.forEach((f, idx) => {
            const id = getBlockId(f, idx);
            const newSchool = assignMap.has(id) ? assignMap.get(id) : (f.properties && f.properties.school ? f.properties.school : '');
            const old = f.properties ? f.properties.school : undefined;
            if (!f.properties) f.properties = {};
            if (!f.properties.block_of_residence) f.properties.block_of_residence = id;
            if (newSchool !== old) {
                f.properties.school = newSchool;
                changed++;
            }
        });

        const paint = await import('./paint.js');
        const stats = await import('./stats.js');
        paint.refreshStyles();
        if (stats && typeof stats.calculateStatistics === 'function') stats.calculateStatistics();

        // Persist assignments into DuckDB stateMap so subsequent stats queries
        // reflect this paint-by-layer operation immediately.
        if (changed > 0) {
            try {
                const conn2 = await getConnection();
                const rowsToUpdate = [];
                state.geojsonData.features.forEach((f, idx) => {
                    try {
                        const id = getBlockId(f, idx);
                        const s = (f.properties && f.properties.school) ? f.properties.school : '';
                        rowsToUpdate.push({ block: id, school: s });
                    } catch (e) { /* ignore */ }
                });
                if (rowsToUpdate.length > 0) await updateStateMapBatch(conn2, rowsToUpdate);
            } catch (err) {
                console.warn('Failed to update stateMap after paintByLayer:', err);
            }
        }

        if (statusEl) statusEl.textContent = `Painted ${changed} features from overlays (${selected.length} layers used).`;
        return { changed, layersUsed: selected.length };
    } catch (err) {
        throw err;
    }
}

export async function mergeBySchool(statusEl) {
    if (!state.geojsonData || !Array.isArray(state.geojsonData.features)) {
        throw new Error('No geojson loaded');
    }

    // Merge boundaries by school using DuckDB spatial functions.
    // Behavior:
    // - Uses DuckDB to union geometries per-school and SUM numeric columns
    //   students, residents and fte (prefers `fte` then `fte_capacity`).
    // - Preserves existing in-memory school metadata (color, latitude,
    //   longitude, capacity, fte) by embedding it into the returned
    //   FeatureCollection at properties.schools. This allows the
    //   finalizeGeojsonImport flow (which calls registerSchoolNames and
    //   merges provided metadata) to restore colors/locations after
    //   flushSchools clears the current state.
    // If DuckDB fails, the function will throw and callers may fallback.
    try {
        // initialize or reuse shared DuckDB instance
        await initDuckDB();
        const conn = await getConnection();

        // Ensure the __feats view exists and aggregate directly from it. The view
        // joins the attached data.<table> geometries with stateMap so edits are
        // respected. Attempt to sum students/residents if present; otherwise
        // default to zero.
        await runQuery(conn, 'load spatial;');
        await ensureFeatsView(state.currentTable);

        // Capture existing in-memory school metadata so we can preserve
        // color, location and capacity when we flush state.schools below.
        const preservedSchoolMeta = {};
        try {
            if (state && state.schools && typeof state.schools.forEach === 'function') {
                state.schools.forEach((v, k) => {
                    try {
                        // shallow clone the metadata object (may contain color, latitude, longitude, capacity, fte, etc.)
                        preservedSchoolMeta[String(k)] = Object.assign({}, v || {});
                    } catch (e) {}
                });
            }
        } catch (e) { /* non-fatal */ }

        // Aggregate geometries and sum any numeric student/resident columns if present
        // Aggregate students, residents and FTEs per school. Some data tables
        // may not include all numeric columns (students, residents, fte, fte_capacity).
        // Query the information_schema to detect available columns and build a
        // safe SQL string that substitutes 0 for missing numeric columns so the
        // Binder won't error.
        const safeTable = String(state.currentTable || '').replace(/[^a-zA-Z0-9_]/g, '');
        if (!safeTable) throw new Error('No currentTable set for merge');

        // Discover columns on the attached data table
        let colRows = [];
        try {
            colRows = await runQuery(conn, `
                select column_name from information_schema.columns
                where table_schema = 'data' and table_name = '${safeTable}';
            `);
        } catch (e) {
            // If information_schema query fails, fall back to assuming minimal columns
            colRows = [];
        }
        const availableCols = (Array.isArray(colRows) ? colRows.map(r => String(r.column_name || r.COLUMN_NAME || '').toLowerCase()) : []);
        const hasStudents = availableCols.includes('students');
        const hasResidents = availableCols.includes('residents');
        const hasFte = availableCols.includes('fte');
        const hasFteCap = availableCols.includes('fte_capacity');

        const studentsExpr = hasStudents ? 'd.students as students' : '0 as students';
        const residentsExpr = hasResidents ? 'd.residents as residents' : '0 as residents';
        let fteExpr = '0 as fte';
        if (hasFte) fteExpr = 'd.fte as fte';
        else if (hasFteCap) fteExpr = 'd.fte_capacity as fte';

        const aggSql = `
            select
                school,
                st_asgeojson(st_union_agg(geom)) as geojson,
                sum(coalesce(students,0)) as students,
                sum(coalesce(residents,0)) as residents,
                sum(coalesce(fte,0)) as fte
            from (
                select
                    COALESCE(sm.school, '') as school,
                    d.geom as geom,
                    ${studentsExpr},
                    ${residentsExpr},
                    ${fteExpr}
                from data.${safeTable} d
                left join stateMap sm on sm.block_of_residence = d.block_of_residence
            ) t
            group by school;
        `;

        const rows = await runQuery(conn, aggSql);

        // Filter out any aggregated rows with empty/blank school names so we
        // don't create a merged feature for an unnamed school (which would not
        // be registered as an active school by finalizeGeojsonImport).
        const filteredRows = (Array.isArray(rows) ? rows.filter(r => {
            try { const s = r.school ?? r.SCHOOL ?? ''; return String(s).trim() !== ''; } catch (e) { return false; }
        }) : []);

        // If aggregation produced no named school groups, abort the merge to
        // avoid clearing the existing schools list (flushSchools would clear
        // state.schools and leave the UI with no active schools).
        if (!filteredRows || filteredRows.length === 0) {
            console.warn('mergeBySchool: aggregation returned no named school groups', { rows });
            throw new Error('No named schools found after aggregation; merge aborted.');
        }

        // Build new feature collection, include summed students/residents
        const outFeatures = filteredRows.map(r => {
            const geom = JSON.parse(r.geojson);
            return {
                type: 'Feature',
                geometry: geom,
                properties: {
                    school: r.school,
                    students: Number(r.students || 0),
                    residents: Number(r.residents || 0),
                    fte: Number(r.fte || 0)
                }
            };
        });

        const outGeojson = { type: 'FeatureCollection', features: outFeatures, properties: {} };

        // Embed preserved school metadata into top-level properties.schools so
        // finalizeGeojsonImport can merge color/lat/lon/capacity back into the
        // in-memory `state.schools` after we call flushSchools (which clears it).
        try {
            outGeojson.properties = outGeojson.properties || {};
            outGeojson.properties.schools = outGeojson.properties.schools || {};
            filteredRows.forEach(r => {
                try {
                    const name = String(r.school || '');
                    if (!name) return;
                    if (preservedSchoolMeta[name]) {
                        // Provide a copy so downstream mutation won't affect our cache
                        outGeojson.properties.schools[name] = Object.assign({}, preservedSchoolMeta[name]);
                    }
                } catch (e) {}
            });
        } catch (e) { /* non-fatal */ }

        // Before replacing the map, capture the current stateMap (block -> school)
        // so we can restore per-block assignments after loading the merged
        // GeoJSON. If we don't restore stateMap, loadGeoJSON's replaceStateMap
        // call will clear assignments because merged features are per-school
        // polygons and lack per-block block_of_residence properties.
        let savedStateMap = [];
        try {
            const smRows = await runQuery(conn, `select block_of_residence as block, school from stateMap;`);
            if (Array.isArray(smRows)) savedStateMap = smRows.map(r => ({ block: String(r.block), school: (r.school || '') }));
        } catch (e) {
            console.warn('mergeBySchool: failed to read existing stateMap prior to flush', e);
            savedStateMap = [];
        }

        // Replace map via existing paint helpers
        // lazy import paint helpers used elsewhere
        const helpers = await import('./importHelpers.js');
        // flush current schools so merged map becomes authoritative
        await helpers.flushSchools({ reloadDefaults: false });
        const paint = await import('./paint.js');
        // loadGeoJSON will also set state.geojsonData and add layers
        await paint.loadGeoJSON(outGeojson);
        await helpers.finalizeGeojsonImport(outGeojson);

        // Restore the saved stateMap so per-block assignments are preserved
        // for statistics queries. Use updateStateMapBatch helper to upsert rows.
        try {
            if (savedStateMap && savedStateMap.length > 0) {
                const conn2 = await getConnection();
                // transform into expected {block, school} shape for updateStateMapBatch
                const rowsToUpdate = savedStateMap.map(r => ({ block: r.block, school: r.school }));
                await updateStateMapBatch(conn2, rowsToUpdate);
            }
        } catch (e) {
            console.warn('mergeBySchool: failed to restore stateMap after merge', e);
        }

        return outGeojson;
    } catch (err) {
        console.warn('DuckDB merge failed, moving on.', err);
        throw err;
    }
}
