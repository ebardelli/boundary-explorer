import { vi } from 'vitest';

// Provide a simple local stub for the browser DuckDB loader that in the
// app uses a remote ESM URL. Tests run in Node and cannot import remote
// ESM URLs, so we mock the module to avoid the loader error.
vi.mock('../app/scripts/duckdb.js', () => ({
  getConnection: async () => ({}),
  runQuery: async (..._args) => [],
  upsertRows: async (..._args) => undefined,
  // export any other helpers the code may import
  buildConnection: async () => ({})
}));
