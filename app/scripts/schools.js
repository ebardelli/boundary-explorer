import { state } from './state.js';
import { translate } from './i18n.js';
import { colorFromName } from './utils.js';
import { style } from './paint.js';

// Return '#000' or '#fff' depending on which has better contrast with the
// provided hex background color. Uses the YIQ formula for a fast decision.
function readableTextColor(hex) {
    if (!hex) return '#000';
    const c = hex.replace('#', '');
    if (c.length !== 6) return '#000';
    const r = parseInt(c.substr(0, 2), 16);
    const g = parseInt(c.substr(2, 2), 16);
    const b = parseInt(c.substr(4, 2), 16);
    const yiq = (r * 299 + g * 587 + b * 114) / 1000;
    return yiq >= 128 ? '#000' : '#fff';
}

// Helper to create a school marker using a Font Awesome school icon inside a colored circle.
export function createSchoolMarker(name, data) {
    const lat = data.latitude;
    const lon = data.longitude;
    if (lat == null || lon == null) return null;
    const size = 28;
    // Requested color: rgb(63,26,96) (#3F1A60). Allow data.color override if provided.
    const bg = data.color || 'rgb(63,26,96)';
    const html = `
        <div class="school-divicon" style="display:inline-flex;align-items:center;justify-content:center;">
            <div class="school-icon" style="background:${bg};width:${size}px;height:${size}px;border-radius:50%;display:flex;align-items:center;justify-content:center;border:1px solid rgba(0,0,0,0.18);box-sizing:border-box">
                <i class="fa-solid fa-school" aria-hidden="true" style="color:white;font-size:14px;line-height:1"></i>
            </div>
        </div>`;
    const icon = L.divIcon({ className: 'school-divicon-container', html, iconSize: [size, size], iconAnchor: [size/2, size/2] });
    try {
        const marker = L.marker([lat, lon], { icon, interactive: true });
        marker.bindPopup(name);
        return marker;
    } catch (e) {
        console.warn('Failed creating school marker', e);
        return null;
    }
}

export function getSchoolType(schoolName) {
    const lowerName = schoolName.toLowerCase();
    if (lowerName.includes('elementary')) return 'elementary';
    if (lowerName.includes('middle')) return 'middle';
    if (lowerName.includes('high')) return 'high';
    return 'other';
}

export function updateSchoolList() {
    // Find the school-list container (single Schools section in the updated layout)
    const schoolList = document.getElementById('school-list');
    if (!schoolList) {
        console.error('No #school-list element found in the DOM to render schools into.');
        return;
    }

    // Clear and group schools by type first so we only render non-empty categories
    schoolList.innerHTML = '';
    const types = ['elementary', 'middle', 'high', 'other'];
    const grouped = { elementary: [], middle: [], high: [], other: [] };

    state.schools.forEach((data, name) => {
        const schoolType = getSchoolType(name);
        (grouped[schoolType] || grouped.other).push({ name, data });
    });

    const containers = {};

    // Render only categories that have at least one school
    types.forEach(t => {
        const entries = grouped[t] || [];
        if (entries.length === 0) return; // skip empty categories

        const wrapper = document.createElement('div');
        wrapper.className = 'school-type-wrapper';
    const header = document.createElement('h4');
    // translate known section titles
    const titleKey = t === 'elementary' ? 'elementarySchools' : t === 'middle' ? 'middleSchools' : t === 'high' ? 'highSchools' : 'otherSchools';
    header.textContent = translate(titleKey);
        header.style.margin = '8px 0 4px';
        const content = document.createElement('div');
        content.className = 'school-type-content';

        wrapper.appendChild(header);
        wrapper.appendChild(content);
        schoolList.appendChild(wrapper);
        containers[t] = content;

        // append schools for this category
        entries.forEach(({ name, data }) => {
            const schoolDiv = document.createElement('div');
            schoolDiv.style.display = 'flex';
            schoolDiv.style.alignItems = 'center';
            schoolDiv.style.marginBottom = '5px';

            // Create a colorized select button on the left that uses the
            // school's color as its background. The button label still uses
            // the translated "Select" / "Selected" text, but we ensure the
            // foreground color is readable on top of the background.
            const btnColor = data.color || colorFromName(name);
            const selectButton = document.createElement('button');
            selectButton.className = 'tool-inline school-select-button';
            selectButton.textContent = state.currentSchool === name ? translate('selected') : translate('select');
            // dynamic appearance: background and text color are per-school
            selectButton.style.backgroundColor = btnColor;
            selectButton.style.color = readableTextColor(btnColor);
            selectButton.setAttribute('aria-pressed', state.currentSchool === name ? 'true' : 'false');

            selectButton.addEventListener('click', () => {
                state.currentSchool = state.currentSchool === name ? null : name;
                // Rerender list (this will update button states/styles too)
                updateSchoolList();
                if (state.currentSchool === name) {
                    if (data.latitude && data.longitude && !state.markers.has(name)) {
                        const marker = createSchoolMarker(name, data);
                        if (marker) { marker.addTo(state.map); state.markers.set(name, marker); }
                    }
                    state.activeSchools.add(name);
                    // refresh statistics when a school becomes active
                    import('./stats.js').then(mod => mod.calculateStatistics());
                }
            });

            const nameSpan = document.createElement('span');
            nameSpan.textContent = name;
            // keep name span natural width

            schoolDiv.appendChild(selectButton);
            schoolDiv.appendChild(nameSpan);
            content.appendChild(schoolDiv);
        });
    });

    // Add New School button should always be available; place it at the bottom of the school list
    const addSchoolBtn = document.createElement('button');
    addSchoolBtn.className = 'tool-list-button';
    addSchoolBtn.textContent = translate('addNewSchool') || 'Add New School';
    addSchoolBtn.style.marginTop = '10px';
    addSchoolBtn.addEventListener('click', () => {
        const name = prompt("Enter the name for the new school:");
        if (!name) return;
        if (state.schools.has(name)) { alert("A school with that name already exists."); return; }
        const color = colorFromName(name);
        state.schools.set(name, { color, latitude: null, longitude: null, capacity: 0 });
        // select and activate the new school so it appears in the UI and stats
        state.currentSchool = name;
        state.activeSchools.add(name);
        updateSchoolList();
        // ensure any colored blocks update and stats refresh
        import('./paint.js').then(mod => mod.refreshStyles());
        import('./stats.js').then(mod => mod.calculateStatistics());
    });
    schoolList.appendChild(addSchoolBtn);

    // Ensure the Edit Schools button (modal trigger) is present. updateSchoolList
    // clears `schoolList.innerHTML` which can remove the button created on
    // window load; recreate it here if necessary. Use dynamic import to avoid
    // circular static imports.
    import('./editor.js').then(mod => { try { mod.createEditButtonAndModal(); } catch (e) { /* ignore */ } });

    // Ensure markers are present for any programmatically-activated schools
    // (e.g., schools added/activated during GeoJSON import). If a school is
    // active and has lat/lon, add a marker to the map if one doesn't exist yet.
    try {
        state.activeSchools.forEach(name => {
            const data = state.schools.get(name);
            if (!data) return;
            if (data.latitude && data.longitude && !state.markers.has(name) && typeof L !== 'undefined' && state.map) {
                const marker = createSchoolMarker(name, data);
                if (marker) { marker.addTo(state.map); state.markers.set(name, marker); }
            }
        });
    } catch (err) {
        console.error('Error activating markers for active schools:', err);
    }
}

// re-render when language changes
if (typeof window !== 'undefined') {
    window.addEventListener('languagechange', () => {
        try { updateSchoolList(); } catch (e) {}
    });
}

export async function loadSchools() {
    try {
        // schools.json lives one level above the scripts/ folder.
        // Resolve it relative to this module so the fetch works even when
        // the app changes its base path during imports/flushes.
        const schoolsUrl = new URL('../schools.json', import.meta.url).href;
        const response = await fetch(schoolsUrl);
        if (!response.ok) throw new Error(`Failed to fetch schools.json: ${response.status} ${response.statusText}`);
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
            const text = await response.text();
            throw new Error(`Unexpected non-JSON response when loading schools.json (content-type: ${contentType}) — first chars: ${text.slice(0,120)}`);
        }
        const data = await response.json();
        state.schools.clear();
        data.forEach(item => {
            const resolvedColor = item.color || colorFromName(item.name);
            state.schools.set(item.name, { color: resolvedColor, latitude: item.latitude, longitude: item.longitude, capacity: item.capacity });
        });
        updateSchoolList();
        // persist to DuckDB temporary table
        try {
            import('./duckdb.js').then(async mod => {
                try {
                    const conn = await mod.getConnection();
                    const { replaceStateSchools } = await import('./state.js');
                    await replaceStateSchools(conn);
                } catch (e) { /* ignore */ }
            }).catch(_e => {});
        } catch (e) {}
    } catch (error) {
        console.error('Error loading schools:', error);
        alert('Failed to load schools');
    }
}
