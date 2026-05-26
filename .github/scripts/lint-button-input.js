'use strict';

// Static button input-compliance lint (P2a) — zero new dependencies.
//
// Fast, browser-free first line of defense: parses the committed HTML and gates
// every interactive control (button / button-like link / form input) on the
// conventions every existing control already follows, so a NEWLY added button
// that forgets them fails the PR. Checks:
//   1. Accessible name   — visible text, title, aria-label, or a child img[alt].
//   2. Known styling class — btn / mapEditorTile / nav-toggle / form-control.
//   3. Gamepad reachability (menu pages only, where the nav selector is global):
//      on index/join every control must match menuGamepad's
//      NAV_SELECTOR = "a.btn, button.btn, input.form-control".
// Reachability on play.html (in-game Settings panel) and create.html (scoped
// #controlPanel/#loadWindow selectors) depends on DOM nesting/runtime state, so
// it is verified authoritatively by the runtime gate (P2b), not here.
//
// Pre-existing intentional exceptions are allowlisted below (not silently — each
// prints its reason). The lint is calibrated to PASS on the current tree.

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const clientDir = path.join(repoRoot, 'client');

const MENU_PAGES = new Set(['index.html', 'join.html']); // load menuGamepad (global selector)
const KNOWN_CLASSES = ['btn', 'mapEditorTile', 'nav-toggle', 'form-control', 'confirm-btn'];

// Allowlist: pre-existing controls that intentionally skip a rule. Each entry
// documents WHY. New controls are not allowlisted — they must comply.
const ALLOWLIST = [
    { page: 'play.html', match: (e) => /closeEmojiWindow/.test(e.raw), skip: ['class'],
      why: 'icon emoji-cancel link (has aria-label); reachable via gamepad.js "#emojiMenu a"' },
    { page: 'create.html', match: (e) => e.id === 'createNew', skip: ['class'],
      why: 'id-styled "Create a new map" tile; reachable via editorGamepad "#loadWindow button"' },
];

function attr(s, n) {
    // Match double- OR single-quoted attribute values (a new button may use either).
    const m = s.match(new RegExp(n + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'i'));
    return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
}
function hasClass(cls, name) { return new RegExp('(^|\\s)' + name + '($|\\s)').test(cls || ''); }
function stripTags(s) { return (s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }

// Extract interactive controls (open tag + inner content for non-void elements).
function extract(html) {
    const els = [];
    const re = /<(button|a|input)\b([^>]*?)(\/?)>/gi;
    let m;
    while ((m = re.exec(html))) {
        const tag = m[1].toLowerCase();
        const at = m[2];
        const cls = attr(at, 'class') || '';
        const role = attr(at, 'role') || '';
        const onclick = /\bonclick\b/i.test(at);
        const interactive =
            tag === 'button' ||
            (tag === 'a' && (hasClass(cls, 'btn') || role === 'button' || onclick)) ||
            (tag === 'input' && hasClass(cls, 'form-control'));
        if (!interactive) continue;

        let inner = '';
        if (tag !== 'input') {
            const close = html.indexOf('</' + tag + '>', re.lastIndex);
            if (close !== -1) inner = html.slice(re.lastIndex, close);
        }
        const imgAlt = inner ? attr(inner, 'alt') : null;
        const childAria = inner ? attr(inner, 'aria-label') : null;
        els.push({
            tag, id: attr(at, 'id') || '', cls, role,
            title: attr(at, 'title'), ariaLabel: attr(at, 'aria-label'),
            placeholder: attr(at, 'placeholder'),
            disabled: /\bdisabled\b/i.test(at),
            text: stripTags(inner), imgAlt, childAria,
            raw: m[0],
        });
    }
    return els;
}

function accessibleName(e) {
    return e.ariaLabel || e.title || e.text || e.imgAlt || e.childAria ||
        (e.tag === 'input' ? e.placeholder : null) || '';
}
function matchesMenuSelector(e) {
    return (e.tag === 'a' && hasClass(e.cls, 'btn')) ||
        (e.tag === 'button' && hasClass(e.cls, 'btn')) ||
        (e.tag === 'input' && hasClass(e.cls, 'form-control'));
}

let failures = 0, checked = 0, allowed = 0;
const summaryRows = [];

for (const page of ['index.html', 'play.html', 'join.html', 'create.html']) {
    const file = path.join(clientDir, page);
    if (!fs.existsSync(file)) continue;
    const html = fs.readFileSync(file, 'utf8');
    const els = extract(html);
    const isMenu = MENU_PAGES.has(page);

    for (const e of els) {
        checked++;
        const label = `${page} ${e.tag}#${e.id || '(no-id)'}`;
        const skips = [];
        for (const a of ALLOWLIST) {
            if (a.page === page && a.match(e)) { skips.push(...a.skip); allowed++; console.log(`  • allow ${label}: ${a.why}`); }
        }

        // 1. accessible name (disabled controls are exempt — not actionable; their
        //    name is set when JS enables/populates them, verified live by P2b)
        if (!skips.includes('name') && !e.disabled && !accessibleName(e)) {
            console.log(`::error file=client/${page}::${label} has no accessible name (add text, title, aria-label, or a child img[alt]).`);
            failures++;
        }
        // 2. known styling class (skip plain text inputs — covered by reachability)
        if (!skips.includes('class') && e.tag !== 'input' && !KNOWN_CLASSES.some(k => hasClass(e.cls, k))) {
            console.log(`::error file=client/${page}::${label} is missing a known styling class (one of: ${KNOWN_CLASSES.join(', ')}).`);
            failures++;
        }
        // 3. gamepad reachability — menu pages only (global selector)
        if (isMenu && !skips.includes('reach') && !matchesMenuSelector(e)) {
            console.log(`::error file=client/${page}::${label} is not gamepad-reachable: must match menuGamepad NAV_SELECTOR (a.btn, button.btn, input.form-control).`);
            failures++;
        }
    }
    summaryRows.push(`| \`${page}\` | ${els.length} | ${isMenu ? 'name + class + reachability' : 'name + class (reachability → P2b)'} |`);
}

const lines = [
    '### Static button input-compliance (P2a)',
    '',
    `Checked **${checked}** interactive controls across 4 pages (${allowed} allowlisted exception(s)). ${failures ? '❌ ' + failures + ' violation(s)' : '✅ all compliant'}`,
    '',
    '| page | controls | static checks |',
    '| --- | --- | --- |',
    ...summaryRows,
];
console.log('\n' + lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) { try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n'); } catch (e) {} }

if (failures > 0) { console.log(`\nButton lint FAILED with ${failures} violation(s).`); process.exit(1); }
console.log('\nButton lint passed.');
process.exit(0);
