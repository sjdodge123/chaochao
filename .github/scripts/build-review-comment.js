'use strict';

// Renders the map-submission review verdict (result.json from
// validate-submitted-map.js) into the markdown body posted as a sticky PR
// comment. Kept separate from the validator so the comment layout is testable
// without re-running the engine, and so the workflow can inject the hosted image
// URLs (which only exist after the preview images are pushed) at this stage.
//
// Env:
//   MAP_REVIEW_OUTPUT  dir holding result.json (default ./map-review-out)
//   IMAGE_BASE_URL     raw base URL the images were published under, e.g.
//                      https://raw.githubusercontent.com/<owner>/<repo>/map-previews-pr-123/
//                      (trailing slash optional). If unset, image filenames are
//                      shown as plain text so the comment still renders.
//
// Prints the markdown to stdout.

const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = process.env.MAP_REVIEW_OUTPUT || path.join(__dirname, '..', '..', 'map-review-out');
const BASE = (process.env.IMAGE_BASE_URL || '').replace(/\/?$/, '/');
const MARKER = '<!-- map-submission-review -->';

function imgUrl(name) {
    if (name == null) { return null; }
    return BASE && BASE !== '/' ? BASE + encodeURIComponent(name) : null;
}

// Emoji swatches roughly matching render-map.js ROUTE_COLORS (the overlay image
// is the precise reference; these just help line up table rows to trails).
const SWATCH = { magenta: '🟣', cyan: '🔵', white: '⚪', purple: '🟪' };

// One-line read on how competitive the map is, from the spread of line times.
function competitiveness(routes) {
    if (routes.length < 2) { return 'only one viable line found — likely a single dominant route.'; }
    const times = routes.map(r => r.seconds);
    const fast = Math.min(...times), slow = Math.max(...times);
    // A fastest line that rounds to 0s means the goal sits right at the start — a
    // percentage spread is meaningless (and would divide by zero), so call it out.
    if (fast <= 0) { return routes.length + ' near-instant lines — the goal sits right at the start gate.'; }
    const spread = (slow - fast) / fast;
    if (spread < 0.15) { return routes.length + ' lines within ' + Math.round(spread * 100) + '% of each other — very competitive (many viable routes).'; }
    if (spread < 0.4) { return 'a clear fastest line with viable alternatives (' + Math.round(spread * 100) + '% slower).'; }
    return 'one line dominates (alternatives are ' + Math.round(spread * 100) + '% slower).';
}

let result;
try {
    result = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, 'result.json'), 'utf8'));
} catch (e) {
    process.stdout.write(MARKER + '\n### 🗺️ Map submission review\n\n' +
        '⚠️ The review step did not produce a result (`result.json` missing). Check the workflow logs.\n');
    process.exit(0);
}

const lines = [];
lines.push(MARKER);
lines.push('### 🗺️ Map submission review');
lines.push('');
lines.push(result.overallPass
    ? '**✅ Automated checks passed.** Please still eyeball the rendered map below before merging.'
    : '**❌ Automated checks failed.** See the issues per map below.');
lines.push('');
lines.push('> 👀 **Manual review:** the image below is rendered from the actual painted tiles — ' +
    'eyeball it for inappropriate imagery or profanity before merging.');
lines.push('');

for (const m of result.maps) {
    const icon = m.verdict === 'pass' ? '✅' : '❌';
    lines.push('#### ' + icon + ' `' + m.file + '`' + (m.mapName ? ' — *' + m.mapName + '*' : ''));

    if (m.errors && m.errors.length) {
        lines.push('');
        lines.push('**Blocking issues:**');
        for (const e of m.errors) { lines.push('- ❌ ' + e); }
    }
    if (m.warnings && m.warnings.length) {
        lines.push('');
        lines.push('**Warnings:**');
        for (const w of m.warnings) { lines.push('- ⚠️ ' + w); }
    }

    // Facts line + the server-vs-submitted preview integrity PASS/FAIL.
    const facts = [];
    if (m.parTime) { facts.push('par ≈ ' + m.parTime.toFixed(1) + 's'); }
    if (m.previewIntegrity) {
        facts.push('preview integrity: ' + (m.previewIntegrity.pass ? '🟢 PASS' : '🔴 FAIL — ' + m.previewIntegrity.detail));
    }
    if (m.sim && !m.sim.error) {
        facts.push(m.sim.scored
            ? 'sim: racer reached goal in ' + m.sim.seconds + 's (' + m.sim.bots + ' bots)'
            : 'sim: no racer scored within ' + m.sim.budgetSec + 's');
    }
    if (facts.length) { lines.push(''); lines.push('_' + facts.join(' · ') + '_'); }

    // Image 1 — the authoritative map render.
    const server = imgUrl(m.serverImage);
    lines.push('');
    if (server) {
        lines.push('<b>Map</b> (rendered from the actual painted tiles)<br>');
        lines.push('<img src="' + server + '" width="560">');
    } else {
        lines.push('_(map render unavailable' + (m.serverImage ? '; set IMAGE_BASE_URL to embed it' : '') + ')_');
    }

    // Image 2 — competing racing lines (AI pathing, timed by the physics-walk).
    // The table rows are colour-matched to the trails drawn on the image.
    if (Array.isArray(m.routes) && m.routes.length > 0) {
        lines.push('');
        lines.push('**Competing lines** — ' + competitiveness(m.routes));
        const routesImg = imgUrl(m.routeImage);
        if (routesImg) {
            lines.push('');
            lines.push('<img src="' + routesImg + '" width="560">');
        }
        lines.push('');
        lines.push('| Line | Colour | Time to goal |');
        lines.push('| --- | --- | --- |');
        for (const r of m.routes) {
            const swatch = SWATCH[r.color] || '▪️';
            lines.push('| ' + r.label + ' | ' + swatch + ' ' + r.color + ' | ' + r.seconds.toFixed(1) + ' seconds |');
        }
    }
    lines.push('');
}

lines.push('---');
lines.push('<sub>🤖 Generated by the map-submission review workflow.</sub>');

process.stdout.write(lines.join('\n') + '\n');
