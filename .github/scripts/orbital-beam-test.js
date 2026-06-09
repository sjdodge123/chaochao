'use strict';

// Headless test for the Orbital Beam ability (id 110).
//
// Boots the REAL server engine on a committed map via the editor preview path
// (like smoke-test.js Session B), arms a player with Orbital Beam, casts it down a
// line seeded with ice + sand, mocks the clock past the 5s fuse, and asserts the
// strike behaves: ice -> water, sand -> lava on the struck line; a kart standing in
// the line dies like lava; the broadcast tileChanges payload is well-formed; and the
// fresh water/lava adjacencies the beam manufactured get walled by rebuilt stone seams.
//
// Run: node .github/scripts/orbital-beam-test.js   (exit 1 on any failed assertion).

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const game = require(path.join(repoRoot, 'server', 'game.js'));
const engine = require(path.join(repoRoot, 'server', 'engine.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));

const DT = config.serverTickSpeed / 1000;
const OB = config.tileMap.abilities.orbitalBeam;
const ICE = config.tileMap.ice.id, WATER = config.tileMap.water.id;
const SAND = config.tileMap.slow.id, LAVA = config.tileMap.lava.id;

let failures = 0;
function fail(msg) { failures++; console.log('::error::' + msg); }
function ok(msg) { console.log('  ok - ' + msg); }
function check(cond, msg) { if (cond) { ok(msg); } else { fail(msg); } }

// Record every server->room broadcast so we can assert on the emitted payloads.
const events = [];
const fakeIo = {
    to() { return { emit(e, p) { events.push({ e: e, p: p }); } }; },
    sockets: { emit() { } }
};
messenger.build(fakeIo);

// --- geometry helpers (mirror the server's beam math) ---
function sideOf(ax, ay, bx, by, px, py) { return (bx - ax) * (py - ay) - (by - ay) * (px - ax); }
function neighborVoronoiIds(cell) {
    const ids = [];
    const hes = cell.halfedges;
    for (let h = 0; h < hes.length; h++) {
        const e = hes[h].edge;
        const nb = (e.lSite && e.lSite.voronoiId === cell.site.voronoiId) ? e.rSite : e.lSite;
        if (nb) { ids.push(nb.voronoiId); }
    }
    return ids;
}

function run() {
    // A real, reconstructable map gives the engine genuine voronoi geometry (halfedges)
    // so the rebuilt stone seams are exercised against real shared edges.
    let map = JSON.parse(fs.readFileSync(path.join(repoRoot, 'client', 'maps', 'Duality.json'), 'utf8'));
    if (mapFormat.isSitesOnly(map)) { map = mapFormat.reconstruct(map); }

    const sig = 'orbital-beam-test';
    const room = game.getRoom(sig, 4);
    room.game.gameBoard.isPreview = true;
    room.game.gameBoard.previewMap = map;

    const casterId = sig + '-caster';
    const victimId = sig + '-victim';
    for (const id of [casterId, victimId]) {
        const player = room.world.createNewPlayer(id);
        room.playerList[id] = player;
        room.game.determineGameState(player);
    }
    room.game.startLobby();
    room.game.startGated();
    room.game.startRace();

    const gb = room.game.gameBoard;
    const cells = gb.currentMap.cells;
    const caster = room.playerList[casterId];
    const victim = room.playerList[victimId];

    // Fire a thin horizontal beam east across mid-map.
    const ox = 40, oy = config.worldHeight / 2, angle = 0;
    caster.x = caster.newX = ox; caster.y = caster.newY = oy; caster.angle = angle;
    caster.currentState = config.stateMap.racing;

    const halfW = OB.beamWidth / 2;
    const inBeam = [];
    for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        const along = cell.site.x - ox;            // dir = (1,0)
        const across = cell.site.y - oy;           // perp = (0,1)
        if (along >= 0 && along <= OB.beamLength && across >= -halfW && across <= halfW) {
            inBeam.push(cell);
        }
    }
    check(inBeam.length >= 2, 'beam covers multiple cells (got ' + inBeam.length + ')');
    if (inBeam.length < 2) { return; }

    // Find an adjacent ice/sand pair INSIDE the beam so the strike makes water beside
    // lava (a fresh seam). Seed the rest of the strip alternating ice/sand for good measure.
    const beamSet = new Set(inBeam.map(c => c.site.voronoiId));
    const byVid = {};
    for (let i = 0; i < cells.length; i++) { byVid[cells[i].site.voronoiId] = cells[i]; }
    let iceCell = null, sandCell = null;
    for (let i = 0; i < inBeam.length && iceCell == null; i++) {
        const A = inBeam[i];
        const nbs = neighborVoronoiIds(A);
        for (let n = 0; n < nbs.length; n++) {
            if (beamSet.has(nbs[n]) && nbs[n] !== A.site.voronoiId) {
                iceCell = A; sandCell = byVid[nbs[n]]; break;
            }
        }
    }
    check(iceCell != null && sandCell != null, 'found an adjacent in-beam cell pair to seed');
    if (iceCell == null || sandCell == null) { return; }
    iceCell.id = ICE;
    sandCell.id = SAND;
    // Alternate-seed the remaining strip (skip the chosen pair) for extra coverage.
    let flip = 0;
    for (let i = 0; i < inBeam.length; i++) {
        const cell = inBeam[i];
        if (cell === iceCell || cell === sandCell) { continue; }
        cell.id = (flip++ % 2 === 0) ? ICE : SAND;
    }
    const iceVid = iceCell.site.voronoiId, sandVid = sandCell.site.voronoiId;

    // Park a fresh, vulnerable victim squarely in the beam line.
    victim.x = victim.newX = ox + 250; victim.y = victim.newY = oy;
    victim.velX = victim.velY = 0;
    victim.currentState = config.stateMap.racing;
    victim.alive = true; victim.isZombie = false;
    victim.invulnUntil = 0; victim.invulnHeldInCircle = false;
    victim.starPowerUntil = 0; victim.onFire = 0; victim.fireTimer = null;
    victim.onSanctuary = false;

    // Arm + cast Orbital Beam through the real ability flow.
    const { OrbitalBeam } = require(path.join(repoRoot, 'server', 'entities', 'abilities.js'));
    caster.ability = new OrbitalBeam(casterId, sig);
    gb.abilityList[casterId] = caster.ability;
    caster.ability.use(); // sets fireBeam

    // Install a controllable clock so we can advance past the 5s fuse without sleeping.
    // (A tight synchronous tick loop freezes wall-clock, so the setTimeout'd strike would
    //  otherwise never fire — see CLAUDE.md "Testing gameplay (headless)".)
    const realSetTimeout = global.setTimeout;
    const realNow = Date.now;
    let fakeNow = realNow();
    const timers = [];
    global.setTimeout = function (fn, ms) {
        const args = Array.prototype.slice.call(arguments, 2);
        timers.push({ fn: fn, at: fakeNow + (ms || 0), args: args });
        return timers.length;
    };
    Date.now = function () { return fakeNow; };
    function advanceClock(ms) {
        const target = fakeNow + ms;
        for (;;) {
            let idx = -1, soonest = Infinity;
            for (let i = 0; i < timers.length; i++) {
                if (timers[i] != null && timers[i].at <= target && timers[i].at < soonest) {
                    soonest = timers[i].at; idx = i;
                }
            }
            if (idx === -1) { break; }
            const t = timers[idx]; timers[idx] = null;
            fakeNow = t.at;
            t.fn.apply(null, t.args);
        }
        fakeNow = target;
    }

    let firedOk = true;
    try {
        // One tick runs checkAbilities -> startOrbitalBeam (broadcasts the cast + schedules
        // the strike on the mocked clock).
        room.update(DT);
        const cast = events.filter(ev => ev.e === 'orbitalBeamCast').pop();
        check(cast != null, 'broadcast orbitalBeamCast on cast');
        check(cast != null && cast.p && cast.p.duration === OB.fuse, 'cast telegraph carries the 5s fuse');

        events.length = 0; // only inspect post-strike broadcasts below
        advanceClock(OB.fuse + 200); // burn past the fuse -> fireOrbitalBeam runs
    } catch (e) {
        firedOk = false;
        fail('strike threw: ' + e.message + '\n' + e.stack);
    } finally {
        global.setTimeout = realSetTimeout;
        Date.now = realNow;
    }
    if (!firedOk) { return; }

    // --- assertions ---
    check(iceCell.id === WATER, 'ice on the struck line melted to water');
    check(sandCell.id === LAVA, 'sand on the struck line burned to lava');
    check(victim.alive === false, 'kart standing in the line died like lava');

    const fired = events.filter(ev => ev.e === 'orbitalBeamFired').pop();
    check(fired != null, 'broadcast orbitalBeamFired on strike');

    // tileChanges payload well-formed: a JSON object of voronoiId -> tile id, carrying our
    // seeded cells with their new ids.
    let tcOk = false;
    const tcs = events.filter(ev => ev.e === 'tileChanges');
    for (let i = 0; i < tcs.length; i++) {
        let payload;
        try { payload = JSON.parse(tcs[i].p); } catch (e) { continue; }
        if (payload == null || typeof payload !== 'object') { continue; }
        let allNums = true;
        for (const k in payload) { if (typeof payload[k] !== 'number') { allNums = false; break; } }
        if (allNums && payload[iceVid] === WATER && payload[sandVid] === LAVA) { tcOk = true; break; }
    }
    check(tcOk, 'tileChanges payload well-formed and carries the melted/burned cells');

    // Stone seams: the rebuilt index must wall a fresh water/lava adjacency the beam made.
    const seams = gb.currentMap._stoneEdges;
    check(Array.isArray(seams), 'stone-edge index rebuilt after the strike');
    let seam = null;
    if (Array.isArray(seams)) {
        for (let i = 0; i < seams.length; i++) {
            if (seams[i].waterCell.id === WATER && seams[i].lavaCell.id === LAVA) { seam = seams[i]; break; }
        }
    }
    check(seam != null, 'a fresh water/lava stone seam exists after the strike');
    if (seam != null) {
        // Step a player from the water side straight across the seam into the lava — the
        // stone wall must deflect it (bounced) and keep it on the water side.
        const mx = (seam.ax + seam.bx) / 2, my = (seam.ay + seam.by) / 2;
        const wpx = mx + (seam.waterCell.site.x - mx) * 0.15, wpy = my + (seam.waterCell.site.y - my) * 0.15;
        const lpx = mx + (seam.lavaCell.site.x - mx) * 0.15, lpy = my + (seam.lavaCell.site.y - my) * 0.15;
        const p = { x: wpx, y: wpy, newX: lpx, newY: lpy, velX: lpx - wpx, velY: lpy - wpy, bounced: false };
        engine.bounceOffStoneEdges(p, gb.currentMap);
        check(p.bounced === true, 'stepping across the new seam is walled (bounced)');
        const sStart = Math.sign(sideOf(seam.ax, seam.ay, seam.bx, seam.by, wpx, wpy));
        const sEnd = Math.sign(sideOf(seam.ax, seam.ay, seam.bx, seam.by, p.newX, p.newY));
        check(sStart === sEnd, 'walled step stayed on the water side (did not cross into lava)');
    }
}

try {
    run();
} catch (e) {
    fail('Unhandled exception: ' + e.message + '\n' + e.stack);
}

if (failures > 0) {
    console.log('\nOrbital Beam test FAILED with ' + failures + ' error(s).');
    process.exit(1);
}
console.log('\nOrbital Beam test passed.');
process.exit(0);
