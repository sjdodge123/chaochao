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
//                      https://raw.githubusercontent.com/<owner>/<repo>/map-previews/pr-123/
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
    const spread = fast > 0 ? (slow - fast) / fast : 0;
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
lines.push('> 👀 **Manual review:** check the images for inappropriate imagery or profanity painted into the tiles. ' +
    'The left image is rendered from the actual map data; the right is the editor\'s own capture. ' +
    'A mismatch between them is itself a red flag.');
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

    // Facts line.
    const facts = [];
    if (m.parTime) { facts.push('par ≈ ' + m.parTime.toFixed(1) + 's'); }
    if (m.sim && !m.sim.error) {
        facts.push(m.sim.scored
            ? 'sim: racer reached goal in ' + m.sim.seconds + 's (' + m.sim.bots + ' bots)'
            : 'sim: no racer scored within ' + m.sim.budgetSec + 's');
    }
    if (facts.length) { lines.push(''); lines.push('_' + facts.join(' · ') + '_'); }

    // Images side by side (HTML table renders in GitHub comments).
    const server = imgUrl(m.serverImage);
    const thumb = imgUrl(m.thumbImage);
    if (server || thumb) {
        lines.push('');
        lines.push('<table><tr>');
        lines.push('<td align="center"><b>Server render (authoritative)</b><br>' +
            (server ? '<img src="' + server + '" width="380">' : '<i>render unavailable</i>') + '</td>');
        lines.push('<td align="center"><b>Editor thumbnail (submitted)</b><br>' +
            (thumb ? '<img src="' + thumb + '" width="380">' : '<i>no thumbnail</i>') + '</td>');
        lines.push('</tr></table>');
    } else {
        lines.push('');
        lines.push('_(no preview images available' +
            (m.serverImage || m.thumbImage ? '; set IMAGE_BASE_URL to embed them' : '') + ')_');
    }

    // Competing lines: the routes the AI's own pathing finds, timed by the engine's
    // physics-walk. The spread of times is the competitiveness read.
    if (Array.isArray(m.routes) && m.routes.length > 0) {
        lines.push('');
        lines.push('**Competing lines** — ' + competitiveness(m.routes));
        const routesImg = imgUrl(m.routeImage);
        if (routesImg) {
            lines.push('');
            lines.push('<img src="' + routesImg + '" width="560">');
        }
        lines.push('');
        lines.push('| Line | Time to goal |');
        lines.push('| --- | --- |');
        for (const r of m.routes) {
            lines.push('| ' + SWATCH[r.color] + ' ' + r.label + ' | ' + r.seconds.toFixed(1) + ' seconds |');
        }
    }
    lines.push('');
}

lines.push('---');
lines.push('<sub>🤖 Generated by the map-submission review workflow.</sub>');

process.stdout.write(lines.join('\n') + '\n');
