import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { setupLeafletStub, teardownLeafletStub } from './helpers/leafletHelper.js';

// Hoist-safe global mocks
globalThis.__TEST_STATE__ = globalThis.__TEST_STATE__ || { state: { schools: new Map(), currentSchool: null, activeSchools: new Set(), markers: new Map(), map: null } };

vi.mock('../app/scripts/state.js', () => {
  const m = {};
  Object.defineProperty(m, 'state', {
    get() {
      if (!globalThis.__TEST_STATE__) globalThis.__TEST_STATE__ = { state: { schools: new Map(), currentSchool: null, activeSchools: new Set(), markers: new Map(), map: null } };
      return globalThis.__TEST_STATE__.state;
    }
  });
  m.replaceStateSchools = vi.fn();
  m.buildStateMap = vi.fn();
  return m;
});

vi.mock('../app/scripts/i18n.js', () => ({ translate: (k) => k }));
vi.mock('../app/scripts/paint.js', () => ({ style: () => ({}), refreshStyles: vi.fn() }));
vi.mock('../app/scripts/editor.js', () => ({ createEditButtonAndModal: vi.fn() }));
vi.mock('../app/scripts/duckdb.js', () => ({ getConnection: async () => ({}), runQuery: async () => [] }));

import { getSchoolType, createSchoolMarker, loadSchools, updateSchoolList } from '../app/scripts/schools.js';

beforeEach(() => {
  // reset state
  globalThis.__TEST_STATE__.state.schools = new Map();
  globalThis.__TEST_STATE__.state.currentSchool = null;
  globalThis.__TEST_STATE__.state.activeSchools = new Set();
  globalThis.__TEST_STATE__.state.markers = new Map();
  globalThis.__TEST_STATE__.state.map = null;

  // ensure DOM container exists
  let el = document.getElementById('school-list');
  if (el) el.remove();
  const div = document.createElement('div');
  div.id = 'school-list';
  document.body.appendChild(div);

  // reset global L and fetch
  teardownLeafletStub();
  globalThis.fetch = undefined;
  vi.clearAllMocks();
});

afterEach(() => {
  teardownLeafletStub();
});

describe('schools.js', () => {
  it('getSchoolType returns correct type', () => {
    expect(getSchoolType('Lincoln Elementary')).toBe('elementary');
    expect(getSchoolType('Roosevelt Middle')).toBe('middle');
    expect(getSchoolType('Santa Rosa High School')).toBe('high');
    expect(getSchoolType('Some Other School')).toBe('other');
  });

  it('createSchoolMarker returns null when no lat/lon present', () => {
    const res = createSchoolMarker('NoCoords', {});
    expect(res).toBeNull();
  });

  it('createSchoolMarker returns a marker object when L is available', () => {
    setupLeafletStub();

    const data = { latitude: 10.5, longitude: -122.3, color: '#112233' };
    const marker = createSchoolMarker('Test School', data);
    expect(marker).toBeTruthy();
    expect(typeof marker.bindPopup).toBe('function');
    expect(marker.coords).toEqual([10.5, -122.3]);
  });

  it('loadSchools fetches and populates state.schools and updates DOM', async () => {
    // mock fetch response
    const sample = [ { name: 'Loaded School', latitude: 1.23, longitude: -4.56, capacity: 50, color: '#ABCDEF' } ];
    globalThis.fetch = vi.fn(async (url) => ({
      ok: true,
      headers: { get: (k) => 'application/json' },
      json: async () => sample
    }));

    // ensure updateSchoolList runs using our DOM
  setupLeafletStub();
  await loadSchools();

    const has = globalThis.__TEST_STATE__.state.schools.has('Loaded School');
    expect(has).toBe(true);
    const entry = globalThis.__TEST_STATE__.state.schools.get('Loaded School');
    expect(entry.color).toBe('#ABCDEF');

    const html = document.getElementById('school-list').textContent || '';
    expect(html).toContain('Loaded School');
  });
});
