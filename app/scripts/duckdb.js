// Load duckdb-wasm ESM from local vendor copy if available, otherwise fall
// back to the original CDN. This lets the app run fully offline when the
// `vendor/@duckdb/duckdb-wasm` files are present.
let _duckdbModule = null;
export function duckdbModule() { return _duckdbModule; }

// Centralized DuckDB + spatial initialization for browser modules.
// Usage:
//   import { getConnection, closeDB } from './duckdb.js';
//   const conn = await getConnection();
//   await conn.query('load spatial;');

let cached = {
    db: null,
    conn: null,
    worker: null,
    bundle: null
};

// Promise used to serialize full initialization (instantiate + connect).
// Promise used to serialize attach operations to avoid Unique file handle conflicts.
cached.initPromise = null;
cached.attachPromise = null;
cached.attached = false;

export async function initDuckDB(opts = {}) {
    // opts: { forceLocal: boolean }
    // opts: { forceLocal: boolean, attachDataUrl?: string, skipAttach?: boolean }
    const { forceLocal = false, attachDataUrl = null, skipAttach = false } = opts;
    if (cached.db && cached.conn) return { db: cached.db, conn: cached.conn };

    // If another call is already running initialization, wait for it to finish
    if (cached.initPromise) {
        await cached.initPromise;
        return { db: cached.db, conn: cached.conn };
    }

    // Create a single init promise for concurrent callers to await.
    cached.initPromise = (async () => {

    // Dynamically import duckdb-wasm ESM. Prefer a local vendor copy and
    // fall back to the CDN. Importing dynamically here avoids top-level await
    // which can be problematic when this module is imported by multiple files.
    if (!_duckdbModule) {
        try {
            _duckdbModule = await import('../vendor/@duckdb/duckdb-wasm/+esm/index.js');
        } catch (e) {
            console.warn('Local duckdb vendor import failed, falling back to CDN import', e);
            _duckdbModule = await import('https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.31.1-dev1.0/+esm');
        }
    }
    const duckdb = _duckdbModule;

    // Use the prebuilt jsDelivr bundles (or vendor-provided bundle metadata)
    // so we can select an appropriate wasm/worker bundle.
    const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles ? duckdb.getJsDelivrBundles() : null;
    const bundle = JSDELIVR_BUNDLES ? await duckdb.selectBundle(JSDELIVR_BUNDLES) : { mainModule: null, mainWorker: null, pthreadWorker: null };
    cached.bundle = bundle;

    // Helper to create a worker from a blob that importScripts a remote worker URL
    const createWorkerFromBlob = (remoteWorkerUrl) => {
        const blobUrl = URL.createObjectURL(
            new Blob([`importScripts("${remoteWorkerUrl}");`], { type: 'text/javascript' })
        );
        const w = new Worker(blobUrl);
        return { worker: w, blobUrl };
    };

    let worker;
    let workerBlobUrl;
    // If forceLocal is set, skip trying jsDelivr and go straight to local worker.
    if (!forceLocal) {
        try {
            const created = createWorkerFromBlob(bundle.mainWorker);
            worker = created.worker;
            workerBlobUrl = created.blobUrl;
        } catch (e) {
            console.warn('jsDelivr worker load failed, will attempt local worker fallback', e);
        }
    }
    cached.worker = worker || null;
    const logger = new duckdb.ConsoleLogger('LogLevel.ERROR');
    const db = new duckdb.AsyncDuckDB(logger, worker || undefined);
    cached.db = db;
    try {
        // Instantiate using the bundle's mainModule and pthreadWorker (if any).
        // If we didn't get a worker from jsDelivr above, we'll attempt a local
        // worker below before (or after) instantiate depending on failure.
        await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    } catch (err) {
        console.error('DuckDB wasm instantiate failed for jsDelivr worker attempt. bundle:', bundle, 'workerBlobUrl:', workerBlobUrl, err);
        // Clean up blob URL if created
        try { if (workerBlobUrl) URL.revokeObjectURL(workerBlobUrl); } catch (_) {}

        // If forceLocal was requested we shouldn't try remote fallback; otherwise
        // attempt to create a worker from a local path and re-instantiate.
        if (forceLocal) {
            throw err;
        }

        // Determine flavor (mvp vs eh) from the wasm filename so we can pick a
        // reasonable local worker filename.
        const wasm = bundle && bundle.mainModule ? bundle.mainModule : '';
        const flavor = wasm.includes('mvp') ? 'mvp' : 'eh';
        const localBundles = {
            mvp: { mainModule: bundle.mainModule, mainWorker: 'duckdb/duckdb-browser-mvp.worker.js' },
            eh: { mainModule: bundle.mainModule, mainWorker: 'duckdb/duckdb-browser-eh.worker.js' }
        };

        // Resolve local worker URL relative to the page
        let localWorkerUrl;
        try {
            localWorkerUrl = (typeof window !== 'undefined' && window.location)
                ? new URL(localBundles[flavor].mainWorker, window.location.href).toString()
                : localBundles[flavor].mainWorker;
        } catch (e) {
            localWorkerUrl = localBundles[flavor].mainWorker;
        }

        // Try creating a normal Worker from the local file (no blob). This works
        // when the worker is hosted with correct CORS and same-origin rules.
        try {
            worker = new Worker(localWorkerUrl);
            cached.worker = worker;
            // Replace db's worker reference by creating a new AsyncDuckDB with the local worker
            const localLogger = new duckdb.ConsoleLogger('LogLevel.ERROR');
            const localDb = new duckdb.AsyncDuckDB(localLogger, worker);
            cached.db = localDb;
            // Try instantiate again using the same wasm module
            await localDb.instantiate(localBundles[flavor].mainModule, bundle.pthreadWorker);
            // success — continue
        } catch (localErr) {
            console.error('Local DuckDB worker fallback also failed. localWorkerUrl:', localWorkerUrl, localErr);
            try { if (worker) worker.terminate(); } catch (_) {}
            throw localErr;
        }
    }
    // We can revoke the blob URL now that the worker has been created and the
    // module instantiated (if it exists).
    try { if (workerBlobUrl) URL.revokeObjectURL(workerBlobUrl); } catch (_) {}

    // The DB instance (either the original `db` or the `localDb` from the
    // fallback) will be stored in cached.db. Connect and return that.
        const conn = await cached.db.connect();
        cached.conn = conn;

        // Ensure the temporary stateMap table exists immediately after the
        // connection is created. This prevents race conditions where other
        // modules run queries that reference stateMap before the app has had
        // a chance to populate it. The table will be populated later by
        // state.replaceStateMap().
        try {
            // Ensure stateMap exists with a primary key on block_of_residence
            await runQuery(conn, `CREATE TEMPORARY TABLE IF NOT EXISTS stateMap (block_of_residence VARCHAR PRIMARY KEY, school VARCHAR);`);
        } catch (e) {
            console.warn('Failed to create temporary stateMap on init (non-fatal):', e);
        }
        try {
            // Ensure stateSchool exists so queries can reference it safely
            await runQuery(conn, `CREATE TEMPORARY TABLE IF NOT EXISTS stateSchool (name VARCHAR PRIMARY KEY, latitude DOUBLE, longitude DOUBLE, color VARCHAR, capacity INTEGER, fte_capacity DOUBLE);`);
        } catch (e) {
            console.warn('Failed to create temporary stateMap on init (non-fatal):', e);
        }

    // Confirm DuckDB loaded and print the version from `select version()`.
    // This is informational only; failures here should not stop initialization.
    try {
        const rows = await runQuery(conn, "select version() as version;");
        const versionStr = rows && rows[0] ? (rows[0].version ?? rows[0]['version()'] ?? String(rows[0])) : null;
        if (versionStr) {
            console.log('DuckDB loaded — version:', versionStr);
        } else {
            console.log('DuckDB loaded — version query returned no rows');
        }
    } catch (e) {
        console.warn('DuckDB loaded — failed to run version() query', e);
    }

        // Load spatial extension and attach the on-disk data.duckdb under schema `data`.
        // This centralizes the attach logic so other modules (e.g., autoPaint.js)
        // don't need to run `load spatial; attach ...` repeatedly. The attach
        // itself is protected by `cached.attachPromise` so concurrent callers
        // won't trigger duplicate attach attempts (which causes unique file
        // handle conflicts in DuckDB).
        if (!skipAttach) {
            // If an attach is already in progress, wait for it.
            if (cached.attachPromise) {
                await cached.attachPromise;
            } else if (!cached.attached) {
                // Create an attach promise so other callers will wait on it.
                cached.attachPromise = (async () => {
                    try {
                        try {
                            await runQuery(conn, 'load spatial;');
                        } catch (e) {
                            console.warn('Failed to load spatial extension (continuing):', e);
                        }

                        // Check whether schema `data` already exists; if not, attach the DB file.
                        let alreadyAttached = false;
                        try {
                            const schemaCheck = await runQuery(conn, "select schema_name from information_schema.schemata where schema_name = 'data';");
                            alreadyAttached = schemaCheck && schemaCheck.length > 0;
                        } catch (e) {
                            console.warn('Failed to check existing schemas before attach (continuing):', e);
                        }

                        if (!alreadyAttached) {
                            let dataUrl = attachDataUrl;
                            if (!dataUrl) {
                                // Prefer a local copy bundled with the app (works for Tauri)
                                try {
                                    dataUrl = new URL('duckdb/data.duckdb', window.location.href).toString();
                                } catch (e) {
                                    dataUrl = 'duckdb/data.duckdb';
                                }
                            }
                            try {
                                await runQuery(conn, `attach '${dataUrl}' as data;`);
                                console.log('Attached data.duckdb as schema `data` from', dataUrl);
                                cached.attached = true;
                            } catch (e) {
                                console.warn('Failed to attach data.duckdb (continuing):', e);
                                // Do not set attached=true so future attempts may retry.
                            }
                        } else {
                            cached.attached = true;
                        }
                    } finally {
                        // Clear the attachPromise so future attach attempts can run if needed.
                        cached.attachPromise = null;
                    }
                })();

                // Wait for the attach attempt to finish.
                await cached.attachPromise;
            }
        }

        return { db: cached.db, conn };
    })();

    try {
        return await cached.initPromise;
    } catch (err) {
        // Clear initPromise on failure to allow retries.
        cached.initPromise = null;
        throw err;
    }
}

export async function getConnection() {
    const { conn } = await initDuckDB();
    return conn;
}

// Unified query helper that always returns a serialized JavaScript array of
// row objects. Accepts two calling patterns:
//   runQuery(sql)             // obtains shared connection internally
//   runQuery(conn, sql)       // uses provided connection
// This centralizes result serialization so callers don't need to check for
// `.toArray()` on results and keeps call sites concise.
export async function runQuery(connOrSql, maybeSql) {
    let conn;
    let sql;
    if (typeof connOrSql === 'string') {
        sql = connOrSql;
        conn = await getConnection();
    } else {
        // first arg looks like a connection object
        conn = connOrSql;
        sql = maybeSql;
        if (!conn || typeof conn.query !== 'function') {
            // fallback: treat first arg as sql if it wasn't a connection
            sql = connOrSql;
            conn = await getConnection();
        }
    }

    const res = await conn.query(sql);
    // DuckDB JS bindings sometimes return an object with toArray(); prefer
    // returning the materialized array always so callers get a predictable
    // JS value.
    return (res && typeof res.toArray === 'function') ? res.toArray() : res;
}

// Upsert helper: attempts to perform an UPSERT (INSERT ... ON CONFLICT DO UPDATE)
// for a given table. If the DuckDB build in the browser does not support
// ON CONFLICT, this will gracefully fall back to delete-then-insert semantics.
//
// Parameters:
//   conn - DuckDB connection (required)
//   tableName - target table name (string)
//   rows - an object or array of objects representing rows to insert/update
//   keyCols - string or array of strings that identify the key columns used
//             for conflict detection (default: ['id'] — callers should pass
//             an appropriate key, e.g. 'block_of_residence')
export async function upsertRows(conn, tableName, rows, keyCols = ['id']) {
    if (!conn || !tableName || !rows) return;
    const rowArr = Array.isArray(rows) ? rows : [rows];
    if (rowArr.length === 0) return;

    // sanitize table and column identifiers (allow letters, numbers, underscore)
    const safeTable = String(tableName).replace(/[^a-zA-Z0-9_]/g, '');

    // collect union of keys across all rows
    const colsSet = new Set();
    rowArr.forEach(r => { Object.keys(r || {}).forEach(k => colsSet.add(String(k))); });
    const columns = Array.from(colsSet);
    if (columns.length === 0) return;

    // normalize keyCols
    const keys = Array.isArray(keyCols) ? keyCols.map(String) : [String(keyCols)];

    // helper to serialize a value into SQL literal
    const serialize = (v) => {
        if (v === null || v === undefined) return 'NULL';
        if (typeof v === 'number' || typeof v === 'bigint') return String(v);
        if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
        // assume string
        return `'${String(v).replace(/'/g, "''")}'`;
    };

    // build VALUES clause
    const valuesSql = rowArr.map(r => `(${columns.map(c => serialize(r[c])).join(',')})`).join(',');
    const colsSql = columns.map(c => c.replace(/[^a-zA-Z0-9_]/g, '')).join(',');

    // prepare ON CONFLICT clause if we have key columns
    const nonKeyCols = columns.filter(c => !keys.includes(c));
    let insertSql = `INSERT INTO ${safeTable} (${colsSql}) VALUES ${valuesSql}`;
    if (keys && keys.length > 0 && nonKeyCols.length > 0) {
        const keysSql = keys.map(k => k.replace(/[^a-zA-Z0-9_]/g, '')).join(',');
        const updateSql = nonKeyCols.map(c => `${c.replace(/[^a-zA-Z0-9_]/g, '')} = EXCLUDED.${c.replace(/[^a-zA-Z0-9_]/g, '')}`).join(', ');
        insertSql = `${insertSql} ON CONFLICT (${keysSql}) DO UPDATE SET ${updateSql};`;
    } else {
        insertSql = `${insertSql};`;
    }

    try {
        // Try the optimistic path: run a single UPSERT statement
        await runQuery(conn, insertSql);
        return;
    } catch (err) {
        // Fallback: some browser DuckDB builds don't support ON CONFLICT.
        // Implement delete-then-insert semantics safely.
        try {
            // Build delete WHERE clause for the batch. If single key use IN (...) for brevity.
            if (keys.length === 1) {
                const k = keys[0];
                const listed = rowArr.map(r => serialize(r[k])).join(',');
                const delSql = `DELETE FROM ${safeTable} WHERE ${k.replace(/[^a-zA-Z0-9_]/g, '')} IN (${listed});`;
                await runQuery(conn, delSql);
            } else {
                // multi-key: OR combined equality clauses
                const orClauses = rowArr.map(r => '(' + keys.map(k => `${k.replace(/[^a-zA-Z0-9_]/g, '')} = ${serialize(r[k])}`).join(' AND ') + ')').join(' OR ');
                const delSql = `DELETE FROM ${safeTable} WHERE ${orClauses};`;
                await runQuery(conn, delSql);
            }
            // Now insert the rows
            const insertFallback = `INSERT INTO ${safeTable} (${colsSql}) VALUES ${valuesSql};`;
            await runQuery(conn, insertFallback);
            return;
        } catch (err2) {
            // Re-throw the original error with fallback info attached
            err2.message = `Upsert failed (primary attempt error: ${err.message}; fallback error: ${err2.message})`;
            throw err2;
        }
    }
}

// Create or replace a convenient view named __feats that provides block id,
// current school (from stateMap override) and geometry from the attached
// data.<table>.geom. Consumers can query __feats instead of building their
// own temporary tables. If stateMap doesn't exist, the view will left-join
// and fall back to the base table's school (if present) or empty string.
export async function ensureFeatsView(tableName) {
    if (!tableName) return;
    const { conn } = await initDuckDB();
    try {
        // Ensure spatial extension is loaded and stateMap exists
        try { await runQuery(conn, 'load spatial;'); } catch (e) {}
    // Ensure stateMap exists (state.js will populate it). Use PRIMARY KEY
    // so ON CONFLICT targets will be valid when callers use upsert semantics.
    try { await runQuery(conn, `CREATE TEMPORARY TABLE IF NOT EXISTS stateMap (block_of_residence VARCHAR PRIMARY KEY, school VARCHAR);`); } catch (e) {}

        // Create or replace a temporary view __feats which selects block id,
        // resolved school (prefer stateMap.school if present), and geometry
        // from the attached data schema table. The geometry column is assumed
        // to be named `geom` in data.<tableName>.
        // Note: use safe quoting for identifier by disallowing dots in tableName
        const safeTable = String(tableName).replace(/[^a-zA-Z0-9_]/g, '');
        const sql = `CREATE OR REPLACE TEMPORARY VIEW __feats AS
            SELECT
                d.block_of_residence AS id,
                COALESCE(sm.school, '') AS school,
                d.geom as geom
            FROM data.${safeTable} d
                LEFT JOIN stateMap sm ON sm.block_of_residence = d.block_of_residence;`;
    await runQuery(conn, sql);
        // also create a fallback __feats view if the data table is missing will throw; let callers handle errors
    } catch (err) {
        console.warn('ensureFeatsView failed for table', tableName, err);
        throw err;
    }
}

// Listen for state.currentTable changes (dispatched by state.setCurrentTable)
// so the __feats view can be recreated automatically in the shared connection.
if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('stateTableChanged', async (ev) => {
        try {
            const table = ev && ev.detail && ev.detail.table ? ev.detail.table : null;
            if (!table) return;
            // best-effort: try to recreate the view; ignore errors so UI doesn't break
            await ensureFeatsView(table);
            console.log('Recreated __feats view for', table);
        } catch (e) {
            console.warn('stateTableChanged handler failed to recreate __feats view', e);
        }
    });
}

// Eagerly initialize DuckDB when the module loads so listeners (like the
// stateMapReplaced handler below) can assume the connection is available.
try {
    // Fire-and-forget — callers can still await getConnection()
    initDuckDB().catch(e => console.warn('initDuckDB early init failed:', e));
} catch (e) {}

// When stateMap is replaced/populated we should create the __feats view so
// downstream tools can query it. This avoids a race where the view is created
// before stateMap exists.
if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('stateMapReplaced', async (ev) => {
        try {
            const table = ev && ev.detail && ev.detail.table ? ev.detail.table : null;
            // if table is not provided, consumers can call ensureFeatsView manually
            if (!table) return;
            await ensureFeatsView(table);
            console.log('Created __feats view after stateMap replaced for', table);
        } catch (e) {
            console.warn('stateMapReplaced handler failed to create __feats view', e);
        }
    });
}

export async function closeDB() {
    try {
        if (cached.conn) await cached.conn.close();
    } catch (e) {}
    try {
        if (cached.worker) cached.worker.terminate();
    } catch (e) {}
    cached = { db: null, conn: null, worker: null, bundle: null };
    // Reset helper state used for concurrency control
    cached.initPromise = null;
    cached.attachPromise = null;
    cached.attached = false;
}

export function getBundle() { return cached.bundle; }
