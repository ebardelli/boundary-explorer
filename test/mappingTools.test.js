import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { setupLeafletStub, teardownLeafletStub } from './helpers/leafletHelper.js';

// Hoist-safe global mocks for state and translate
globalThis.__TEST_STATE__ = globalThis.__TEST_STATE__ || { state: { geojsonData: { features: [] }, map: null, currentTable: null } };

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
  m.featureStyleDefaults = {};
  return m;
});

vi.mock('../app/scripts/i18n.js', () => ({ translate: (k) => k }));
vi.mock('../app/scripts/duckdb.js', () => ({ initDuckDB: vi.fn(), getConnection: async () => ({}), runQuery: async () => [] }));

import { getBlockId, registerToolButton, initMappingTools } from '../app/scripts/mappingTools.js';

beforeEach(() => {
  // reset state
  globalThis.__TEST_STATE__.state.geojsonData = { features: [] };
  globalThis.__TEST_STATE__.state.map = null;
  globalThis.__TEST_STATE__.state.currentTable = null;

  // DOM setup
  const left = document.getElementById('left-column');
  if (left) left.remove();
  const div = document.createElement('div');
  div.id = 'left-column';
  document.body.appendChild(div);

  // remove any pending map-editor-controls
  const existing = document.getElementById('map-editor-controls');
  if (existing) existing.remove();

  teardownLeafletStub();
  vi.clearAllMocks();
});

afterEach(() => {
  teardownLeafletStub();
});

describe('mappingTools.js small helpers', () => {
  it('getBlockId prefers block_of_residence and falls back correctly', () => {
    const f1 = { properties: { block_of_residence: '123' } };
    expect(getBlockId(f1, 5)).toBe('123');

    const f2 = { properties: { GEOID: 'geoid-9' } };
    expect(getBlockId(f2, 7)).toBe('geoid-9');

    const f3 = { id: 'feature-1' };
    expect(getBlockId(f3, 2)).toBe('feature-1');

    const f4 = null;
    expect(getBlockId(f4, 4)).toBe('idx_4');
  });

  it('registerToolButton inserts into DOM if container exists', () => {
    // create the container and row
    const left = document.getElementById('left-column');
    left.innerHTML = `<div class="section"><div id="map-editor-controls"><div class="map-editor-row"></div></div></div>`;

    const btn = document.createElement('button');
    btn.id = 'my-tool';
    registerToolButton(btn);

    const row = document.querySelector('.map-editor-row');
    expect(row.querySelector('#my-tool')).toBeTruthy();
  });

  it('registerToolButton queues when container missing and flushes on initMappingTools', () => {
    // ensure no container present
    const existing = document.getElementById('map-editor-controls');
    if (existing) existing.remove();

    const btn = document.createElement('button');
    btn.id = 'queued-tool';
    registerToolButton(btn, 'import-btn');

    // now initialize mapping tools which will create the container and flush queue
    initMappingTools();

    const found = document.getElementById('queued-tool');
    expect(found).toBeTruthy();
  });

  it('initMappingTools wires up buttons and status elements', () => {
    // Provide a mapping-placeholder to ensure a deterministic insert
    const left = document.getElementById('left-column');
    const placeholder = document.createElement('div');
    placeholder.id = 'mapping-tools-placeholder';
    left.appendChild(placeholder);

    initMappingTools();

    // Controls created
    expect(document.getElementById('map-editor-controls')).toBeTruthy();
    expect(document.getElementById('merge-by-school-btn')).toBeTruthy();
    expect(document.getElementById('merge-status-wrapper')).toBeTruthy();

    // clicking import triggers file input click wiring (file input exists)
    const importBtn = document.getElementById('import-btn');
    const fileInput = document.getElementById('geojson-upload');
    let clicked = false;
    if (fileInput) {
      fileInput.click = () => { clicked = true; };
    }
    importBtn && importBtn.click();
    expect(clicked).toBe(true);
  });
});
