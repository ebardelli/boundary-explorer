import { state, setCurrentTable } from './state.js';
import { translate } from './i18n.js';

// Exported helper so the filename/geojson -> inferred table logic can be
// unit-tested without needing to manipulate DOM or File objects.
export function inferTableFromGeojsonAndFilename(geojson, fileName) {
    let inferredTable = null;
    if (geojson && geojson.properties && geojson.properties.table) {
        inferredTable = String(geojson.properties.table).toLowerCase();
    }
    if (!inferredTable && fileName) {
        const name = String(fileName).toLowerCase();
        if (name.includes('elementary')) inferredTable = 'elementary';
        else if (name.includes('middle')) inferredTable = 'middle';
        else if (name.includes('high')) inferredTable = 'high';
        else if (name.includes('secondary')) inferredTable = 'secondary';
    }
    return inferredTable;
}

// Export helper to trigger a GeoJSON download for given data. Centralizes
// prompting and anchor-based download so other modules can reuse the logic.
export function exportGeojson(downloadData) {
    if (!downloadData) downloadData = { type: "FeatureCollection", features: [], properties: {} };
    if (!downloadData.properties) downloadData.properties = {};

    // Collect school metadata if present in features
    const schoolsInFeatures = new Set();
    if (Array.isArray(downloadData.features)) {
        downloadData.features.forEach(feature => {
            const s = feature && feature.properties && feature.properties.school;
            if (s) schoolsInFeatures.add(s);
        });
    }

    if (schoolsInFeatures.size > 0) {
        downloadData.properties.schools = {};
        schoolsInFeatures.forEach(name => {
            const data = state.schools.get(name);
            if (data) downloadData.properties.schools[name] = data;
        });
    }

    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(downloadData, null, 2));
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').split('.')[0];
    const defaultFileName = (() => {
        if (!state.currentMap) return `New_Boundaries_${timestamp}.geojson`;
        const sanitizedMap = String(state.currentMap).replace(/ — /g, '_').replace(/\s+/g, '_');
        return `${sanitizedMap}_Boundaries_${timestamp}.geojson`;
    })();
    const promptText = translate('exportFileNamePrompt') || "Enter the name for the exported file:";
    const fileName = prompt(promptText, defaultFileName) || defaultFileName;

    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", fileName);
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
}

export function createFileManager() {
    // If mapping tools are present, those controls already create Import/Export
    // buttons inside '#map-editor-controls'. In that case, wire handlers to
    // the existing elements so all tool buttons live in the same container.
    const mappingControls = document.getElementById('map-editor-controls');
    if (mappingControls) {
        const fileInput = document.getElementById('geojson-upload');
        const importBtn = document.getElementById('import-btn');
        const exportBtn = document.getElementById('export-btn');

        if (importBtn && fileInput) importBtn.addEventListener('click', () => fileInput.click());

        if (fileInput) {
            fileInput.addEventListener('change', async (event) => {
                const file = event.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (e) => {
                    try {
                        const geojson = JSON.parse(e.target.result);

                        try {
                            const inferredTable = inferTableFromGeojsonAndFilename(geojson, file && file.name);
                            if (inferredTable) {
                                setCurrentTable(inferredTable);
                                console.log('Inferred state.currentTable from import:', inferredTable);
                            }
                        } catch (inferErr) {
                            console.warn('Failed to infer currentTable from import:', inferErr);
                        }

                        import('./importHelpers.js').then(async (helpers) => {
                            await helpers.flushSchools({ reloadDefaults: false });
                            const paint = await import('./paint.js');
                            if (paint && typeof paint.loadGeoJSON === 'function') await paint.loadGeoJSON(geojson);
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

        if (exportBtn) {
            exportBtn.addEventListener('click', () => {
                exportGeojson(state.geojsonData);
            });
        }

        // update labels when language changes (keep behavior)
        if (typeof window !== 'undefined') {
            window.addEventListener('languagechange', () => {
                const title = document.getElementById('import-export-title');
                if (title) title.textContent = translate('importExport');
                const importBtnEl = document.getElementById('import-btn');
                if (importBtnEl) importBtnEl.textContent = translate('importGeojson');
                const exportBtnEl = document.getElementById('export-btn');
                if (exportBtnEl) exportBtnEl.textContent = translate('exportGeojson');
            });
        }

        return;
    }

    // fallback: create the import/export markup inside the legacy import-export area
    const fileManager = document.createElement('div');
    fileManager.style.marginTop = '20px';
    fileManager.innerHTML = `
        <div>
            <h3 id="import-export-title">${translate('importExport')}</h3>
            <button id="import-btn" class="tool-list-button">${translate('importGeojson')}</button>
            <input type="file" id="geojson-upload" style="display:none" accept=".geojson, .json" />
            <button id="export-btn" class="tool-list-button">${translate('exportGeojson')}</button>
        </div>
    `;
    document.getElementById('import-export').appendChild(fileManager);

    const fileInput = document.getElementById('geojson-upload');
    const importBtn = document.getElementById('import-btn');
    const exportBtn = document.getElementById('export-btn');

    // Register these fallback-created elements so Mapping Tools can adopt them
    // into the canonical `.map-editor-row` when it initializes later.
    if (typeof window !== 'undefined') {
        window._mappingToolsButtonQueue = window._mappingToolsButtonQueue || [];
        try {
            window._mappingToolsButtonQueue.push({ el: importBtn, afterId: null });
            window._mappingToolsButtonQueue.push({ el: fileInput, afterId: 'import-btn' });
            window._mappingToolsButtonQueue.push({ el: exportBtn, afterId: null });
        } catch (e) {
            // non-fatal if queueing fails
            console.warn('Failed to queue fallback import/export buttons', e);
        }
    }

    importBtn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async (event) => {
        const file = event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const geojson = JSON.parse(e.target.result);

                try {
                    const inferredTable = inferTableFromGeojsonAndFilename(geojson, file && file.name);
                    if (inferredTable) {
                        setCurrentTable(inferredTable);
                        console.log('Inferred state.currentTable from import:', inferredTable);
                    }
                } catch (inferErr) {
                    console.warn('Failed to infer currentTable from import:', inferErr);
                }

                import('./importHelpers.js').then(async (helpers) => {
                    await helpers.flushSchools({ reloadDefaults: false });
                        const paint = await import('./paint.js');
                        if (paint && typeof paint.loadGeoJSON === 'function') await paint.loadGeoJSON(geojson);
                    helpers.finalizeGeojsonImport(geojson);
                });
            } catch (error) {
                alert('Invalid GeoJSON file');
                console.error('Error parsing GeoJSON:', error);
            }
        };
        reader.readAsText(file);
    });

    exportBtn.addEventListener('click', () => exportGeojson(state.geojsonData));

    // update labels when language changes
    if (typeof window !== 'undefined') {
        window.addEventListener('languagechange', () => {
            const title = document.getElementById('import-export-title');
            if (title) title.textContent = translate('importExport');
            const importBtnEl = document.getElementById('import-btn');
            if (importBtnEl) importBtnEl.textContent = translate('importGeojson');
            const exportBtnEl = document.getElementById('export-btn');
            if (exportBtnEl) exportBtnEl.textContent = translate('exportGeojson');
        });
    }
}
