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
// SCENARIO: a 25-kart, stacked-brutal race (explosive/volcano/etc.), reached with
// zero manual input via the editor preview-room path (preview skips the lobby
// rally that otherwise traps a headless client in the lobby forever). The load is
// forced through the CHAO_PERF_OVERRIDE config seam — no config.json edit.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const repoRoot = path.join(__dirname, '..', '..');
const PORT = Number(process.env.PERF_PORT) || 28911;
const ORIGIN = `http://localhost:${PORT}`;
const MAP_FILE = process.env.PERF_MAP || '4suns!.json';
const SAMPLE_SECONDS = Number(process.env.PERF_SAMPLE_SECONDS) || 8;
// A preview round can END mid-sample (a bot reaches the goal), which would
// otherwise have us measuring the post-race overview/editor instead of the race.
// We sample from race-start, validate the whole window stayed a full-grid race,
// and retry on the next round if not. The metric itself is very stable once a
// valid window is captured (~0.3% run-to-run).
const MAX_ATTEMPTS = Number(process.env.PERF_MAX_ATTEMPTS) || 6;
const MIN_KARTS = 20;  // a valid sample must keep at least this many karts throughout
const MIN_FRAMES = 10; // ...and must have actually rendered frames (else the render loop stalled)
// This is a MEASUREMENT tool — the real gate is the base-vs-PR delta in
// perf-compare.js. An absolute ceiling here is meaningful only as a catastrophic
// guard (e.g. an infinite render loop), since the software-raster baseline is
// environment-dependent. Off unless PERF_SCRIPT_CEILING_MS is set.
const SCRIPT_CEILING_MS = process.env.PERF_SCRIPT_CEILING_MS ? Number(process.env.PERF_SCRIPT_CEILING_MS) : null;
const OUT_JSON = process.env.PERF_OUT_JSON || '';

const OVERRIDE = JSON.stringify({
    aiRacers: { minGrid: 25, maxGrid: 25, testForceBots: 24 }, // testForceBots pins the auto-fill at 24 bots (1H+24=25 karts)
    maxPlayersInRoom: 25,                                   // room cap must allow the full grid
    chanceOfBrutalRound: 100,
    chanceForAdditionalBrutal: 100,
    maxTotalBrutals: 4,
});

const f = (n) => (Number.isFinite(n) ? n.toFixed(2) : 'n/a');
function pct(a, p) { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; }
function metric(metrics, name) { const m = metrics.metrics.find(x => x.name === name); return m ? m.value : 0; }

function bootServer() {
    return new Promise((resolve, reject) => {
        const srv = spawn('node', ['index.js'], {
            cwd: repoRoot,
            env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', CHAO_PERF_OVERRIDE: OVERRIDE },
        });
        let out = '';
        const onData = (d) => { out += d.toString(); if (/listening on/i.test(out)) resolve(srv); };
        srv.stdout.on('data', onData);
        srv.stderr.on('data', onData);
        srv.on('exit', (c) => reject(new Error(`server exited early (${c}):\n${out}`)));
        setTimeout(() => reject(new Error(`server boot timeout:\n${out}`)), 20000);
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

(async () => {
    let srv, browser, exitCode = 0;
    const errors = [];
    try {
        console.log(`[1/5] Booting server on :${PORT} (CHAO_PERF_OVERRIDE: 25-kart grid + forced brutal) ...`);
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

        console.log('[5/5] Capturing a full-grid racing window (retry until valid) ...');
        let cap = null;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS && cap == null; attempt++) {
            const reached = await poll(page, racingFn, 45000, `attempt ${attempt}`);
            if (!reached) { console.log(`  attempt ${attempt}: no full-grid racing reached`); continue; }
            // Stop the preview auto-return so a round that ends mid-window cycles to the
            // next round (staying on play.html) rather than bouncing to the editor —
            // a bad window is then caught by post-validation, never silently measured.
            await page.evaluate(() => { try { previewReturnScheduled = true; } catch (e) { window.previewReturnScheduled = true; } });

            await page.evaluate(() => window.__resetFrames());
            await context.tracing.start({ screenshots: false, snapshots: false });
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
            const valid = after.onPlay && after.state === after.racing &&
                after.karts != null && after.karts >= MIN_KARTS &&
                after.frames.length >= MIN_FRAMES && brutalActive;
            if (!valid) {
                await context.tracing.stop().catch(() => {}); // discard this window's trace
                console.log(`  attempt ${attempt}: discarded (onPlay=${after.onPlay} state=${after.state} karts=${after.karts} frames=${after.frames.length} brutal=${brutalActive}) — not a clean full-grid brutal window; retrying`);
                continue;
            }
            await context.tracing.stop({ path: path.join(repoRoot, 'perf-trace.zip') }).catch(() => {});
            cap = { m0, m1, wallMs, ...after };
            console.log(`  attempt ${attempt}: captured ${after.karts} karts over ${after.frames.length} frames`);
        }
        if (cap == null) {
            if (errors.length) console.log('  errors:\n   - ' + errors.slice(0, 8).join('\n   - '));
            throw new Error('could not capture a full-grid racing window in ' + MAX_ATTEMPTS + ' attempts');
        }

        const frames = cap.frames.length || 1;
        const dScript = (metric(cap.m1, 'ScriptDuration') - metric(cap.m0, 'ScriptDuration')) * 1000; // s -> ms
        const dLayout = (metric(cap.m1, 'LayoutDuration') - metric(cap.m0, 'LayoutDuration')) * 1000;
        const dStyle = (metric(cap.m1, 'RecalcStyleDuration') - metric(cap.m0, 'RecalcStyleDuration')) * 1000;
        const dTask = (metric(cap.m1, 'TaskDuration') - metric(cap.m0, 'TaskDuration')) * 1000;
        const scriptPerFrame = dScript / frames;
        const taskPerFrame = dTask / frames;
        const frameWorkP95 = pct(cap.frames, 95);
        const fpsActual = frames / (cap.wallMs / 1000);
        const ctx = { karts: cap.karts, brutal: cap.brutal, heapMB: cap.heapMB };

        const ceilingBreached = SCRIPT_CEILING_MS != null && scriptPerFrame > SCRIPT_CEILING_MS;
        const result = {
            karts: ctx.karts, brutalTypes: ctx.brutal, frames,
            scriptMsPerFrame: +scriptPerFrame.toFixed(3),
            taskMsPerFrame: +taskPerFrame.toFixed(3),
            layoutMsTotal: +dLayout.toFixed(1), styleMsTotal: +dStyle.toFixed(1),
            frameWorkP95Ms: +frameWorkP95.toFixed(2),
            heapMB: ctx.heapMB ? +ctx.heapMB.toFixed(1) : null,
            fpsActual: +fpsActual.toFixed(1),
        };

        console.log('\n=== CLIENT PERF (measurement — gate is base-vs-PR delta) ===');
        console.log(`  karts=${result.karts}  brutal=[${(result.brutalTypes || []).join(', ')}]  frames=${frames}`);
        console.log(`  HEADLINE  scripting ms/frame : ${f(scriptPerFrame)}   (≈ full frame; software raster counts as script)`);
        console.log(`  context   task ms/frame      : ${f(taskPerFrame)}`);
        console.log(`  context   frame-work p95     : ${f(frameWorkP95)} ms  (NOT an iPad FPS — env-dependent)`);
        console.log(`  context   layout/style tot   : ${f(dLayout)} / ${f(dStyle)} ms`);
        console.log(`  context   JS heap            : ${result.heapMB} MB`);
        if (errors.length) console.log(`  NOTE: ${errors.length} non-benign page error(s): ${errors[0]}`);
        console.log('============================================================');

        if (OUT_JSON) fs.writeFileSync(OUT_JSON, JSON.stringify(result, null, 2));

        writeSummary([
            '### Client render-perf (P1b) — measurement',
            '',
            `Scenario: **${result.karts} karts**, brutal \`[${(result.brutalTypes || []).join(', ')}]\`, map \`${MAP_FILE}\`. _Headless software raster: absolute ms is env-dependent and **not** an iPad FPS — the gate is the **base-vs-PR delta** (see perf-compare)._`,
            '',
            '| metric | value | note |',
            '| --- | --- | --- |',
            `| **scripting ms/frame** | **${f(scriptPerFrame)}** | headline (≈ full frame) |`,
            `| task ms/frame | ${f(taskPerFrame)} | context |`,
            `| frame-work p95 | ${f(frameWorkP95)} ms | env-dependent, context |`,
            `| JS heap | ${result.heapMB} MB | context |`,
            `| frames sampled | ${frames} | over ${SAMPLE_SECONDS}s |`,
        ]);

        if (ceilingBreached) { console.log(`\n::error::Catastrophic ceiling breached: ${f(scriptPerFrame)} ms/frame > ${f(SCRIPT_CEILING_MS)} ms.`); exitCode = 1; }
        else console.log('\nMeasurement complete.');
    } catch (e) {
        console.error('\nPERF GATE ERROR:', (e && e.message) || e);
        exitCode = 1;
    } finally {
        if (browser) await browser.close().catch(() => {});
        if (srv) srv.kill('SIGKILL');
    }
    process.exit(exitCode);
})();
