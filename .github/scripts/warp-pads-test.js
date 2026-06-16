'use strict';

// Real-engine headless test for the Warp Pads BOON (config.boons.warpPad, id 958) —
// PAIRED TELEPORTERS. The genuinely new bits: a PAIR of placeables that reference each
// other (linked by a `pair` id), a distance-based TRANSIT (the racer is frozen + invulnerable,
// then emerges at the partner with velocity restored — run from gameBoard.updateWarpPads,
// NOT handleHit), a per-player ARMED latch to stop ping-pong, and — the headline work —
// an AI cellGraph SHORTCUT edge between the two linked cells so bots route THROUGH a pad
// pair, weighted by the transit cost so it's only taken when it genuinely shortens the trip.
//
//   [A] WarpPad (pure). Pairing/link + helpful (boon); contains() membership + warpTo()
//       relocate preserving velocity; players only (pucks/dead/finished skipped); an
//       unlinked/fractional pad is inert; handleHit inert.
//   [B] Wire (compressor). netState carries the pair id (5-field per-tick row); the
//       creation row stays 9 fields with the pair at [7] and [8] null (not sizable).
//   [C] AI cellGraph linkage. getWarpLinks builds the cross-cell edge; findPath routes
//       THROUGH the warp when it shortens the drive; estimatePathTime adds the transit
//       time but par still DROPS on a real shortcut (the saved driving > the freeze).
//   [D] Live tick loop. Driving onto pad A starts a 2s TRANSIT (frozen at the entrance,
//       warpStart emitted), then the kart EMERGES at pad B with velocity restored
//       (warpEnd emitted); the armed latch stops a parked kart oscillating; and a BOT on
//       a warp-shortcut map routes through the pads and FINISHES (takes the shortcut).
//   [E] validateMap. Rejects a lone / triple / fractional / on-a-hole / on-a-door pad;
//       accepts clean pairs.

const path = require('path');
const repoRoot = path.join(__dirname, '..', '..');
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));
const utils = require(path.join(repoRoot, 'server', 'utils.js'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));
const compressor = require(path.join(repoRoot, 'server', 'compressor.js'));
const cellGraph = require(path.join(repoRoot, 'server', 'cellGraph.js'));
const { WarpPad, linkWarpPads } = require(path.join(repoRoot, 'server', 'entities', 'hazards.js'));

const T = config.tileMap;
const GRASS = T.fast.id;
const EMPTY = T.empty.id;
const GOAL = T.goal.id;
const DT = config.serverTickSpeed / 1000;
const WP = config.boons.warpPad;  // id 958 (a boon)

let failures = 0;
function check(cond, msg) {
    if (cond) { console.log('  ok  - ' + msg); }
    else { failures++; console.log('::error::FAIL - ' + msg); }
}

function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const events = [];
const fakeIo = {
    to() { return { emit(name, data) { events.push({ name: name, data: data }); } }; },
    sockets: { emit(name, data) { events.push({ name: name, data: data }); } }
};
messenger.build(fakeIo);

const COLS = [76, 228, 380, 532, 684, 836, 988, 1140, 1290];
const ROWS = [280, 384, 488];
function buildMap(name, hazards, lanes) {
    const sites = [];
    for (let col = 0; col < COLS.length; col++) {
        for (let row = 0; row < ROWS.length; row++) {
            let id = EMPTY;
            if (lanes.indexOf(row) !== -1) { id = (col === 8) ? GOAL : GRASS; }
            sites.push({ x: COLS[col], y: ROWS[row], id: id });
        }
    }
    return mapFormat.reconstruct({
        bbox: { xl: 0, xr: config.worldWidth, yt: 0, yb: config.worldHeight },
        sites: sites, hazards: hazards, startEdges: ['left'], name: name, author: 'test', id: 'warptest-' + name
    });
}

const realNow = Date.now;
const realRandom = Math.random;
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
let clock = 1000000;
let timers = [];
function fireDueTimers() {
    const due = [];
    timers = timers.filter(t => { if (t.at <= clock) { due.push(t); return false; } return true; });
    for (const t of due) { t.fn.apply(null, t.args); }
}

function bootRoom(sig, map, profile) {
    const game = require(path.join(repoRoot, 'server', 'game.js'));
    const room = game.getRoom(sig, 8);
    room.game.gameBoard.isPreview = true;
    room.game.gameBoard.previewMap = map;
    const bid = sig + '-bot0';
    const bot = room.world.createNewBot(bid, profile);
    room.playerList[bid] = bot;
    room.game.determineGameState(bot);
    room.game.startLobby(); room.game.startGated(); room.game.startRace();
    return { room, bot };
}

const SOAK = { id: 'soak', name: 'Soak', title: '', skill: 0.5, aggression: 0.2, tempo: 0.5, risk: 0.3, focus: 'race' };

try {
    Date.now = () => clock;
    Math.random = mulberry32(0x5A1D);
    global.setTimeout = function (fn, ms) {
        const handle = { at: clock + (ms || 0), fn: fn, args: Array.prototype.slice.call(arguments, 2) };
        timers.push(handle);
        return handle;
    };
    global.clearTimeout = function (handle) { timers = timers.filter(t => t !== handle); };

    // ----------------------------------------------------------------------
    console.log('[A] WarpPad (pure): pairing, helpful, contains/warpTo');
    {
        const a = new WarpPad(200, 300, 'wp-a', 'sig-a', 5);
        const b = new WarpPad(900, 300, 'wp-b', 'sig-a', 5);
        check(a.moveable === false, 'is stationary (not moveable)');
        check(a.isWarpPad === true, 'flags isWarpPad (AI skips it as an obstacle)');
        check(a.pair === 5 && a.netState === 5, 'carries the pair id and ships it on netState');
        check(a.radius === WP.radius, 'trigger/visual radius is the configured radius');
        check(a.partner == null, 'unlinked until linkWarpPads runs');

        const list = {}; list[a.ownerId] = a; list[b.ownerId] = b;
        linkWarpPads(list);
        check(a.partner === b && b.partner === a, 'linkWarpPads pairs the two pads by id');

        // handleHit is inert — the teleport is the dedicated updateWarpPads pass.
        check(a.handleHit({ isPlayer: true, x: 200, y: 300 }) === undefined, 'handleHit is a no-op (teleport is not applied on contact)');

        // contains() is the on-pad membership test; warpTo() relocates onto the partner,
        // KEEPING velocity. (The armed-latch gating lives in gameBoard — see [D].)
        const p = { isPlayer: true, alive: true, reachedGoal: false, x: 205, y: 302, newX: 205, newY: 302, velX: 4, velY: -3 };
        check(a.contains(p) === true, 'a racer standing on pad A is detected by contains()');
        check(a.warpTo(p) === true, 'warpTo relocates it');
        check(p.x === b.x && p.y === b.y && p.newX === b.x && p.newY === b.y, 'it lands on pad B (x/y AND newX/newY)');
        check(p.velX === 4 && p.velY === -3, 'velocity is preserved through the warp');
        const jump = Math.hypot(b.x - 205, b.y - 302);
        check(jump > 120, 'the jump exceeds the client snap distance (120px) so smoothEntities snaps, not slides (' + jump.toFixed(0) + 'px)');

        // Off-pad / non-player / dead / finished are never "contained".
        const off = { isPlayer: true, alive: true, reachedGoal: false, x: 500, y: 300, newX: 500, newY: 300, velX: 0, velY: 0 };
        check(a.contains(off) === false, 'a racer not on the pad is not contained');
        check(a.contains({ isPuck: true, x: 200, y: 300, newX: 200, newY: 300 }) === false, 'a puck (non-player) is ignored');
        check(a.contains({ isPlayer: true, alive: false, x: 200, y: 300, newX: 200, newY: 300 }) === false, 'a dead racer is ignored');
        check(a.contains({ isPlayer: true, alive: true, reachedGoal: true, x: 200, y: 300, newX: 200, newY: 300 }) === false, 'a finished racer is ignored');

        // An unlinked pad (malformed map) is inert (no partner) — contains() is false.
        const lone = new WarpPad(400, 400, 'wp-lone', 'sig-a', 9);
        check(lone.contains({ isPlayer: true, alive: true, reachedGoal: false, x: 400, y: 400, newX: 400, newY: 400 }) === false, 'an unlinked (lone) pad reports nothing contained (no partner)');
        // A fractional/missing pair never links (integer ids only), matching validateMap.
        const fracA = new WarpPad(100, 100, 'fa', 'sig-a', 1.5);
        check(fracA.pair === null, 'a fractional pair id is rejected (stored null → never links)');
    }

    // ----------------------------------------------------------------------
    console.log('\n[B] Wire (compressor): pair id on netState');
    {
        const a = new WarpPad(200, 300, 'wp-wire', 'sig-b', 3);
        const list = {}; list[a.ownerId] = a;
        const rows = compressor.sendHazardUpdates(list);
        check(rows[0].length === 5, 'per-tick row is 5 fields (netState carries the pair id)');
        check(rows[0][3] === null, 'per-tick [3] = null (no streamed angle — warp pads don\'t rotate)');
        check(rows[0][4] === 3, 'per-tick [4] = the pair id (netState)');

        const created = JSON.parse(compressor.newHazards(list));
        check(created[0].length === 9, 'creation row stays 9 fields (no new wire slot — reuses netState)');
        check(created[0][1] === WP.id, 'newHazards carries the warp pad (id ' + WP.id + ')');
        check(created[0][7] === 3, 'created [7] = the pair id (netState)');
        check(created[0][8] === null, 'created [8] = radius is null (warp pad is not sizable)');
    }

    // ----------------------------------------------------------------------
    console.log('\n[C] AI cellGraph linkage: the shortcut edge');
    {
        // A single straight grass lane left->right, goal at the right. A warp pair links
        // a near-start cell to a near-goal cell, so the optimal route hops the pair.
        const lanes = [1];
        const noWarp = buildMap('nowarp', [], lanes);
        const r1 = cellGraph.findPathToNearestGoal(noWarp, { x: COLS[0], y: ROWS[1] });
        const par1 = cellGraph.estimatePathTime(noWarp, r1.path);
        check(r1 != null && r1.path.length >= 7, 'without warp, the route walks the whole lane (' + r1.path.length + ' cells)');

        const warp = buildMap('warp', [
            { id: WP.id, x: COLS[1], y: ROWS[1], pair: 1 },
            { id: WP.id, x: COLS[6], y: ROWS[1], pair: 1 }
        ], lanes);
        const links = cellGraph.getWarpLinks(warp);
        check(links != null, 'getWarpLinks builds the cross-cell edge map');
        const r2 = cellGraph.findPathToNearestGoal(warp, { x: COLS[0], y: ROWS[1] });
        const par2 = cellGraph.estimatePathTime(warp, r2.path);
        check(r2 != null && r2.path.length < r1.path.length, 'with the warp the route is SHORTER (' + r2.path.length + ' < ' + r1.path.length + ' cells) — it hops the pair');
        check(par2 < par1, 'estimatePathTime adds the transit cost yet par still drops on a real shortcut (' + par1.toFixed(2) + 's -> ' + par2.toFixed(2) + 's)');

        // A bidirectional link: each pad cell points at the other.
        let keys = Object.keys(links);
        check(keys.length === 2, 'exactly the two pad cells are linked');
        check(links[keys[0]] === Number(keys[1]) && links[keys[1]] === Number(keys[0]), 'the link is bidirectional (A<->B)');

        // A malformed (lone) pad builds no link — no shortcut, no crash.
        const lone = buildMap('lone', [{ id: WP.id, x: COLS[3], y: ROWS[1], pair: 7 }], lanes);
        check(cellGraph.getWarpLinks(lone) == null, 'a lone (unpaired) pad yields no link');
    }

    // ----------------------------------------------------------------------
    console.log('\n[D] Live tick loop: distance-based transit + emerge + AI shortcut');
    {
        // D1 — a kart driving onto pad A COMMITS: it's frozen + invulnerable for the
        // (distance-based) transit (a warpStart event fires), then EMERGES at pad B with
        // velocity restored (a warpEnd event fires). It does NOT instantly teleport.
        const lanes = [0, 1, 2];
        const padAx = COLS[2], padAy = ROWS[1], padBx = COLS[6], padBy = ROWS[1];
        const tmap = buildMap('tele', [
            { id: WP.id, x: padAx, y: padAy, pair: 1 },
            { id: WP.id, x: padBx, y: padBy, pair: 1 }
        ], lanes);
        const { room: tRoom, bot: tBot } = bootRoom('wp-tele', tmap, SOAK);
        const ids = Object.keys(tRoom.game.gameBoard.hazardList);
        check(ids.length === 2, 'both warp pads spawned from the map entries');
        const hzA = tRoom.game.gameBoard.hazardList[ids[0]];
        check(hzA.isWarpPad && hzA.partner != null && hzA.helpful === true, 'the spawned pads are linked WarpPads and flagged helpful (a boon)');
        // The transit duration is DISTANCE-based (set by linkWarpPads): both pads share it,
        // and it's clamped to [minTransitMs, maxTransitMs].
        const TRANSIT = hzA.transitMs / 1000;
        check(hzA.transitMs === hzA.partner.transitMs && hzA.transitMs >= WP.minTransitMs && hzA.transitMs <= WP.maxTransitMs, 'the transit duration is distance-based + clamped (' + Math.round(hzA.transitMs) + 'ms for a ' + Math.round(Math.hypot(padBx - padAx, padBy - padAy)) + 'px hop)');

        tBot.isAI = false;
        tBot.moveForward = tBot.moveBackward = tBot.turnLeft = tBot.turnRight = false;
        // Park the kart on pad A with a rightward velocity; the next tick commits the warp.
        tBot.x = tBot.newX = padAx; tBot.y = tBot.newY = padAy; tBot.velX = 6; tBot.velY = 0;
        tBot.warpArmed = true;
        events.length = 0;
        // One tick to commit the transit.
        tRoom.update(DT); clock += config.serverTickSpeed; fireDueTimers();
        check(tBot.warping != null, 'driving onto pad A starts a TRANSIT (not an instant teleport)');
        check(Math.hypot(tBot.x - padAx, tBot.y - padAy) < 60, 'during transit the kart is held at the entrance (frozen), not yet at the exit');
        check(tBot.velX === 0 && tBot.velY === 0, 'the kart is frozen (velocity zeroed) in transit');
        check(events.some(e => e.name === 'warpStart'), 'a warpStart event was emitted (drives the enter SFX + camera pan)');

        // It stays frozen until transitMs elapses (advance the mock clock by < transitMs).
        for (let f = 0; f < Math.floor((TRANSIT * 1000 - 200) / config.serverTickSpeed); f++) {
            tRoom.update(DT); clock += config.serverTickSpeed; fireDueTimers();
        }
        check(tBot.warping != null && Math.hypot(tBot.x - padAx, tBot.y - padAy) < 60, 'still in transit (frozen at the entrance) before transitMs elapses');

        // Past transitMs it EMERGES at the exit with its velocity restored.
        events.length = 0;
        for (let f = 0; f < 10; f++) {
            tRoom.update(DT); clock += config.serverTickSpeed; fireDueTimers();
            if (tBot.warping == null) { break; }
        }
        check(tBot.warping == null, 'the transit ended');
        check(Math.hypot(tBot.x - padBx, tBot.y - padBy) < 60, 'the kart EMERGED at the exit pad B');
        check(tBot.velX > 0, 'its rightward velocity was restored on emerge');
        check(events.some(e => e.name === 'warpEnd'), 'a warpEnd event was emitted (drives the exit SFX + camera release)');

        // Death mid-transit: a racer that dies while warping (e.g. an infection kill-timer
        // firing) must DROP the transit — never relocate the dead kart to the exit or emit a
        // ghost warpEnd. updateWarpPads's stage-1 guard handles it (killPlayer also clears
        // warping). Call updateWarpPads directly in a racing state so the death of the only
        // bot doesn't end the round before the guard runs.
        tBot.x = tBot.newX = padBx + 5; tBot.y = tBot.newY = padBy; // somewhere that ISN'T the exit
        tBot.warping = { until: clock + 999999, exitX: padAx, exitY: padAy, velX: 3, velY: 0 };
        tBot.alive = false;
        events.length = 0;
        tRoom.game.gameBoard.updateWarpPads(config.stateMap.racing);
        check(tBot.warping == null, 'a dead racer\'s transit is dropped (updateWarpPads stage-1 alive guard)');
        check(!events.some(e => e.name === 'warpEnd'), 'no ghost warpEnd is emitted for a kart that died mid-transit');
        check(Math.hypot(tBot.x - padAx, tBot.y - padAy) > 100, 'the dead kart was NOT relocated to the exit');
        tBot.alive = true; tBot.warpArmed = true; // restore for the rest of the test

        // Armed latch: a kart parked DEAD STILL on pad B must NOT warp back to A — it stays
        // disarmed until it leaves the pad. Pin it on pad B, no input, well past a transit.
        tBot.x = tBot.newX = padBx; tBot.y = tBot.newY = padBy; tBot.velX = tBot.velY = 0;
        tBot.warpArmed = false; tBot.warping = null;
        let oscillated = false;
        for (let f = 0; f < 90; f++) {
            tBot.moveForward = tBot.moveBackward = tBot.turnLeft = tBot.turnRight = false;
            tBot.velX = tBot.velY = 0; tBot.x = tBot.newX = padBx; tBot.y = tBot.newY = padBy; tBot.warping = null;
            tRoom.update(DT); clock += config.serverTickSpeed; fireDueTimers();
            if (Math.hypot(tBot.x - padAx, tBot.y - padAy) < 100) { oscillated = true; break; }
        }
        check(!oscillated, 'a kart parked dead-still on a pad does NOT ping-pong back (armed latch holds)');

        // D2 — AI on a warp-shortcut map: the bot routes THROUGH the pads (transit + emerge)
        // and finishes, proving it uses the link as a shortcut and never ping-pongs forever.
        const sLanes = [1];
        const warpMap = buildMap('aiwarp', [
            { id: WP.id, x: COLS[1], y: ROWS[1], pair: 1 },
            { id: WP.id, x: COLS[6], y: ROWS[1], pair: 1 }
        ], sLanes);
        const { room: aRoom, bot: aBot } = bootRoom('wp-ai', warpMap, SOAK);
        let usedWarp = false, finished = false, finishTick = -1;
        for (let f = 0; f < 600; f++) { // up to 20s (the transit costs 2s)
            aRoom.update(DT); clock += config.serverTickSpeed; fireDueTimers();
            if (aBot.warping != null) { usedWarp = true; }
            if (aBot.reachedGoal) { finished = true; finishTick = f; break; }
        }
        check(usedWarp, 'the bot drove onto a pad and went into transit (took the shortcut)');
        check(finished, 'the bot reached the goal via the shortcut (no ping-pong stall)' + (finishTick >= 0 ? ' in ' + (finishTick * DT).toFixed(1) + 's' : ''));
    }

    // ----------------------------------------------------------------------
    console.log('\n[E] validateMap: exactly two pads per pair');
    {
        const cells = [];
        for (let col = 0; col < COLS.length; col++) {
            cells.push({ x: COLS[col], y: ROWS[1], id: (col === 8) ? GOAL : GRASS });
        }
        function vmap(hazards) {
            return mapFormat.reconstruct({
                bbox: { xl: 0, xr: config.worldWidth, yt: 0, yb: config.worldHeight },
                sites: cells, hazards: hazards, startEdges: ['left'], name: 'v', author: 'test', id: 'warpvalid'
            });
        }
        const pair = [{ id: WP.id, x: COLS[1], y: ROWS[1], pair: 1 }, { id: WP.id, x: COLS[6], y: ROWS[1], pair: 1 }];
        check(utils.validateMap(vmap(pair), config).valid === true, 'a clean pair (2 pads, same id) validates');

        const lone = [{ id: WP.id, x: COLS[1], y: ROWS[1], pair: 1 }];
        check(utils.validateMap(vmap(lone), config).valid === false, 'a lone pad is rejected (needs a partner)');

        const triple = [
            { id: WP.id, x: COLS[1], y: ROWS[1], pair: 1 },
            { id: WP.id, x: COLS[4], y: ROWS[1], pair: 1 },
            { id: WP.id, x: COLS[6], y: ROWS[1], pair: 1 }
        ];
        check(utils.validateMap(vmap(triple), config).valid === false, 'three pads sharing one pair id is rejected (pairs of exactly 2)');

        const noPair = [{ id: WP.id, x: COLS[1], y: ROWS[1] }, { id: WP.id, x: COLS[6], y: ROWS[1] }];
        check(utils.validateMap(vmap(noPair), config).valid === false, 'a pad with no pair id is rejected');

        const twoPairs = [
            { id: WP.id, x: COLS[1], y: ROWS[1], pair: 1 }, { id: WP.id, x: COLS[6], y: ROWS[1], pair: 1 },
            { id: WP.id, x: COLS[2], y: ROWS[1], pair: 2 }, { id: WP.id, x: COLS[5], y: ROWS[1], pair: 2 }
        ];
        check(utils.validateMap(vmap(twoPairs), config).valid === true, 'two independent pairs both validate');

        const frac = [{ id: WP.id, x: COLS[1], y: ROWS[1], pair: 1.5 }, { id: WP.id, x: COLS[6], y: ROWS[1], pair: 1.5 }];
        check(utils.validateMap(vmap(frac), config).valid === false, 'a fractional (non-integer) pair id is rejected');

        // A pad on a non-drivable cell (a hole) is rejected — must sit on drivable ground.
        const holeCells = cells.map((s, i) => ({ x: s.x, y: s.y, id: (i === 1) ? EMPTY : s.id }));
        const onHole = [{ id: WP.id, x: COLS[1], y: ROWS[1], pair: 1 }, { id: WP.id, x: COLS[6], y: ROWS[1], pair: 1 }];
        const holeMap = mapFormat.reconstruct({
            bbox: { xl: 0, xr: config.worldWidth, yt: 0, yb: config.worldHeight },
            sites: holeCells, hazards: onHole, startEdges: ['left'], name: 'v', author: 'test', id: 'warphole'
        });
        const holeResult = utils.validateMap(holeMap, config);
        check(holeResult.valid === false && /drivable ground/.test(holeResult.reason || ''), 'a pad on a hole (empty cell) is rejected — pads need drivable ground');

        // A pad sitting on an authored locked-door cell is rejected (the cell becomes a
        // wall at runtime). Door at COLS[1]; one pad on top of it, its partner elsewhere.
        const doorMap = mapFormat.reconstruct({
            bbox: { xl: 0, xr: config.worldWidth, yt: 0, yb: config.worldHeight },
            sites: cells, hazards: [{ id: WP.id, x: COLS[1], y: ROWS[1], pair: 1 }, { id: WP.id, x: COLS[6], y: ROWS[1], pair: 1 }],
            doors: [{ x: COLS[1], y: ROWS[1] }], keys: [{ x: COLS[3], y: ROWS[1] }],
            startEdges: ['left'], name: 'v', author: 'test', id: 'warpdoor'
        });
        const doorResult = utils.validateMap(doorMap, config);
        check(doorResult.valid === false && /locked-door cell/.test(doorResult.reason || ''), 'a pad on a locked-door cell is rejected');
    }

    // ----------------------------------------------------------------------
    console.log('\n[F] Fairness: a TRAP teleport (goal-side mouth on the racing line) is caught');
    {
        const mapClassifier = require(path.join(repoRoot, 'server', 'mapClassifier.js'));
        const TC = [80, 300, 520, 740, 960, 1180, 1400], TR = [260, 460, 660];
        // The racing line is the middle row; other rows are EMPTY unless `island` carves grass.
        function tmap(haz, island) {
            const s = [];
            for (let ci = 0; ci < TC.length; ci++) for (let ri = 0; ri < TR.length; ri++) {
                let id = EMPTY;
                if (ri === 1) { id = (ci === TC.length - 1) ? GOAL : GRASS; }
                if (island && island(ci, ri)) { id = GRASS; }
                s.push({ x: TC[ci], y: TR[ri], id: id });
            }
            return mapFormat.reconstruct({ bbox: { xl: 0, xr: config.worldWidth, yt: 0, yb: config.worldHeight }, sites: s, hazards: haz, startEdges: ['left'], name: 'f', author: 'test', id: 'warpfair-' + Math.random() });
        }
        const hasWarpTrap = (cls) => (cls.deductions || []).some(d => d.indexOf('warptrap') === 0);
        const baseScore = mapClassifier.classify(tmap([]), config).balanceScore;
        // TRAP: goal-side mouth ON the lane (col5) ↔ far pad near the start (col1). A racer
        // driving the line straight hits col5 head-on and is flung back to the start side —
        // invisible to the optimal par (which takes the warp from the start side instead).
        const trap = mapClassifier.classify(tmap([{ id: WP.id, x: TC[5], y: TR[1], pair: 1 }, { id: WP.id, x: TC[1], y: TR[1], pair: 1 }]), config);
        check(hasWarpTrap(trap), 'a warp whose goal-side mouth sits ON the racing line is penalised (warptrap deduction)');
        check(trap.balanceScore < baseScore - 10, 'the trap drops the balance score hard (' + baseScore + ' -> ' + trap.balanceScore + ')');
        // SAFE: goal-side mouth in an OFF-line pocket (col5,row0 grass island, not on the line)
        // ↔ far near the start. Forward racers never drive over it, so it's a pure exit.
        const safe = mapClassifier.classify(tmap([{ id: WP.id, x: TC[5], y: TR[0], pair: 1 }, { id: WP.id, x: TC[1], y: TR[1], pair: 1 }], (ci, ri) => ri === 0 && (ci === 5 || ci === 4)), config);
        check(!hasWarpTrap(safe), 'a warp with an OFF-line exit pocket is NOT penalised (safe placement, score ' + safe.balanceScore + ')');
    }
} finally {
    Date.now = realNow;
    Math.random = realRandom;
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
}

console.log('');
if (failures > 0) {
    console.log('Warp-pads test FAILED with ' + failures + ' error(s).');
    process.exit(1);
}
console.log('Warp-pads test passed.');
process.exit(0);
