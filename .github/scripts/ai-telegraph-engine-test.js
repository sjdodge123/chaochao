'use strict';

// Real-engine headless test for "AI telegraph reasoning". Unlike ai-telegraph-test.js
// (which calls decideAbility in isolation), this boots the REAL server modules, pins
// a map, forces the racing state, hands a bot a held ability, and drives the LIVE
// tick loop (room.update(dt)) — exactly like punch-rework-test.js / smoke-test.js.
// Date.now is mocked into a clock we advance per tick (a tight synchronous loop
// otherwise freezes wall-clock, so the held-ability "armed" floor never elapses), and
// the fake socket.io `io` RECORDS every emit so we can assert the ability actually
// fired end-to-end (bombUsed/spawnBomb, iceCannon/spawnSnowFlake, swapUsed,
// blindfoldUsed) and that the spawned projectile was aimed where we expect.

const fs = require('fs');
const path = require('path');
const repoRoot = path.join(__dirname, '..', '..');
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));
const abilities = require(path.join(repoRoot, 'server', 'entities', 'abilities.js'));

const LAVA = config.tileMap.lava.id;
const NORMAL = config.tileMap.normal.id;
const DT = config.serverTickSpeed / 1000;

let failures = 0;
function check(cond, msg) {
    if (cond) { console.log('  ok  - ' + msg); }
    else { failures++; console.log('::error::FAIL - ' + msg); }
}

// Recording fake io: every messageRoomBySig -> io.to(sig).emit(header,payload) lands here.
let recorded = [];
const fakeIo = { to() { return { emit(header, payload) { recorded.push({ header, payload }); } }; }, sockets: { emit() { } } };
messenger.build(fakeIo);

function snap45(deg) { var d = Math.round(deg / 45) * 45; return ((d % 360) + 360) % 360; }
function bearing(fx, fy, tx, ty) { return snap45(Math.atan2(ty - fy, tx - fx) * 180 / Math.PI); }
function mag(x, y) { return Math.sqrt(x * x + y * y); }

// Nearest-site tile id at (x,y) — same resolution isLavaAt() uses in the engine.
function tileIdAt(map, x, y) {
    let best = Infinity, id = -1;
    for (let i = 0; i < map.cells.length; i++) {
        const cl = map.cells[i];
        if (!cl || !cl.site) { continue; }
        const dx = cl.site.x - x, dy = cl.site.y - y, d = dx * dx + dy * dy;
        if (d < best) { best = d; id = cl.id; }
    }
    return id;
}
function lavaWithin(map, x, y, r) {
    if (tileIdAt(map, x, y) === LAVA) { return true; }
    for (let a = 0; a < 360; a += 45) {
        const rad = a * Math.PI / 180;
        if (tileIdAt(map, x + Math.cos(rad) * r, y + Math.sin(rad) * r) === LAVA) { return true; }
    }
    return false;
}

const realNow = Date.now;
let clock = 1000000;

// Boot a fresh room with `nBots` bots (+ optional human), pinned to `map`, in racing.
function bootRoom(sig, map, nBots, withHuman) {
    const game = require(path.join(repoRoot, 'server', 'game.js'));
    const room = game.getRoom(sig, 8);
    room.game.gameBoard.isPreview = true;
    room.game.gameBoard.previewMap = map;
    for (let i = 0; i < nBots; i++) {
        const bid = sig + '-bot' + i;
        const bot = room.world.createNewBot(bid, { id: 'tester' + i, name: 'T' + i, title: '', aggression: 0.6, skill: 0.8, tempo: 1, risk: 0.4, focus: 'combat' });
        room.playerList[bid] = bot;
        room.game.determineGameState(bot);
    }
    if (withHuman) {
        const hid = sig + '-human';
        const h = room.world.createNewPlayer(hid);
        h.roomSig = sig;
        room.playerList[hid] = h;
        room.game.determineGameState(h);
    }
    room.game.startLobby(); room.game.startGated(); room.game.startRace();
    return room;
}

// Find safe (open, non-lava) anchor cells on the map, plus a lava-adjacent one.
function findAnchors(map) {
    const open = [];     // normal cells with no lava within 200px (truly open)
    const lavaEdge = []; // normal cells WITH lava within 70px (a hazard pinch)
    for (let i = 0; i < map.cells.length; i++) {
        const cl = map.cells[i];
        if (!cl || !cl.site || cl.id !== NORMAL) { continue; }
        const p = { x: cl.site.x, y: cl.site.y };
        if (lavaWithin(map, p.x, p.y, 70)) { lavaEdge.push(p); }
        else if (!lavaWithin(map, p.x, p.y, 200)) { open.push(p); }
    }
    return { open, lavaEdge };
}

// Give a player a held ability instance + register it the way a tile pickup does.
function holdAbility(room, player, Ctor) {
    player.ability = new Ctor(player.id, player.roomSig);
    player.acquiredAbility = { mapID: null }; // registers into gameBoard.abilityList next updatePlayers
}

// Pin a player in place (zero drift) so the engine can't carry it off our test setup.
function pin(p, x, y) {
    p.x = x; p.y = y; p.newX = x; p.newY = y; p.velX = 0; p.velY = 0;
    p.alive = true; p.reachedGoal = false;
}

// Drive the live tick loop until `eventHeader` is recorded (or `maxTicks`), re-pinning
// `pins` (array of {p,x,y}) every tick and advancing the mocked clock one tick. Returns
// the recorded entry for eventHeader, or null.
function tickUntil(room, pins, eventHeader, maxTicks) {
    for (let f = 0; f < maxTicks; f++) {
        pins.forEach(q => pin(q.p, q.x, q.y));
        room.update(DT);
        clock += config.serverTickSpeed;
        const hit = recorded.find(r => r.header === eventHeader);
        if (hit) { return hit; }
    }
    return null;
}

try {
    Date.now = () => clock;

    const mapsDir = path.join(repoRoot, 'client', 'maps');
    const file = fs.readdirSync(mapsDir).filter(f => f.endsWith('.json'))[0];
    const map = mapFormat.hydrate(JSON.parse(fs.readFileSync(path.join(mapsDir, file), 'utf8')));
    const anchors = findAnchors(map);
    console.log('Map: ' + file + ' — open anchors: ' + anchors.open.length + ', lava-edge anchors: ' + anchors.lavaEdge.length);

    // ----------------------------------------------------------------------
    console.log('\n[A] held bomb fires AT a rival (live tick + recorded emit)');
    {
        const room = bootRoom('tg-bomb', map, 2, false);
        const bots = Object.values(room.playerList);
        const bot = bots[0], rival = bots[1];
        const A = anchors.open[0];
        // Rival placed off to the side, in throw range (< 340), away from lava.
        let R = { x: A.x, y: A.y + 250 };
        if (lavaWithin(map, R.x, R.y, 30)) { R = { x: A.x + 250, y: A.y }; }
        holdAbility(room, bot, abilities.Bomb);
        recorded = [];
        const used = tickUntil(room, [{ p: bot, x: A.x, y: A.y }, { p: rival, x: R.x, y: R.y }], 'spawnBomb', 150);
        check(used != null, 'a held bomb actually fired (spawnBomb emitted)');
        check(recorded.some(r => r.header === 'bombUsed'), 'bombUsed emitted through the real ability.use()');
        const proj = room.game.gameBoard.projectileList[bot.id];
        const expectAtRival = bearing(A.x, A.y, R.x, R.y);
        const travelSnap = snap45(Math.atan2(bot.targetDirY, bot.targetDirX) * 180 / Math.PI);
        check(proj != null && proj.type === 'bomb', 'a bomb projectile was spawned');
        check(proj != null && proj.angle === expectAtRival, 'bomb is aimed AT the rival (angle ' + (proj && proj.angle) + ' = ' + expectAtRival + ')');
        if (expectAtRival !== travelSnap) {
            check(proj != null && proj.angle !== travelSnap, 'bomb is NOT lobbed down our own travel lane (travel ' + travelSnap + ')');
        } else {
            console.log('  ..  - (rival happened to lie on the travel lane; down-track contrast skipped)');
        }
    }

    // ----------------------------------------------------------------------
    console.log('\n[B] iceCannon still aims along TRAVEL, not at a rival');
    {
        const room = bootRoom('tg-ice', map, 2, false);
        const bots = Object.values(room.playerList);
        const bot = bots[0], rival = bots[1];
        const A = anchors.open[1] || anchors.open[0];
        holdAbility(room, bot, abilities.IceCannon);
        // First learn our goal heading, then place the rival AHEAD (closer to goal) but
        // laterally off the travel line so "aims along travel" is distinguishable.
        pin(bot, A.x, A.y); pin(rival, A.x + 200, A.y + 200);
        room.update(DT); clock += config.serverTickSpeed;
        const goal = bot.ai.goal || { x: A.x + 1000, y: A.y };
        let gx = goal.x - A.x, gy = goal.y - A.y; const gm = mag(gx, gy) || 1; gx /= gm; gy /= gm;
        const perpx = -gy, perpy = gx;
        // a bit toward the goal (so rival ranks ahead) + a big lateral offset.
        let R = { x: A.x + gx * 90 + perpx * 250, y: A.y + gy * 90 + perpy * 250 };
        if (lavaWithin(map, R.x, R.y, 30)) { R = { x: A.x + gx * 90 - perpx * 250, y: A.y + gy * 90 - perpy * 250 }; }
        recorded = [];
        const used = tickUntil(room, [{ p: bot, x: A.x, y: A.y }, { p: rival, x: R.x, y: R.y }], 'spawnSnowFlake', 150);
        check(used != null, 'ice cannon fired while chasing on open runway (spawnSnowFlake emitted)');
        check(recorded.some(r => r.header === 'iceCannon'), 'iceCannon emitted through the real ability.use()');
        const proj = room.game.gameBoard.projectileList[bot.id];
        const travelSnap = snap45(Math.atan2(bot.targetDirY, bot.targetDirX) * 180 / Math.PI);
        const atRival = bearing(A.x, A.y, R.x, R.y);
        check(proj != null && proj.type === 'snowFlake', 'a snowflake projectile was spawned');
        check(proj != null && proj.angle === travelSnap, 'snowflake aims ALONG travel (angle ' + (proj && proj.angle) + ' = ' + travelSnap + ')');
        if (atRival !== travelSnap) {
            check(proj != null && proj.angle !== atRival, 'snowflake does NOT aim at the rival (rival bearing ' + atRival + ')');
        } else {
            console.log('  ..  - (travel lane happened to point at the rival; contrast skipped)');
        }
    }

    // ----------------------------------------------------------------------
    console.log('\n[C] swap: fires on the leader when behind; never force-fires while leading');
    {
        // C1 — behind, leader in range on safe ground -> swapUsed.
        const room = bootRoom('tg-swap1', map, 2, false);
        const bots = Object.values(room.playerList);
        const bot = bots[0], leader = bots[1];
        const A = anchors.open[0];
        pin(bot, A.x, A.y); pin(leader, A.x + 150, A.y); room.update(DT); clock += config.serverTickSpeed;
        const goal = bot.ai.goal || { x: A.x + 1000, y: A.y };
        let gx = goal.x - A.x, gy = goal.y - A.y; const gm = mag(gx, gy) || 1; gx /= gm; gy /= gm;
        // Leader ahead (toward goal), within SWAP_RANGE (280), on open ground.
        let L = { x: A.x + gx * 180, y: A.y + gy * 180 };
        if (lavaWithin(map, L.x, L.y, 70)) { L = { x: A.x + gx * 140, y: A.y + gy * 140 }; }
        holdAbility(room, bot, abilities.Swap);
        recorded = [];
        const used = tickUntil(room, [{ p: bot, x: A.x, y: A.y }, { p: leader, x: L.x, y: L.y }], 'swapUsed', 150);
        check(used != null, 'swap fires when behind with the leader in range on safe ground');

        // C2 — bot is LEADING and the round is collapsing (forced): must NEVER swap.
        const room2 = bootRoom('tg-swap2', map, 2, false);
        const b2 = Object.values(room2.playerList);
        const lead = b2[0], trail = b2[1];
        const A2 = anchors.open[0];
        pin(lead, A2.x, A2.y); pin(trail, A2.x + 100, A2.y); room2.update(DT); clock += config.serverTickSpeed;
        const goal2 = lead.ai.goal || { x: A2.x + 1000, y: A2.y };
        let g2x = goal2.x - A2.x, g2y = goal2.y - A2.y; const g2m = mag(g2x, g2y) || 1; g2x /= g2m; g2y /= g2m;
        // Put the LEADER (our bot) closest to the goal; the trailer behind it.
        const leadPos = { x: A2.x + g2x * 120, y: A2.y + g2y * 120 };
        const trailPos = { x: A2.x - g2x * 120, y: A2.y - g2y * 120 };
        const safeLead = !lavaWithin(map, leadPos.x, leadPos.y, 40) && !lavaWithin(map, trailPos.x, trailPos.y, 40);
        holdAbility(room2, lead, abilities.Swap);
        room2.game.startCollapse(goal2.x, goal2.y); // force the "use it or lose it" path
        recorded = [];
        tickUntil(room2, [{ p: lead, x: leadPos.x, y: leadPos.y }, { p: trail, x: trailPos.x, y: trailPos.y }], '__never__', 25);
        if (safeLead) {
            check(!recorded.some(r => r.header === 'swapUsed'), 'a leading bot NEVER force-swaps (no swapUsed even at collapse)');
        } else {
            console.log('  ..  - (could not place a safe leading pair clear of the collapse; skipped)');
        }
    }

    // ----------------------------------------------------------------------
    console.log('\n[D] blindfold fires when a human is in a lava pinch and the bot is on open ground');
    {
        if (anchors.lavaEdge.length === 0 || anchors.open.length === 0) {
            console.log('  ..  - (map has no lava-edge cell to stage the pinch; skipped)');
        } else {
            const room = bootRoom('tg-blind', map, 1, true);
            const all = Object.values(room.playerList);
            const bot = all.find(p => p.isAI);
            const human = all.find(p => !p.isAI);
            const A = anchors.open[0];
            pin(bot, A.x, A.y); pin(human, anchors.lavaEdge[0].x, anchors.lavaEdge[0].y);
            room.update(DT); clock += config.serverTickSpeed;
            // Ensure the human ranks AHEAD of the bot (so rank>=1): pick the bot anchor
            // farthest from the bot's goal among open cells, vs the human's lava-edge cell.
            const goal = bot.ai.goal;
            let H = anchors.lavaEdge[0];
            let Ba = A;
            if (goal != null) {
                const hGoal = mag(goal.x - H.x, goal.y - H.y);
                // choose an open anchor that is farther from goal than the human (bot behind)
                let chosen = null;
                for (const o of anchors.open) {
                    if (!lavaWithin(map, o.x, o.y, 200) && mag(goal.x - o.x, goal.y - o.y) > hGoal + 50) { chosen = o; break; }
                }
                if (chosen) { Ba = chosen; }
            }
            holdAbility(room, bot, abilities.Blindfold);
            recorded = [];
            const used = tickUntil(room, [{ p: bot, x: Ba.x, y: Ba.y }, { p: human, x: H.x, y: H.y }], 'blindfoldUsed', 150);
            check(used != null, 'blindfold fires when a human is hugging lava and the bot is safe & behind');
        }
    }
} finally {
    Date.now = realNow;
}

console.log('');
if (failures > 0) {
    console.log('AI-telegraph engine test FAILED with ' + failures + ' error(s).');
    process.exit(1);
}
console.log('AI-telegraph engine test passed.');
process.exit(0);
