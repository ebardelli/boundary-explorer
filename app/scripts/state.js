export const state = {
    geojsonData: null,
    geojsonLayer: null,
    currentMap: null,
    currentTable: null,
    schools: new Map(),
    currentSchool: null,
    mode: 'none',
    markers: new Map(),
    activeSchools: new Set(),
    map: null
};

// Default visual settings for features loaded from GeoJSON (blocks)
export const featureStyleDefaults = {
    // fill opacity for block polygons (0..1)
    fillOpacity: 0.7,
    // stroke weight in pixels
    weight: 1,
    // stroke opacity (0..1)
    strokeOpacity: 1
};

// Set the active currentTable and notify listeners. Use this instead of
// directly mutating `state.currentTable` so other modules (like duckdb.js)
// can react and recreate derived views (for example __feats).
export function setCurrentTable(tableName) {
    state.currentTable = tableName;
    try {
        if (typeof window !== 'undefined' && window.dispatchEvent) {
            window.dispatchEvent(new CustomEvent('stateTableChanged', { detail: { table: tableName } }));
        }
    } catch (e) {
        console.warn('setCurrentTable: failed to dispatch event', e);
    }
}

// Store custom UI/settings for overlay layers (keeps selected colors per-layer)
export const customLayerSettings = {
    colors: {},
    // per-layer visual settings: opacity (0-1) and weight (stroke width in px)
    opacity: {},
    weight: {}
};

// Re-export `baseMapOptions` for backward compatibility with existing imports.
export { baseMapOptions } from './maps.js';

// Create/populate stateMap temporary table in DuckDB from the in-memory geojson
// features. This is used by stats modules to allow map edits to override
// block->school assignments.
export async function buildStateMap(conn) {
    // Backwards-compatible alias for replaceStateMap
    return replaceStateMap(conn);
}

// Ensure the temporary table exists (creates if missing). Use this when doing
// incremental updates so we don't recreate the table repeatedly.
import { runQuery, upsertRows } from './duckdb.js';

export async function ensureStateMap(conn) {
    if (!conn) return;
    try {
        await runQuery(conn, `CREATE TEMPORARY TABLE IF NOT EXISTS stateMap (block_of_residence VARCHAR PRIMARY KEY, school VARCHAR);`);
    } catch (err) {
        console.warn('ensureStateMap failed:', err);
    }
}

// Replace the entire stateMap contents from the in-memory geojson. This is
// intended to be called only when a new map is loaded (import or base map
// selection).
export async function replaceStateMap(conn) {
    if (!conn) return;
    try {
    await runQuery(conn, `CREATE OR REPLACE TEMPORARY TABLE stateMap (block_of_residence VARCHAR PRIMARY KEY, school VARCHAR);`);

        const mapRows = [];
        if (state.geojsonData && Array.isArray(state.geojsonData.features)) {
            state.geojsonData.features.forEach(f => {
                const props = f.properties || {};
                const block = props.block_of_residence || props.GEOID20 || '';
                const school = props.school || '';
                if (block) mapRows.push({ block, school });
            });
        } else if (state.geojsonLayer && typeof state.geojsonLayer.eachLayer === 'function') {
            state.geojsonLayer.eachLayer(layer => {
                const props = (layer.feature && layer.feature.properties) || {};
                const block = props.block_of_residence || props.GEOID20 || '';
                const school = props.school || '';
                if (block) mapRows.push({ block, school });
            });
        }

        console.log('Replacing stateMap with', mapRows.length, 'rows');
        if (mapRows.length > 0) {
            // Batch the upserts to avoid constructing a single massive SQL
            // statement or overwhelming the worker. Tune batchSize as needed.
            const batchSize = 200;
            for (let i = 0; i < mapRows.length; i += batchSize) {
                const chunk = mapRows.slice(i, i + batchSize);
                const formatted = chunk.map(r => ({ block_of_residence: r.block, school: r.school }));
                try {
                    await upsertRows(conn, 'stateMap', formatted, 'block_of_residence');
                } catch (e) {
                    console.warn(`replaceStateMap: upsert batch ${i}-${i + chunk.length} failed:`, e);
                    // Continue attempting remaining batches — don't hard-fail the full replace.
                }
            }
        }
        // Notify listeners (duckdb.js) that the stateMap has been replaced so
        // they can create dependent views (for example __feats) now that the
        // temporary table exists and is populated.
        try {
            if (typeof window !== 'undefined' && window.dispatchEvent) {
                window.dispatchEvent(new CustomEvent('stateMapReplaced', { detail: { table: state.currentTable } }));
            }
        } catch (e) { console.warn('Failed to dispatch stateMapReplaced event', e); }
    } catch (err) {
        console.error('replaceStateMap failed:', err);
    }
}

// Update a single row in the temporary stateMap table. This does a delete-then-insert
// so it works with DuckDB versions that don't support UPSERT syntax in the browser.
export async function updateStateMapRow(conn, block_of_residence, school) {
    if (!conn || !block_of_residence) return;
    try {
        // ensure table exists
        await ensureStateMap(conn);
        const formatted = { block_of_residence: block_of_residence, school: (school === null || school === undefined) ? '' : school };
        await upsertRows(conn, 'stateMap', formatted, 'block_of_residence');
    } catch (err) {
        console.warn('updateStateMapRow failed:', err);
    }
}

// Batch update multiple rows (array of {block, school}) - performs a single
// multi-value INSERT after deleting matching blocks. This is used when applying
// many edits at once.
export async function updateStateMapBatch(conn, rows = []) {
    if (!conn || !Array.isArray(rows) || rows.length === 0) return;
    try {
        await ensureStateMap(conn);
        const batchSize = 1000;
        for (let i = 0; i < rows.length; i += batchSize) {
            const chunk = rows.slice(i, i + batchSize).map(r => ({ block_of_residence: r.block, school: (r.school === null || r.school === undefined) ? '' : r.school }));
            try {
                await upsertRows(conn, 'stateMap', chunk, 'block_of_residence');
            } catch (e) {
                console.warn(`updateStateMapBatch: upsert chunk ${i}-${i + chunk.length} failed:`, e);
            }
        }
    } catch (err) {
        console.warn('updateStateMapBatch failed:', err);
    }
}

// ------------------------- stateSchool helpers -------------------------
// Create/populate a temporary stateSchool table in DuckDB that mirrors the
// in-memory `state.schools` Map. This allows SQL queries to reference
// editable school metadata (latitude, longitude, capacity, color, etc.)
// using the temporary table `stateSchool` instead of the on-disk
// `data.schools` table.

export async function ensureStateSchools(conn) {
    if (!conn) return;
    try {
        await runQuery(conn, `CREATE TEMPORARY TABLE IF NOT EXISTS as select * from data.schools;`);
    } catch (err) {
        console.warn('ensureStateSchools failed:', err);
    }
}

// Replace the entire stateSchool contents from the in-memory state.schools
// Map. Intended to be called when schools metadata changes (map load, editor save).
export async function replaceStateSchools(conn) {
    if (!conn) return;
    try {
        await runQuery(conn, `CREATE OR REPLACE TEMPORARY TABLE stateSchool (name VARCHAR PRIMARY KEY, latitude DOUBLE, longitude DOUBLE, color VARCHAR, capacity INTEGER, fte_capacity DOUBLE);`);

        const rows = [];
        // Fetch data.schools.fte for fallbacks in one query to avoid per-row queries
        let dataFteMap = new Map();
        try {
            const ds = await runQuery(conn, `SELECT name, fte_capacity as fte FROM data.schools;`);
            if (Array.isArray(ds)) ds.forEach(r => { if (r && r.name) dataFteMap.set(String(r.name), (r.fte != null) ? Number(r.fte) : null); });
        } catch (e) {
            // Non-fatal if data.schools is missing or attach failed — we'll fall back to capacity
            dataFteMap = new Map();
        }
        try {
            if (state && state.schools && typeof state.schools.forEach === 'function') {
                state.schools.forEach((v, k) => {
                    const name = String(k || '');
                    const latitude = (v && v.latitude != null) ? Number(v.latitude) : null;
                    const longitude = (v && v.longitude != null) ? Number(v.longitude) : null;
                    const color = (v && v.color) ? String(v.color) : null;
                    const capacity = (v && v.capacity != null) ? Number(v.capacity) : null;
                    // Prefer explicit `v.fte` (editor writes `fte`), then legacy `v.fte_capacity`,
                    // then fallback to `data.schools.fte`, then capacity.
                    const fte_capacity = (v && v.fte != null) ? Number(v.fte)
                        : (v && v.fte_capacity != null) ? Number(v.fte_capacity)
                        : (dataFteMap.has(name) && dataFteMap.get(name) != null) ? Number(dataFteMap.get(name))
                        : (capacity != null ? Number(capacity) : null);
                    rows.push({ name, latitude, longitude, color, capacity, fte_capacity });
                });
            }
        } catch (e) {
            console.warn('replaceStateSchools: failed to enumerate state.schools', e);
        }

        if (rows.length > 0) {
            const batchSize = 200;
            for (let i = 0; i < rows.length; i += batchSize) {
                const chunk = rows.slice(i, i + batchSize);
                try {
                    await upsertRows(conn, 'stateSchool', chunk, 'name');
                } catch (e) {
                    console.warn(`replaceStateSchools: upsert batch ${i}-${i + chunk.length} failed:`, e);
                }
            }
        }

        try {
            if (typeof window !== 'undefined' && window.dispatchEvent) {
                window.dispatchEvent(new CustomEvent('stateSchoolReplaced', { detail: {} }));
            }
        } catch (e) { console.warn('Failed to dispatch stateSchoolReplaced event', e); }
    } catch (err) {
        console.error('replaceStateSchools failed:', err);
    }
}

// Update a single school row
export async function updateStateSchoolRow(conn, name, obj) {
    if (!conn || !name) return;
    try {
        await ensureStateSchools(conn);
        // Determine fte_capacity: prefer obj.fte, then obj.fte_capacity, then try to read from data.schools.fte, then capacity
        let fte_capacity = null;
        if (obj && obj.fte != null) fte_capacity = obj.fte;
        else if (obj && obj.fte_capacity != null) fte_capacity = obj.fte_capacity;
        else if (obj && obj.capacity != null) fte_capacity = obj.capacity;
        else {
            // try reading from data.schools
            try {
                const rows = await runQuery(conn, `SELECT fte FROM data.schools WHERE name = '${String(name).replace(/'/g, "''")}' LIMIT 1;`);
                if (rows && rows[0] && rows[0].fte != null) fte_capacity = Number(rows[0].fte);
            } catch (e) {
                // ignore and leave fte_capacity null
            }
        }

        const formatted = {
            name: String(name),
            latitude: (obj && obj.latitude != null) ? obj.latitude : null,
            longitude: (obj && obj.longitude != null) ? obj.longitude : null,
            color: (obj && obj.color != null) ? obj.color : null,
            capacity: (obj && obj.capacity != null) ? obj.capacity : null,
            fte_capacity: (fte_capacity != null) ? fte_capacity : null
        };
        await upsertRows(conn, 'stateSchool', formatted, 'name');
    } catch (err) {
        console.warn('updateStateSchoolRow failed:', err);
    }
}

// Batch update multiple school rows. Accepts array of {name, latitude, longitude, color, capacity, fte_capacity}
export async function updateStateSchoolBatch(conn, rows = []) {
    if (!conn || !Array.isArray(rows) || rows.length === 0) return;
    try {
        await ensureStateSchools(conn);
        const batchSize = 500;
        for (let i = 0; i < rows.length; i += batchSize) {
            const chunkRows = rows.slice(i, i + batchSize);
            // collect names that might need fallback from data.schools
            const needFallbackNames = chunkRows.filter(r => (r.fte != null) || (r.fte_capacity != null) ? false : true).map(r => r.name).filter(Boolean);
            let dataFte = new Map();
            if (needFallbackNames.length > 0) {
                try {
                    const safeList = needFallbackNames.map(n => `'${String(n).replace(/'/g, "''")}'`).join(',');
                    const ds = await runQuery(conn, `SELECT name, fte FROM data.schools WHERE name IN (${safeList});`);
                    if (Array.isArray(ds)) ds.forEach(r => { if (r && r.name) dataFte.set(String(r.name), (r.fte != null) ? Number(r.fte) : null); });
                } catch (e) {
                    dataFte = new Map();
                }
            }

            const chunk = chunkRows.map(r => {
                const name = r.name;
                const latitude = (r.latitude != null) ? r.latitude : null;
                const longitude = (r.longitude != null) ? r.longitude : null;
                const color = r.color || null;
                const capacity = (r.capacity != null) ? r.capacity : null;
                // prefer explicit r.fte, then r.fte_capacity, then data.schools.fte, then capacity
                let fte_capacity = null;
                if (r && r.fte != null) fte_capacity = r.fte;
                else if (r && r.fte_capacity != null) fte_capacity = r.fte_capacity;
                else if (dataFte.has(name) && dataFte.get(name) != null) fte_capacity = dataFte.get(name);
                else if (capacity != null) fte_capacity = capacity;

                return {
                    name,
                    latitude,
                    longitude,
                    color,
                    capacity,
                    fte_capacity: (fte_capacity != null) ? fte_capacity : null
                };
            });
            try {
                await upsertRows(conn, 'stateSchool', chunk, 'name');
            } catch (e) {
                console.warn(`updateStateSchoolBatch: upsert chunk ${i}-${i + chunk.length} failed:`, e);
            }
        }
    } catch (err) {
        console.warn('updateStateSchoolBatch failed:', err);
    }
}
