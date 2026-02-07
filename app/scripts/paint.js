import { state, replaceStateMap, updateStateMapRow, featureStyleDefaults } from './state.js';
import { style as defaultStyle, showBlockStatistics } from './stats.js';

// track whether the 'q' key is currently pressed so popups open on click only while held
let qKeyPressed = false;
if (typeof window !== 'undefined') {
    window.addEventListener('keydown', (e) => {
        if (e.key && e.key.toLowerCase() === 'q') qKeyPressed = true;
    });
    window.addEventListener('keyup', (e) => {
        if (e.key && e.key.toLowerCase() === 'q') qKeyPressed = false;
    });
}
import { calculateStatistics } from './stats.js';
import { getConnection } from './duckdb.js';

export function style(feature) {
    const school = feature.properties.school;
    const schoolData = state.schools.get(school);
    // allow per-feature overrides via properties (eg. _strokeOpacity, _weight, _fillOpacity)
    const fillOpacity = (feature.properties && (feature.properties._fillOpacity != null)) ? Number(feature.properties._fillOpacity) : featureStyleDefaults.fillOpacity;
    const weight = (feature.properties && (feature.properties._weight != null)) ? Number(feature.properties._weight) : featureStyleDefaults.weight;
    const strokeOpacity = (feature.properties && (feature.properties._strokeOpacity != null)) ? Number(feature.properties._strokeOpacity) : featureStyleDefaults.strokeOpacity;
    return {
        fillColor: schoolData ? schoolData.color : '#808080',
        weight: weight,
        opacity: strokeOpacity,
        color: 'black',
        fillOpacity: fillOpacity
    };
}

export async function loadGeoJSON(data) {
    if (state.geojsonLayer) state.map.removeLayer(state.geojsonLayer);
    state.geojsonData = data;
    if (data.properties && data.properties.schools) {
        state.schools.clear();
        Object.entries(data.properties.schools).forEach(([name, value]) => {
            // value historically could be a color string or an object. Normalize to an object.
            if (typeof value === 'string') {
                state.schools.set(name, { color: value, latitude: null, longitude: null, capacity: 0 });
            } else if (value && typeof value === 'object') {
                state.schools.set(name, {
                    color: value.color || '#'+Math.floor(Math.random()*16777215).toString(16).padStart(6,'0'),
                    latitude: value.latitude || null,
                    longitude: value.longitude || null,
                    capacity: value.capacity || 0
                });
            } else {
                state.schools.set(name, { color: '#'+Math.floor(Math.random()*16777215).toString(16).padStart(6,'0'), latitude: null, longitude: null, capacity: 0 });
            }
        });
        // updateSchoolList called by caller
    }

    // Before creating the layer, ensure incoming features have any defaults applied
    if (Array.isArray(state.geojsonData.features)) {
        state.geojsonData.features.forEach(f => {
            if (!f.properties) f.properties = {};
            // only set properties if not explicitly provided in the GeoJSON
            if (f.properties._fillOpacity == null) f.properties._fillOpacity = featureStyleDefaults.fillOpacity;
            if (f.properties._weight == null) f.properties._weight = featureStyleDefaults.weight;
            if (f.properties._strokeOpacity == null) f.properties._strokeOpacity = featureStyleDefaults.strokeOpacity;
        });
    }

    state.geojsonLayer = L.geoJSON(state.geojsonData, {
        style: style,
        onEachFeature: function (feature, layer) {
            layer.on('mouseover', function(e) {
                if (state.mode === 'paint') paintFeature(state.currentSchool, feature, layer);
                else if (state.mode === 'eraser') eraseFeature(feature, layer);
            });
            layer.on('click', function(e) {
                // If in select mode, paint; if eraser, erase; otherwise show stats popup/modal
                if (state.mode === 'select') paintFeature(state.currentSchool, feature, layer);
                else if (state.mode === 'eraser') eraseFeature(feature, layer);
                else {
                    // only open popup if q key is currently pressed
                    if (qKeyPressed) {
                        try { showBlockStatistics(feature, e && e.latlng ? e.latlng : null); } catch (err) { console.warn('Failed to show block stats', err); }
                    }
                }
            });
        }
    }).addTo(state.map);

    // After loading a new GeoJSON, replace the DuckDB stateMap so stats queries
    // reflect the newly-loaded map. This keeps the `stateMap` table in sync
    // and avoids rebuilding it repeatedly from stats modules.
    try {
        const conn = await getConnection();
        await replaceStateMap(conn);
        // Also replace the in-memory stateSchool temporary table so SQL can
        // use editable school metadata (latitude, capacity, etc.)
        try {
            const { replaceStateSchools } = await import('./state.js');
            await replaceStateSchools(conn);
        } catch (e) {
            console.warn('Failed to replace stateSchool after loadGeoJSON:', e);
        }
    } catch (err) {
        console.warn('Failed to replace stateMap after loadGeoJSON:', err);
    }

    calculateStatistics();
    state.map.fitBounds(state.geojsonLayer.getBounds());
}

// Allow updating defaults at runtime (used by UI controls)
export function setFeatureStyleDefaults(opts = {}) {
    if (opts.fillOpacity != null) featureStyleDefaults.fillOpacity = Number(opts.fillOpacity);
    if (opts.weight != null) featureStyleDefaults.weight = Number(opts.weight);
    if (opts.strokeOpacity != null) featureStyleDefaults.strokeOpacity = Number(opts.strokeOpacity);
    // refresh existing layers to apply new defaults
    try { refreshStyles(); } catch (e) {}
}

export function paintBlock(school, blockOfResidence) {
    if (!state.geojsonLayer) return;
    state.geojsonLayer.eachLayer((layer) => {
        try {
            const layerId = layer && layer.feature && layer.feature.properties && layer.feature.properties.block_of_residence;
            if (layerId !== undefined && layerId !== null && String(layerId) === String(blockOfResidence)) {
            layer.feature.properties.school = school;
            layer.setStyle(style(layer.feature));
            calculateStatistics();
            // update DuckDB for this single block
            (async () => {
                try {
                    const conn = await getConnection();
                    await updateStateMapRow(conn, blockOfResidence, school);
                } catch (err) {
                    console.warn('Failed to update stateMap row after paintBlock:', err);
                }
            })();
            }
        } catch (e) {
            // defensive: if a layer lacks properties, skip
        }
    });
}

export function paintFeature(school, feature, layer) {
    if (!school || !feature || !layer) return null;
    if (state.currentSchool !== null) {
        feature.properties.school = school;
        layer.setStyle(style(feature));
        calculateStatistics();
        // update DB mapping for this feature
        (async () => {
            try {
                const props = feature.properties || {};
                const block = props.block_of_residence || props.GEOID20 || null;
                if (block) {
                    const conn = await getConnection();
                    await updateStateMapRow(conn, block, school);
                }
            } catch (err) {
                console.warn('Failed to update stateMap row after paintFeature:', err);
            }
        })();
    }
}

export function eraseFeature(feature, layer) {
    if (!feature || !layer) return null;
    feature.properties.school = null;
    layer.setStyle(style(feature));
    calculateStatistics();
    (async () => {
        try {
            const props = feature.properties || {};
            const block = props.block_of_residence || props.GEOID20 || null;
            if (block) {
                const conn = await getConnection();
                await updateStateMapRow(conn, block, null);
            }
        } catch (err) {
            console.warn('Failed to update stateMap row after eraseFeature:', err);
        }
    })();
}

export function refreshStyles() {
    if (!state.geojsonLayer) return;
    try {
        state.geojsonLayer.eachLayer(layer => {
            layer.setStyle(style(layer.feature));
        });
    } catch (err) {
        console.error('Error refreshing styles:', err);
    }
}
