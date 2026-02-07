import { vi } from 'vitest';

export function setupLeafletStub() {
  // Minimal Leaflet stubs used across tests
  globalThis.L = globalThis.L || {};

  globalThis.L.divIcon = globalThis.L.divIcon || ((opts) => ({ _divIcon: true, opts }));

  globalThis.L.marker = globalThis.L.marker || ((coords, opts) => {
    const marker = {
      coords,
      opts,
      bindPopup: vi.fn(),
      addTo(map) { this._map = map; if (map && typeof map.addLayer === 'function') map.addLayer(this); return this; },
      remove: vi.fn()
    };
    return marker;
  });

  globalThis.L.geoJSON = globalThis.L.geoJSON || ((data, opts) => {
    // create per-feature mocked layer objects
    const features = (data && data.features) ? data.features : [];
    const layers = features.map((f, idx) => ({ feature: f, setStyle: vi.fn(), on: vi.fn(), getElement: () => null }));

    const layerGroup = {
      _layers: layers,
      addTo(map) { this._map = map; if (map && typeof map.addLayer === 'function') map.addLayer(this); return this; },
      eachLayer(cb) { this._layers.forEach(cb); },
      getBounds() { return { _bounds: true }; },
      toGeoJSON() { return data; }
    };
    return layerGroup;
  });
}

export function teardownLeafletStub() {
  try { delete globalThis.L; } catch (e) { globalThis.L = undefined; }
}
