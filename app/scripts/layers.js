import { state, customLayerSettings } from './state.js';
import { translate } from './i18n.js';

export const additionalLayers = {
    districts: { name: "Feeder District Boundaries", url: 'maps/feeder_districts.geojson', color: '#1f78b4' },
    elementary: { name: "Elementary Boundaries - 2025", url: 'maps/elementary_boundaries_2025.geojson', color: '#33a02c' },
    elementary_2024: { name: "Elementary Boundaries - 2024", url: 'maps/elementary_boundaries_2024.geojson', color: '#b2df8a' },
    middle_2024: { name: "Middle Boundaries - 2024", url: 'maps/middle_boundaries_2024.geojson', color: '#fb9a99' },
    high_2024: { name: "High Boundaries - 2024", url: 'maps/high_boundaries_2024.geojson', color: '#e31a1c' },
    high_2025: { name: "High Boundaries - 2025", url: 'maps/high_boundaries_2025.geojson', color: '#ff7f00' },
    high_2026: { name: "High Boundaries - 2026", url: 'maps/high_boundaries_2026.geojson', color: '#ff7f00' },
    landmarks: { name: "Landmarks", url: 'maps/landmarks.geojson', color: '#1174ddff' }
};

export function createLayerControls(map) {
    // Base layer options: several OpenStreetMap-derived and common basemap
    // providers are offered here so users can switch the map background.
    // If you add more providers, ensure you include appropriate attribution
    // strings and follow the tile provider's usage policy (rate limits, API keys, etc.).
    // The original OpenStreetMap tiles remain the default and are added to the map.
    const baseLayers = {
        "OpenStreetMap": L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
            maxZoom: 22,
            maxNativeZoom: 18
        }).addTo(map),

        // OpenTopoMap
        "OpenTopoMap": L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
            attribution: 'Map data: &copy; <a href="https://www.openstreetmap.org/">OpenStreetMap</a> contributors, SRTM | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a>',
            maxZoom: 17
        }),

        // Esri World Street Map
        "Esri World StreetMap": L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
            attribution: 'Tiles &copy; Esri &mdash; Source: Esri, DeLorme, NAVTEQ, USGS, Intermap, iPC, NRCAN, Esri Japan, METI, Esri China (Hong Kong), Esri (Thailand), TomTom, 2012'
        }),

        // Esri National Geographic basemap
        "Esri NatGeo World Map": L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/NatGeo_World_Map/MapServer/tile/{z}/{y}/{x}', {
            attribution: 'Tiles &copy; Esri &mdash; National Geographic, Esri, DeLorme, NAVTEQ, UNEP-WCMC, USGS, NASA, ESA, METI, NRCAN, GEBCO, NOAA, iPC',
            maxZoom: 16
        }),

        // USGS basemaps
        "USGS US Topo": L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', {
            maxZoom: 20,
            attribution: 'Tiles courtesy of the <a href="https://usgs.gov/">U.S. Geological Survey</a>'
        }),

        "USGS Imagery": L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}', {
            maxZoom: 20,
            attribution: 'Tiles courtesy of the <a href="https://usgs.gov/">U.S. Geological Survey</a>'
        }),

        "USGS Imagery Topo": L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}', {
            maxZoom: 20,
            attribution: 'Tiles courtesy of the <a href="https://usgs.gov/">U.S. Geological Survey</a>'
        }),

        // Thunderforest
        "Thunderforest Mobile Atlas": L.tileLayer('https://{s}.tile.thunderforest.com/mobile-atlas/{z}/{x}/{y}.png?apikey={api_key}', {
            attribution: 'Maps &copy; Thunderforest, Data &copy; OpenStreetMap contributors',
            api_key: '9251eeae40d24202bb2f54873d1d20e3',
            maxZoom: 22
        })
    };

    // Ensure a dedicated pane for overlays that should always sit above base/map tiles.
    // Using a custom pane with a high z-index prevents newly added overlays from being
    // rendered underneath a tile layer that was added later.
    if (!map.getPane('top-overlays')) {
        map.createPane('top-overlays');
        const topPane = map.getPane('top-overlays');
        // z-index above default tile/overlay panes (tilePane ~200). Pick a suitably high value.
        topPane.style.zIndex = 650;
        // Keep pointer-events off by default so these decorative boundaries don't block map interaction.
        topPane.style.pointerEvents = 'none';
    }

    // We'll load layers in parallel, but collect results in the same order as
    // `additionalLayers` so the final overlays object (and the layers control)
    // always use a deterministic ordering instead of depending on network timing.
    let overlayLayers = {};
    const layerPromises = Object.entries(additionalLayers).map(([key, layerDef]) => {
        return fetch(layerDef.url)
            .then(r => r.json())
            .then(data => {
                const initialColor = (customLayerSettings && customLayerSettings.colors && customLayerSettings.colors[key]) || layerDef.color || '#ff7800';
                // If this is a point-only layer (like landmarks) render points as
                // colored circle markers and attach popups/icons. For polygon/polylines
                // use the existing styling approach.
                let geoJsonLayer;
                if (key === 'landmarks') {
                    // NOTE: Landmark icons were switched from emoji to Font Awesome icons.
                    // This file now emits <i class="fa-solid fa-..."> elements inside
                    // the landmark divIcon. Ensure `apps/boundary-explorer/index.html`
                    // includes the Font Awesome stylesheet (this project uses the
                    // CDN link there). If you prefer a different FA subset or an
                    // offline package, update the stylesheet reference accordingly.
                    geoJsonLayer = L.geoJSON(data, {
                        pane: 'top-overlays',
                        pointToLayer: (feature, latlng) => {
                            // Prefer per-feature marker-color/marker-symbol if present
                            const p = feature.properties || {};
                            const featureColor = p['marker-color'] || p['markerColor'] || ((customLayerSettings && customLayerSettings.colors && customLayerSettings.colors[key]) || initialColor) || '#ff7800';
                            const symbol = p['marker-symbol'] || p['markerSymbol'] || null;

                            // If a symbol is provided, render a divIcon so we can show the symbol
                            // using a Font Awesome icon (fall back to a single-letter label). Otherwise
                            // fall back to circleMarker.
                            if (symbol) {
                                    // Use Font Awesome icons for landmark symbols. If a mapping exists use
                                    // the FA class (solid style). Fall back to a single-letter label.
                                    // NOTE: Ensure Font Awesome CSS is loaded in the page (index.html).
                                    const faMap = {
                                        'shop': 'fa-store',
                                        'park': 'fa-tree',
                                        'car': 'fa-car',
                                        'airport': 'fa-plane',
                                        'airfield': 'fa-plane',
                                        'cemetery': 'fa-church',
                                        'golf': 'fa-golf-ball-tee',
                                        'suitcase': 'fa-suitcase',
                                        'horse-riding': 'fa-horse',
                                        'courthouse': 'fa-gavel',
                                        'hospital': 'fa-hospital'
                                    };
                                    const faClass = faMap[symbol];
                                    const size = 24;
                                    // Build inner content: prefer a FA <i> element so the icon glyph comes from the
                                    // Font Awesome font. Keep the icon color white and slightly smaller than the
                                    // container so it fits within the circular swatch.
                                    let innerIconHtml;
                                    if (faClass) {
                                        innerIconHtml = `<i class="fa-solid ${faClass}" aria-hidden="true" style="color: white; font-size:12px; line-height:1"></i>`;
                                    } else {
                                        innerIconHtml = `<i class="fa-solid fa-landmark" aria-hidden="true" style="color: white; font-size:12px; line-height:1"></i>`;
                                    }
                                    const html = `
                                        <div class="landmark-divicon" style="display:inline-flex;align-items:center;justify-content:center;">
                                            <div class="landmark-icon" style="background:${featureColor};width:${size}px;height:${size}px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:1px solid rgba(0,0,0,0.2);font-size:14px;line-height:1">${innerIconHtml}</div>
                                        </div>`;
                                const icon = L.divIcon({ className: 'landmark-divicon-container', html, iconSize: [size, size], iconAnchor: [size/2, size/2] });
                                const marker = L.marker(latlng, { icon, interactive: true });
                                try {
                                    const title = p.Name || p.name || p.title || p.label || translate('landmark') || 'Landmark';
                                    const type = p.type ? `<div><strong>${translate('type') || 'Type'}:</strong> ${p.type}</div>` : '';
                                    const desc = p.description ? `<div>${p.description}</div>` : '';
                                    const content = `<div><strong>${title}</strong>${type}${desc}</div>`;
                                    marker.bindPopup(content);
                                } catch (e) {}
                                return marker;
                            }

                            // No symbol: use a circleMarker colored by the layer or feature
                            const marker = L.circleMarker(latlng, {
                                radius: 8,
                                fillColor: featureColor,
                                color: '#222',
                                weight: 1,
                                opacity: 1,
                                fillOpacity: 0.9
                            });
                            try {
                                const title = p.Name || p.name || p.title || p.label || translate('landmark') || 'Landmark';
                                const type = p.type ? `<div><strong>${translate('type') || 'Type'}:</strong> ${p.type}</div>` : '';
                                const desc = p.description ? `<div>${p.description}</div>` : '';
                                const content = `<div><strong>${title}</strong>${type}${desc}</div>`;
                                marker.bindPopup(content);
                            } catch (e) {}
                            return marker;
                        },
                        onEachFeature: (feature, featureLayer) => {
                            // pointer events should remain enabled for point markers so popups work
                        }
                    });
                } else {
                    geoJsonLayer = L.geoJSON(data, {
                        // place this layer into the top-overlays pane so it renders above tile layers
                        pane: 'top-overlays',
                        style: { color: initialColor, weight: 4, opacity: 1, fillOpacity: 0, interactive: false },
                        onEachFeature: (feature, featureLayer) => {
                            // individual feature DOM elements live inside the pane; keep them non-interactive
                            featureLayer.getElement?.()?.setAttribute('pointer-events', 'none');
                        }
                    });
                }
                geoJsonLayer._layerKey = key;
                geoJsonLayer.on('add', function(e) {
                    if (e.target.getElement) {
                        const elementParent = e.target.getElement();
                        if (elementParent) elementParent.setAttribute('pointer-events', 'none');
                    }
                });
                // return the info so Promise.all preserves original iteration order
                return { key, name: layerDef.name, layer: geoJsonLayer };
            })
            .catch(err => {
                console.error(`Error loading boundary layer ${layerDef.name}:`, err);
                return { key, name: layerDef.name, layer: null };
            });
    });

    // Once all overlay layers are loaded (or failed), create the layers control once and attach pickers
    Promise.all(layerPromises).then((results) => {
        if (map.layerControl) map.layerControl.remove();
        // Assemble overlays in the original additionalLayers order so the control stays stable
        const orderedOverlays = {};
        results.forEach(res => {
            if (res && res.layer) orderedOverlays[res.name] = res.layer;
        });
        overlayLayers = orderedOverlays;
        map.layerControl = L.control.layers(baseLayers, overlayLayers).addTo(map);
        // Ensure map.customLayers is set before attaching color pickers so they can inspect
        // the actual overlay layer objects (this prevents the swatch defaulting to orange).
        map.customLayers = { base: baseLayers, overlays: overlayLayers };
        attachColorPickers(map);
    });

    return { baseLayers, overlayLayers };
}

export function setLayerColor(map, key, color) {
    // persist color (defensive: customLayerSettings may be undefined if module init order is odd)
    let settings = customLayerSettings;
    if (!settings) {
        // fallback: attach to state so it persists for this session
        state.customLayerSettings = state.customLayerSettings || { colors: {} };
        settings = state.customLayerSettings;
    }
    settings.colors = settings.colors || {};
    settings.colors[key] = color;
    // Apply combined style (color + any saved opacity/weight)
    const opts = {
        color: color,
        opacity: (settings.opacity && settings.opacity[key] != null) ? Number(settings.opacity[key]) : 1,
        weight: (settings.weight && settings.weight[key] != null) ? Number(settings.weight[key]) : 4,
        fillOpacity: 0
    };
    setLayerStyle(map, key, opts);
    // update any loaded overlay layers that belong to this key
    const overlays = map?.customLayers?.overlays || {};
    Object.entries(overlays).forEach(([name, layer]) => {
        if (!layer) return;
        try {
            // match by explicit _layerKey (used for uploaded layers) OR by the display name key
            if ((layer._layerKey && layer._layerKey === key) || name === key) {
                // Apply stroke and transparent fill to the layer and its children
                const styleObj = { color, fillOpacity: 0, opacity: 1 };
                if (typeof layer.setStyle === 'function') {
                    try { layer.setStyle(styleObj); } catch (e) {}
                }
                if (typeof layer.getLayers === 'function') {
                    try {
                        layer.getLayers().forEach(child => {
                            if (child && typeof child.setStyle === 'function') child.setStyle(styleObj);
                            try { const el = child.getElement?.(); if (el) el.setAttribute('pointer-events', 'none'); } catch (e) {}
                        });
                    } catch (e) {}
                }
                // also ensure pointer-events remain off for the layer's top element
                try { const el = layer.getElement?.(); if (el) el.setAttribute('pointer-events', 'none'); } catch (e) {}
            }
        } catch (e) {
            // defensive: ignore per-layer errors
        }
    });
}

// Apply style options (color, opacity, weight, fillOpacity) to matching overlay layers
export function setLayerStyle(map, key, opts = {}) {
    if (!map || !key) return;
    try {
        // persist any provided settings
        if (!state.customLayerSettings) state.customLayerSettings = { colors: {}, opacity: {}, weight: {} };
        const settings = state.customLayerSettings;
        settings.colors = settings.colors || {};
        settings.opacity = settings.opacity || {};
        settings.weight = settings.weight || {};
        if (opts.color) settings.colors[key] = opts.color;
        if (opts.opacity != null) settings.opacity[key] = Number(opts.opacity);
        if (opts.weight != null) settings.weight[key] = Number(opts.weight);

        // Build style object for Leaflet
        const styleObj = {
            color: opts.color || settings.colors[key] || '#ff7800',
            opacity: (opts.opacity != null) ? Number(opts.opacity) : (settings.opacity[key] != null ? Number(settings.opacity[key]) : 1),
            weight: (opts.weight != null) ? Number(opts.weight) : (settings.weight[key] != null ? Number(settings.weight[key]) : 4),
            fillOpacity: (opts.fillOpacity != null) ? Number(opts.fillOpacity) : 0
        };

        const overlays = map?.customLayers?.overlays || {};
        Object.entries(overlays).forEach(([name, layer]) => {
            if (!layer) return;
            try {
                if ((layer._layerKey && layer._layerKey === key) || name === key || name === key) {
                    if (typeof layer.setStyle === 'function') {
                        try { layer.setStyle(styleObj); } catch (e) {}
                    }
                    if (typeof layer.getLayers === 'function') {
                        try {
                            layer.getLayers().forEach(child => {
                                if (child) {
                                    // For vector layers (polygons/lines) use setStyle
                                    if (typeof child.setStyle === 'function') child.setStyle(styleObj);
                                    // For point markers (circleMarker) update fillColor/opacity directly
                                    try {
                                        if (child instanceof L.CircleMarker || (child.options && child.options.fillColor !== undefined)) {
                                            try { child.setStyle({ fillColor: styleObj.color, color: styleObj.color, fillOpacity: (settings.fillOpacity && settings.fillOpacity[key] != null) ? Number(settings.fillOpacity[key]) : child.options.fillOpacity || 0.9 }); } catch (e) {}
                                        }
                                    } catch (e) {}
                                    try { const el = child.getElement?.(); if (el) el.setAttribute('pointer-events', 'none'); } catch (e) {}
                                    // If this child is a marker using the landmark divIcon, update its inner background
                                    try {
                                        // Some environments may not have L available for instanceof checks,
                                        // so prefer checking the icon's className where possible.
                                        const isDivIcon = child && child.options && child.options.icon && child.options.icon.options && child.options.icon.options.className && child.options.icon.options.className.indexOf('landmark-divicon-container') !== -1;
                                        if (isDivIcon) {
                                            try {
                                                const el = child.getElement && child.getElement();
                                                if (el) {
                                                    const iconInner = el.querySelector && el.querySelector('.landmark-icon');
                                                    if (iconInner) iconInner.style.background = styleObj.color;
                                                }
                                            } catch (e) {}
                                        }
                                    } catch (e) {}
                                }
                            });
                        } catch (e) {}
                    }
                    try { const el = layer.getElement?.(); if (el) { el.setAttribute('pointer-events', 'none'); if (styleObj.color) el.style.stroke = styleObj.color; } } catch (e) {}
                }
            } catch (e) {}
        });
    } catch (e) { console.warn('setLayerStyle failed', e); }
}

export function attachColorPickers(map) {
    // Find the Leaflet layers control container
    if (!map.layerControl || !map.layerControl.getContainer) return;
    const container = map.layerControl.getContainer();
    if (!container) return;
    // We'll walk the labels in the layers control and add swatches for any overlay entry.
    const labels = container.querySelectorAll('label');
    // Build a map of overlay displayName -> internalKey for color persistence lookups.
    const overlayKeys = {};
    try {
        const overlays = map.customLayers && map.customLayers.overlays ? map.customLayers.overlays : {};
        Object.keys(overlays).forEach(k => { overlayKeys[k] = k; });
        // also include configured additionalLayers by their display name
        Object.entries(additionalLayers).forEach(([key, def]) => { overlayKeys[def.name] = key; });
    } catch (e) {}

    for (const label of labels) {
        // Only target overlay entries (they use checkbox inputs). Base layers are radios and should be skipped.
        const input = label.querySelector('input');
        if (!input || input.type !== 'checkbox') continue;

        const span = label.querySelector('span') || label;
        if (!span) continue;
        const name = span.textContent.trim();
        if (!name) continue;

        // Skip if a swatch already exists
        let ns = label.nextSibling;
        while (ns && ns.nodeType === Node.TEXT_NODE) ns = ns.nextSibling;
        if (ns && ns.classList && (ns.classList.contains('layer-color-swatch') || ns.classList.contains('layer-color-popover'))) continue;

        // Determine the settings key: prefer a stored key (overlayKeys[name]) else use name itself
        const settingsKey = overlayKeys[name] || name;
        // Prefer an explicitly saved color. If none, try to read the layer's current style so the
        // swatch always reflects the actual visible color on the map. Fall back to a default.
        let initial = (customLayerSettings && customLayerSettings.colors && customLayerSettings.colors[settingsKey]) || null;
        if (!initial) {
            try {
                const overlays = map.customLayers && map.customLayers.overlays ? map.customLayers.overlays : {};
                // overlays keys are the display names used in the control
                const layerRef = overlays[name] || overlays[settingsKey];
                if (layerRef) {
                    // try common places for a stroke color: layer.options.color, layer.options.style.color, child's options
                    if (layerRef.options && layerRef.options.color) initial = layerRef.options.color;
                    else if (layerRef.options && layerRef.options.style && layerRef.options.style.color) initial = layerRef.options.style.color;
                    else if (typeof layerRef.getLayers === 'function') {
                        const children = layerRef.getLayers();
                        if (children && children.length > 0) {
                            const first = children[0];
                            if (first && first.options && first.options.color) initial = first.options.color;
                        }
                    }
                    // If still not found, try reading the DOM element's stroke color
                    if (!initial) {
                        try {
                            const el = layerRef.getElement && layerRef.getElement();
                            if (el) {
                                const stroke = el.style && el.style.stroke;
                                if (stroke) initial = stroke;
                            }
                        } catch (e) {}
                    }
                }
            } catch (e) {
                // ignore
            }
        }
        if (!initial) initial = '#ff7800';

        // Create swatch and popover similar to previous behavior
        const swatch = document.createElement('button');
        swatch.type = 'button';
        swatch.className = 'layer-color-swatch';
    swatch.title = translate('layersControl.changeLayerColor') || 'Change layer color';
    // ensure visible even if CSS is missing or overridden
    swatch.style.background = initial;
    swatch.style.width = '18px';
    swatch.style.height = '14px';
    swatch.style.borderRadius = '3px';
    swatch.style.border = '1px solid rgba(0,0,0,0.15)';
    swatch.style.marginLeft = '6px';
    swatch.style.verticalAlign = 'middle';
    swatch.style.cursor = 'pointer';
        const stop = (ev) => { ev.stopPropagation(); };
        swatch.addEventListener('click', stop);
        swatch.addEventListener('mousedown', stop);

    const pop = document.createElement('div');
        pop.className = 'layer-color-popover';
    pop.style.display = 'none';
    // basic positioning so popover isn't clipped or invisible
    pop.style.position = 'absolute';
    pop.style.left = '22px';
    pop.style.top = '22px';
    pop.style.width = '260px';
    pop.style.zIndex = '10000';
    pop.style.padding = '8px';
    pop.style.background = 'white';
    pop.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';

        const presetColors = ['#1f78b4','#33a02c','#b2df8a','#fb9a99','#e31a1c','#ff7f00','#6a3d9a','#b15928','#ffff99','#a6cee3','#fdbf6f','#cab2d6'];
        const palette = document.createElement('div');
        palette.className = 'layer-color-palette';
        presetColors.forEach(c => {
            const tile = document.createElement('button');
            tile.type = 'button';
            tile.className = 'layer-color-tile';
            tile.style.background = c;
            tile.title = c;
            tile.addEventListener('click', (ev) => { ev.stopPropagation(); setLayerColor(map, settingsKey, c); swatch.style.background = c; hide(); });
            palette.appendChild(tile);
        });
        pop.appendChild(palette);

        const hexWrap = document.createElement('div');
        hexWrap.className = 'layer-color-hex';
        const hexInput = document.createElement('input');
        hexInput.type = 'text';
        hexInput.placeholder = '#rrggbb';
        hexInput.value = initial;
        hexInput.addEventListener('click', (ev) => ev.stopPropagation());
        hexInput.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') { commitHex(); } });
        const commitHex = () => {
            const v = hexInput.value.trim();
            if (/^#([0-9a-fA-F]{6})$/.test(v)) { setLayerColor(map, settingsKey, v); swatch.style.background = v; hide(); }
        };
        const hexBtn = document.createElement('button');
        hexBtn.type = 'button';
    hexBtn.className = 'tool-inline';
        hexBtn.textContent = translate('layersControl.set') || 'Set';
        hexBtn.addEventListener('click', (ev) => { ev.stopPropagation(); commitHex(); });
        hexWrap.appendChild(hexInput);
        hexWrap.appendChild(hexBtn);
        pop.appendChild(hexWrap);

        // Only the color picker (palette + hex input) is shown in the per-layer popover.

        const docClick = (ev) => { if (!pop.contains(ev.target) && ev.target !== swatch) hide(); };

        const hide = () => {
            pop.style.display = 'none';
            // restore positioning mode
            try { pop.style.position = 'absolute'; } catch (e) {}
            document.removeEventListener('click', docClick);
        };

        const show = () => {
            // Use fixed positioning so we can clamp to the viewport and avoid overflow
            pop.style.position = 'fixed';
            pop.style.display = 'inline-block';
            pop.style.visibility = 'hidden'; // hide while computing placement
            document.addEventListener('click', docClick);

            // measure and compute coordinates
            try {
                const lblRect = label.getBoundingClientRect();
                const popRect = pop.getBoundingClientRect();
                // default: place to the right of the label
                let left = Math.round(lblRect.right + 8);
                // if overflow to the right, flip to left side of the label
                if (left + popRect.width > window.innerWidth - 8) {
                    left = Math.round(lblRect.left - popRect.width - 8);
                    if (left < 8) left = 8; // clamp to small margin
                }
                // vertical: align top of popover with label top, but clamp to viewport
                let top = Math.round(lblRect.top);
                if (top + popRect.height > window.innerHeight - 8) {
                    top = Math.max(8, window.innerHeight - popRect.height - 8);
                }
                pop.style.left = left + 'px';
                pop.style.top = top + 'px';
            } catch (e) {
                // fallback: leave default absolute offsets
                try { pop.style.left = pop.style.left || '22px'; pop.style.top = pop.style.top || '22px'; } catch (e) {}
            }
            pop.style.visibility = 'visible';
        };

        swatch.addEventListener('click', (ev) => { ev.stopPropagation(); if (pop.style.display === 'none') show(); else hide(); });

    // ensure the label can be a positioning context for the popover
    try { if (label && label.style) label.style.position = label.style.position || 'relative'; } catch (e) {}
    label.appendChild(swatch);
    label.appendChild(pop);
    }

    // Add a centralized feature defaults panel at the bottom of the layers control
    try {
        // Insert section headers for Base Map and Boundaries at the top of their lists
        try {
            const baseSection = container.querySelector('.leaflet-control-layers-base');
            if (baseSection && !baseSection.querySelector('.layers-section-header')) {
                const h = document.createElement('div');
                h.className = 'layers-section-header';
                h.textContent = translate('layersControl.baseMap') || 'Base Map';
                h.style.fontWeight = '700';
                h.style.padding = '6px 8px';
                baseSection.insertBefore(h, baseSection.firstChild);
            }
        } catch (e) {}
        try {
            const overlaysSection = container.querySelector('.leaflet-control-layers-overlays');
            if (overlaysSection && !overlaysSection.querySelector('.layers-section-header')) {
                const h2 = document.createElement('div');
                h2.className = 'layers-section-header';
                h2.textContent = translate('layersControl.boundaries') || 'Boundaries';
                h2.style.fontWeight = '700';
                h2.style.padding = '6px 8px';
                overlaysSection.insertBefore(h2, overlaysSection.firstChild);
            }
        } catch (e) {}

        // only add once
        if (!container.querySelector('.layer-feature-defaults')) {
            const wrapper = document.createElement('div');
            wrapper.className = 'layer-feature-defaults';
            wrapper.style.padding = '8px';
            wrapper.style.borderTop = '1px solid rgba(0,0,0,0.08)';
            wrapper.style.fontSize = '12px';

            const title = document.createElement('div');
            title.textContent = translate('layersControl.mapDefaults') || 'Map Defaults';
            title.style.fontWeight = '600';
            title.style.marginBottom = '6px';
            wrapper.appendChild(title);

            const foRow = document.createElement('div');
            foRow.style.display = 'flex';
            foRow.style.alignItems = 'center';
            foRow.style.gap = '8px';
            const foLabel = document.createElement('label');
            foLabel.textContent = translate('layersControl.opacity') || 'Opacity';
            foLabel.style.flex = '1';
            const foInput = document.createElement('input');
            foInput.type = 'range';
            foInput.min = '0';
            foInput.max = '1';
            foInput.step = '0.05';
            foInput.value = '0.7';
            foInput.style.flex = '2';
            foRow.appendChild(foLabel);
            foRow.appendChild(foInput);
            wrapper.appendChild(foRow);

            const bwRow = document.createElement('div');
            bwRow.style.display = 'flex';
            bwRow.style.alignItems = 'center';
            bwRow.style.gap = '8px';
            const bwLabel = document.createElement('label');
            bwLabel.textContent = translate('layersControl.border') || 'Border';
            bwLabel.style.flex = '1';
            const bwInput = document.createElement('input');
            bwInput.type = 'range';
            bwInput.min = '1';
            bwInput.max = '12';
            bwInput.step = '1';
            bwInput.value = '1';
            bwInput.style.flex = '2';
            bwRow.appendChild(bwLabel);
            bwRow.appendChild(bwInput);
            wrapper.appendChild(bwRow);

            // Apply immediately when sliders change (no confirmation button)
            const applyCentralImmediate = async () => {
                try {
                    const fillOpacity = Number(foInput.value);
                    const weight = Number(bwInput.value);
                    const paint = await import('./paint.js');
                    if (paint && typeof paint.setFeatureStyleDefaults === 'function') paint.setFeatureStyleDefaults({ fillOpacity, weight });
                    if (state.geojsonData && Array.isArray(state.geojsonData.features)) {
                        state.geojsonData.features.forEach(f => {
                            if (!f.properties) f.properties = {};
                            f.properties._fillOpacity = fillOpacity;
                            f.properties._weight = weight;
                        });
                    }
                    if (state.geojsonLayer) state.geojsonLayer.eachLayer(l => l.setStyle(paint.style(l.feature)));
                } catch (err) { console.warn('Failed applying feature defaults from layers control', err); }
            };
            foInput.addEventListener('input', () => applyCentralImmediate());
            bwInput.addEventListener('input', () => applyCentralImmediate());

            // Prefer adding into the control's inner form/list so the panel
            // hides when the layers control is collapsed. Fall back to container.
            const inner = container.querySelector('form') || container.querySelector('.leaflet-control-layers-list') || container;
            inner.appendChild(wrapper);
        }
    } catch (e) { /* non-fatal */ }
}
