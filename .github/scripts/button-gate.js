'use strict';

// Runtime button input-compliance gate (P2b). Requires Playwright + axe-core.
//
// The authoritative companion to the static lint (P2a): it loads each page in a
// real (touch, iPad-ish) browser and checks every interactive control — INCLUDING
// the ~26 jQuery-injected ones the static lint can't see — for:
//   1. Accessible name / valid role — axe-core, scoped to interactive-control
//      rules only (button-name, link-name, …), not general page a11y.
//   2. Touch-target size — ≥44px target (the project's own input.js standard);
//      <24px hard-fails (WCAG 2.5.8 AA floor), 24–44px warns.
//   3. Gamepad reachability — every visible, enabled control must be reachable by
//      its page's gamepad nav selector (read live from menuGamepad/editorGamepad
//      so this stays in lockstep), or match a known in-game pattern (play.html),
//      or be an explicitly documented allowlist exception.
//
// Pre-existing exceptions are allowlisted (printed with reasons), so the gate is
// calibrated to PASS on the current tree and enforce the standard for NEW buttons.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { AxeBuilder } = require('@axe-core/playwright');

const repoRoot = path.join(__dirname, '..', '..');
const PORT = Number(process.env.BTN_PORT) || 28913;
const ORIGIN = `http://localhost:${PORT}`;

const TARGET_PX = 44;   // project standard (input.js)
const FLOOR_PX = 24;    // WCAG 2.5.8 AA minimum — hard fail below this
const INTERACTIVE = 'button, a[role="button"], a.btn, input.form-control, [onclick]';
const CONTROL_RULES = ['button-name', 'link-name', 'input-button-name', 'aria-command-name', 'aria-toggle-field-name', 'aria-input-field-name', 'select-name', 'nested-interactive'];

// Pre-existing, documented exceptions. New controls are NOT here — they comply.
const ALLOW = {
    size: {
        themeToggle: 'JS-injected navbar theme button, pre-existing 34px — recommend bump to 44px',
        freeRewardButton: 'invisible anti-bot honeypot decoy — intentionally a 1px off-screen trap, never a real touch target (see botGuard.js)',
    },
    reach: {
        themeToggle: 'reachable in-game via the Settings panel (gamepad.js); secondary navbar affordance on menu pages',
        freeRewardButton: 'invisible anti-bot honeypot decoy — must NOT be gamepad-reachable; only a DOM-scraping bot should ever reach it (see botGuard.js)',
    },
};

// Read the gamepad nav selectors from source so the gate tracks them if they change.
function readSelector(file, varName) {
    const src = fs.readFileSync(path.join(repoRoot, 'client', 'scripts', file), 'utf8');
    const m = src.match(new RegExp(varName + '\\s*=\\s*"([^"]*)"'));
    return m ? m[1] : null;
}
const MENU_NAV = readSelector('menuGamepad.js', 'NAV_SELECTOR');
const EG_NAV = readSelector('editorGamepad.js', 'EG_NAV_SELECTOR');
// play.html in-game reachability: navbar toggles (Settings panel) + emoji menu.
const PLAY_NAV = '.nav-toggle, #themeToggle, #emojiMenu a';

const PAGES = [
    { page: 'index.html', nav: MENU_NAV },
    { page: 'join.html', nav: MENU_NAV },
    { page: 'create.html', nav: EG_NAV },
    { page: 'play.html', nav: PLAY_NAV },
];

function boot() {
    return new Promise((res, rej) => {
        const s = spawn('node', ['index.js'], { cwd: repoRoot, env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development' } });
        let o = ''; const h = d => { o += d.toString(); if (/listening on/i.test(o)) res(s); };
        s.stdout.on('data', h); s.stderr.on('data', h);
        s.on('exit', c => rej(new Error('server exited (' + c + '):\n' + o)));
        setTimeout(() => rej(new Error('boot timeout:\n' + o)), 20000);
    });
}

let failures = 0, warnings = 0;
const fail = (m) => { console.log('::error::' + m); failures++; };
const warn = (m) => { console.log('::warning::' + m); warnings++; };
const rows = [];

(async () => {
    if (!MENU_NAV || !EG_NAV) { fail('could not read gamepad nav selectors from source'); process.exit(1); }
    let srv, browser;
    try {
        srv = await boot();
        browser = await chromium.launch({ headless: true });
        const ctx = await browser.newContext({ viewport: { width: 1194, height: 834 }, deviceScaleFactor: 2, hasTouch: true });

        for (const { page, nav } of PAGES) {
            const p = await ctx.newPage();
            await p.goto(`${ORIGIN}/${page}`, { waitUntil: 'networkidle' }).catch(() => {});
            await p.waitForTimeout(2500);
            let pFail = 0;

            // 1. axe — interactive-control rules only
            try {
                const res = await new AxeBuilder({ page: p }).options({ runOnly: { type: 'rule', values: CONTROL_RULES } }).analyze();
                // Guard against a vacuous pass: if a rule id is misspelled or was
                // renamed/removed in an axe upgrade, axe silently runs zero of it and
                // reports no violations. A rule that ran appears in exactly one of
                // these result buckets; flag any requested rule that appears in none.
                const ran = new Set([...res.violations, ...res.passes, ...res.incomplete, ...res.inapplicable].map(r => r.id));
                for (const ruleId of CONTROL_RULES) {
                    if (!ran.has(ruleId)) { fail(`${page}: axe rule "${ruleId}" did not run (renamed/removed in axe-core?) — the gate would pass it vacuously`); pFail++; }
                }
                for (const v of res.violations) {
                    for (const node of v.nodes) {
                        fail(`${page}: a11y [${v.id}] ${node.target.join(' ')} — ${v.help}`); pFail++;
                    }
                }
            } catch (e) { fail(`${page}: axe error: ${e.message}`); }

            // 2. size + 3. reachability (one DOM pass)
            const data = await p.evaluate(({ interactive, navSel }) => {
                // Rendered = has a non-zero box. Excludes controls that exist in the DOM
                // but aren't currently shown (e.g. the emoji wheel's options while the
                // menu is closed) — those aren't touchable/focusable in this state.
                const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
                const enabled = el => !el.disabled && el.getAttribute('aria-disabled') !== 'true';
                const all = [...document.querySelectorAll(interactive)].filter(el => vis(el) && enabled(el));
                const reachable = new Set([...document.querySelectorAll(navSel)].filter(vis));
                const desc = el => ({ id: el.id || '', cls: (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) || '', tag: el.tagName.toLowerCase() });
                return {
                    sizes: all.map(el => { const r = el.getBoundingClientRect(); return { ...desc(el), w: Math.round(r.width), h: Math.round(r.height) }; }),
                    unreachable: all.filter(el => !reachable.has(el)).map(desc),
                    total: all.length, reachableCount: reachable.size,
                };
            }, { interactive: INTERACTIVE, navSel: nav });

            // size
            for (const e of data.sizes) {
                const tag = `${e.tag}#${e.id || '(no-id)'} (${e.w}×${e.h})`;
                const small = e.w < TARGET_PX || e.h < TARGET_PX;
                const tiny = e.w < FLOOR_PX || e.h < FLOOR_PX;
                if (!small) continue;
                if (e.id && ALLOW.size[e.id]) { console.log(`  • allow size ${page} ${tag}: ${ALLOW.size[e.id]}`); continue; }
                if (tiny) { fail(`${page}: ${tag} below ${FLOOR_PX}px WCAG AA floor`); pFail++; }
                else { fail(`${page}: ${tag} below the ${TARGET_PX}px touch-target standard`); pFail++; }
            }
            // reachability
            for (const e of data.unreachable) {
                const tag = `${e.tag}#${e.id || '(no-id)'}`;
                if (e.id && ALLOW.reach[e.id]) { console.log(`  • allow reach ${page} ${tag}: ${ALLOW.reach[e.id]}`); continue; }
                fail(`${page}: ${tag} class="${e.cls}" is not gamepad-reachable (no match for "${nav}")`); pFail++;
            }

            rows.push(`| \`${page}\` | ${data.total} | ${data.reachableCount} | ${pFail ? '❌ ' + pFail : '✅'} |`);
            await p.close();
        }
    } catch (e) {
        fail('gate error: ' + e.message);
    } finally {
        if (browser) await browser.close().catch(() => {});
        if (srv) srv.kill('SIGKILL');
    }

    const lines = [
        '### Runtime button input-compliance (P2b)',
        '',
        `axe control-rules + ≥${TARGET_PX}px touch targets + gamepad-reachability, on the **live DOM** (incl. JS-injected controls). ${failures ? '❌ ' + failures + ' violation(s)' : '✅ all compliant'}${warnings ? ' · ' + warnings + ' warning(s)' : ''}`,
        '',
        '| page | interactive (live) | gamepad-reachable | result |',
        '| --- | --- | --- | --- |',
        ...rows,
    ];
    console.log('\n' + lines.join('\n'));
    if (process.env.GITHUB_STEP_SUMMARY) { try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n'); } catch (e) {} }

    if (failures > 0) { console.log(`\nButton gate FAILED with ${failures} violation(s).`); process.exit(1); }
    console.log('\nButton gate passed.');
    process.exit(0);
})();
