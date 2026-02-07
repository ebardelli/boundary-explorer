import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupLeafletStub, teardownLeafletStub } from './helpers/leafletHelper.js';

// Hoist-safe state mock
globalThis.__TEST_STATE__ = globalThis.__TEST_STATE__ || { state: { geojsonData: null, geojsonLayer: null, currentMap: null, currentTable: null, schools: new Map(), currentSchool: null, mode: 'none', markers: new Map(), activeSchools: new Set(), map: { addLayer: vi.fn(), removeLayer: vi.fn(), fitBounds: vi.fn(), customLayers: {}, layerControl: null } } };

vi.mock('../app/scripts/state.js', () => {
  const m = {};
  Object.defineProperty(m, 'state', { get() { return globalThis.__TEST_STATE__.state; } });
  m.replaceStateMap = vi.fn();
  m.updateStateMapRow = vi.fn();
  m.featureStyleDefaults = { fillOpacity: 0.7, weight: 1, strokeOpacity: 1 };
  return m;
});

vi.mock('../app/scripts/stats.js', () => ({ style: () => ({}), showBlockStatistics: vi.fn(), calculateStatistics: vi.fn() }));
vi.mock('../app/scripts/duckdb.js', () => ({ getConnection: async () => ({}), runQuery: async () => [] }));

import { style, loadGeoJSON, paintBlock, paintFeature, eraseFeature, refreshStyles, setFeatureStyleDefaults } from '../app/scripts/paint.js';
import { state } from '../app/scripts/state.js';

beforeEach(() => {
  teardownLeafletStub();
  setupLeafletStub();
  // reset state
  state.geojsonData = null;
  state.geojsonLayer = null;
  state.schools = new Map();
  state.currentSchool = null;
  state.map = { addLayer: vi.fn(), removeLayer: vi.fn(), fitBounds: vi.fn(), customLayers: {}, hasLayer: () => false };
});

afterEach(() => {
  teardownLeafletStub();
});

describe('paint.js', () => {
  it('style uses school color and defaults', () => {
    state.schools.set('S1', { color: '#123456' });
    const feature = { properties: { school: 'S1' } };
    const s = style(feature);
    expect(s.fillColor).toBe('#123456');
    expect(s.fillOpacity).toBe(0.7);
  });

  it('loadGeoJSON applies defaults and attaches layer', async () => {
    const geo = { type: 'FeatureCollection', features: [ { type: 'Feature', geometry: { type: 'Polygon', coordinates: [] }, properties: {} } ], properties: { schools: { A: { color: '#AAA', latitude: 0, longitude: 0, capacity: 10 } } } };
    await loadGeoJSON(geo);
    expect(state.geojsonData).toBeTruthy();
    expect(state.schools.has('A')).toBe(true);
    expect(state.geojsonLayer).toBeTruthy();
  });

  it('paintFeature assigns school and calls setStyle', () => {
    const feature = { properties: { block_of_residence: 'B1' } };
    const layer = { setStyle: vi.fn() };
    state.currentSchool = 'S2';
    paintFeature('S2', feature, layer);
    expect(feature.properties.school).toBe('S2');
    expect(layer.setStyle).toHaveBeenCalled();
  });

  it('paintBlock updates matching layer and persists mapping', async () => {
    // Use duckdb helper to capture SQL emitted by upsertRows via runQuery
    const { setupRunQueryMock, applyDuckdbMock, clearRunQueryMock } = await import('./helpers/duckdbHelper.js');
    // capture SQL strings passed to runQuery
    const captured = [];
    setupRunQueryMock((conn, sql) => {
      if (typeof sql === 'string') captured.push(sql);
      return [];
    });
    applyDuckdbMock();

    // reset modules so the duckdb mock is used by state/paint modules
    // Unmock the top-level state mock so we can import the real state module
    vi.unmock('../app/scripts/state.js');
    vi.resetModules();
    const { state: freshState } = await import('../app/scripts/state.js');
    const paintMod = await import('../app/scripts/paint.js');

    // two layers, only second matches the block id
    const layer1 = { feature: { properties: { block_of_residence: 'B100' } }, setStyle: vi.fn() };
    const layer2 = { feature: { properties: { block_of_residence: 'B200' } }, setStyle: vi.fn() };
    freshState.geojsonLayer = { eachLayer: (cb) => { cb(layer1); cb(layer2); } };

    // call paintBlock to update B200
    paintMod.paintBlock('NewSchool', 'B200');

    // wait for the async IIFE to run
    await new Promise(r => setTimeout(r, 10));

    expect(layer2.feature.properties.school).toBe('NewSchool');
    expect(layer2.setStyle).toHaveBeenCalled();

  // ensure the emitted SQL contains the painted block id
  const containsBlock = captured.find(s => String(s).includes("'B200'") || String(s).includes('B200'));
  expect(containsBlock).toBeTruthy();

    clearRunQueryMock();
  });

  it('eraseFeature clears school and calls setStyle', () => {
    const feature = { properties: { block_of_residence: 'B1', school: 'S2' } };
    const layer = { setStyle: vi.fn() };
    eraseFeature(feature, layer);
    expect(feature.properties.school).toBeNull();
    expect(layer.setStyle).toHaveBeenCalled();
  });

  it('refreshStyles iterates layers and applies style', () => {
    // simulate geojsonLayer with two layers
    const layer1 = { feature: { properties: { school: null } }, setStyle: vi.fn() };
    const layer2 = { feature: { properties: { school: 'Sx' } }, setStyle: vi.fn() };
    state.geojsonLayer = { eachLayer: (cb) => { cb(layer1); cb(layer2); } };
    refreshStyles();
    expect(layer1.setStyle).toHaveBeenCalled();
    expect(layer2.setStyle).toHaveBeenCalled();
  });

  it('setFeatureStyleDefaults updates defaults', () => {
    setFeatureStyleDefaults({ fillOpacity: 0.5, weight: 2, strokeOpacity: 0.8 });
    const f = { properties: {} };
    // style function will use updated defaults
    const s = style(f);
    expect(s.fillOpacity).toBe(0.5);
    expect(s.weight).toBe(2);
    expect(s.opacity).toBe(0.8);
  });

  it('paintFeature persists mapping via upsert SQL', async () => {
    const { setupRunQueryMock, applyDuckdbMock, clearRunQueryMock } = await import('./helpers/duckdbHelper.js');
    const captured = [];
    setupRunQueryMock((conn, sql) => { if (typeof sql === 'string') captured.push(sql); return []; });
    applyDuckdbMock();
    vi.resetModules();
    const { state: freshState } = await import('../app/scripts/state.js');
    const paintMod = await import('../app/scripts/paint.js');

    // prepare feature and layer
    const feature = { properties: { block_of_residence: 'PB1' } };
    const layer = { setStyle: vi.fn() };
    freshState.currentSchool = 'Sx';

    paintMod.paintFeature('Sx', feature, layer);
    await new Promise(r => setTimeout(r, 10));

  const sql = captured.find(s => typeof s === 'string' && (/INSERT INTO\s+statemap/i.test(s) || /ON CONFLICT/i.test(s) || /INSERT INTO\s+stateschool/i.test(s)));
  expect(sql, `captured SQL: ${JSON.stringify(captured)}`).toBeTruthy();
  expect(sql.toUpperCase()).toContain("ON CONFLICT");
  expect(sql).toContain("'PB1'");

    clearRunQueryMock();
  });

  it('eraseFeature persists null mapping via upsert SQL', async () => {
    const { setupRunQueryMock, applyDuckdbMock, clearRunQueryMock } = await import('./helpers/duckdbHelper.js');
    const captured = [];
    setupRunQueryMock((conn, sql) => { if (typeof sql === 'string') captured.push(sql); return []; });
    applyDuckdbMock();
    vi.resetModules();
    const { state: freshState } = await import('../app/scripts/state.js');
    const paintMod = await import('../app/scripts/paint.js');

    const feature = { properties: { block_of_residence: 'PB2', school: 'Sx' } };
    const layer = { setStyle: vi.fn() };

    paintMod.eraseFeature(feature, layer);
    await new Promise(r => setTimeout(r, 10));

  const sql = captured.find(s => typeof s === 'string' && (/INSERT INTO\s+statemap/i.test(s) || /ON CONFLICT/i.test(s) || /INSERT INTO\s+stateschool/i.test(s)));
  expect(sql, `captured SQL: ${JSON.stringify(captured)}`).toBeTruthy();
  expect(sql.toUpperCase()).toContain("ON CONFLICT");
  // when erasing, state.updateStateMapRow serializes null school as empty string
  expect(sql).toContain("''");

    clearRunQueryMock();
  });
});
