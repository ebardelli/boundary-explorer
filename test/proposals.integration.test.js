import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import duckdb from 'duckdb';

// Integration test: open the on-disk DuckDB database used by the app
// and verify that every block_of_residence referenced by proposal GeoJSON
// features exists in at least one table in the `data` schema that contains
// a `block_of_residence` column (commonly `block_statistics`).

function findProposalFiles(rootDirs = ['app/proposals']) {
  const out = [];
  for (const d of rootDirs) {
    const full = path.resolve(process.cwd(), d);
    if (!fs.existsSync(full)) continue;
    const entries = fs.readdirSync(full, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isFile() && ent.name.toLowerCase().endsWith('.geojson')) {
        out.push(path.join(full, ent.name));
      } else if (ent.isDirectory()) {
        // scan recursive
        const walker = (dir) => {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walker(p);
            else if (e.isFile() && e.name.toLowerCase().endsWith('.geojson')) out.push(p);
          }
        };
        walker(path.join(full, ent.name));
      }
    }
  }
  return out;
}

function extractBlockIdsFromFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return { error: e.message, ids: [] }; }
  const features = parsed && parsed.features && Array.isArray(parsed.features) ? parsed.features : [];
  const ids = new Set();
  for (const f of features) {
    const props = f && f.properties ? f.properties : {};
    const id = props.block_of_residence || props.GEOID20 || props.block || props.geoid;
    if (id) ids.add(String(id));
  }
  return { ids: Array.from(ids), error: null };
}

async function getTablesWithBlockColumn(conn) {
  // Query information_schema to find tables in schema `data` with a block_of_residence column
  const rows = await new Promise((resolve, reject) => {
    conn.all("SELECT table_schema, table_name, column_name FROM information_schema.columns WHERE column_name = 'block_of_residence' AND table_schema = 'data';", (err, res) => {
      if (err) reject(err);
      else resolve(res || []);
    });
  });
  return rows.map(r => r.table_name);
}

async function blockExistsInTable(conn, table, blockId) {
  const sql = `SELECT 1 FROM data.${table} WHERE block_of_residence = $1 LIMIT 1;`;
  return new Promise((resolve, reject) => {
    // duckdb node driver exposes `all` which returns rows array
    conn.all(sql, [blockId], (err, rows) => {
      if (err) return reject(err);
      resolve(Array.isArray(rows) && rows.length > 0);
    });
  });
}

describe('proposals vs data.duckdb (integration)', () => {
  it('every block_of_residence referenced by proposals exists in data.* tables', async () => {
    // open the on-disk database used by the browser app
    const dbPath = path.resolve(process.cwd(), 'app/duckdb/data.duckdb');
    if (!fs.existsSync(dbPath)) {
      throw new Error(`data.duckdb not found at ${dbPath}. Ensure the file exists before running integration tests.`);
    }

    const db = new duckdb.Database(dbPath);
    const conn = db.connect();

    // find candidate tables that contain block_of_residence
    const tables = await getTablesWithBlockColumn(conn);
    if (!tables || tables.length === 0) {
      // fallback: if no information_schema result, assume common table 'block_statistics'
      tables.push('block_statistics');
    }

    const files = findProposalFiles();
    const missingByFile = {};

    for (const f of files) {
      const { ids, error } = extractBlockIdsFromFile(f);
      if (error) {
        missingByFile[f] = { error, missing: [] };
        continue;
      }

      const missing = [];
      for (const id of ids) {
        let found = false;
        for (const t of tables) {
          // eslint-disable-next-line no-await-in-loop
          const exists = await blockExistsInTable(conn, t, id);
          if (exists) { found = true; break; }
        }
        if (!found) missing.push(id);
      }
      if (missing.length) missingByFile[f] = { error: null, missing };
    }

    // cleanup
    try { conn.close(); } catch (e) {}
    try { db.close(); } catch (e) {}

    const filesWithMissing = Object.keys(missingByFile).filter(k => missingByFile[k].missing && missingByFile[k].missing.length);
    if (filesWithMissing.length) {
      const lines = [
        'Found proposal files referencing block ids not present in data.duckdb:',
      ];
      for (const k of filesWithMissing) {
        lines.push(`${k}: ${missingByFile[k].missing.length} missing (example: ${missingByFile[k].missing.slice(0,5).join(', ')})`);
      }
      lines.push('Run a local check or inspect the DB to reconcile these blocks.');
      throw new Error(lines.join('\n'));
    }

    // if we get here, all is good
    expect(Object.keys(missingByFile).length).toBe(0);
  }, 120000);
});
