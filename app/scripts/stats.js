import { state } from './state.js';
import { translate } from './i18n.js';
import { getConnection, runQuery } from './duckdb.js';
import { buildStateMap } from './state.js';

// style function kept for reuse by other modules
export function style(feature) {
    const school = feature.properties.school;
    const schoolData = state.schools.get(school);
    return {
        fillColor: schoolData ? schoolData.color : '#808080',
        weight: 1,
        opacity: 1,
        color: 'black',
        fillOpacity: 0.7
    };
}

// internal caches
let lastStats = [];
let lastFteStats = [];
let lastGradeStats = [];
let lastFteGradeStats = [];

// Helpers
function sqlEscape(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/'/g, "''");
}

function buildActiveFilter() {
    const activeSet = state.activeSchools && state.activeSchools.size > 0 ? Array.from(state.activeSchools) : null;
    if (!activeSet || activeSet.length === 0) return '';
    const inList = activeSet.map(s => `'${sqlEscape(s)}'`).join(',');
    return `AND stateMap.school IN (${inList})`;
}

function currentMapName() {
    return (state.currentTable === null || state.currentTable === undefined) ? 'elementary' : String(state.currentTable);
}

async function runAggregate(sql) {
    // runQuery will obtain a connection if needed and always return a JS array
    return await runQuery(sql);
}

function normalizeRowsToStats(rows, mapping) {
    // mapping describes how to pick fields from row -> normalized {name, students, residents, capacity, remaining}
    return (rows || []).map(r => {
        const get = key => {
            const v = r[key];
            return v === undefined || v === null ? 0 : Number(v);
        };
        return {
            name: r.name || r.school || '',
            students: get(mapping.students),
            residents: get(mapping.residents),
            capacity: get(mapping.capacity),
            remaining: get(mapping.remaining)
        };
    });
}

function getGradeRangeForMap(mapName) {
    // mapName expected to be 'elementary', 'middle', 'high', 'secondary' or similar
    switch ((mapName || '').toLowerCase()) {
        case 'middle':
            return [7, 8];
        case 'high':
            return [9, 10, 11, 12];
        case 'secondary':
            return [7, 8, 9, 10, 11, 12];
        case 'elementary':
        default:
            // include -1 (pre-k) through 6 for elementary
            return [-1, 0, 1, 2, 3, 4, 5, 6];
    }
}

// Grade-level statistics: return array of { name, grades: { grade: sum, ... } }
export async function calculateGradeLevelStatistics() {
    const activeFilter = buildActiveFilter();

    const sql = `
        SELECT
            stateMap.school AS name,
            block_statistics.grade AS grade,
            SUM(COALESCE(block_statistics.students, 0)) AS students
        FROM data.block_statistics
            LEFT JOIN stateMap ON stateMap.block_of_residence = block_statistics.block_of_residence
        WHERE
            stateMap.school IS NOT NULL
            AND block_statistics.grade IS NOT NULL
            ${activeFilter}
        GROUP BY stateMap.school, block_statistics.grade
        ORDER BY stateMap.school, block_statistics.grade
    `;

    const rows = await runAggregate(sql);

    // Build mapping school -> { grade: students }
    const map = new Map();
    (rows || []).forEach(r => {
        const school = r.name || r.school || '';
        const gradeRaw = r.grade;
        // try convert numeric-like grade values to integers, otherwise ignore
        const gradeNum = Number.isFinite(Number(gradeRaw)) ? Number(gradeRaw) : null;
        if (gradeNum === null || Number.isNaN(gradeNum)) return;
        if (gradeNum < -1 || gradeNum > 12) return; // out of expected range
        const students = r.students === undefined || r.students === null ? 0 : Number(r.students);
        if (!map.has(school)) map.set(school, {});
        map.get(school)[gradeNum] = (map.get(school)[gradeNum] || 0) + (Number.isFinite(students) ? students : 0);
    });

    // Convert to array of rows
    const result = Array.from(map.entries()).map(([name, gradesObj]) => ({ name, grades: gradesObj }));
    // Sort by school name
    result.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    lastGradeStats = result;

    const modal = document.getElementById('enrollment-stats-modal');
    if (modal && modal.style.display === 'block') populateGradeLevelsTable(result);
    return result;
}

// Grade-level FTE statistics: similar to calculateGradeLevelStatistics but sum FTEs
export async function calculateGradeLevelFTEStatistics() {
    const activeFilter = buildActiveFilter();

    const table = currentMapName();
    const escapedTable = sqlEscape(table);

    // Rounding rules applied server-side per request:
    // - elementary: round to nearest 0.5 (ROUND(x*2)/2)
    // - secondary: round to nearest 0.2 (ROUND(x*5)/5)
    // - default: round to nearest 0.2
    const sql = `
        SELECT
            stateMap.school AS name,
            block_statistics.grade AS grade,
            CASE WHEN '${escapedTable}' = 'elementary'
                 THEN ROUND(SUM(CAST(COALESCE(block_statistics.fte_students, 0) AS DOUBLE)) * 2.0) / 2.0
                 ELSE ROUND(SUM(CAST(COALESCE(block_statistics.fte_students, 0) AS DOUBLE)) * 5.0) / 5.0
            END AS fte_students,
            CASE WHEN '${escapedTable}' = 'elementary'
                 THEN ROUND(SUM(CAST(COALESCE(block_statistics.fte_residents, 0) AS DOUBLE)) * 2.0) / 2.0
                 ELSE ROUND(SUM(CAST(COALESCE(block_statistics.fte_residents, 0) AS DOUBLE)) * 5.0) / 5.0
            END AS fte_residents
        FROM data.block_statistics
            LEFT JOIN stateMap ON stateMap.block_of_residence = block_statistics.block_of_residence
        WHERE
            stateMap.school IS NOT NULL
            AND block_statistics.grade IS NOT NULL
            ${activeFilter}
        GROUP BY stateMap.school, block_statistics.grade
        ORDER BY stateMap.school, block_statistics.grade
    `;

    const rows = await runAggregate(sql);

    // Build mapping school -> { grade: fte }
    const map = new Map();
    (rows || []).forEach(r => {
        const school = r.name || r.school || '';
        const gradeRaw = r.grade;
        const gradeNum = Number.isFinite(Number(gradeRaw)) ? Number(gradeRaw) : null;
        if (gradeNum === null || Number.isNaN(gradeNum)) return;
        if (gradeNum < -1 || gradeNum > 12) return;
        const fte = r.fte_students === undefined || r.fte_students === null ? 0 : Number(r.fte_students);
        if (!map.has(school)) map.set(school, {});
        map.get(school)[gradeNum] = (map.get(school)[gradeNum] || 0) + (Number.isFinite(fte) ? fte : 0);
    });

    const result = Array.from(map.entries()).map(([name, gradesObj]) => ({ name, grades: gradesObj }));
    result.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    lastFteGradeStats = result;

    const modal = document.getElementById('enrollment-stats-modal');
    if (modal && modal.style.display === 'block') populateFteGradeLevelsTable(result);
    return result;
}

// Public calculations
export async function calculateStatistics() {
    const table = currentMapName();
    const escapedTable = sqlEscape(table);
    const activeFilter = buildActiveFilter();

    const sql = `
        SELECT
            stateMap.school AS name,
            SUM(COALESCE(block_statistics.students, 0)) AS students,
            SUM(COALESCE(block_statistics.residents, 0)) AS residents,
            max(schools.capacity) AS capacity,
            SUM(COALESCE(block_statistics.students, 0)) - max(schools.capacity) AS remaining
        FROM data.block_statistics
            LEFT JOIN stateMap ON stateMap.block_of_residence = block_statistics.block_of_residence
            LEFT JOIN stateSchool AS schools ON schools.name = stateMap.school
        where
            data.block_statistics.map = '${escapedTable}'
            ${activeFilter}
        GROUP BY stateMap.school
        ORDER BY stateMap.school
    `;

    const rows = await runAggregate(sql);
    const stats = normalizeRowsToStats(rows, { students: 'students', residents: 'residents', capacity: 'capacity', remaining: 'remaining' });
    lastStats = stats;

    const modal = document.getElementById('enrollment-stats-modal');
    if (modal && modal.style.display === 'block') populateModalTable(stats);
    return stats;
}

export async function calculateFTEStatistics() {
    const table = currentMapName();
    const escapedTable = sqlEscape(table);
    const activeFilter = buildActiveFilter();

    // fte_* fields in the DB are stored as DECIMAL(?,2). Some JS drivers/serializers
    // return fixed-point decimals as scaled integers (e.g. 12.34 -> 1234). Cast to
    // DOUBLE here so DuckDB returns normal floating point numbers to JS.
    // Apply rounding rules based on the selected map/table:
    // - For 'elementary': round up to the nearest integer (CEIL)
    // - Otherwise: round up to the nearest 0.20 (CEIL(x*5)/5)
    // We apply the rounding after aggregation using CASE so it's done server-side.
    const sql = `
        SELECT
            stateMap.school AS name,
            CASE WHEN '${escapedTable}' = 'elementary'
                 THEN CEIL(SUM(CAST(COALESCE(block_statistics.fte_students, 0) AS DOUBLE)))
                 ELSE CEIL(SUM(CAST(COALESCE(block_statistics.fte_students, 0) AS DOUBLE)) * 5.0) / 5.0
            END AS fte_students,
            CASE WHEN '${escapedTable}' = 'elementary'
                 THEN CEIL(SUM(CAST(COALESCE(block_statistics.fte_residents, 0) AS DOUBLE)))
                 ELSE CEIL(SUM(CAST(COALESCE(block_statistics.fte_residents, 0) AS DOUBLE)) * 5.0) / 5.0
            END AS fte_residents,
            CASE WHEN '${escapedTable}' = 'elementary'
                 THEN CEIL(MAX(CAST(schools.fte_capacity AS DOUBLE)))
                 ELSE CEIL(MAX(CAST(schools.fte_capacity AS DOUBLE)) * 5.0) / 5.0
            END AS fte_capacity,
            CASE WHEN '${escapedTable}' = 'elementary'
                 THEN CEIL(SUM(CAST(COALESCE(block_statistics.fte_students, 0) AS DOUBLE)) - MAX(CAST(schools.fte_capacity AS DOUBLE)))
                 ELSE CEIL((SUM(CAST(COALESCE(block_statistics.fte_students, 0) AS DOUBLE)) - MAX(CAST(schools.fte_capacity AS DOUBLE))) * 5.0) / 5.0
            END AS fte_remaining
        FROM data.block_statistics
            LEFT JOIN stateMap ON stateMap.block_of_residence = block_statistics.block_of_residence
            LEFT JOIN stateSchool AS schools ON schools.name = stateMap.school
        where
            data.block_statistics.map = '${escapedTable}'
            ${activeFilter}
        GROUP BY stateMap.school
        ORDER BY stateMap.school
    `;

    const rows = await runAggregate(sql);
    // Normalize from fte_* fields
    const stats = normalizeRowsToStats(rows, { students: 'fte_students', residents: 'fte_residents', capacity: 'fte_capacity', remaining: 'fte_remaining' });
    lastFteStats = stats;

    const modal = document.getElementById('enrollment-stats-modal');
    if (modal && modal.style.display === 'block') populateFteModalTable(stats);
    return stats;
}

// Modal + UI helpers
function mkTable(id, headers) {
    const table = document.createElement('table');
    table.id = id;
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';
    table.style.marginTop = '0px';

    const thead = document.createElement('thead');
    thead.id = `${id}-thead`;
    thead.innerHTML = `<tr>${headers.map(h => `<th style="text-align:${h.align};border-bottom:1px solid #ddd;padding:8px">${h.label}</th>`).join('')}</tr>`;
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    return table;
}

function clearAndFillTbody(selector, rows, rowRenderer) {
    const tbody = document.querySelector(selector);
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!rows || rows.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = 5;
        td.style.padding = '8px';
        td.style.fontStyle = 'italic';
        td.textContent = translate('noSchoolsAssigned') || 'No schools assigned';
        tr.appendChild(td);
        tbody.appendChild(tr);
        return;
    }
    rows.forEach(r => tbody.appendChild(rowRenderer(r)));
}

function createRowFromStat(s) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
        <td style="padding:8px;border-bottom:1px solid #f0f0f0">${s.name}</td>
        <td style="padding:8px;border-bottom:1px solid #f0f0f0;text-align:right">${s.residents.toLocaleString()}</td>
        <td style="padding:8px;border-bottom:1px solid #f0f0f0;text-align:right">${s.students.toLocaleString()}</td>
        <td style="padding:8px;border-bottom:1px solid #f0f0f0;text-align:right">${s.capacity.toLocaleString()}</td>
        <td style="padding:8px;border-bottom:1px solid #f0f0f0;text-align:right">${s.remaining.toLocaleString()}</td>
    `;
    return tr;
}

function populateModalTable(stats) {
    clearAndFillTbody('#enrollment-stats-table tbody', stats, createRowFromStat);
}

function populateFteModalTable(stats) {
    // defensive: accept either normalized stats or raw fte_* rows.
    const normalized = (stats || []).map(s => {
        return {
            name: s.name || s.school || '',
            residents: Number(s.residents ?? s.fte_residents ?? 0) || 0,
            students: Number(s.students ?? s.fte_students ?? 0) || 0,
            capacity: Number(s.capacity ?? s.fte_capacity ?? 0) || 0,
            remaining: Number(s.remaining ?? s.fte_remaining ?? (Number(s.students ?? s.fte_students ?? 0) - Number(s.capacity ?? s.fte_capacity ?? 0))) || 0
        };
    });
    clearAndFillTbody('#fte-stats-table tbody', normalized, createRowFromStat);
}

function createFloatingButtonAndModal() {
    if (document.getElementById('enrollment-stats-button')) return;

    const btn = document.createElement('button');
    btn.id = 'enrollment-stats-button';
    btn.textContent = translate('mapAnalysis') || 'Map Analysis';
    btn.classList.add('tool-list-button');
    btn.addEventListener('click', () => openModal());

    // place button gracefully into existing UI
    try {
        const reg = (typeof window !== 'undefined' && window.registerMappingToolButton) ? window.registerMappingToolButton : (typeof registerToolButton !== 'undefined' ? registerToolButton : null);
        if (reg && typeof reg === 'function') reg(btn, 'import-btn');
        else {
            const mappingControls = document.getElementById('map-editor-controls');
            const importBtn = document.getElementById('import-btn');
            if (mappingControls) {
                if (importBtn && importBtn.parentElement) importBtn.parentElement.insertBefore(btn, importBtn.nextSibling);
                else mappingControls.appendChild(btn);
            } else {
                const mapSelector = document.getElementById('map-selector');
                if (mapSelector && mapSelector.parentElement) mapSelector.parentElement.appendChild(btn);
                else {
                    const left = document.getElementById('left-column');
                    if (left) {
                        const importExport = document.getElementById('import-export');
                        if (importExport) left.insertBefore(btn, importExport);
                        else left.appendChild(btn);
                    } else document.body.appendChild(btn);
                }
            }
        }
    } catch (e) {
        const left = document.getElementById('left-column');
        if (left) {
            const importExport = document.getElementById('import-export');
            if (importExport) left.insertBefore(btn, importExport);
            else left.appendChild(btn);
        } else document.body.appendChild(btn);
    }

    // Modal overlay
    const overlay = document.createElement('div');
    overlay.id = 'enrollment-stats-modal';
    overlay.style.position = 'fixed';
    overlay.style.left = '0';
    overlay.style.top = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.background = 'rgba(0,0,0,0.4)';
    overlay.style.display = 'none';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.zIndex = 10001;

    const modalBox = document.createElement('div');
    modalBox.style.width = '720px';
    modalBox.style.maxWidth = '95%';
    modalBox.style.maxHeight = '80%';
    modalBox.style.overflow = 'auto';
    modalBox.style.background = 'white';
    modalBox.style.borderRadius = '8px';
    modalBox.style.padding = '18px';
    modalBox.style.boxShadow = '0 6px 20px rgba(0,0,0,0.3)';
    modalBox.style.position = 'relative';

    const styleEl = document.createElement('style');
    styleEl.textContent = `
    .stats-tab-list { display:flex; gap:8px; align-items:flex-end; margin-bottom:8px; border-bottom:1px solid #e6e6e6; }
    .stats-tab-button { background:#f3f3f3; border:1px solid #ddd; padding:6px 12px; border-radius:6px 6px 0 0; cursor:pointer; color:#333; font-weight:600; position:relative; box-shadow:0 2px 6px rgba(0,0,0,0.04); margin-bottom:-1px; }
    .stats-tab-button.active { background:white; border-bottom-color: white; margin-bottom:-1px; box-shadow:0 8px 24px rgba(0,0,0,0.08); z-index:2; }
    .stats-tab-button:focus { outline:2px solid rgba(0,120,215,0.25); }
    .stats-tab-content { padding-top:8px; }
    .modal-close-button { position:absolute; top:12px; right:12px; background:#f5f5f5; border:1px solid #ccc; border-radius:6px; padding:6px 10px; cursor:pointer; }
    .modal-close-button:hover { background:#eee; }
    `;
    modalBox.appendChild(styleEl);

    const title = document.createElement('h2');
    title.textContent = translate('mapAnalysis') || 'Map Analysis';
    modalBox.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.id = 'enrollment-stats-close';
    closeBtn.className = 'modal-close-button';
    closeBtn.type = 'button';
    closeBtn.textContent = translate('close') || 'Close';
    closeBtn.addEventListener('click', () => closeModal());
    modalBox.appendChild(closeBtn);

    const tabsWrapper = document.createElement('div');
    tabsWrapper.className = 'stats-tabs-wrapper';

    const tabList = document.createElement('div');
    tabList.className = 'stats-tab-list';
    tabList.style.display = 'flex';
    tabList.style.gap = '8px';

    const enrollmentTabBtn = document.createElement('button');
    enrollmentTabBtn.className = 'stats-tab-button active';
    enrollmentTabBtn.type = 'button';
    enrollmentTabBtn.textContent = translate('total') || 'Total';
    enrollmentTabBtn.style.padding = '6px 10px';
    tabList.appendChild(enrollmentTabBtn);

    const gradeTabBtn = document.createElement('button');
    gradeTabBtn.className = 'stats-tab-button';
    gradeTabBtn.type = 'button';
    gradeTabBtn.textContent = translate('gradeLevels') || 'Grade';
    gradeTabBtn.style.padding = '6px 10px';
    tabList.appendChild(gradeTabBtn);

    const fteTabBtn = document.createElement('button');
    fteTabBtn.className = 'stats-tab-button';
    fteTabBtn.type = 'button';
    fteTabBtn.textContent = translate('FTE') || 'FTE';
    fteTabBtn.style.padding = '6px 10px';
    tabList.appendChild(fteTabBtn);

    const fteGradeTabBtn = document.createElement('button');
    fteGradeTabBtn.className = 'stats-tab-button';
    fteGradeTabBtn.type = 'button';
    fteGradeTabBtn.textContent = translate('fteByGrade') || 'FTE by Grade';
    fteGradeTabBtn.style.padding = '6px 10px';
    tabList.appendChild(fteGradeTabBtn);

    const tabContent = document.createElement('div');
    tabContent.className = 'stats-tab-content';

    // Enrollment panel
    const enrollmentPanel = document.createElement('div');
    enrollmentPanel.className = 'stats-tab-panel';
    enrollmentPanel.id = 'tab-enrollment';
    enrollmentPanel.style.display = 'block';

    const enrollmentTable = mkTable('enrollment-stats-table', [
        { label: translate('name') || 'School', align: 'left' },
        { label: translate('residents') || 'Residents', align: 'right' },
        { label: translate('students') || 'Students', align: 'right' },
        { label: translate('enrollment2025') || '2025 Enrollment', align: 'right' },
        { label: translate('remainingSpace') || 'Change', align: 'right' }
    ]);
    enrollmentPanel.appendChild(enrollmentTable);
    tabContent.appendChild(enrollmentPanel);

    // FTE panel
    const ftePanel = document.createElement('div');
    ftePanel.className = 'stats-tab-panel';
    ftePanel.id = 'tab-fte';
    ftePanel.style.display = 'none';

    const fteTable = mkTable('fte-stats-table', [
        { label: translate('name') || 'School', align: 'left' },
        { label: translate('fte_residents') || 'Residents FTEs', align: 'right' },
        { label: translate('fte_students') || 'Students FTEs', align: 'right' },
        { label: translate('fte_2025') || '2025 FTEs', align: 'right' },
        { label: translate('fte_remainingSpace') || 'Change', align: 'right' }
    ]);
    ftePanel.appendChild(fteTable);
    tabContent.appendChild(ftePanel);

    // Grade Levels panel
    const gradePanel = document.createElement('div');
    gradePanel.className = 'stats-tab-panel';
    gradePanel.id = 'tab-grade-levels';
    gradePanel.style.display = 'none';

    // table will be built dynamically because headers depend on selected map
    const gradeWrapper = document.createElement('div');
    gradeWrapper.id = 'grade-levels-wrapper';
    const gradeTable = document.createElement('table');
    gradeTable.id = 'grade-levels-stats-table';
    gradeTable.style.width = '100%';
    gradeTable.style.borderCollapse = 'collapse';
    gradeTable.style.marginTop = '0px';
    const gradeThead = document.createElement('thead');
    gradeThead.id = 'grade-levels-stats-thead';
    gradeTable.appendChild(gradeThead);
    const gradeTbody = document.createElement('tbody');
    gradeTable.appendChild(gradeTbody);
    gradeWrapper.appendChild(gradeTable);
    gradePanel.appendChild(gradeWrapper);
    tabContent.appendChild(gradePanel);

    // FTE by Grade Levels panel
    const fteGradePanel = document.createElement('div');
    fteGradePanel.className = 'stats-tab-panel';
    fteGradePanel.id = 'tab-fte-grade-levels';
    fteGradePanel.style.display = 'none';

    const fteGradeWrapper = document.createElement('div');
    fteGradeWrapper.id = 'fte-grade-levels-wrapper';
    const fteGradeTable = document.createElement('table');
    fteGradeTable.id = 'fte-grade-levels-stats-table';
    fteGradeTable.style.width = '100%';
    fteGradeTable.style.borderCollapse = 'collapse';
    fteGradeTable.style.marginTop = '0px';
    const fteGradeThead = document.createElement('thead');
    fteGradeThead.id = 'fte-grade-levels-stats-thead';
    fteGradeTable.appendChild(fteGradeThead);
    const fteGradeTbody = document.createElement('tbody');
    fteGradeTable.appendChild(fteGradeTbody);
    fteGradeWrapper.appendChild(fteGradeTable);
    fteGradePanel.appendChild(fteGradeWrapper);
    tabContent.appendChild(fteGradePanel);

    tabsWrapper.appendChild(tabList);
    tabsWrapper.appendChild(tabContent);
    modalBox.appendChild(tabsWrapper);
    overlay.appendChild(modalBox);

    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
    document.body.appendChild(overlay);

    // populate with cached stats if available
    populateModalTable(lastStats);
    populateFteModalTable(lastFteStats);

    // tab handlers
    enrollmentTabBtn.addEventListener('click', () => {
        tabList.querySelectorAll('.stats-tab-button').forEach(b => b.classList.remove('active'));
        enrollmentTabBtn.classList.add('active');
        tabContent.querySelectorAll('.stats-tab-panel').forEach(p => p.style.display = 'none');
        enrollmentPanel.style.display = 'block';
    });

    fteTabBtn.addEventListener('click', () => {
        tabList.querySelectorAll('.stats-tab-button').forEach(b => b.classList.remove('active'));
        fteTabBtn.classList.add('active');
        tabContent.querySelectorAll('.stats-tab-panel').forEach(p => p.style.display = 'none');
        ftePanel.style.display = 'block';
        calculateFTEStatistics().then(populateFteModalTable).catch(err => console.error('Failed to calculate FTE stats', err));
    });

    gradeTabBtn.addEventListener('click', () => {
        tabList.querySelectorAll('.stats-tab-button').forEach(b => b.classList.remove('active'));
        gradeTabBtn.classList.add('active');
        tabContent.querySelectorAll('.stats-tab-panel').forEach(p => p.style.display = 'none');
        gradePanel.style.display = 'block';
        // build headers based on current map
        const mapName = currentMapName();
        const grades = getGradeRangeForMap(mapName);
        buildGradeTableHeader(grades);
        // populate skeleton while loading
        clearAndFillTbody('#grade-levels-stats-table tbody', [], () => {
            const tr = document.createElement('tr');
            const td = document.createElement('td');
            td.colSpan = 5;
            td.style.padding = '8px';
            td.textContent = translate('loading') || 'Loading...';
            tr.appendChild(td);
            return tr;
        });
        calculateGradeLevelStatistics().then(populateGradeLevelsTable).catch(err => console.error('Failed to calculate grade stats', err));
    });

    fteGradeTabBtn.addEventListener('click', () => {
        tabList.querySelectorAll('.stats-tab-button').forEach(b => b.classList.remove('active'));
        fteGradeTabBtn.classList.add('active');
        tabContent.querySelectorAll('.stats-tab-panel').forEach(p => p.style.display = 'none');
        fteGradePanel.style.display = 'block';
        // build headers based on current map
        const mapName = currentMapName();
        const grades = getGradeRangeForMap(mapName);
        buildFteGradeTableHeader(grades);
        // populate skeleton while loading
        clearAndFillTbody('#fte-grade-levels-stats-table tbody', [], () => {
            const tr = document.createElement('tr');
            const td = document.createElement('td');
            td.colSpan = 5;
            td.style.padding = '8px';
            td.textContent = translate('loading') || 'Loading...';
            tr.appendChild(td);
            return tr;
        });
        calculateGradeLevelFTEStatistics().then(populateFteGradeLevelsTable).catch(err => console.error('Failed to calculate grade FTE stats', err));
    });
}

// language updates
if (typeof window !== 'undefined') {
    window.addEventListener('languagechange', () => {
        const btn = document.getElementById('enrollment-stats-button');
        if (btn) btn.textContent = translate('mapAnalysis') || btn.textContent;

        const modal = document.getElementById('enrollment-stats-modal');
        if (modal && modal.style.display === 'flex') {
            const title = modal.querySelector('h2'); if (title) title.textContent = translate('enrollmentStatistics') || title.textContent;
            const closeBtn = modal.querySelector('#enrollment-stats-close'); if (closeBtn) closeBtn.textContent = translate('close') || closeBtn.textContent;
            calculateStatistics().then(populateModalTable).catch(err => console.error('Failed to recalc stats', err));
            const ftePanel = modal.querySelector('#tab-fte');
            if (ftePanel && ftePanel.style.display === 'block') calculateFTEStatistics().then(populateFteModalTable).catch(err => console.error('Failed to recalc FTE stats', err));
                const gradePanel = modal.querySelector('#tab-grade-levels');
                if (gradePanel && gradePanel.style.display === 'block') {
                    const grades = getGradeRangeForMap(currentMapName());
                    buildGradeTableHeader(grades);
                    calculateGradeLevelStatistics().then(populateGradeLevelsTable).catch(err => console.error('Failed to recalc grade stats', err));
                }
                const fteGradePanel = modal.querySelector('#tab-fte-grade-levels');
                if (fteGradePanel && fteGradePanel.style.display === 'block') {
                    const grades = getGradeRangeForMap(currentMapName());
                    buildFteGradeTableHeader(grades);
                    calculateGradeLevelFTEStatistics().then(populateFteGradeLevelsTable).catch(err => console.error('Failed to recalc grade FTE stats', err));
                }
        }

        // update thead labels if present
        const theadEl = document.getElementById('enrollment-stats-table-thead') || document.getElementById('enrollment-stats-thead');
        if (theadEl) {
            theadEl.innerHTML = `<tr>
                <th style="text-align:left;border-bottom:1px solid #ddd;padding:8px">${translate('name') || 'School'}</th>
                <th style="text-align:right;border-bottom:1px solid #ddd;padding:8px">${translate('residents') || 'Residents'}</th>
                <th style="text-align:right;border-bottom:1px solid #ddd;padding:8px">${translate('students') || 'Students'}</th>
                <th style="text-align:right;border-bottom:1px solid #ddd;padding:8px">${translate('enrollment2025') || '2025 Enrollment'}</th>
                <th style="text-align:right;border-bottom:1px solid #ddd;padding:8px">${translate('remainingSpace') || 'Change'}</th>
            </tr>`;
        }

        const ftheadEl = document.getElementById('fte-stats-table-thead') || document.getElementById('fte-stats-thead');
        if (ftheadEl) {
            ftheadEl.innerHTML = `<tr>
                <th style="text-align:left;border-bottom:1px solid #ddd;padding:8px">${translate('name') || 'School'}</th>
                <th style="text-align:right;border-bottom:1px solid #ddd;padding:8px">${translate('fte_residents') || 'Residents FTEs'}</th>
                <th style="text-align:right;border-bottom:1px solid #ddd;padding:8px">${translate('fte_students') || 'Students FTEs'}</th>
                <th style="text-align:right;border-bottom:1px solid #ddd;padding:8px">${translate('fte_2025') || '2025 FTEs'}</th>
                <th style="text-align:right;border-bottom:1px solid #ddd;padding:8px">${translate('fte_remainingSpace') || 'Change'}</th>
            </tr>`;
        }
        const gtheadEl = document.getElementById('grade-levels-stats-thead') || document.getElementById('grade-levels-thead');
        if (gtheadEl) {
            // rebuild based on current map
            const grades = getGradeRangeForMap(currentMapName());
            buildGradeTableHeader(grades);
        }
        const fgteadEl = document.getElementById('fte-grade-levels-stats-thead') || document.getElementById('fte-grade-levels-thead');
        if (fgteadEl) {
            const grades = getGradeRangeForMap(currentMapName());
            buildFteGradeTableHeader(grades);
        }
    });
}

function buildGradeTableHeader(grades) {
    const thead = document.getElementById('grade-levels-stats-thead');
    if (!thead) return;
    // First column: School name; second column: Total enrollment; then each grade column
    const headers = [
        { label: translate('name') || 'School', align: 'left' },
        { label: translate('enrollment') || 'Total', align: 'right' }
    ].concat((grades || []).map(g => {
        let label = String(g);
        if (Number(g) === -1) label = translate('TK') || 'TK';
        else if (Number(g) === 0) label = translate('K') || 'K';
        return { label, align: 'right' };
    }));
    thead.innerHTML = `<tr>${headers.map(h => `<th style="text-align:${h.align};border-bottom:1px solid #ddd;padding:8px">${h.label}</th>`).join('')}</tr>`;
}

function buildFteGradeTableHeader(grades) {
    const thead = document.getElementById('fte-grade-levels-stats-thead');
    if (!thead) return;
    const headers = [
        { label: translate('name') || 'School', align: 'left' },
        { label: translate('total') || 'Total', align: 'right' }
    ].concat((grades || []).map(g => {
        let label = String(g);
        if (Number(g) === -1) label = translate('TK') || 'TK';
        else if (Number(g) === 0) label = translate('K') || 'K';
        return { label, align: 'right' };
    }));
    thead.innerHTML = `<tr>${headers.map(h => `<th style="text-align:${h.align};border-bottom:1px solid #ddd;padding:8px">${h.label}</th>`).join('')}</tr>`;
}

function populateFteGradeLevelsTable(rows) {
    // rows: [{ name, grades: { gradeNum: fte, ... } }, ...]
    const grades = getGradeRangeForMap(currentMapName());
    const tbody = document.querySelector('#fte-grade-levels-stats-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!rows || rows.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = (grades ? (1 + 1 + grades.length) : 2);
        td.style.padding = '8px';
        td.style.fontStyle = 'italic';
        td.textContent = translate('noSchoolsAssigned') || 'No schools assigned';
        tr.appendChild(td);
        tbody.appendChild(tr);
        return;
    }

    rows.forEach(r => {
        const tr = document.createElement('tr');
        const nameTd = document.createElement('td');
        nameTd.style.padding = '8px';
        nameTd.style.borderBottom = '1px solid #f0f0f0';
        nameTd.textContent = r.name || '';
        tr.appendChild(nameTd);
        const total = (grades || []).reduce((acc, g) => acc + (r.grades && Object.prototype.hasOwnProperty.call(r.grades, g) ? Number(r.grades[g]) || 0 : 0), 0);
        const totalTd = document.createElement('td');
        totalTd.style.padding = '8px';
        totalTd.style.borderBottom = '1px solid #f0f0f0';
        totalTd.style.textAlign = 'right';
        // show decimals for FTEs but use locale formatting
        totalTd.textContent = Number(total).toLocaleString();
        tr.appendChild(totalTd);
        (grades || []).forEach(g => {
            const td = document.createElement('td');
            td.style.padding = '8px';
            td.style.borderBottom = '1px solid #f0f0f0';
            td.style.textAlign = 'right';
            const val = (r.grades && Object.prototype.hasOwnProperty.call(r.grades, g)) ? (Number(r.grades[g]) || 0) : 0;
            td.textContent = Number(val).toLocaleString();
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
}

function populateGradeLevelsTable(rows) {
    // rows: [{ name, grades: { gradeNum: sum, ... } }, ...]
    const grades = getGradeRangeForMap(currentMapName());
    const tbody = document.querySelector('#grade-levels-stats-table tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!rows || rows.length === 0) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        // columns = name + total + grades
        td.colSpan = (grades ? (1 + 1 + grades.length) : 2);
        td.style.padding = '8px';
        td.style.fontStyle = 'italic';
        td.textContent = translate('noSchoolsAssigned') || 'No schools assigned';
        tr.appendChild(td);
        tbody.appendChild(tr);
        return;
    }

    rows.forEach(r => {
        const tr = document.createElement('tr');
        // first cell: school name
        const nameTd = document.createElement('td');
        nameTd.style.padding = '8px';
        nameTd.style.borderBottom = '1px solid #f0f0f0';
        nameTd.textContent = r.name || '';
        tr.appendChild(nameTd);
        // second cell: total enrollment across displayed grades
        const total = (grades || []).reduce((acc, g) => acc + (r.grades && Object.prototype.hasOwnProperty.call(r.grades, g) ? Number(r.grades[g]) || 0 : 0), 0);
        const totalTd = document.createElement('td');
        totalTd.style.padding = '8px';
        totalTd.style.borderBottom = '1px solid #f0f0f0';
        totalTd.style.textAlign = 'right';
        totalTd.textContent = total.toLocaleString();
        tr.appendChild(totalTd);
        // grade cells
        (grades || []).forEach(g => {
            const td = document.createElement('td');
            td.style.padding = '8px';
            td.style.borderBottom = '1px solid #f0f0f0';
            td.style.textAlign = 'right';
            const val = (r.grades && Object.prototype.hasOwnProperty.call(r.grades, g)) ? (Number(r.grades[g]) || 0) : 0;
            td.textContent = val.toLocaleString();
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
}

// Feature-level stats modal
// distance is read from the precomputed `data.distances` table

function ensureFeatureModalElements() {
    if (document.getElementById('feature-stats-modal')) return;
    const overlay = document.createElement('div');
    overlay.id = 'feature-stats-modal';
    overlay.style.position = 'fixed';
    overlay.style.left = '0';
    overlay.style.top = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.background = 'rgba(0,0,0,0.35)';
    overlay.style.display = 'none';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.zIndex = 10002;

    const box = document.createElement('div');
    box.id = 'feature-stats-box';
    box.style.width = '420px';
    box.style.maxWidth = '95%';
    box.style.background = 'white';
    box.style.borderRadius = '8px';
    box.style.padding = '14px';
    box.style.boxShadow = '0 6px 18px rgba(0,0,0,0.2)';
    box.style.position = 'relative';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = translate('close') || 'Close';
    closeBtn.style.position = 'absolute';
    closeBtn.style.top = '10px';
    closeBtn.style.right = '10px';
    closeBtn.addEventListener('click', () => { overlay.style.display = 'none'; });
    box.appendChild(closeBtn);

    const title = document.createElement('h3');
    title.id = 'feature-stats-title';
    title.style.marginTop = '0';
    box.appendChild(title);

    const content = document.createElement('div');
    content.id = 'feature-stats-content';
    content.style.marginTop = '8px';
    box.appendChild(content);

    overlay.appendChild(box);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.style.display = 'none'; });
    document.body.appendChild(overlay);
}

export async function showBlockStatistics(feature, latlng = null) {
    try {
        ensureFeatureModalElements();
        const overlay = document.getElementById('feature-stats-modal');
        const titleEl = document.getElementById('feature-stats-title');
        const contentEl = document.getElementById('feature-stats-content');
        if (!feature || !feature.properties) {
            // If a latlng was provided and Leaflet is available, show a simple popup
            if (latlng && typeof L !== 'undefined' && state && state.map) {
                L.popup().setLatLng(latlng).setContent(translate('noData') || 'No data').openOn(state.map);
                return;
            }
            titleEl.textContent = translate('noData') || 'No data';
            contentEl.textContent = '';
            overlay.style.display = 'flex';
            return;
        }

        const blockId = feature.properties.block_of_residence || feature.properties.GEOID20 || feature.properties.id || null;
        if (!blockId) {
            titleEl.textContent = translate('noId') || 'Unknown block';
            contentEl.textContent = '';
            overlay.style.display = 'flex';
            return;
        }

        titleEl.textContent = `${translate('block') || 'Block'}: ${String(blockId)}`;
        // Decide whether to use a Leaflet popup (preferred when we have click latlng)
        const usePopup = (latlng && typeof L !== 'undefined' && state && state.map);
        let popup = null;
        if (usePopup) {
            try {
                popup = L.popup({ maxWidth: 360 }).setLatLng(latlng).setContent(`${translate('loading') || 'Loading...'}`).openOn(state.map);
            } catch (e) {
                popup = null;
            }
        }
        // If not using popup, show modal overlay with loading text
        if (!popup) {
            contentEl.innerHTML = `<div style="padding:6px 0">${translate('loading') || 'Loading...'}</div>`;
            overlay.style.display = 'flex';
        }

        const conn = await getConnection();
        const table = currentMapName();
        const escapedTable = sqlEscape(table);
        const escapedBlock = sqlEscape(blockId);

        // Query block statistics row (students/residents)
        let statsRow = null;
        try {
            const rows = await runQuery(conn, `SELECT students, residents FROM data.block_statistics WHERE block_of_residence = '${escapedBlock}' AND map = '${escapedTable}' LIMIT 1;`);
            if (rows && rows.length > 0) statsRow = rows[0];
        } catch (e) {
            console.warn('block_statistics lookup failed', e);
        }

        // assigned school
        let assigned = null;
        try {
            const sm = await runQuery(conn, `SELECT school FROM stateMap WHERE block_of_residence = '${escapedBlock}' LIMIT 1;`);
            if (sm && sm.length > 0) assigned = sm[0].school || null;
        } catch (e) { console.warn('stateMap lookup failed', e); }

        // Query precomputed distances from data.distances using assigned school & block
        let distanceStr = translate('n_a') || 'N/A';
        let drivingDistanceStr = translate('n_a') || 'N/A';
        let drivingTimeStr = translate('n_a') || 'N/A';
        if (assigned) {
            try {
                const drows = await runQuery(conn, `SELECT distance, driving_distance / 1609.344 as driving_distance, driving_time FROM data.distances WHERE block_of_residence = '${escapedBlock}' AND school = '${sqlEscape(assigned)}' LIMIT 1;`);
                if (drows && drows.length > 0) {
                    const d = drows[0];
                    if (d.distance != null) {
                        const milesVal = Number(d.distance);
                        if (!Number.isNaN(milesVal)) distanceStr = `${milesVal.toFixed(2)} ${translate('miles') || 'mi'}`;
                    }
                    if (d.driving_distance != null) {
                        const driving_distance = Number(d.driving_distance);
                        if (!Number.isNaN(driving_distance)) {
                            drivingDistanceStr = `${driving_distance.toFixed(2)} ${translate('miles') || 'mi'}`;
                        }
                    }
                    if (d.driving_time != null) {
                        // driving_time stored in minutes (may be fractional). Round to nearest 15s and display as Xm Ys
                        const minutesVal = Number(d.driving_time);
                        if (!Number.isNaN(minutesVal)) {
                            let totalSeconds = Math.round(minutesVal * 60);
                            // round to nearest 15 seconds
                            totalSeconds = Math.round(totalSeconds / 15) * 15;
                            const mins = Math.floor(totalSeconds / 60);
                            const secs = totalSeconds % 60;
                            drivingTimeStr = `${mins}m ${String(secs).padStart(2, '0')}s`;
                        }
                    }
                }
            } catch (e) { console.warn('distances lookup failed', e); }
        }

        // Build content
        const assignedLabel = translate('assignedSchool') || 'Assigned school';
        const studentsLabel = translate('students') || 'Students';
        const residentsLabel = translate('residents') || 'Residents';
        const distanceLabel = translate('distance') || 'Distance';
        const drivingDistanceLabel = translate('driving_distance') || 'Driving distance';
        const drivingTimeLabel = translate('driving_time') || 'Driving time';

        const studentsVal = statsRow && (statsRow.students != null) ? Number(statsRow.students).toLocaleString() : (translate('unknown') || 'Unknown');
        const residentsVal = statsRow && (statsRow.residents != null) ? Number(statsRow.residents).toLocaleString() : (translate('unknown') || 'Unknown');
        const schoolVal = assigned || (translate('unassigned') || 'Unassigned');

        const htmlContent = `
            <div style="display:flex;flex-direction:column;gap:6px;font-size:14px;">
                <div><strong>${assignedLabel}:</strong> ${schoolVal}</div>
                <div><strong>${studentsLabel}:</strong> ${studentsVal}</div>
                <div><strong>${residentsLabel}:</strong> ${residentsVal}</div>
                <div><strong>${distanceLabel}:</strong> ${distanceStr}</div>
                <div><strong>${drivingDistanceLabel}:</strong> ${drivingDistanceStr}</div>
                <div><strong>${drivingTimeLabel}:</strong> ${drivingTimeStr}</div>
            </div>
        `;

        // If we opened a popup, update it and return (do not show modal)
        const appendedId = `${titleEl.id}-block_of_residence`;
        const appendedHtml = `<div id="${appendedId}" style="margin-top:8px;font-size:12px;color:#444"><strong>${translate('block_of_residence') || 'ID'}:</strong> ${String(blockId)}</div>`;

        if (popup) {
            try { popup.setContent(htmlContent + appendedHtml); } catch (e) { console.warn('Failed updating popup content', e); }
            return;
        }

        // Otherwise populate the modal overlay and append the block_of_residence id
    contentEl.innerHTML = htmlContent + appendedHtml;

    } catch (err) {
        console.error('showBlockStatistics failed', err);
    }
}

function openModal() {
    createFloatingButtonAndModal();
    const modal = document.getElementById('enrollment-stats-modal');
    if (modal) {
        populateModalTable([]);
        populateFteModalTable([]);
        // prepare grade levels header and cached content
        const grades = getGradeRangeForMap(currentMapName());
        buildGradeTableHeader(grades);
        populateGradeLevelsTable(lastGradeStats);
        buildFteGradeTableHeader(grades);
        populateFteGradeLevelsTable(lastFteGradeStats);
        modal.style.display = 'flex';
        calculateStatistics().then(populateModalTable).catch(err => console.error('Failed to calculate stats', err));
        const ftePanel = modal.querySelector('#tab-fte');
        if (ftePanel && ftePanel.style.display === 'block') calculateFTEStatistics().then(populateFteModalTable).catch(err => console.error('Failed to calculate FTE stats', err));
    }
}

function closeModal() {
    const modal = document.getElementById('enrollment-stats-modal');
    if (modal) modal.style.display = 'none';
}

// initialize button/modal on module load
if (typeof window !== 'undefined') {
    window.addEventListener('load', () => { try { createFloatingButtonAndModal(); } catch (e) { console.error(e); } });
}

export { openModal, closeModal };

