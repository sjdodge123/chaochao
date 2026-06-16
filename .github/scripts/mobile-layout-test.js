'use strict';

// Mobile layout gate. Two classes of bug this catches, both reported from a real
// Pixel-class phone (2026-06-15):
//
//   1. HORIZONTAL OVERFLOW — a menu page wider than the phone so it scrolls sideways
//      and clips its left edge. (The map list shrink-wrapped to a 5-column row via a
//      leaked `float: left`; the editor's action group ran Copy/Upload off-screen.)
//      We load each page in real portrait + landscape phone viewports and fail if any
//      *visible* element extends past the viewport's right edge.
//
//   2. HUD OVERLAP — a newly-added HUD element drawn on top of an existing one. (The
//      lobby status/sign-in banner was added at top-centre, directly over the settings
//      gear.) The client publishes each top-edge HUD element's rect to window.__hudRects
//      when loaded with `?hudprobe=1` (see draw.js hudProbeRect); the DOM gear is measured
//      live and converted into the same logical space. We fail if any two collide.
//
// Reuses the button-gate.js harness shape: boot the real server, drive Chromium in a
// touch/mobile context. Browser-dependent (Playwright + chromium), so it runs in its own
// CI job alongside button-gate.
//
// Run: node .github/scripts/mobile-layout-test.js

const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('playwright');

const repoRoot = path.join(__dirname, '..', '..');
const PORT = Number(process.env.ML_PORT) || 28914;
const ORIGIN = `http://localhost:${PORT}`;
const TOL = 2; // px slack for sub-pixel rounding

const PORTRAIT = { width: 412, height: 915 };   // Pixel-class portrait
const LANDSCAPE = { width: 915, height: 412 };   // …rotated

let failures = 0;
const fail = (m) => { console.log('::error::' + m); failures++; };
const ok = (m) => console.log('  ok: ' + m);

function boot() {
    return new Promise((res, rej) => {
        const s = spawn('node', ['index.js'], { cwd: repoRoot, env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development' } });
        let o = ''; const h = d => { o += d.toString(); if (/listening on/i.test(o)) res(s); };
        s.stdout.on('data', h); s.stderr.on('data', h);
        s.on('exit', c => rej(new Error('server exited (' + c + '):\n' + o)));
        setTimeout(() => rej(new Error('boot timeout:\n' + o)), 20000);
    });
}

// Visible elements whose right edge exceeds the viewport (the honest "page scrolls
// sideways" signal). Ignores intentionally off-screen / zero-size nodes (e.g. the
// anti-bot honeypot decoy) and elements scrolled inside an overflow:auto container.
const SCAN = (tol) => {
    const vw = document.documentElement.clientWidth;
    const out = [];
    const els = document.querySelectorAll('body *');
    for (const el of els) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 4) continue;        // decoys / hairlines
        if (r.left > vw || r.right < 0) continue;         // fully off-screen trap
        // NB: position:fixed elements are NOT skipped — a fixed bar/banner that runs
        // off the right edge is exactly the kind of regression to catch. The size +
        // off-screen filters above already exclude the off-screen anti-bot decoy.
        if (r.right > vw + tol) {
            // Skip if an ancestor is an intentional horizontal scroller (the element
            // is reachable by scrolling that strip, not by scrolling the page).
            let p = el.parentElement, scrolled = false;
            while (p) { const pc = getComputedStyle(p); if ((pc.overflowX === 'auto' || pc.overflowX === 'scroll')) { scrolled = true; break; } p = p.parentElement; }
            if (scrolled) continue;
            out.push({ tag: el.tagName.toLowerCase(), id: el.id || null, cls: (el.className && el.className.toString().slice(0, 30)) || null, right: Math.round(r.right), vw });
        }
    }
    return out;
};

async function checkOverflow(ctx, pageLabel, url, prep) {
    for (const [oLabel, vp] of [['portrait', PORTRAIT], ['landscape', LANDSCAPE]]) {
        const p = await ctx.newPage();
        await p.setViewportSize(vp);
        await p.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await p.waitForTimeout(500);
        if (prep) {
            const prepOk = await prep(p);
            await p.waitForTimeout(300);
            // prep returns false when it already recorded a failure (e.g. the editor
            // never opened) — don't scan the wrong page and report a misleading "ok".
            if (prepOk === false) { await p.close(); continue; }
        }
        const offenders = await p.evaluate(SCAN, TOL);
        const docOverflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (offenders.length) {
            fail(`${pageLabel} [${oLabel} ${vp.width}x${vp.height}] overflows by ${docOverflow}px — ${offenders.length} element(s): ` +
                offenders.slice(0, 6).map(o => `${o.tag}${o.id ? '#' + o.id : ''}${o.cls ? '.' + o.cls.split(' ')[0] : ''}(right=${o.right}>${o.vw})`).join(', '));
        } else {
            ok(`${pageLabel} [${oLabel}] no horizontal overflow`);
        }
        await p.close();
    }
}

function rectsOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

async function checkLobbyHudOverlap(browser) {
    for (const [oLabel, vp] of [['landscape', LANDSCAPE], ['portrait', PORTRAIT]]) {
        const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
        const p = await ctx.newPage();
        await p.goto(`${ORIGIN}/play.html?hudprobe=1`, { waitUntil: 'domcontentloaded' }).catch(() => {});
        const reachedLobby = await p.waitForFunction(
            () => typeof currentState !== 'undefined' && typeof config !== 'undefined' && config.stateMap && currentState === config.stateMap.lobby,
            { timeout: 15000 }).then(() => true).catch(() => false);
        if (!reachedLobby) { fail(`lobby HUD [${oLabel}] never reached lobby state — cannot verify overlap`); await ctx.close(); continue; }
        // Force the touch settings gear visible (headless can't enter fullscreen) and
        // run its canvas-relative positioner, exactly as fullscreen would.
        await p.evaluate(() => { const b = document.getElementById('touchSettingsBtn'); if (b) b.classList.add('visible'); if (typeof positionTouchSettingsButton === 'function') positionTouchSettingsButton(); });
        await p.waitForTimeout(900);
        const data = await p.evaluate(() => {
            const cv = document.getElementById('gameCanvas');
            const cr = cv.getBoundingClientRect();
            const gear = document.getElementById('touchSettingsBtn');
            const out = { hudRects: window.__hudRects || [], gear: null };
            if (gear && cr.width && cr.height) {
                const gr = gear.getBoundingClientRect();
                const sx = cr.width / LOGICAL_WIDTH, sy = cr.height / LOGICAL_HEIGHT;
                out.gear = { name: 'settingsGear', x: (gr.x - cr.x) / sx, y: (gr.y - cr.y) / sy, w: gr.width / sx, h: gr.height / sy };
            }
            return out;
        });
        const rects = data.hudRects.slice();
        if (data.gear) rects.push(data.gear);
        if (!rects.find(r => r.name === 'lobbyStatusCard')) { fail(`lobby HUD [${oLabel}] status card not published — probe wiring broken`); await ctx.close(); continue; }
        if (!data.gear) { fail(`lobby HUD [${oLabel}] settings gear not found`); await ctx.close(); continue; }
        const hits = [];
        for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
            if (rectsOverlap(rects[i], rects[j])) hits.push(`${rects[i].name} ✕ ${rects[j].name}`);
        }
        if (hits.length) {
            fail(`lobby HUD [${oLabel}] overlapping elements: ${hits.join('; ')} — rects: ` +
                JSON.stringify(rects.map(r => ({ n: r.name, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) }))));
        } else {
            ok(`lobby HUD [${oLabel}] ${rects.length} elements, no overlap (${rects.map(r => r.name).join(', ')})`);
        }
        await ctx.close();
    }
}

(async () => {
    let srv, browser;
    try {
        srv = await boot();
        browser = await chromium.launch({ headless: true });

        // --- PART 1: horizontal overflow on the menu pages ---
        const ctx = await browser.newContext({ hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
        await checkOverflow(ctx, 'index.html', `${ORIGIN}/index.html`);
        await checkOverflow(ctx, 'join.html', `${ORIGIN}/join.html`);
        await checkOverflow(ctx, 'create.html (map list)', `${ORIGIN}/create.html`);
        await checkOverflow(ctx, 'create.html (editor)', `${ORIGIN}/create.html`, async (p) => {
            // Enter the editor for real (click the New tile) so create.js initialises
            // and sizes the drawing canvas to the viewport — toggling classes alone
            // leaves #createCanvas at its unsized intrinsic width (a false positive).
            await p.click('#createNew').catch(() => {});
            const opened = await p.waitForFunction(() => {
                const cw = document.getElementById('createWindow');
                return cw && !cw.classList.contains('editor-hidden');
            }, { timeout: 8000 }).then(() => true).catch(() => false);
            // Don't let a failed editor-enter silently fall back to scanning the map
            // list (which would report a false "ok") — fail loudly instead.
            if (!opened) { fail('create.html editor never opened (#createNew) — cannot verify editor overflow'); return false; }
            await p.evaluate(() => window.dispatchEvent(new Event('resize')));
            return true;
        });
        await ctx.close();

        // --- PART 2: lobby HUD overlap ---
        await checkLobbyHudOverlap(browser);

    } catch (e) {
        fail('harness error: ' + e.message);
    } finally {
        if (browser) await browser.close();
        if (srv) srv.kill();
    }
    if (failures) { console.log(`\nFAIL — ${failures} mobile-layout problem(s)`); process.exit(1); }
    console.log('\nPASS — no horizontal overflow, no lobby HUD overlap');
})();
