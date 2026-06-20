'use strict';

// Client render-perf regression gate (P1b). Requires Playwright (devDep).
//
// WHAT IT IS: a *relative* regression gate, not an iPad-FPS predictor. CI runners
// have no GPU, so the 2D canvas is software-rasterized — absolute frame time is
// far slower than a real device and not comparable to one. We therefore gate on
// SCRIPTING ms/frame (CDP Performance.ScriptDuration), which reflects the JS/draw
// work the game does and stays meaningful under heavy software raster. Total
// frame-work and JS heap are reported as context only. See
// docs/spikes/perf-and-input-ci.md (and CALIBRATION below) for the iPad mapping.
//
// SCENARIO: a 25-kart, stacked-brutal race (a FIXED brutal set, see OVERRIDE),
// reached with zero manual input via the editor preview-room path (preview skips
// the lobby rally that otherwise traps a headless client in the lobby forever).
// The load is forced through the CHAO_PERF_OVERRIDE config seam — no config.json edit.
//
// ACCURACY DESIGN (why this is no longer a coin-flip): the old harness took ONE
// 8s wall-clock window and divided ScriptDuration by however many frames happened
// to render. On the shared CI runner that frame count swung ~10x with CPU
// contention (12 frames/8s under load vs 180-260 healthy), so the per-frame
// denominator — and thus the metric — swung several-fold on byte-identical code.
// (The denominator carries a hidden per-WINDOW overhead term — socket handlers, GC,
// which fire on wall-clock not per frame — so the fewer frames a contended window
// renders, the more that overhead inflates the per-frame number.)
// Three fixes, all here:
//   1. FIXED SCENE — brutalTypesForce pins the exact brutal combo, so the base and
//      PR halves render identical FX (the old unseeded shuffle gave each half a
//      different combo with different cost).
//   2. PEAK-RELATIVE FRAME FILTER — we measure each runner's OWN peak fps in-job and
//      keep only windows within PEAK_FRACTION of it (the least-contended windows,
//      where the per-window overhead is well-amortized and per-frame is stable). A
//      fixed fps floor can't do this — the stable region depends on each runner's
//      capacity. A starved/contended window is dropped, not misread as a regression.
//   3. MEDIAN OF KEPT WINDOWS — report the median of the near-peak windows, so a
//      single transient spike can't define the run. Too few near-peak windows (or a
//      peak below the absolute floor) -> degenerate; compare calls it INCONCLUSIVE
//      rather than inventing a regression.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const repoRoot = path.join(__dirname, '..', '..');
const PORT = Number(process.env.PERF_PORT) || 28911;
const ORIGIN = `http://localhost:${PORT}`;
const MAP_FILE = process.env.PERF_MAP || '4Suns!.json';
const SAMPLE_SECONDS = Number(process.env.PERF_SAMPLE_SECONDS) || 6;
// COLLECT: how many scene-valid windows we gather before filtering. We then keep the
// ones rendered near the runner's own peak fps (see PEAK_FRACTION) and take the
// MEDIAN of those. A single window was the old design's core flaw — one transient
// CPU-contention spike skewed the whole gate; the median of several near-peak
// windows is robust to a stray spike.
const COLLECT = Number(process.env.PERF_COLLECT) || 7;
// We need at least this many KEPT (near-peak) windows for the run to be trustworthy.
// Fewer means the runner was too contended to measure cleanly — we report that
// honestly (degenerate) so the compare step calls it INCONCLUSIVE rather than
// inventing a regression from garbage.
const MIN_VALID_REPS = Number(process.env.PERF_MIN_VALID_REPS) || 3;
// A preview round can END mid-sample (a bot reaches the goal), which would
// otherwise have us measuring the post-race overview/editor instead of the race.
// We sample from race-start, validate the whole window stayed a full-grid race,
// and retry if not. Budget enough attempts to collect COLLECT scene-valid windows
// even with some discards.
const MAX_ATTEMPTS = Number(process.env.PERF_MAX_ATTEMPTS) || (COLLECT * 4);
const MIN_KARTS = 20;  // a valid sample must keep at least this many karts throughout
// PEAK-RELATIVE FRAME FILTER — the heart of the accuracy fix. The metric is
// scripting-ms / FRAME, and that has a hidden per-WINDOW overhead term (socket
// handlers, GC — they fire on wall-clock, not per frame); divided by the frame
// count it inflates the metric whenever fps is low. A *fixed* fps floor can't fix
// this because the "flat" region where per-frame is stable depends on each runner's
// capacity (observed: even at 6fps a window read ~7-14 ms/frame while the same code
// at 17fps read ~4.7). So instead we measure each runner's OWN peak fps in-job and
// keep only windows within PEAK_FRACTION of it — the least-contended windows, where
// the overhead is well-amortized and per-frame is stable and comparable. Base and PR
// each filter to near their shared runner's peak, so they're compared on equal terms.
const PEAK_FRACTION = Number(process.env.PERF_PEAK_FRACTION) || 0.7;
// If even the BEST window can't clear this absolute fps, the whole runner was
// contended for the entire job — nothing is trustworthy, so the run is degenerate.
const ABS_MIN_PEAK_FPS = Number(process.env.PERF_ABS_MIN_PEAK_FPS) || 10;
// A window this slow is a near-stall; skip measuring it (saves time) — it would be
// filtered out by PEAK_FRACTION anyway and only wastes a sample window.
const SKIP_BELOW_FPS = Number(process.env.PERF_SKIP_BELOW_FPS) || 4;
// This is a MEASUREMENT tool — the real gate is the base-vs-PR delta in
// perf-compare.js. An absolute ceiling here is meaningful only as a catastrophic
// guard (e.g. an infinite render loop), since the software-raster baseline is
// environment-dependent. Off unless PERF_SCRIPT_CEILING_MS is set.
const SCRIPT_CEILING_MS = process.env.PERF_SCRIPT_CEILING_MS ? Number(process.env.PERF_SCRIPT_CEILING_MS) : null;
const OUT_JSON = process.env.PERF_OUT_JSON || '';

// FIXED brutal set — volcano + explosive + infection + hockey. Pinned (not the
// unseeded shuffle) so base and PR render an identical, heavy-FX scene. Numeric ids
// from config.brutalRounds (see gameBoard.checkForBrutalRound, which short-circuits
// on c.brutalTypesForce when this seam injects it).
const FORCED_BRUTALS = [1007, 1010, 1008, 1009];
const OVERRIDE = JSON.stringify({
    // previewBotCount pins the PREVIEW-room fill at 24 bots (1H+24=25 karts) — this
    // harness reaches the race via the editor preview path (createPreviewRoom), which
    // fills off c.aiRacers.previewBotCount, NOT testForceBots. testForceBots/minGrid/
    // maxGrid are kept for the lobby/auto fill path in case it's ever used, but the
    // preview path needs previewBotCount or the grid never clears the 20-kart floor.
    aiRacers: { minGrid: 25, maxGrid: 25, testForceBots: 24, previewBotCount: 24 },
    maxPlayersInRoom: 25,                                   // room cap must allow the full grid
    chanceOfBrutalRound: 100,
    chanceForAdditionalBrutal: 100,
    maxTotalBrutals: 4,
    brutalTypesForce: FORCED_BRUTALS,                      // pin the exact brutal scene (test-only seam)
});

const f = (n) => (Number.isFinite(n) ? n.toFixed(2) : 'n/a');
function pct(a, p) { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; }
function median(a) { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function metric(metrics, name) { const m = metrics.metrics.find(x => x.name === name); return m ? m.value : 0; }

function bootServer() {
    return new Promise((resolve, reject) => {
        const srv = spawn('node', ['index.js'], {
            cwd: repoRoot,
            env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', CHAO_PERF_OVERRIDE: OVERRIDE },
        });
        let out = '', settled = false;
        const done = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); fn(arg); };
        const onData = (d) => { out += d.toString(); if (/listening on/i.test(out)) done(resolve, srv); };
        srv.stdout.on('data', onData);
        srv.stderr.on('data', onData);
        srv.on('exit', (c) => done(reject, new Error(`server exited early (${c}):\n${out}`)));
        // On timeout, kill the spawned server so it can't linger — the outer finally
        // only kills `srv` once this promise RESOLVES, so a boot that never resolves
        // would otherwise leak the child.
        const timer = setTimeout(() => {
            try { srv.kill('SIGKILL'); } catch (e) {}
            done(reject, new Error(`server boot timeout:\n${out}`));
        }, 20000);
    });
}

const SAMPLER = `(() => {
  window.__frames = [];
  const orig = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function (cb) {
    return orig(function (ts) { const t0 = performance.now(); try { cb(ts); } finally { window.__frames.push(performance.now() - t0); } });
  };
  window.__resetFrames = () => { window.__frames.length = 0; };
})();`;

async function poll(page, fn, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs; let last = null;
    while (Date.now() < deadline) {
        const snap = await page.evaluate(fn);
        if (JSON.stringify(snap) !== JSON.stringify(last)) { console.log(`    ${label}: ${JSON.stringify(snap)}`); last = snap; }
        if (snap && snap.done) return snap;
        await page.waitForTimeout(500);
    }
    return null;
}

function writeSummary(lines) {
    if (process.env.GITHUB_STEP_SUMMARY) { try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n'); } catch (e) {} }
}

// A navigation/context-destroyed throw is the preview round ending and the page
// bouncing back to the editor out from under an in-flight page.evaluate — a
// flaky/degenerate run, NOT a real regression. Any other exception is a real bug.
const NAV_RACE_RE = /Execution context was destroyed|Target closed|Navigation|detached Frame|Session closed/i;

(async () => {
    let srv, browser, exitCode = 0, reachedRace = false;
    const errors = [];
    try {
        console.log(`[1/5] Booting server on :${PORT} (CHAO_PERF_OVERRIDE: 25-kart grid + fixed brutal [${FORCED_BRUTALS.join(', ')}]) ...`);
        srv = await bootServer();
        console.log('      listening.');

        console.log('[2/5] Launching headless Chromium (iPad-ish 1194x834, DPR 2, touch) ...');
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({
            viewport: { width: 1194, height: 834 }, deviceScaleFactor: 2, hasTouch: true,
            userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        });
        await context.addInitScript(SAMPLER);
        const page = await context.newPage();
        page.on('pageerror', e => errors.push('pageerror: ' + e.message));
        page.on('console', m => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED|gtag|googletagmanager/i.test(m.text())) errors.push('console.error: ' + m.text()); });

        console.log('[3/5] Creating AI-filled preview room ...');
        const mapJson = fs.readFileSync(path.join(repoRoot, 'client', 'maps', MAP_FILE), 'utf8');
        await page.goto(`${ORIGIN}/create.html`, { waitUntil: 'domcontentloaded' });
        await poll(page, () => ({ done: !!(window.server && window.server.connected) }), 15000, 'socket');
        const gameID = await page.evaluate((mj) => new Promise((res, rej) => {
            const t = setTimeout(() => rej('no previewRoomCreated'), 10000);
            window.server.on('previewRoomCreated', p => { clearTimeout(t); res(p.gameID); });
            window.server.on('previewRejected', p => { clearTimeout(t); rej('rejected: ' + p.reason); });
            sessionStorage.setItem('previewMap', mj);
            window.server.emit('createPreviewRoom', JSON.stringify({ map: JSON.parse(mj), enableAI: true }));
        }), mapJson);
        console.log('      gameID=' + gameID);

        console.log('[4/5] Loading client into the race (preview skips lobby) ...');
        await page.goto(`${ORIGIN}/play.html?gameid=${gameID}&preview=1`, { waitUntil: 'domcontentloaded' });
        const cdp = await context.newCDPSession(page);
        await cdp.send('Performance.enable');

        // Live snapshot: a full-grid racing phase on the play page.
        const racingFn = () => {
            const racing = (window.config && window.config.stateMap) ? window.config.stateMap.racing : null;
            const karts = window.playerList ? Object.keys(window.playerList).length : 0;
            return { state: window.currentState, racing, karts,
                onPlay: location.pathname.indexOf('play.html') !== -1,
                done: racing != null && window.currentState === racing && karts >= 20 };
        };

        console.log(`[5/5] Collecting up to ${COLLECT} scene-valid ${SAMPLE_SECONDS}s windows, then keeping those >= ${(PEAK_FRACTION * 100).toFixed(0)}% of the runner's peak fps (median of >= ${MIN_VALID_REPS}) ...`);
        const windows = [];          // every scene-valid window: { scriptPerFrame, taskPerFrame, frames, fps, frameWorkP95, heapMB, brutal, karts }
        let tracedOne = false;
        let nearStall = 0, badWindow = 0;
        // FAIL FAST when the scenario is broken. Each poll waits up to 45s for a
        // full-grid race; a CONTENDED runner still reaches one (just slowly), but a
        // BROKEN scenario (preview never fills the grid, a client throw kills the
        // render loop, etc.) never will — so burning all MAX_ATTEMPTS (~21 min) only
        // delays an inevitable failure. If we haven't reached a single race in the
        // first few attempts, it's breakage not contention: stop and let the
        // empty-windows path throw immediately.
        const REACH_RACE_MAX_TRIES = Number(process.env.PERF_REACH_RACE_TRIES) || 3;
        let reachTries = 0;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS && windows.length < COLLECT; attempt++) {
            const reached = await poll(page, racingFn, 45000, `attempt ${attempt}`);
            if (!reached) {
                console.log(`  attempt ${attempt}: no full-grid racing reached`);
                if (!reachedRace && ++reachTries >= REACH_RACE_MAX_TRIES) {
                    console.log(`  giving up after ${reachTries} attempts without ever reaching a full-grid race — the perf scenario is broken (not runner contention). Failing fast instead of grinding all ${MAX_ATTEMPTS} attempts.`);
                    break;
                }
                continue;
            }
            reachedRace = true;
            // Stop the preview auto-return so a round that ends mid-window cycles to the
            // next round (staying on play.html) rather than bouncing to the editor —
            // a bad window is then caught by post-validation, never silently measured.
            await page.evaluate(() => { try { previewReturnScheduled = true; } catch (e) { window.previewReturnScheduled = true; } });

            await page.evaluate(() => window.__resetFrames());
            // Trace only the FIRST window we keep, for the uploaded artifact.
            const wantTrace = !tracedOne;
            if (wantTrace) await context.tracing.start({ screenshots: false, snapshots: false });
            const m0 = await cdp.send('Performance.getMetrics');
            const t0 = Date.now();
            await page.waitForTimeout(SAMPLE_SECONDS * 1000);
            const m1 = await cdp.send('Performance.getMetrics');
            const wallMs = Date.now() - t0;
            const after = await page.evaluate(() => {
                const racing = (window.config && window.config.stateMap) ? window.config.stateMap.racing : null;
                return { state: window.currentState, racing,
                    onPlay: location.pathname.indexOf('play.html') !== -1,
                    frames: window.__frames.slice(),
                    heapMB: (performance && performance.memory) ? performance.memory.usedJSHeapSize / 1048576 : null,
                    karts: window.playerList ? Object.keys(window.playerList).length : null,
                    brutal: (window.brutalRoundConfig && window.brutalRoundConfig.brutalTypes) ? window.brutalRoundConfig.brutalTypes : null };
            });
            // The whole window must have stayed a full-grid race that actually rendered
            // and was the forced BRUTAL scenario; otherwise the round ended into
            // overview/editor mid-sample, the render loop stalled, or the brutal round
            // silently failed to engage — in all cases the numbers are meaningless.
            const brutalActive = Array.isArray(after.brutal) && after.brutal.length > 0;
            const frameCount = after.frames.length;
            const fps = frameCount / (wallMs / 1000);
            const sceneOk = after.onPlay && after.state === after.racing &&
                after.karts != null && after.karts >= MIN_KARTS && brutalActive;
            if (!sceneOk) {
                if (wantTrace) await context.tracing.stop().catch(() => {}); // discard this window's trace
                badWindow++;
                console.log(`  attempt ${attempt}: discarded scene (onPlay=${after.onPlay} state=${after.state} karts=${after.karts} brutal=${brutalActive}) — not a clean full-grid brutal window`);
                continue;
            }
            // Near-stall: too contended to be even a peak candidate; skip without keeping
            // (it would be filtered by PEAK_FRACTION anyway and only wastes a window).
            if (fps < SKIP_BELOW_FPS) {
                if (wantTrace) await context.tracing.stop().catch(() => {});
                nearStall++;
                console.log(`  attempt ${attempt}: skipped near-stall (${frameCount} frames = ${fps.toFixed(1)}fps < ${SKIP_BELOW_FPS}fps) — runner heavily contended this window`);
                continue;
            }
            if (wantTrace) { await context.tracing.stop({ path: path.join(repoRoot, 'perf-trace.zip') }).catch(() => {}); tracedOne = true; }

            const dScript = (metric(m1, 'ScriptDuration') - metric(m0, 'ScriptDuration')) * 1000; // s -> ms
            const dTask = (metric(m1, 'TaskDuration') - metric(m0, 'TaskDuration')) * 1000;
            const dLayout = (metric(m1, 'LayoutDuration') - metric(m0, 'LayoutDuration')) * 1000;
            const dStyle = (metric(m1, 'RecalcStyleDuration') - metric(m0, 'RecalcStyleDuration')) * 1000;
            windows.push({
                scriptPerFrame: dScript / frameCount,
                taskPerFrame: dTask / frameCount,
                layoutMs: dLayout, styleMs: dStyle,
                frames: frameCount, fps,
                frameWorkP95: pct(after.frames, 95),
                heapMB: after.heapMB, karts: after.karts, brutal: after.brutal,
            });
            console.log(`  window ${windows.length}/${COLLECT}: ${after.karts} karts, ${frameCount} frames (${fps.toFixed(1)}fps), scripting ${f(dScript / frameCount)} ms/frame`);
        }

        // PEAK-RELATIVE FILTER: keep only windows rendered near this runner's own peak
        // fps — the least-contended ones, where the per-frame metric is stable and
        // base/PR are comparable. If even the peak is below the absolute floor, or too
        // few windows survive, the run is degenerate -> compare calls it INCONCLUSIVE.
        const peakFps = windows.length ? Math.max(...windows.map(w => w.fps)) : 0;
        const keepThreshold = peakFps * PEAK_FRACTION;
        const reps = windows.filter(w => w.fps >= keepThreshold);
        const validReps = reps.length;
        const peakTooLow = peakFps < ABS_MIN_PEAK_FPS;
        const degenerate = validReps < MIN_VALID_REPS || peakTooLow;

        if (windows.length === 0) {
            // No scene-valid, non-stalled window at all. Only ONE shape of this is true
            // contention: we reached a race and every miss was a near-stall (too few
            // frames to trust) with ZERO scene-invalid windows — report degenerate so
            // compare calls it inconclusive rather than failing the build. ANY badWindow
            // (round left racing mid-sample, karts dropped, or the forced brutal never
            // engaged) means the perf SCENARIO is broken, not that the runner was slow —
            // that must fail loudly, otherwise a broken gate reads as a quiet pass. A run
            // that never reached a race at all is likewise real breakage.
            if (errors.length) console.log('  errors:\n   - ' + errors.slice(0, 8).join('\n   - '));
            const pureContention = reachedRace && nearStall > 0 && badWindow === 0;
            if (pureContention) {
                console.log(`\n::warning::All ${nearStall} window(s) were near-stalls under contention (0 scene-invalid) — reporting INCONCLUSIVE (no regression).`);
                const degResult = { karts: null, brutalTypes: FORCED_BRUTALS, validReps: 0, requestedReps: COLLECT,
                    degenerate: true, peakFps: +peakFps.toFixed(1), scriptMsPerFrame: null, frameWorkP95Ms: null, heapMB: null, fpsActual: +peakFps.toFixed(1) };
                if (OUT_JSON) fs.writeFileSync(OUT_JSON, JSON.stringify(degResult, null, 2));
                console.log('\nMeasurement inconclusive (runner contended).');
                if (browser) await browser.close().catch(() => {});
                if (srv) srv.kill('SIGKILL');
                process.exit(0);
            }
            throw new Error(`no usable perf window in ${MAX_ATTEMPTS} attempts (reachedRace=${reachedRace} nearStall=${nearStall} badScene=${badWindow}) — ${badWindow > 0 ? 'scene/scenario broke (not contention)' : 'never reached a full-grid race'}; failing rather than masking as contention`);
        }

        // A short-but-non-empty collection (ran out of attempts before COLLECT)
        // needs no special case: the median/gate path below already computes the
        // `degenerate` flag (validReps < MIN_VALID_REPS) and perf-compare honors
        // it as INCONCLUSIVE, while a short run that still gathered >= MIN_VALID_REPS
        // near-peak windows stays gradeable. Forcing INCONCLUSIVE here on any
        // near-stall would disable the gate on perfectly measurable runs.

        const scriptPerFrame = median(reps.map(r => r.scriptPerFrame));
        const taskPerFrame = median(reps.map(r => r.taskPerFrame));
        const frameWorkP95 = median(reps.map(r => r.frameWorkP95));
        const fpsActual = median(reps.map(r => r.fps));
        const framesMed = Math.round(median(reps.map(r => r.frames)));
        const heapMB = median(reps.map(r => r.heapMB).filter(Number.isFinite));
        const last = reps[reps.length - 1] || windows[windows.length - 1];

        const ceilingBreached = SCRIPT_CEILING_MS != null && Number.isFinite(scriptPerFrame) && scriptPerFrame > SCRIPT_CEILING_MS;
        const result = {
            karts: last.karts, brutalTypes: last.brutal,
            validReps, collected: windows.length, requestedReps: COLLECT, degenerate,
            peakFps: +peakFps.toFixed(1), keepFpsThreshold: +keepThreshold.toFixed(1),
            framesMedian: Number.isFinite(framesMed) ? framesMed : null,
            scriptMsPerFrame: Number.isFinite(scriptPerFrame) ? +scriptPerFrame.toFixed(3) : null,
            scriptMsPerFrameReps: reps.map(r => +r.scriptPerFrame.toFixed(3)),
            taskMsPerFrame: Number.isFinite(taskPerFrame) ? +taskPerFrame.toFixed(3) : null,
            frameWorkP95Ms: Number.isFinite(frameWorkP95) ? +frameWorkP95.toFixed(2) : null,
            heapMB: Number.isFinite(heapMB) ? +heapMB.toFixed(1) : null,
            fpsActual: Number.isFinite(fpsActual) ? +fpsActual.toFixed(1) : null,
        };

        console.log('\n=== CLIENT PERF (measurement — gate is base-vs-PR delta) ===');
        console.log(`  karts=${result.karts}  brutal=[${(result.brutalTypes || []).join(', ')}]  kept ${validReps}/${windows.length} windows >= ${keepThreshold.toFixed(1)}fps (peak ${peakFps.toFixed(1)}fps)  framesMed=${result.framesMedian}  (nearStall=${nearStall}, badScene=${badWindow})`);
        console.log(`  HEADLINE  scripting ms/frame (median) : ${f(scriptPerFrame)}   kept=[${result.scriptMsPerFrameReps.join(', ')}]`);
        console.log(`  context   task ms/frame (median)      : ${f(taskPerFrame)}`);
        console.log(`  context   frame-work p95 (median)     : ${f(frameWorkP95)} ms  (NOT an iPad FPS — env-dependent)`);
        console.log(`  context   fps (median kept)           : ${f(fpsActual)}`);
        console.log(`  context   JS heap (median)            : ${result.heapMB} MB`);
        if (degenerate) console.log(`  WARN: ${peakTooLow ? `peak fps ${peakFps.toFixed(1)} < ${ABS_MIN_PEAK_FPS} (runner contended all job)` : `only ${validReps} near-peak window(s) (< ${MIN_VALID_REPS})`} — compare will mark INCONCLUSIVE.`);
        if (errors.length) console.log(`  NOTE: ${errors.length} non-benign page error(s): ${errors[0]}`);
        console.log('============================================================');

        if (OUT_JSON) fs.writeFileSync(OUT_JSON, JSON.stringify(result, null, 2));

        writeSummary([
            '### Client render-perf (P1b) — measurement',
            '',
            `Scenario: **${result.karts} karts**, fixed brutal \`[${(result.brutalTypes || []).join(', ')}]\`, map \`${MAP_FILE}\`. Median of **${validReps}/${windows.length}** near-peak windows (kept >= ${keepThreshold.toFixed(1)}fps of ${peakFps.toFixed(1)}fps peak). _Headless software raster: absolute ms is env-dependent and **not** an iPad FPS — the gate is the **base-vs-PR delta** (see perf-compare)._`,
            degenerate ? `\n> ⚠️ Only ${validReps} near-peak window(s) — runner too contended; treated as **inconclusive**.\n` : '',
            '| metric | value | note |',
            '| --- | --- | --- |',
            `| **scripting ms/frame** (median) | **${f(scriptPerFrame)}** | headline (≈ full frame) |`,
            `| task ms/frame (median) | ${f(taskPerFrame)} | context |`,
            `| frame-work p95 (median) | ${f(frameWorkP95)} ms | env-dependent, context |`,
            `| JS heap (median) | ${result.heapMB} MB | context |`,
            `| kept windows | ${validReps} / ${windows.length} | ${result.framesMedian} frames/window @ ${f(fpsActual)}fps |`,
        ]);

        if (ceilingBreached) { console.log(`\n::error::Catastrophic ceiling breached: ${f(scriptPerFrame)} ms/frame > ${f(SCRIPT_CEILING_MS)} ms.`); exitCode = 1; }
        else console.log('\nMeasurement complete.');
    } catch (e) {
        const msg = (e && e.message) || String(e);
        // Only treat a navigation/context-destroyed throw as benign once we've
        // actually reached the race (sampling underway) — that's the preview round
        // ending and bouncing back to the editor. The same error class BEFORE the
        // race (a setup page.goto failing on a broken build/500) is real breakage
        // and must still fail loudly.
        if (reachedRace && NAV_RACE_RE.test(msg)) {
            // The preview round ended and the page navigated back to the editor,
            // destroying the execution context mid-sample — flaky, not a regression.
            console.error('\nPERF GATE navigation race (execution context destroyed):', msg);
            console.log('\n::warning::perf-client navigation race (execution context destroyed) — reporting INCONCLUSIVE (no regression).');
            exitCode = 0;
        } else {
            console.error('\nPERF GATE ERROR:', msg);
            exitCode = 1;
        }
    } finally {
        if (browser) await browser.close().catch(() => {});
        if (srv) srv.kill('SIGKILL');
    }
    process.exit(exitCode);
})();
