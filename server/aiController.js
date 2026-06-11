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
var HAZARD_AVOID_RADIUS = 64;   // px: start steering away from a bumper within this
var HAZARD_AVOID_STRENGTH = 1.7;// weight of hazard repulsion vs desired heading
var BUMPER_DANGER_PAD = 22;     // px: extra clearance for a bumper's strike (radius+punch)
// MOVING-bumper rail crossing. The whole swept rail used to be a permanent
// repulsive wall, so on a route that HAD to cross it the bots queued up at the
// rail and oscillated forever — there was no notion of timing the gap. But the
// bumper's motion is fully deterministic (constant sweep, exact reflection at the
// rail ends), so it can be predicted: when the bumper cannot come within strike
// range of the bot's crossing point before the bot has cleared the strike band,
// the gap is OPEN — drop the rail repulsion and let the carrot carry the bot
// across, exactly like a human darting through behind the bumper. While the gap
// is CLOSED, stage just outside the strike band (not the big avoid radius, so the
// dash is short when it opens) and slide toward the nearer rail END, where the
// bumper spends the least time and the windows are widest.
var RAIL_STRIKE = c.hazards.movingBumper.attackRadius + c.playerBaseRadius + 4; // px: bumper strike reach vs a kart (+pad)
var RAIL_WAIT_GAP = 16;         // px: staging standoff outside the strike band while the gap is closed
var RAIL_WAIT_STRENGTH = 2.5;   // closed-gap wall: holds the equilibrium just outside the band
var RAIL_END_SLIDE = 0.35;      // tangential drift toward the nearer rail end while waiting
var RAIL_CROSS_SPEED = 48;      // px/s: dash-speed fallback when the tile under the bot is unknown
var RAIL_CROSS_MARGIN = 1.05;   // safety factor on the predicted exposure time
var RAIL_SAMPLE_STEP = 0.06;    // s: resolution of the predicted bumper walk
// On slow ground (terminal speed ~17-21px/s) NO window on a standard 100px rail is
// ever provably safe — the crossing takes longer than the bumper's whole round
// trip. A human there darts right behind the bumper as it sweeps past and accepts
// the risk of a glancing bump (knockback, not death). When the rail can't offer a
// safe window ANYWHERE for this bot's speed, degrade to that dart: go behind the
// receding bumper while at least this fraction of the pass's best headroom
// remains (relative, so it fires once per sweep at any ground speed — an absolute
// time bound is unsatisfiable on slow tiles and froze staged bots).
var RAIL_DART_FRACTION = 0.6;
// Tile id -> tile def, for estimating the dash speed off the ground under the bot
// (terminal speed = acel*dt/drag, times the engine's 0.8 bot-input scale).
var TILE_BY_ID = {};
for (var tileKey in c.tileMap) {
    var tileDef = c.tileMap[tileKey];
    if (tileDef && tileDef.id != null && tileDef.acel != null && tileDef.dragCoeff != null) {
        TILE_BY_ID[tileDef.id] = tileDef;
    }
}
var COLLAPSE_DANGER_MARGIN = 55;// px: also block cells this close to the lava front
var LAVA_AVOID_RADIUS = 70;     // px: soft repulsion from a lava cell center within this
var LAVA_AVOID_STRENGTH = 2.2;  // weight of the soft lava field
var FEELER_BASE = 34;           // px: shortest predictive feeler reach
var FEELER_SPEED_K = 0.7;       // feeler grows with speed (stopping-distance proxy)
var FEELER_MAX = 120;           // px: cap feeler reach
var FEELER_SIDE_DEG = 32;       // angle of the two side feelers off the heading
var FEELER_AVOID_STRENGTH = 3.0;// weight of the predictive feeler push (strongest)
var FEELER_STEP = 13;           // px between samples along a feeler (catch thin lava fingers)
var FEELER_MAX_SAMPLES = 8;     // cap samples per feeler so isLavaAt cost stays bounded at high speed
var FEELER_BOXED_NEAR = 0.6;    // both-sides "boxed in" brakes only when lava is this near (frac of side reach)
// ICE: on a slippery tile a kart can barely brake (0.0001 vs 0.235) OR steer (accel 15
// vs 300), so its stopping/steering distance balloons — a normal-length feeler spots the
// lava far too late to curve the glide away, and the bot skates straight in. Look much
// farther ahead on ice (and allow more samples + a bigger cap so the long ray still
// catches lava) so the perpendicular push starts curving the slide while there's room.
var ICE_FEELER_MULT = 2.6;      // feeler reach/cap multiplier while on ice
var ICE_FEELER_SAMPLES = 24;    // ray samples on ice: keep ~13px spacing (=FEELER_STEP) over the
                                // ~2.6x-longer feeler so a thin lava finger isn't stepped over
// Pre-ice speed control: a kart can only brake on a GRIPPY tile (ice brake is 0.0001),
// so the time to bleed speed for the ice is BEFORE crossing onto it. When grippy and ice
// is imminent dead ahead, brake down to a controllable entry speed so the weak ice-steering
// can still follow the path across instead of skating straight off into the lava.
var ICE_ENTRY_LOOKAHEAD = 46;   // px ahead (plus a speed term) to sniff for upcoming ice
var ICE_ENTRY_SPEED = 42;       // px/s: target speed to be at or below when entering ice
// Water entry: a held ability fires on attack, so a bot carrying one CAN'T punch-swim (the
// stroke is a bare-handed punch). Sniff this far ahead (plus a speed term) for upcoming water
// while still on dry land and force the bot to SPEND its banked ability before the crossing,
// so it enters bare-handed and can stroke instead of crawling/stalling in the water.
var WATER_ENTRY_LOOKAHEAD = 60; // px ahead (plus a speed term) to sniff for upcoming water
// Anti-stuck escape: in a tight/looping corridor (sidewinder) over-cautious
// soft-field repulsion can stall a momentum car at a narrow gap — it crawls or
// slowly orbits one spot ("line up at the 1px pinch and wait"). When a bot loiters
// inside STUCK_RADIUS for STUCK_TRIGGER seconds, a STAGE-1 escape relaxes the soft
// lava field + kills the random wobble so it can hug a wall and thread the gap.
var STUCK_RADIUS = 40;          // px: staying within this of an anchor spot = no real headway
var STUCK_TRIGGER = 1.6;        // s loitering inside STUCK_RADIUS before an escape fires
// A bot CRUISING isn't stuck. On slow tiles the terminal speed (~17-21px/s)
// covers less than STUCK_RADIUS per STUCK_TRIGGER window, so without a speed
// gate the escape branch re-anchors every window while the bot drives flat-out
// — a treadmill that pins every slow-ground bot in permanent escape/beeline
// (headwayAt can never reset because the anchor leapfrogs along). Only treat a
// bot as wedged when it's actually near-stationary; 12px/s sits safely under
// every tile's bot terminal speed while still catching real pinch grinds.
var STUCK_SPEED_MAX = 12;
var ESCAPE_MS = 1400;           // ms an escape lasts once triggered
var ESCAPE_LAVA_RELAX = 0.45;   // shrink the SOFT lava-centering field during an escape (thread the gap)
var ESCAPE_WANDER_KILL = true;  // suppress the random wobble during an escape so it doesn't fight the gap
// Escalation: if stage 1 doesn't free the bot and it re-triggers within
// ESCALATE_WINDOW, it's wedged tighter than the soft approach can solve. STAGE 2
// COMMITS — throttle floor, drop the soft brake, and lean the steer toward the
// route exit (shrunk feeler push) — so it threads the gap or, if it's sealed in by
// lava, dies clearing the pinch instead of clogging it. Only ever reached by a bot
// already stuck through a failed stage-1 escape, so a normally-racing bot is
// untouched. (The hard feeler BRAKE that prevents driving point-blank into lava
// still applies in stage 1; stage 2 is the deliberate thread-or-die override.)
var ESCAPE_ESCALATE_WINDOW = 4000; // ms: re-trigger within this counts as a repeat
var ESCAPE_COMMIT_THROTTLE = 0.75; // stage-2 committed throttle floor
var ESCAPE_COMMIT_FEELER = 0.3;    // stage-2: shrink the feeler PUSH so the bot drives toward the
                                   // route exit (carrot) instead of being bent back into the pocket
// Last-resort "give up" beeline: when a bot has made NO real headway (continuous,
// reset only by actually breaking STUCK_RADIUS) for this long, neither the soft
// escape nor a committed thread freed it — it's genuinely sealed/wedged. The worst
// offender is a bot pinned in a lava-walled corner or in the start-gate margin
// OUTSIDE the terrain, where it's even immune to lava death (off every cell -> no
// hit) and so orbits one spot for the whole race. When this fires, the steer below
// abandons the path and drives STRAIGHT at the nearest goal with ALL avoidance OFF:
// it either threads back onto terrain, or drives onto the lava that's walling it in
// and dies, clearing the clog. Strictly a bot that's been frozen seconds already.
var BEELINE_AFTER_MS = 4500;       // ms continuously stuck before the avoidance-off beeline
// Steering low-pass. In a narrow lava-walled corridor the feeler + lava-field push
// flips side every tick; undamped, that vibration grows until the momentum car
// clips a wall (death) or cancels its own forward motion (the "stuck" crawl). We
// blend this tick's steer vector with the last so the bot holds a stable line down
// the lane. STEER_SMOOTH is the weight on the NEW vector (lower = more damping).
var STEER_SMOOTH = 0.4;

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
        progressAnchor: null,// {x,y}: spot the bot last made real headway from (anti-stuck)
        progressAt: 0,     // ms: when it last re-anchored there
        headwayAt: null,   // ms: last time it broke STUCK_RADIUS (real headway). MONOTONIC —
                           // unlike progressAt it is NOT reset when an escape fires or a route
                           // momentarily vanishes, so now-headwayAt is true continuous-stuck time.
        prevSx: null,      // steering low-pass: previous tick's (unnormalized) steer vector
        prevSy: null,
        escapeUntil: 0,    // ms: end of an active stuck-escape (relax soft fields)
        lastEscapeAt: 0,   // ms: when the current escape was triggered
        escapeStage: 0,    // 1 = gentle (relax+wander-kill), 2 = committed (thread-or-die)
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

// The line segment a moving bumper sweeps along its rail, as {ax,ay,bx,by}. A
// railed bumper is a small fast circle (radius ~10) whipping back and forth at
// ~2000px/s, so its instantaneous point is a poor thing to dodge — by the time a
// bot reacts to where it IS, it's already elsewhere. The bot must treat the whole
// rail (where it CAN be) as the hazard. The bumper rides from ~radius to ~railLen
// out from the rail origin along rail.angle (see engine.updateHazards).
function bumperSegment(h) {
    var rail = h.rail;
    var rad = rail.angle * Math.PI / 180;
    var dirX = Math.cos(rad), dirY = Math.sin(rad);
    var railLen = Math.sqrt(rail.lengthSq);            // = rail.width
    var near = Math.sqrt(h.lengthSq || 0) || 0;        // bumper's near-end reversal point
    return {
        ax: rail.x + dirX * near, ay: rail.y + dirY * near,
        bx: rail.x + dirX * railLen, by: rail.y + dirY * railLen
    };
}

// Nearest point on segment AB to P, returned as {x,y}.
function closestOnSegment(px, py, ax, ay, bx, by) {
    var abx = bx - ax, aby = by - ay;
    var len2 = abx * abx + aby * aby;
    if (len2 < 1e-6) { return { x: ax, y: ay }; }
    var t = ((px - ax) * abx + (py - ay) * aby) / len2;
    if (t < 0) { t = 0; } else if (t > 1) { t = 1; }
    return { x: ax + abx * t, y: ay + aby * t };
}

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

// Whether the gap is open for THIS bot to cross h's rail right now. Walks the
// bumper's deterministic future (constant sweep, reflecting at the rail ends)
// across the bot's exposure window — from entering the strike band to clearing
// its far side — and reports closed if the bumper can be within strike range of
// the bot's crossing point at any sampled moment of that window.
function railCrossingOpen(bot, h, dt, vFloor) {
    var rail = h.rail;
    var rad = rail.angle * Math.PI / 180;
    var dirX = Math.cos(rad), dirY = Math.sin(rad);
    var len = rail.width;
    var tB = (h.x - rail.x) * dirX + (h.y - rail.y) * dirY;     // bumper's rail param
    var tP = (bot.x - rail.x) * dirX + (bot.y - rail.y) * dirY; // bot's crossing param
    if (tP < 0) { tP = 0; } else if (tP > len) { tP = len; }
    // Perpendicular distance from the bot to the rail line.
    var perp = Math.abs((bot.x - rail.x) * dirY - (bot.y - rail.y) * dirX);
    // engine.updateHazards steps the rail param by speed*dt² per tick -> speed*dt px/s.
    var vBump = h.speed * dt;
    if (!(vBump > 0)) { return true; } // frozen bumper: nothing to time
    var vBot = mag(bot.velX, bot.velY);
    var floor = vFloor != null ? vFloor : RAIL_CROSS_SPEED;
    if (vBot < floor) { vBot = floor; }
    var tEnter = (perp - RAIL_STRIKE) / vBot;                    // first moment the bot is strikable
    if (tEnter < 0) { tEnter = 0; }
    var tExit = ((perp + RAIL_STRIKE) / vBot) * RAIL_CROSS_MARGIN; // bot fully clear of the band
    var dir = (h.angle === rail.angle) ? 1 : -1;
    // The longest gap this rail can offer ANYWHERE (crossing right at an end while
    // the bumper runs the full rail and back). If even that doesn't cover this
    // bot's exposure — slow ground — then no safe window exists at any crossing
    // point and waiting can never pay off (the old absolute check here was
    // unsatisfiable from the staging band, so staged bots sat until the stuck
    // beeline rammed them through). Dart instead: go right behind the receding
    // bumper while most of THIS pass's headroom remains — best effort, judged
    // relative to the best this pass can offer, so it actually fires once per
    // sweep at any ground speed (a glancing bump beats freezing).
    if (tExit >= (2 * (len - RAIL_STRIKE)) / vBump) {
        if ((tP - tB) * dir >= 0) { return false; } // still bearing down on the crossing point
        if (Math.abs(tP - tB) < RAIL_STRIKE) { return false; } // not clear of it yet
        var end = dir > 0 ? len : 0;
        var arm = Math.abs(end - tP); // run the bumper is heading into, from the crossing point
        var head = arm - RAIL_STRIKE; // headroom left at the moment the bumper CLEARS the point
        if (head <= 0) { return false; } // it reflects right back onto the point — wait for the other sweep
        var timeBack = (Math.abs(end - tB) + arm - RAIL_STRIKE) / vBump;
        // Judge against the most a post-clearance dart can ever have (2*head/vBump),
        // NOT a gap-0 ideal the clearance guard makes unreachable — that off-by-a-
        // strike-radius made the window ~0.1s and slow bots never caught it.
        return timeBack >= (2 * head / vBump) * RAIL_DART_FRACTION;
    }
    var t = tB;
    for (var s = 0; s <= tExit; s += RAIL_SAMPLE_STEP) {
        if (s >= tEnter && Math.abs(t - tP) < RAIL_STRIKE) { return false; }
        t += dir * vBump * RAIL_SAMPLE_STEP;
        if (t >= len) { t = len; dir = -1; }
        else if (t <= 0) { t = 0; dir = 1; }
    }
    return true;
}

// Dash-speed floor for the crossing prediction, from the ground under the bot:
// terminal speed on the tile (acel*dt/drag) times the engine's 0.8 bot-input
// scale. Slow tiles crawl (~17px/s) while fast tiles fly (~62px/s) — assuming one
// global dash speed opened windows on slow ground that weren't really safe.
function railDashFloor(bot, ctx) {
    var tile = TILE_BY_ID[nearestTileId(ctx, bot.x, bot.y)];
    if (!tile) { return RAIL_CROSS_SPEED; }
    var v = (tile.acel * (c.serverTickSpeed / 1000) / tile.dragCoeff) * 0.8;
    return v < 14 ? 14 : v;
}

// Sum of repulsion away from nearby bumpers/moving bumpers, scaled so it ramps
// up sharply as the bot closes on a hazard's strike range. Returns {x,y} (may be
// {0,0} when clear). A moving bumper (has a rail) is dodged from the closest point
// on the WHOLE swept segment — not its flickering instantaneous position — so the
// push stays a stable "stay off the track" vector instead of jittering as the
// bumper races back and forth, which is what let bots thread in and get clipped.
// EXCEPT when the bot's route actually crosses the rail: then the segment-as-wall
// would pin it there forever, so it times the gap instead (railCrossingOpen) —
// commit across while open, stage at the band edge and drift toward a rail end
// while closed.
function hazardRepulsion(bot, ctx, desiredX, desiredY, dt) {
    var rx = 0, ry = 0;
    var hazardList = ctx.hazardList;
    var vFloor = null; // computed lazily, once, only when a railed bumper is in play
    for (var id in hazardList) {
        var h = hazardList[id];
        if (h.alive === false) { continue; }
        var hx = h.x, hy = h.y;
        if (h.moveable && h.rail != null) {
            var seg = bumperSegment(h);
            var cp = closestOnSegment(bot.x, bot.y, seg.ax, seg.ay, seg.bx, seg.by);
            // Crossing intent: the desired heading drives INTO the rail (the route
            // continues on the other side). Only then does gap timing apply — a bot
            // merely skirting alongside keeps the plain stay-away field below.
            var nx = bot.x - cp.x, ny = bot.y - cp.y;
            var nd = mag(nx, ny);
            if (nd > 0.0001 && (desiredX * nx + desiredY * ny) / nd < -0.1) {
                if (vFloor == null) { vFloor = railDashFloor(bot, ctx); }
                // Committed dart in flight: once a window fires, hold the door open
                // for the whole estimated crossing. Without this latch a slow bot
                // re-evaluates every tick, the brief window flickers shut before it
                // has moved, and the wait wall shoves it right back out.
                var aiSt = bot.ai;
                var goKey = 'rg' + id;
                var nowMs = Date.now();
                if (aiSt && aiSt.railGo && aiSt.railGo[goKey] > nowMs) { continue; }
                if (railCrossingOpen(bot, h, dt, vFloor)) { // gap open: commit across
                    if (aiSt) {
                        if (aiSt.railGo == null) { aiSt.railGo = {}; }
                        var crossMs = ((nd + RAIL_STRIKE) / (vFloor < 14 ? 14 : vFloor)) * 1500; // 1.5x est. crossing time
                        aiSt.railGo[goKey] = nowMs + (crossMs > 8000 ? 8000 : crossMs);
                    }
                    continue;
                }
                // Gap closed: hold just outside the strike band so the dash is short
                // when it opens...
                var waitRange = RAIL_STRIKE + RAIL_WAIT_GAP;
                if (nd < waitRange) {
                    var ww = (waitRange - nd) / waitRange; // linear: a hard wall, not a soft field
                    rx += (nx / nd) * ww * RAIL_WAIT_STRENGTH;
                    ry += (ny / nd) * ww * RAIL_WAIT_STRENGTH;
                }
                // ...and drift toward the nearer rail END, where the bumper spends the
                // least time and the crossing windows are widest.
                if (nd < HAZARD_AVOID_RADIUS + waitRange) {
                    var radR = h.rail.angle * Math.PI / 180;
                    var ax = Math.cos(radR), ay = Math.sin(radR);
                    var tP = (bot.x - h.rail.x) * ax + (bot.y - h.rail.y) * ay;
                    var toEnd = (tP < h.rail.width / 2) ? -1 : 1;
                    rx += ax * toEnd * RAIL_END_SLIDE;
                    ry += ay * toEnd * RAIL_END_SLIDE;
                }
                continue;
            }
            hx = cp.x; hy = cp.y;
        }
        var dx = bot.x - hx, dy = bot.y - hy;
        var d = mag(dx, dy);
        var range = HAZARD_AVOID_RADIUS + (h.radius || 0) + BUMPER_DANGER_PAD;
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

// Tile id of the Voronoi cell containing (x,y) — i.e. the nearest site's id.
function nearestTileId(ctx, x, y) {
    var cells = ctx.map.cells;
    var best = Infinity, bestId = -1;
    for (var i = 0; i < cells.length; i++) {
        if (!cells[i] || !cells[i].site) { continue; }
        var s = cells[i].site;
        var dx = s.x - x, dy = s.y - y;
        var d = dx * dx + dy * dy;
        if (d < best) { best = d; bestId = cells[i].id; }
    }
    return bestId;
}
// True if the cell containing (x,y) is a death/no-go tile (lava, or an empty hole that
// bounces you off). Used by the predictive feelers to catch a momentum car about to
// slide off the path into lava or over a rim.
function isLavaAt(ctx, x, y) {
	var id = nearestTileId(ctx, x, y);
	return id === ctx.lavaId || id === ctx.emptyId;
}

function rotate(x, y, deg) {
    var r = deg * Math.PI / 180, cs = Math.cos(r), sn = Math.sin(r);
    return { x: x * cs - y * sn, y: x * sn + y * cs };
}

// Walk a feeler ray from the bot out to `reach`, sampling every ~FEELER_STEP px
// (capped at FEELER_MAX_SAMPLES). Returns the fraction [0..1] of `reach` at which
// lava first appears, or 1 if the ray is clear. Endpoint-only checks stepped over
// thin lava fingers narrower than the feeler (so the bot drove straight into them);
// stepping along the ray catches them, and the fraction lets callers tell "lava
// right here" from "lava far down the feeler".
function rayLavaFrac(bot, ctx, dirX, dirY, reach, maxSamples) {
    var steps = Math.ceil(reach / FEELER_STEP);
    if (steps < 1) { steps = 1; }
    var cap = maxSamples || FEELER_MAX_SAMPLES;
    if (steps > cap) { steps = cap; }
    for (var i = 1; i <= steps; i++) {
        var t = i / steps;
        if (isLavaAt(ctx, bot.x + dirX * reach * t, bot.y + dirY * reach * t)) { return t; }
    }
    return 1;
}

// Predictive avoidance: cast three feelers ahead along the bot's heading (center
// + two sides). If a feeler crosses lava, push perpendicular toward the clear side
// and flag a hard brake. Returns { x, y, brake } where x/y is a steer push.
function feelerAvoid(bot, ctx, headX, headY, speed) {
    var reach = FEELER_BASE + speed * FEELER_SPEED_K;
    var cap = FEELER_MAX;
    // On ice the kart can't brake or steer hard, so it needs to see lava much farther out.
    var onIce = bot.brakeCoeff < c.playerBrakeCoeff;
    var samples = onIce ? ICE_FEELER_SAMPLES : FEELER_MAX_SAMPLES;
    if (onIce) { reach *= ICE_FEELER_MULT; cap *= ICE_FEELER_MULT; }
    // Lightning round speeds everyone up — look farther ahead to keep control.
    if (ctx.lightning) { reach *= LIGHTNING_FEELER_MULT; cap *= LIGHTNING_FEELER_MULT; }
    if (reach > cap) { reach = cap; }
    // Risk: high-risk personalities use shorter feelers, cutting closer to lava.
    if (ctx.riskMult != null) { reach *= ctx.riskMult; }
    var px = 0, py = 0, brake = false;
    // Center feeler — lava anywhere ahead (within stopping distance) means slow down.
    if (rayLavaFrac(bot, ctx, headX, headY, reach, samples) < 1) {
        brake = true;
    }
    // Side feelers, slightly shorter. Lava on one side pushes toward the other.
    var sd = reach * 0.8;
    var lDir = rotate(headX, headY, FEELER_SIDE_DEG);
    var rDir = rotate(headX, headY, -FEELER_SIDE_DEG);
    var lFrac = rayLavaFrac(bot, ctx, lDir.x, lDir.y, sd, samples);
    var rFrac = rayLavaFrac(bot, ctx, rDir.x, rDir.y, sd, samples);
    var lLava = lFrac < 1, rLava = rFrac < 1;
    // Perpendicular to heading: right = (headY, -headX), left = (-headY, headX).
    if (lLava && !rLava) { px += headY; py += -headX; }        // push right
    else if (rLava && !lLava) { px += -headY; py += headX; }   // push left
    // Lava on BOTH sides only counts as "boxed in" (brake) when it's genuinely
    // close on both — otherwise it's just a corridor with walls a safe distance
    // off, and braking there would needlessly grind the bot to a crawl.
    else if (lLava && rLava && lFrac < FEELER_BOXED_NEAR && rFrac < FEELER_BOXED_NEAR) { brake = true; }
    return { x: px, y: py, brake: brake };
}

// --- Phase 4: combat + ability tunables ---
var SHOVE_PROBE = 42;       // px past a rival to check for lava (punch shoves them away from us)
var BOMB_THROW_RANGE = 340; // px: throw a bomb at a rival within this
var SWAP_RANGE = 280;       // px: only swap with a rival this near (and only when behind)
var CUT_RANGE = 78;         // px: cut when a rival is this close
var BOMB_MAX_HOLD = 2.6;    // s: detonate before the bomb's 3s auto-expire
var BOMB_LEAD_TIME = 0.35;  // s: lead a moving target by this much when aiming a thrown bomb
var SWAP_LAND_PROBE = 70;   // px: a swap leaves us on the target's ground — don't steal onto lava this close
var BLIND_HAZARD_PROBE = 60;// px: a rival is "in a pinch" for a blindfold if lava is this close to them
var GOAL_CONTEST_RANGE = 160;// px: a rival this near a goal tile is contesting the finish (good blindfold timing)
var PUNCH_MOMENTUM_MIN = 0.4; // min momentum-toward-target (as a fraction of a full-power
                              // charge) before a bot throws a routine offensive punch — so
                              // it commits to a closing hit instead of a weak standing tap

// --- Phase 5: brutal-round tunables ---
var BLIND_DRIFT_STEP = 7;       // deg/tick random-walk of the blind steering error
var BLIND_DRIFT_MAX = 55;       // deg: max veer off the intended line when blinded
var BLIND_THROTTLE = 0.72;      // speed factor while blinded (tentative)
var ZOMBIE_AVOID_RADIUS = 95;   // px: non-zombies steer away from zombies (contact infects)
var ZOMBIE_AVOID_STRENGTH = 2.1;
var PUCK_AVOID_RADIUS = 115;    // px: the hockey puck hits hard — give it room
var PUCK_AVOID_STRENGTH = 2.6;
// Telegraphed strike zones (Orbital Beam line, lava-explosion aimer): these mark
// ground that is ABOUT to become deadly (lava/burn), so a bot steers out of the
// marked area during the warn-up the same way it avoids live lava.
var TELEGRAPH_AVOID_MARGIN = 26;   // px clearance beyond the strike zone's edge
var TELEGRAPH_BEAM_STRENGTH = 2.8; // perpendicular push out of an Orbital Beam band
var TELEGRAPH_CIRCLE_STRENGTH = 2.6; // push away from a lava-explosion aimer center
var LIGHTNING_FEELER_MULT = 1.45; // see farther ahead when everyone's sped up
// Cost multipliers for routing through a bumper's cell — priced per hazard class.
// STATIC bumpers stay harsh (12): they sit on the spot forever and a route through
// one means getting knocked, so only a big detour saving justifies it. MOVING
// rails are mild (4): the bots can TIME a rail crossing (railCrossingOpen), so a
// rail cell just costs "a short wait + some risk". Lowering the static penalty
// along with the rail one made A* thread static-bumper fields (goldeyes,
// sidewinder) for modest detour savings — exactly the knock/stuck routes the
// penalty exists to prevent.
var HAZARD_PATH_PENALTY = 12;
var RAIL_PATH_PENALTY = 4;

var AB = c.tileMap.abilities;

function snap45(deg) {
    var d = Math.round(deg / 45) * 45;
    return ((d % 360) + 360) % 360;
}
function angleDeg(fromX, fromY, toX, toY) {
    return Math.atan2(toY - fromY, toX - fromX) * 180 / Math.PI;
}
function punchReady(bot) {
    // Respect the punch-stamina gate the same way checkAttack does, so a tired bot
    // doesn't keep setting attack on punches that the server will silently swallow.
    if (bot.staminaExhausted) { return false; }
    if (c.punchStamina != null && bot.stamina != null && bot.stamina < c.punchStamina.punchCost) { return false; }
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

// --- Telegraph-reasoning helpers: PREDICT an ability's effect and TIME its release
// for maximum impact, instead of firing on the first plain range gate. ---

// Straight-line distance from a player to the goal point a bot is pathing toward.
function goalDistOf(p, goal) { return goal == null ? Infinity : mag(goal.x - p.x, goal.y - p.y); }

// Rivals that are AHEAD of the bot in the race (closer to the goal), each tagged with
// its distance to the bot. Nearest-first. Empty when no goal is known (degrade safely).
function rivalsAhead(bot, ctx, goal) {
    var out = [];
    if (goal == null) { return out; }
    var mine = goalDistOf(bot, goal);
    for (var id in ctx.players) {
        var p = ctx.players[id];
        if (!isRacer(p, bot)) { continue; }
        if (goalDistOf(p, goal) >= mine) { continue; } // not ahead of us
        out.push({ player: p, dist: mag(p.x - bot.x, p.y - bot.y), goalDist: goalDistOf(p, goal) });
    }
    out.sort(function (a, b) { return a.dist - b.dist; });
    return out;
}
// The race LEADER among the bot's rivals (the rival closest to the goal) with its
// distance to the bot. null when there are no rivals. Falls back to the bot-nearest
// rival when no goal is known so callers still get a sensible target.
function raceLeader(bot, ctx, goal) {
    var best = null;
    for (var id in ctx.players) {
        var p = ctx.players[id];
        if (!isRacer(p, bot)) { continue; }
        var gd = goalDistOf(p, goal);
        var d = mag(p.x - bot.x, p.y - bot.y);
        if (best == null || gd < best.goalDist || (gd === best.goalDist && d < best.dist)) {
            best = { player: p, dist: d, goalDist: gd };
        }
    }
    return best;
}
// Where a moving target will be after `t` seconds at its current velocity. A thrown
// bomb persists (~3s) and its trigger watches for a rival entering the blast, so
// aiming at where the rival is HEADED keeps the bomb's line crossing their path.
function leadPoint(p, t) { return { x: p.x + (p.velX || 0) * t, y: p.y + (p.velY || 0) * t }; }

// True if (x,y) is on, or lava-adjacent within `probe` of, a lava cell (samples the
// containing cell plus 8 points one probe out). Used to keep abilities from putting
// the bot (swap landing) or judging a rival (blindfold) on safe vs. dangerous ground.
function lavaNear(ctx, x, y, probe) {
    if (isLavaAt(ctx, x, y)) { return true; }
    for (var a = 0; a < 360; a += 45) {
        var r = a * Math.PI / 180;
        if (isLavaAt(ctx, x + Math.cos(r) * probe, y + Math.sin(r) * probe)) { return true; }
    }
    return false;
}
// The point a held bomb should be thrown at to MAXIMIZE impact, lead-predicted by
// rival velocity. Preference order: a Nemesis bot's human; a CLUSTER centroid where
// the blast catches 2+ rivals at once; else the race LEADER; else the nearest rival.
// Only considers rivals inside BOMB_THROW_RANGE — returns null if none are in range
// (so the bomb stays held/telegraphed rather than wasted down an empty track).
function bombTarget(bot, ctx, goal) {
    var cands = [];
    for (var id in ctx.players) {
        var p = ctx.players[id];
        if (!isRacer(p, bot)) { continue; }
        if (mag(p.x - bot.x, p.y - bot.y) >= BOMB_THROW_RANGE) { continue; }
        cands.push(p);
    }
    if (cands.length === 0) { return null; }
    var blast = AB.bomb.explosionRadius;
    // Nemesis (focus 'human'): hunt the human first if one is in range.
    if (bot.ai && bot.ai.focus === 'human') {
        for (var hi = 0; hi < cands.length; hi++) {
            if (!cands[hi].isAI) { return leadPoint(cands[hi], BOMB_LEAD_TIME); }
        }
    }
    var leads = cands.map(function (p) { return leadPoint(p, BOMB_LEAD_TIME); });
    // Cluster: pick the lead-position whose blast catches the most rivals at once.
    var bestI = 0, bestCount = 0;
    for (var i = 0; i < leads.length; i++) {
        var n = 0;
        for (var j = 0; j < leads.length; j++) {
            if (mag(leads[i].x - leads[j].x, leads[i].y - leads[j].y) < blast) { n++; }
        }
        if (n > bestCount) { bestCount = n; bestI = i; }
    }
    if (bestCount >= 2) { return leads[bestI]; }
    // No cluster: aim at the LEADER (closest to goal) among candidates, else nearest.
    var li = 0, best = Infinity;
    for (var k = 0; k < cands.length; k++) {
        var score = goal != null ? goalDistOf(cands[k], goal) : mag(cands[k].x - bot.x, cands[k].y - bot.y);
        if (score < best) { best = score; li = k; }
    }
    return leads[li];
}
// Blindfold blinds the WHOLE room (the bot too, in effect), so it only pays off when
// the disruption lands harder on rivals than on us: the bot is on easy, open ground
// while at least one rival is in terrain where losing vision really hurts — hugging
// lava, or right on a contested goal. Otherwise bank it for the endgame.
function blindfoldWorthIt(bot, ctx, nav, goal) {
    if (nav.lavaAhead || nav.sharpTurn || nav.braking) { return false; } // bot itself in a pinch
    for (var id in ctx.players) {
        var p = ctx.players[id];
        if (!isRacer(p, bot)) { continue; }
        if (lavaNear(ctx, p.x, p.y, BLIND_HAZARD_PROBE)) { return true; }
        if (goalContested(ctx, p)) { return true; }
    }
    return false;
}
function goalContested(ctx, p) {
    var gt = ctx.goalTiles;
    if (!gt || gt.length === 0) { return false; }
    for (var i = 0; i < gt.length; i++) {
        if (mag(gt[i].x - p.x, gt[i].y - p.y) < GOAL_CONTEST_RANGE) { return true; }
    }
    return false;
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

// Sum of repulsion OUT of telegraphed strike zones (ground about to turn deadly).
// 'circle' zones (lava-explosion aimer) push radially away from the center like a
// hazard; 'beam' zones (Orbital Beam) push perpendicular toward the nearer edge of
// the band so the bot clears the line by the shortest route. The caster is immune to
// its own beam, so it doesn't avoid that one. Returns a steering contribution to add
// alongside the other repulsions.
function telegraphRepulsion(bot, telegraphs) {
    var ax = 0, ay = 0;
    for (var i = 0; i < telegraphs.length; i++) {
        var t = telegraphs[i];
        if (t.kind === 'circle') {
            var pr = pointRepulsion(bot, t.x, t.y, t.radius + TELEGRAPH_AVOID_MARGIN);
            ax += pr.x * TELEGRAPH_CIRCLE_STRENGTH; ay += pr.y * TELEGRAPH_CIRCLE_STRENGTH;
        } else if (t.kind === 'beam') {
            // The caster is NOT exempt from its own beam, so it dodges too (else it suicides).
            var vx = bot.x - t.x, vy = bot.y - t.y;
            var along = vx * t.dirX + vy * t.dirY;
            // Only inside the beam's length span (with a small cap margin) is dangerous.
            if (along < -TELEGRAPH_AVOID_MARGIN || along > t.length + TELEGRAPH_AVOID_MARGIN) { continue; }
            var perpX = -t.dirY, perpY = t.dirX;
            var across = vx * perpX + vy * perpY;
            var band = t.halfWidth + TELEGRAPH_AVOID_MARGIN;
            if (across > band || across < -band) { continue; } // already clear of the band
            var sign = across >= 0 ? 1 : -1;            // push toward the nearer edge
            var depth = 1 - Math.abs(across) / band;    // 0 at the edge .. 1 dead-center
            var strength = TELEGRAPH_BEAM_STRENGTH * (0.35 + 0.65 * depth);
            ax += perpX * sign * strength; ay += perpY * sign * strength;
        }
    }
    return { x: ax, y: ay };
}

// Is the bot currently "blinded" — blackout round, an active blindfold, or sitting
// under a cloud? Bots read game state (not pixels), so without this they'd be
// immune; the self-handicap makes vision effects bite the AI as they bite a human.
function isBlinded(bot, ctx, now) {
    if (ctx.blackoutActive) { return true; }
    // A starred bot mirrors the starred human: the blindfold overlay is skipped
    // for a Star Power holder client-side, so don't self-handicap here either.
    if (ctx.visionBlockedUntil > now && !(bot.starPowerUntil > now)) { return true; }
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
// Face a punch target before swinging — the punch is omnidirectional, but the
// stored facing drives the clash-facing check (so a bot has to commit toward a
// rival to clash with their swing).
function facePunch(bot, x, y) { bot.angle = angleDeg(bot.x, bot.y, x, y); }

// Punches now fire on RELEASE (checkAttack charges while attack is held, throws when it
// drops). So a bot can't just hold attack=true — it would charge forever and never throw.
// botPunch holds the button for holdMs (0 = a tap that releases next tick) and records the
// release time; decideAttack's manager drops attack when it's reached. Keep this OFF the
// ability-fire paths (abilities fire instantly on press, not on a charge).
function botPunch(bot, holdMs) {
    bot.attack = true;
    bot.ai.punchHoldUntil = Date.now() + (holdMs || 0);
    // steerBot rewrites bot.angle to the movement direction every tick, but the punch
    // fires on the release tick (where decideAttack's manager returns early before any
    // facePunch). Lock the facing now (facePunch already set bot.angle toward the target)
    // so the clash-facing check on the thrown punch sees a committed approach.
    bot.ai.punchAngle = bot.angle;
}

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
            facePunch(bot, prey.player.x, prey.player.y); botPunch(bot, 0); return true;
        }
        return false; // not in range — the chase is handled in steering
    }
    if (ctx.infection && !bot.isZombie) {
        var z = nearestMatch(bot, ctx.players, isZombieP);
        if (z != null && z.dist < c.punchRadius + bot.radius + z.player.radius + 8) {
            facePunch(bot, z.player.x, z.player.y); botPunch(bot, 0); return true; // knock the zombie back
        }
    }
    if (ctx.hockey && ctx.puck != null) {
        if (mag(ctx.puck.x - bot.x, ctx.puck.y - bot.y) < c.punchRadius + bot.radius + (ctx.puck.radius || 0) + 8) {
            facePunch(bot, ctx.puck.x, ctx.puck.y); botPunch(bot, 0); return true; // clear the puck off us
        }
    }
    return false;
}

// Decide whether to fire the held ability this tick; may set bot.angle (snapped to
// the 8-way the engine's clampPlayerAngle requires) and bot.attack.
function decideAbility(bot, ctx, ability, nav) {
    var id = ability.id;
    // A held ability fires on attack, so it blocks the bare-handed swim stroke. When the
    // bot is on water or about to enter it, deploy the ability NOW rather than carry it in
    // and crawl — spending it (even a harmless fizzle with no target) clears bot.ability so
    // the next tick the bot can punch-swim. Prioritising the ability before the crossing is
    // the intended behaviour (the operator's call), so this overrides the usual patient hold.
    var waterImminent = bot.onWater === true || (nav && nav.waterAhead === true);

    if (id === AB.bombTrigger.id) {
        // Two-step bomb: detonate when a rival is inside the blast, just before the bomb
        // auto-expires (so the trigger isn't wasted), or before a water crossing (a held
        // trigger blocks the swim stroke too).
        var bomb = ctx.projectileList[bot.id];
        var held = (Date.now() - (bot.ai.bombFiredAt || 0)) / 1000;
        if (bomb == null) { bot.attack = true; return; } // bomb gone — clear the trigger
        if (nearestRivalToPoint(bomb.x, bomb.y, ctx.players, bot) < AB.bomb.explosionRadius * 0.9) { bot.attack = true; return; }
        if (held > BOMB_MAX_HOLD || waterImminent) { bot.attack = true; }
        return;
    }
    // Abilities persist the whole round, so bots HOLD them like a patient human —
    // banking the ability and spending it only when there's a real reason, not on a
    // short timer. Three gates:
    //   armed   — a brief anti-twitch floor so a bot doesn't fire the literal instant
    //             it grabs one; opportunistic plays (bomb a rival, cut a neighbour)
    //             still fire soon after, but never on frame one.
    //   endgame — "use it or lose it": once the floor starts collapsing the round is
    //             wrapping up, so a banked ability is deployed at the next safe chance
    //             rather than carried into oblivion. This is the usual trigger for a
    //             situational ability that never found its moment.
    //   forced  — a long patience cap (tens of seconds) as a last-resort fallback for
    //             a quiet round that somehow never collapses, so nothing is wasted.
    var held = nav.held || 0;
    var tempo = bot.ai.abilityTempo;
    var minHold = 2 + (1 - tempo) * 4;     // ~2s (eager) .. ~6s (hoarder): anti-twitch floor
    var maxHold = 30 + (1 - tempo) * 60;   // ~30s (eager) .. ~90s (hoarder): patience cap
    var armed = held >= minHold;
    var endgame = ctx.collapsing === true; // round ending -> deploy now or waste it
    // waterImminent forces deployment for the same reason endgame does: a held ability would
    // otherwise be carried into water and block the swim stroke (see waterImminent above).
    var forced = endgame || held > maxHold || waterImminent;
    var goal = bot.ai.goal;
    var rank = goalRank(bot, ctx.players, goal);
    var racers = countRacers(ctx.players);
    var behind = racers > 1 && rank >= 1;  // at least one rival is ahead of us
    var aimAhead = function () { bot.angle = snap45(Math.atan2(bot.targetDirY, bot.targetDirX) * 180 / Math.PI); };
    // A straight, fast stretch with no brake/lava — the only time a self speed boost
    // is worth spending (and even then only when it actually helps; see below).
    var openRunway = !nav.lavaAhead && !nav.sharpTurn && !nav.braking;

    if (id === AB.bomb.id) {
        // TIME the throw for impact rather than firing at the first rival in range:
        // aim where the blast catches the most rivals (a cluster) or the race leader,
        // lead-predicted for a moving target (see bombTarget).
        var btgt = bombTarget(bot, ctx, goal);
        if (btgt != null && armed) {
            bot.angle = snap45(angleDeg(bot.x, bot.y, btgt.x, btgt.y));
            bot.attack = true; bot.ai.bombFiredAt = Date.now();
        } else if (forced) {
            // No target in range — lob it down the track to lay slow tiles ahead.
            aimAhead(); bot.attack = true; bot.ai.bombFiredAt = Date.now();
        } else {
            // Still holding: telegraph the threat by pointing the bomb at our
            // preferred target (Nemesis -> human) so a held bomb reads as a deliberate
            // aimed threat and pressures the rival, instead of spinning with our
            // steering. Facing only — movement uses targetDirX/Y.
            var preB = preferredTarget(bot, ctx);
            if (preB != null) { bot.angle = snap45(angleDeg(bot.x, bot.y, preB.player.x, preB.player.y)); }
        }
        return;
    }
    if (id === AB.swap.id) {
        // STEAL the lead, deliberately: only swap when behind (a random-target swap
        // while leading risks giving away the lead, so never force it while in front).
        // Time it for when the race LEADER is within the swap's catch radius AND their
        // ground is safe to inherit — don't steal onto lava-adjacent ground we'd die
        // on or be instantly re-passed from. Endgame still forces it so it isn't wasted.
        if (rank >= 1) {
            var leadS = raceLeader(bot, ctx, goal);
            var landingSafe = leadS != null && !lavaNear(ctx, leadS.player.x, leadS.player.y, SWAP_LAND_PROBE);
            // Require a live swap target even when forced: if we're only "behind"
            // because a rival already finished (raceLeader -> null), forcing a swap
            // just arms a warning aimer that fizzles with no one to steal from.
            if (leadS != null && (forced || (leadS.dist < SWAP_RANGE && armed && landingSafe))) { bot.attack = true; }
        } else if (waterImminent) {
            // LEADING (rank 0) and about to swim: the "never give away the lead" guard above
            // would bank the swap, but a held ability blocks the swim stroke, so spend it
            // before the crossing rather than crawl across. Fizzles harmlessly if there's no
            // one to steal from; either way it clears the ability so the bot can stroke.
            bot.attack = true;
        }
        return;
    }
    if (id === AB.cut.id) {
        // Shove nearby rivals aside (perpendicular to facing); aim along travel.
        var nrc = nearestRival(bot, ctx.players);
        var range = forced ? CUT_RANGE * 2 : CUT_RANGE;
        if (nrc != null && nrc.dist < range && (armed || forced)) {
            aimAhead(); bot.attack = true;
        } else if (nrc != null) {
            // Still holding it: point the on-screen Cut beam AT the nearest rival
            // (8-way snapped) instead of letting it spin with the bot's steering, so
            // a held Cut reads as a deliberate threat lined up on a target rather
            // than a wandering line. Facing only — movement uses targetDirX/Y.
            bot.angle = snap45(angleDeg(bot.x, bot.y, nrc.player.x, nrc.player.y));
        }
        return;
    }
    if (id === AB.speedDebuff.id) {
        // Slows ALL rivals — time it for max catch-up value: a rival (ideally a
        // cluster of them) is AHEAD of us and near, so the slow bites the racers we
        // actually need to reel in. A runaway leader with no one ahead banks it for
        // the collapse instead of wasting it on rivals already behind.
        var aheadD = rivalsAhead(bot, ctx, goal);
        var aheadNear = 0;
        for (var ai2 = 0; ai2 < aheadD.length; ai2++) { if (aheadD[ai2].dist < BOMB_THROW_RANGE) { aheadNear++; } }
        if ((armed && behind && aheadNear >= 1) || forced) { bot.attack = true; }
        return;
    }
    if (id === AB.speedBuff.id) {
        // Self speed boost: bank it until it actually wins ground — a straightaway
        // while CHASING (behind) — or the endgame dash; a leader holds it. Forced
        // fallback still avoids boosting into lava.
        if ((behind && openRunway && armed) || (forced && !nav.lavaAhead)) { bot.attack = true; }
        return;
    }
    if (id === AB.iceCannon.id) {
        // Self-boost + ice the lane ahead: same chase/endgame timing as speedBuff.
        if ((behind && openRunway && armed) || (forced && !nav.lavaAhead)) { aimAhead(); bot.attack = true; }
        return;
    }
    if (id === AB.blindfold.id) {
        // Room-wide blind: best when a human rival is in play and the bot isn't out
        // front, AND the disruption lands harder on rivals than on the bot itself —
        // the bot is on easy ground while a rival is in a hazard pinch (lava edge /
        // contested goal). Otherwise bank it until the round's wrapping up.
        if ((hasHumanRival(bot, ctx.players) && rank >= 1 && armed && blindfoldWorthIt(bot, ctx, nav, goal)) || forced) { bot.attack = true; }
        return;
    }
    if (id === AB.tileSwap.id) {
        // Map-wide chaos: best when behind, but use it before the round's out.
        if ((rank >= 2 && armed) || forced) { bot.attack = true; }
        return;
    }
    if (id === AB.starPower.id) {
        // Invulnerability pays off when CONTESTED: a rival close enough to punch or
        // shove us (plow through them untouchable), or as armor for the endgame
        // collapse scramble. A bot cruising alone banks it.
        var nrs = nearestRival(bot, ctx.players);
        if ((armed && nrs != null && nrs.dist < CUT_RANGE * 1.5) || forced) { bot.attack = true; }
        return;
    }
    if (id === AB.orbitalBeam.id) {
        // Lock a 5s damage line down the track: it's an area-denial / threat play, so
        // line it up on the nearest rival (the beam's locked at cast, so aim where they
        // ARE) and fire when armed with one in range, or lay it down the lane if forced.
        // While holding, point the telegraphed aim at that rival so it reads as a threat.
        var nro = nearestRival(bot, ctx.players);
        if ((nro != null && nro.dist < BOMB_THROW_RANGE && armed) || forced) {
            if (nro != null) { bot.angle = snap45(angleDeg(bot.x, bot.y, nro.player.x, nro.player.y)); }
            else { aimAhead(); }
            bot.attack = true;
        } else if (nro != null) {
            bot.angle = snap45(angleDeg(bot.x, bot.y, nro.player.x, nro.player.y));
        }
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

// Fraction (0..1) of a full-power punch the bot's CURRENT velocity would earn —
// raw speed magnitude over the same reference speed Player.calcPunchBonus uses.
// Punches are radial, so any motion contributes (no aim to project onto).
function momentumFrac(bot) {
    if (c.punchMomentum == null) { return 1; }
    var ref = bot.maxVelocity * c.punchMomentum.refFrac;
    if (ref <= 0) { return 0; }
    return Math.min(1, mag(bot.velX, bot.velY) / ref);
}

// How long to hold a charge (ms); 0 = a quick tap. A committed haymaker is held to a
// strong depth but ALWAYS released with a wide margin before the overcharge danger line,
// so a bot can never charge itself into the exhaustion lock. Only commit from a near-full
// bar (a charge spends most of it), on a real closing line, and not while we need our
// mobility (fleeing a collapse, or braking at a lava edge).
function chargeHoldFor(bot, ctx, nr) {
    if (c.punchCharge == null) { return 0; }
    var fullBar = c.punchStamina ? c.punchStamina.fullChargeCost : 100;
    var commit = !(ctx && ctx.collapsing) && !bot.braking
        && bot.stamina != null && bot.stamina >= fullBar * 0.85
        && bot.ai.aggression >= 0.5
        && momentumFrac(bot) >= 0.7;
    if (!commit) { return 0; }
    var depth = 0.65 + 0.3 * bot.ai.aggression;          // 0.65 .. 0.95 of a full charge
    var holdMs = depth * c.punchCharge.maxChargeMs;
    // Hard safety: never get near the overcharge threshold (leave a wide margin).
    var safeCap = Math.min(c.punchCharge.maxChargeMs, c.punchCharge.overchargeAfterMs - 700);
    return Math.max(0, Math.min(holdMs, safeCap));
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
    // Bunker (battle royale): the whole point is to kill, not race. Bots fight far
    // more readily — routine punches need much less aggression, and a guaranteed
    // shove into the closing ring bypasses the burst cooldown entirely (otherwise
    // they'd stand around waiting out refractory while a free kill is right there).
    var buriedBR = (ctx.bunkerSafeIds != null);
    // A free shove into the lava is always worth it; routine aggression only in bursts.
    if (!shove && bot.ai.aggression < (buriedBR ? 0.3 : 0.6)) { return; }
    if (!(buriedBR && shove) && !offensiveCombatAllowed(bot, Date.now())) { return; }
    // Momentum-aware timing: punch power scales with speed, so for a routine
    // offensive punch the bot holds the swing until it's actually moving fast enough
    // to land a real hit — not a limp standing tap. A free lava shove (about position,
    // not power) and a point-blank defensive jab still go through regardless.
    if (!shove) {
        var pointBlank = nr.dist < (bot.radius + nr.player.radius + 2);
        if (!pointBlank && momentumFrac(bot) < PUNCH_MOMENTUM_MIN) { return; }
    }
    facePunch(bot, nr.player.x, nr.player.y);
    // Charge a committed haymaker on a strong closing line (held safely below overcharge),
    // otherwise a quick tap. Charging holds attack across ticks — the decideAttack manager
    // releases it; the throw cost/charge size is finalised server-side.
    botPunch(bot, chargeHoldFor(bot, ctx, nr));
}

// Defensive counter: swing back at a REAL incoming punch. Scans live punches for a
// rival's punch that's close and aimed at the bot, then punches toward that attacker
// so the two clash (and the heavier committer eats their own momentum). Reacting to an
// actual punch — not merely a rival that happens to face the bot — keeps the bot from
// burning its stamina on speculative counters against rivals who never swing.
// Cooldown + stamina gated via punchReady.
function decideCounter(bot, ctx) {
    if (ctx.punches == null || c.punchClash == null) { return false; }
    if (!punchReady(bot)) { return false; }
    var cfg = c.punchClash;
    for (var oid in ctx.punches) {
        if (oid == bot.id) { continue; } // not our own punch
        var pn = ctx.punches[oid];
        if (pn == null || pn.mapOwned || pn.clashResolved || pn.landed || pn.ownerInfected) { continue; }
        var attacker = ctx.players[pn.ownerId];
        if (attacker == null || !isRacer(attacker, bot)) { continue; }
        var dx = bot.x - attacker.x, dy = bot.y - attacker.y;
        var d = mag(dx, dy);
        if (d === 0 || d > cfg.range) { continue; }
        // The attacker has to be heading toward us for this to be a real incoming threat
        // (the same facingDot the clash check uses on the server). Skip drive-by swings.
        var rr = (pn.angle || 0) * Math.PI / 180;
        if (Math.cos(rr) * (dx / d) + Math.sin(rr) * (dy / d) < cfg.facingDot) { continue; }
        // Don't counter into a losing clash: if the incoming punch is clearly stronger
        // than the tap we could swing back (stronger wins), a counter just loses and
        // wastes stamina — better to eat it / let steering carry us clear.
        if (c.punchMomentum != null) {
            var mm = c.punchMomentum;
            var ourTap = mm.floor + (mm.ceil - mm.floor) * momentumFrac(bot);
            if (pn.getBonus() > ourTap + cfg.tieMargin) { continue; }
        }
        facePunch(bot, attacker.x, attacker.y);
        botPunch(bot, 0); // quick reactive jab
        return true;
    }
    return false;
}

// A tap punch brakes ~55% of your velocity, so it doubles as an emergency stop. This
// fires when a bot is sliding fast on ICE (reduced grip) toward lava with its steering
// fighting its momentum (trying to turn away but skating in anyway) — the classic
// "slide off the ice into the lava" death that normal braking can't save. The tap kills
// the slide so the steering can redirect. Bare-handed only (a held ability would fire
// instead of braking) and stamina/cooldown gated like any punch.
function emergencyBrakeNeeded(bot) {
    if (bot.brakeCoeff >= c.playerBrakeCoeff) { return false; } // not on a slippery tile
    var speed = mag(bot.velX, bot.velY);
    if (speed < bot.maxVelocity * 0.45) { return false; }       // not sliding fast enough to matter
    var tlen = mag(bot.targetDirX, bot.targetDirY);
    if (tlen < 1e-3) { return true; }                           // no escape heading + lava ahead -> stop
    var dot = (bot.velX * bot.targetDirX + bot.velY * bot.targetDirY) / (speed * tlen);
    return dot < 0.4;                                           // momentum badly off our intended line
}

// Drift: holding a punch charge ON ICE blends grip toward normal terrain
// (Player.handleMapCellHit, c.iceDrift.grip) — the same trick humans use. A bot
// starts a drift hold when it's skating off its intended line on ice WITHOUT the
// lava emergency (that path wants the instant tap's throw-brake, not grip): the
// traction applies for the whole hold, steering comes back, and the decideAttack
// manager releases early once momentum is back on line or the ice ends. Looser
// misalignment gate than emergencyBrakeNeeded — drifting is routine control,
// braking is a panic stop.
var DRIFT_HOLD_MS = 1200; // well clear of the 2000ms overcharge line
function driftHoldNeeded(bot, nav) {
    if (c.iceDrift == null || !bot.onIce || bot.isZombie) { return false; }
    if (nav && nav.lavaAhead) { return false; }                 // emergency tap path owns that
    var speed = mag(bot.velX, bot.velY);
    if (speed < bot.maxVelocity * 0.25) { return false; }       // crawling: steering alone is enough
    var tlen = mag(bot.targetDirX, bot.targetDirY);
    if (tlen < 1e-3) { return false; }                          // nowhere we're trying to go
    var dot = (bot.velX * bot.targetDirX + bot.velY * bot.targetDirY) / (speed * tlen);
    return dot < 0.7;                                           // sliding off our line -> dig in
}
// A drifting bot has regained its line (or slowed to a crawl): the grip did its job.
function driftRecovered(bot) {
    var speed = mag(bot.velX, bot.velY);
    if (speed < bot.maxVelocity * 0.15) { return true; }
    var tlen = mag(bot.targetDirX, bot.targetDirY);
    if (tlen < 1e-3) { return false; }
    var dot = (bot.velX * bot.targetDirX + bot.velY * bot.targetDirY) / (speed * tlen);
    return dot > 0.85;
}

// Top-level per-tick combat decision: fire the held ability, else consider a punch.
function decideAttack(bot, ctx, nav) {
    // Manage an in-progress punch hold (charge): hold the button (and keep the locked
    // aim, since steerBot just overwrote bot.angle) until the planned release, then drop
    // it so checkAttack throws the punch on the falling edge. This is what makes a bot
    // RELEASE — without it a bot that keeps wanting to punch would charge forever.
    if (bot.ai.punchHoldUntil != null) {
        // Bail out of a charge hold if survival or an ability now takes over: release the
        // button so checkAttack throws the (partial) charge — the throw-brake doubles as
        // the ice-stop — instead of skating into lava or firing a just-grabbed ability via
        // the still-held attack.
        if (bot.ability != null || (nav && nav.lavaAhead && emergencyBrakeNeeded(bot))) {
            bot.ai.punchHoldUntil = null;
            bot.ai.driftHold = false;
            bot.attack = false;
            return;
        }
        if (bot.ai.driftHold) {
            // Drift hold: facing stays with steering (the eventual throw is incidental,
            // not an aimed swing), and the hold ends EARLY once the grip has done its
            // job — momentum back on our line — or the ice ends under us.
            if (!bot.onIce || driftRecovered(bot)) {
                bot.ai.punchHoldUntil = null;
                bot.ai.driftHold = false;
                bot.attack = false; // release: the eased ice throw-brake scrubs the rest
                return;
            }
        } else {
            bot.angle = bot.ai.punchAngle;
        }
        if (Date.now() < bot.ai.punchHoldUntil) { bot.attack = true; return; } // still charging
        bot.ai.punchHoldUntil = null;
        bot.ai.driftHold = false;
        bot.attack = false; // release -> throw on the locked aim
        return;
    }
    bot.attack = false;
    // Survival first: tap to brake out of an ice slide into lava before anything else.
    if (nav && nav.lavaAhead && bot.ability == null && punchReady(bot) && emergencyBrakeNeeded(bot)) {
        botPunch(bot, 0);
        return;
    }
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
    // Swimming: on deep water the passive drive barely moves the kart — the only real
    // propulsion is a STROKE, which is just a bare-handed punch (throwChargedPunch's water
    // branch converts it to swimImpulse in the held direction). A human strokes by holding a
    // move key; a bot has none, so stroke toward its steer vector (targetDirX/Y, the path
    // carrot) — the same direction it's already trying to swim. A quick tap (holdMs 0) = one
    // stroke; we don't charge, since hoarding stamina mid-water and resting between strokes
    // (cooldown/stamina-gated, like a human) keeps drag from ever fully stalling the crossing.
    // Kept above combat so a bot commits to crossing instead of dithering on open water; the
    // stroke still shoves any rival it lands on, exactly as a human swim stroke does.
    if (bot.onWater && punchReady(bot)) {
        var swimM = mag(bot.targetDirX, bot.targetDirY);
        if (swimM > 0.0001) {
            facePunch(bot, bot.x + bot.targetDirX, bot.y + bot.targetDirY);
            botPunch(bot, 0);
            return;
        }
    }
    // Ice drift: skating off our line (no lava emergency) -> hold the charge for grip
    // instead of tapping. Bare-handed only (an ability would fire on the press) and
    // stamina/cooldown gated like any punch; the hold manager above releases it.
    if (punchReady(bot) && driftHoldNeeded(bot, nav)) {
        botPunch(bot, DRIFT_HOLD_MS);
        bot.ai.driftHold = true;
        return;
    }
    if (decideCounter(bot, ctx)) { return; }
    decidePunch(bot, ctx);
}

function steerBot(bot, ctx, dt) {
    var ai = bot.ai || (bot.ai = newBotState(bot.profile));

    // --- Anti-stuck probe: hold an anchor at the last spot the bot made real
    // headway from. While it loiters within STUCK_RADIUS of that anchor (crawling
    // in place, or circling tighter than that radius), clock the time; the moment it
    // breaks STUCK_RADIUS it's made real headway, so re-anchor AND end any escape /
    // reset the escalation (the next pinch starts fresh at the gentle stage). Loiter
    // past STUCK_TRIGGER and the bot is wedged — typically over-cautious soft-field
    // repulsion stalling it at a narrow gap (the "line up at the 1px pinch and wait"
    // failure). Open an escape window (stage 1 gentle; stage 2 committed only if a
    // PRIOR escape that wasn't cleared by real progress re-fires); the steer code
    // below relaxes the SOFT lava field + drops the wobble so it threads the gap,
    // while the hard ray-sampled feeler brake still guards against driving INTO lava.
    // (Zombies skip this — they ignore the goal and chase prey.) ---
    var nowProbe = Date.now();
    var escaping = false, committed = false, beelining = false;
    if (!bot.isZombie) {
        if (ai.headwayAt == null) { ai.headwayAt = nowProbe; }
        if (ai.progressAnchor == null || mag(bot.x - ai.progressAnchor.x, bot.y - ai.progressAnchor.y) > STUCK_RADIUS) {
            ai.progressAnchor = { x: bot.x, y: bot.y };
            ai.progressAt = nowProbe;
            ai.headwayAt = nowProbe; // real headway -> reset the continuous-stuck clock
            ai.escapeUntil = 0; ai.escapeStage = 0; ai.lastEscapeAt = 0; // real headway -> escape over
        } else if ((nowProbe - ai.progressAt) / 1000 >= STUCK_TRIGGER && nowProbe >= ai.escapeUntil &&
            mag(bot.velX, bot.velY) < STUCK_SPEED_MAX) {
            // Re-triggering after a previous escape that real progress never cleared
            // means the gentle approach didn't free it -> escalate the push (keyed off
            // lastEscapeAt, which only survives if no re-anchor reset it — so a different,
            // freshly-reached pinch starts at 1). 1 gentle -> 2 committed -> stays 2.
            ai.escapeStage = (nowProbe - ai.lastEscapeAt) <= ESCAPE_ESCALATE_WINDOW ? 2 : 1;
            ai.lastEscapeAt = nowProbe;
            ai.escapeUntil = nowProbe + ESCAPE_MS;
            ai.progressAnchor = { x: bot.x, y: bot.y };
            ai.progressAt = nowProbe;
        }
        escaping = nowProbe < ai.escapeUntil;
        committed = escaping && ai.escapeStage === 2;
        // Final ladder rung: stuck (no real headway) past BEELINE_AFTER_MS regardless of
        // the soft/committed escape — it's sealed in. The steer below abandons the path
        // and beelines the nearest goal with avoidance off (thread out, or die clearing it).
        // Not during a collapse — there the no-path branch already flees toward the safe
        // center (collapseLoc), which beats charging a goal tile with lava avoidance off
        // into the advancing collapse front.
        beelining = !ctx.collapsing && (nowProbe - ai.headwayAt) >= BEELINE_AFTER_MS;
    }

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
            penaltySet: ctx.staticHazardCells, // route AROUND static bumpers (harsh soft penalty)
            penaltyMult: HAZARD_PATH_PENALTY,
            penaltySet2: ctx.railCells, // moving rails are timeable — mild penalty
            penaltyMult2: RAIL_PATH_PENALTY
        };
        // Bunker round: the goal is buried (no goal tiles), so home the A* on the
        // safe bunker island instead — otherwise findPathToNearestGoal returns null
        // and the bot just sits there.
        if (ctx.bunkerSafeIds != null) { pathOpts.goalSet = ctx.bunkerSafeIds; }
        var route = cellGraph.findPathToNearestGoal(ctx.map, { x: bot.x, y: bot.y }, pathOpts);
        // If the danger ring walled us off, retry without it so we still aim at a
        // goal (better a tight line than freezing in front of the lava). Keep the
        // hazard penalty on the retry — it's soft, so it never nulls the path.
        if (route == null && blocked != null) {
            route = cellGraph.findPathToNearestGoal(ctx.map, { x: bot.x, y: bot.y }, { noiseSeed: ai.pathSeed, noiseAmount: pathOpts.noiseAmount, penaltySet: ctx.staticHazardCells, penaltyMult: HAZARD_PATH_PENALTY, penaltySet2: ctx.railCells, penaltyMult2: RAIL_PATH_PENALTY, goalSet: pathOpts.goalSet });
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
    } else if (beelining && ctx.goalTiles && ctx.goalTiles.length > 0) {
        // No path AND stuck for BEELINE_AFTER_MS: it's sealed off (the goal is lava-walled
        // from here and a re-path will keep returning null). Don't keep holding — that's
        // exactly the off-terrain corner freeze where the bot never moves and never dies.
        // The unconditional beeline override below points `desired` straight at the nearest
        // goal (with avoidance off) to thread out or die clearing it; just don't fall into
        // the hold/return branch here.
    } else {
        // No path and not collapsing: hold position (don't drive blindly). A walled
        // bot isn't "stuck at a pinch", so clear any charging escape and re-anchor
        // here — otherwise it would silently escalate to a committed launch the
        // instant a route reappears, firing it off a standstill with brakes off.
        // (headwayAt is left alone — it's the monotonic clock that eventually trips
        // the beeline above for a bot that's genuinely sealed in here.)
        ai.escapeUntil = 0; ai.escapeStage = 0; ai.lastEscapeAt = 0;
        ai.progressAnchor = { x: bot.x, y: bot.y }; ai.progressAt = nowProbe;
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
    // While escaping a stuck spot, drop the random wobble — a low-skill bot's
    // wander is what keeps shoving it into the wall it's trying to thread.
    if (escaping && ESCAPE_WANDER_KILL) { ai.wander *= 0.5; }
    else if (wobble > 0.02) {
        var rw = rotate(desiredX, desiredY, ai.wander);
        desiredX = rw.x; desiredY = rw.y;
    }
    // Risk: tighter lines hug the lava (corner-cutting); cautious bots keep clear.
    ctx.riskMult = 1 - 0.45 * ai.risk;

    // A last-resort beeline overrides the path/carrot heading and points STRAIGHT at the
    // nearest goal, so a bot sealed in a corner drives decisively out (or into the walling
    // lava). Avoidance is turned off just below so nothing bends it back into the pocket.
    if (beelining && ctx.goalTiles && ctx.goalTiles.length > 0) {
        var ngb = nearestGoalPoint(bot.x, bot.y, ctx.goalTiles);
        var bgx = ngb.x - bot.x, bgy = ngb.y - bot.y, bgm = mag(bgx, bgy) || 1;
        desiredX = bgx / bgm; desiredY = bgy / bgm;
    }

    // --- Avoidance: predictive feelers (primary) + soft fields (secondary) ---
    // Heading the feelers look along: actual velocity when moving, else desired.
    var headX = desiredX, headY = desiredY;
    if (speed > 5) { headX = bot.velX / speed; headY = bot.velY / speed; }

    // Water entry sniff: if water lies just ahead along our heading (and we're not in it
    // yet), flag it so decideAttack/decideAbility can spend a banked ability BEFORE the
    // crossing — a held ability fires on attack, so it would otherwise block the swim
    // stroke and leave the bot crawling/stalling in the water.
    var waterAhead = false;
    if (!bot.onWater && ctx.waterId != null && ctx.waterId !== -999 && bot.ability != null) {
        var wlook = WATER_ENTRY_LOOKAHEAD + speed * 0.5;
        if (nearestTileId(ctx, bot.x + headX * wlook, bot.y + headY * wlook) === ctx.waterId) { waterAhead = true; }
    }

    // Zombies don't die on lava (and ignore the collapse) — they cut straight across it
    // to chase prey, so a zombie turns OFF all lava avoidance. A beelining bot likewise
    // wants no avoidance bending its decisive line (it has been frozen for seconds).
    var ignoreLava = bot.isZombie === true || beelining;
    var fl = ignoreLava ? { x: 0, y: 0, brake: false } : feelerAvoid(bot, ctx, headX, headY, speed);
    var hz = beelining ? { x: 0, y: 0 } : hazardRepulsion(bot, ctx, desiredX, desiredY, dt);
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
    // Steer out of telegraphed strike zones (Orbital Beam line / lava-explosion aimer).
    // Zombies are immune to the beam's lava-burn and beeliners want an undiluted line, so
    // both skip it; a Star Power holder is immune too, so it doesn't bother dodging.
    if (!beelining && !bot.isZombie && ctx.telegraphs && ctx.telegraphs.length &&
        !(bot.starPowerUntil != null && bot.starPowerUntil > Date.now())) {
        var tg = telegraphRepulsion(bot, ctx.telegraphs);
        exX += tg.x; exY += tg.y;
    }

    var lavaW = LAVA_AVOID_STRENGTH * (ctx.riskMult != null ? ctx.riskMult : 1);
    // While escaping, relax the soft lava-centering field so the bot can hug a wall
    // to thread a narrow gap (the feeler brake still stops it driving INTO lava).
    if (escaping) { lavaW *= ESCAPE_LAVA_RELAX; }
    // Stage-2 commit also leans off the feeler push so the steer points toward the
    // route exit (desired/carrot) rather than being bent back into the pocket.
    var feelerW = committed ? FEELER_AVOID_STRENGTH * ESCAPE_COMMIT_FEELER : FEELER_AVOID_STRENGTH;
    var sx = desiredX + fl.x * feelerW + lv.x * lavaW + hz.x * HAZARD_AVOID_STRENGTH + exX;
    var sy = desiredY + fl.y * feelerW + lv.y * lavaW + hz.y * HAZARD_AVOID_STRENGTH + exY;
    // Steering low-pass (see STEER_SMOOTH): blend with the previous tick's steer so
    // the side-flipping feeler/lava push in a tight corridor can't build into a
    // vibration that clips a wall or cancels forward motion.
    if (bot.isZombie) {
        // Zombies beeline and want instant response — bypass the filter, and drop
        // the stored history so a zombie->racer revert (infection round end) doesn't
        // blend in a stale pre-zombie vector.
        ai.prevSx = null; ai.prevSy = null;
    } else if (committed || beelining) {
        // A committed (thread-or-die) escape or last-resort beeline wants its decisive line
        // undiluted, so snap the filter to it instead of blending the pre-escape pocket vector.
        ai.prevSx = sx; ai.prevSy = sy;
    } else {
        if (ai.prevSx == null) { ai.prevSx = sx; ai.prevSy = sy; }
        sx = STEER_SMOOTH * sx + (1 - STEER_SMOOTH) * ai.prevSx;
        sy = STEER_SMOOTH * sy + (1 - STEER_SMOOTH) * ai.prevSy;
        ai.prevSx = sx; ai.prevSy = sy;
    }
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
    // During an escape, soften the throttle's lava-PROXIMITY gate too (not just the
    // steering field above) — otherwise being wedged at a lava-walled pinch (exactly
    // when lavaField is strongest) keeps even a stage-1 escape pinned to the 0.42
    // crawl, so it never builds the momentum to thread. A real lava-DEAD-AHEAD brake
    // (fl.brake) still bites, so this doesn't drive it straight into lava.
    if (escaping) { lavaField *= ESCAPE_LAVA_RELAX; }
    // On ice the throttle IS the bot's steering authority (the engine scales accel by the
    // targetDir magnitude, and accel is only 15 on ice) — and braking does nothing. So the
    // usual "crawl when lava is ahead" makes an ice slide WORSE: it cuts the very accel the
    // bot needs to curve its momentum off the lava. Keep throttle up on ice and lean on the
    // longer ice feeler (steer away early) + the emergency punch-brake (kill a bad slide).
    var onIce = bot.brakeCoeff < c.playerBrakeCoeff;
    if ((fl.brake || lavaField > 1.2) && !onIce) {
        throttle = 0.42;
        if (speed > BRAKE_SPEED_MIN) { braking = true; }
    } else if (sharpTurn || lavaField > 0.6) {
        if (!onIce) { throttle = 0.7; }
        if (sharpTurn && !onIce && speed > BRAKE_SPEED_MIN * 1.3) { braking = true; }
    }
    // Pre-ice braking: bleed speed on the grippy approach so we enter the ice slow enough
    // to actually steer across it. Only when grippy now (braking works), ice is imminent
    // dead ahead, and we're carrying too much speed; skip during a beeline/escape (those
    // deliberately commit) and when fleeing a collapse.
    if (!onIce && !beelining && !escaping && !ctx.collapsing &&
        speed > ICE_ENTRY_SPEED) {
        var look = ICE_ENTRY_LOOKAHEAD + speed * 0.45;
        var hX = headX, hY = headY; // heading already computed above for the feelers
        if (nearestTileId(ctx, bot.x + hX * look, bot.y + hY * look) === ctx.iceId) {
            braking = true;
            if (throttle > 0.5) { throttle = 0.5; }
        }
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

    // Stage-2 (committed) escape: a bot wedged at a pinch the gentle stage-1
    // approach couldn't thread stops loitering and commits down its (still
    // feeler/lava-avoidance-bent) line — threading the gap or, if it's sealed in by
    // lava, dying to clear the pinch. Either way it no longer clogs the spot and
    // "lines up forever". Only ever reached by a bot already stuck through a failed
    // gentle escape, so it can't affect a normally-racing bot.
    if (committed) {
        if (throttle < ESCAPE_COMMIT_THROTTLE) { throttle = ESCAPE_COMMIT_THROTTLE; }
        braking = false;
    }
    // Last-resort beeline: full throttle, no brake, no lava crawl — drive the decisive
    // line out of the pocket (avoidance is already off, so fl.brake never fires here).
    if (beelining) { throttle = Math.max(throttle, 1.0); braking = false; }

    // A hunting zombie commits fully: it ignores lava and only wants to catch prey,
    // so skip the cautious governor, rubber-band easing, and braking — full chase.
    if (bot.isZombie) { throttle = 1; braking = false; }

    bot.targetDirX = steerX * throttle;
    bot.targetDirY = steerY * throttle;
    bot.angle = Math.atan2(steerY, steerX) * (180 / Math.PI);
    bot.braking = braking;

    // Combat & abilities (may override bot.angle to an 8-way aim and set bot.attack).
    decideAttack(bot, ctx, { sharpTurn: sharpTurn, lavaAhead: fl.brake, braking: braking, waterAhead: waterAhead });
}

// Per-gate launch geometry, agnostic to which edge the gate hugs. A gate is thin
// on one axis: left/right gates are vertical (lanes run along Y, bots launch
// along X); top/bottom gates are horizontal (lanes run along X, launch along Y).
//   launchPos  — the inner-edge coordinate on the launch axis (release line)
//   launchDir  — +1 / -1 sign of the launch direction along that axis
//   standPos   — coordinate on the launch axis where a held bot actually stands
//   laneMin/Max— span on the lane (perpendicular) axis, inset off the corners
function gateGeometry(gate) {
    var vertical = gate.width < gate.height; // left/right are thin in width
    var edge = gate.edge || (vertical
        ? (gate.x <= 0 ? "left" : "right")
        : (gate.y <= 0 ? "top" : "bottom"));
    var g;
    if (vertical) {
        var innerX = (edge === "left") ? gate.x + gate.width : gate.x;
        g = {
            vertical: true,
            launchPos: innerX,
            launchDir: (edge === "left") ? 1 : -1,
            standPos: innerX + ((edge === "left") ? -10 : 10),
            laneMin: gate.y + 16,
            laneMax: gate.y + gate.height - 16,
            penMin: gate.y, penMax: gate.y + gate.height
        };
    } else {
        var innerY = (edge === "top") ? gate.y + gate.height : gate.y;
        g = {
            vertical: false,
            launchPos: innerY,
            launchDir: (edge === "top") ? 1 : -1,
            standPos: innerY + ((edge === "top") ? -10 : 10),
            laneMin: gate.x + 16,
            laneMax: gate.x + gate.width - 16,
            penMin: gate.x, penMax: gate.x + gate.width
        };
    }
    return g;
}

// The non-lava launch lanes along the gate's front row: positions on the lane
// axis where a bot can stand (and be released) onto solid ground, not lava. On a
// lava-walled map only a few exist, so bots contest them — like real players
// fighting over the safe spots — instead of spreading evenly onto the lava.
function computeSafeLanes(ctx, geo) {
    var lanes = [];
    for (var p = geo.laneMin; p <= geo.laneMax; p += 20) {
        var x = geo.vertical ? geo.standPos : p;
        var y = geo.vertical ? p : geo.standPos;
        if (!isLavaAt(ctx, x, y)) { lanes.push(p); }
    }
    return lanes;
}

// Gated phase: bots aren't racing yet (held inside their start gate). They press
// to the front row, target a SAFE (non-lava) launch lane so they don't drive into
// lava the instant the gate opens, and bursty-punch to contest a lane. Everyone
// converges on the safe lanes, so they jostle for them. preventEscape keeps them
// in the gate; lava can't kill here, only once racing starts.
function steerGated(bot, ctx) {
    var ai = bot.ai || (bot.ai = newBotState(bot.profile));
    var geo = ctx.geo;
    // Stand just behind the release line, inside the gate.
    var front = geo.launchPos - geo.launchDir * (bot.radius + 3);
    var perpMin = geo.penMin + bot.radius + 4;
    var perpMax = geo.penMax - bot.radius - 4;
    var tperp;
    if (ctx.safeLanes && ctx.safeLanes.length > 0) {
        // Each bot is assigned a safe lane by its seed so the field SPREADS across
        // the available lanes (route diversity) instead of all converging on the
        // nearest one. When safe lanes are scarce (lava-walled gate) several bots
        // share a lane and jostle for it. Sticky per-bot jitter avoids exact stacks.
        if (ai.gateJitter == null) { ai.gateJitter = (Math.random() - 0.5) * 16; }
        tperp = ctx.safeLanes[ai.pathSeed % ctx.safeLanes.length] + ai.gateJitter;
    } else {
        // No safe-lane reading: gentle shuffle along the gate (fallback).
        if (ai.gateY == null) { ai.gateY = geo.vertical ? bot.y : bot.x; }
        ai.gateY += (Math.random() - 0.5) * 12;
        if (ai.gateY < perpMin) { ai.gateY = perpMin; }
        if (ai.gateY > perpMax) { ai.gateY = perpMax; }
        tperp = ai.gateY;
    }
    if (tperp < perpMin) { tperp = perpMin; } else if (tperp > perpMax) { tperp = perpMax; }
    var tx = geo.vertical ? front : tperp;
    var ty = geo.vertical ? tperp : front;
    var dx = tx - bot.x, dy = ty - bot.y;
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
    var gates = gameBoard.startingGates || [];
    if (gates.length === 0) { return; }
    // Build a per-gate steering context once (geometry + safe lanes for that gate),
    // so each bot is steered toward the gate it was assigned (player.gateIndex).
    var gateCtxs = [];
    for (var gi = 0; gi < gates.length; gi++) {
        var geo = gateGeometry(gates[gi]);
        var ctx = {
            map: gameBoard.currentMap,
            lavaId: c.tileMap.lava.id,
            emptyId: c.tileMap.empty.id,
            players: playerList,
            projectileList: gameBoard.projectileList,
            gate: gates[gi],
            geo: geo,
            infection: false, hockey: false, cloudy: false, lightning: false,
            puck: null, clouds: [], blackoutActive: false, visionBlockedUntil: 0
        };
        ctx.safeLanes = computeSafeLanes(ctx, geo);
        gateCtxs.push(ctx);
    }
    for (var pid in playerList) {
        var bot = playerList[pid];
        if (!bot.isAI || !bot.alive || bot.isSpectator) { continue; }
        var idx = bot.gateIndex || 0;
        if (idx < 0 || idx >= gateCtxs.length) { idx = 0; }
        steerGated(bot, gateCtxs[idx]);
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

    // Bunker (battle royale): while the goal is buried there are no goal tiles, so
    // bots have nothing to path toward. Feed them the bunker center as a virtual goal
    // so they converge on the shrinking safe island and the combat/leader machinery
    // engages (knocking rivals into the closing ring). Real goal tiles reappear and
    // take over the instant the goal emerges for the lone survivor.
    var bunkerSafeIds = null;
    if (gameBoard.goalBuried && gameBoard.bunkerLoc != null) {
        goalTiles = [{ x: gameBoard.bunkerLoc.x, y: gameBoard.bunkerLoc.y }];
        bunkerSafeIds = gameBoard.bunkerSafeIds;
    }

    // Cells holding a bumper hazard — bumpers aren't in the cell graph, so without
    // this A* routes straight through them and the bot gets knocked/stuck. Penalize
    // those cells so routes go AROUND. Recomputed each tick so a moving bumper's
    // cell is tracked (re-pathing is throttled; local repulsion handles the rest).
    // A MOVING bumper sweeps a whole rail at ~2000px/s, so penalizing only the cell
    // it sits in this instant is useless — penalize every cell whose center is near
    // the swept segment. The two classes are priced separately (see the penalty
    // constants): static bumpers in staticHazardCells (harsh), timeable moving
    // rails in railCells (mild).
    var staticHazardCells = null;
    var railCells = null;
    var hazardList = gameBoard.hazardList;
    var RAIL_PENALTY_MARGIN = 48; // px from the swept segment to still penalize a cell
    for (var hkey in hazardList) {
        var hz = hazardList[hkey];
        if (!hz || hz.alive === false) { continue; }
        if (hz.moveable && hz.rail != null) {
            var seg = bumperSegment(hz);
            var marginSq = RAIL_PENALTY_MARGIN * RAIL_PENALTY_MARGIN;
            for (var ri = 0; ri < map.cells.length; ri++) {
                var rc = map.cells[ri];
                if (!rc || !rc.site) { continue; }
                var cpr = closestOnSegment(rc.site.x, rc.site.y, seg.ax, seg.ay, seg.bx, seg.by);
                var rdx = rc.site.x - cpr.x, rdy = rc.site.y - cpr.y;
                if (rdx * rdx + rdy * rdy < marginSq) {
                    if (railCells == null) { railCells = new Set(); }
                    railCells.add(rc.site.voronoiId);
                }
            }
            continue;
        }
        var bestI = -1, bestD = Infinity;
        for (var ci2 = 0; ci2 < map.cells.length; ci2++) {
            var cc = map.cells[ci2];
            if (!cc || !cc.site) { continue; }
            var ddx = cc.site.x - hz.x, ddy = cc.site.y - hz.y;
            var dd = ddx * ddx + ddy * ddy;
            if (dd < bestD) { bestD = dd; bestI = ci2; }
        }
        if (bestI >= 0) {
            if (staticHazardCells == null) { staticHazardCells = new Set(); }
            staticHazardCells.add(map.cells[bestI].site.voronoiId);
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

    // Telegraphed strike zones the bots should steer out of during their warn-up:
    // pending Orbital Beam lines (gameBoard.pendingBeams) and the lava-explosion aimer
    // (a charging circle that turns the area to lava). Both mark ground about to become
    // deadly. A small grace past fireAt keeps a just-resolved beam from snapping off mid-tick.
    var telegraphs = [];
    var nowTg = Date.now();
    if (gameBoard.pendingBeams != null) {
        for (var bmId in gameBoard.pendingBeams) {
            var bm = gameBoard.pendingBeams[bmId];
            if (bm == null || nowTg > bm.fireAt + 200) { continue; }
            telegraphs.push({ kind: 'beam', ownerId: bm.ownerId, x: bm.x, y: bm.y, dirX: bm.dirX, dirY: bm.dirY, length: bm.length, halfWidth: bm.halfWidth });
        }
    }
    for (var amId in gameBoard.aimerList) {
        var am = gameBoard.aimerList[amId];
        if (am == null || am.alive === false || !am.isExplosionAimer) { continue; }
        telegraphs.push({ kind: 'circle', ownerId: amId, x: am.x, y: am.y, radius: am.radius });
    }

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
        emptyId: c.tileMap.empty.id,
        iceId: c.tileMap.ice.id,
        waterId: c.tileMap.water != null ? c.tileMap.water.id : -999,
        siteById: buildSiteIndex(map),
        lavaCells: lavaCells,
        goalTiles: goalTiles, // for zombie intercept (prey are racing to a goal)
        bunkerSafeIds: bunkerSafeIds, // Bunker round: A* homes on these cells (buried goal)
        staticHazardCells: staticHazardCells, // static bumper cells (harsh path penalty)
        railCells: railCells, // moving-rail swept cells (mild path penalty — timeable)
        players: playerList,
        projectileList: gameBoard.projectileList,
        hazardList: gameBoard.hazardList,
        punches: gameBoard.punchList, // live punches, so a bot can counter a REAL incoming one
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
        telegraphs: telegraphs, // strike zones (Orbital Beam line / lava-explosion aimer) to dodge
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
// Pure helpers exposed for unit tests (cf. lastRubberBand diagnostic above).
module.exports._test = {
    bumperSegment: bumperSegment,
    closestOnSegment: closestOnSegment,
    hazardRepulsion: hazardRepulsion,
    railCrossingOpen: railCrossingOpen,
    telegraphRepulsion: telegraphRepulsion,
    decideAbility: decideAbility,
    newBotState: newBotState,
    chargeHoldFor: chargeHoldFor,
    emergencyBrakeNeeded: emergencyBrakeNeeded,
    driftHoldNeeded: driftHoldNeeded,
    driftRecovered: driftRecovered,
    bombTarget: bombTarget,
    raceLeader: raceLeader,
    rivalsAhead: rivalsAhead,
    lavaNear: lavaNear,
    blindfoldWorthIt: blindfoldWorthIt
};
