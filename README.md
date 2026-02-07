Boundary Explorer — app/
=========================

What this is
------------
A lightweight, browser-based interactive map application for exploring school boundaries and related geographic data. It uses local static assets (Leaflet, Font Awesome) and an in-browser DuckDB dataset to provide fast, client-side querying and map interaction.

Quick start
-----------
1. Ensure vendor dependencies are present in `app/vendor/`. If they are missing, run the helper in the project root:

   ./vendor.sh

2. Serve the `app/` directory with a static HTTP server (recommended) and open `index.html` in your browser. Example using Python 3:

   cd app
   python3 -m http.server 8000
   # then open http://localhost:8000 in your browser

Opening the file directly with a `file://` URL may work for static assets, but some browser features (e.g., worker loading, fetch) work more reliably when served over HTTP.

What you'll find
----------------
- `index.html` — Single-page app shell that loads CSS, Leaflet, and `scripts/main.js` (entry point).
- `styles.css` — App styling.
- `vendor/` — 3rd-party libraries (Leaflet, Font Awesome, DuckDB WASM). Use `vendor.sh` to populate.
- `scripts/` — Application JavaScript modules. Key files:
  - `main.js` — App initialization and DB boot sequence.
  - `maps.js`, `mappingTools.js`, `layers.js` — Map and UI logic.
  - `duckdb.js` + `duckdb/` — In-browser DuckDB binary/data and worker scripts (prebuilt WASM workers in `duckdb/`).
  - `fileManager.js`, `importHelpers.js` — Import and data management utilities.
  - `i18n.js`, `ui.js` — Internationalization and UI helpers.
- `maps/` — GeoJSON boundary and block files used by the app (elementary/middle/high/secondary boundaries, blocks, landmarks, etc.).
- `duckdb/data.duckdb` — Prepopulated DuckDB database used for fast client queries.
- `schools.json` — Example data for school listings shown in the UI.
- `queries/` — SQL query snippets used for data processing (e.g., `feeder_districts.sql`).

Behavior and notes
------------------
- On startup the app shows a loading overlay while the in-browser DuckDB initializes. The UI exposes a retry button if initialization fails.
- Map interactions and tools are injected by JavaScript modules. The `mapping-tools-placeholder` in `index.html` is where the mapping tools section is inserted at runtime.
- The app is designed to run fully client-side; no server backend is required beyond static hosting.

Development tips
----------------
- Serve the files from a local HTTP server to avoid worker/loading restrictions.
- If you change or update vendor assets, re-run `vendor.sh` from the project root.
- Use the browser devtools console to see initialization logs from `scripts/main.js` and DuckDB worker messages.

Troubleshooting
---------------
- Missing vendor files: run `./vendor.sh` (project root) to download Leaflet, Font Awesome, and DuckDB WASM files into `app/vendor/`.
- If the DuckDB worker fails to load, check that `app/duckdb/duckdb-browser-*.worker.js` files are present and that the site is served via HTTP (not restricted by file://). Browser console errors will usually show the worker load error.

Contributing
------------
- Follow the existing code style in `scripts/` (ES modules). Keep changes small and test by running a local HTTP server and exercising the map tools.

License
-------
- No license file included in the app directory. Add a LICENSE at project root if you intend to open-source the project.

Contact
-------
- For questions, check the repo root or the project maintainer's contact (not provided here).
