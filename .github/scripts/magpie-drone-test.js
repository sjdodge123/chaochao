'use strict';

// Real-engine headless test for the Magpie Drone hazard (config.hazards.magpieDrone): a
// thieving drone that patrols a rail (railed, like the moving bumper) and STEALS a racer's
// HELD ABILITY on contact, carrying it off. Punch it (a real player swing) and it DROPS the
// loot onto the nearest drivable cell as a re-grabbable ability PAD (the normal ability-tile
// pickup). An empty-handed racer gets a STAMINA chunk drained instead. It's the first hazard
// to touch the ability ECONOMY.
//
//   [A] handleHit request logic (pure). Body contact with a racer holding an ability records
//       a steal request; a FULL drone / protected / star-power / on-cooldown contact records
//       nothing; a real player PUNCH while carrying records a drop (and marks the punch
//       landed); a map-owned / clashed punch records nothing. scaleSpeed (lightning).
//
//   [B] Wire (compressor). netState ships the carried ability tile id (per-tick row grows to
//       5: [owner,x,y,null,loot]); railed, so newHazards ships the RAIL origin/angle + netState.
//
//   [C] Live loop (full tick). The drone spawns from a map entry; a kart with a held ability
//       driven onto it is robbed (loot carried, ability gone, abilityList cleared, magpieSteal
//       fired); a punch makes it DROP the loot onto a cell as an ability pad which an empty
//       kart then RE-GRABS; an empty-handed kart loses a stamina chunk instead.

const path = require('path');
const repoRoot = path.join(__dirname, '..', '..');
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));
const compressor = require(path.join(repoRoot, 'server', 'compressor.js'));
const { hazardKindById } = require(path.join(repoRoot, 'server', 'entities', 'hazards.js'));
const { Blindfold } = require(path.join(repoRoot, 'server', 'entities', 'abilities.js'));

const T = config.tileMap;
const GRASS = T.fast.id;
const EMPTY = T.empty.id;
const GOAL = T.goal.id;
const DT = config.serverTickSpeed / 1000;
const MD = config.hazards.magpieDrone; // id 912
const KIND = hazardKindById(MD.id);
const BLIND = T.abilities.blindfold.id; // 100 — what a stolen Blindfold reports as ability.id

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
        sites: sites, hazards: hazards, startEdges: ['left'], name: name, author: 'test', id: 'magpietest-' + name
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

function fakeKart(over) {
    return Object.assign({
        id: 'k', isPlayer: true, alive: true, reachedGoal: false, ability: null, stamina: 100,
        x: 0, y: 0, newX: 0, newY: 0, velX: 0, velY: 0,
        isProtected() { return false; }, hasStarPower() { return false; }
    }, over);
}
function fakePunch(over) {
    return Object.assign({ isPunch: true, mapOwned: false, clashed: false, landed: false }, over);
}

try {
    Date.now = () => clock;
    Math.random = mulberry32(0x9A95);
    global.setTimeout = function (fn, ms) {
        const handle = { at: clock + (ms || 0), fn: fn, args: Array.prototype.slice.call(arguments, 2) };
        timers.push(handle);
        return handle;
    };
    global.clearTimeout = function (handle) { timers = timers.filter(t => t !== handle); };

    // ----------------------------------------------------------------------
    console.log('[A] handleHit request logic (pure)');
    {
        const d = KIND.build({ id: MD.id, x: 400, y: 200, angle: 0 }, 'md-a', 'sig-a');
        check(d.id === MD.id && d.moveable === true && d.rail != null && d.isMagpie === true, 'is a railed, moveable MagpieDrone');
        check(d.loot === 0 && d.netState === 0, 'starts empty-handed (loot 0, netState 0)');

        // Body contact with a racer HOLDING an ability → records a steal request (no mutation yet).
        const holder = fakeKart({ id: 'h', ability: { id: BLIND } });
        d.handleHit(holder);
        check(d.stealVictimId === 'h', 'contact with an ability-holder records a steal request');
        check(holder.ability != null, 'handleHit does NOT mutate the inventory itself (deferred to the gameBoard pass)');

        // A FULL drone ignores further body contact.
        d.stealVictimId = null; d.loot = BLIND;
        d.handleHit(fakeKart({ id: 'h2', ability: { id: BLIND } }));
        check(d.stealVictimId === null, 'a FULL drone records no steal (it is busy carrying loot)');

        // Punch while carrying → drop request, punch marked landed.
        const swing = fakePunch();
        d.handleHit(swing);
        check(d.dropRequest === true && swing.landed === true, 'a real player punch while carrying records a DROP (and lands the punch)');

        // Map-owned / clashed punches don't count.
        d.dropRequest = false;
        d.handleHit(fakePunch({ mapOwned: true }));
        d.handleHit(fakePunch({ clashed: true }));
        check(d.dropRequest === false, 'map-owned / clashed punches cannot make it drop');

        // Empty again: protected / star / cooldown all block the steal.
        d.loot = 0; d.stealVictimId = null;
        d.handleHit(fakeKart({ id: 'p', ability: { id: BLIND }, isProtected() { return true; } }));
        check(d.stealVictimId === null, 'a protected kart is not robbed');
        d.handleHit(fakeKart({ id: 's', ability: { id: BLIND }, hasStarPower() { return true; } }));
        check(d.stealVictimId === null, 'a star-power kart is not robbed');
        d.nextStealTime = clock + 5000;
        d.handleHit(fakeKart({ id: 'c', ability: { id: BLIND } }));
        check(d.stealVictimId === null, 'a drone on cooldown records no steal');
        d.nextStealTime = 0;

        // An empty-handed racer still registers (so the gameBoard pass can drain stamina).
        d.handleHit(fakeKart({ id: 'e', ability: null }));
        check(d.stealVictimId === 'e', 'an empty-handed racer is recorded too (for a stamina drain)');

        // Lightning speed-up.
        const before = d.speed;
        d.scaleSpeed(config.brutalRounds.lightning.movingHazardSpeedMod);
        check(d.speed > before, 'scaleSpeed (lightning) speeds the drone up');
    }

    // ----------------------------------------------------------------------
    console.log('\n[B] Wire: netState carries the loot + author-sized rail length (compressor)');
    {
        const d = KIND.build({ id: MD.id, x: 350, y: 260, angle: 0, railLength: 240 }, 'md-b', 'sig-b');
        const list = {}; list[d.ownerId] = d;
        let row = compressor.sendHazardUpdates(list)[0];
        check(row.length === 5 && row[3] === null && row[4] === 0, 'empty drone per-tick row = [owner,x,y,null,0]');

        d.loot = BLIND; d.netState = BLIND;
        row = compressor.sendHazardUpdates(list)[0];
        check(row[4] === BLIND, 'a carrying drone ships the loot ability id on netState ([4])');

        const created = JSON.parse(compressor.newHazards(list));
        check(created[0][1] === MD.id, 'newHazards carries the drone (id ' + MD.id + ')');
        check(Math.abs(created[0][5] - 350) < 1e-6 && Math.abs(created[0][6] - 260) < 1e-6, 'created[5]/[6] = rail origin (railed)');
        check(created[0][7] === BLIND, 'created[7] = netState (the carried loot)');
        check(created[0][8] === null, 'created[8] = radius (null — the drone is NOT a radius-sizable kind)');
        // Author-set rail length rides slot [9] (railLengthAuthored — the SAME slot as the Zipline).
        check(created[0].length === 10 && created[0][9] === 240, 'created[9] = the authored per-instance RAIL LENGTH');

        // Per-instance rail length: build honors the authored value, clamped to config bounds.
        const dShort = KIND.build({ id: MD.id, x: 0, y: 0, angle: 0, railLength: 120 }, 'md-s', 'sig-b');
        check(dShort.rail.width === 120, 'a built drone uses the authored rail length (rail.width)');
        const dBig = KIND.build({ id: MD.id, x: 0, y: 0, angle: 0, railLength: 99999 }, 'md-big', 'sig-b');
        const mapWide = Math.hypot(config.worldWidth, config.worldHeight); // map-wide cap = world diagonal
        check(dBig.rail.width === mapWide, 'an over-long rail is clamped MAP-WIDE (the world diagonal ' + Math.round(mapWide) + 'px)');
        const dDef = KIND.build({ id: MD.id, x: 0, y: 0, angle: 0 }, 'md-def', 'sig-b');
        check(dDef.rail.width === MD.railLength, 'a missing rail length falls back to the config default');
    }

    // ----------------------------------------------------------------------
    console.log('\n[C] Live loop: steal / drop+repaint / re-grab / stamina drain');
    {
        const RX = COLS[3], RY = ROWS[1];
        const map = buildMap('econ', [{ id: MD.id, x: RX, y: RY, angle: 0 }], [0, 1, 2]);
        const { room, bot } = bootRoom('magpie-econ', map, { id: 'mark', name: 'Mark', title: '', skill: 0.5, aggression: 0.2, tempo: 0.5, risk: 0.3, focus: 'race' });
        const gb = room.game.gameBoard;
        const ids = Object.keys(gb.hazardList);
        check(ids.length === 1, 'the drone spawned from the map hazard entry');
        const hz = gb.hazardList[ids[0]];
        check(hz != null && hz.id === MD.id && hz.isMagpie === true, 'the spawned hazard is a railed MagpieDrone');

        // Pin the drone in place so we control contact, and put the bot under our control.
        hz.advance = function () { this.newX = RX; this.newY = RY; this.velX = 0; this.velY = 0; };
        bot.isAI = false;

        // --- STEAL: give the bot a held ability, then hold it on the drone. ---
        bot.ability = new Blindfold(bot.id, 'magpie-econ');
        gb.abilityList[bot.id] = bot.ability;
        hz.loot = 0; hz.netState = 0; hz.nextStealTime = 0;
        events.length = 0;
        let stoleEvent = null;
        for (let f = 0; f < 6 && hz.loot === 0; f++) {
            bot.x = bot.newX = RX; bot.y = bot.newY = RY; bot.velX = 0; bot.velY = 0;
            room.update(DT); clock += config.serverTickSpeed; fireDueTimers();
            for (const e of events) { if (e.name === 'magpieSteal') { stoleEvent = e.data; } }
        }
        check(hz.loot === BLIND && hz.netState === BLIND, 'the drone STOLE the held ability (carries it as loot)');
        check(bot.ability == null, "the victim's held ability is gone");
        check(gb.abilityList[bot.id] == null, 'the stolen ability was removed from abilityList');
        check(stoleEvent != null && stoleEvent.victim === bot.id && stoleEvent.ability === BLIND, 'a magpieSteal event named the victim + the stolen ability');

        // --- DROP: a punch frees the loot onto the nearest drivable cell as an ability pad. ---
        // (handleHit's punch detection is covered in [A]; here we exercise the gameBoard
        // resolution + the cell repaint via the recorded drop request.)
        hz.dropRequest = true;
        events.length = 0;
        room.update(DT); clock += config.serverTickSpeed; fireDueTimers();
        let dropEvent = null;
        for (const e of events) { if (e.name === 'magpieDrop') { dropEvent = e.data; } }
        check(hz.loot === 0 && hz.netState === 0, 'after the punch the drone is empty again');
        check(dropEvent != null && dropEvent.ability === BLIND, 'a magpieDrop event carried the dropped ability');
        let paintedCell = null;
        for (const cell of gb.currentMap.cells) { if (cell.id === BLIND) { paintedCell = cell; break; } }
        check(paintedCell != null, 'the loot was painted onto a cell as a re-grabbable ability pad');
        check(dropEvent.voronoiId === (paintedCell && paintedCell.site.voronoiId), 'the drop event points at the painted cell');
        // FX rides the PAD location, not the drone (they differ when the drone is over lava/water).
        check(Math.abs(dropEvent.x - paintedCell.site.x) < 1e-6 && Math.abs(dropEvent.y - paintedCell.site.y) < 1e-6, 'the magpieDrop FX is positioned at the painted cell');
        // The painted cell's ORIGINAL terrain (a grass lane in this map) is recorded for restore.
        const originalTerrain = GRASS;

        // --- RE-GRAB: an empty-handed kart driving onto the pad picks it up (engine pickup). ---
        bot.ability = null; bot.acquiredAbility = null;
        // Keep the drone from re-stealing the re-grab: park it far away + on cooldown.
        hz.advance = function () { this.newX = -9999; this.newY = -9999; this.velX = 0; this.velY = 0; };
        hz.x = hz.newX = -9999; hz.y = hz.newY = -9999;
        const px = paintedCell.site.x, py = paintedCell.site.y;
        let regrabbed = false;
        for (let f = 0; f < 6 && !regrabbed; f++) {
            bot.x = bot.newX = px; bot.y = bot.newY = py; bot.velX = 0; bot.velY = 0;
            room.update(DT); clock += config.serverTickSpeed; fireDueTimers();
            if (bot.ability != null) { regrabbed = true; }
        }
        check(regrabbed, 'an empty-handed kart RE-GRABBED the dropped ability off the pad');
        check(paintedCell.id === originalTerrain, "the pad reverted to its ORIGINAL terrain (not plain normal) once picked up");

        // --- ARM DELAY: a re-grabbed magpie ability can't be fired for a brief window, so a
        // player still spam-punching the drone doesn't insta-fire it on pickup. ---
        check(bot.abilityReadyAt > clock, 'a re-grabbed magpie ability is ARMED with a use delay');
        bot.attack = true;
        bot.checkAttack(config.stateMap.racing);
        check(bot.ability != null && bot.ability.alive !== false, 'pressing attack DURING the arm window does not fire the re-grabbed ability');
        clock += MD.regrabArmMs + 50; // wait out the arm delay
        bot.attack = true;
        bot.checkAttack(config.stateMap.racing);
        check(bot.ability != null && bot.ability.alive === false, 'once armed, pressing attack fires it normally');

        // --- STAMINA DRAIN: an empty-handed kart contacting an empty drone loses stamina. ---
        bot.ability = null; bot.acquiredAbility = null;
        if (gb.abilityList[bot.id] != null) { delete gb.abilityList[bot.id]; }
        hz.loot = 0; hz.netState = 0; hz.nextStealTime = 0;
        hz.advance = function () { this.newX = RX; this.newY = RY; this.velX = 0; this.velY = 0; };
        hz.x = hz.newX = RX; hz.y = hz.newY = RY;
        bot.stamina = config.punchStamina.max;
        events.length = 0;
        let zapEvent = null;
        for (let f = 0; f < 4 && zapEvent == null; f++) {
            bot.x = bot.newX = RX; bot.y = bot.newY = RY; bot.velX = 0; bot.velY = 0;
            room.update(DT); clock += config.serverTickSpeed; fireDueTimers();
            for (const e of events) { if (e.name === 'magpieSteal') { zapEvent = e.data; } }
        }
        check(zapEvent != null && zapEvent.ability === null, 'an empty-handed kart triggers a stamina zap (magpieSteal, ability null)');
        check(bot.stamina <= config.punchStamina.max - MD.staminaSteal + 1e-6, 'the zap drained a stamina chunk (' + bot.stamina.toFixed(0) + ' / ' + config.punchStamina.max + ')');
        check(hz.loot === 0, 'a stamina zap leaves the drone empty (nothing to carry)');

        // --- NON-DROPPABLE ability (BombTrigger 103): NOT stolen, falls to the stamina zap
        // (Codex P1: a non-spawnable held ability has no pickup tile — stealing it would
        // strand a placed bomb + destroy the ability on drop). ---
        const BOMBTRIG = T.abilities.bombTrigger.id; // 103, spawnable:false
        check(gb.stealableAbilityIds()[BOMBTRIG] !== true, 'the BombTrigger is NOT a stealable ability id');
        check(gb.stealableAbilityIds()[BLIND] === true, 'a normal ability (blindfold) IS stealable');
        bot.ability = { id: BOMBTRIG };
        hz.loot = 0; hz.netState = 0; hz.nextStealTime = 0;
        bot.stamina = config.punchStamina.max;
        events.length = 0;
        let trigZap = null;
        for (let f = 0; f < 4 && trigZap == null; f++) {
            bot.x = bot.newX = RX; bot.y = bot.newY = RY; bot.velX = 0; bot.velY = 0;
            room.update(DT); clock += config.serverTickSpeed; fireDueTimers();
            for (const e of events) { if (e.name === 'magpieSteal') { trigZap = e.data; } }
        }
        check(hz.loot === 0 && bot.ability != null && bot.ability.id === BOMBTRIG, 'a BombTrigger is NOT carried off — the holder keeps it');
        check(trigZap != null && trigZap.ability === null, 'a BombTrigger holder gets the stamina zap instead');

        // --- DROP with no drivable cell keeps the loot (Codex P2: never vanish carried loot
        // when dropAbilityNear finds nowhere to paint). ---
        bot.ability = null;
        hz.loot = BLIND; hz.netState = BLIND; hz.nextStealTime = 0;
        const realDrop = gb.dropAbilityNear;
        gb.dropAbilityNear = function () { return null; };
        hz.dropRequest = true;
        events.length = 0;
        room.update(DT); clock += config.serverTickSpeed; fireDueTimers();
        gb.dropAbilityNear = realDrop;
        let droppedAnyway = false;
        for (const e of events) { if (e.name === 'magpieDrop') { droppedAnyway = true; } }
        check(hz.loot === BLIND && !droppedAnyway, 'a punch with nowhere to drop keeps the loot (no magpieDrop, still carrying)');
    }

    // ----------------------------------------------------------------------
    console.log('\n[D] Patrol covers the FULL rail at a steady pace (live loop)');
    {
        // A LONG horizontal rail — the drone must sweep its whole length (the bug fix: a
        // fixed step rate left a long rail barely covered). Anchor mid-map so the full rail
        // fits, then let the engine drive it (no pinning) and record the x range it covers.
        const RAILLEN = 500, AX = 300, AY = ROWS[1];
        const map = buildMap('patrol', [{ id: MD.id, x: AX, y: AY, angle: 0, railLength: RAILLEN }], [0, 1, 2]);
        const { room } = bootRoom('magpie-patrol', map, { id: 'pp', name: 'PP', title: '', skill: 0.5, aggression: 0.2, tempo: 0.5, risk: 0.3, focus: 'race' });
        const gb = room.game.gameBoard;
        const hz = gb.hazardList[Object.keys(gb.hazardList)[0]];
        check(hz.rail.width === RAILLEN, 'the drone built its long authored rail');
        let minX = Infinity, maxX = -Infinity;
        for (let f = 0; f < 400; f++) { // ~13s at 30Hz — several full sweeps at 160px/s
            room.update(DT); clock += config.serverTickSpeed; fireDueTimers();
            minX = Math.min(minX, hz.x); maxX = Math.max(maxX, hz.x);
        }
        const covered = maxX - minX;
        check(minX <= AX + 30, 'the drone returns near the rail anchor (t≈0)');
        check(maxX >= AX + RAILLEN - 30, 'the drone reaches the FAR end of the rail (t≈length)');
        check(covered >= RAILLEN * 0.9, 'the drone sweeps ≥90% of the full rail (' + Math.round(covered) + ' / ' + RAILLEN + 'px)');
    }
} finally {
    Date.now = realNow;
    Math.random = realRandom;
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
}

console.log('');
if (failures > 0) {
    console.log('Magpie-drone test FAILED with ' + failures + ' error(s).');
    process.exit(1);
}
console.log('Magpie-drone test passed.');
process.exit(0);
