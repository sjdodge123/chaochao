'use strict';

// Client perf regression gate (P1b gate). Compares two perf-client.js JSON
// outputs (base branch vs PR) and gates on the DELTA — the only meaningful
// signal, since the headless software-raster baseline is environment-dependent
// and absolute ms is not an iPad FPS. Writes a $GITHUB_STEP_SUMMARY table and a
// sticky PR-comment body (marker so CI can update one comment in place).
//
// Usage: node perf-compare.js <base.json> <pr.json>
// Env: PERF_REGRESS_PCT (default 15) — fail if scripting ms/frame regresses more
//      than this % over base. PERF_COMMENT_OUT — path to write the comment body.
//      PERF_GATE_SOFT=1 — report only, always exit 0 (non-blocking job).

const fs = require('fs');

const [, , basePath, prPath] = process.argv;
// Number.isFinite check (not `|| 15`) so PERF_REGRESS_PCT=0 — "fail on ANY
// regression" — is honored rather than silently reset to 15%.
const REGRESS_PCT = Number.isFinite(Number(process.env.PERF_REGRESS_PCT)) ? Number(process.env.PERF_REGRESS_PCT) : 15;
const SOFT = process.env.PERF_GATE_SOFT === '1';
const COMMENT_OUT = process.env.PERF_COMMENT_OUT || '';
const MARKER = '<!-- chaochao-perf -->';

if (!basePath || !prPath) { console.error('usage: perf-compare.js <base.json> <pr.json>'); process.exit(2); }

function read(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
const base = read(basePath);
const pr = read(prPath);
const f = (n) => (Number.isFinite(n) ? n.toFixed(2) : 'n/a');
function deltaPct(b, p) { return (b && Number.isFinite(b) && Number.isFinite(p)) ? ((p - b) / b) * 100 : NaN; }
function sign(n) { return n > 0 ? '+' : ''; }

if (!pr) { console.error('::error::missing PR metrics (' + prPath + ')'); process.exit(2); }

// The gate can only run if there's a base WITH a usable scripting metric. A
// missing base (predates this job) OR a present-but-degenerate base (missing/zero
// scriptMsPerFrame from an old schema or a failed baseline run) both mean "cannot
// compare" — report that honestly instead of letting a NaN delta read as "✅".
const haveBase = !!base;
const baseUsable = haveBase && Number.isFinite(base.scriptMsPerFrame) && base.scriptMsPerFrame > 0;
const scriptDelta = baseUsable ? deltaPct(base.scriptMsPerFrame, pr.scriptMsPerFrame) : NaN;
const heapDelta = baseUsable ? deltaPct(base.heapMB, pr.heapMB) : NaN;
const frameDelta = baseUsable ? deltaPct(base.frameWorkP95Ms, pr.frameWorkP95Ms) : NaN;

const compared = Number.isFinite(scriptDelta);
const regressed = compared && scriptDelta > REGRESS_PCT;

function row(label, b, p, d, unit) {
    const dStr = Number.isFinite(d) ? `${sign(d)}${d.toFixed(1)}%` : 'n/a';
    return `| ${label} | ${baseUsable ? f(b) + unit : '—'} | ${f(p)}${unit} | ${dStr} |`;
}

const lines = [
    `### Client render-perf — base vs PR ${regressed ? '❌ regression' : (compared ? '✅' : 'ℹ️')}`,
    '',
    compared
        ? `Gate: scripting ms/frame must not regress **> ${REGRESS_PCT}%** vs \`main\`. _(Headless software raster — absolute ms is not an iPad FPS; only the delta is meaningful. Calibrate absolute mobile perf on a real iPad — see docs/spikes/perf-and-input-ci.md.)_`
        : (haveBase
            ? `_Base metrics present but unusable (missing/zero scripting field) — the gate could not run; showing PR measurement only._`
            : `_No base metrics found (base branch predates this job) — showing PR measurement only._`),
    '',
    `Scenario: **${pr.karts} karts**, forced brutal round.`,
    '',
    '| metric | base (`main`) | PR | Δ |',
    '| --- | --- | --- | --- |',
    row('**scripting ms/frame** (gated)', base && base.scriptMsPerFrame, pr.scriptMsPerFrame, scriptDelta, ''),
    row('frame-work p95 (ms, context)', base && base.frameWorkP95Ms, pr.frameWorkP95Ms, frameDelta, ''),
    row('JS heap (MB, context)', base && base.heapMB, pr.heapMB, heapDelta, ''),
    '',
    regressed
        ? `⚠️ **scripting ms/frame regressed ${sign(scriptDelta)}${scriptDelta.toFixed(1)}%** (> ${REGRESS_PCT}% threshold). A change made the per-frame render/JS work heavier.`
        : (compared ? `Within threshold.` : ''),
];

const body = lines.join('\n');
console.log(body);

if (process.env.GITHUB_STEP_SUMMARY) { try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, body + '\n'); } catch (e) {} }
if (COMMENT_OUT) { try { fs.writeFileSync(COMMENT_OUT, MARKER + '\n' + body + '\n'); } catch (e) {} }

if (regressed && !SOFT) { process.exit(1); }
process.exit(0);
