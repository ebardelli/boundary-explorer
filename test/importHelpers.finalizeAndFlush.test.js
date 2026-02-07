import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock utils to provide deterministic getRandomColor
vi.mock('../app/scripts/utils.js', () => ({ getRandomColor: () => '#112233' }));

// Prepare hoist-safe module mocks for UI modules imported dynamically by importHelpers
const mockSchools = { updateSchoolList: vi.fn(), loadSchools: vi.fn() };
vi.mock('../app/scripts/schools.js', () => mockSchools);
const mockPaint = { refreshStyles: vi.fn(), loadGeoJSON: vi.fn() };
vi.mock('../app/scripts/paint.js', () => mockPaint);
const mockStats = { calculateStatistics: vi.fn() };
vi.mock('../app/scripts/stats.js', () => mockStats);

// lightweight duckdb mock so dynamic import doesn't throw; operations are no-ops
vi.mock('../app/scripts/duckdb.js', () => ({ getConnection: async () => ({}), runQuery: async () => [] }));

import { finalizeGeojsonImport, flushSchools } from '../app/scripts/importHelpers.js';
import { state } from '../app/scripts/state.js';

describe('importHelpers.finalizeGeojsonImport', () => {
  beforeEach(() => {
    // reset state maps and UI mocks
    state.schools.clear();
    state.activeSchools.clear();
    state.markers.clear && state.markers.clear();
    state.currentSchool = null;
    mockSchools.updateSchoolList.mockReset();
    mockPaint.refreshStyles.mockReset();
    mockStats.calculateStatistics.mockReset();
  });

  it('registers active schools from features and merges properties.schools metadata', async () => {
    // create a geojson with two features and top-level properties.schools metadata
    const geojson = {
      type: 'FeatureCollection',
      properties: {
        schools: {
          'Alpha School': { color: '#00FF00', capacity: 120, latitude: 38.0, longitude: -122.0 },
          'Beta School': '#FF00FF'
        }
      },
      features: [
        { type: 'Feature', properties: { school: 'Alpha School', block_of_residence: 'b1' }, geometry: null },
        { type: 'Feature', properties: { school: 'Beta School', block_of_residence: 'b2' }, geometry: null }
      ]
    };

    await finalizeGeojsonImport(geojson);

    // both schools should be registered and active
    expect(state.schools.has('Alpha School')).toBe(true);
    expect(state.schools.has('Beta School')).toBe(true);
    expect(state.activeSchools.has('Alpha School')).toBe(true);
    expect(state.activeSchools.has('Beta School')).toBe(true);

    // metadata from properties.schools should have been merged
    const a = state.schools.get('Alpha School');
    expect(a.color).toBe('#00FF00');
    expect(Number(a.capacity)).toBe(120);
    expect(Number(a.latitude)).toBe(38.0);
    expect(Number(a.longitude)).toBe(-122.0);

    const b = state.schools.get('Beta School');
    expect(b.color).toBe('#FF00FF');

    // ensure UI refresh functions were triggered
    expect(mockSchools.updateSchoolList).toHaveBeenCalled();
    expect(mockPaint.refreshStyles).toHaveBeenCalled();
    expect(mockStats.calculateStatistics).toHaveBeenCalled();
  });
});

describe('importHelpers.flushSchools', () => {
  beforeEach(() => {
    // populate state with markers, schools and active schools
    state.schools.clear();
    state.activeSchools.clear();
    state.markers = new Map();
    const marker = {};
    state.markers.set('m1', marker);
    state.schools.set('S', { color: '#000' });
    state.activeSchools.add('S');

    // mock map removeLayer behavior
    state.map = { hasLayer: () => true, removeLayer: vi.fn() };

    mockSchools.updateSchoolList.mockReset();
    mockPaint.refreshStyles.mockReset();
    mockStats.calculateStatistics.mockReset();
    mockSchools.loadSchools.mockReset();
  });

  it('clears state and does not reload defaults when reloadDefaults=false', async () => {
    await flushSchools({ reloadDefaults: false });

    expect(state.markers.size).toBe(0);
    expect(state.schools.size).toBe(0);
    expect(state.activeSchools.size).toBe(0);
    expect(state.currentSchool).toBe(null);

    // since reloadDefaults=false, loadSchools should not be called but updateSchoolList should be
    expect(mockSchools.loadSchools).not.toHaveBeenCalled();
    expect(mockSchools.updateSchoolList).toHaveBeenCalled();

    // visuals and stats should have been refreshed
    expect(mockPaint.refreshStyles).toHaveBeenCalled();
    expect(mockStats.calculateStatistics).toHaveBeenCalled();
  });
});
