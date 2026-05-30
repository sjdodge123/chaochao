'use strict';

// Client perf regression gate (P1b gate). Compares two perf-client.js JSON
// outputs (base branch vs PR) and gates on the DELTA — the only meaningful
// signal, since the headless software-raster baseline is environment-dependent
// and absolute ms is not an iPad FPS. Writes a $GITHUB_STEP_SUMMARY table and a
// sticky PR-comment body (marker so CI can update one comment in place).
//
// Usage: node perf-compare.js <base.json> <pr.json>
// Env: PERF_REGRESS_PCT (default 20) — fail if scripting ms/frame regresses more
//      than this % over base. PERF_MIN_VALID_REPS (default 3) — a half measured
//      from fewer valid windows is treated as INCONCLUSIVE, not a regression.
//      PERF_COMMENT_OUT — path to write the comment body.
//      PERF_GATE_SOFT=1 — report only, always exit 0 (non-blocking job).

const fs = require('fs');

const [, , basePath, prPath] = process.argv;
// Number.isFinite check (not `|| 20`) so PERF_REGRESS_PCT=0 — "fail on ANY
// regression" — is honored rather than silently reset to the default.
const REGRESS_PCT = Number.isFinite(Number(process.env.PERF_REGRESS_PCT)) ? Number(process.env.PERF_REGRESS_PCT) : 20;
const MIN_VALID_REPS = Number(process.env.PERF_MIN_VALID_REPS) || 3;
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
// A half is degenerate when the harness couldn't collect enough valid windows
// (runner too contended). Honor the explicit flag the harness writes, falling back
// to the rep count for older payloads. A degenerate half makes the run INCONCLUSIVE
// rather than a regression — the whole point of the accuracy rework is to never
// invent a regression out of a starved measurement.
function degenerate(m) {
    if (!m) return true;
    if (typeof m.degenerate === 'boolean') return m.degenerate;
    if (Number.isFinite(m.validReps)) return m.validReps < MIN_VALID_REPS;
    return false; // pre-rep schema: assume the single sample stands
}

if (!pr) { console.error('::error::missing PR metrics (' + prPath + ')'); process.exit(2); }

// New-schema = produced by the median/rep harness (carries validReps). Comparing a
// MEDIAN to an old single-window sample is apples-to-oranges in EITHER direction:
// during rollout the base (merge-base checkout) may still run the old harness, and a
// PR could equally revert/modify perf-client.js to emit the old schema against a new
// base. So treat ANY disagreement between the two halves' schema versions as
// inconclusive — not just the new-PR/old-base case.
const newSchema = (m) => !!m && Number.isFinite(m.validReps);
const schemaMismatch = !!base && (newSchema(pr) !== newSchema(base));

// The gate can only run if there's a base WITH a usable scripting metric. A
// missing base (predates this job) OR a present-but-degenerate base (missing/zero
// scriptMsPerFrame from an old schema or a failed baseline run) both mean "cannot
// compare" — report that honestly instead of letting a NaN delta read as "✅".
const haveBase = !!base;
const baseDegenerate = degenerate(base);
const prDegenerate = degenerate(pr);
const inconclusive = baseDegenerate || prDegenerate || schemaMismatch;
const baseUsable = haveBase && !baseDegenerate && Number.isFinite(base.scriptMsPerFrame) && base.scriptMsPerFrame > 0;
const canGate = baseUsable && !prDegenerate && !schemaMismatch;
const scriptDelta = baseUsable ? deltaPct(base.scriptMsPerFrame, pr.scriptMsPerFrame) : NaN;
const heapDelta = baseUsable ? deltaPct(base.heapMB, pr.heapMB) : NaN;
const frameDelta = baseUsable ? deltaPct(base.frameWorkP95Ms, pr.frameWorkP95Ms) : NaN;

// "compared" = we actually have a base-vs-PR delta to show. "regressed" gates ONLY
// when both halves were measured cleanly (canGate) — a contended/degenerate half
// shows the delta for context but never fails the build.
const compared = Number.isFinite(scriptDelta);
const regressed = canGate && compared && scriptDelta > REGRESS_PCT;

function row(label, b, p, d, unit) {
    const dStr = Number.isFinite(d) ? `${sign(d)}${d.toFixed(1)}%` : 'n/a';
    return `| ${label} | ${Number.isFinite(b) ? f(b) + unit : '—'} | ${f(p)}${unit} | ${dStr} |`;
}

const icon = regressed ? '❌ regression' : (inconclusive ? 'ℹ️ inconclusive' : (canGate ? '✅' : 'ℹ️'));
// Spell out WHY a run is inconclusive so a degenerate half never reads as a pass.
const degenWho = baseDegenerate && prDegenerate ? 'both halves' : (baseDegenerate ? 'the base half' : 'the PR half');
const repsNote = (m) => (m && Number.isFinite(m.validReps)) ? `${m.validReps}/${m.requestedReps || m.validReps} valid windows` : 'single window';

const lines = [
    `### Client render-perf — base vs PR ${icon}`,
    '',
    canGate
        ? `Gate: median scripting ms/frame must not regress **> ${REGRESS_PCT}%** vs \`main\`. _(Headless software raster — absolute ms is not an iPad FPS; only the delta is meaningful. Calibrate absolute mobile perf on a real iPad — see docs/spikes/perf-and-input-ci.md.)_`
        : (inconclusive
            ? (schemaMismatch
                ? `_Inconclusive: the two halves were produced by different perf-harness versions (${newSchema(base) ? 'base=median' : 'base=single-window'} vs ${newSchema(pr) ? 'PR=median' : 'PR=single-window'}), so their numbers aren't comparable. During rollout this is the base half still on the old harness and resolves once this change is on \`main\`; otherwise check whether the PR changed \`perf-client.js\`. **Not** treated as a regression._`
                : `_Inconclusive: ${degenWho} could not collect ≥ ${MIN_VALID_REPS} clean windows (the CI runner was too CPU-contended to measure render perf this run). **Not** treated as a regression — re-run to retry. Base: ${repsNote(base)}; PR: ${repsNote(pr)}._`)
            : (haveBase
                ? `_Base metrics present but unusable (missing/zero scripting field) — the gate could not run; showing PR measurement only._`
                : `_No base metrics found (base branch predates this job) — showing PR measurement only._`)),
    '',
    `Scenario: **${pr.karts} karts**, fixed brutal \`[${(pr.brutalTypes || []).join(', ')}]\`. Median of ${repsNote(pr)} (base: ${repsNote(base)}).`,
    '',
    '| metric | base (`main`) | PR | Δ |',
    '| --- | --- | --- | --- |',
    row('**scripting ms/frame** (gated, median)', base && base.scriptMsPerFrame, pr.scriptMsPerFrame, scriptDelta, ''),
    row('frame-work p95 (ms, context)', base && base.frameWorkP95Ms, pr.frameWorkP95Ms, frameDelta, ''),
    row('JS heap (MB, context)', base && base.heapMB, pr.heapMB, heapDelta, ''),
    '',
    regressed
        ? `⚠️ **median scripting ms/frame regressed ${sign(scriptDelta)}${scriptDelta.toFixed(1)}%** (> ${REGRESS_PCT}% threshold). A change made the per-frame render/JS work heavier.`
        : (canGate ? `Within threshold.` : ''),
];

const body = lines.join('\n');
console.log(body);

if (process.env.GITHUB_STEP_SUMMARY) { try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, body + '\n'); } catch (e) {} }
if (COMMENT_OUT) { try { fs.writeFileSync(COMMENT_OUT, MARKER + '\n' + body + '\n'); } catch (e) {} }

if (regressed && !SOFT) { process.exit(1); }
process.exit(0);
