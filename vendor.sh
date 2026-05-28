#!/usr/bin/env bash
set -euo pipefail

# Simple vendoring script to download JS/CSS assets needed to run the
# boundary-explorer app offline / inside a Tauri bundle.
# Run from the `apps/boundary-explorer` directory:
#   cd apps/boundary-explorer && ./scripts/vendor.sh

ROOT_DIR="app"
VENDOR_DIR="$ROOT_DIR/vendor"
mkdir -p "$VENDOR_DIR"

echo "Vendoring leaflet and fontawesome into $VENDOR_DIR"

# Leaflet
LEAFLET_VERSION="1.9.4"
mkdir -p "$VENDOR_DIR/leaflet"
curl -L "https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.css" -o "$VENDOR_DIR/leaflet/leaflet.css"
curl -L "https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.js" -o "$VENDOR_DIR/leaflet/leaflet.js"

# Download Leaflet image assets referenced by the CSS (layers icon, marker icons, shadows)
mkdir -p "$VENDOR_DIR/leaflet/images"
LEAFLET_IMAGES=(
	"layers.png"
	"layers-2x.png"
	"marker-icon.png"
	"marker-icon-2x.png"
	"marker-shadow.png"
)
for img in "${LEAFLET_IMAGES[@]}"; do
	url="https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/images/${img}"
	out="$VENDOR_DIR/leaflet/images/${img}"
	if [ -f "$out" ]; then
		echo "Skipping existing $out"
		continue
	fi
	echo "  - $img"
	if curl -f -L "$url" -o "$out"; then
		echo "    saved $out"
	else
		echo "    failed to download $url (continuing)"
		rm -f "$out"
	fi
done

# Font Awesome (only CSS needed for icons)
mkdir -p "$VENDOR_DIR/fontawesome/css"
FA_VERSION="7.0.1"
curl -L "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/${FA_VERSION}/css/all.min.css" -o "$VENDOR_DIR/fontawesome/css/all.min.css"

# Also download the Font Awesome webfont files so the CSS can load them locally
mkdir -p "$VENDOR_DIR/fontawesome/webfonts"
WEBFONTS=(
	"fa-solid-900.woff2"
	"fa-brands-400.woff2"
	"fa-regular-400.woff2"
	"fa-v4compatibility.woff2"
)
for wf in "${WEBFONTS[@]}"; do
	url="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@${FA_VERSION}/webfonts/${wf}"
	out="$VENDOR_DIR/fontawesome/webfonts/${wf}"
	if [ -f "$out" ]; then
		echo "Skipping existing $out"
		continue
	fi
	echo "  - $wf"
	if curl -f -L "$url" -o "$out"; then
		echo "    saved $out"
	else
		echo "    failed to download $url (continuing)"
		rm -f "$out"
	fi
done

echo "Vendor files downloaded. Please verify and commit vendor/ to your repo if desired."

# Duckdb-wasm vendoring
DUCKDB_TAG="1.33.1-dev45.0"
DUCKDB_PARENT_DIR="$ROOT_DIR/vendor/@duckdb"
DUCKDB_DIR="$DUCKDB_PARENT_DIR/duckdb-wasm"
mkdir -p "$DUCKDB_PARENT_DIR"

# Download prebuilt dist artifacts from the jsDelivr CDN so we have the
# browser bundles, worker scripts and wasm binaries available locally.
DIST_URL_BASE="https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${DUCKDB_TAG}/dist"
mkdir -p "$DUCKDB_DIR/dist"
echo "Downloading duckdb-wasm dist files from $DIST_URL_BASE"
DIST_FILES=(
	"duckdb-browser.mjs"
	"duckdb-browser-blocking.mjs"
	"duckdb-browser.cjs"
	"duckdb-browser-blocking.cjs"
	"duckdb-browser-mvp.worker.js"
	"duckdb-browser-eh.worker.js"
	"duckdb-browser-coi.worker.js"
	"duckdb-browser-coi.pthread.worker.js"
	"duckdb-mvp.wasm"
	"duckdb-eh.wasm"
	"duckdb-coi.wasm"
)
for f in "${DIST_FILES[@]}"; do
	url="$DIST_URL_BASE/$f"
	out="$DUCKDB_DIR/dist/$f"
	out_tmp="${out}.tmp.$$"
	echo "  - $f"
	# Attempt download to a temporary file and move into place on success so
	# we never leave a partially-downloaded file at the final path.
	if curl -f -L "$url" -o "$out_tmp"; then
		mv -f "$out_tmp" "$out"
		echo "    saved $out"
	else
		echo "    failed to download $url (continuing)"
		rm -f "$out_tmp"
	fi
done

# Create a minimal +esm wrapper so the app can import vendor/@duckdb/duckdb-wasm/+esm/index.js
# Point the wrapper at the prebuilt browser bundle (`duckdb-browser.mjs`) we just downloaded.
WRAPPER_DIR="$DUCKDB_DIR/+esm"
WRAPPER_INDEX="$WRAPPER_DIR/index.js"
if [ ! -f "$WRAPPER_INDEX" ]; then
	mkdir -p "$WRAPPER_DIR"
	cat > "$WRAPPER_INDEX" <<'EOF'
// Minimal ESM wrapper for vendored duckdb-wasm
// This re-exports the prebuilt browser bundle that should exist under ../dist/.
// If you need a different bundle, update the path below.
export * from '../dist/duckdb-browser.mjs';
export { default } from '../dist/duckdb-browser.mjs';
EOF
	echo "Created minimal duckdb-wasm ESM wrapper at $WRAPPER_INDEX"
fi
