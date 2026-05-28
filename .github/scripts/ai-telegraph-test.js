'use strict';

// Headless behaviour test for "AI telegraph reasoning": bots PREDICT an ability's
// effect and TIME its release for maximum impact instead of firing on the first
// plain range/armed gate. Exercises the REAL decision logic in
// server/aiController.js `decideAbility` (+ its targeting helpers) directly — no
// network, no browser — like punch-rework-test.js. The `armed`/`forced` gates are
// driven purely off nav.held + ctx.collapsing, so no mocked clock is needed here;
// the all-maps engine sweep is covered by smoke-test.js (run separately in CI).

const path = require('path');
const repoRoot = path.join(__dirname, '..', '..');
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));

// decideAbility emits room messages on fire (bombUsed/swapUsed/…) via messenger —
// give it a recording fake io so those calls don't throw and we can sanity-check.
const emitted = [];
const fakeIo = { to() { return { emit(ev) { emitted.push(ev); } }; }, sockets: { emit() { } } };
messenger.build(fakeIo);

const ai = require(path.join(repoRoot, 'server', 'aiController.js'));
const T = ai._test;
const AB = config.tileMap.abilities;
const LAVA = config.tileMap.lava.id;
const NORMAL = config.tileMap.normal.id;

let failures = 0;
function check(cond, msg) {
    if (cond) { console.log('  ok  - ' + msg); }
    else { failures++; console.log('::error::FAIL - ' + msg); }
}

// snap45 mirror so expected facings are computed the same way the engine snaps them.
function snap45(deg) { var d = Math.round(deg / 45) * 45; return ((d % 360) + 360) % 360; }
function bearing(fx, fy, tx, ty) { return snap45(Math.atan2(ty - fy, tx - fx) * 180 / Math.PI); }

// A coarse 50px grid of cells: a vertical LAVA band at x in [1400,1650], normal
// elsewhere, so isLavaAt()/lavaNear() resolve against real nearest-site geometry.
function buildMap() {
    const cells = [];
    let vid = 0;
    for (let x = 0; x <= 2100; x += 50) {
        for (let y = 0; y <= 1050; y += 50) {
            const id = (x >= 1400 && x <= 1650) ? LAVA : NORMAL;
            cells.push({ id, site: { x, y, voronoiId: vid++ } });
        }
    }
    return { cells };
}
const MAP = buildMap();
const GOAL = { x: 2000, y: 500 }; // farther right = closer to goal = "ahead" in the race

function player(id, x, y, opts) {
    opts = opts || {};
    return Object.assign({
        id, x, y, velX: 0, velY: 0, alive: true, reachedGoal: false,
        isSpectator: false, isAI: true
    }, opts);
}
// players: array of player objects -> dict keyed by id, plus the bot.
function ctxWith(players, over) {
    const dict = {};
    players.forEach(p => { dict[p.id] = p; });
    return Object.assign({
        players: dict, map: MAP, lavaId: LAVA, goalTiles: [{ x: 1900, y: 500 }],
        collapsing: false, projectileList: {}
    }, over);
}
function makeBot(x, y, over) {
    const b = player('bot', x, y, { isAI: true });
    b.ai = Object.assign({ abilityTempo: 1, goal: GOAL, focus: 'combat', bombFiredAt: 0 }, (over && over.ai) || {});
    b.targetDirX = (over && over.targetDirX != null) ? over.targetDirX : 1; // default heading +x (down-track)
    b.targetDirY = (over && over.targetDirY != null) ? over.targetDirY : 0;
    b.angle = -999; b.attack = false;
    return b;
}
// armed: held >= minHold (=2 at tempo 1); not forced (held < maxHold=30, not collapsing).
const ARMED = { held: 5, lavaAhead: false, sharpTurn: false, braking: false };
const HELD = { held: 1, lavaAhead: false, sharpTurn: false, braking: false }; // below minHold -> not armed
function decide(bot, ctx, abilityId, nav) {
    bot.angle = -999; bot.attack = false;
    T.decideAbility(bot, ctx, { id: abilityId }, Object.assign({}, nav));
}

try {
    // -----------------------------------------------------------------------
    console.log('\n[1] bomb fires AT a rival, not down-track');
    {
        const bot = makeBot(200, 500); // heading down-track (+x); down-track snap = 0
        const rival = player('r', 400, 300); // off-axis, in range (dist 283 < 340)
        const ctx = ctxWith([bot, rival]);
        decide(bot, ctx, AB.bomb.id, ARMED);
        check(bot.attack === true, 'armed bomb fires');
        check(bot.angle === bearing(200, 500, 400, 300), 'aims at the rival (' + bot.angle + ' = ' + bearing(200, 500, 400, 300) + ')');
        check(bot.angle !== snap45(0), 'NOT pointed down-track (down-track = ' + snap45(0) + ')');
    }

    // -----------------------------------------------------------------------
    console.log('\n[2] bomb targets the race LEADER (no cluster), not merely the nearest');
    {
        const bot = makeBot(200, 500);
        const leader = player('lead', 450, 500); // ahead (x larger -> closer to goal), dist 250
        const back = player('back', 100, 500);    // nearer (dist 100) but BEHIND
        const ctx = ctxWith([bot, leader, back]);
        decide(bot, ctx, AB.bomb.id, ARMED);
        check(bot.attack === true, 'fires');
        check(bot.angle === bearing(200, 500, 450, 500), 'aims at the LEADER (bearing 0), not the nearer rival behind (bearing 180)');
        check(bot.angle !== bearing(200, 500, 100, 500), 'did not just pick the closest body');
    }

    // -----------------------------------------------------------------------
    console.log('\n[3] bomb prefers a CLUSTER (catches 2+) over a lone leader');
    {
        const bot = makeBot(200, 500);
        const a = player('ca', 300, 750); // cluster pair (within blast 100 of each other)
        const b = player('cb', 330, 770);
        const lone = player('lead', 700, 500); // closer to goal but alone
        const ctx = ctxWith([bot, a, b, lone]);
        decide(bot, ctx, AB.bomb.id, ARMED);
        check(bot.attack === true, 'fires');
        const clusterAim = bearing(200, 500, 300, 750);
        check(bot.angle === clusterAim, 'aims at the cluster (' + bot.angle + ' = ' + clusterAim + ')');
        check(bot.angle !== bearing(200, 500, 700, 500), 'did NOT chase the lone leader (bearing 0) over the 2-body cluster');
    }

    // -----------------------------------------------------------------------
    console.log('\n[4] held bomb telegraphs (aims at preferred target) without firing');
    {
        const bot = makeBot(200, 500);
        const rival = player('r', 400, 300);
        const ctx = ctxWith([bot, rival]);
        decide(bot, ctx, AB.bomb.id, HELD); // below minHold -> not armed, not forced
        check(bot.attack === false, 'does NOT fire while still holding');
        check(bot.angle === bearing(200, 500, 400, 300), 'held bomb points at the rival (telegraph/intimidation)');
    }

    // -----------------------------------------------------------------------
    console.log('\n[5] iceCannon still aims along travel (own-lane), not at a rival');
    {
        const bot = makeBot(200, 500, { targetDirX: 1, targetDirY: 0 }); // travelling +x
        const rival = player('r', 500, 200); // ahead + off-axis (so bot is "behind")
        const ctx = ctxWith([bot, rival]);
        decide(bot, ctx, AB.iceCannon.id, ARMED);
        check(bot.attack === true, 'ice cannon fires while chasing on open runway');
        check(bot.angle === snap45(0), 'aims ALONG travel (' + bot.angle + '), not at the rival (' + bearing(200, 500, 500, 200) + ')');
    }

    // -----------------------------------------------------------------------
    console.log('\n[6] swap: targets the leader on safe ground; never force-fires while leading');
    {
        // 6a: behind, leader in range on safe (non-lava) ground -> steal.
        let bot = makeBot(200, 500);
        let leader = player('lead', 400, 500);   // ahead, dist 200 < SWAP_RANGE, normal ground
        let behind = player('back', 100, 500);
        let ctx = ctxWith([bot, leader, behind]);
        decide(bot, ctx, AB.swap.id, ARMED);
        check(bot.attack === true, 'swaps the in-range leader on safe ground');

        // 6b: leader is lava-adjacent -> hold (would land somewhere we'd die / be re-passed).
        bot = makeBot(1300, 500);
        leader = player('lead', 1380, 500);      // ahead, dist 80, but lava band starts at 1400
        ctx = ctxWith([bot, leader]);
        check(T.lavaNear(ctx, 1380, 500, 70) === true, 'leader ground reads as lava-adjacent');
        decide(bot, ctx, AB.swap.id, ARMED);
        check(bot.attack === false, 'does NOT steal onto lava-adjacent ground (not forced)');

        // 6c: bot is LEADING -> never force a random-target swap, even at collapse.
        bot = makeBot(1900, 500);                // closest to goal = rank 0
        const trailer = player('t', 1000, 500);
        ctx = ctxWith([bot, trailer], { collapsing: true }); // forced
        decide(bot, ctx, AB.swap.id, ARMED);
        check(bot.attack === false, 'never force-swaps while in the lead (even when forced)');
    }

    // -----------------------------------------------------------------------
    console.log('\n[7] blindfold: fire on a rival hazard-pinch; hold when the bot itself is pinched');
    {
        // 7a: human rival lava-adjacent + bot on open ground -> fire.
        let bot = makeBot(200, 500);
        let human = player('h', 1380, 500, { isAI: false }); // ahead + lava-adjacent
        let ctx = ctxWith([bot, human]);
        decide(bot, ctx, AB.blindfold.id, ARMED);
        check(bot.attack === true, 'blinds the room when a human is hugging lava and the bot is safe');

        // 7b: same rival pinch, but the BOT is in a pinch too -> hold (would blind itself badly).
        bot = makeBot(200, 500);
        ctx = ctxWith([bot, human]);
        decide(bot, ctx, AB.blindfold.id, { held: 5, lavaAhead: true, sharpTurn: false, braking: false });
        check(bot.attack === false, 'does NOT fire when the bot itself is in the hazard');

        // 7c: nobody in a pinch (all open ground, away from the goal) -> bank it.
        bot = makeBot(200, 500);
        const humanSafe = player('h', 500, 500, { isAI: false }); // open ground, far from goal tile
        ctx = ctxWith([bot, humanSafe]);
        decide(bot, ctx, AB.blindfold.id, ARMED);
        check(bot.attack === false, 'holds when no rival is in a hazard pinch');
    }

    // -----------------------------------------------------------------------
    console.log('\n[8] cut behaviour unchanged (regression guard)');
    {
        // 8a: out of CUT_RANGE -> hold, but the beam still points AT the nearest rival.
        let bot = makeBot(200, 500);
        let rival = player('r', 300, 350); // dist ~180 > CUT_RANGE (78)
        let ctx = ctxWith([bot, rival]);
        decide(bot, ctx, AB.cut.id, ARMED);
        check(bot.attack === false, 'held cut does not fire out of range');
        check(bot.angle === bearing(200, 500, 300, 350), 'held cut beam still aims at the nearest rival (telegraph)');

        // 8b: in range + armed -> fire, aiming along travel (shove perpendicular).
        bot = makeBot(200, 500, { targetDirX: 1, targetDirY: 0 });
        rival = player('r', 260, 500); // dist 60 < CUT_RANGE
        ctx = ctxWith([bot, rival]);
        decide(bot, ctx, AB.cut.id, ARMED);
        check(bot.attack === true, 'cut fires when a rival is in range');
        check(bot.angle === snap45(0), 'cut aims along travel when firing');
    }

    // -----------------------------------------------------------------------
    console.log('\n[9] speedDebuff times on an AHEAD-and-near rival, not just any near body');
    {
        // 9a: a rival ahead and within range -> fire (catch-up value).
        let bot = makeBot(500, 500);
        let ahead = player('a', 700, 500); // ahead (closer to goal), dist 200 < 340
        let ctx = ctxWith([bot, ahead]);
        decide(bot, ctx, AB.speedDebuff.id, ARMED);
        check(bot.attack === true, 'slows the field when an ahead rival is near');

        // 9b: the only NEAR rival is behind us; the ahead rival is far -> hold.
        bot = makeBot(500, 500);
        const nearBehind = player('b', 300, 500); // near (dist 200) but BEHIND
        const farAhead = player('f', 1900, 500);  // ahead but far (dist 1400 > 340)
        ctx = ctxWith([bot, nearBehind, farAhead]);
        decide(bot, ctx, AB.speedDebuff.id, ARMED);
        check(bot.attack === false, 'does NOT waste it on a rival who is already behind');
    }
} finally {
    // nothing to restore (no clock mock).
}

console.log('');
if (failures > 0) {
    console.log('AI-telegraph test FAILED with ' + failures + ' error(s).');
    process.exit(1);
}
console.log('AI-telegraph test passed.');
process.exit(0);
