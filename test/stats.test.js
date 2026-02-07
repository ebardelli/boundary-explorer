import { describe, it, expect, beforeEach, vi } from 'vitest';

// Use globalThis to hold mutable mocks so vi.mock factory (which is hoisted)
// can safely reference them without hitting TDZ.
globalThis.__TEST_STATE__ = globalThis.__TEST_STATE__ || { state: { schools: new Map(), currentTable: null, activeSchools: null, map: null } };
globalThis.__RUN_QUERY__ = globalThis.__RUN_QUERY__ || (async () => []);
globalThis.__GET_CONN__ = globalThis.__GET_CONN__ || (async () => ({}));

vi.mock('../app/scripts/state.js', () => {
  const m = {};
  Object.defineProperty(m, 'state', {
    get() {
      if (!globalThis.__TEST_STATE__) globalThis.__TEST_STATE__ = { state: { schools: new Map(), currentTable: null, activeSchools: null, map: null } };
      return globalThis.__TEST_STATE__.state;
    }
  });
  m.buildStateMap = vi.fn();
  return m;
});

vi.mock('../app/scripts/i18n.js', () => ({
  translate: (k) => k
}));

vi.mock('../app/scripts/duckdb.js', () => ({
  getConnection: (...args) => globalThis.__GET_CONN__(...args),
  runQuery: (...args) => globalThis.__RUN_QUERY__(...args)
}));

// Import the module under test after mocks are declared
import {
  style,
  calculateStatistics,
  calculateFTEStatistics,
  calculateGradeLevelStatistics,
  calculateGradeLevelFTEStatistics,
  showBlockStatistics
} from '../app/scripts/stats.js';

beforeEach(() => {
  // reset state and mocks; mutate the exported mockStateObj.state
  globalThis.__TEST_STATE__.state.schools = new Map();
  globalThis.__TEST_STATE__.state.currentTable = null;
  globalThis.__TEST_STATE__.state.activeSchools = null;
  globalThis.__TEST_STATE__.state.map = null;
  globalThis.__RUN_QUERY__ = vi.fn();
  globalThis.__GET_CONN__ = vi.fn(async () => ({}));
  vi.clearAllMocks();
});

describe('stats.js', () => {
  it('style returns school color when available and default when not', () => {
  globalThis.__TEST_STATE__.state.schools.set('Lincoln', { color: '#112233' });
    const feature = { properties: { school: 'Lincoln' } };
    expect(style(feature).fillColor).toBe('#112233');

    const feature2 = { properties: { school: 'Unknown' } };
    expect(style(feature2).fillColor).toBe('#808080');
  });

  it('calculateStatistics normalizes rows to stats', async () => {
    // no active filter
  globalThis.__TEST_STATE__.state.currentTable = 'elementary';
    // return two rows as the DB would
    globalThis.__RUN_QUERY__.mockResolvedValueOnce([
      { name: 'A School', students: 12, residents: 10, capacity: 20, remaining: -8 },
      { name: 'B School', students: null, residents: 3, capacity: 5, remaining: -5 }
    ]);

    const res = await calculateStatistics();
    expect(Array.isArray(res)).toBe(true);
    const a = res.find(s => s.name === 'A School');
    expect(a.students).toBe(12);
    expect(a.residents).toBe(10);
    expect(a.capacity).toBe(20);
    expect(a.remaining).toBe(-8);

    const b = res.find(s => s.name === 'B School');
    expect(b.students).toBe(0); // null -> 0
    expect(b.residents).toBe(3);
  });

  it('calculateFTEStatistics normalizes fte rows', async () => {
  globalThis.__TEST_STATE__.state.currentTable = 'high';
    globalThis.__RUN_QUERY__.mockResolvedValueOnce([
      { name: 'X', fte_students: 3.2, fte_residents: 2.5, fte_capacity: 4.0, fte_remaining: -0.8 }
    ]);

    const res = await calculateFTEStatistics();
    expect(res.length).toBe(1);
    expect(res[0].students).toBeCloseTo(3.2);
    expect(res[0].residents).toBeCloseTo(2.5);
    expect(res[0].capacity).toBeCloseTo(4.0);
    expect(res[0].remaining).toBeCloseTo(-0.8);
  });

  it('calculateGradeLevelStatistics groups by school and grade', async () => {
    globalThis.__RUN_QUERY__.mockResolvedValueOnce([
      { name: 'Alpha', grade: '0', students: 5 },
      { name: 'Alpha', grade: '1', students: 3 },
      { name: 'Beta', grade: '0', students: 2 }
    ]);

    const res = await calculateGradeLevelStatistics();
    expect(res.length).toBe(2);
    expect(res[0].name).toBe('Alpha');
    expect(res[0].grades['0']).toBe(5);
    expect(res[0].grades['1']).toBe(3);
    expect(res[1].name).toBe('Beta');
    expect(res[1].grades['0']).toBe(2);
  });

  it('calculateGradeLevelFTEStatistics groups and returns fte values', async () => {
    globalThis.__RUN_QUERY__.mockResolvedValueOnce([
      { name: 'Alpha', grade: '0', fte_students: 1.5 },
      { name: 'Alpha', grade: '1', fte_students: 0.5 }
    ]);

    const res = await calculateGradeLevelFTEStatistics();
    expect(res.length).toBe(1);
    expect(res[0].name).toBe('Alpha');
    expect(res[0].grades['0']).toBeCloseTo(1.5);
    expect(res[0].grades['1']).toBeCloseTo(0.5);
  });

  it('showBlockStatistics populates feature modal with assigned school and distances', async () => {
    // prepare DOM elements
    // ensureFeatureModalElements will create elements if missing
    // Provide runQuery responses depending on SQL content
    globalThis.__RUN_QUERY__.mockImplementation(async (connOrSql, maybeSql) => {
      const sql = typeof maybeSql === 'string' ? maybeSql : connOrSql;
      if (/FROM data.block_statistics/i.test(sql)) return [{ students: 7, residents: 4 }];
      if (/FROM stateMap/i.test(sql)) return [{ school: 'Z School' }];
      // the real query divides driving_distance by 1609.344 and returns miles,
      // so our mock should return the value already in miles
      if (/FROM data.distances/i.test(sql)) return [{ distance: 1.23, driving_distance: 1.25, driving_time: 2.5 }];
      return [];
    });

    const feature = { properties: { block_of_residence: 'B-100' } };
    await showBlockStatistics(feature);

    const content = document.getElementById('feature-stats-content');
    expect(content).toBeTruthy();
    const html = content.innerHTML;
    expect(html).toContain('Z School');
    expect(html).toContain('7'); // students
    expect(html).toContain('4'); // residents
    // distance formatted with two decimals
    expect(html).toContain('1.23');
    // driving distance (miles) shown
    expect(html).toContain('1.25') || expect(html).toContain('1.25');
  });
});
