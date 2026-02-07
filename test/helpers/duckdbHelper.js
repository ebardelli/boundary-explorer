import { vi } from 'vitest';

// Setup a hoist-safe runQuery mock attached to globalThis and provide a
// vi.mock for the duckdb module that delegates to the global mock. Tests
// should call setupRunQueryMock(fn) before importing modules that import
// duckdb.js.

export function setupRunQueryMock(fn) {
  // attach to globalThis so vi.mock factories can safely reference it
  globalThis.__TEST_RUN_QUERY__ = vi.fn(fn);
}

export function clearRunQueryMock() {
  try { delete globalThis.__TEST_RUN_QUERY__; } catch (e) { globalThis.__TEST_RUN_QUERY__ = undefined; }
}

export function applyDuckdbMock() {
  vi.mock('../../app/scripts/duckdb.js', () => ({
    initDuckDB: vi.fn(),
    getConnection: async () => ({}),
    runQuery: (...args) => globalThis.__TEST_RUN_QUERY__ && globalThis.__TEST_RUN_QUERY__(...args),
    // Provide an upsertRows shim that mirrors production SQL generation so
    // tests can assert the emitted UPSERT/INSERT statements precisely.
    upsertRows: async (conn, tableName, rows, keyCols = ['id']) => {
      if (!tableName || !rows) return;
      const rowArr = Array.isArray(rows) ? rows : [rows];
      if (rowArr.length === 0) return;

      // collect union of keys across all rows
      const colsSet = new Set();
      rowArr.forEach(r => { Object.keys(r || {}).forEach(k => colsSet.add(String(k))); });
      const columns = Array.from(colsSet);
      if (columns.length === 0) return;

      const keys = Array.isArray(keyCols) ? keyCols.map(String) : [String(keyCols)];

      const serialize = (v) => {
        if (v === null || v === undefined) return 'NULL';
        if (typeof v === 'number' || typeof v === 'bigint') return String(v);
        if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
        return `'${String(v).replace(/'/g, "''")}'`;
      };

      const valuesSql = rowArr.map(r => `(${columns.map(c => serialize(r[c])).join(',')})`).join(',');
      const colsSql = columns.map(c => c.replace(/[^a-zA-Z0-9_]/g, '')).join(',');

      // Prepare ON CONFLICT clause when possible
      const nonKeyCols = columns.filter(c => !keys.includes(c));
      let insertSql = `INSERT INTO ${String(tableName).replace(/[^a-zA-Z0-9_]/g, '')} (${colsSql}) VALUES ${valuesSql}`;
      if (keys && keys.length > 0 && nonKeyCols.length > 0) {
        const keysSql = keys.map(k => k.replace(/[^a-zA-Z0-9_]/g, '')).join(',');
        const updateSql = nonKeyCols.map(c => `${c.replace(/[^a-zA-Z0-9_]/g, '')} = EXCLUDED.${c.replace(/[^a-zA-Z0-9_]/g, '')}`).join(', ');
        insertSql = `${insertSql} ON CONFLICT (${keysSql}) DO UPDATE SET ${updateSql};`;
      } else {
        insertSql = `${insertSql};`;
      }

      return globalThis.__TEST_RUN_QUERY__ && globalThis.__TEST_RUN_QUERY__(null, insertSql);
    },
    ensureFeatsView: vi.fn()
  }));
}
