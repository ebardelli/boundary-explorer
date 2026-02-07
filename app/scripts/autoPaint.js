import { state, replaceStateSchools } from './state.js';
import { paintBlock } from './paint.js';
import { getConnection, initDuckDB, runQuery, upsertRows } from './duckdb.js';

export async function createAutoPaintControl() {
    const autoPaintDiv = document.createElement('div');
    autoPaintDiv.innerHTML = `
        <h2>Auto Paint</h2>
        <div style="margin-bottom: 10px;">
            <label for="optimization-select">Block Prioritization</label>
            <select id="optimization-select" style="width: 100%; padding: 8px; margin-top: 4px;">
                <option value="driving_distance">Driving Distance</option>
                <option value="distance">Radius Distance</option>
                <option value="driving_time">Driving Time</option>
            </select>
        </div>
        <div style="margin-bottom: 10px;">
            <label for="capacity-select">Capacity Constraint</label>
            <select id="capacity-select" style="width: 100%; padding: 8px; margin-top: 4px;">
                <option value="percentage">Balance Capacity Percentage</option>
                <option value="enrollment">Balance Enrollment Count</option>
                <option value="nothing">No Restrictions</option>
            </select>
        </div>
        <button id="auto-paint-btn" style="width: 100%; padding: 8px;">Auto Assign Blocks</button>
    `;
    document.getElementById('auto-paint').appendChild(autoPaintDiv);

    const autoPaintBtn = document.getElementById('auto-paint-btn');
    const blockSelect = document.getElementById('optimization-select');
    const capacitySelect = document.getElementById('capacity-select');
    let isProcessing = false;

    // Use the shared mapping tools status element for progress messages so all
    // mapping tools show messages in the same place. Look up the element at
    // runtime (it may be created after this module is loaded). Do NOT fall
    // back to changing the button label; the button will simply be disabled
    // (greyed) while processing.
    function setStatus(message) {
        try {
            const statusEl = document.getElementById('merge-status');
            if (statusEl) statusEl.textContent = message;
        } catch (e) {
            // ignore if DOM not ready
        }
    }
    function updateButtonState() {
        autoPaintBtn.disabled = isProcessing;
        try { autoPaintBtn.setAttribute('aria-busy', isProcessing ? 'true' : 'false'); } catch (e) { }
    }

    async function autoPaint() {
        if (!state.activeSchools || !state.geojsonLayer || !state.schools) return;
        if (isProcessing) return;
        isProcessing = true; updateButtonState(); setStatus('Initializing...');

        try {
            const blockOptimization = blockSelect.value;
            const capacityOptimization = capacitySelect.value;
            const totalBlocks = state.geojsonLayer.getLayers().length;

            let schoolDataMap = Array.from(state.activeSchools).map(school => ({
                school,
                data: state.schools.get(school),
                currentEnrollment: 0,
                capacity: state.schools.get(school)?.capacity || 0,
                assignedFeatures: []
            }));

            // initialize or reuse shared DuckDB instance
            await initDuckDB();
            const conn = await getConnection();


            // Create status table with explicit schema and primary key so upserts can target `block`.
            await runQuery(conn, `CREATE OR REPLACE TABLE status (block VARCHAR PRIMARY KEY, school VARCHAR, enrollment INTEGER);`);
            await runQuery(conn, `INSERT INTO status (block, school, enrollment) SELECT block_of_residence as block, CAST(NULL AS VARCHAR) as school, 0 as enrollment FROM data.${state.currentTable};`);

            updateButtonState(); setStatus('Assigning initial blocks...');
            let initialAssigned = 0;
            for (const activeSchool of schoolDataMap) {
                // Ensure the temporary stateSchool table exists and is populated
                // from the in-memory `state.schools` map so SQL below can reference
                // `stateSchool` safely.
                try { await replaceStateSchools(conn); } catch (e) { /* non-fatal */ }

                const rows = await runQuery(conn, `
                SELECT
                    block_of_residence
                FROM
                    data.${state.currentTable} AS map 
                    CROSS JOIN (        
                            SELECT
                                *
                            FROM
                                stateSchool
                    UNION ALL
                        SELECT
                            name,
                            latitude,
                            longitude,
                            NULL AS color,
                            capacity,
                            fte_capacity
                        FROM
                            data.schools
                            WHERE NOT EXISTS (SELECT
                                1
                            FROM
                                stateSchool
                            WHERE stateSchool.name = data.schools.name)
                    ) AS schools
                WHERE schools.name LIKE '${activeSchool.school}' AND st_contains(map.geom, st_point(schools.longitude, schools.latitude));
                `);
                for (const row of rows) {
                    await upsertRows(conn, 'status', { block: row.block_of_residence, school: activeSchool.school, enrollment: 0 }, 'block');
                    paintBlock(activeSchool.school, row.block_of_residence);
                    initialAssigned++;
                }
            }
            console.debug('autoPaint: initialAssigned blocks =', initialAssigned);

            setStatus('Optimizing block assignment...');
            let iterationCount = 0;
            while (true) {
                // Continue attempting assignments until the query explicitly returns
                // no candidate (null/undefined `block`). We previously stopped when
                // iterationCount reached totalBlocks which could prematurely end
                // the loop if a school ran out of capacity while other blocks
                // remained unassigned. Keep a counter for diagnostics but do not
                // use it as a stopping condition.
                // Ensure stateSchool is up-to-date before each optimization step
                // in case school metadata changed during processing.
                try { await replaceStateSchools(conn); } catch (e) { /* non-fatal */ }

                let rows = await runQuery(conn, `
                WITH
                    current_enrollment
                    AS
                    (
                        SELECT
                            status.school,
                            sum(map.residents) AS enrollment,
                            schools.capacity AS capacity
                        FROM
                            status JOIN data.${state.currentTable} AS map ON map.block_of_residence = status.block JOIN
                            (
                            SELECT
                                *
                            FROM
                                stateSchool
                            UNION ALL
                                SELECT
                                    name,
                                    latitude,
                                    longitude,
                                    NULL AS color,
                                    capacity,
                                    fte_capacity
                                FROM
                                    data.schools
                                WHERE NOT EXISTS (SELECT
                                    1
                                FROM
                                    stateSchool
                                WHERE stateSchool.name = data.schools.name))
                            AS schools ON schools.name = status.school WHERE school IS NOT NULL GROUP BY ALL), block_candidates AS
                            (SELECT
                                current_enrollment.school,
                                current_enrollment.enrollment,
                                current_enrollment.capacity,
                                adjecent_block AS block
                            FROM
                                data.${state.currentTable}_adjacency CROSS JOIN current_enrollment WHERE block_of_residence IN
                            (SELECT
                                block
                            FROM
                                status
                            WHERE school = current_enrollment.school)
                            AND adjecent_block IN
                            (SELECT
                                block
                            FROM
                                status
                            WHERE school IS NULL)
                            )
                            SELECT
                                block_candidates.school,
                                block_candidates.enrollment,
                                block_candidates.block,
                                distances.distance,
                                distances.driving_distance,
                                distances.driving_time
                            FROM
                                block_candidates JOIN data.distances ON distances.school = block_candidates.school AND distances.block_of_residence = block_candidates.block
                            WHERE CASE WHEN '${capacityOptimization}' = 'percentage' THEN (enrollment / capacity) <= 1.0
                            WHEN '${capacityOptimization}' = 'enrollment' THEN enrollment <= capacity ELSE true
                            END ORDER BY CASE WHEN '${capacityOptimization}' = 'percentage' THEN
                            (enrollment / capacity) WHEN '${capacityOptimization}' = 'enrollment' THEN enrollment ELSE 1
                            END, distances.${blockOptimization} limit 1    
                `);
                console.debug('autoPaint: iteration', iterationCount, 'initial rows length =', Array.isArray(rows) ? rows.length : String(rows));
                // If no candidate found due to capacity constraints, try a
                // fallback pass that ignores capacity so we can continue
                // assigning remaining blocks. This prevents the algorithm
                // from stopping early when every school temporarily fails the
                // capacity filter but unassigned blocks remain.
                if (!Array.isArray(rows) || rows.length === 0) {
                    console.debug('autoPaint: no candidate with capacity filter, trying fallback (ignore capacity) — iteration', iterationCount);
                    rows = await runQuery(conn, `
                    WITH
                        current_enrollment
                        AS
                        (
                            SELECT
                                status.school,
                                sum(map.residents) AS enrollment,
                                schools.capacity AS capacity
                            FROM
                                status JOIN data.${state.currentTable} AS map ON map.block_of_residence = status.block JOIN
                                (
                                SELECT
                                    *
                                FROM
                                    stateSchool
                                UNION ALL
                                    SELECT
                                        name,
                                        latitude,
                                        longitude,
                                        NULL AS color,
                                        capacity,
                                        fte_capacity
                                    FROM
                                        data.schools
                                    WHERE NOT EXISTS (SELECT
                                        1
                                    FROM
                                        stateSchool
                                    WHERE stateSchool.name = data.schools.name))
                                AS schools ON schools.name = status.school WHERE school IS NOT NULL GROUP BY ALL), block_candidates AS
                                (SELECT
                                    current_enrollment.school,
                                    current_enrollment.enrollment,
                                    current_enrollment.capacity,
                                    adjecent_block AS block
                                FROM
                                    data.${state.currentTable}_adjacency CROSS JOIN current_enrollment WHERE block_of_residence IN
                                (SELECT
                                    block
                                FROM
                                    status
                                WHERE school = current_enrollment.school)
                                AND adjecent_block IN
                                (SELECT
                                    block
                                FROM
                                    status
                                WHERE school IS NULL)
                                )
                                SELECT
                                    block_candidates.school,
                                    block_candidates.enrollment,
                                    block_candidates.block,
                                    distances.distance,
                                    distances.driving_distance,
                                    distances.driving_time
                                FROM
                                    block_candidates JOIN data.distances ON distances.school = block_candidates.school AND distances.block_of_residence = block_candidates.block
                                ORDER BY distances.${blockOptimization} limit 1
                    `);
                    console.debug('autoPaint: fallback rows length =', Array.isArray(rows) ? rows.length : String(rows));
                    if (!Array.isArray(rows) || rows.length === 0) break; // still nothing
                }
                const nextBlock = rows[0];
                console.debug('autoPaint: selected nextBlock =', nextBlock);
                // Stop only when the returned block is explicitly null/undefined. Use
                // loose null check to catch both `null` and `undefined` specifically
                // (avoid treating other falsy values like '' as a stop signal).
                if (nextBlock.block == null) break;
                await upsertRows(conn, 'status', { block: nextBlock.block, school: nextBlock.school }, 'block');
                paintBlock(nextBlock.school, nextBlock.block);
                    iterationCount++;
                    try {
                        const counts = await runQuery(conn, `SELECT SUM(CASE WHEN school IS NULL THEN 1 ELSE 0 END) AS unassigned, SUM(CASE WHEN school IS NOT NULL THEN 1 ELSE 0 END) AS assigned FROM status;`);
                        console.debug('autoPaint: after upsert status counts =', counts && counts[0] ? counts[0] : counts);
                    } catch (e) {
                        console.debug('autoPaint: failed to read status counts', e);
                    }
            }
            setStatus('Auto Assign Blocks complete');
        } catch (err) {
            console.error('Auto paint failed', err);
            try { setStatus('Auto paint failed: ' + (err && err.message ? err.message : String(err))); } catch (e) { }
        } finally {
            isProcessing = false;
            updateButtonState();
            // Clear status after a short delay so users see the final message briefly
            try { setTimeout(() => { setStatus(''); }, 4000); } catch (e) { }
        }
    }

    autoPaintBtn.addEventListener('click', autoPaint);
}
