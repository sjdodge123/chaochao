// AI racer brain (Phase 3 — base racing).
//
// Runs once per server tick, BEFORE engine.updatePlayers (called from
// GameBoard.update). For each alive bot it writes the exact Player fields the
// socket handlers would have written for a human:
//   targetDirX, targetDirY  unit steering vector (engine.js isAI branch reads
//                            them as the movement axis, scaled by .8)
//   braking                  true to bleed speed into a sharp turn
//   angle                    heading in degrees (facing; used by directional
//                            abilities in Phase 4)
//
// Navigation is pure-pursuit over the Phase 0 cell graph: A* (Dijkstra) to the
// nearest reachable goal, then chase a "carrot" point a fixed look-ahead
// distance along the path so a momentum car tracks the cell-center polyline
// without wiggling. Collapsed/about-to-collapse cells are blocked so bots flee
// the lava, and bumpers/moving-bumpers (hazardList) are dodged with local
// repulsion steering.

var c = require('./config.json');
var cellGraph = require('./cellGraph.js');

// --- Tunables (Phase 6 will fold per-personality/difficulty scaling on top) ---
// In-race speeds are drag-limited and modest (~40/s normal .. ~78/s fast — the
// gate's +500 boost is zeroed when racing starts), so brake thresholds are set
// to those real speeds, not the 500 velocity cap.
var REPATH_INTERVAL = 0.3;      // seconds between A* re-paths per bot
var ARRIVE_RADIUS = 26;         // px: treat a waypoint as reached within this
var LOOKAHEAD = 60;             // px: carrot distance ahead along the path
var TURN_BRAKE_COS = 0.45;      // brake when the upcoming bend is sharper than this (cos)
var BRAKE_SPEED_MIN = 30;       // only brake for turns/lava when moving faster than this
var HAZARD_AVOID_RADIUS = 58;   // px: start steering away from a bumper within this
var HAZARD_AVOID_STRENGTH = 1.7;// weight of hazard repulsion vs desired heading
var COLLAPSE_DANGER_MARGIN = 55;// px: also block cells this close to the lava front
var LAVA_AVOID_RADIUS = 70;     // px: soft repulsion from a lava cell center within this
var LAVA_AVOID_STRENGTH = 2.2;  // weight of the soft lava field
var FEELER_BASE = 34;           // px: shortest predictive feeler reach
var FEELER_SPEED_K = 0.7;       // feeler grows with speed (stopping-distance proxy)
var FEELER_MAX = 120;           // px: cap feeler reach
var FEELER_SIDE_DEG = 32;       // angle of the two side feelers off the heading
var FEELER_AVOID_STRENGTH = 3.0;// weight of the predictive feeler push (strongest)

function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

// Initialise a bot's brain state from its personality profile (config cast entry)
// plus a small per-race skill jitter so the same character isn't identical every
// race. Falls back to a competent generalist when no profile is given.
function newBotState(profile) {
    profile = profile || {};
    var pick = function (k, d) { return profile[k] != null ? profile[k] : d; };
    var jitter = (Math.random() - 0.5) * 0.12; // ±0.06
    return {
        repathTimer: 0,
        path: null,        // [voronoiId...]
        waypoints: null,   // [{x,y}...]
        wpIndex: 0,
        goal: null,        // {x,y} of the targeted goal
        bombFiredAt: 0,    // ms timestamp the bot threw its current bomb
        blindDrift: 0,     // deg: vision-handicap steering error (random walk)
        wander: 0,         // deg: skill-based steering imprecision (random walk)
        offUntil: 0,       // ms: end of a transient "off moment" (skill dip)
        combatUntil: 0,    // ms: end of the current offensive-punch burst
        combatRestUntil: 0,// ms: earliest a new combat burst may start (refractory)
        gateY: null,       // gated-phase vertical jockey target
        heldAbilityId: null,// which ability the bot is currently holding
        abilityHeldSince: 0,// ms: when it picked up the held ability (hold-timeout)
        pathSeed: 1 + Math.floor(Math.random() * 1e9), // per-bot route-diversity seed
        // Personality knobs (0..1 unless noted).
        skill: clamp01(pick('skill', 0.7) + jitter), // speed + precision + reaction
        aggression: clamp01(pick('aggression', 0.5)),// punch willingness
        abilityTempo: clamp01(pick('tempo', 0.5)),    // spend vs hoard abilities
        risk: clamp01(pick('risk', 0.4)),             // how tight to the lava (corner-cut)
        focus: pick('focus', 'race'),                 // race|combat|human|chaos
        tilt: pick('tilt', null)                      // 'rage' = reckless when behind
    };
}

function mag(x, y) { return Math.sqrt(x * x + y * y); }

// Build a voronoiId -> {x,y} site lookup once per tick (shared across bots).
function buildSiteIndex(map) {
    var idx = {};
    var cells = map.cells;
    for (var i = 0; i < cells.length; i++) {
        if (cells[i] && cells[i].site) {
            idx[cells[i].site.voronoiId] = { x: cells[i].site.x, y: cells[i].site.y };
        }
    }
    return idx;
}

// Cells already lava or about to be (within COLLAPSE_DANGER_MARGIN of the front)
// during a collapse, returned as a Set of voronoiIds for findPathToNearestGoal's
// `blocked` option. Lava cells are blocked by the graph already; this adds the
// soon-to-flip ring so a bot doesn't path into cells the lava is about to claim.
function collapseDangerSet(ctx) {
    if (!ctx.collapsing || ctx.collapseLoc == null || ctx.collapseLine == null) {
        return null;
    }
    var blocked = new Set();
    var cells = ctx.map.cells;
    var GOAL = c.tileMap.goal.id;
    var threshold = ctx.collapseLine - COLLAPSE_DANGER_MARGIN;
    for (var i = 0; i < cells.length; i++) {
        if (!cells[i] || !cells[i].site || cells[i].id === GOAL) { continue; }
        var d = mag(ctx.collapseLoc.x - cells[i].site.x, ctx.collapseLoc.y - cells[i].site.y);
        // collapseMap turns a cell to lava once collapseLine < d; block the ring
        // just inside that so the bot keeps clear of the advancing edge.
        if (d > threshold) {
            blocked.add(cells[i].site.voronoiId);
        }
    }
    return blocked;
}

// Carrot point: walk LOOKAHEAD px along the waypoint polyline starting from the
// bot's position, so steering aims at a smoothed point ahead instead of snapping
// to the next cell center (which makes a momentum car oscillate).
function carrotPoint(bot, waypoints, startIndex) {
    var remaining = LOOKAHEAD;
    var curX = bot.x, curY = bot.y;
    var i = startIndex;
    var last = waypoints.length - 1;
    if (i > last) { return { x: waypoints[last].x, y: waypoints[last].y }; }
    while (i <= last) {
        var wp = waypoints[i];
        var dx = wp.x - curX, dy = wp.y - curY;
        var segLen = mag(dx, dy);
        if (segLen >= remaining) {
            var t = remaining / (segLen || 1);
            return { x: curX + dx * t, y: curY + dy * t };
        }
        remaining -= segLen;
        curX = wp.x; curY = wp.y;
        i++;
    }
    return { x: waypoints[last].x, y: waypoints[last].y };
}

// Sum of repulsion away from nearby bumpers/moving bumpers, scaled so it ramps
// up sharply as the bot closes on a hazard's strike range. Returns {x,y} (may be
// {0,0} when clear).
function hazardRepulsion(bot, hazardList) {
    var rx = 0, ry = 0;
    for (var id in hazardList) {
        var h = hazardList[id];
        if (h.alive === false) { continue; }
        var dx = bot.x - h.x, dy = bot.y - h.y;
        var d = mag(dx, dy);
        var range = HAZARD_AVOID_RADIUS + (h.radius || 0);
        if (d > 0 && d < range) {
            var w = (range - d) / range; // 0 at edge -> 1 at center
            w = w * w;                   // ramp harder up close
            rx += (dx / d) * w;
            ry += (dy / d) * w;
        }
    }
    return { x: rx, y: ry };
}

// Sum of repulsion away from nearby lava cell centers. Lava is instant death, so
// the path routes around it (graph-blocked) but a momentum car still cuts corners
// into it — this field pushes the bot back toward the safe side of a lava edge.
function lavaRepulsion(bot, lavaCells) {
    var rx = 0, ry = 0;
    for (var i = 0; i < lavaCells.length; i++) {
        var l = lavaCells[i];
        var dx = bot.x - l.x, dy = bot.y - l.y;
        var d = mag(dx, dy);
        if (d > 0 && d < LAVA_AVOID_RADIUS) {
            var w = (LAVA_AVOID_RADIUS - d) / LAVA_AVOID_RADIUS;
            w = w * w;
            rx += (dx / d) * w;
            ry += (dy / d) * w;
        }
    }
    return { x: rx, y: ry };
}

// True if the Voronoi cell containing (x,y) — the nearest site — is lava. Used by
// the predictive feelers to catch a momentum car about to slide off the path.
function isLavaAt(ctx, x, y) {
    var cells = ctx.map.cells;
    var best = Infinity, bestId = -1;
    for (var i = 0; i < cells.length; i++) {
        if (!cells[i] || !cells[i].site) { continue; }
        var s = cells[i].site;
        var dx = s.x - x, dy = s.y - y;
        var d = dx * dx + dy * dy;
        if (d < best) { best = d; bestId = cells[i].id; }
    }
    return bestId === ctx.lavaId;
}

function rotate(x, y, deg) {
    var r = deg * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
    return { x: x * cs - y * sn, y: x * sn + y * cs };
}

// Predictive avoidance: cast three feelers ahead along the bot's heading (center
// + two sides). If a feeler lands on lava, push perpendicular toward the clear
// side and flag a hard brake. Returns { x, y, brake } where x/y is a steer push.
function feelerAvoid(bot, ctx, headX, headY, speed) {
    var reach = FEELER_BASE + speed * FEELER_SPEED_K;
    // Lightning round speeds everyone up — look farther ahead to keep control.
    if (ctx.lightning) { reach *= LIGHTNING_FEELER_MULT; }
    var cap = FEELER_MAX * (ctx.lightning ? LIGHTNING_FEELER_MULT : 1);
    if (reach > cap) { reach = cap; }
    // Risk: high-risk personalities use shorter feelers, cutting closer to lava.
    if (ctx.riskMult != null) { reach *= ctx.riskMult; }
    var px = 0, py = 0, brake = false;
    // Center feeler — straight ahead.
    if (isLavaAt(ctx, bot.x + headX * reach, bot.y + headY * reach)) {
        brake = true;
    }
    // Side feelers, slightly shorter. Lava on one side pushes toward the other.
    var sd = reach * 0.8;
    var lDir = rotate(headX, headY, FEELER_SIDE_DEG);
    var rDir = rotate(headX, headY, -FEELER_SIDE_DEG);
    var lLava = isLavaAt(ctx, bot.x + lDir.x * sd, bot.y + lDir.y * sd);
    var rLava = isLavaAt(ctx, bot.x + rDir.x * sd, bot.y + rDir.y * sd);
    // Perpendicular to heading: right = (headY, -headX), left = (-headY, headX).
    if (lLava && !rLava) { px += headY; py += -headX; }        // push right
    else if (rLava && !lLava) { px += -headY; py += headX; }   // push left
    else if (lLava && rLava) { brake = true; }                 // boxed in — slow down
    if (brake && !(lLava || rLava)) { /* only center lava: rely on carrot + brake */ }
    return { x: px, y: py, brake: brake };
}

// --- Phase 4: combat + ability tunables ---
var SHOVE_PROBE = 42;       // px past a rival to check for lava (punch shoves them away from us)
var BOMB_THROW_RANGE = 340; // px: throw a bomb at a rival within this
var SWAP_RANGE = 280;       // px: only swap with a rival this near (and only when behind)
var CUT_RANGE = 78;         // px: cut when a rival is this close
var BOMB_MAX_HOLD = 2.6;    // s: detonate before the bomb's 3s auto-expire

// --- Phase 5: brutal-round tunables ---
var BLIND_DRIFT_STEP = 7;       // deg/tick random-walk of the blind steering error
var BLIND_DRIFT_MAX = 55;       // deg: max veer off the intended line when blinded
var BLIND_THROTTLE = 0.72;      // speed factor while blinded (tentative)
var ZOMBIE_AVOID_RADIUS = 95;   // px: non-zombies steer away from zombies (contact infects)
var ZOMBIE_AVOID_STRENGTH = 2.1;
var PUCK_AVOID_RADIUS = 115;    // px: the hockey puck hits hard — give it room
var PUCK_AVOID_STRENGTH = 2.6;
var LIGHTNING_FEELER_MULT = 1.45; // see farther ahead when everyone's sped up
var HAZARD_PATH_PENALTY = 12;     // cost x for routing a path through a bumper's cell

var AB = c.tileMap.abilities;

function snap45(deg) {
    var d = Math.round(deg / 45) * 45;
    return ((d % 360) + 360) % 360;
}
function angleDeg(fromX, fromY, toX, toY) {
    return Math.atan2(toY - fromY, toX - fromX) * 180 / Math.PI;
}
function punchReady(bot) {
    return bot.punchedTimer == null || (Date.now() - bot.punchedTimer) >= bot.punchWaitTime;
}
function isRacer(p, self) {
    return p !== self && p.alive && !p.reachedGoal && !p.isSpectator;
}
function nearestRival(bot, players) {
    var best = null, bd = Infinity;
    for (var id in players) {
        var p = players[id];
        if (!isRacer(p, bot)) { continue; }
        var d = mag(p.x - bot.x, p.y - bot.y);
        if (d < bd) { bd = d; best = p; }
    }
    return best == null ? null : { player: best, dist: bd };
}
function nearestRivalToPoint(px, py, players, self) {
    var bd = Infinity;
    for (var id in players) {
        var p = players[id];
        if (!isRacer(p, self)) { continue; }
        var d = mag(p.x - px, p.y - py);
        if (d < bd) { bd = d; }
    }
    return bd;
}
function hasRacingRival(bot, players) {
    for (var id in players) { if (isRacer(players[id], bot)) { return true; } }
    return false;
}
function countRacers(players) {
    var n = 0;
    for (var id in players) { var p = players[id]; if (p.alive && !p.isSpectator && !p.reachedGoal) { n++; } }
    return n;
}
// The rival a bot prefers to target: a 'human'-focused bot (Nemesis) goes after
// the nearest human; everyone else targets the nearest rival of any kind.
function preferredTarget(bot, ctx) {
    if (bot.ai && bot.ai.focus === 'human') {
        var h = nearestMatch(bot, ctx.players, function (p) { return !p.isAI; });
        if (h != null) { return h; }
    }
    return nearestRival(bot, ctx.players);
}
function hasHumanRival(bot, players) {
    for (var id in players) {
        var p = players[id];
        if (isRacer(p, bot) && !p.isAI) { return true; }
    }
    return false;
}
// How many rivals are closer to `goal` than the bot (0 = the bot is leading).
function goalRank(bot, players, goal) {
    if (goal == null) { return 0; }
    var mine = mag(goal.x - bot.x, goal.y - bot.y);
    var ahead = 0;
    for (var id in players) {
        var p = players[id];
        if (p === bot || !p.alive || p.isSpectator) { continue; }
        if (p.reachedGoal) { ahead++; continue; }
        if (mag(goal.x - p.x, goal.y - p.y) < mine) { ahead++; }
    }
    return ahead;
}
// Is there lava just beyond `target` along the bot->target ray? (so a punch, which
// shoves the target directly away from the bot, knocks them into it).
function lavaBeyond(ctx, bot, target, dist) {
    var dx = target.x - bot.x, dy = target.y - bot.y;
    var m = mag(dx, dy) || 1;
    return isLavaAt(ctx, target.x + (dx / m) * dist, target.y + (dy / m) * dist);
}

// --- Phase 5 helpers ---
function nearestMatch(bot, players, pred) {
    var best = null, bd = Infinity;
    for (var id in players) {
        var p = players[id];
        if (p === bot || !p.alive || p.isSpectator) { continue; }
        if (!pred(p)) { continue; }
        var d = mag(p.x - bot.x, p.y - bot.y);
        if (d < bd) { bd = d; best = p; }
    }
    return best == null ? null : { player: best, dist: bd };
}
function notZombiePrey(p) { return !p.isZombie && !p.reachedGoal; }
function isZombieP(p) { return p.isZombie; }

// Nearest goal point to (x,y) from the precomputed goal tiles.
function nearestGoalPoint(x, y, goalTiles) {
    var best = null, bd = Infinity;
    for (var i = 0; i < goalTiles.length; i++) {
        var d = mag(goalTiles[i].x - x, goalTiles[i].y - y);
        if (d < bd) { bd = d; best = goalTiles[i]; }
    }
    return best;
}

// Where a hunting zombie should aim to HEAD OFF its prey: lead it along its route
// to the goal (prey are racing for a goal), not its current spot — and lead more
// the farther away the zombie is, so it cuts the prey off rather than tail-chasing.
// Zombies are lava-immune, so the straight beeline to the intercept is valid.
function zombieInterceptDir(bot, prey, ctx) {
    var px = prey.x, py = prey.y;
    var leadX, leadY;
    var g = ctx.goalTiles && ctx.goalTiles.length ? nearestGoalPoint(px, py, ctx.goalTiles) : null;
    if (g != null) {
        leadX = g.x - px; leadY = g.y - py; // they're running toward this goal
    } else {
        leadX = prey.velX || 0; leadY = prey.velY || 0; // fall back to current heading
    }
    var lm = mag(leadX, leadY);
    var distToPrey = mag(px - bot.x, py - bot.y);
    var lead = distToPrey * 0.6;
    if (lead < 40) { lead = 40; } else if (lead > 240) { lead = 240; }
    var ix = px, iy = py;
    if (lm > 0.001) { ix = px + (leadX / lm) * lead; iy = py + (leadY / lm) * lead; }
    var dx = ix - bot.x, dy = iy - bot.y, m = mag(dx, dy) || 1;
    return { x: dx / m, y: dy / m };
}

// Repulsion away from a point within `radius` (ramped up close). Shared by zombie
// and puck avoidance.
function pointRepulsion(bot, x, y, radius) {
    var dx = bot.x - x, dy = bot.y - y, d = mag(dx, dy);
    if (d > 0 && d < radius) {
        var w = (radius - d) / radius; w = w * w;
        return { x: (dx / d) * w, y: (dy / d) * w };
    }
    return { x: 0, y: 0 };
}

// Is the bot currently "blinded" — blackout round, an active blindfold, or sitting
// under a cloud? Bots read game state (not pixels), so without this they'd be
// immune; the self-handicap makes vision effects bite the AI as they bite a human.
function isBlinded(bot, ctx, now) {
    if (ctx.blackoutActive) { return true; }
    if (ctx.visionBlockedUntil > now) { return true; }
    if (ctx.cloudy) {
        for (var i = 0; i < ctx.clouds.length; i++) {
            var cl = ctx.clouds[i];
            if (mag(cl.x - bot.x, cl.y - bot.y) < (cl.radius || 0)) { return true; }
        }
    }
    return false;
}

// Brutal-round punches take priority over the generic punch/ability policy:
// zombies hunt-and-bite, non-zombies fend off an adjacent zombie, and anyone
// clears the puck when it's on top of them. Returns true if it set an attack.
// Face a punch target before swinging — needed where the punch is directional
// (lands in front of the kart); harmless where it's omnidirectional.
function facePunch(bot, x, y) { bot.angle = angleDeg(bot.x, bot.y, x, y); }

function decideBrutalPunch(bot, ctx) {
    // A "punch" is attack with no held ability. If the bot holds an ability,
    // setting attack would FIRE THE ABILITY (Player.checkAttack), not punch — and
    // at this function's non-8-way facing that breaks directional projectiles
    // (clampPlayerAngle -> undefined -> NaN). So defer to the ability policy here.
    if (bot.ability != null) { return false; }
    if (!punchReady(bot)) { return false; }
    if (ctx.infection && bot.isZombie) {
        var prey = nearestMatch(bot, ctx.players, notZombiePrey);
        if (prey != null && prey.dist < c.punchRadius + bot.radius + prey.player.radius + 8) {
            facePunch(bot, prey.player.x, prey.player.y); bot.attack = true; return true;
        }
        return false; // not in range — the chase is handled in steering
    }
    if (ctx.infection && !bot.isZombie) {
        var z = nearestMatch(bot, ctx.players, isZombieP);
        if (z != null && z.dist < c.punchRadius + bot.radius + z.player.radius + 8) {
            facePunch(bot, z.player.x, z.player.y); bot.attack = true; return true; // knock the zombie back
        }
    }
    if (ctx.hockey && ctx.puck != null) {
        if (mag(ctx.puck.x - bot.x, ctx.puck.y - bot.y) < c.punchRadius + bot.radius + (ctx.puck.radius || 0) + 8) {
            facePunch(bot, ctx.puck.x, ctx.puck.y); bot.attack = true; return true; // clear the puck off us
        }
    }
    return false;
}

// Decide whether to fire the held ability this tick; may set bot.angle (snapped to
// the 8-way the engine's clampPlayerAngle requires) and bot.attack.
function decideAbility(bot, ctx, ability, nav) {
    var id = ability.id;

    if (id === AB.bombTrigger.id) {
        // Two-step bomb: detonate when a rival is inside the blast, or just before
        // the bomb auto-expires (so the trigger isn't wasted).
        var bomb = ctx.projectileList[bot.id];
        var held = (Date.now() - (bot.ai.bombFiredAt || 0)) / 1000;
        if (bomb == null) { bot.attack = true; return; } // bomb gone — clear the trigger
        if (nearestRivalToPoint(bomb.x, bomb.y, ctx.players, bot) < AB.bomb.explosionRadius * 0.9) { bot.attack = true; return; }
        if (held > BOMB_MAX_HOLD) { bot.attack = true; }
        return;
    }
    // Abilities persist all round, so bots use them strategically but never hoard:
    // each has a "good moment" to fire, plus a hold-timeout (longer for hoarders,
    // shorter for trigger-happy) after which it fires at the next safe opportunity.
    var held = nav.held || 0;
    var maxHold = 2 + (1 - bot.ai.abilityTempo) * 5; // ~2s (eager) .. ~7s (hoarder)
    var forced = held > maxHold;
    var rank = goalRank(bot, ctx.players, bot.ai.goal);
    var aimAhead = function () { bot.angle = snap45(Math.atan2(bot.targetDirY, bot.targetDirX) * 180 / Math.PI); };

    if (id === AB.bomb.id) {
        var nr = preferredTarget(bot, ctx); // Nemesis aims at the human
        if (nr != null && nr.dist < BOMB_THROW_RANGE) {
            bot.angle = snap45(angleDeg(bot.x, bot.y, nr.player.x, nr.player.y));
            bot.attack = true; bot.ai.bombFiredAt = Date.now();
        } else if (forced) {
            // No target in range — lob it down the track to lay slow tiles ahead.
            aimAhead(); bot.attack = true; bot.ai.bombFiredAt = Date.now();
        }
        return;
    }
    if (id === AB.swap.id) {
        // Swap with a leader when behind (a random-target swap while leading risks
        // giving away the lead, so never force it while in front).
        if (rank >= 1) {
            var nrs = preferredTarget(bot, ctx);
            if (nrs != null && (nrs.dist < SWAP_RANGE || forced)) { bot.attack = true; }
        }
        return;
    }
    if (id === AB.cut.id) {
        // Shove nearby rivals aside (perpendicular to facing); aim along travel.
        var nrc = nearestRival(bot, ctx.players);
        var range = forced ? CUT_RANGE * 2 : CUT_RANGE;
        if (nrc != null && nrc.dist < range) { aimAhead(); bot.attack = true; }
        return;
    }
    if (id === AB.speedDebuff.id) {
        if (hasRacingRival(bot, ctx.players)) { bot.attack = true; } // slows ALL rivals
        return;
    }
    if (id === AB.speedBuff.id) {
        // Self speed boost: spend it on the move (just not braking into lava).
        if (!nav.lavaAhead) { bot.attack = true; }
        return;
    }
    if (id === AB.iceCannon.id) {
        if (!nav.lavaAhead) { aimAhead(); bot.attack = true; } // self-boost + ice the lane ahead
        return;
    }
    if (id === AB.blindfold.id) {
        // Room-wide blind: best when a human rival is in play and the bot isn't out
        // front; otherwise use it once held a while so it isn't wasted.
        if ((hasHumanRival(bot, ctx.players) && rank >= 1) || forced) { bot.attack = true; }
        return;
    }
    if (id === AB.tileSwap.id) {
        // Map-wide chaos: best when behind, but use it before the round's out.
        if (rank >= 2 || forced) { bot.attack = true; }
        return;
    }
}

// Offensive combat comes in BURSTS, not a continuous punch-lock: a bot engages
// for a short window then disengages and races for a stretch, so bots don't just
// stand and trade punches. Returns true if the bot may throw an offensive punch
// now; starts a fresh burst (and schedules the following rest) on the first punch.
function offensiveCombatAllowed(bot, now) {
    var ai = bot.ai;
    if (now < ai.combatUntil) { return true; }          // mid-burst
    if (now < ai.combatRestUntil) { return false; }     // resting -> race only
    // Rested: open a new burst. Aggressive bots fight longer and rest less.
    var burst = 400 + ai.aggression * 850;              // 0.4s .. 1.25s
    var rest = 2200 + (1 - ai.aggression) * 3200;       // 2.2s .. 5.4s
    ai.combatUntil = now + burst;
    ai.combatRestUntil = ai.combatUntil + rest;
    return true;
}

// Decide whether to throw a (cooldown-gated, bursty) punch this tick. Priority:
// shove a rival into adjacent lava; aggressive bots also punch a rival pressed
// against them — but only during a combat burst. Brutal-round combat (zombies,
// pucks) is objective-driven and handled separately (not rate-limited here).
function decidePunch(bot, ctx) {
    if (!punchReady(bot)) { return; }
    var nr = preferredTarget(bot, ctx); // Nemesis hounds the human
    if (nr == null) { return; }
    // The punch (radius punchRadius at the bot's position) only lands on a rival
    // within punchRadius + both radii; add a small buffer for closing speed.
    var landRange = c.punchRadius + bot.radius + nr.player.radius + 6;
    if (nr.dist > landRange) { return; }
    var shove = lavaBeyond(ctx, bot, nr.player, SHOVE_PROBE);
    // A free shove into the lava is always worth it; routine aggression only in bursts.
    if (!shove && bot.ai.aggression < 0.6) { return; }
    if (!offensiveCombatAllowed(bot, Date.now())) { return; }
    facePunch(bot, nr.player.x, nr.player.y);
    bot.attack = true;
}

// Top-level per-tick combat decision: fire the held ability, else consider a punch.
function decideAttack(bot, ctx, nav) {
    bot.attack = false;
    if (decideBrutalPunch(bot, ctx)) { return; } // zombies / puck / zombie-defense first
    if (bot.ability != null) {
        // Track how long this ability has been held so it gets used within the
        // round (strategically when possible, but never hoarded indefinitely).
        var now = Date.now();
        if (bot.ai.heldAbilityId !== bot.ability.id) {
            bot.ai.heldAbilityId = bot.ability.id;
            bot.ai.abilityHeldSince = now;
        }
        nav.held = (now - bot.ai.abilityHeldSince) / 1000;
        decideAbility(bot, ctx, bot.ability, nav);
        return;
    }
    bot.ai.heldAbilityId = null;
    decidePunch(bot, ctx);
}

function steerBot(bot, ctx, dt) {
    var ai = bot.ai || (bot.ai = newBotState(bot.profile));

    // --- Re-path on a throttle (and immediately if we have no path) ---
    ai.repathTimer -= dt;
    if (ai.repathTimer <= 0 || ai.waypoints == null) {
        var blocked = collapseDangerSet(ctx);
        // Per-bot route diversity: jitter edge costs by a seeded amount so bots
        // don't all take the identical optimal line. Weaker (lower-skill) bots
        // wander a bit more; skilled bots stay closer to optimal.
        var pathOpts = {
            blocked: blocked,
            noiseSeed: ai.pathSeed,
            noiseAmount: 0.15 + (1 - ai.skill) * 0.2,
            penaltySet: ctx.hazardCells, // route AROUND bumper cells (soft penalty)
            penaltyMult: HAZARD_PATH_PENALTY
        };
        var route = cellGraph.findPathToNearestGoal(ctx.map, { x: bot.x, y: bot.y }, pathOpts);
        // If the danger ring walled us off, retry without it so we still aim at a
        // goal (better a tight line than freezing in front of the lava). Keep the
        // hazard penalty on the retry — it's soft, so it never nulls the path.
        if (route == null && blocked != null) {
            route = cellGraph.findPathToNearestGoal(ctx.map, { x: bot.x, y: bot.y }, { noiseSeed: ai.pathSeed, noiseAmount: pathOpts.noiseAmount, penaltySet: ctx.hazardCells, penaltyMult: HAZARD_PATH_PENALTY });
        }
        if (route != null) {
            var pts = [];
            for (var p = 0; p < route.path.length; p++) {
                var site = ctx.siteById[route.path[p]];
                if (site) { pts.push(site); }
            }
            ai.path = route.path;
            ai.waypoints = pts;
            ai.goal = route.goal;
            // Skip the start cell (≈ current position) so the carrot looks ahead.
            ai.wpIndex = pts.length > 1 ? 1 : 0;
        } else {
            ai.waypoints = null;
            ai.goal = null;
        }
        // Lower-skill bots react slower (re-path less often) — laggier, less optimal.
        ai.repathTimer = REPATH_INTERVAL * (1 + (1 - ai.skill) * 1.2);
    }

    var desiredX = 0, desiredY = 0;
    var speed = mag(bot.velX, bot.velY);
    var sharpTurn = false;

    if (ai.waypoints != null && ai.waypoints.length > 0) {
        // Advance past waypoints we've effectively reached.
        var last = ai.waypoints.length - 1;
        while (ai.wpIndex < last) {
            var wp = ai.waypoints[ai.wpIndex];
            if (mag(wp.x - bot.x, wp.y - bot.y) < ARRIVE_RADIUS) { ai.wpIndex++; } else { break; }
        }
        var carrot = carrotPoint(bot, ai.waypoints, ai.wpIndex);
        var dx = carrot.x - bot.x, dy = carrot.y - bot.y;
        var dm = mag(dx, dy) || 1;
        desiredX = dx / dm;
        desiredY = dy / dm;

        // Detect a sharp upcoming bend so we can ease off and brake before it.
        if (ai.wpIndex < last) {
            var a = ai.waypoints[ai.wpIndex];
            var b = ai.waypoints[ai.wpIndex + 1];
            var inX = a.x - bot.x, inY = a.y - bot.y;
            var outX = b.x - a.x, outY = b.y - a.y;
            var im = mag(inX, inY) || 1, om = mag(outX, outY) || 1;
            var turnCos = (inX * outX + inY * outY) / (im * om);
            if (turnCos < TURN_BRAKE_COS) { sharpTurn = true; }
        }
    } else if (ctx.collapsing && ctx.collapseLoc != null) {
        // Walled off with no reachable goal during a collapse: the collapse closes
        // inward toward collapseLoc (the safe center / goal), so flee toward it.
        var fx = ctx.collapseLoc.x - bot.x, fy = ctx.collapseLoc.y - bot.y;
        var fm = mag(fx, fy) || 1;
        desiredX = fx / fm; desiredY = fy / fm;
    } else if (ctx.infection && bot.isZombie && nearestMatch(bot, ctx.players, notZombiePrey) != null) {
        // A zombie with no reachable goal path (it's lava-immune and often sits on
        // lava) still HUNTS — fall through to the intercept override below, which
        // sets desired toward the prey. Don't freeze in the no-path hold.
    } else {
        // No path and not collapsing: hold position (don't drive blindly).
        bot.targetDirX = 0; bot.targetDirY = 0; bot.braking = true; bot.attack = false;
        return;
    }

    // --- Brutal-round steering overrides (objective flips + vision fairness) ---
    var now = Date.now();
    // Infection: a zombie's whole job is to infect non-zombies. It abandons the
    // goal, picks the nearest non-zombie prey, and aims to HEAD IT OFF on its way
    // to a goal (intercept lead) rather than tail-chase. Lava-immune, so it beelines.
    if (ctx.infection && bot.isZombie) {
        var prey = nearestMatch(bot, ctx.players, notZombiePrey);
        if (prey != null) {
            var idir = zombieInterceptDir(bot, prey.player, ctx);
            desiredX = idir.x; desiredY = idir.y;
        }
    }
    // Vision self-handicap: random-walk a heading error and slow down when blinded.
    // Feelers still keep local lava safety (a human keeps a small vision circle).
    var blinded = isBlinded(bot, ctx, now);
    if (blinded) {
        ai.blindDrift += (Math.random() - 0.5) * 2 * BLIND_DRIFT_STEP;
        if (ai.blindDrift > BLIND_DRIFT_MAX) { ai.blindDrift = BLIND_DRIFT_MAX; }
        if (ai.blindDrift < -BLIND_DRIFT_MAX) { ai.blindDrift = -BLIND_DRIFT_MAX; }
        var rd = rotate(desiredX, desiredY, ai.blindDrift);
        desiredX = rd.x; desiredY = rd.y;
    } else {
        ai.blindDrift *= 0.85;
    }

    // --- Personality: effective skill, off-moments, tilt, and line precision ---
    var effSkill = ai.skill;
    // Occasional "off moment" (a fumble) — likelier for lower-skill bots — so a
    // player win feels earned rather than scripted.
    if (now < ai.offUntil) {
        effSkill *= 0.55;
    } else if (Math.random() < 0.0015 * (1.2 - ai.skill)) {
        ai.offUntil = now + 350 + Math.random() * 550;
    }
    // Hothead tilt: reckless (faster, cuts tighter) when behind the field.
    var rank = goalRank(bot, ctx.players, ai.goal);
    var racers = countRacers(ctx.players);
    var behind = racers > 1 && rank >= Math.ceil(racers / 2);
    if (ai.tilt === 'rage' && behind) { effSkill = clamp01(effSkill + 0.2); }
    // Steering imprecision: low-skill bots wander off the optimal line (the
    // "scenic route"); high-skill bots hold a tight, smart line.
    var wobble = (1 - effSkill);
    ai.wander += (Math.random() - 0.5) * 2 * 5 * wobble;
    var wanderMax = 38 * wobble;
    if (ai.wander > wanderMax) { ai.wander = wanderMax; }
    if (ai.wander < -wanderMax) { ai.wander = -wanderMax; }
    if (wobble > 0.02) {
        var rw = rotate(desiredX, desiredY, ai.wander);
        desiredX = rw.x; desiredY = rw.y;
    }
    // Risk: tighter lines hug the lava (corner-cutting); cautious bots keep clear.
    ctx.riskMult = 1 - 0.45 * ai.risk;

    // --- Avoidance: predictive feelers (primary) + soft fields (secondary) ---
    // Heading the feelers look along: actual velocity when moving, else desired.
    var headX = desiredX, headY = desiredY;
    if (speed > 5) { headX = bot.velX / speed; headY = bot.velY / speed; }

    // Zombies don't die on lava (and ignore the collapse) — they cut straight
    // across it to chase prey, so a zombie bot turns OFF all lava avoidance.
    var ignoreLava = bot.isZombie === true;
    var fl = ignoreLava ? { x: 0, y: 0, brake: false } : feelerAvoid(bot, ctx, headX, headY, speed);
    var hz = hazardRepulsion(bot, ctx.hazardList);
    var lv = ignoreLava ? { x: 0, y: 0 } : lavaRepulsion(bot, ctx.lavaCells);

    // Lava dead ahead means the current line is bad — re-path next tick to find a
    // route around it instead of crawling toward the edge until we clip it.
    if (fl.brake) { ai.repathTimer = 0; }

    // Extra brutal-round repulsions: dodge zombies (contact infects) and the puck.
    var exX = 0, exY = 0;
    if (ctx.infection && !bot.isZombie && !bot.infected) {
        for (var zi in ctx.players) {
            var zp = ctx.players[zi];
            if (zp === bot || !zp.alive || !zp.isZombie) { continue; }
            var zr = pointRepulsion(bot, zp.x, zp.y, ZOMBIE_AVOID_RADIUS);
            exX += zr.x * ZOMBIE_AVOID_STRENGTH; exY += zr.y * ZOMBIE_AVOID_STRENGTH;
        }
    }
    if (ctx.hockey && ctx.puck != null) {
        var pr = pointRepulsion(bot, ctx.puck.x, ctx.puck.y, PUCK_AVOID_RADIUS);
        exX += pr.x * PUCK_AVOID_STRENGTH; exY += pr.y * PUCK_AVOID_STRENGTH;
    }

    var lavaW = LAVA_AVOID_STRENGTH * (ctx.riskMult != null ? ctx.riskMult : 1);
    var sx = desiredX + fl.x * FEELER_AVOID_STRENGTH + lv.x * lavaW + hz.x * HAZARD_AVOID_STRENGTH + exX;
    var sy = desiredY + fl.y * FEELER_AVOID_STRENGTH + lv.y * lavaW + hz.y * HAZARD_AVOID_STRENGTH + exY;
    var sm = mag(sx, sy);
    var steerX = desiredX, steerY = desiredY;
    if (sm > 0.0001) { steerX = sx / sm; steerY = sy / sm; }

    // --- Throttle governor: don't outdrive the sensors. Crawl when lava is close
    // ahead so steering can redirect momentum before instant death; ease into
    // sharp bends; full throttle on open, straight runway. The engine reads the
    // targetDir magnitude as the accel input, so a shorter vector = lower speed.
    var throttle = 1.0;
    var braking = false;
    var lavaField = mag(lv.x, lv.y);
    if (fl.brake || lavaField > 1.2) {
        throttle = 0.42;
        if (speed > BRAKE_SPEED_MIN) { braking = true; }
    } else if (sharpTurn || lavaField > 0.6) {
        throttle = 0.7;
        if (sharpTurn && speed > BRAKE_SPEED_MIN * 1.3) { braking = true; }
    }
    // Blinded racers feel their way forward more tentatively.
    if (blinded) { throttle *= BLIND_THROTTLE; }

    // Personality + rubber-band speed: skill sets the cruise pace (slow Tortoise ..
    // quick Ghost); the within-race rubber-band eases the field off when the human
    // is behind and pushes it when the human is leading, so wins feel earned.
    // NOTE: the engine scales a bot's input by 0.8 (vs a human's 1.0), so the top
    // of this range is set high enough that a max-skill bot's effective input
    // (0.8 x speedFactor) reaches/*slightly* exceeds a human's — otherwise even the
    // best bots are hard-capped below human top speed and trivially beatable.
    var speedFactor = (0.72 + 0.55 * effSkill) * (ctx.rubberBand || 1);
    if (speedFactor > 1.45) { speedFactor = 1.45; }
    if (speedFactor < 0.4) { speedFactor = 0.4; }
    throttle *= speedFactor;

    // A hunting zombie commits fully: it ignores lava and only wants to catch prey,
    // so skip the cautious governor, rubber-band easing, and braking — full chase.
    if (bot.isZombie) { throttle = 1; braking = false; }

    bot.targetDirX = steerX * throttle;
    bot.targetDirY = steerY * throttle;
    bot.angle = Math.atan2(steerY, steerX) * (180 / Math.PI);
    bot.braking = braking;

    // Combat & abilities (may override bot.angle to an 8-way aim and set bot.attack).
    decideAttack(bot, ctx, { sharpTurn: sharpTurn, lavaAhead: fl.brake });
}

// The non-lava launch lanes along the gate's front row: the Y positions where a
// bot can stand (and be released) onto solid ground, not lava. On a lava-walled
// map only a few exist, so bots contest them — like real players fighting over
// the safe spots — instead of spreading evenly onto the lava.
function computeSafeLanes(ctx, gate, standX) {
    var lanes = [];
    var topY = gate.y + 16, botY = gate.y + gate.height - 16;
    for (var y = topY; y <= botY; y += 20) {
        if (!isLavaAt(ctx, standX, y)) { lanes.push(y); }
    }
    return lanes;
}

// Gated phase: bots aren't racing yet (held inside the start gate). They press to
// the front row, target a SAFE (non-lava) launch lane so they don't drive into
// lava the instant the gate opens, and bursty-punch to contest a lane. Everyone
// converges on the safe lanes, so they jostle for them. preventEscape keeps them
// in the gate; lava can't kill here, only once racing starts.
function steerGated(bot, ctx, dt) {
    var ai = bot.ai || (bot.ai = newBotState(bot.profile));
    var gate = ctx.gate;
    var frontX = (gate ? gate.x + gate.width : 75) - bot.radius - 3;
    var topY = (gate ? gate.y : 0) + bot.radius + 4;
    var botYmax = (gate ? gate.y + gate.height : c.worldHeight) - bot.radius - 4;
    var ty;
    if (ctx.safeLanes && ctx.safeLanes.length > 0) {
        // Each bot is assigned a safe lane by its seed so the field SPREADS across
        // the available lanes (route diversity) instead of all converging on the
        // nearest one. When safe lanes are scarce (lava-walled gate) several bots
        // share a lane and jostle for it. Sticky per-bot jitter avoids exact stacks.
        if (ai.gateJitter == null) { ai.gateJitter = (Math.random() - 0.5) * 16; }
        ty = ctx.safeLanes[ai.pathSeed % ctx.safeLanes.length] + ai.gateJitter;
    } else {
        // No safe-lane reading: gentle shuffle along the gate (fallback).
        if (ai.gateY == null) { ai.gateY = bot.y; }
        ai.gateY += (Math.random() - 0.5) * 12;
        if (ai.gateY < topY) { ai.gateY = topY; }
        if (ai.gateY > botYmax) { ai.gateY = botYmax; }
        ty = ai.gateY;
    }
    if (ty < topY) { ty = topY; } else if (ty > botYmax) { ty = botYmax; }
    var dx = frontX - bot.x, dy = ty - bot.y;
    var m = mag(dx, dy) || 1;
    bot.targetDirX = (dx / m) * 0.75; // press to the front, not flat out
    bot.targetDirY = (dy / m) * 0.75;
    bot.braking = false;
    bot.angle = Math.atan2(dy, dx) * (180 / Math.PI);
    decideAttack(bot, ctx, { sharpTurn: false, lavaAhead: false }); // bursty jockey punches
}

function steerGatedPhase(gameBoard) {
    var playerList = gameBoard.playerList;
    var hasBot = false;
    for (var id in playerList) { if (playerList[id].isAI && playerList[id].alive) { hasBot = true; break; } }
    if (!hasBot) { return; }
    var gate = gameBoard.startingGate;
    var ctx = {
        map: gameBoard.currentMap,
        lavaId: c.tileMap.lava.id,
        players: playerList,
        projectileList: gameBoard.projectileList,
        gate: gate,
        infection: false, hockey: false, cloudy: false, lightning: false,
        puck: null, clouds: [], blackoutActive: false, visionBlockedUntil: 0
    };
    // Where a gated bot ends up standing (front row, inside the gate); the lava
    // check uses that X so a "safe lane" is one the bot can actually launch from.
    var standX = gate ? gate.x + gate.width - 10 : 65;
    ctx.safeLanes = gate ? computeSafeLanes(ctx, gate, standX) : [];
    for (var pid in playerList) {
        var bot = playerList[pid];
        if (!bot.isAI || !bot.alive || bot.isSpectator) { continue; }
        steerGated(bot, ctx);
    }
}

// Entry point: steer every alive bot for this tick. Bots jockey during the gated
// phase, race/avoid during racing & collapsing, and sit still otherwise.
function update(gameBoard, currentState, dt) {
    var map = gameBoard.currentMap;
    if (map == null || !Array.isArray(map.cells) || map.cells.length === 0) {
        return;
    }
    if (currentState === c.stateMap.gated) {
        steerGatedPhase(gameBoard);
        return;
    }
    if (currentState !== c.stateMap.racing && currentState !== c.stateMap.collapsing) {
        return;
    }
    var hasBot = false;
    var playerList = gameBoard.playerList;
    for (var id in playerList) {
        if (playerList[id].isAI && playerList[id].alive && !playerList[id].reachedGoal) { hasBot = true; break; }
    }
    if (!hasBot) { return; }

    // Lava cell centers + goal tiles, rebuilt each tick (cells flip during collapse).
    var lavaCells = [];
    var goalTiles = [];
    var LAVA = c.tileMap.lava.id;
    var GOAL = c.tileMap.goal.id;
    for (var li = 0; li < map.cells.length; li++) {
        if (!map.cells[li] || !map.cells[li].site) { continue; }
        if (map.cells[li].id === LAVA) {
            lavaCells.push({ x: map.cells[li].site.x, y: map.cells[li].site.y });
        } else if (map.cells[li].id === GOAL) {
            goalTiles.push({ x: map.cells[li].site.x, y: map.cells[li].site.y });
        }
    }

    // Cells holding a bumper hazard — bumpers aren't in the cell graph, so without
    // this A* routes straight through them and the bot gets knocked/stuck. Penalize
    // those cells so routes go AROUND. Recomputed each tick so a moving bumper's
    // cell is tracked (re-pathing is throttled; local repulsion handles the rest).
    var hazardCells = null;
    var hazardList = gameBoard.hazardList;
    for (var hkey in hazardList) {
        var hz = hazardList[hkey];
        if (!hz || hz.alive === false) { continue; }
        var bestI = -1, bestD = Infinity;
        for (var ci2 = 0; ci2 < map.cells.length; ci2++) {
            var cc = map.cells[ci2];
            if (!cc || !cc.site) { continue; }
            var ddx = cc.site.x - hz.x, ddy = cc.site.y - hz.y;
            var dd = ddx * ddx + ddy * ddy;
            if (dd < bestD) { bestD = dd; bestI = ci2; }
        }
        if (bestI >= 0) {
            if (hazardCells == null) { hazardCells = new Set(); }
            hazardCells.add(map.cells[bestI].site.voronoiId);
        }
    }

    // Within-race rubber-band: compare the leading human's progress-to-goal with
    // the bot field's and ease the bots off when the human is behind, push them
    // when the human is ahead. Straight-line distance to the nearest goal is the
    // progress proxy. No human (or no goal) -> neutral.
    var rubberBand = 1;
    if (goalTiles.length > 0) {
        var nearestGoalDist = function (px, py) {
            var b = Infinity;
            for (var g = 0; g < goalTiles.length; g++) {
                var d = mag(goalTiles[g].x - px, goalTiles[g].y - py);
                if (d < b) { b = d; }
            }
            return b;
        };
        var humanMin = Infinity, botDists = [];
        for (var rid in playerList) {
            var rp = playerList[rid];
            if (!rp.alive || rp.isSpectator || rp.reachedGoal) { continue; }
            var gd = nearestGoalDist(rp.x, rp.y);
            if (rp.isAI) { botDists.push(gd); }
            else if (gd < humanMin) { humanMin = gd; }
        }
        if (humanMin < Infinity && botDists.length > 0) {
            botDists.sort(function (a, b) { return a - b; });
            var botMed = botDists[Math.floor(botDists.length / 2)];
            // Positive delta = human closer to a goal than the bots (leading).
            var delta = (botMed - humanMin) / c.worldWidth;
            if (delta > 1) { delta = 1; } else if (delta < -1) { delta = -1; }
            rubberBand = 1 + delta * (c.aiRacers.rubberBandStrength || 0.18);
        }
    }
    module.exports.lastRubberBand = rubberBand; // diagnostic for tests

    // Active brutal modes + the special objects/state their strategies need.
    var br = c.brutalRounds;
    var infection = gameBoard.checkForActiveBrutal(br.infection.id);
    var hockey = gameBoard.checkForActiveBrutal(br.hockey.id);
    var cloudy = gameBoard.checkForActiveBrutal(br.cloudy.id);
    var lightning = gameBoard.checkForActiveBrutal(br.lightning.id);
    var puck = null, clouds = [];
    if (hockey || cloudy) {
        for (var prj in gameBoard.projectileList) {
            var o = gameBoard.projectileList[prj];
            if (hockey && o.type === "puck") { puck = o; }
            else if (cloudy && o.type === "cloud") { clouds.push(o); }
        }
    }

    var ctx = {
        map: map,
        lavaId: LAVA,
        siteById: buildSiteIndex(map),
        lavaCells: lavaCells,
        goalTiles: goalTiles, // for zombie intercept (prey are racing to a goal)
        hazardCells: hazardCells, // bumper cells to penalize in pathing
        players: playerList,
        projectileList: gameBoard.projectileList,
        hazardList: gameBoard.hazardList,
        collapsing: currentState === c.stateMap.collapsing,
        collapseLoc: gameBoard.collapseLoc && gameBoard.collapseLoc.x != null ? gameBoard.collapseLoc : null,
        collapseLine: gameBoard.collapseLine,
        // Phase 5 brutal-round state
        infection: infection,
        hockey: hockey,
        cloudy: cloudy,
        lightning: lightning,
        puck: puck,
        clouds: clouds,
        blackoutActive: gameBoard.blackoutActive === true,
        visionBlockedUntil: gameBoard.visionBlockedUntil || 0,
        rubberBand: rubberBand,
        riskMult: 1 // overwritten per-bot in steerBot from personality risk
    };

    for (var pid in playerList) {
        var bot = playerList[pid];
        if (!bot.isAI || !bot.alive || bot.reachedGoal || bot.isSpectator) { continue; }
        steerBot(bot, ctx, dt);
    }
}

module.exports = { update: update };
