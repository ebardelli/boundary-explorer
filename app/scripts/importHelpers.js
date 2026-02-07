import { state, replaceStateMap } from './state.js';
import { getConnection } from './duckdb.js';

// Shared helper used after a GeoJSON is loaded into the map (either via
// the file manager or via baseMapOptions selection). Normalizes schools
// entries in `state`, marks them active, updates the UI, refreshes styles,
// and recalculates statistics.
export async function finalizeGeojsonImport(geojson) {
    try {
        // Only consider schools that are actually assigned to GeoJSON features
        // (i.e. active schools). We intentionally ignore geojson.properties.schools
        // here because that object can include metadata or inactive schools that
        // should not be automatically activated when loading a map.
        const schoolsInFeatures = new Set();
        if (Array.isArray(geojson.features)) {
            geojson.features.forEach(feature => {
                // Try common property keys that might hold the school name.
                const s = feature && feature.properties && (feature.properties.school || feature.properties.SCHOOL || feature.properties.school_name);
                if (s) schoolsInFeatures.add(s);
            });
        }

        if (schoolsInFeatures.size > 0) {
            // Use the centralized helper to register and activate these names.
            try {
                await registerSchoolNames(Array.from(schoolsInFeatures));

                // If the GeoJSON has a top-level properties.schools object/array,
                // merge any provided metadata (color, latitude, longitude, capacity)
                // into the registered schools. We only apply metadata for schools
                // that are present in the features (i.e. active schools) to avoid
                // unintentionally activating inactive or unrelated schools.
                try {
                    const props = geojson && geojson.properties && geojson.properties.schools;
                    const updatedFromProvided = new Set();

                    // Helper to merge meta into state.schools entry
                    const mergeMeta = (name, meta) => {
                        try {
                            const existing = state.schools.get(name) || {};
                            const merged = Object.assign({}, existing);
                            if (meta && typeof meta === 'object') {
                                if (meta.color || meta.colour || meta.hex) merged.color = meta.color || meta.colour || meta.hex;
                                if (meta.latitude !== undefined || meta.lat !== undefined) merged.latitude = meta.latitude ?? meta.lat;
                                if (meta.longitude !== undefined || meta.lon !== undefined || meta.lng !== undefined) merged.longitude = meta.longitude ?? meta.lon ?? meta.lng;
                                if (meta.capacity !== undefined || meta.cap !== undefined) merged.capacity = meta.capacity ?? meta.cap;
                            } else if (typeof meta === 'string') {
                                // treat scalar as color
                                merged.color = meta;
                            }
                            state.schools.set(name, merged);
                            updatedFromProvided.add(name);
                        } catch (err) {
                            // ignore individual failures
                        }
                    };

                    if (props) {
                        // Normalize to a map keyed by school name for easy lookup.
                        if (Array.isArray(props)) {
                            props.forEach(item => {
                                if (!item) return;
                                const name = item.name || item.school || item.school_name || item.id;
                                if (!name) return;
                                const key = String(name);
                                if (!schoolsInFeatures.has(key)) return;
                                mergeMeta(key, item);
                            });
                        } else if (typeof props === 'object') {
                            // If it's an object keyed by school name, copy entries.
                            Object.keys(props).forEach(k => {
                                const v = props[k];
                                const key = String(k);
                                if (!schoolsInFeatures.has(key)) return;
                                mergeMeta(key, v);
                            });
                        }
                    }

                    // For any active schools not provided in properties.schools,
                    // try to pull defaults from the on-disk schools.json database.
                    const remaining = Array.from(schoolsInFeatures).filter(n => !updatedFromProvided.has(n));
                    if (remaining.length > 0) {
                        try {
                            const schoolsUrl = new URL('../schools.json', import.meta.url).href;
                            const resp = await fetch(schoolsUrl);
                            if (resp && resp.ok) {
                                const list = await resp.json();
                                if (Array.isArray(list)) {
                                    // create a lookup by name (case-insensitive)
                                    const lookup = new Map();
                                    list.forEach(item => {
                                        if (!item || !item.name) return;
                                        lookup.set(String(item.name).trim().toLowerCase(), item);
                                    });

                                    remaining.forEach(name => {
                                        try {
                                            const found = lookup.get(String(name).trim().toLowerCase());
                                            if (found) {
                                                mergeMeta(name, found);
                                            }
                                        } catch (err) {
                                            // ignore
                                        }
                                    });
                                }
                            }
                        } catch (err) {
                            // ignore failures to fetch or parse schools.json
                        }
                    }

                    // Refresh UI and styles since we mutated school entries
                    import('./schools.js').then(mod => mod.updateSchoolList());
                    import('./paint.js').then(mod => mod.refreshStyles());
                    import('./stats.js').then(mod => mod.calculateStatistics());
                    // update stateSchool table
                    try {
                        import('./duckdb.js').then(async mod => {
                            try {
                                const conn = await mod.getConnection();
                                const { replaceStateSchools } = await import('./state.js');
                                await replaceStateSchools(conn);
                            } catch (e) { /* ignore */ }
                        }).catch(_e => {});
                    } catch (e) {}
                } catch (err) {
                    console.warn('Failed to apply properties.schools metadata or fallback:', err);
                }
            } catch (err) {
                console.warn('registerSchoolNames failed in finalizeGeojsonImport:', err);
            }
        } else {
            // still update the list/stats in case properties.schools was present but empty
            import('./schools.js').then(mod => mod.updateSchoolList());
            import('./stats.js').then(mod => mod.calculateStatistics());
        }
    } catch (err) {
        console.error('Error finalizing schools from GeoJSON:', err);
    }
}

// Clear all school-related UI/state before loading a new base map or import.
// Removes markers from the map, clears the schools map and active set, and
// resets currentSchool. Also updates the UI and statistics so the app shows
// the flushed state immediately.
export async function flushSchools(options = {}) {
    try {
        // remove any markers from the map
        try {
            state.markers.forEach((marker) => {
                try {
                    if (state.map && marker && state.map.hasLayer && state.map.hasLayer(marker)) {
                        state.map.removeLayer(marker);
                    }
                } catch (e) {
                    // ignore individual marker failures
                }
            });
        } catch (e) {
            // ignore
        }

        state.markers.clear();
        state.schools.clear();
        state.activeSchools.clear();
        state.currentSchool = null;

        // lazy-load UI modules to update list, styles and stats
        const [schoolsMod, paintMod, statsMod] = await Promise.all([
            import('./schools.js'),
            import('./paint.js'),
            import('./stats.js')
        ]);

        // Optionally re-initialize default schools (loads app/schools.json)
        // By default we reload defaults to ensure the UI has a baseline set of
        // schools when switching base maps. However, file imports should skip
        // reloading defaults so the imported file's referenced schools become
        // the single source of truth for the session.
        const { reloadDefaults = true } = options || {};
        if (reloadDefaults) {
            if (typeof schoolsMod.loadSchools === 'function') {
                try {
                    await schoolsMod.loadSchools();
                } catch (err) {
                    // If loading defaults fails, fall back to rendering empty list
                    console.warn('Failed to load default schools after flush:', err);
                    schoolsMod.updateSchoolList && schoolsMod.updateSchoolList();
                }
            } else {
                // fallback: update list if loadSchools not available
                schoolsMod.updateSchoolList && schoolsMod.updateSchoolList();
            }
        } else {
            // Caller requested we not reload defaults; just render whatever state
            // currently contains (likely empty) so that subsequent imports
            // (finalizeGeojsonImport) can populate from feature properties only.
            schoolsMod.updateSchoolList && schoolsMod.updateSchoolList();
        }

        // refresh visuals and statistics to reflect the newly-loaded defaults
        paintMod.refreshStyles();
        statsMod.calculateStatistics();
        // If we've reloaded defaults (e.g., switching base maps), ensure the
        // DuckDB `stateMap` doesn't retain stale mappings. Replace it with
        // whatever the current in-memory geojson contains (often empty until
        // a base map is subsequently loaded).
        if (reloadDefaults) {
            try {
                    const conn = await getConnection();
                    await replaceStateMap(conn);
                        // also replace stateSchool table with defaults
                        try {
                            const { replaceStateSchools } = await import('./state.js');
                            await replaceStateSchools(conn);
                        } catch (e) { console.warn('Failed to replace stateSchool during flushSchools:', e); }
                } catch (err) {
                    console.warn('Failed to replace stateMap during flushSchools:', err);
                }
        }
    } catch (err) {
        console.error('Error flushing schools state:', err);
    }
}

// Register an array of school names into state.schools and mark them active.
// This centralizes the logic used by multiple import flows so names are
// processed consistently (color assignment, activation, UI refresh).
export async function registerSchoolNames(names = []) {
    try {
        if (!Array.isArray(names) || names.length === 0) return;
        const uniq = Array.from(new Set(names.map(n => String(n || '').trim()).filter(n => n)));
        if (uniq.length === 0) return;

        const [utilsMod, schoolsMod, paintMod, statsMod] = await Promise.all([
            import('./utils.js'),
            import('./schools.js'),
            import('./paint.js'),
            import('./stats.js')
        ]);
        const getRandomColor = utilsMod.getRandomColor;

        uniq.forEach(name => {
            if (!state.schools.has(name)) {
                state.schools.set(name, { color: getRandomColor(), latitude: null, longitude: null, capacity: 0 });
            } else {
                const val = state.schools.get(name);
                if (typeof val === 'string') {
                    state.schools.set(name, { color: val, latitude: null, longitude: null, capacity: 0 });
                } else if (!val || !val.color) {
                    const newColor = getRandomColor();
                    state.schools.set(name, Object.assign({ color: newColor, latitude: null, longitude: null, capacity: 0 }, val || {}));
                }
            }
            state.activeSchools.add(name);
        });

        if (!state.currentSchool || !state.activeSchools.has(state.currentSchool)) {
            state.currentSchool = uniq[0];
        }

        schoolsMod.updateSchoolList && schoolsMod.updateSchoolList();
        paintMod.refreshStyles && paintMod.refreshStyles();
        statsMod.calculateStatistics && statsMod.calculateStatistics();
        // persist newly-registered names (and any metadata) to DuckDB
        try {
            import('./duckdb.js').then(async mod => {
                try {
                    const conn = await mod.getConnection();
                    const { replaceStateSchools } = await import('./state.js');
                    await replaceStateSchools(conn);
                } catch (e) { /* ignore */ }
            }).catch(_e => {});
        } catch (e) {}
    } catch (err) {
        console.warn('registerSchoolNames failed:', err);
    }
}
