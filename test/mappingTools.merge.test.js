import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupRunQueryMock, applyDuckdbMock, clearRunQueryMock } from './helpers/duckdbHelper.js';

// Hoist-safe state mock setup
beforeEach(() => {
  globalThis.__TEST_STATE__ = globalThis.__TEST_STATE__ || { state: { geojsonData: { features: [] }, map: null, currentTable: null } };
  // minimal features so merge can operate (not strictly used by aggSql which is mocked)
  globalThis.__TEST_STATE__.state.geojsonData = { features: [
    { type: 'Feature', properties: { block_of_residence: 'b1' }, geometry: { type: 'Polygon', coordinates: [[[0,0],[0,1],[1,1],[1,0],[0,0]]] } }
  ] };
  globalThis.__TEST_STATE__.state.currentTable = 'data_table';
  // ensure schools map exists (mergeBySchool preserves metadata)
  globalThis.__TEST_STATE__.state.schools = new Map([['Existing School', { color: '#112233' }]]);
});

describe('mappingTools.mergeBySchool with mocked DuckDB', () => {
  it('returns a merged FeatureCollection and calls finalize/import helpers', async () => {
    vi.resetModules();

    // state mock used by mappingTools
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

    // Setup runQuery to respond to the aggregation and saved stateMap reads
    setupRunQueryMock(async (conn, sql) => {
      const s = String(sql || '').toLowerCase();
      if (s.includes('information_schema.columns')) {
        // pretend the data table has students column so fte/residents default logic isn't broken
        return [{ column_name: 'students' }];
      }
      if (s.includes('st_asgeojson') || s.includes('st_union_agg') || s.includes('group by school')) {
        // Aggregation query returns one school group
        return [{ school: 'Merged School', geojson: JSON.stringify({ type: 'Polygon', coordinates: [[[0,0],[0,1],[1,1],[1,0],[0,0]]] }), students: 42, residents: 10, fte: 5 }];
      }
      if (s.includes('select block_of_residence as block, school from statemap')) {
        // saved state map prior to merge
        return [{ block: 'b1', school: 'Existing School' }];
      }
      // default empty
      return [];
    });
    applyDuckdbMock();

    // Mock importHelpers and paint used by mergeBySchool in a hoist-safe way.
    globalThis.__TEST_IMPORT_HELPERS__ = {
      flushSchools: vi.fn(async () => {}),
      finalizeGeojsonImport: vi.fn(async () => {})
    };
    vi.mock('../app/scripts/importHelpers.js', () => ({
      flushSchools: (...args) => globalThis.__TEST_IMPORT_HELPERS__.flushSchools(...args),
      finalizeGeojsonImport: (...args) => globalThis.__TEST_IMPORT_HELPERS__.finalizeGeojsonImport(...args)
    }));

    globalThis.__TEST_PAINT__ = { loadGeoJSON: vi.fn(async () => {}) };
    vi.mock('../app/scripts/paint.js', () => ({ loadGeoJSON: (...args) => globalThis.__TEST_PAINT__.loadGeoJSON(...args) }));

    // Import module under test after mocks applied
    const mt = await import('../app/scripts/mappingTools.js');

    const out = await mt.mergeBySchool();
    expect(out).toBeTruthy();
    expect(out.type).toBe('FeatureCollection');
    expect(Array.isArray(out.features)).toBe(true);
    expect(out.features.length).toBeGreaterThan(0);

    const feat = out.features[0];
    expect(feat.properties).toBeTruthy();
    expect(feat.properties.school).toBe('Merged School');
    expect(Number(feat.properties.students)).toBe(42);
    expect(Number(feat.properties.fte)).toBe(5);

  // ensure helpers were called to flush and finalize the import
  expect(globalThis.__TEST_IMPORT_HELPERS__.flushSchools).toHaveBeenCalled();
  expect(globalThis.__TEST_IMPORT_HELPERS__.finalizeGeojsonImport).toHaveBeenCalledWith(out);

    // ensure we attempted to restore saved stateMap via updateStateMapBatch on the mocked state
    const stateMod = await import('../app/scripts/state.js');
    expect(stateMod.updateStateMapBatch).toHaveBeenCalled();

    // cleanup global test mocks
    clearRunQueryMock();
    try { delete globalThis.__TEST_IMPORT_HELPERS__; } catch (e) { globalThis.__TEST_IMPORT_HELPERS__ = undefined; }
    try { delete globalThis.__TEST_PAINT__; } catch (e) { globalThis.__TEST_PAINT__ = undefined; }
  });
});
