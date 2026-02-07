import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupRunQueryMock, applyDuckdbMock, clearRunQueryMock } from './helpers/duckdbHelper.js';

// This test dynamically resets modules and re-mocks duckdb to provide
// SQL-aware responses so we can validate paintByLayer's DB interactions.

beforeEach(() => {
  // ensure global hoist-safe state holder
  globalThis.__TEST_STATE__ = globalThis.__TEST_STATE__ || { state: { geojsonData: { features: [] }, map: null, currentTable: null } };
  // reset state features
  globalThis.__TEST_STATE__.state.geojsonData = { features: [
    { type: 'Feature', properties: { block_of_residence: 'b1' }, geometry: { type: 'Polygon', coordinates: [[[0,0],[0,1],[1,1],[1,0],[0,0]]] } },
    { type: 'Feature', properties: { block_of_residence: 'b2' }, geometry: { type: 'Polygon', coordinates: [[[0,0],[0,2],[2,2],[2,0],[0,0]]] } }
  ] };

  // minimal map with one overlay selected
  const layer = {
    toGeoJSON: () => ({ type: 'FeatureCollection', features: [ { type: 'Feature', properties: { Name: 'Overlay Feature' }, geometry: { type: 'Polygon', coordinates: [[[0,0],[0,1],[1,1],[1,0],[0,0]]] } } ] }),
  };
  const map = {
    customLayers: { overlays: { 'Overlay1': layer } },
    hasLayer: () => true,
    addLayer: () => {},
  };
  globalThis.__TEST_STATE__.state.map = map;
  globalThis.__TEST_STATE__.state.currentTable = 'some_table';
  // ensure schools map exists for importHelpers.registerSchoolNames
  globalThis.__TEST_STATE__.state.schools = new Map();
});

describe('mappingTools paintByLayer with mocked DuckDB', () => {
  it('loads overlay features into DuckDB, computes matches and assigns schools', async () => {
    // reset module registry so dynamic mocks take effect
    vi.resetModules();

    // hoist-safe state mock
    vi.mock('../app/scripts/state.js', () => {
      const m = {};
      Object.defineProperty(m, 'state', {
        get() {
          if (!globalThis.__TEST_STATE__) globalThis.__TEST_STATE__ = { state: { geojsonData: { features: [] }, map: null, currentTable: null } };
          return globalThis.__TEST_STATE__.state;
        }
      });
      m.updateStateMapBatch = vi.fn();
      m.updateStateMapRow = vi.fn();
      m.setCurrentTable = vi.fn();
      return m;
    });

    vi.mock('../app/scripts/i18n.js', () => ({ translate: (k) => k }));

    // use shared duckdb helper to set the runQuery mock and apply the duckdb vi.mock
    setupRunQueryMock(async (conn, sql) => {
      const s = String(sql || '').toLowerCase();
      if (s.includes('select distinct layer_name from __layers_raw')) return [{ layer_name: 'Overlay1' }];
      if (s.includes("select distinct layer_name as name from __layers_raw") || s.includes("select distinct part_name as name from __parts")) return [{ name: 'Overlay1' }];
      if (s.includes('select id, part_name from __matches where rn = 1') || s.includes('select id, part_name from __matches')) return [{ id: 'b1', part_name: 'Overlay1' }];
      if (s.includes('select id, school from __feats')) return [{ id: 'b1', school: 'Overlay1' }, { id: 'b2', school: 'Overlay1' }];
      return [];
    });
    applyDuckdbMock();

    // paint module used by mappingTools; mock refreshStyles so it's callable
    vi.mock('../app/scripts/paint.js', () => ({ refreshStyles: vi.fn() }));

    // import mappingTools with our dynamic mocks in place
    const mt = await import('../app/scripts/mappingTools.js');

    // call paintByLayer and assert results
    const status = { textContent: '' };
    const res = await mt.paintByLayer(status);
    expect(res).toBeTruthy();
    expect(res.layersUsed).toBe(1);

    // both features should have been assigned 'Overlay1'
    const feats = globalThis.__TEST_STATE__.state.geojsonData.features;
    expect(feats[0].properties.school).toBe('Overlay1');
    expect(feats[1].properties.school).toBe('Overlay1');

    // runQuery (hoist-safe) should have been called at least a few times (load, insert, select)
    expect(globalThis.__TEST_RUN_QUERY__.mock.calls.length).toBeGreaterThan(3);
    clearRunQueryMock();
  });
});
