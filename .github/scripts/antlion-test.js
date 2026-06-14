'use strict';

// Headless test for the Antlions brutal round (brutalRounds.antlion, id 1014).
//
// Boots the REAL server modules with no network/browser (smoke-test.js
// techniques): a fake socket.io `io` whose emit RECORDS events so the test can
// assert on the wire traffic (applyHazards / removeHazards / punch), a pinned
// sand-heavy map via the editor preview path, `brutalTypesForce` to make every
// round an antlion round, and — important — Date.now + setTimeout mocked into
// a clock the tick loop advances, because a tight synchronous loop freezes
// wall-clock and otherwise no hit cooldown, thumper slam, or punch-termination
// timer would ever fire.
//
// Asserts:
//   1. selection gate  — a map with too few sand tiles never rolls the mode,
//                        and antlion+heatwave never stack (mutual exclusion)
//   2. dwell spawn     — no antlion before 2s of continuous sand dwell; one
//                        erupts (60..120u away, never under the kart) after;
//                        camping keeps spawning more (timer resets)
//   3. chase           — the antlion closes distance to its target
//   4. shove           — contact fires a mapOwned punch of type "antlion"
//   5. sand leash      — ~3s continuously off sand => burrow (removeHazards)
//   6. thumper slam    — a slam knocks an antlion inside repelRadius outward
//   7. cap             — camping sand never exceeds the global antlion cap
//
// Any throw or failed assertion exits 1.

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const game = require(path.join(repoRoot, 'server', 'game.js'));
const utils = require(path.join(repoRoot, 'server', 'utils.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));

const _engine = require(path.join(repoRoot, 'server', 'engine.js'));
const { Antlion, VortexWell } = require(path.join(repoRoot, 'server', 'entities', 'hazards.js'));

const DT = config.serverTickSpeed / 1000;
const AL = config.brutalRounds.antlion;
const ANTLION_HAZARD_ID = config.hazards.antlion.id;
const SAND_ID = config.tileMap.slow.id;
const WATER_ID = (config.tileMap.water != null) ? config.tileMap.water.id : -1;

let failures = 0;
function fail(msg) {
    failures++;
    console.log('::error::' + msg);
}
function assert(cond, msg) {
    if (!cond) { fail(msg); }
}

// --- mocked clock -----------------------------------------------------------
// Date.now returns fakeNow; setTimeout queues onto a task list drained whenever
// the clock advances. tick() advances the clock by one server tick and runs the
// room update, so every wall-clock cooldown in game/gameBoard/hazards moves in
// lockstep with the simulated frames.
const realNow = Date.now;
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
let fakeNow = realNow();
let timerSeq = 1;
let timers = [];
Date.now = () => fakeNow;
global.setTimeout = function (fn, delay, ...args) {
    const id = timerSeq++;
    timers.push({ id, at: fakeNow + (delay || 0), fn, args });
    return id;
};
global.clearTimeout = function (id) {
    timers = timers.filter(t => t.id !== id);
};
function drainTimers() {
    let fired = true;
    while (fired) {
        fired = false;
        for (let i = 0; i < timers.length; i++) {
            if (timers[i].at <= fakeNow) {
                const t = timers.splice(i, 1)[0];
                t.fn(...t.args);
                fired = true;
                break;
            }
        }
    }
}
function restoreClock() {
    Date.now = realNow;
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
}

// --- recording io ------------------------------------------------------------
const events = []; // { event, payload }
const fakeIo = {
    to() { return { emit(event, payload) { events.push({ event, payload }); } }; },
    sockets: { emit(event, payload) { events.push({ event, payload }); } }
};
function eventsSince(mark, name) {
    const out = [];
    for (let i = mark; i < events.length; i++) {
        if (events[i].event === name) { out.push(events[i].payload); }
    }
    return out;
}

// --- map + room helpers -------------------------------------------------------
function loadMap(file) {
    let map = JSON.parse(fs.readFileSync(path.join(repoRoot, 'client', 'maps', file), 'utf8'));
    if (mapFormat.isSitesOnly(map)) { map = mapFormat.reconstruct(map); }
    return map;
}
function dist(ax, ay, bx, by) {
    return Math.sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by));
}
function cellsOfId(map, id) {
    return map.cells.filter(c => c.id === id);
}
// A sand site that's comfortably inside the world and far from lava, so a kart
// parked there isn't burned or rim-bounced mid-assertion.
function pickParkingSandSite(map) {
    const lava = cellsOfId(map, config.tileMap.lava.id).map(c => c.site);
    const sand = cellsOfId(map, SAND_ID).map(c => c.site);
    let best = null, bestScore = -1;
    for (const s of sand) {
        if (s.x < 150 || s.x > config.worldWidth - 150 || s.y < 100 || s.y > config.worldHeight - 100) { continue; }
        let minLava = Infinity;
        for (const l of lava) { minLava = Math.min(minLava, dist(s.x, s.y, l.x, l.y)); }
        if (minLava > bestScore) { bestScore = minLava; best = s; }
    }
    return best;
}
// A non-sand walkable site as far from every sand cell as possible (burrow test).
function pickOffSandSite(map) {
    const sand = cellsOfId(map, SAND_ID).map(c => c.site);
    const walkable = map.cells.filter(c =>
        c.id === config.tileMap.normal.id || c.id === config.tileMap.fast.id).map(c => c.site);
    let best = null, bestScore = -1;
    for (const s of walkable) {
        if (s.x < 150 || s.x > config.worldWidth - 150 || s.y < 100 || s.y > config.worldHeight - 100) { continue; }
        let minSand = Infinity;
        for (const d of sand) { minSand = Math.min(minSand, dist(s.x, s.y, d.x, d.y)); }
        if (minSand > bestScore) { bestScore = minSand; best = s; }
    }
    return best;
}

let roomSeq = 0;
function buildRoom(map) {
    const sig = 'antlion-test-' + (roomSeq++);
    const room = game.getRoom(sig, 4);
    room.game.gameBoard.isPreview = true;
    room.game.gameBoard.previewMap = map;
    room.game.botOverride = { enabled: false }; // deterministic: no AI racers
    // Two parked players: alivePlayerCount stays 2, so the lone-survivor
    // collapse timers never arm under the mocked clock.
    for (let i = 0; i < 2; i++) {
        const id = sig + '-p' + i;
        const player = room.world.createNewPlayer(id);
        room.playerList[id] = player;
        room.game.determineGameState(player);
    }
    room.game.startLobby();
    room.game.startGated();
    room.game.startRace();
    return room;
}
function pinPlayer(player, x, y) {
    player.x = x; player.y = y;
    player.newX = x; player.newY = y;
    player.velX = 0; player.velY = 0;
}
function tick(room, holds) {
    fakeNow += config.serverTickSpeed;
    drainTimers();
    room.update(DT);
    if (holds) {
        for (const h of holds) { pinPlayer(h.player, h.x, h.y); }
    }
}
function antlionsOf(room) {
    const out = [];
    for (const id in room.hazardList) {
        if (room.hazardList[id].isAntlion) { out.push(room.hazardList[id]); }
    }
    return out;
}
function thumpersOf(room) {
    const out = [];
    for (const id in room.hazardList) {
        if (room.hazardList[id].isThumper) { out.push(room.hazardList[id]); }
    }
    return out;
}

// -----------------------------------------------------------------------------
// 1. Selection gate + heatwave mutual exclusion (no brutalTypesForce here).
// -----------------------------------------------------------------------------
function sessionSelectionGate() {
    // A map with (almost) no sand: rebuild a committed map and overwrite every
    // sand cell with normal ground, so countSandTiles() < minSandTiles.
    const noSand = loadMap('SandsOfTime.json');
    for (const cell of noSand.cells) {
        if (cell.id === SAND_ID) { cell.id = config.tileMap.normal.id; }
    }
    const roomA = buildRoom(noSand);
    const gbA = roomA.game.gameBoard;
    gbA.chanceOfBrutalRound = 100;
    gbA.chanceForAdditionalBrutal = 100;
    for (let i = 0; i < 60; i++) {
        const cfg = gbA.checkForBrutalRound();
        if (cfg.brutalTypes.indexOf(AL.id) !== -1) {
            fail('selection gate: antlion rolled on a zero-sand map (iteration ' + i + ')');
            break;
        }
    }

    // Sand-rich map: antlion may roll, but never alongside heatwave.
    const sandy = loadMap('SandsOfTime.json');
    const roomB = buildRoom(sandy);
    const gbB = roomB.game.gameBoard;
    gbB.chanceOfBrutalRound = 100;
    gbB.chanceForAdditionalBrutal = 100;
    let sawAntlion = false;
    for (let i = 0; i < 300; i++) {
        const cfg = gbB.checkForBrutalRound();
        const hasA = cfg.brutalTypes.indexOf(AL.id) !== -1;
        const hasH = cfg.brutalTypes.indexOf(config.brutalRounds.heatwave.id) !== -1;
        if (hasA) { sawAntlion = true; }
        if (hasA && hasH) {
            fail('mutual exclusion: antlion and heatwave rolled together (iteration ' + i + ')');
            break;
        }
    }
    assert(sawAntlion, 'selection: antlion never rolled in 300 max-chance tries on a sand-rich map');
    if (failures === 0) {
        console.log('Session 1 passed: sand gate + heatwave exclusion hold.');
    }
}

// -----------------------------------------------------------------------------
// 2-4. Dwell spawn -> chase -> shove, on a forced antlion round.
// -----------------------------------------------------------------------------
function sessionSpawnChaseShove() {
    config.brutalTypesForce = [AL.id];
    const map = loadMap('SandsOfTime.json');
    const room = buildRoom(map);
    const gb = room.game.gameBoard;
    assert(gb.checkForActiveBrutal(AL.id), 'forced round: antlion brutal not active after startRace');
    assert(thumpersOf(room).length >= 1, 'round load: no thumpers were placed on a sand-rich map');

    const ids = Object.keys(room.playerList);
    const camper = room.playerList[ids[0]];
    const bystander = room.playerList[ids[1]];
    const site = pickParkingSandSite(gb.currentMap);
    assert(site != null, 'no parkable sand site found on SandsOfTime');
    if (failures > 0) { return; }
    // Bystander parks far away off sand so the camper is the nearest target.
    const farSite = pickOffSandSite(gb.currentMap);
    const holds = [
        { player: camper, x: site.x, y: site.y },
        { player: bystander, x: farSite.x, y: farSite.y }
    ];
    pinPlayer(camper, site.x, site.y);
    pinPlayer(bystander, farSite.x, farSite.y);

    // (2a) Before the dwell threshold: ~1.5s on sand must spawn nothing.
    const preTicks = Math.floor((AL.sandDwellSeconds * 1000 * 0.75) / config.serverTickSpeed);
    for (let f = 0; f < preTicks; f++) { tick(room, holds); }
    assert(antlionsOf(room).length === 0,
        'an antlion spawned before the ' + AL.sandDwellSeconds + 's dwell threshold');

    // (2b) Past the threshold: one erupts, 60..120u away (never under the kart),
    // and the spawn was broadcast on the dedicated antlionErupt event (NOT the
    // generic applyHazards snapshot path) with the antlion hazard id.
    const mark = events.length;
    const moreTicks = Math.floor((AL.sandDwellSeconds * 1000 * 0.5) / config.serverTickSpeed);
    for (let f = 0; f < moreTicks && antlionsOf(room).length === 0; f++) { tick(room, holds); }
    const spawned = antlionsOf(room);
    assert(spawned.length >= 1, 'no antlion spawned after ' + AL.sandDwellSeconds + 's of sand dwell');
    if (failures > 0) { return; }
    const first = spawned[0];
    const spawnDist = dist(first.x, first.y, camper.x, camper.y);
    assert(spawnDist >= AL.minSpawnDist - 1,
        'antlion erupted under the kart (' + Math.round(spawnDist) + 'u away, min ' + AL.minSpawnDist + ')');
    assert(spawnDist <= AL.maxSpawnDist * 2 + 1,
        'antlion erupted implausibly far (' + Math.round(spawnDist) + 'u away)');
    const spawnsOnWire = eventsSince(mark, 'antlionErupt').filter(p => {
        const arr = JSON.parse(p);
        return arr.some(h => h[1] === ANTLION_HAZARD_ID);
    });
    assert(spawnsOnWire.length >= 1, 'antlion spawn was not broadcast via antlionErupt');
    // And the SNAPSHOT path must NOT carry a live eruption (no double-fire / no
    // late-joiner re-erupt): applyHazards events since the mark carry no antlion.
    const antlionsOnSnapshot = eventsSince(mark, 'applyHazards').filter(p => {
        const arr = JSON.parse(p);
        return arr.some(h => h[1] === ANTLION_HAZARD_ID);
    });
    assert(antlionsOnSnapshot.length === 0, 'a live antlion spawn leaked onto the applyHazards snapshot path');

    // (3) Chase: over the next second it must close on the camper.
    const d0 = dist(first.x, first.y, camper.x, camper.y);
    for (let f = 0; f < Math.floor(1000 / config.serverTickSpeed); f++) { tick(room, holds); }
    const d1 = dist(first.x, first.y, camper.x, camper.y);
    assert(d1 < d0 - 10 || d1 < config.hazards.antlion.attackRadius + camper.radius + 5,
        'antlion did not close distance (' + Math.round(d0) + ' -> ' + Math.round(d1) + ')');

    // (4) Shove: keep ticking until its punch lands on the wire.
    const punchMark = events.length;
    for (let f = 0; f < Math.floor(4000 / config.serverTickSpeed); f++) {
        tick(room, holds);
        const punches = eventsSince(punchMark, 'punch').map(p => JSON.parse(p));
        if (punches.some(p => p[5] === 'antlion')) { break; }
    }
    const punches = eventsSince(punchMark, 'punch').map(p => JSON.parse(p));
    assert(punches.some(p => p[5] === 'antlion'),
        'antlion contact never fired an "antlion"-type punch within 4s of chasing a pinned kart');

    // (2c) Camping keeps spawning: hold the camper on sand for two more full
    // dwell windows — the population must grow past one (the timer reset on the
    // first spawn and keeps feeding).
    for (let f = 0; f < Math.floor((AL.sandDwellSeconds * 1000 * 2 + 500) / config.serverTickSpeed); f++) {
        tick(room, holds);
    }
    assert(antlionsOf(room).length >= 2,
        'camping sand did not keep spawning antlions (dwell timer failed to reset)');

    config.brutalTypesForce = null;
    if (failures === 0) {
        console.log('Session 2 passed: dwell spawn (timing + placement + wire), chase, shove, re-spawn.');
    }
}

// -----------------------------------------------------------------------------
// 5. Sand leash: ~3s continuously off sand => burrow + removeHazards broadcast.
// -----------------------------------------------------------------------------
function sessionBurrow() {
    config.brutalTypesForce = [AL.id];
    const map = loadMap('SandsOfTime.json');
    const room = buildRoom(map);
    const gb = room.game.gameBoard;
    const ids = Object.keys(room.playerList);
    const off = pickOffSandSite(gb.currentMap);
    const holds = ids.map(id => ({ player: room.playerList[id], x: off.x, y: off.y }));
    for (const h of holds) { pinPlayer(h.player, off.x, off.y); }

    // Drop an antlion directly onto the off-sand spot (deterministic: no
    // route-dependent sand contact resets the leash).
    const ant = gb.spawnAntlion(room.playerList[ids[0]]);
    assert(ant != null, 'burrow: spawnAntlion returned null on a sand-rich map');
    if (failures > 0) { return; }
    ant.x = off.x + 40; ant.y = off.y; ant.newX = ant.x; ant.newY = ant.y;

    const mark = events.length;
    const ticksNeeded = Math.floor((AL.offSandDespawnSeconds * 1000 + 600) / config.serverTickSpeed);
    let gone = false;
    for (let f = 0; f < ticksNeeded; f++) {
        tick(room, holds);
        if (room.hazardList[ant.ownerId] == null) { gone = true; break; }
    }
    assert(gone, 'antlion did not burrow after ' + AL.offSandDespawnSeconds + 's off sand');
    const removes = eventsSince(mark, 'removeHazards').map(p => JSON.parse(p));
    assert(removes.some(batch => batch.some(e => e[0] === ant.ownerId && e[3] === 'burrow')),
        'burrow was not broadcast via removeHazards with reason "burrow"');

    config.brutalTypesForce = null;
    if (failures === 0) {
        console.log('Session 3 passed: off-sand leash burrows + removeHazards broadcast.');
    }
}

// -----------------------------------------------------------------------------
// 6. Thumper slam repels an antlion inside the radius.
// -----------------------------------------------------------------------------
function sessionThumperSlam() {
    config.brutalTypesForce = [AL.id];
    const map = loadMap('SandsOfTime.json');
    const room = buildRoom(map);
    const gb = room.game.gameBoard;
    const thumpers = thumpersOf(room);
    assert(thumpers.length >= 1, 'slam: no thumpers placed');
    if (failures > 0) { return; }
    const th = thumpers[0];

    // Park both players on real walkable ground (an arbitrary offset can land
    // on lava — dead players empty the target list and the swarm digs out,
    // freezing the antlion mid-assertion), far from the thumper so seek is weak
    // compared to the slam.
    const ids = Object.keys(room.playerList);
    const far = pickOffSandSite(gb.currentMap);
    assert(far != null, 'slam: no walkable off-sand parking site found');
    if (failures > 0) { return; }
    const holds = ids.map(id => ({ player: room.playerList[id], x: far.x, y: far.y }));
    for (const h of holds) { pinPlayer(h.player, far.x, far.y); }

    const ant = gb.spawnAntlion(room.playerList[ids[0]]);
    assert(ant != null, 'slam: spawnAntlion returned null');
    if (failures > 0) { return; }
    // Inside the repel radius, on the far side from the players.
    ant.x = th.x - 40; ant.y = th.y; ant.newX = ant.x; ant.newY = ant.y;
    ant.offSandMs = 0;

    th.nextSlamTime = fakeNow; // slam due on the next tick
    const before = dist(ant.x, ant.y, th.x, th.y);
    tick(room, holds);
    const impulse = Math.sqrt(ant.impVX * ant.impVX + ant.impVY * ant.impVY);
    assert(impulse > AL.slamImpulse * 0.5,
        'slam applied no meaningful impulse (|imp| = ' + Math.round(impulse) + ')');
    for (let f = 0; f < Math.floor(900 / config.serverTickSpeed); f++) { tick(room, holds); }
    const after = dist(ant.x, ant.y, th.x, th.y);
    assert(after > before + 40 && after > AL.repelRadius * 0.8,
        'slam did not repel the antlion out of the radius (' + Math.round(before) + ' -> ' + Math.round(after) + 'u from thumper, radius ' + AL.repelRadius + ')');

    config.brutalTypesForce = null;
    if (failures === 0) {
        console.log('Session 4 passed: thumper slam hurls antlions out of the radius.');
    }
}

// -----------------------------------------------------------------------------
// 7. Global cap holds under indefinite camping.
// -----------------------------------------------------------------------------
function sessionCap() {
    config.brutalTypesForce = [AL.id];
    const realMax = AL.maxAntlions, realCeil = AL.maxAntlionsCeiling;
    AL.maxAntlions = 3; AL.maxAntlionsCeiling = 4; // small cap = fast assertion
    const map = loadMap('SandsOfTime.json');
    const room = buildRoom(map);
    const gb = room.game.gameBoard;
    const ids = Object.keys(room.playerList);
    const site = pickParkingSandSite(gb.currentMap);
    const holds = ids.map(id => ({ player: room.playerList[id], x: site.x, y: site.y }));
    for (const h of holds) { pinPlayer(h.player, site.x, site.y); }

    const cap = gb.antlionCap();
    let maxSeen = 0;
    // ~20 dwell windows of camping; population must never exceed the cap.
    const ticksTotal = Math.floor((AL.sandDwellSeconds * 1000 * 20) / config.serverTickSpeed);
    for (let f = 0; f < ticksTotal; f++) {
        tick(room, holds);
        maxSeen = Math.max(maxSeen, antlionsOf(room).length);
    }
    assert(maxSeen <= cap, 'antlion cap breached: saw ' + maxSeen + ' with cap ' + cap);
    assert(maxSeen >= cap, 'camping never reached the cap (saw ' + maxSeen + ' of ' + cap + ') — spawn loop broken?');

    AL.maxAntlions = realMax; AL.maxAntlionsCeiling = realCeil;
    config.brutalTypesForce = null;
    if (failures === 0) {
        console.log('Session 5 passed: global cap holds at ' + cap + ' under indefinite camping.');
    }
}

// -----------------------------------------------------------------------------
// 8. Water is a hard barrier: antlions can't walk on water (like zombies). Uses a
// water+sand map (The Flow) since SandsOfTime has none.
// -----------------------------------------------------------------------------
function sessionWaterBlock() {
    if (WATER_ID < 0) { fail('water-block: config has no water tile'); return; }
    config.brutalTypesForce = [AL.id];
    const map = loadMap('TheFlow.json');
    const room = buildRoom(map);
    const gb = room.game.gameBoard;
    const cells = gb.currentMap.cells;
    const waterCells = cells.filter(c => c.id === WATER_ID && c.site);
    assert(waterCells.length > 0, 'water-block: The Flow has no water cells (test map changed?)');
    if (failures > 0) { return; }

    // A water cell center, and the nearest land (non-water) cell to it.
    const w = waterCells[Math.floor(waterCells.length / 2)].site;
    let land = null, bd = Infinity;
    for (const c2 of cells) {
        if (c2.id === WATER_ID || !c2.site) { continue; }
        const d = (c2.site.x - w.x) ** 2 + (c2.site.y - w.y) ** 2;
        if (d < bd) { bd = d; land = c2.site; }
    }
    assert(land != null, 'water-block: no land cell found');
    if (failures > 0) { return; }

    // (a) Engine-level: a step from land aimed straight into water is deflected out.
    const ent = { x: land.x, y: land.y, newX: w.x, newY: w.y, velX: 0, velY: 0, maxVelocity: AL.chaseSpeed, bounced: false };
    _engine.bounceEntityOffWater(ent, gb.currentMap);
    assert(!_engine.isOnCellOfType(ent.newX, ent.newY, gb.currentMap, WATER_ID),
        'water-block: a step aimed into water was not deflected (ended at ' + Math.round(ent.newX) + ',' + Math.round(ent.newY) + ')');

    // (b) Integration: a live antlion lured straight at open water (both targets
    // pinned on the water cell) must never occupy a water cell on any tick.
    const ids = Object.keys(room.playerList);
    const holds = ids.map(id => ({ player: room.playerList[id], x: w.x, y: w.y }));
    for (const h of holds) { pinPlayer(h.player, w.x, w.y); }
    const hash = 'water-ant';
    room.hazardList[hash] = new Antlion(land.x, land.y, hash, gb.roomSig);
    let everInWater = false, samples = 0;
    for (let f = 0; f < 90; f++) {
        tick(room, holds);
        const a = room.hazardList[hash];
        if (a == null) { break; } // burrowed off a non-sand shore — fine, held so far
        samples++;
        if (_engine.isOnCellOfType(a.x, a.y, gb.currentMap, WATER_ID)) { everInWater = true; break; }
    }
    assert(!everInWater, 'water-block: a live antlion entered a water cell while lured across water');
    assert(samples > 0, 'water-block: integration antlion never ticked (setup error)');

    // (c) Dynamic water (Orbital Beam / Heatwave turn ice->water mid-round): the
    // mapHasCellOfType cache is otherwise never invalidated, so a map that STARTED
    // with no water would keep the block disabled after water appears. Verify the
    // block re-engages once rebuildStoneEdges (called wherever water is made) runs.
    const dryMap = loadMap('SandsOfTime.json'); // no water tiles
    assert(dryMap.cells.filter(c => c.id === WATER_ID).length === 0, 'dynamic-water: SandsOfTime unexpectedly has water');
    // Prime the cache to "no water" the way a live antlion tick would.
    const dryEnt = { x: 700, y: 400, newX: 700, newY: 400, velX: 0, velY: 0, maxVelocity: AL.chaseSpeed, bounced: false };
    _engine.bounceEntityOffWater(dryEnt, dryMap);
    // Convert one interior cell to water (mid-round mutation) + the terrain-change hook.
    let conv = null;
    for (const c2 of dryMap.cells) {
        if (c2.site && c2.site.x > 300 && c2.site.x < 1000 && c2.site.y > 250 && c2.site.y < 550) { conv = c2; break; }
    }
    assert(conv != null, 'dynamic-water: no interior cell to convert');
    if (failures === 0) {
        conv.id = WATER_ID;
        _engine.rebuildStoneEdges(dryMap); // the cache-invalidation choke point
        // A land entity stepping into the freshly-made water cell must now deflect.
        let lx = null, bnd = Infinity;
        for (const c2 of dryMap.cells) {
            if (c2.id === WATER_ID || !c2.site) { continue; }
            const d = (c2.site.x - conv.site.x) ** 2 + (c2.site.y - conv.site.y) ** 2;
            if (d < bnd) { bnd = d; lx = c2.site; }
        }
        const dynEnt = { x: lx.x, y: lx.y, newX: conv.site.x, newY: conv.site.y, velX: 0, velY: 0, maxVelocity: AL.chaseSpeed, bounced: false };
        _engine.bounceEntityOffWater(dynEnt, dryMap);
        assert(!_engine.isOnCellOfType(dynEnt.newX, dynEnt.newY, dryMap, WATER_ID),
            'dynamic-water: block did NOT re-engage after water was created mid-round (stale mapHasCellOfType cache)');
    }

    config.brutalTypesForce = null;
    if (failures === 0) {
        console.log('Session 6 passed: antlions blocked from water (' + samples + ' ticks clear) + dynamic-water cache invalidation.');
    }
}

// -----------------------------------------------------------------------------
// 9. A Vortex Well drags an antlion toward its core (A/B vs no-well control).
// The antlion sits inside a well; the only target sits FAR on the opposite side,
// so chase steering alone pulls it AWAY from the core. With the well present the
// pull must leave it measurably closer to the core than the well-less control.
// -----------------------------------------------------------------------------
function sessionVortexPull() {
    config.brutalTypesForce = [AL.id];
    const VW = config.hazards.vortexWell;

    function run(withWell) {
        const map = loadMap('SandsOfTime.json');
        const room = buildRoom(map);
        const gb = room.game.gameBoard;
        const site = pickParkingSandSite(gb.currentMap);
        const ids = Object.keys(room.playerList);
        // Core of the well; antlion 60u to its RIGHT; the lone live target far to
        // the right (chase = +x, away from the core at the antlion's left).
        const core = { x: site.x, y: site.y };
        const antX = core.x + 60, antY = core.y;
        const targetX = Math.min(core.x + 320, config.worldWidth - 120), targetY = core.y;
        // Park BOTH players together at the far target so the target list is the
        // far point (a second parked player elsewhere could become the nearest).
        const holds = ids.map(id => ({ player: room.playerList[id], x: targetX, y: targetY }));
        for (const h of holds) { pinPlayer(h.player, targetX, targetY); }

        const ant = gb.spawnAntlion(room.playerList[ids[0]]);
        if (ant == null) { return null; }
        ant.x = antX; ant.y = antY; ant.newX = antX; ant.newY = antY;
        ant.offSandMs = 0;
        if (withWell) {
            const well = new VortexWell(core.x, core.y, VW.radius, VW.color, 'vw-pull', room.game.gameBoard.roomSig);
            gb.hazardList[well.ownerId] = well;
        }
        // A handful of ticks — long enough for the steering delta to register,
        // short enough the antlion can't burrow (offSandDespawnSeconds is seconds).
        for (let f = 0; f < 12; f++) { tick(room, holds); }
        return dist(ant.x, ant.y, core.x, core.y);
    }

    const withoutWell = run(false);
    const withWell = run(true);
    assert(withoutWell != null && withWell != null, 'vortex-pull: spawnAntlion returned null');
    if (failures > 0) { config.brutalTypesForce = null; return; }
    // The well must pull the antlion meaningfully closer to the core than the
    // chase-only control (which drifts it the other way toward the far target).
    assert(withWell < withoutWell - 15,
        'vortex did not pull the antlion toward its core (with well ' + Math.round(withWell) +
        'u from core vs ' + Math.round(withoutWell) + 'u without)');

    config.brutalTypesForce = null;
    if (failures === 0) {
        console.log('Session 7 passed: a vortex well drags antlions toward its core (' +
            Math.round(withWell) + 'u with vs ' + Math.round(withoutWell) + 'u without).');
    }
}

messenger.build(fakeIo);
try {
    sessionSelectionGate();
    if (failures === 0) sessionSpawnChaseShove();
    if (failures === 0) sessionBurrow();
    if (failures === 0) sessionThumperSlam();
    if (failures === 0) sessionCap();
    if (failures === 0) sessionWaterBlock();
    if (failures === 0) sessionVortexPull();
} catch (e) {
    fail('Unhandled exception during antlion test: ' + e.message + '\n' + e.stack);
} finally {
    restoreClock();
    config.brutalTypesForce = null;
}

if (failures > 0) {
    console.log('\nAntlion test FAILED with ' + failures + ' error(s).');
    process.exit(1);
}
console.log('\nAntlion test passed: spawn, chase, shove, leash, slam, cap all verified.');
process.exit(0);
