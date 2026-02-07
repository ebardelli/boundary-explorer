import { state, updateStateMapBatch } from './state.js';
import { getConnection, runQuery } from './duckdb.js';
import { translate } from './i18n.js';
import { style } from './paint.js';

function createEditButtonAndModal() {
    // snapshot of active schools when the modal is opened. This is used so
    // that saving edits does not add markers for schools that were not
    // active when the editor was opened. It will still honor removals and
    // preserve active schools through renames.
    let initialActiveAtOpen = new Set();
    if (document.getElementById('edit-schools-button')) return;

    const btn = document.createElement('button');
    btn.id = 'edit-schools-button';
    btn.textContent = translate('editSchools') || 'Edit Schools';
    // use shared styling for tool buttons; this appears in the mapping tools list
    btn.classList.add('tool-list-button');

    btn.addEventListener('click', openModal);

    // Prefer to register Edit Schools button with Mapping Tools so it
    // appears together with other tool buttons. If a registration API is
    // available use it; otherwise fall back to the previous insertion logic.
    try {
        const reg = (typeof window !== 'undefined' && window.registerMappingToolButton) ? window.registerMappingToolButton : (typeof registerToolButton !== 'undefined' ? registerToolButton : null);
        if (reg && typeof reg === 'function') {
            reg(btn, 'import-btn');
        } else {
            const mappingControls = document.getElementById('map-editor-controls');
            const importBtn = document.getElementById('import-btn');
            if (mappingControls) {
                if (importBtn && importBtn.parentElement) {
                    importBtn.parentElement.insertBefore(btn, importBtn.nextSibling);
                } else {
                    mappingControls.appendChild(btn);
                }
            } else {
                const schoolListEl = document.getElementById('school-list');
                if (schoolListEl) schoolListEl.appendChild(btn);
                else document.body.appendChild(btn);
            }
        }
    } catch (e) {
        // on any failure, fall back to safe insertion
        const schoolListEl = document.getElementById('school-list');
        if (schoolListEl) schoolListEl.appendChild(btn);
        else document.body.appendChild(btn);
    }

    // update label when language changes
    if (typeof window !== 'undefined') {
        window.addEventListener('languagechange', () => {
            const eb = document.getElementById('edit-schools-button');
            if (eb) eb.textContent = translate('editSchools') || eb.textContent;
            // update tab label and modal close text if modal exists
            const tabBtn = document.querySelector('.stats-tab-button');
            if (tabBtn) tabBtn.textContent = translate('editSchools') || tabBtn.textContent;
            const closeBtn = document.querySelector('#edit-schools-modal .modal-close-button');
            if (closeBtn) closeBtn.textContent = translate('close') || closeBtn.textContent;
        });
    }

    // build modal container
    const overlay = document.createElement('div');
    overlay.id = 'edit-schools-modal';
    overlay.style.position = 'fixed';
    overlay.style.left = '0';
    overlay.style.top = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.background = 'rgba(0,0,0,0.4)';
    overlay.style.display = 'none';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.zIndex = 10002;

    const modalBox = document.createElement('div');
    modalBox.style.width = '820px';
    modalBox.style.maxWidth = '96%';
    modalBox.style.maxHeight = '86%';
    modalBox.style.overflow = 'auto';
    modalBox.style.background = 'white';
    modalBox.style.borderRadius = '8px';
    modalBox.style.padding = '18px';
    modalBox.style.boxShadow = '0 6px 20px rgba(0,0,0,0.3)';
    modalBox.style.position = 'relative';
    // create tab UI wrapper (reuse stats styles for consistency)
    const styleEl = document.createElement('style');
    styleEl.textContent = `
    .stats-tab-list { display:flex; gap:8px; align-items:flex-end; margin-bottom:8px; border-bottom:1px solid #e6e6e6; }
    .stats-tab-button { background:#f3f3f3; border:1px solid #ddd; padding:6px 12px; border-radius:6px 6px 0 0; cursor:pointer; color:#333; font-weight:600; position:relative; box-shadow:0 2px 6px rgba(0,0,0,0.04); margin-bottom:-1px; }
    .stats-tab-button.active { background:white; border-bottom-color: white; margin-bottom:-1px; box-shadow:0 8px 24px rgba(0,0,0,0.08); z-index:2; }
    .stats-tab-button:focus { outline:2px solid rgba(0,120,215,0.25); }
    .stats-tab-content { padding-top:8px; }
    .modal-close-button { position:absolute; top:12px; right:12px; background:#f5f5f5; border:1px solid #ccc; border-radius:6px; padding:6px 10px; cursor:pointer; }
    .modal-close-button:hover { background:#eee; }
    `;
    modalBox.appendChild(styleEl);

    const closeBtn = document.createElement('button');
    closeBtn.textContent = translate('close') || 'Close';
    closeBtn.className = 'modal-close-button';
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', () => closeModal());

    // Tabs wrapper
    const tabsWrapper = document.createElement('div');
    tabsWrapper.className = 'stats-tabs-wrapper';

    const tabList = document.createElement('div');
    tabList.className = 'stats-tab-list';
    tabList.style.display = 'flex';
    tabList.style.gap = '8px';

    const editorTabBtn = document.createElement('button');
    editorTabBtn.className = 'stats-tab-button active';
    editorTabBtn.type = 'button';
    editorTabBtn.textContent = translate('editSchools') || 'Edit Schools';
    editorTabBtn.style.padding = '6px 10px';
    tabList.appendChild(editorTabBtn);

    const infoTabBtn = document.createElement('button');
    infoTabBtn.className = 'stats-tab-button';
    infoTabBtn.type = 'button';
    infoTabBtn.textContent = translate('info') || 'Info';
    infoTabBtn.style.padding = '6px 10px';
    tabList.appendChild(infoTabBtn);

    const tabContent = document.createElement('div');
    tabContent.className = 'stats-tab-content';

    // School Editor panel (we'll append existing controls into this panel)
    const editorPanel = document.createElement('div');
    editorPanel.className = 'stats-tab-panel';
    editorPanel.id = 'tab-school-editor';
    editorPanel.style.display = 'block';

    // append header controls into the editor panel (no title; tab shows the label)
    editorPanel.appendChild(closeBtn);

    const addRowBtn = document.createElement('button');
    addRowBtn.textContent = translate('addRow') || 'Add Row';
    addRowBtn.className = 'tool-inline';
    addRowBtn.style.marginLeft = '8px';
    addRowBtn.addEventListener('click', () => addEmptyRow());
    editorPanel.appendChild(addRowBtn);

    const loadDefaultsBtn = document.createElement('button');
    loadDefaultsBtn.textContent = translate('loadDefaults') || 'Load Defaults';
    loadDefaultsBtn.className = 'tool-inline';
    loadDefaultsBtn.style.marginLeft = '8px';
    loadDefaultsBtn.addEventListener('click', () => loadDefaultsFromData());
    editorPanel.appendChild(loadDefaultsBtn);

    // Export / Import buttons
    const exportBtn = document.createElement('button');
    exportBtn.textContent = translate('exportSchools') || 'Export Schools';
    exportBtn.className = 'tool-inline';
    exportBtn.style.marginLeft = '8px';
    exportBtn.id = 'export-schools-btn';
    exportBtn.addEventListener('click', () => exportSchools());
    editorPanel.appendChild(exportBtn);

    const importBtn = document.createElement('button');
    importBtn.textContent = translate('importSchools') || 'Import Schools';
    importBtn.className = 'tool-inline';
    importBtn.style.marginLeft = '8px';
    importBtn.id = 'import-schools-btn';
    importBtn.addEventListener('click', () => triggerImport());
    editorPanel.appendChild(importBtn);

    const table = document.createElement('table');
    table.id = 'edit-schools-table';
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';
    table.style.marginTop = '12px';

    const thead = document.createElement('thead');
    thead.innerHTML = `<tr>
        <th style="text-align:left;border-bottom:1px solid #ddd;padding:8px">${translate('name') || 'Name'}</th>
        <th style="text-align:center;border-bottom:1px solid #ddd;padding:8px">${translate('active') || 'Active'}</th>
        <th style="text-align:left;border-bottom:1px solid #ddd;padding:8px">${translate('latitude') || 'Latitude'}</th>
        <th style="text-align:left;border-bottom:1px solid #ddd;padding:8px">${translate('longitude') || 'Longitude'}</th>
        <th style="text-align:left;border-bottom:1px solid #ddd;padding:8px">${translate('color') || 'Color'}</th>
        <th style="text-align:right;border-bottom:1px solid #ddd;padding:8px">${translate('fte') || 'FTE'}</th>
        <th style="text-align:right;border-bottom:1px solid #ddd;padding:8px">${translate('capacityLabel') || 'Capacity'}</th>
        <th style="text-align:center;border-bottom:1px solid #ddd;padding:8px">${translate('actions') || 'Actions'}</th>
    </tr>`;
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    tbody.id = 'edit-schools-tbody';
    table.appendChild(tbody);
    editorPanel.appendChild(table);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'tool-list-button';
    saveBtn.textContent = translate('saveChanges') || 'Save Changes';
    saveBtn.style.marginTop = '12px';
    saveBtn.style.background = '#2f855a';
    saveBtn.style.color = 'white';
    saveBtn.style.border = 'none';
    saveBtn.style.padding = '8px 12px';
    saveBtn.style.borderRadius = '4px';
    saveBtn.addEventListener('click', () => saveChanges());
    editorPanel.appendChild(saveBtn);

    tabContent.appendChild(editorPanel);

    // Info panel: shows lightweight runtime information about the map and DB
    const infoPanel = document.createElement('div');
    infoPanel.className = 'stats-tab-panel';
    infoPanel.id = 'tab-info';
    infoPanel.style.display = 'none';
    infoPanel.style.minHeight = '120px';

    const infoInner = document.createElement('div');
    infoInner.style.padding = '8px 0';
    infoInner.innerHTML = `
        <div style="display:flex;gap:12px;flex-direction:column">
            <div><strong>${translate('featuresLabel') || 'Features'}:</strong> <span id="editor-info-features">—</span></div>
            <div><strong>${translate('layersLabel') || 'Layers on map'}:</strong> <span id="editor-info-layers">—</span></div>
            <div><strong>${translate('markersLabel') || 'Markers'}:</strong> <span id="editor-info-markers">—</span></div>
            <div><strong>${translate('duckdbVersionLabel') || 'DuckDB version'}:</strong> <span id="editor-info-duckdb">—</span></div>
            <div style="margin-top:8px"><button id="editor-info-refresh">${translate('refresh') || 'Refresh'}</button></div>
        </div>`;
    infoPanel.appendChild(infoInner);
    tabContent.appendChild(infoPanel);
    tabsWrapper.appendChild(tabList);
    tabsWrapper.appendChild(tabContent);
    modalBox.appendChild(tabsWrapper);

    overlay.appendChild(modalBox);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
    document.body.appendChild(overlay);

    // Tab switching behavior
    tabList.querySelectorAll('.stats-tab-button').forEach(btn => {
        btn.addEventListener('click', async () => {
            tabList.querySelectorAll('.stats-tab-button').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            tabContent.querySelectorAll('.stats-tab-panel').forEach(p => p.style.display = 'none');
            if (btn === editorTabBtn) {
                editorPanel.style.display = 'block';
            } else if (btn === infoTabBtn) {
                infoPanel.style.display = 'block';
                try { await updateInfoPanel(); } catch (e) { /* ignore */ }
            } else {
                // fallback
                editorPanel.style.display = 'block';
            }
        });
    });

    // wire refresh button
    (function wireInfoRefresh() {
        const onClick = async () => { try { await updateInfoPanel(); } catch (e) { console.warn('updateInfoPanel failed', e); } };
        // delegate in case panel is created later
        document.addEventListener('click', (ev) => {
            const t = ev.target;
            if (t && t.id === 'editor-info-refresh') onClick();
        });
    })();

    async function updateInfoPanel() {
        // Features count
        try {
            const featEl = document.getElementById('editor-info-features');
            const layerEl = document.getElementById('editor-info-layers');
            const markerEl = document.getElementById('editor-info-markers');
            const dbEl = document.getElementById('editor-info-duckdb');

            // features: prefer in-memory geojsonData, then geojsonLayer
            let featuresCount = null;
            if (state.geojsonData && Array.isArray(state.geojsonData.features)) {
                featuresCount = state.geojsonData.features.length;
            } else if (state.geojsonLayer && typeof state.geojsonLayer.eachLayer === 'function') {
                let c = 0;
                try { state.geojsonLayer.eachLayer(() => { c++; }); } catch (e) { c = null; }
                featuresCount = c;
            }
            if (featEl) featEl.textContent = (featuresCount == null) ? '—' : String(featuresCount);

            // layers: try to count map layers if Leaflet map is available
            let layerCount = null;
            if (state.map && typeof state.map.eachLayer === 'function') {
                let c = 0;
                try { state.map.eachLayer(() => { c++; }); } catch (e) { c = null; }
                layerCount = c;
            }
            // fallback: markers + geojsonLayer presence
            if (layerCount == null) {
                let fallback = 0;
                try { fallback += (state.markers && typeof state.markers.size === 'number') ? state.markers.size : 0; } catch (e) {}
                if (state.geojsonLayer) fallback += 1;
                layerCount = fallback;
            }
            if (layerEl) layerEl.textContent = (layerCount == null) ? '—' : String(layerCount);

            // markers
            let markerCount = (state.markers && typeof state.markers.size === 'number') ? state.markers.size : '—';
            if (markerEl) markerEl.textContent = String(markerCount);

            // DuckDB version
            if (dbEl) dbEl.textContent = (translate('loading') || 'loading...');
            try {
                const conn = await getConnection();
                const rows = await runQuery(conn, "select version() as version;");
                const versionStr = (Array.isArray(rows) && rows[0]) ? (rows[0].version ?? rows[0]['version()'] ?? String(rows[0])) : null;
                if (dbEl) dbEl.textContent = versionStr || 'unknown';
            } catch (e) {
                if (dbEl) dbEl.textContent = (translate('unavailable') || 'unavailable');
            }
        } catch (e) {
            console.warn('updateInfoPanel error', e);
        }
    }

    function addEmptyRow() {
        const tBodyEl = document.getElementById('edit-schools-tbody');
        if (!tBodyEl) return null;
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td style="padding:8px;border-bottom:1px solid #f0f0f0"><input type="text" class="school-name" style="width:100%"/></td>
            <td style="padding:8px;border-bottom:1px solid #f0f0f0;text-align:center"><input type="checkbox" class="school-active"/></td>
            <td style="padding:8px;border-bottom:1px solid #f0f0f0"><input type="number" step="any" class="school-lat" style="width:100%"/></td>
            <td style="padding:8px;border-bottom:1px solid #f0f0f0"><input type="number" step="any" class="school-lon" style="width:100%"/></td>
            <td style="padding:8px;border-bottom:1px solid #f0f0f0"><input type="color" class="school-color"/></td>
            <td style="padding:8px;border-bottom:1px solid #f0f0f0"><input type="number" step="any" class="school-fte" style="width:100%" min="0"/></td>
            <td style="padding:8px;border-bottom:1px solid #f0f0f0"><input type="number" class="school-capacity" style="width:100%" min="0"/></td>
            <td style="padding:8px;border-bottom:1px solid #f0f0f0;text-align:center"><button class="tool-inline delete-row">Delete</button></td>
        `;
        tBodyEl.appendChild(tr);
        tr.querySelector('.delete-row').addEventListener('click', () => tr.remove());
        return tr;
    }

    function populateTable() {
        const tBodyEl = document.getElementById('edit-schools-tbody');
        if (!tBodyEl) return;
        tBodyEl.innerHTML = '';
        // Include all known schools in the editor list (not only active ones)
        // so users can edit / add metadata even when a school isn't currently active on the map.
    // include both known schools and any currently-active schools so the
    // editor shows active entries even if metadata is missing from
    // state.schools (some flows add active names without full metadata)
    const known = (state.schools && typeof state.schools.forEach === 'function') ? Array.from(state.schools.keys()) : [];
    const active = (state.activeSchools && typeof state.activeSchools.forEach === 'function') ? Array.from(state.activeSchools) : [];
    const schoolNames = Array.from(new Set([...known, ...active]));
        if (schoolNames.length === 0) {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td colspan="8" style="padding:8px;font-style:italic">No schools defined</td>`;
            tBodyEl.appendChild(tr);
            return;
        }

        // sort names for stable ordering
        schoolNames.sort((a,b) => a.localeCompare(b));
        schoolNames.forEach(k => {
            const v = state.schools.get(k) || {};
            // allow entries that lack metadata (we'll show defaults)
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td style="padding:8px;border-bottom:1px solid #f0f0f0"><input type="text" class="school-name" style="width:100%" value="${escapeHtml(k)}"/></td>
                <td style="padding:8px;border-bottom:1px solid #f0f0f0;text-align:center"><input type="checkbox" class="school-active" ${ (state.activeSchools && state.activeSchools.has(k)) ? 'checked' : '' }/></td>
                <td style="padding:8px;border-bottom:1px solid #f0f0f0"><input type="number" step="any" class="school-lat" style="width:100%" value="${v.latitude ?? ''}"/></td>
                <td style="padding:8px;border-bottom:1px solid #f0f0f0"><input type="number" step="any" class="school-lon" style="width:100%" value="${v.longitude ?? ''}"/></td>
                <td style="padding:8px;border-bottom:1px solid #f0f0f0"><input type="color" class="school-color" value="${toColorInput(v.color || '')}"/></td>
                <td style="padding:8px;border-bottom:1px solid #f0f0f0"><input type="number" step="any" class="school-fte" style="width:100%" min="0" value="${v.fte ?? 0}"/></td>
                <td style="padding:8px;border-bottom:1px solid #f0f0f0"><input type="number" class="school-capacity" style="width:100%" min="0" value="${v.capacity ?? 0}"/></td>
                <td style="padding:8px;border-bottom:1px solid #f0f0f0;text-align:center"><button class="tool-inline delete-row">Delete</button></td>
            `;
            tr.dataset.originalName = k;
            tBodyEl.appendChild(tr);
            tr.querySelector('.delete-row').addEventListener('click', () => tr.remove());
        });
    }

    function toColorInput(color) {
        if (!color) return '#808080';
        // ensure hex format #rrggbb
        if (color.startsWith('#') && (color.length === 7 || color.length === 4)) return expandHex(color);
        return color;
    }

    function expandHex(short) {
        if (short.length === 4) return '#' + short[1]+short[1]+short[2]+short[2]+short[3]+short[3];
        return short;
    }

    // Return a random hex color in the form #rrggbb
    function getRandomColor() {
        const rand = () => Math.floor(Math.random() * 256);
        const toHex = (n) => n.toString(16).padStart(2, '0');
        return `#${toHex(rand())}${toHex(rand())}${toHex(rand())}`;
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; });
    }

    async function saveChanges() {
        // read each row and build new map
        const newMap = new Map();
        const tBodyEl = document.getElementById('edit-schools-tbody');
        const rows = tBodyEl ? Array.from(tBodyEl.querySelectorAll('tr')) : [];
        for (const tr of rows) {
            const name = tr.querySelector('.school-name').value.trim();
            if (!name) continue; // skip empty rows
            const latRaw = tr.querySelector('.school-lat').value;
            const lonRaw = tr.querySelector('.school-lon').value;
            const lat = latRaw === '' ? null : Number(latRaw);
            const lon = lonRaw === '' ? null : Number(lonRaw);
            const color = tr.querySelector('.school-color').value || '#808080';
            const fte = Number(tr.querySelector('.school-fte').value) || 0;
            const capacity = Number(tr.querySelector('.school-capacity').value) || 0;
            newMap.set(name, { color, latitude: lat, longitude: lon, fte, capacity });
        }

        // apply changes: handle renames and deletions
        const oldMap = new Map(state.schools);

        // remove markers for deleted schools (keep UI consistent immediately)
        for (const [oldName] of oldMap) {
            if (!newMap.has(oldName)) {
                if (state.markers.has(oldName)) {
                    try { state.map.removeLayer(state.markers.get(oldName)); } catch (e) { /* ignore */ }
                    state.markers.delete(oldName);
                }
                try { state.activeSchools.delete(oldName); } catch (e) { /* ignore */ }
                if (state.currentSchool === oldName) state.currentSchool = null;
            }
        }

        // Replace state.schools entirely with newMap
        state.schools.clear();
        newMap.forEach((v, k) => state.schools.set(k, v));

        // Build a nameMap of originalName -> currentName (used for renames)
        const nameMap = new Map();
        rows.forEach(tr => {
            const orig = tr.dataset.originalName;
            const current = tr.querySelector('.school-name').value.trim();
            if (orig && current && orig !== current) nameMap.set(orig, current);
        });

        // Compute the effective set of schools that should be active after save
        // based on the checkbox state in each row. This lets the user explicitly
        // choose which schools remain active. Checkboxes were pre-checked for
        // schools that were active when the modal opened.
        const effectiveActive = new Set();
        for (const tr of rows) {
            const name = tr.querySelector('.school-name').value.trim();
            if (!name) continue;
            const checkedEl = tr.querySelector('.school-active');
            const checked = !!(checkedEl && checkedEl.checked);
            if (checked && state.schools.has(name)) effectiveActive.add(name);
        }

        // Update state.activeSchools to the computed effective set
        if (state.activeSchools && typeof state.activeSchools.clear === 'function') {
            state.activeSchools.clear();
            for (const n of effectiveActive) state.activeSchools.add(n);
        } else {
            state.activeSchools = new Set(effectiveActive);
        }

        // If currentSchool was renamed, update it
        if (state.currentSchool && nameMap.has(state.currentSchool)) {
            state.currentSchool = nameMap.get(state.currentSchool);
        }

        // Rebuild markers: only recreate markers for schools that were active when
        // the modal was opened (and still exist). This avoids adding markers for
        // newly-created/non-active schools.
        try {
            state.markers.forEach((marker, name) => {
                try { state.map.removeLayer(marker); } catch (e) { /* ignore */ }
            });
        } catch (e) { /* ignore */ }
        state.markers.clear();

        // Rebuild markers using the shared createSchoolMarker helper to keep icon appearance consistent.
        try {
            const mod = await import('./schools.js');
            const createSchoolMarker = mod.createSchoolMarker;
            for (const name of effectiveActive) {
                const data = state.schools.get(name);
                if (!data) continue;
                if (data.latitude != null && data.longitude != null && typeof L !== 'undefined' && state.map) {
                    try {
                        const marker = createSchoolMarker ? createSchoolMarker(name, data) : null;
                        if (marker) { marker.addTo(state.map); state.markers.set(name, marker); }
                    } catch (e) {
                        // Fallback to simple marker
                            try {
                                const m = createSchoolMarker ? createSchoolMarker(name, data) : null;
                                if (m) { m.addTo(state.map); state.markers.set(name, m); }
                                else { const mm = L.marker([data.latitude, data.longitude]).bindPopup(name).addTo(state.map); state.markers.set(name, mm); }
                            } catch (ee) {}
                    }
                }
            }
        } catch (e) {
            // If import fails, fall back to simple markers
                for (const name of effectiveActive) {
                    const data = state.schools.get(name);
                    if (!data) continue;
                    if (data.latitude != null && data.longitude != null && typeof L !== 'undefined' && state.map) {
                        try {
                            // Try a dynamic import here as a last-ditch attempt to use the shared helper
                            let marker = null;
                            try { const mod = await import('./schools.js'); marker = mod.createSchoolMarker ? mod.createSchoolMarker(name, data) : null; } catch (ie) { marker = null; }
                            if (marker) { marker.addTo(state.map); state.markers.set(name, marker); }
                            else { const m = L.marker([data.latitude, data.longitude]).bindPopup(name).addTo(state.map); state.markers.set(name, m); }
                        } catch (ee) {}
                    }
                }
        }

        // Update assigned school names in geojson features: if schools were renamed we won't be able to map old->new automatically.
        // We'll attempt to preserve by matching original names where possible: if a row's dataset.originalName exists and differs
        // from the provided name, rename features.
        if (state.geojsonLayer) {
            // use the previously-built nameMap (originalName -> newName) to
            // update feature assignments when schools were renamed or removed.
            // Collect changes and apply in batch so DuckDB stateMap stays in sync
            const rowsToUpdate = [];
            state.geojsonLayer.eachLayer(layer => {
                const props = layer.feature.properties || {};
                const assigned = props.school;
                if (!assigned && !nameMap.has(assigned)) return;
                let newVal = assigned;
                if (assigned && nameMap.has(assigned)) {
                    newVal = nameMap.get(assigned);
                    layer.feature.properties.school = newVal;
                } else if (assigned && !state.schools.has(assigned)) {
                    // assigned school no longer exists -> clear assignment
                    newVal = '';
                    layer.feature.properties.school = null;
                }
                // update style
                try { layer.setStyle(style(layer.feature)); } catch (e) { /* ignore; paint.refreshStyles will handle */ }

                try {
                    const block = (layer.feature && layer.feature.properties && (layer.feature.properties.block_of_residence || layer.feature.properties.GEOID20 || layer.feature.properties.GEOID || layer.feature.properties.geoid)) || null;
                    if (block) rowsToUpdate.push({ block, school: newVal || '' });
                } catch (e) { /* ignore individual failures */ }
            });

            // persist to DuckDB if any changes
                if (rowsToUpdate.length > 0) {
                (async () => {
                    try {
                        const conn = await getConnection();
                        await updateStateMapBatch(conn, rowsToUpdate);
                    } catch (err) {
                        console.warn('Failed to update stateMap after schoolEditor changes:', err);
                    }
                })();
            }
        }

        // refresh UI and styles
    import('./schools.js').then(mod => mod.updateSchoolList());
        import('./paint.js').then(mod => mod.refreshStyles());
        import('./stats.js').then(mod => mod.calculateStatistics());

        // persist schools metadata to DuckDB temporary table
        (async () => {
            try {
                const mod = await import('./duckdb.js');
                const conn = await mod.getConnection();
                const { replaceStateSchools } = await import('./state.js');
                await replaceStateSchools(conn);
            } catch (err) {
                console.warn('Failed to persist stateSchool after editor save:', err);
            }
        })();

        closeModal();
    }

    async function loadDefaultsFromData() {
        // Merge database values from data.schools into state.schools.
        try {
            const conn = await getConnection();
            // Query relevant columns from data.schools
            let rows = [];
            try {
                rows = await runQuery(conn, `SELECT name, latitude, longitude, null as color, capacity, fte_capacity as fte FROM data.schools;`);
            } catch (e) {
                console.warn('loadDefaultsFromData: failed to read data.schools:', e);
                rows = [];
            }

            // Merge: prefer database values when present, otherwise keep existing in-memory values
            if (Array.isArray(rows) && rows.length > 0) {
                rows.forEach(r => {
                    if (!r || !r.name) return;
                    const name = String(r.name);
                    const existing = state.schools.get(name) || {};
                    // Only overwrite fields when DB provides a non-null value
                    if (r.latitude != null) existing.latitude = Number(r.latitude);
                    if (r.longitude != null) existing.longitude = Number(r.longitude);
                    if (r.color != null) {
                        existing.color = String(r.color);
                    } else {
                        // If DB returned null for color, prefer any existing in-memory color;
                        // otherwise assign a random color so the editor/color picker isn't empty.
                        if (!existing.color) existing.color = getRandomColor();
                    }
                    if (r.capacity != null) existing.capacity = (Number(r.capacity) || 0);
                    if (r.fte != null) existing.fte = (Number(r.fte) || 0);
                    state.schools.set(name, existing);
                });
            }

            // Persist to stateSchool temporary table so SQL consumers see the new values
            try {
                const { replaceStateSchools } = await import('./state.js');
                await replaceStateSchools(conn);
            } catch (err) {
                console.warn('Failed to persist stateSchool after loading defaults:', err);
            }

            // Refresh UI and styles
            import('./schools.js').then(mod => mod.updateSchoolList());
            import('./paint.js').then(mod => mod.refreshStyles());
            import('./stats.js').then(mod => mod.calculateStatistics());

            // Refresh the editor table view
            populateTable();
        } catch (err) {
            console.warn('loadDefaultsFromData failed:', err);
        }
    }

    // Export current in-memory schools to a JSON file
    function exportSchools() {
        try {
            const out = {
                exportedAt: (new Date()).toISOString(),
                schools: []
            };
            if (state && state.schools && typeof state.schools.forEach === 'function') {
                state.schools.forEach((v, k) => {
                    out.schools.push({
                        name: String(k),
                        latitude: (v && v.latitude != null) ? v.latitude : null,
                        longitude: (v && v.longitude != null) ? v.longitude : null,
                        color: (v && v.color != null) ? v.color : null,
                        fte: (v && v.fte != null) ? v.fte : (v && v.fte_capacity != null) ? v.fte_capacity : null,
                        capacity: (v && v.capacity != null) ? v.capacity : null
                    });
                });
            }
            // include active schools set
            out.active = Array.from((state && state.activeSchools) ? state.activeSchools : []);
            out.currentSchool = state && state.currentSchool ? state.currentSchool : null;

            const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const name = `schools-${(new Date()).toISOString().slice(0,10)}.json`;
            a.href = url;
            a.download = name;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
        } catch (e) {
            console.warn('exportSchools failed', e);
            alert(translate('exportFailed') || 'Export failed');
        }
    }

    // Trigger file input for import
    function triggerImport() {
        const inputId = 'import-schools-input';
        let input = document.getElementById(inputId);
        if (!input) {
            input = document.createElement('input');
            input.type = 'file';
            input.accept = 'application/json,application/*+json';
            input.id = inputId;
            input.style.display = 'none';
            input.addEventListener('change', async (ev) => {
                const file = ev.target.files && ev.target.files[0];
                if (!file) return;
                try {
                    const text = await file.text();
                    let parsed = null;
                    try { parsed = JSON.parse(text); } catch (e) { throw new Error('Invalid JSON'); }
                    await applyImportedSchools(parsed);
                } catch (err) {
                    console.warn('Import failed', err);
                    alert(translate('importFailed') || ('Import failed: ' + (err && err.message ? err.message : String(err))));
                } finally {
                    input.value = '';
                }
            });
            document.body.appendChild(input);
        }
        input.click();
    }

    // Apply parsed import payload to in-memory state and refresh UI
    async function applyImportedSchools(payload) {
        if (!payload) throw new Error('No data');
        let records = [];
        let active = [];
        let current = null;
        if (Array.isArray(payload)) {
            records = payload;
        } else if (payload.schools && Array.isArray(payload.schools)) {
            records = payload.schools;
            if (Array.isArray(payload.active)) active = payload.active;
            if (payload.currentSchool) current = payload.currentSchool;
        } else {
            throw new Error('Unrecognized format');
        }

        // validate records minimally
        const newMap = new Map();
        records.forEach(r => {
            if (!r || !r.name) return;
            const name = String(r.name);
            const latitude = (r.latitude != null) ? (Number.isFinite(Number(r.latitude)) ? Number(r.latitude) : null) : null;
            const longitude = (r.longitude != null) ? (Number.isFinite(Number(r.longitude)) ? Number(r.longitude) : null) : null;
            const color = r.color || r.color === null ? r.color : null;
            const fte = (r.fte != null) ? Number(r.fte) : (r.fte_capacity != null ? Number(r.fte_capacity) : null);
            const capacity = (r.capacity != null) ? Number(r.capacity) : null;
            newMap.set(name, { latitude, longitude, color, fte, capacity });
        });

        // Replace in-memory schools
        state.schools.clear();
        newMap.forEach((v, k) => state.schools.set(k, v));

        // Replace activeSchools
        state.activeSchools = new Set(Array.isArray(payload.active) ? payload.active : active);
        if (current != null) state.currentSchool = current;

        // Remove and rebuild markers for active schools
        try { state.markers.forEach((m, n) => { try { state.map.removeLayer(m); } catch (e) {} }); } catch (e) {}
        if (state.markers && typeof state.markers.clear === 'function') state.markers.clear();

        try {
            const mod = await import('./schools.js');
            const createSchoolMarker = mod.createSchoolMarker;
            for (const name of state.activeSchools) {
                const data = state.schools.get(name);
                if (!data) continue;
                if (data.latitude != null && data.longitude != null && typeof L !== 'undefined' && state.map) {
                    try {
                        const marker = createSchoolMarker ? createSchoolMarker(name, data) : null;
                        if (marker) { marker.addTo(state.map); state.markers.set(name, marker); }
                    } catch (e) {
                        try { const mm = L.marker([data.latitude, data.longitude]).bindPopup(name).addTo(state.map); state.markers.set(name, mm); } catch (ee) {}
                    }
                }
            }
        } catch (e) {
            // fallback simple markers
            for (const name of state.activeSchools) {
                const data = state.schools.get(name);
                if (!data) continue;
                if (data.latitude != null && data.longitude != null && typeof L !== 'undefined' && state.map) {
                    try { const mm = L.marker([data.latitude, data.longitude]).bindPopup(name).addTo(state.map); state.markers.set(name, mm); } catch (ee) {}
                }
            }
        }

        // Persist to DuckDB stateSchool table and update UI
        try {
            const { replaceStateSchools } = await import('./state.js');
            const connMod = await import('./duckdb.js');
            const conn = await connMod.getConnection();
            await replaceStateSchools(conn);
        } catch (err) {
            console.warn('Failed to persist stateSchool after import:', err);
        }

        import('./schools.js').then(mod => mod.updateSchoolList());
        import('./paint.js').then(mod => mod.refreshStyles());
        import('./stats.js').then(mod => mod.calculateStatistics());

        // Refresh editor table
        populateTable();
    }

    function openModal() {
        createEditButtonAndModal();
        const overlay = document.getElementById('edit-schools-modal');
        if (!overlay) return;
        // snapshot active schools now so we preserve which schools were active
        // at the moment the editor was opened. We use this to avoid adding
        // markers for newly-created/non-active schools on save.
        try {
            if (state && state.activeSchools && typeof state.activeSchools[Symbol.iterator] === 'function') {
                initialActiveAtOpen = new Set(state.activeSchools);
            } else {
                initialActiveAtOpen = new Set();
            }
        } catch (e) { initialActiveAtOpen = new Set(); }
        populateTable();
        overlay.style.display = 'flex';
    }

    function closeModal() {
        const overlay = document.getElementById('edit-schools-modal');
        if (overlay) overlay.style.display = 'none';
    }

    // expose open/close to outer scope if needed
    return { openModal, closeModal };
}

// create button/modal on load
if (typeof window !== 'undefined') {
    window.addEventListener('load', () => {
        try { createEditButtonAndModal(); } catch (e) { console.error(e); }
    });
}

export { createEditButtonAndModal };
