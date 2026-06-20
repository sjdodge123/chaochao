'use strict';

// Headless repro for the "checkpoint flags drag the round out" fix.
//
// A "checkpoint" is the Second Wind totem (boon id 954): once a racer drives over
// it, `player.secondWind` points at that totem and EVERY death respawns them at
// it — until the collapsing lava burns the totem (`totem.safe` flips false). So a
// racer parked on a safe checkpoint never concludes the round on their own.
//
// The only mid-race "hurry-up" (par) collapse trigger is the last-stand check in
// game.js `checkForWinners()`: FFA fires it at one alive rival left. Before the
// fix, several players camped on checkpoints kept the alive count high, last-stand
// never fired, no collapse was ever scheduled, so the totems never burned and the
// round dragged forever.
//
// The fix discounts safe-totem campers from the last-stand trigger (counting them
// like a dead rival) WITHOUT marking them concluded for the overview/round-end, so
// an attuned player still keeps their shot at finishing.
//
// The discount applies only once a racer has ACTUALLY respawned at a flag — merely
// touching one in passing while still pushing for the goal keeps them a real rival.
//
// This drives the REAL engine + REAL checkForWinners() (no network, no browser),
// deterministically (no physics ticks — round-end is a pure function of player
// flags), across four cases:
//
//   1. CONTROL — 4 alive racers, NO checkpoints        -> NO premature collapse.
//   2. TOUCHED — 4 alive racers on safe flags, NEVER respawned -> NO collapse
//                (they grabbed a flag but are still racing; they're real rivals).
//   3. REPRO   — 4 alive racers who HAVE respawned on safe flags -> last-stand
//                fires; the scheduled collapse then runs. (Pre-fix: nothing fired.)
//   4. GATE    — 4 respawned racers on BURNED flags     -> counted as real rivals
//                again, so NO collapse (matches killPlayer's own safe gate).
//
// Run: node .github/scripts/checkpoint-collapse-repro.js   (not wired into CI)

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const game = require(path.join(repoRoot, 'server', 'game.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));

const RACING = config.stateMap.racing;
const COLLAPSING = config.stateMap.collapsing;
const OVERVIEW = config.stateMap.overview;

let failures = 0;
function check(cond, msg) {
    if (cond) {
        console.log('  ✓ ' + msg);
    } else {
        failures++;
        console.log('  ✗ FAIL: ' + msg);
    }
}

const fakeIo = { to() { return { emit() { } }; }, sockets: { emit() { } } };
messenger.build(fakeIo);

// A real committed map (has goal tiles + valid geometry); pinned via the editor
// preview path exactly like a solo play-test.
let pinnedMap = JSON.parse(fs.readFileSync(path.join(repoRoot, 'client', 'maps', 'Duality.json'), 'utf8'));
if (mapFormat.isSitesOnly(pinnedMap)) { pinnedMap = mapFormat.reconstruct(pinnedMap); }

// Build a room in the racing state on the pinned map with exactly `count`
// player-controlled racers, each set up by `setup(player)`.
function makeRacingRoom(sig, count, setup) {
    const room = game.getRoom(sig, 8);
    room.game.gameBoard.isPreview = true;
    room.game.gameBoard.previewMap = pinnedMap;

    // Reach the racing state the normal way so the pinned map is the active map
    // (startGated/startRace load it; this is also where the AI grid is filled).
    room.game.startLobby();
    room.game.startGated();
    room.game.startRace();

    // Replace the playerList with exactly our controlled racers so bots/spawns
    // don't perturb the counts. checkForWinners is a pure function of these flags.
    for (const id in room.playerList) { delete room.playerList[id]; }
    for (let i = 0; i < count; i++) {
        const id = sig + '-p' + i;
        const p = room.world.createNewPlayer(id);
        // A normal alive, awake, racing competitor.
        p.alive = true;
        p.awake = true;
        p.reachedGoal = false;
        p.isZombie = false;
        p.isSpectator = false;
        p.secondWind = null;
        p.secondWindRespawned = false;
        p.murderedBy = null;
        p.teamId = null;
        setup(p);
        room.playerList[id] = p;
    }

    // Recompute playerCount from the rebuilt list and reset the round latches so
    // checkForWinners evaluates this state fresh.
    room.game.getPlayerCount();
    room.game.firstPlaceSig = null;
    room.game.secondPlaceSig = null;
    room.game.collapseInitated = false;
    room.game.currentState = RACING;

    // Make the legacy "random goal" collapse target deterministic (independent of
    // which tiles this particular map happens to expose).
    room.game.gameBoard.findRandomGoalTile = function () {
        return { x: config.worldWidth / 2, y: config.worldHeight / 2 };
    };
    return room;
}

// Run checkForWinners once with setTimeout captured (the multi-rival FFA last
// stand schedules its collapse on a 15s timer), and return what fired.
function runRoundEnd(room) {
    const realSetTimeout = global.setTimeout;
    const timers = [];
    global.setTimeout = function (fn, delay) {
        const args = Array.prototype.slice.call(arguments, 2);
        timers.push({ fn: fn, delay: delay, args: args });
        return 0;
    };
    try {
        room.game.checkForWinners();
    } finally {
        global.setTimeout = realSetTimeout;
    }
    return timers;
}

// ---------------------------------------------------------------------------
console.log('\n[1] CONTROL — 4 alive racers, no checkpoints (normal racing):');
{
    const room = makeRacingRoom('repro-control', 4, function () { /* no totem */ });
    const timers = runRoundEnd(room);
    check(room.game.alivePlayerCount === 4, 'all 4 counted alive (alivePlayerCount=' + room.game.alivePlayerCount + ')');
    check(room.game.collapseInitated === false, 'no last-stand collapse scheduled (a 4-way race keeps racing)');
    check(timers.length === 0, 'no hurry-up timer armed');
    check(room.game.currentState === RACING, 'still racing');
}

// ---------------------------------------------------------------------------
console.log('\n[2] TOUCHED-ONLY — 4 alive racers attuned to safe flags, NEVER respawned:');
{
    const room = makeRacingRoom('repro-touched', 4, function (p) {
        p.secondWind = { safe: true, x: 200, y: 200 }; // grabbed a flag in passing...
        p.secondWindRespawned = false;                 // ...but never died on it
    });
    const timers = runRoundEnd(room);
    check(room.game.collapseInitated === false, 'touch-only racers stay real rivals -> NO premature collapse (still pushing for the goal)');
    check(timers.length === 0, 'no hurry-up timer armed');
    check(room.game.currentState === RACING, 'still racing');
}

// ---------------------------------------------------------------------------
console.log('\n[3] REPRO — 4 alive racers who HAVE respawned on SAFE checkpoint flags:');
{
    const room = makeRacingRoom('repro-campers', 4, function (p) {
        p.secondWind = { safe: true, x: 200, y: 200 }; // attuned to a still-safe totem
        p.secondWindRespawned = true;                  // and have already leaned on a respawn
    });
    // Pre-fix, lastStand was `alivePlayerCount == 1` -> 4 != 1 -> nothing fired
    // and the round dragged. Post-fix, the respawn-leaning racers are discounted.
    const timers = runRoundEnd(room);
    check(room.game.alivePlayerCount === 4, 'campers are NOT concluded — still alive for the round-end/overview (alivePlayerCount=' + room.game.alivePlayerCount + ')');
    check(room.game.currentState !== OVERVIEW, 'round did NOT short-circuit to overview (they keep their shot at finishing)');
    check(room.game.collapseInitated === true, 'last-stand collapse WAS scheduled (respawn-campers discounted -> 0 real rivals)');
    check(timers.length === 1 && timers[0].delay === 15000, 'the 15s hurry-up collapse timer was armed');

    // Fire the scheduled timer: the collapse must actually engage so the lava can
    // burn the totems and resolve the round.
    if (timers.length === 1) {
        timers[0].fn.apply(null, timers[0].args);
        check(room.game.currentState === COLLAPSING, 'firing the timer drives startCollapse -> board is now collapsing');
    }
}

// ---------------------------------------------------------------------------
console.log('\n[4] GATE — 4 respawned racers on BURNED flags (totem.safe === false):');
{
    const room = makeRacingRoom('repro-burned', 4, function (p) {
        p.secondWind = { safe: false, x: 200, y: 200 }; // totem already consumed by lava
        p.secondWindRespawned = true;
    });
    const timers = runRoundEnd(room);
    check(room.game.collapseInitated === false, 'burned-totem racers count as real rivals again -> NO premature collapse');
    check(timers.length === 0, 'no hurry-up timer armed (matches killPlayer\'s own safe !== false gate)');
}

console.log('');
if (failures > 0) {
    console.log('Repro FAILED with ' + failures + ' failed assertion(s).');
    process.exit(1);
}
console.log('Repro passed: checkpoint campers now trip the last-stand collapse without being prematurely concluded.');
process.exit(0);
