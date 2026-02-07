import { state, baseMapOptions, setCurrentTable } from './state.js';
import { translate, setLanguage } from './i18n.js';

export function createInstructionsSection() {
    const instructionsContainer = document.getElementById('instructions');
    instructionsContainer.innerHTML = `
        <h2 id="instructions-title">${translate('instructions').title}</h2>
        <ul id="instructions-list"></ul>
        <a id="howto-link" href="how-to.html">${translate('instructions').howto}</a>
    `;

    const instructionsList = document.getElementById('instructions-list');
    const steps = translate('instructions');
    if (steps && Array.isArray(steps.steps)) {
        steps.steps.forEach(step => {
            const li = document.createElement('li');
            li.textContent = step;
            instructionsList.appendChild(li);
        });
    }
}

export function createMapSelector() {
    const mapSelector = document.createElement('div');
    mapSelector.style.marginBottom = '15px';
    mapSelector.innerHTML = `
        <h2 id="map-selector-title">${translate('selectBaseMap')}</h2>
        <select id="base-map-select" style="width: 100%; padding: 5px;">
            <option value="">Select a map...</option>
            ${baseMapOptions.map(map => `<option value="${map.url}">${map.title}</option>`).join('')}
        </select>
    `;

    document.getElementById('map-selector').appendChild(mapSelector);

    document.getElementById('base-map-select').addEventListener('change', async (e) => {
        const url = e.target.value;
        if (url) {
            try {
                const response = await fetch(url);
                if (!response.ok) throw new Error('Failed to fetch GeoJSON');
                const data = await response.json();
                // Flush existing schools first so the newly selected base map
                // becomes the authoritative source for schools and avoids
                // mixing previous schools with the new map.
                const helpers = await import('./importHelpers.js');
                await helpers.flushSchools();

                // lazy import paint to avoid circular deps
                const { loadGeoJSON } = await import('./paint.js');
                await loadGeoJSON(data);
                // run the same post-load finalization used by file imports
                await helpers.finalizeGeojsonImport(data);
                state.currentMap = baseMapOptions.find(map => map.url === url).title;
                setCurrentTable(baseMapOptions.find(map => map.url === url).table);
            } catch (error) {
                alert('Error loading map: ' + error.message);
                console.error('Error:', error);
            }
        }
    });
}

// Load a map by its title (case-insensitive match against baseMapOptions).
// Returns the map object if loaded, or null if not found.
export async function loadMapByTitle(title) {
    if (!title) return null;
    // normalize: trim and compare case-insensitively
    const norm = String(title).trim().toLowerCase();
    const match = baseMapOptions.find(m => String(m.title || '').trim().toLowerCase() === norm);
    if (!match) return null;
    try {
        const response = await fetch(match.url);
        if (!response.ok) throw new Error('Failed to fetch GeoJSON');
        const data = await response.json();
        const helpers = await import('./importHelpers.js');
        await helpers.flushSchools();
        const { loadGeoJSON } = await import('./paint.js');
        await loadGeoJSON(data);
        await helpers.finalizeGeojsonImport(data);
        state.currentMap = match.title;
        setCurrentTable(match.table);
        // Also set the select UI if present
        const sel = document.getElementById('base-map-select');
        if (sel) {
            sel.value = match.url;
        }
        return match;
    } catch (err) {
        console.error('loadMapByTitle failed:', err);
        return null;
    }
}

export function createModeControls() {
    const modeControls = document.createElement('div');
    modeControls.innerHTML = `
        <h2 id="mode-title">${translate('selectMode')}</h2>
        <div style="margin-bottom: 15px; display:flex; gap:8px; justify-content:center; align-items:center;">
            <button id="select-mode" class="tool-inline">${translate('selectMode')}</button>
            <button id="paint-mode" class="tool-inline">${translate('paintMode')}</button>
            <button id="eraser-mode" class="tool-inline">${translate('eraserMode')}</button>
        </div>
    `;
   
    document.getElementById('map-mode').appendChild(modeControls);

    const selectModeBtn = document.getElementById('select-mode');
    const paintModeBtn = document.getElementById('paint-mode');
    const eraserModeBtn = document.getElementById('eraser-mode');

    selectModeBtn.addEventListener('click', () => {
        state.mode = state.mode === 'select' ? 'none' : 'select';
        updateModeButtons();
        state.map.getContainer().style.cursor = state.mode === 'select' ? 'crosshair' : '';
        state.map.dragging.enable();
    });

    paintModeBtn.addEventListener('click', () => {
        state.mode = state.mode === 'paint' ? 'none' : 'paint';
        updateModeButtons();
        state.map.getContainer().style.cursor = state.mode === 'paint' ? 'crosshair' : '';
        state.map.dragging.enable();
    });

    eraserModeBtn.addEventListener('click', () => {
        state.mode = state.mode === 'eraser' ? 'none' : 'eraser';
        updateModeButtons();
        state.map.getContainer().style.cursor = state.mode === 'eraser' ? 'not-allowed' : '';
        state.map.dragging.enable();
    });
}

// Update static text for changed language
export function updateLocalizedText() {
    // Instructions and mode controls may need updating
    const mapTitle = document.getElementById('map-selector-title');
    if (mapTitle) mapTitle.textContent = translate('selectBaseMap');
    const modeTitle = document.getElementById('mode-title');
    if (modeTitle) modeTitle.textContent = translate('selectMode');
    // update buttons in mode controls
    try { updateModeButtons(); } catch (e) {}
    // re-create instructions (it uses translate internally)
    try { createInstructionsSection(); } catch (e) {}
}

export function updateModeButtons() {
    const selectModeBtn = document.getElementById('select-mode');
    const paintModeBtn = document.getElementById('paint-mode');
    const eraserModeBtn = document.getElementById('eraser-mode');
    
    selectModeBtn.textContent = state.mode === 'select' ? translate('exitSelectMode') : translate('selectMode');
    paintModeBtn.textContent = state.mode === 'paint' ? translate('exitPaintMode') : translate('paintMode');
    eraserModeBtn.textContent = state.mode === 'eraser' ? translate('exitEraserMode') : translate('eraserMode');
    
    selectModeBtn.style.backgroundColor = state.mode === 'select' ? '#ddd' : '';
    paintModeBtn.style.backgroundColor = state.mode === 'paint' ? '#ddd' : '';
    eraserModeBtn.style.backgroundColor = state.mode === 'eraser' ? '#ddd' : '';
}

export function initLanguageToggle() {
    const languageSelect = document.createElement('select');
    languageSelect.innerHTML = `
        <option value="en">English</option>
        <option value="es">Español</option>
    `;
    languageSelect.id = 'language-toggle';
    languageSelect.style.marginBottom = '20px';
    languageSelect.addEventListener('change', (e) => {
        setLanguage(e.target.value);
        // re-render relevant UI
        createInstructionsSection();
    });
    const languageContainer = document.getElementById('language-select');
    languageContainer.appendChild(languageSelect);
}

// Initialize collapsible section toggles: clicking header rotates icon and shows/hides content
export function initCollapsibles() {
    function initSections(){
        // Attach handlers to all current headers
        document.querySelectorAll('.section-header').forEach(initHeader);

        // Observe added nodes so dynamically injected headers (e.g. by main.js)
        // will also be initialized.
        const left = document.getElementById('left-column');
        if (!left) return;
        const mo = new MutationObserver(mutations => {
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (!(node instanceof Element)) continue;
                    if (node.matches && node.matches('.section-header')) initHeader(node);
                    // also check subtree
                    node.querySelectorAll && node.querySelectorAll('.section-header').forEach(initHeader);
                }
            }
        });
        mo.observe(left, { childList: true, subtree: true });
    }

    function initHeader(h) {
        if (!h || h.dataset.toggleInit === '1') return; // already initialized
        const content = h.nextElementSibling;
        if (h.classList.contains('open')){
            if (content) content.style.display = '';
            h.setAttribute('aria-expanded','true');
        } else {
            if (content) content.style.display = 'none';
            h.setAttribute('aria-expanded','false');
        }
        h.addEventListener('click', toggle);
        h.tabIndex = 0;
        h.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                toggle();
            }
        });
        function toggle(){
            const isOpen = h.classList.toggle('open');
            if (isOpen){
                if (content) content.style.display = '';
                h.setAttribute('aria-expanded','true');
            } else {
                if (content) content.style.display = 'none';
                h.setAttribute('aria-expanded','false');
            }
        }
        h.dataset.toggleInit = '1';
    }

    // Run immediately when requested. Caller (main.js) will call this on DOMContentLoaded.
    initSections();
    // initialize left-column collapse/hover behavior
    initLeftColumnToggle();
}

// Adds a collapse button for the left column and a hover-area to reveal it.
function initLeftColumnToggle(){
    const left = document.getElementById('left-column');
    const mapContainer = document.getElementById('map-container');
    if (!left || !mapContainer) return;


    // Create toggle button if not present
    let btn = document.getElementById('left-toggle-button');
    if (!btn){
    btn = document.createElement('button');
    btn.id = 'left-toggle-button';
        // presenter-mode affordance: an icon + label when inactive, icon-only when active
        btn.title = 'Enter presenter mode';
        btn.setAttribute('aria-label', 'Enter presenter mode');
        btn.setAttribute('aria-pressed','false');
                btn.innerHTML = `
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
                            <rect x="2.5" y="6.5" width="13" height="8" rx="1.2"/>
                            <circle cx="18" cy="10" r="2.2" fill="currentColor"/>
                              <path d="M9 16l-2.5 3" />
                              <path d="M9 16l2.5 3" />
                        </svg>
                        <span class="label">Enter presenter mode</span>
                `;
        document.body.appendChild(btn);
    }

    // Create hover area
    let hover = document.getElementById('left-hover-area');
    if (!hover){
        hover = document.createElement('div');
        hover.id = 'left-hover-area';
        hover.className = 'hidden';
        document.body.appendChild(hover);
    }

    // Ensure left column has an inner scrolling container so transforms on the outer
    // don't detach the scrollbar. If not present, wrap existing children.
    if (!left.querySelector('.left-inner')){
        const inner = document.createElement('div');
        inner.className = 'left-inner';
        // move all children into inner
        while (left.firstChild){
            inner.appendChild(left.firstChild);
        }
        left.appendChild(inner);
    }

    // Move any future direct children into .left-inner so dynamic content is scrollable
    const leftInner = left.querySelector('.left-inner');
    const leftObserver = new MutationObserver(mutations => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (!(node instanceof Element)) continue;
                if (node === leftInner) continue;
                // move this node into the inner container
                leftInner.appendChild(node);
            }
        }
        // update offset in case layout changed
        updateLeftInnerOffset();
    });
    leftObserver.observe(left, { childList: true });

    // State: collapsed (boolean). Default: false (open)
    let collapsed = false;
    // Keep track of whether we're temporarily revealed by hover
    let hovered = false;
    // track separate hover sources so we only hide when none are hovered
    let hoveredButton = false;
    let hoveredHoverArea = false;
    let hoveredLeft = false;

    function updateTempVisibility(){
        const any = hoveredButton || hoveredHoverArea || hoveredLeft;
        if (any){
            if (!hovered){
                hovered = true;
                left.classList.add('hovered');
                mapContainer.classList.remove('fullwidth');
                try { state.map && state.map.invalidateSize(true); } catch (e) {}
            }
        } else {
            if (hovered){
                hovered = false;
                left.classList.remove('hovered');
                mapContainer.classList.add('fullwidth');
                try { state.map && state.map.invalidateSize(true); } catch (e) {}
            }
        }
    }

    function applyState(){
        if (collapsed){
            left.classList.add('collapsed');
            btn.classList.add('collapsed');
            btn.setAttribute('aria-pressed','true');
            // update accessible name to reflect active state
            btn.title = 'Exit presenter mode';
            btn.setAttribute('aria-label', 'Exit presenter mode');
            hover.classList.remove('hidden');
            // allow map to expand into freed space
            mapContainer.classList.add('fullwidth');
                // after transition ends, invalidate map size so Leaflet resizes properly
                try { state.map && state.map.invalidateSize(true); } catch (e) {}
                setTimeout(() => { try { state.map && state.map.invalidateSize(true); } catch (e) {} }, 300);
                // ensure scroll area offset is up-to-date after collapsing
                updateLeftInnerOffset();
        } else {
            left.classList.remove('collapsed');
            left.classList.remove('hovered');
            btn.classList.remove('collapsed');
            btn.setAttribute('aria-pressed','false');
            // restore accessible name when not active
            btn.title = 'Enter presenter mode';
            btn.setAttribute('aria-label', 'Enter presenter mode');
            hover.classList.add('hidden');
            mapContainer.classList.remove('fullwidth');
            try { state.map && state.map.invalidateSize(true); } catch (e) {}
            setTimeout(() => { try { state.map && state.map.invalidateSize(true); } catch (e) {} }, 300);
            // ensure scroll area offset is up-to-date after opening
            updateLeftInnerOffset();
        }
    }

    // Compute and set CSS variable --left-toggle-offset so the inner scroll area
    // starts just below the toggle button. Runs on init and resize.
    function updateLeftInnerOffset(){
        try {
            const btnRect = btn.getBoundingClientRect();
            // Add a small gap between button and content
            const offset = Math.ceil(btnRect.bottom + 6);
            // update CSS var for compatibility
            document.documentElement.style.setProperty('--left-toggle-offset', offset + 'px');
            // also set the leftInner inline styles so max-height/margin are exact
            const leftInner = left.querySelector('.left-inner');
            if (leftInner) {
                leftInner.style.marginTop = offset + 'px';
                const max = Math.max(0, window.innerHeight - offset);
                leftInner.style.maxHeight = max + 'px';
                leftInner.style.height = max + 'px';
                // ensure padding-bottom so last items aren't clipped by any overlays
                leftInner.style.paddingBottom = '48px';
                leftInner.style.boxSizing = 'border-box';
            }
        } catch (e) {
            // fallback: do nothing
        }
    }

    // keep offset updated on resize and orientation change
    window.addEventListener('resize', updateLeftInnerOffset);
    // run once now
    updateLeftInnerOffset();

    btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        collapsed = !collapsed;
        applyState();
    });

    // Reveal the sidebar when hovering the toggle button (temporary while collapsed)
    btn.addEventListener('mouseenter', () => {
        if (!collapsed) return;
        hoveredButton = true;
        updateTempVisibility();
    });
    btn.addEventListener('mouseleave', () => {
        if (!collapsed) return;
        hoveredButton = false;
        updateTempVisibility();
    });

    // Hover behavior: when collapsed, hovering the narrow left strip or the left column reveals it
    hover.addEventListener('mouseenter', () => {
        if (!collapsed) return;
        hoveredHoverArea = true;
        updateTempVisibility();
    });
    hover.addEventListener('mouseleave', () => {
        if (!collapsed) return;
        hoveredHoverArea = false;
        updateTempVisibility();
    });

    left.addEventListener('mouseenter', () => {
        if (!collapsed) return;
        hoveredLeft = true;
        updateTempVisibility();
    });
    left.addEventListener('mouseleave', () => {
        if (!collapsed) return;
        hoveredLeft = false;
        updateTempVisibility();
    });

    // Fallback: if hover area doesn't receive events, use mousemove near left edge
    document.addEventListener('mousemove', (ev) => {
        if (!collapsed) return;
        if (ev.clientX <= 24) {
            hoveredHoverArea = true;
        } else {
            hoveredHoverArea = false;
        }
        updateTempVisibility();
    });

    // keyboard accessibility: toggle via keyboard when focused
    btn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); btn.click(); }
    });

    // initial apply
    applyState();
}
