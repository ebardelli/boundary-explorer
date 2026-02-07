import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the duckdb module before importing the state module so the module
// under test picks up the mocked functions.
const runQueryMock = vi.fn(async (...args) => []);
const upsertRowsMock = vi.fn(async (...args) => {});

vi.mock('../app/scripts/duckdb.js', () => ({
  runQuery: (...args) => runQueryMock(...args),
  upsertRows: (...args) => upsertRowsMock(...args)
}));

import * as stateMod from '../app/scripts/state.js';

describe('state.js', () => {
  beforeEach(() => {
    runQueryMock.mockClear();
    upsertRowsMock.mockClear();
    // reset in-memory state to defaults
    stateMod.state.geojsonData = null;
    stateMod.state.geojsonLayer = null;
    stateMod.state.currentTable = null;
    stateMod.state.currentMap = null;
    stateMod.state.schools.clear();
    stateMod.state.activeSchools.clear();
    stateMod.state.markers.clear && stateMod.state.markers.clear();
    stateMod.state.currentSchool = null;
  });

  it('setCurrentTable updates state and dispatches event', () => {
    const listener = vi.fn();
    window.addEventListener('stateTableChanged', (e) => listener(e.detail.table));
    stateMod.setCurrentTable('elementary');
    expect(stateMod.state.currentTable).toBe('elementary');
    expect(listener).toHaveBeenCalledWith('elementary');
  });

  it('replaceStateMap upserts features from state.geojsonData', async () => {
    stateMod.state.geojsonData = {
      features: [
        { properties: { block_of_residence: 'B1', school: 'S1' } },
        { properties: { GEOID20: 'B2', school: 'S2' } }
      ]
    };

    await stateMod.replaceStateMap({});

    // Expect upsertRows to have been called at least once for stateMap
    expect(upsertRowsMock).toHaveBeenCalled();
    const callArgs = upsertRowsMock.mock.calls[0];
    // signature: (conn, tableName, rows, key)
    expect(callArgs[1]).toBe('stateMap');
    expect(Array.isArray(callArgs[2])).toBe(true);
    const formattedRow = callArgs[2][0];
    expect(formattedRow).toHaveProperty('block_of_residence');
  });

  it('replaceStateSchools writes state.schools into stateSchool table', async () => {
    // populate state.schools with one entry
    stateMod.state.schools.set('Alpha School', { latitude: 10.1, longitude: -122.5, color: '#112233', capacity: 200, fte: 150 });

    // run replaceStateSchools with a mock connection
    await stateMod.replaceStateSchools({});

    // upsertRows should be called for 'stateSchool'
    expect(upsertRowsMock).toHaveBeenCalled();
    // find a call where second arg is 'stateSchool'
    const stateSchoolCall = upsertRowsMock.mock.calls.find(c => c[1] === 'stateSchool');
    expect(stateSchoolCall).toBeTruthy();
    const rowsArg = stateSchoolCall[2];
    expect(Array.isArray(rowsArg)).toBe(true);
    // find our school row
    const found = rowsArg.find(r => r.name === 'Alpha School');
    expect(found).toBeTruthy();
    expect(found.latitude).toBeCloseTo(10.1);
    expect(found.color).toBe('#112233');
    expect(found.fte_capacity).toBe(150);
  });
});
