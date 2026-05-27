'use strict';

// Server tick-budget check (P1a) — zero new dependencies.
//
// The smoke test proves the engine still *runs*; this proves it still runs
// *fast enough*. It boots the real server-side game headlessly (no network, no
// browser), forces the worst-case server load — a full 25-kart grid in a
// stacked brutal round — and times how long a single room's `update(dt)` takes.
// If one room can't tick within the server's 30 Hz interval, it can't keep up.
//
// Determinism: seeded Math.random + a mock clock (so setTimeout-driven brutal
// effects fire as the tick loop advances) make per-tick timings reproducible.
// Same headless harness shape as smoke-test.js — see that file for the pattern.

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');

// --- Force the worst-case load by mutating the shared in-memory config object
// BEFORE the engine modules read it. (No config.json edit; in-process only.) ---
const config = require(path.join(repoRoot, 'server', 'config.json'));
config.aiRacers.minGrid = 25;
config.aiRacers.maxGrid = 25;
config.aiRacers.autoTarget = 25;       // drives the fill target (lobby-hub); -> 24 bots + 1 human = 25 karts
config.maxPlayersInRoom = 25;          // room cap must allow the full grid
config.chanceOfBrutalRound = 100;      // force a brutal round
config.chanceForAdditionalBrutal = 100;
config.maxTotalBrutals = 4;            // stack up to 4 brutal types

// --- Deterministic RNG (mulberry32) so tick costs are reproducible run-to-run.
let __seed = 0x9e3779b9;
Math.random = function () {
    __seed |= 0; __seed = (__seed + 0x6D2B79F5) | 0;
    let t = Math.imul(__seed ^ (__seed >>> 15), 1 | __seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// --- Mock clock: advance time per tick so brutal setTimeout effects (volcano
// eruptions, hockey puck, blackout) actually fire during the synchronous loop. ---
let __now = 1700000000000;
const __timers = [];
let __timerId = 1;
Date.now = () => __now;
global.setTimeout = function (fn, delay, ...args) {
    const id = __timerId++;
    __timers.push({ id, fireAt: __now + (delay || 0), fn, args });
    return id;
};
global.clearTimeout = function (id) {
    const i = __timers.findIndex(t => t.id === id);
    if (i !== -1) __timers.splice(i, 1);
};
function advanceClock(ms) {
    __now += ms;
    // Drain in fireAt order, re-checking after each callback so a timer SCHEDULED
    // by a fired callback (with fireAt already <= now) also runs this tick instead
    // of being deferred. Bounded to avoid an infinite reschedule loop.
    for (var guard = 0; guard < 10000; guard++) {
        var next = null;
        for (var i = 0; i < __timers.length; i++) {
            if (__timers[i].fireAt <= __now && (next === null || __timers[i].fireAt < next.fireAt)) next = __timers[i];
        }
        if (next === null) break;
        __timers.splice(__timers.indexOf(next), 1);
        try { next.fn(...next.args); } catch (e) { /* surfaced by the tick loop if it matters */ }
    }
}

const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const game = require(path.join(repoRoot, 'server', 'game.js'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));

const DT = config.serverTickSpeed / 1000;
const TICK_MS = config.serverTickSpeed;                 // 33.33 ms @ 30 Hz
const BUDGET_MS = Number(process.env.PERF_TICK_BUDGET_MS) || TICK_MS;
const WARMUP = 60;
const MEASURE = Number(process.env.PERF_TICK_SAMPLES) || 300;

const fakeIo = { to() { return { emit() {} }; }, sockets: { emit() {} } };
messenger.build(fakeIo);

function pct(arr, p) {
    if (!arr.length) return NaN;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
const f = (n) => (Number.isFinite(n) ? n.toFixed(3) : 'n/a');

function pickMap() {
    const dir = path.join(repoRoot, 'client', 'maps');
    const want = process.env.PERF_MAP || '4suns!.json';
    if (fs.existsSync(path.join(dir, want))) return want;
    return fs.readdirSync(dir).filter(x => x.endsWith('.json')).sort()[0];
}

function summary(lines) {
    if (process.env.GITHUB_STEP_SUMMARY) {
        try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n'); } catch (e) {}
    }
}

const mapFile = pickMap();
const map = mapFormat.hydrate(JSON.parse(fs.readFileSync(path.join(repoRoot, 'client', 'maps', mapFile), 'utf8')));
console.log(`Tick-budget scenario: 25-kart grid + forced brutal on "${mapFile}".`);

const room = game.getRoom('perf-tick', 30);
room.game.gameBoard.isPreview = true;     // pin this map
room.game.gameBoard.previewMap = map;
room.game.gameBoard.previewAI = true;     // allow bot fill in a preview room

// One human so fillGridWithBots() engages (it no-ops with zero humans).
const human = room.world.createNewPlayer('perf-human');
room.playerList['perf-human'] = human;
room.game.determineGameState(human);

let kartCount = 0, brutalTypes = [];
try {
    room.game.startLobby();   // world.resize() builds the engine quadtree
    room.game.startGated();   // lays out the map + fills the grid to 25 karts
    room.game.startRace();    // schedules brutal effects on the (mock) clock
    kartCount = Object.keys(room.playerList).length;
    brutalTypes = (room.game.gameBoard.brutalConfig && room.game.gameBoard.brutalConfig.brutalTypes) || [];
} catch (e) {
    console.log('::error::Failed to set up the 25-kart brutal race: ' + e.message + '\n' + e.stack);
    process.exit(1);
}

// Hard-fail (don't just warn) if the grid didn't fill: measuring a lighter load
// would let a bot-fill/seating regression PASS the budget precisely because it
// made the worst-case scenario cheaper — the opposite of what this gate guards.
if (kartCount < 25 || (brutalTypes && brutalTypes.length === 0)) {
    console.log(`::error::Scenario not established (karts=${kartCount}, brutalTypes=${(brutalTypes || []).length}). The 25-kart brutal worst-case was not actually exercised — refusing to report a meaningless budget pass.`);
    process.exit(1);
}

// Warm up (bots spread out, brutal effects spawn) — not measured.
for (let i = 0; i < WARMUP; i++) { room.update(DT); advanceClock(TICK_MS); }

const samples = [];
for (let i = 0; i < MEASURE; i++) {
    const t0 = process.hrtime.bigint();
    room.update(DT);
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1e6); // ns -> ms
    advanceClock(TICK_MS);
}

const p50 = pct(samples, 50), p95 = pct(samples, 95), p99 = pct(samples, 99), max = Math.max(...samples);
const headroom = (BUDGET_MS / p95);
const pass = p95 <= BUDGET_MS;

console.log(`\nKarts: ${kartCount}   brutal types: [${brutalTypes.join(', ')}]   samples: ${samples.length}`);
console.log(`Per-room update(dt) ms:  p50=${f(p50)}  p95=${f(p95)}  p99=${f(p99)}  max=${f(max)}`);
console.log(`Budget (one 30 Hz tick): ${f(BUDGET_MS)} ms   headroom@p95: ${f(headroom)}x   => ${pass ? 'PASS' : 'FAIL'}`);

summary([
    '### Server tick-budget (P1a)',
    '',
    `Worst-case load: **${kartCount} karts**, brutal types \`[${brutalTypes.join(', ')}]\`, map \`${mapFile}\`.`,
    '',
    '| metric | value |',
    '| --- | --- |',
    `| update(dt) p50 | ${f(p50)} ms |`,
    `| update(dt) p95 | ${f(p95)} ms |`,
    `| update(dt) p99 | ${f(p99)} ms |`,
    `| update(dt) max | ${f(max)} ms |`,
    `| budget (1 tick @30Hz) | ${f(BUDGET_MS)} ms |`,
    `| headroom @p95 | ${f(headroom)}× |`,
    `| result | ${pass ? '✅ PASS' : '❌ FAIL'} |`,
]);

if (!pass) {
    console.log(`\n::error::Server tick budget exceeded: p95 ${f(p95)} ms > ${f(BUDGET_MS)} ms. A single room can no longer tick within the 30 Hz interval under full load.`);
    process.exit(1);
}
console.log('\nServer tick-budget check passed.');
process.exit(0);
