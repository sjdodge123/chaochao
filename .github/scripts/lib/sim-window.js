'use strict';

// Shared sweep-methodology primitives for measuring a map's AI difficulty
// (perRoundFrac, the metric behind server/mapDifficulty.json and the
// difficulty-ramp tier cutoffs). Consumers: validate-submitted-map.js (one
// submitted map per PR) and measure-map-difficulty.js (catalog-wide
// regeneration). Both MUST measure identically or new maps get graded on a
// different ruler than the shipped data — that is the whole reason this file
// exists, so change methodology here and nowhere else.
//
// The methodology replicates the 2026-06-11 balance sweep (ai-fitness.js plus
// the spike extension documented in docs/spikes/gameplay-balance-analysis.md):
// all-bot room with the 6-racer aiRacers cast grid, mocked Date.now/setTimeout,
// seeded RNG (schedule 0xA11CE + s*7919), 30 warm-up ticks, explicit
// startRace(), notchesToWin pinned to 99 every tick (so a clinch can never end
// the match mid-window), continuous 120s windows where rounds chain naturally;
// perRoundFrac = finish events / (rounds observed x bots), partial last rounds
// included. ai-fitness.js predates this lib and keeps its own copy on purpose —
// it is the A/B protocol tool and its numbers must stay comparable to its own
// history; do not rewire it casually.

// Deterministic PRNG (same generator as ai-fitness.js).
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Mock clock over Date.now + global.setTimeout. A tight synchronous tick loop
// freezes wall-clock, so without this no setTimeout fires and nothing
// Date.now-based (cooldowns, fuses, round timers) ever advances. Matching the
// sweep, clearTimeout is deliberately NOT mocked and the pending queue persists
// across a run's windows — cancellations are no-ops here exactly as they were
// when the shipped data was measured.
function makeSimClock() {
    return {
        now: 1e6,
        pend: [],
        realDateNow: Date.now,
        realSetTimeout: global.setTimeout,
        install() {
            this.now = 1e6;
            this.pend = [];
            Date.now = () => this.now;
            global.setTimeout = (fn, d, ...a) => { this.pend.push({ at: this.now + (d || 0), fn, a }); return this.pend.length; };
        },
        restore() {
            Date.now = this.realDateNow;
            global.setTimeout = this.realSetTimeout;
            this.pend = [];
        },
        tick(ms) {
            this.now += ms;
            this.pend.sort((a, b) => a.at - b.at);
            while (this.pend.length && this.pend[0].at <= this.now) {
                const t = this.pend.shift();
                try { t.fn(...t.a); } catch (e) { /* timer callbacks are best-effort, as in ai-fitness */ }
            }
        }
    };
}

// One 120s all-bot window on a hydrated map. `clock` must already be installed.
// Returns { finishEvents, rounds, bots }.
function runWindow(game, config, map, sig, clock) {
    const DT = config.serverTickSpeed / 1000;
    const cast = (config.aiRacers && config.aiRacers.cast) || [];
    if (cast.length === 0) {
        // world.createNewBot dereferences the identity unconditionally; fail with
        // a nameable cause instead of a TypeError three frames deep (callers may
        // downgrade this to a warning, and the warning must say what broke).
        throw new Error('config.aiRacers.cast is empty — the difficulty sweep needs bot identities');
    }
    let room = null;
    try {
        room = game.getRoom(sig, config.maxPlayersInRoom || 8);
        room.game.gameBoard.isPreview = true;
        room.game.gameBoard.previewMap = map;
        const bots = [];
        for (let i = 0; i < 6; i++) {
            const bid = sig + '-bot' + i;
            const b = room.world.createNewBot(bid, cast[i % cast.length]);
            room.playerList[bid] = b;
            bots.push(b);
        }
        room.game.determineGameState(bots[0]);
        room.game.startLobby();
        room.game.startGated();
        for (let g = 0; g < 30; g++) { clock.tick(config.serverTickSpeed); room.update(DT); }
        room.game.startRace();
        const ticks = Math.ceil(120 / DT);
        const prevGoal = {};
        for (const b of bots) { prevGoal[b.id] = b.reachedGoal === true; }
        let finishEvents = 0;
        let rounds = room.game.currentState === config.stateMap.racing ? 1 : 0;
        let prevState = room.game.currentState;
        for (let f = 0; f < ticks; f++) {
            room.game.notchesToWin = 99; // don't end the match on a clinch; measure everyone
            clock.tick(config.serverTickSpeed);
            room.update(DT);
            for (const b of bots) {
                const g2 = b.reachedGoal === true;
                if (g2 && !prevGoal[b.id]) { finishEvents++; }
                prevGoal[b.id] = g2;
            }
            const st = room.game.currentState;
            if (st === config.stateMap.racing && prevState !== config.stateMap.racing) { rounds++; }
            prevState = st;
        }
        return { finishEvents, rounds, bots: bots.length };
    } finally {
        if (room) { try { for (const id in room.playerList) { delete room.playerList[id]; } } catch (e) { /* best effort */ } }
    }
}

// Full measurement: `windows` seeded windows on a hydrated map, aggregated the
// sweep's way. Owns the RNG/clock install + restore so a consumer cannot
// half-replicate the methodology. Returns { perRoundFrac, rounds, finishEvents,
// windows } or null when no round was ever observed (broken map).
function measurePerRoundFrac(game, config, map, windows) {
    const realRandom = Math.random;
    const clock = makeSimClock();
    const mapJson = JSON.stringify(map); // windows mutate cells; parse a fresh copy per window
    let events = 0, rounds = 0, bots = 6;
    clock.install();
    try {
        for (let s = 0; s < windows; s++) {
            Math.random = mulberry32(0xA11CE + s * 7919);
            const w = runWindow(game, config, JSON.parse(mapJson), 'mapdiff-' + s + '-' + map.id, clock);
            events += w.finishEvents;
            rounds += w.rounds;
            bots = w.bots;
        }
    } finally {
        Math.random = realRandom;
        clock.restore();
    }
    if (rounds === 0) { return null; }
    return { perRoundFrac: +(events / (rounds * bots)).toFixed(3), rounds, finishEvents: events, windows };
}

module.exports = { mulberry32, makeSimClock, measurePerRoundFrac };
