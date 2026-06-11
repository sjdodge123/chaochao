'use strict';

// Headless state-machine test for the Heatwave brutal round.
//
// Like bunker-test.js, this boots the REAL server modules (no network/browser),
// pins a Heatwave round via the brutalTypesForce seam, and asserts the rules the
// mode is built on:
//
//   setup       -> a tile delta ships in the newMap payload; every conversion is
//                  a legal transition (sand->lava, ice->water, grass->dirt,
//                  dirt->concrete ability id); no lava lands on a gate strip;
//                  a walkable path to the goal survives from every start edge.
//   firewalker  -> a clean finisher banks the medal count once (latched); a
//                  finisher who touched scorched ground does not.
//   second wave -> warn stashes a selection + telegraphs it; fire commits it,
//                  broadcasts tileChanges + heatwaveWaveFired, grows the scorch
//                  set, and the path guarantee still holds.
//   dud maps    -> a map below minConvertibleTiles never rolls heatwave.
//   reset       -> a following non-heatwave round clears the scorched set.
//
// Any failed assertion exits 1.

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const game = require(path.join(repoRoot, 'server', 'game.js'));
const utils = require(path.join(repoRoot, 'server', 'utils.js'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));
const c = utils.loadConfig();

const DT = c.serverTickSpeed / 1000;
let failures = 0;
function check(cond, msg) {
    if (!cond) { failures++; console.log('::error::Heatwave: ' + msg); }
    else { console.log('ok: ' + msg); }
}

// Recording messenger so we can assert on emitted events.
const emitted = [];
const fakeIo = {
    to() { return { emit(name, data) { emitted.push({ name: name, data: data }); } }; },
    sockets: { emit(name, data) { emitted.push({ name: name, data: data }); } }
};
messenger.build(fakeIo);
function emittedNames() { return emitted.map(e => e.name); }

// Controllable clock — a tight synchronous tick loop freezes wall-clock.
const realNow = Date.now;
let fakeNow = 1000000;
Date.now = () => fakeNow;

function tick(room) { fakeNow += Math.round(DT * 1000); room.update(DT); }

function countId(gb, id) {
    let n = 0;
    const cells = gb.currentMap.cells;
    for (let i = 0; i < cells.length; i++) { if (cells[i].id === id) { n++; } }
    return n;
}

function cellByVid(gb, vid) {
    const cells = gb.currentMap.cells;
    for (let i = 0; i < cells.length; i++) {
        if (String(cells[i].site.voronoiId) === String(vid)) { return cells[i]; }
    }
    return null;
}

const abilityIds = {};
for (const prop in c.tileMap.abilities) {
    if (c.tileMap.abilities[prop].id != null) { abilityIds[c.tileMap.abilities[prop].id] = true; }
}

// A committed map with a goal and enough convertible (sand/ice) tiles.
function pickHeatwaveMap() {
    const dir = path.join(repoRoot, 'client', 'maps');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_'));
    let best = null;
    for (const file of files) {
        let m = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        if (mapFormat.isSitesOnly(m)) { m = mapFormat.reconstruct(m); }
        if (m.lobbyOnly || !m.cells) { continue; }
        if (!m.cells.some(cell => cell.id === c.tileMap.goal.id)) { continue; }
        const convertible = m.cells.filter(cell =>
            cell.id === c.tileMap.slow.id || cell.id === c.tileMap.ice.id).length;
        if (best == null || convertible > best.convertible) {
            best = { name: file, map: m, convertible: convertible };
        }
    }
    return (best != null && best.convertible >= c.brutalRounds.heatwave.minConvertibleTiles) ? best : null;
}

function buildRoom(sig, nPlayers, map) {
    const room = game.getRoom(sig, 8);
    room.game.gameBoard.isPreview = true;
    room.game.gameBoard.previewMap = map;
    for (let i = 0; i < nPlayers; i++) {
        const id = sig + '-p' + i;
        const player = room.world.createNewPlayer(id);
        room.playerList[id] = player;
        room.game.determineGameState(player);
    }
    return room;
}

const picked = pickHeatwaveMap();
if (picked == null) {
    console.log('::error::Heatwave: no committed map with a goal and enough sand/ice found');
    process.exit(1);
}
console.log('Using map: ' + picked.name + ' (' + picked.convertible + ' convertible tiles)');

// Force every brutal roll to be a solo Heatwave round.
c.brutalTypesForce = [c.brutalRounds.heatwave.id];

// ---- Setup invariants ----
(function setupInvariants() {
    const room = buildRoom('hw-setup', 3, picked.map);
    const gb = room.game.gameBoard;
    room.game.startLobby();
    emitted.length = 0;
    room.game.startGated(); // setupMap -> applyBrutalHeatwaveRound

    const hw = gb.newMapPayload.heatwave;
    check(hw != null && hw.changes != null, 'newMap payload carries the heatwave delta');
    const vids = Object.keys(hw.changes);
    check(vids.length > 0, 'heatwave converted at least one tile (' + vids.length + ')');
    check(vids.length <= gb.currentMap.cells.length * 0.3, 'conversion volume is sane (<=30% of cells)');

    let legal = true, abilityConcrete = true, anyAbility = false;
    for (const vid of vids) {
        const newId = hw.changes[vid];
        const isLegal = newId === c.tileMap.lava.id || newId === c.tileMap.water.id ||
            newId === c.tileMap.normal.id || abilityIds[newId] === true;
        if (!isLegal) { legal = false; }
        if (newId === c.tileMap.ability.id) { abilityConcrete = false; } // generic pad must never ship
        if (abilityIds[newId] === true) { anyAbility = true; }
        const cell = cellByVid(gb, vid);
        if (cell == null || cell.id !== newId) { legal = false; }
    }
    check(legal, 'every conversion is a legal transition applied to the live map');
    check(abilityConcrete, 'ability conversions carry concrete ability ids (never the generic pad)');
    if (anyAbility) { console.log('  (delta includes ability conversions)'); }

    // No fresh lava on a gate strip (spawns do not avoid hazards).
    const margin = 75 + (c.brutalRounds.heatwave.gateMargin || 0);
    const edges = gb.resolveStartEdges();
    let gateClean = true;
    for (const vid of vids) {
        if (hw.changes[vid] !== c.tileMap.lava.id) { continue; }
        const cell = cellByVid(gb, vid);
        for (const edge of edges) {
            if (edge === 'left' && cell.site.x < margin) { gateClean = false; }
            if (edge === 'right' && cell.site.x > room.world.width - margin) { gateClean = false; }
            if (edge === 'top' && cell.site.y < margin) { gateClean = false; }
            if (edge === 'bottom' && cell.site.y > room.world.height - margin) { gateClean = false; }
        }
    }
    check(gateClean, 'no sand->lava conversion landed on a gate strip');

    check(gb.heatwavePathOk(), 'a walkable path to the goal survives from every start edge');

    // Scorched set mirrors the delta and is shared by reference with players.
    let scorchOk = gb.heatwaveScorchedIds != null;
    for (const vid of vids) { if (!gb.heatwaveScorchedIds[vid]) { scorchOk = false; } }
    check(scorchOk, 'scorched set covers every converted tile');
    const pid = Object.keys(room.playerList)[0];
    check(room.playerList[pid].heatwaveScorchedIds === gb.heatwaveScorchedIds,
        'players share the scorched set by reference');
})();

// ---- Late-join snapshot: gated joiners must not get the delta early ----
// (Codex P2: the tileChanges snapshot flipped the converted tiles instantly on a
// gated reconnect, skipping the reveal. The gated snapshot now excludes the
// heatwave delta — it arrives via the armed reveal — while racing keeps it.)
(function gatedJoinSnapshot() {
    const room = buildRoom('hw-join', 3, picked.map);
    const gb = room.game.gameBoard;
    room.game.startLobby();
    room.game.startGated();
    const hwVids = Object.keys(gb.newMapPayload.heatwave.changes);

    function snapshotFor(state) {
        const sent = [];
        const fakeClient = { emit(name, data) { sent.push({ name: name, data: data }); } };
        room.game.checkSendGameStateUpdates(fakeClient);
        const msg = sent.find(m => m.name === 'tileChanges');
        return (msg != null) ? JSON.parse(msg.data) : null;
    }

    const gatedSnap = snapshotFor('gated');
    check(gatedSnap != null, 'gated joiner receives a tileChanges snapshot');
    let leaked = false;
    for (const vid of hwVids) { if (gatedSnap[vid] != null) { leaked = true; } }
    check(!leaked, 'gated snapshot excludes the heatwave delta (reveal owns it)');

    room.game.startRace();
    const racingSnap = snapshotFor('racing');
    let present = true;
    for (const vid of hwVids) { if (racingSnap[vid] == null) { present = false; } }
    check(present, 'racing snapshot still carries the full heatwave delta');
})();

// ---- Firewalker medal bookkeeping ----
(function firewalker() {
    const room = buildRoom('hw-medal', 3, picked.map);
    const gb = room.game.gameBoard;
    room.game.startLobby();
    room.game.startGated();
    room.game.startRace();

    const ids = Object.keys(room.playerList);
    const clean = room.playerList[ids[0]];
    const dirty = room.playerList[ids[1]];

    // Dirty racer touches a scorched tile (simulated footing report).
    const scorchVid = Object.keys(gb.heatwaveScorchedIds)[0];
    dirty.currentState = c.stateMap.racing;
    dirty.handleMapCellHit({
        id: c.tileMap.normal.id, voronoiId: scorchVid,
        acel: c.tileMap.normal.acel, dragCoeff: c.tileMap.normal.dragCoeff, brakeCoeff: c.tileMap.normal.brakeCoeff
    });
    check(dirty.touchedScorchedTile === true, 'footing on a scorched tile voids the clean run');
    check(clean.touchedScorchedTile === false, 'other racers stay clean');

    clean.reachedGoal = true;
    dirty.reachedGoal = true;
    tick(room);
    check(clean.firewalkerCount === 1, 'clean finisher banks a Firewalker count');
    check(dirty.firewalkerCount === 0, 'scorch-touching finisher banks nothing');
    tick(room);
    tick(room);
    check(clean.firewalkerCount === 1, 'the award is latched once per round (no per-tick inflation)');
})();

// ---- Second wave: warn -> fire ----
(function secondWave() {
    // Bump the wave percentages so the selection is never empty on small maps.
    const sw = c.brutalRounds.heatwave.secondWave;
    const saved = { s: sw.sandToLavaPct, i: sw.iceToWaterPct, g: sw.grassToDirtPct, d: sw.dirtToAbilityPct };
    sw.sandToLavaPct = 50; sw.iceToWaterPct = 50; sw.grassToDirtPct = 50; sw.dirtToAbilityPct = 50;

    const room = buildRoom('hw-wave', 3, picked.map);
    const gb = room.game.gameBoard;
    room.game.startLobby();
    room.game.startGated();
    room.game.startRace();

    const scorchBefore = Object.keys(gb.heatwaveScorchedIds).length;
    const packet = { context: room.game, map: gb.currentMap };

    // Capture the fire timer the warn handler schedules, then invoke it directly
    // (real setTimeout never fires inside a synchronous mocked-clock test).
    const realSetTimeout = global.setTimeout;
    let fired = null;
    global.setTimeout = function (fn, delay, arg) { fired = { fn: fn, arg: arg }; return 0; };
    emitted.length = 0;
    gb.warnOfHeatwaveWave(packet);
    global.setTimeout = realSetTimeout;

    check(gb.pendingHeatwaveWave != null, 'warn stashed a second-wave selection');
    check(emittedNames().indexOf('heatwavePending') !== -1, 'warn telegraphed heatwavePending');
    check(fired != null, 'warn scheduled the fire timer');

    emitted.length = 0;
    gb.fireHeatwaveWave(packet);
    const names = emittedNames();
    check(names.indexOf('tileChanges') !== -1, 'fire broadcast tileChanges');
    check(names.indexOf('heatwaveWaveFired') !== -1, 'fire broadcast heatwaveWaveFired');
    const scorchAfter = Object.keys(gb.heatwaveScorchedIds).length;
    check(scorchAfter > scorchBefore, 'second wave grew the scorched set (' + scorchBefore + ' -> ' + scorchAfter + ')');
    check(gb.heatwavePathOk(), 'path guarantee still holds after the second wave');
    check(gb.pendingHeatwaveWave == null, 'pending selection consumed');

    // Late joiners read scorch from the stored payload — it must cover both waves.
    const payloadVids = Object.keys(gb.newMapPayload.heatwave.changes).length;
    check(payloadVids === scorchAfter, 'stored newMap payload folded in the second wave for late joiners');

    sw.sandToLavaPct = saved.s; sw.iceToWaterPct = saved.i; sw.grassToDirtPct = saved.g; sw.dirtToAbilityPct = saved.d;
})();

// ---- Dud maps never roll heatwave ----
(function dudMapSkip() {
    c.brutalTypesForce = null; // the force seam bypasses the dud filter — use real rolls
    const savedMin = c.brutalRounds.heatwave.minConvertibleTiles;
    c.brutalRounds.heatwave.minConvertibleTiles = 1000000; // every map is now a dud
    const room = buildRoom('hw-dud', 2, picked.map);
    const gb = room.game.gameBoard;
    room.game.startLobby();
    room.game.startGated();
    gb.chanceOfBrutalRound = 100; // every roll goes brutal
    let sawHeatwave = false;
    for (let i = 0; i < 40; i++) {
        const cfg = gb.checkForBrutalRound();
        if (cfg.brutalTypes.indexOf(c.brutalRounds.heatwave.id) !== -1) { sawHeatwave = true; }
    }
    check(!sawHeatwave, 'heatwave never rolls on a map below minConvertibleTiles');
    c.brutalRounds.heatwave.minConvertibleTiles = savedMin;
})();

// ---- A following non-heatwave round clears the state ----
(function resetBetweenRounds() {
    c.brutalTypesForce = [c.brutalRounds.heatwave.id];
    const room = buildRoom('hw-reset', 2, picked.map);
    const gb = room.game.gameBoard;
    room.game.startLobby();
    room.game.startGated();
    check(gb.heatwaveScorchedIds != null, 'heatwave round armed the scorched set');
    c.brutalTypesForce = null;
    gb.chanceOfBrutalRound = 0; // next round: never brutal
    room.game.startGated();     // next round's setup
    check(gb.heatwaveScorchedIds == null, 'next non-heatwave round cleared the scorched set');
    const pid = Object.keys(room.playerList)[0];
    check(room.playerList[pid].heatwaveScorchedIds == null, 'player references cleared with it');
})();

Date.now = realNow;
if (failures > 0) { console.log('\nHeatwave test FAILED with ' + failures + ' error(s).'); process.exit(1); }
console.log('\nHeatwave test passed.');
process.exit(0);
