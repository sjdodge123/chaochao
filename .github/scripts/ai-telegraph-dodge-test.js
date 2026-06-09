'use strict';

// Headless test: AI steers OUT of telegraphed strike zones (Orbital Beam line +
// lava-explosion aimer) during the warn-up, instead of standing in ground about to
// turn deadly. Two layers:
//   1. Unit — telegraphRepulsion (pure) pushes perpendicular out of a beam band and
//      radially out of an explosion circle, with the right sign / zero outside.
//   2. Engine — boot a real room, drop a beam band across a pinned bot, run the live
//      AI tick, and assert the bot's steering gains an out-of-band component vs an
//      identical run with no telegraph.

const path = require('path');
const fs = require('fs');
const repoRoot = path.join(__dirname, '..', '..');
const ai = require(path.join(repoRoot, 'server', 'aiController.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));

const DT = config.serverTickSpeed / 1000;
const NORMAL = config.tileMap.normal.id;
const LAVA = config.tileMap.lava.id;

let failures = 0;
function check(cond, msg) {
    if (cond) { console.log('  ok  - ' + msg); }
    else { failures++; console.log('::error::FAIL - ' + msg); }
}

const fakeIo = { to() { return { emit() { } }; }, sockets: { emit() { } } };
messenger.build(fakeIo);

const telegraphRepulsion = ai._test.telegraphRepulsion;

// ---------------------------------------------------------------------------
// 1. Unit: telegraphRepulsion sign / span / immunity
// ---------------------------------------------------------------------------
function unitTests() {
    // Horizontal beam centerline through (0,0): dir=(1,0), perp=(0,1), halfWidth 37.
    const beam = { kind: 'beam', ownerId: 'caster', x: 0, y: 0, dirX: 1, dirY: 0, length: 800, halfWidth: 37 };

    // A kart 10px to the +y side, mid-span: pushed further +y (out the near edge).
    let r = telegraphRepulsion({ id: 'b', x: 200, y: 10 }, [beam]);
    check(r.y > 0 && Math.abs(r.y) > Math.abs(r.x), 'beam pushes a +side kart further +y (out of band)');

    // A kart 10px to the -y side: pushed -y.
    r = telegraphRepulsion({ id: 'b', x: 200, y: -10 }, [beam]);
    check(r.y < 0 && Math.abs(r.y) > Math.abs(r.x), 'beam pushes a -side kart further -y (out of band)');

    // Dead-center is pushed harder than the band edge (depth ramps the strength).
    const center = telegraphRepulsion({ id: 'b', x: 200, y: 0 }, [beam]);
    const edge = telegraphRepulsion({ id: 'b', x: 200, y: 30 }, [beam]);
    check(Math.abs(center.y) > Math.abs(edge.y), 'beam push is stronger dead-center than near the edge');

    // Outside the band (across well past halfWidth+margin): no push.
    r = telegraphRepulsion({ id: 'b', x: 200, y: 300 }, [beam]);
    check(r.x === 0 && r.y === 0, 'kart clear of the band gets no push');

    // Beyond the beam length: no push.
    r = telegraphRepulsion({ id: 'b', x: 2000, y: 10 }, [beam]);
    check(r.x === 0 && r.y === 0, 'kart beyond the beam length gets no push');

    // The caster is NOT exempt from its own beam, so it dodges it just like anyone else.
    r = telegraphRepulsion({ id: 'caster', x: 200, y: 10 }, [beam]);
    check(r.y > 0 && Math.abs(r.y) > Math.abs(r.x), 'the caster also dodges its own beam (no self-exemption)');

    // Circle (lava-explosion aimer) at (0,0), radius 100: a kart at (40,0) is pushed +x away.
    const circle = { kind: 'circle', ownerId: 'x', x: 0, y: 0, radius: 100 };
    r = telegraphRepulsion({ id: 'b', x: 40, y: 0 }, [circle]);
    check(r.x > 0 && Math.abs(r.x) > Math.abs(r.y), 'explosion circle pushes a kart radially away from center');
    r = telegraphRepulsion({ id: 'b', x: 300, y: 0 }, [circle]);
    check(r.x === 0 && r.y === 0, 'kart outside the explosion circle gets no push');
}

// ---------------------------------------------------------------------------
// 2. Engine: a beam band across a pinned bot bends its steering out of the band
// ---------------------------------------------------------------------------
function findOpenCell(map) {
    function lavaWithin(x, y, rad) {
        for (let a = 0; a < 360; a += 30) {
            const px = x + Math.cos(a * Math.PI / 180) * rad, py = y + Math.sin(a * Math.PI / 180) * rad;
            let best = Infinity, id = -1;
            for (let i = 0; i < map.cells.length; i++) {
                const cl = map.cells[i]; if (!cl || !cl.site) continue;
                const dx = cl.site.x - px, dy = cl.site.y - py, d = dx * dx + dy * dy;
                if (d < best) { best = d; id = cl.id; }
            }
            if (id === LAVA) return true;
        }
        return false;
    }
    for (let i = 0; i < map.cells.length; i++) {
        const cl = map.cells[i];
        if (!cl || !cl.site || cl.id !== NORMAL) continue;
        if (!lavaWithin(cl.site.x, cl.site.y, 160)) { return { x: cl.site.x, y: cl.site.y }; }
    }
    return null;
}

function bootBot(sig, map) {
    const game = require(path.join(repoRoot, 'server', 'game.js'));
    const room = game.getRoom(sig, 8);
    room.game.gameBoard.isPreview = true;
    room.game.gameBoard.previewMap = map;
    const bid = sig + '-bot';
    const bot = room.world.createNewBot(bid, { id: 't', name: 'T', title: '', aggression: 0.5, skill: 0.8, tempo: 1, risk: 0.4, focus: 'race' });
    room.playerList[bid] = bot;
    room.game.determineGameState(bot);
    room.game.startLobby(); room.game.startGated(); room.game.startRace();
    return { room, bot };
}

function steerY(map, withBeam) {
    // Fresh room each run so AI smoothing/state can't leak between control + test.
    const sig = 'tg-dodge-' + (withBeam ? 'beam' : 'ctrl');
    const { room, bot } = bootBot(sig, map);
    const gb = room.game.gameBoard;
    const cell = findOpenCell(gb.currentMap);
    if (cell == null) { return null; }
    bot.x = bot.newX = cell.x; bot.y = bot.newY = cell.y; bot.velX = bot.velY = 0;
    bot.alive = true; bot.reachedGoal = false;
    if (withBeam) {
        // Horizontal beam whose centerline runs through the bot (across = 0), so the
        // dodge is a clean perpendicular (+y) push.
        gb.pendingBeams['someone'] = {
            ownerId: 'someone', x: cell.x - 120, y: cell.y, dirX: 1, dirY: 0,
            length: 1200, halfWidth: config.tileMap.abilities.orbitalBeam.beamWidth / 2,
            fireAt: Date.now() + 5000
        };
    }
    ai.update(gb, config.stateMap.racing, DT);
    return { ty: bot.targetDirY, tx: bot.targetDirX };
}

function engineTest() {
    const mapsDir = path.join(repoRoot, 'client', 'maps');
    const file = fs.readdirSync(mapsDir).find(f => f.endsWith('.json'));
    let map = JSON.parse(fs.readFileSync(path.join(mapsDir, file), 'utf8'));
    if (mapFormat.isSitesOnly(map)) { map = mapFormat.reconstruct(map); }

    const ctrl = steerY(map, false);
    const beam = steerY(map, true);
    check(ctrl != null && beam != null, 'found an open cell to anchor the bot for the dodge test');
    if (ctrl == null || beam == null) { return; }
    // The beam adds a +y (out-of-band) component, so the steering tilts further +y than
    // the identical no-telegraph run.
    check(beam.ty > ctrl.ty + 0.15, 'bot steers further out of the band when a beam telegraph is present (' + ctrl.ty.toFixed(3) + ' -> ' + beam.ty.toFixed(3) + ')');
}

unitTests();
engineTest();

if (failures > 0) {
    console.log('\nAI telegraph-dodge test FAILED with ' + failures + ' error(s).');
    process.exit(1);
}
console.log('\nAI telegraph-dodge test passed.');
process.exit(0);
