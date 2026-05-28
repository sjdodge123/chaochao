'use strict';

// Static input-validation lint — zero new dependencies.
//
// Every <input>/<textarea> added to a client HTML page should declare basic
// input bounds, so the next "what could a crafted payload do?" review starts
// with the answer already at the boundary. The lint is forward-looking: it is
// calibrated to PASS on the current tree (no allowlist — every existing input
// is compliant) so a NEW unvalidated input fails the PR.
//
// Per-type requirements:
//   text / search / email / tel / url / password / (no type) / textarea
//                — needs `maxlength` OR `pattern` (length or format bound)
//   number       — needs `max` (length doesn't bound numeric value)
//   file         — needs `accept` (MIME constraint)
//   button / submit / reset / checkbox / radio / hidden / color / date / time /
//   datetime-local / month / week / image / range
//                — inherently bounded; no requirement
//
// Pre-existing exceptions that intentionally skip a rule go in ALLOWLIST below
// (each entry documents WHY). Adding to it should be a deliberate decision, not
// a way to dodge the gate for a fresh input.
//
// Scope: client/*.html. Inputs injected by JS (createElement('input'),
// innerHTML strings) aren't scanned here — there are none in the tree today;
// prefer authoring inputs in HTML, or extend this lint if that changes.

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const clientDir = path.join(repoRoot, 'client');

const NEEDS_NONE = new Set([
    'button', 'submit', 'reset', 'checkbox', 'radio', 'hidden',
    'color', 'date', 'time', 'datetime-local', 'month', 'week',
    'image', 'range',
]);

// Allowlist: pre-existing controls that intentionally skip a rule. Each entry
// documents WHY. New controls are not allowlisted — they must comply.
const ALLOWLIST = [
    // (empty — the tree is currently fully compliant)
];

function attr(s, n) {
    // Match double- OR single-quoted attribute values.
    const m = s.match(new RegExp(n + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'i'));
    return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
}

function extract(html) {
    const els = [];
    // Catches both void <input ...> / <input ... /> and the opening <textarea ...>
    // tag (we only need its attributes — body length is what maxlength bounds).
    const re = /<(input|textarea)\b([^>]*?)\/?>/gi;
    let m;
    while ((m = re.exec(html))) {
        const tag = m[1].toLowerCase();
        const at = m[2];
        // textarea has no `type=`; treat it as the "textarea" type so its rule
        // matches the text-like family.
        const type = (attr(at, 'type') || (tag === 'textarea' ? 'textarea' : 'text')).toLowerCase();
        els.push({
            tag, id: attr(at, 'id') || '', type,
            maxlength: attr(at, 'maxlength'),
            pattern: attr(at, 'pattern'),
            max: attr(at, 'max'),
            min: attr(at, 'min'),
            accept: attr(at, 'accept'),
            raw: m[0],
        });
    }
    return els;
}

function checkOne(page, e) {
    // type-based requirement; returns null if compliant, otherwise a reason
    // string for an ::error annotation.
    if (NEEDS_NONE.has(e.type)) return null;
    if (e.type === 'number') {
        if (e.max == null) {
            return 'is missing a "max" attribute (numeric inputs need an upper bound).';
        }
        return null;
    }
    if (e.type === 'file') {
        if (e.accept == null) {
            return 'is missing an "accept" attribute (file inputs should constrain MIME types).';
        }
        return null;
    }
    // text / search / email / tel / url / password / unknown / textarea
    if (e.maxlength == null && e.pattern == null) {
        return 'is missing a "maxlength" or "pattern" attribute (text inputs need length or format bounds).';
    }
    return null;
}

let failures = 0, checked = 0, allowed = 0;
const summaryRows = [];

const pages = fs.readdirSync(clientDir).filter(f => f.endsWith('.html')).sort();
for (const page of pages) {
    const html = fs.readFileSync(path.join(clientDir, page), 'utf8');
    const els = extract(html);

    for (const e of els) {
        checked++;
        const label = `${page} ${e.tag}#${e.id || '(no-id)'} type=${e.type}`;

        let skipped = false;
        for (const a of ALLOWLIST) {
            if (a.page === page && a.match(e)) {
                skipped = true; allowed++;
                console.log(`  • allow ${label}: ${a.why}`);
                break;
            }
        }
        if (skipped) continue;

        const reason = checkOne(page, e);
        if (reason) {
            console.log(`::error file=client/${page}::${label} ${reason}`);
            failures++;
        }
    }
    summaryRows.push(`| \`${page}\` | ${els.length} | per-type bounds (maxlength / pattern / max / accept) |`);
}

const lines = [
    '### Static input-validation lint',
    '',
    `Checked **${checked}** input/textarea field(s) across ${pages.length} page(s) (${allowed} allowlisted exception(s)). ${failures ? '❌ ' + failures + ' violation(s)' : '✅ all compliant'}`,
    '',
    '| page | inputs | rules |',
    '| --- | --- | --- |',
    ...summaryRows,
];
console.log('\n' + lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n'); } catch (e) {}
}

if (failures > 0) {
    console.log(`\nInput-validation lint FAILED with ${failures} violation(s).`);
    process.exit(1);
}
console.log('\nInput-validation lint passed.');
process.exit(0);
