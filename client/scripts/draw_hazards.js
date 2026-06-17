// draw_hazards.js — per-kind hazard & boon drawers, extracted verbatim from
// draw.js (phase 3 of docs/spikes/client-refactor.md). Pure file split: no
// logic, naming, or order changes. Loaded after draw.js in the play bundle;
// all references are runtime calls (hazardDrawers is built lazily on first
// draw, after config arrives via socket).
// Contents: buildHazardDrawers dispatch + every hazard drawer (bumper/rotor/
// geyser/mine/vortex/warp/laser/crusher/sentry/antlion/thumper) and boon
// drawer (dash-arrows/recharge/slipstream/launch-pad/barrel/slingshot/zipline/
// lily/guard-halo/second-wind), locked-door/key glyphs, bonus orbs.

// Per-kind hazard drawers, keyed by hazard id. Adding a new hazard kind on the
// client = one entry here (the server-side counterpart is the kind registry in
// server/entities/hazards.js). Built lazily on first draw — config arrives via
// socket, and hazards can't exist client-side before it has.
var hazardDrawers = null;
function buildHazardDrawers() {
    hazardDrawers = {};
    hazardDrawers[config.hazards.bumper.id] = function (h) {
        drawBumper(h.x, h.y);
    };
    hazardDrawers[config.hazards.movingBumper.id] = function (h) {
        drawMovingBumper(h.x, h.y, h.railX, h.railY, h.angle);
    };
    hazardDrawers[config.hazards.bumperWall.id] = function (h) {
        drawBumperWall(h.x, h.y, h.angle);
    };
    hazardDrawers[config.hazards.rotor.id] = function (h) {
        drawRotor(h.x, h.y, h.angle);
    };
    hazardDrawers[config.hazards.geyser.id] = function (h) {
        drawGeyser(h.x, h.y, h.state);
    };
    hazardDrawers[config.hazards.mine.id] = function (h) {
        drawMine(h.x, h.y, h.state);
    };
    if (config.hazards.vortexWell != null) {
        hazardDrawers[config.hazards.vortexWell.id] = function (h) {
            drawVortexWell(h.x, h.y, h.radius);
        };
    }
    if (config.hazards.laserGate != null) {
        hazardDrawers[config.hazards.laserGate.id] = function (h) {
            drawLaserGate(h.x, h.y, h.angle, h.state);
        };
    }
    if (config.hazards.crusher != null) {
        hazardDrawers[config.hazards.crusher.id] = function (h) {
            drawCrusher(h.x, h.y, h.railX, h.railY, h.angle);
        };
    }
    if (config.hazards.sentryTurret != null) {
        hazardDrawers[config.hazards.sentryTurret.id] = function (h) {
            drawSentryTurret(h.x, h.y, h.angle, h.state);
        };
    }
    if (config.boons.warpPad != null) {
        hazardDrawers[config.boons.warpPad.id] = function (h) {
            drawWarpPad(h.x, h.y, h.state); // h.state = the pair id (netState) → per-pair colour
        };
    }
    if (config.hazards.magpieDrone != null) {
        hazardDrawers[config.hazards.magpieDrone.id] = function (h) {
            drawMagpieDrone(h); // reads x/y, rail origin/angle, state (carried ability tile id, 0=empty), and tx for facing
        };
    }
    // Boons share the hazard drawer registry (they live in the same client
    // hazardList). Their visual language is teal/helpful, the inverse of the
    // bumper-orange "this flings you" rule.
    if (config.boons != null && config.boons.dashArrows != null) {
        hazardDrawers[config.boons.dashArrows.id] = function (h) {
            drawDashArrows(h.x, h.y, h.angle);
        };
    }
    if (config.boons != null && config.boons.rechargeSpring != null) {
        hazardDrawers[config.boons.rechargeSpring.id] = function (h) {
            drawRechargeSpring(h.x, h.y, h.state);
        };
    }
    if (config.boons != null && config.boons.slipstream != null) {
        hazardDrawers[config.boons.slipstream.id] = function (h) {
            drawSlipstream(h.x, h.y, h.angle);
        };
    }
    if (config.boons != null && config.boons.guardHalo != null) {
        hazardDrawers[config.boons.guardHalo.id] = function (h) {
            drawGuardHalo(h.x, h.y, h.state);
        };
    }
    if (config.boons != null && config.boons.secondWindTotem != null) {
        hazardDrawers[config.boons.secondWindTotem.id] = function (h) {
            drawSecondWindTotem(h);
        };
    }
    if (config.boons != null && config.boons.launchPad != null) {
        hazardDrawers[config.boons.launchPad.id] = function (h) {
            drawLaunchPad(h.x, h.y, h.angle);
        };
    }
    if (config.boons != null && config.boons.barrelCannon != null) {
        hazardDrawers[config.boons.barrelCannon.id] = function (h) {
            drawBarrelCannon(h.x, h.y, h.angle);
        };
    }
    if (config.boons != null && config.boons.slingshotRings != null) {
        hazardDrawers[config.boons.slingshotRings.id] = function (h) {
            drawSlingshotRings(h.x, h.y, h.angle);
        };
    }
    if (config.boons != null && config.boons.zipline != null) {
        hazardDrawers[config.boons.zipline.id] = function (h) {
            // railX/railY = the start post (rail origin); railLength = the author-set span.
            drawZipline(h.railX != null ? h.railX : h.x, h.railY != null ? h.railY : h.y,
                h.angle, h.railLength != null ? h.railLength : config.boons.zipline.minLength);
        };
    }
    if (config.boons != null && config.boons.lilyPad != null) {
        hazardDrawers[config.boons.lilyPad.id] = function (h) {
            // h.state = sink % (netState) 0 floating..100 sunk; h.radius = author-resized size;
            // h.angle = the baked per-pad random rotation (cosmetic variety).
            drawLilyPad(h.x, h.y, h.state, h.radius, h.angle);
        };
    }
}
function drawHazard(hazard) {
    if (hazardDrawers == null) {
        if (config == null) {
            return;
        }
        buildHazardDrawers();
    }
    var drawer = hazardDrawers[hazard.id];
    if (drawer != null) {
        drawer(hazard);
    }
    if (config.hazards.antlion != null && hazard.id == config.hazards.antlion.id) {
        drawAntlionHazard(hazard);
    }
    if (config.hazards.thumper != null && hazard.id == config.hazards.thumper.id) {
        drawThumperHazard(hazard);
    }
}

var bumperRingColor = "#E5392B";
function drawBumper(x, y) {
    gameContext.save();
    gameContext.beginPath();
    gameContext.strokeStyle = bumperRingColor;
    gameContext.lineWidth = 3;
    gameContext.arc(x, y, config.hazards.bumper.attackRadius, 0, 2 * Math.PI);
    gameContext.stroke();
    gameContext.beginPath();
    gameContext.arc(x, y, config.hazards.bumper.radius, 0, 2 * Math.PI);
    gameContext.fillStyle = config.hazards.bumper.color;
    gameContext.fill();
    gameContext.restore();
}
function drawMovingBumper(x, y, railX, railY, angle) {
    gameContext.save();
    gameContext.beginPath();
    gameContext.translate(railX, railY);
    gameContext.rotate(angle * (Math.PI / 180));
    gameContext.rect(0, -config.hazards.movingBumper.height / 2, config.hazards.movingBumper.width, config.hazards.movingBumper.height);
    gameContext.fillStyle = "black";
    gameContext.fill();
    gameContext.restore();

    gameContext.save();
    gameContext.beginPath();
    gameContext.strokeStyle = bumperRingColor;
    gameContext.lineWidth = 3;
    gameContext.arc(x, y, config.hazards.movingBumper.attackRadius, 0, 2 * Math.PI);
    gameContext.stroke();
    gameContext.beginPath();
    gameContext.arc(x, y, config.hazards.movingBumper.radius, 0, 2 * Math.PI);
    gameContext.fillStyle = config.hazards.movingBumper.color;
    gameContext.fill();
    gameContext.restore();
}
// A magpie drone: a thieving BIRD patrolling its rail — a stylized magpie (black body, white
// breast, long iridescent blue-green tail, flapping wings). When carrying a stolen ability
// (state = the ability TILE id, 0 = empty) it clutches the loot in its beak + a gold "rob me"
// glow ring pulses behind it (punch it to drop the loot). It flips to face its travel
// direction along the rail (from the smoothed position target tx). Railed, so it draws its
// patrol track from the rail origin like the moving bumper.
function drawMagpieDrone(h) {
    var cfg = config.hazards.magpieDrone;
    var R = cfg.radius;
    var x = h.x, y = h.y;
    // Patrol rail (faint dashed indigo line from the rail origin along its angle). The rail
    // length is author-sized per instance, shipped on wire slot [9] (decoded into h.railLength,
    // the same slot the Zipline uses); fall back to the config default.
    var railLen = (h.railLength != null && h.railLength > 0) ? h.railLength : cfg.railLength;
    if (h.railX != null && h.railY != null) {
        var rad = (h.angle || 0) * (Math.PI / 180);
        gameContext.save();
        gameContext.strokeStyle = "rgba(91,108,196,0.30)";
        gameContext.lineWidth = 3;
        gameContext.setLineDash([8, 8]);
        gameContext.beginPath();
        gameContext.moveTo(h.railX, h.railY);
        gameContext.lineTo(h.railX + Math.cos(rad) * railLen, h.railY + Math.sin(rad) * railLen);
        gameContext.stroke();
        gameContext.setLineDash([]);
        gameContext.restore();
    }
    var t = Date.now() / 1000;
    var carrying = (h.state != null && h.state >= 100);
    var bob = Math.sin(t * 2.2) * R * 0.06;
    // Face travel direction (the bird flies where it's headed). tx is the smoothed position
    // target; a horizontal delta flips the sprite. Falls back to facing right.
    var face = (h.tx != null && h.tx < x - 0.4) ? -1 : 1;
    // Gold "rob me / punch me" glow ring behind the bird while it carries loot.
    if (carrying) {
        var pulse = 0.5 + 0.5 * Math.sin(t * 6);
        gameContext.beginPath();
        gameContext.arc(x, y + bob, R + 6 + pulse * 3, 0, Math.PI * 2);
        gameContext.strokeStyle = "rgba(255,210,90," + (0.30 + 0.30 * pulse).toFixed(3) + ")";
        gameContext.lineWidth = 2.5;
        gameContext.stroke();
    }
    gameContext.save();
    gameContext.translate(x, y + bob);
    gameContext.scale(face, 1);
    drawMagpieBird(R, t, carrying);
    gameContext.restore();
    // Loot = the actual stolen ability icon, clutched at the beak tip (world space, so the
    // wing flap / sprite mirror don't distort the token).
    if (carrying) {
        drawAbilityIconToken(abilityIconFor(h.state), x + face * R * 1.5, y + bob - R * 0.7, R * 0.55);
    }
}
// The magpie body, drawn centered at the current origin facing +x (caller handles the
// translate/bob/mirror). Delegates to the shared magpieBirdShape (barrierArt.js) — the same
// shape the editor draws — passing the live animation phase (wing flap, tail sway, beak gape,
// shifting blue-green tail shimmer).
function drawMagpieBird(R, t, carrying) {
    magpieBirdShape(gameContext, R, Math.sin(t * 9) * 0.55, Math.sin(t * 2.2) * 0.05, carrying ? 0.16 : 0.05, function (s) {
        return (Math.sin(t * 1.5 + s) > 0.5) ? "#2f6df0" : "#1f8f7a";
    });
}
// A pinball slingshot wall: a rounded band from its anchor along `angle` for the
// configured length — red rim over the bumper-orange core, matching the round
// bumpers' palette so "this colour flings you" stays one visual rule.
function drawBumperWall(x, y, angle) {
    var rad = (angle || 0) * (Math.PI / 180);
    var bx = x + Math.cos(rad) * config.hazards.bumperWall.width;
    var by = y + Math.sin(rad) * config.hazards.bumperWall.width;
    gameContext.save();
    gameContext.lineCap = "round";
    gameContext.beginPath();
    gameContext.moveTo(x, y);
    gameContext.lineTo(bx, by);
    gameContext.strokeStyle = bumperRingColor;
    gameContext.lineWidth = config.hazards.bumperWall.height + 6;
    gameContext.stroke();
    gameContext.beginPath();
    gameContext.moveTo(x, y);
    gameContext.lineTo(bx, by);
    gameContext.strokeStyle = config.hazards.bumperWall.color;
    gameContext.lineWidth = config.hazards.bumperWall.height;
    gameContext.stroke();
    gameContext.restore();
}

// Author-placed barriers (engine.bounceOffBarriers): solid fence/wall segments
// drawn in the WORLD PASS (raw world coords) so the visual matches the server
// collider. The art lives in the shared client/scripts/barrierArt.js (the editor
// uses the same functions). Each barrier is baked ONCE to an offscreen canvas keyed
// by geometry+style and blitted with a rotate each frame, so the per-segment plank/
// crack loops never re-run per frame.
var barrierRenderCache = {};
function barrierRenderReset() { barrierRenderCache = {}; } // called on newMap (setBarriers)
function getBarrierRender(b) {
    var key = b.style + "|" + Math.round(b.x1) + "," + Math.round(b.y1) + "," + Math.round(b.x2) + "," + Math.round(b.y2);
    var cached = barrierRenderCache[key];
    if (cached != null) { return cached; }
    var dx = b.x2 - b.x1, dy = b.y2 - b.y1;
    var len = Math.sqrt(dx * dx + dy * dy);
    var pad = 14; // room for posts / outline past the segment ends + sides
    var w = Math.max(1, Math.ceil(len + pad * 2));
    var h = pad * 2;
    var ss = 2; // supersample so the bake stays crisp under zoom / high-DPR blits
    var cv = document.createElement("canvas");
    cv.width = w * ss; cv.height = h * ss;
    var cx = cv.getContext("2d");
    cx.scale(ss, ss);
    // Local space: segment runs horizontally at y=h/2 from x=pad..pad+len.
    var local = { x1: pad, y1: h / 2, x2: pad + len, y2: h / 2, style: b.style };
    if (b.style === "fence") { drawBarrierFenceArt(cx, local, 1); }
    else { drawBarrierConcreteArt(cx, local, 1); }
    var rec = { canvas: cv, pad: pad, half: h / 2, w: w, h: h };
    barrierRenderCache[key] = rec;
    return rec;
}
function drawBarriers() {
    if (typeof mapBarriers === "undefined" || mapBarriers.length === 0) { return; }
    if (config == null) { return; }
    if (currentState !== config.stateMap.lobby &&
        currentState !== config.stateMap.gated &&
        currentState !== config.stateMap.racing &&
        currentState !== config.stateMap.collapsing) { return; }
    for (var i = 0; i < mapBarriers.length; i++) {
        var b = mapBarriers[i];
        var rec = getBarrierRender(b);
        var ang = Math.atan2(b.y2 - b.y1, b.x2 - b.x1);
        gameContext.save();
        gameContext.translate(b.x1, b.y1);
        gameContext.rotate(ang);
        // local (pad, half) -> the segment start (b.x1,b.y1); downscale the SS bake.
        gameContext.drawImage(rec.canvas, -rec.pad, -rec.half, rec.w, rec.h);
        gameContext.restore();
    }
}

// Bonus orbs (team modes): a floating golden sphere a team banks for +1 by driving
// over it. Drawn in the WORLD PASS (raw world coords, like karts/hazards) so it
// aligns with the server collider. Pulses + bobs while live; on pickup it plays a
// brief expanding ring burst (popAt, set by the bonusOrbCollected handler) then is
// gone for the rest of the round.
// --- Locked doors + keys (any mode) ---------------------------------------------
// Doors render as a dark slab over their cell with a glowing SHAPE silhouette (the
// barrier itself is server-authoritative; this is just the visual). Keys render as the
// same shape — bobbing on the ground when loose, orbiting their carrier when held. Each
// shape gets its own colour so a player can match key->door at a glance. doorFX drives a
// shared camera zoom-out: a brief ping on pickup, a stronger pull-back + burst on unlock
// (the burst is timed to the camera peak). All world-space (raw coords, like karts).
var doorFX = null;
function keyShapeColor(shape) {
    switch (shape) {
        case "triangle": return "#ff7043";
        case "square": return "#42a5f5";
        case "diamond": return "#ec407a";
        case "pentagon": return "#ab47bc";
        case "hexagon": return "#26c6da";
        case "circle":
        default: return "#ffca28";
    }
}
// Trace a named shape's polygon (or circle) into the current path, centred at (x,y).
function traceShapePath(ctx, shape, x, y, r) {
    ctx.beginPath();
    var sides = 0, rot = -Math.PI / 2;
    switch (shape) {
        case "triangle": sides = 3; break;
        case "square": sides = 4; rot = -Math.PI / 4; break;
        case "diamond": sides = 4; rot = -Math.PI / 2; break;
        case "pentagon": sides = 5; break;
        case "hexagon": sides = 6; rot = 0; break;
        case "circle":
        default: ctx.arc(x, y, r, 0, 2 * Math.PI); return;
    }
    for (var i = 0; i < sides; i++) {
        var a = rot + i * (2 * Math.PI / sides);
        var px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
        if (i === 0) { ctx.moveTo(px, py); } else { ctx.lineTo(px, py); }
    }
    ctx.closePath();
}
function drawKeyGlyph(ctx, shape, x, y, r) {
    // High-contrast double outline (thick dark halo + bright inner edge) so the bright
    // fill reads on light grass AND dark lava/stone — keys must be easy to spot.
    traceShapePath(ctx, shape, x, y, r);
    ctx.fillStyle = keyShapeColor(shape);
    ctx.fill();
    ctx.lineWidth = 4.5;
    ctx.strokeStyle = "rgba(0,0,0,0.9)";
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255,255,255,0.97)";
    ctx.stroke();
}
// Nearest cell to a world point (the door/key sits on its site) + that cell's outer
// radius, cached on the door so we only scan the map once.
function _findCellNear(x, y) {
    if (typeof currentMap === "undefined" || currentMap == null || !currentMap.cells) { return null; }
    var best = Infinity, bestCell = null;
    for (var i = 0; i < currentMap.cells.length; i++) {
        var s = currentMap.cells[i].site;
        if (s == null) { continue; }
        var dx = s.x - x, dy = s.y - y, d = dx * dx + dy * dy;
        if (d < best) { best = d; bestCell = currentMap.cells[i]; }
    }
    return bestCell;
}
function _cellOuterRadius(cell) {
    if (cell == null || !cell.halfedges || cell.halfedges.length === 0 || cell.site == null) { return 26; }
    var max = 0, s = cell.site;
    for (var i = 0; i < cell.halfedges.length; i++) {
        var v = getEndpoint(cell.halfedges[i]);
        var dx = v.x - s.x, dy = v.y - s.y, d = dx * dx + dy * dy;
        if (d > max) { max = d; }
    }
    return Math.sqrt(max) || 26;
}
function _distToSeg(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    if (l2 < 1e-9) { var gx = px - ax, gy = py - ay; return Math.sqrt(gx * gx + gy * gy); }
    var t = ((px - ax) * dx + (py - ay) * dy) / l2;
    if (t < 0) { t = 0; } else if (t > 1) { t = 1; }
    var cx = ax + t * dx, cy = ay + t * dy, ex = px - cx, ey = py - cy;
    return Math.sqrt(ex * ex + ey * ey);
}
// Inscribed radius: distance from the site to the NEAREST cell edge — the largest
// circle that fits INSIDE the cell. Used to size the door shape hint so it stays
// within the painted tile's bounds (small tiles get a small hint, by design).
function _cellInnerRadius(cell) {
    if (cell == null || !cell.halfedges || cell.halfedges.length === 0 || cell.site == null) { return 14; }
    var s = cell.site, min = Infinity;
    for (var i = 0; i < cell.halfedges.length; i++) {
        var a = getStartpoint(cell.halfedges[i]), b = getEndpoint(cell.halfedges[i]);
        var dd = _distToSeg(s.x, s.y, a.x, a.y, b.x, b.y);
        if (dd < min) { min = dd; }
    }
    return (min === Infinity) ? 14 : min;
}
function drawLockedDoors() {
    if (typeof lockedDoorList === "undefined" || lockedDoorList.length === 0) { return; }
    if (currentState !== config.stateMap.gated && currentState !== config.stateMap.racing && currentState !== config.stateMap.collapsing) { return; }
    var doorColor = (config.tileMap.door && config.tileMap.door.color) ? config.tileMap.door.color : "#2b2438";
    var now = Date.now();
    for (var i = 0; i < lockedDoorList.length; i++) {
        var d = lockedDoorList[i];
        if (d.unlocked) { continue; }
        // Resolve (and cache) the door's cell. Retry while null — currentMap may not be
        // loaded yet on the first frames after the newMap payload set this door list, and
        // caching a null would leave the slab undrawn (bare terrain showing through).
        if (d._cell == null) { d._cell = _findCellNear(d.x, d.y); if (d._cell != null) { d._ri = _cellInnerRadius(d._cell); } }
        var col = keyShapeColor(d.shape);
        var pulse = 0.5 + 0.5 * Math.sin(now / 500 + i);
        gameContext.save();
        // Dark barrier slab over the door cell.
        var haveCell = (d._cell != null && traceCellPath(gameContext, d._cell));
        if (haveCell) {
            gameContext.fillStyle = doorColor;
            gameContext.fill();
            // A thick GLOWING border in the key's colour hugging the cell — this is what
            // makes the door's exact footprint unmistakable and colour-codes it to its key.
            gameContext.globalAlpha = 0.45 + pulse * 0.45;
            gameContext.lineWidth = 6;
            gameContext.strokeStyle = col;
            gameContext.stroke();
            gameContext.globalAlpha = 1;
            gameContext.lineWidth = 1.5;
            gameContext.strokeStyle = "rgba(0,0,0,0.6)";
            gameContext.stroke();
        }
        // Centre emblem: an OPAQUE bright shape in the key's colour with a white edge
        // (identity) + a dark keyhole punched in (reads as "locked"). Sized by the
        // inscribed radius so it stays inside the tile.
        var sr = Math.max(5, (d._ri || 14) * 0.78);
        traceShapePath(gameContext, d.shape, d.x, d.y, sr);
        gameContext.fillStyle = col;
        gameContext.fill();
        gameContext.lineWidth = 2.5;
        gameContext.strokeStyle = "rgba(255,255,255,0.95)";
        gameContext.stroke();
        var kr = Math.max(2, sr * 0.30); // keyhole
        gameContext.fillStyle = "rgba(18,14,28,0.92)";
        gameContext.beginPath();
        gameContext.arc(d.x, d.y - kr * 0.2, kr, 0, 2 * Math.PI);
        gameContext.fill();
        gameContext.fillRect(d.x - kr * 0.42, d.y - kr * 0.2, kr * 0.84, kr * 1.9);
        gameContext.restore();
    }
}
function drawLooseKeys() {
    if (typeof lockedKeyList === "undefined" || lockedKeyList.length === 0) { return; }
    if (currentState !== config.stateMap.gated && currentState !== config.stateMap.racing && currentState !== config.stateMap.collapsing) { return; }
    var now = Date.now();
    var baseR = (config.lockedDoor && config.lockedDoor.keyRadius) ? config.lockedDoor.keyRadius : 15;
    for (var i = 0; i < lockedKeyList.length; i++) {
        var key = lockedKeyList[i];
        if (key.consumed || key.carriedBy != null) { continue; } // carried keys draw on the kart
        var pulse = 0.5 + 0.5 * Math.sin(now / 300 + i * 1.7);
        var cy = key.y + Math.sin(now / 480 + i * 2.1) * 4; // a little float
        var r = baseR * (0.98 + pulse * 0.12);
        var col = keyShapeColor(key.shape);
        gameContext.save();
        // Ground shadow lifts the key off the terrain.
        gameContext.globalAlpha = 0.28;
        gameContext.fillStyle = "#000";
        gameContext.beginPath();
        gameContext.ellipse(key.x, key.y + baseR * 0.95, baseR * 0.85, baseR * 0.34, 0, 0, 2 * Math.PI);
        gameContext.fill();
        // Pulsing high-contrast beacon: a bright expanding ring over a dark backing ring
        // so it stands out on any terrain.
        var ringR = baseR * 1.7 + pulse * 7;
        gameContext.globalAlpha = 0.55 + pulse * 0.35;
        gameContext.lineWidth = 5;
        gameContext.strokeStyle = "rgba(0,0,0,0.6)";
        gameContext.beginPath();
        gameContext.arc(key.x, cy, ringR, 0, 2 * Math.PI);
        gameContext.stroke();
        gameContext.lineWidth = 2.5;
        gameContext.strokeStyle = col;
        gameContext.beginPath();
        gameContext.arc(key.x, cy, ringR, 0, 2 * Math.PI);
        gameContext.stroke();
        gameContext.globalAlpha = 1;
        drawKeyGlyph(gameContext, key.shape, key.x, cy, r);
        gameContext.restore();
    }
}
// Key orbiting a carrier (drawn from drawPlayers, alongside the armed-ability ring).
function drawHeldKey(player) {
    if (player == null || player.heldKey == null) { return; }
    var now = Date.now();
    var ang = (now / 700) % (2 * Math.PI);
    var orbit = (player.radius || 6) + 16;
    var kx = player.x + Math.cos(ang) * orbit;
    var ky = player.y + Math.sin(ang) * orbit;
    gameContext.save();
    drawKeyGlyph(gameContext, player.heldKey.shape, kx, ky, 9);
    gameContext.restore();
}
// Camera cinematics + world-space FX, triggered by the key/door events.
function triggerDoorPing(x, y, shape) {
    if (x == null || y == null) { return; }
    doorFX = { x: x, y: y, shape: shape, kind: "ping", animStart: Date.now() };
    _spawnDoorRingFX(x, y, shape, "ping");
}
function triggerDoorUnlock(x, y, shape) {
    if (x == null || y == null) { return; }
    doorFX = { x: x, y: y, shape: shape, kind: "unlock", animStart: Date.now() };
    _spawnDoorRingFX(x, y, shape, "unlock");
}
function _spawnDoorRingFX(x, y, shape, kind) {
    if (typeof addEffect !== "function") { return; }
    var cfg = (typeof config !== "undefined" && config && config.lockedDoor) ? config.lockedDoor : {};
    if (kind === "ping") {
        addEffect({
            x: x, y: y, maxAge: cfg.pingMs || 1300,
            draw: function (ctx, t) {
                for (var k = 0; k < 2; k++) {
                    var tt = (t + k * 0.5) % 1;
                    ctx.globalAlpha = (1 - tt) * 0.7;
                    ctx.lineWidth = 3 * (1 - tt) + 1;
                    ctx.strokeStyle = keyShapeColor(shape);
                    ctx.beginPath();
                    ctx.arc(x, y, 20 + tt * 72, 0, 2 * Math.PI);
                    ctx.stroke();
                }
                ctx.globalAlpha = 0.9;
                ctx.lineWidth = 3;
                ctx.strokeStyle = keyShapeColor(shape);
                traceShapePath(ctx, shape, x, y, 17);
                ctx.stroke();
            }
        });
    } else {
        // Unlock burst — held back until the camera reaches its peak (after the pan-out),
        // then a bright flash + the shape bursting open.
        var peak = 0.40;
        addEffect({
            x: x, y: y, maxAge: cfg.unlockAnimMs ? (cfg.unlockAnimMs + 600) : 1500,
            draw: function (ctx, t) {
                if (t < peak) { return; }
                var u = (t - peak) / (1 - peak);
                ctx.globalAlpha = (1 - u) * 0.85;
                ctx.fillStyle = "#fff6cc";
                ctx.beginPath();
                ctx.arc(x, y, 18 + u * 64, 0, 2 * Math.PI);
                ctx.fill();
                ctx.globalAlpha = (1 - u);
                ctx.lineWidth = 4 * (1 - u) + 1;
                ctx.strokeStyle = keyShapeColor(shape);
                traceShapePath(ctx, shape, x, y, 18 + u * 44);
                ctx.stroke();
            }
        });
    }
}

var BONUS_ORB_POP_MS = 500;
function drawBonusOrbs() {
    if (typeof bonusOrbList === "undefined" || bonusOrbList.length === 0) { return; }
    if (currentState !== config.stateMap.gated &&
        currentState !== config.stateMap.racing &&
        currentState !== config.stateMap.collapsing) { return; }
    var now = Date.now();
    var baseR = (config.bonusOrb && config.bonusOrb.radius) ? config.bonusOrb.radius : 22;
    var color = (config.bonusOrb && config.bonusOrb.color) ? config.bonusOrb.color : "#FFD54A";
    for (var i = 0; i < bonusOrbList.length; i++) {
        var orb = bonusOrbList[i];
        if (orb.collected) {
            var pe = now - orb.popAt;
            if (pe > BONUS_ORB_POP_MS) { continue; }
            var t = pe / BONUS_ORB_POP_MS;                  // 0..1
            gameContext.save();
            gameContext.globalAlpha = 1 - t;
            gameContext.strokeStyle = color;
            gameContext.lineWidth = 3 * (1 - t) + 1;
            gameContext.beginPath();
            gameContext.arc(orb.x, orb.y, baseR + t * baseR * 2.2, 0, 2 * Math.PI);
            gameContext.stroke();
            gameContext.restore();
            continue;
        }
        var pulse = 0.5 + 0.5 * Math.sin(now / 280 + i * 1.7);   // 0..1
        var cy = orb.y + Math.sin(now / 520 + i * 2.1) * 3;      // gentle float
        var r = baseR * (0.78 + pulse * 0.10);
        gameContext.save();
        // outer halo
        gameContext.globalAlpha = 0.28 + pulse * 0.18;
        gameContext.fillStyle = color;
        gameContext.beginPath();
        gameContext.arc(orb.x, cy, baseR * 1.5, 0, 2 * Math.PI);
        gameContext.fill();
        gameContext.restore();
        // core sphere with a radial sheen
        gameContext.save();
        var grad = gameContext.createRadialGradient(orb.x - r * 0.3, cy - r * 0.3, r * 0.1, orb.x, cy, r);
        grad.addColorStop(0, "#FFFDF0");
        grad.addColorStop(0.45, color);
        grad.addColorStop(1, "#C9962E");
        gameContext.fillStyle = grad;
        gameContext.beginPath();
        gameContext.arc(orb.x, cy, r, 0, 2 * Math.PI);
        gameContext.fill();
        gameContext.lineWidth = 2;
        gameContext.strokeStyle = "rgba(255,255,255," + (0.5 + pulse * 0.4) + ")";
        gameContext.stroke();
        // "+1" so the objective reads at a glance
        gameContext.globalAlpha = 0.75 + pulse * 0.25;
        gameContext.fillStyle = "#5A3B00";
        gameContext.font = "bold 12px sans-serif";
        gameContext.textAlign = "center";
        gameContext.textBaseline = "middle";
        gameContext.fillText("+1", orb.x, cy);
        gameContext.restore();
    }
}

// A rotor: a bumper head sweeping a circle around a fixed pivot. The pivot is
// derived from the head (x,y) and the streamed sweep `angle` (head = pivot +
// orbitRadius along angle), so the streamAngle wire drives where the arm points.
// Drawn as a dark hub + arm to a bumper-orange head with the red attack ring.
function drawRotor(x, y, angle) {
    var rad = (angle || 0) * (Math.PI / 180);
    var px = x - Math.cos(rad) * config.hazards.rotor.orbitRadius;
    var py = y - Math.sin(rad) * config.hazards.rotor.orbitRadius;
    gameContext.save();
    gameContext.lineCap = "round";
    // Arm.
    gameContext.beginPath();
    gameContext.moveTo(px, py);
    gameContext.lineTo(x, y);
    gameContext.strokeStyle = "#222";
    gameContext.lineWidth = config.hazards.rotor.armWidth;
    gameContext.stroke();
    // Hub.
    gameContext.beginPath();
    gameContext.arc(px, py, config.hazards.rotor.armWidth, 0, 2 * Math.PI);
    gameContext.fillStyle = "#222";
    gameContext.fill();
    // Head — same disc + ring look as a round bumper, sized from rotor config.
    gameContext.beginPath();
    gameContext.strokeStyle = bumperRingColor;
    gameContext.lineWidth = 3;
    gameContext.arc(x, y, config.hazards.rotor.attackRadius, 0, 2 * Math.PI);
    gameContext.stroke();
    gameContext.beginPath();
    gameContext.arc(x, y, config.hazards.rotor.radius, 0, 2 * Math.PI);
    gameContext.fillStyle = config.hazards.rotor.color;
    gameContext.fill();
    gameContext.restore();
}

// A geyser vent. `state` is the server phase (netState): 0 dormant, 1 charging
// (telegraph — a pulsing warning ring + bubbles so you clear off), 2 erupting (an
// orange burst out to the eruption reach). Always draws the stone vent itself.
function drawGeyser(x, y, state) {
    var cfg = config.hazards.geyser;
    var r = cfg.radius;
    gameContext.save();
    // Vent rim + dark throat (always).
    gameContext.beginPath();
    gameContext.arc(x, y, r, 0, 2 * Math.PI);
    gameContext.fillStyle = "#3a2f2a";
    gameContext.fill();
    gameContext.lineWidth = 3;
    gameContext.strokeStyle = "#6b5546";
    gameContext.stroke();
    gameContext.beginPath();
    gameContext.arc(x, y, r * 0.6, 0, 2 * Math.PI);
    gameContext.fillStyle = "#241c18";
    gameContext.fill();

    if (state === 2) {
        // Erupting: a filled orange burst with radial spikes out to the reach.
        gameContext.globalAlpha = 0.85;
        gameContext.fillStyle = cfg.color;
        gameContext.beginPath();
        gameContext.arc(x, y, cfg.attackRadius, 0, 2 * Math.PI);
        gameContext.fill();
        gameContext.globalAlpha = 1;
        gameContext.fillStyle = "#FFD27B";
        for (var s = 0; s < 8; s++) {
            var a = (s / 8) * 2 * Math.PI;
            gameContext.beginPath();
            gameContext.arc(x + Math.cos(a) * cfg.attackRadius, y + Math.sin(a) * cfg.attackRadius, 5, 0, 2 * Math.PI);
            gameContext.fill();
        }
    } else if (state === 1) {
        // Charging: a pulsing warning ring (grows toward the eruption reach) + a
        // couple of rising bubbles. Date.now drives the pulse; no game state needed.
        var t = (Date.now() % 700) / 700;          // 0..1 sawtooth
        var ringR = r + t * (cfg.attackRadius - r);
        gameContext.globalAlpha = 0.7 * (1 - t);
        gameContext.lineWidth = 4;
        gameContext.strokeStyle = cfg.color;
        gameContext.beginPath();
        gameContext.arc(x, y, ringR, 0, 2 * Math.PI);
        gameContext.stroke();
        gameContext.globalAlpha = 0.9;
        gameContext.fillStyle = "#FFD27B";
        gameContext.beginPath();
        gameContext.arc(x + (t - 0.5) * 6, y - t * r, 2.5, 0, 2 * Math.PI);
        gameContext.fill();
        gameContext.globalAlpha = 1;
    }
    gameContext.restore();
}

// A proximity mine. `state` is the server phase (netState): 0 armed (spiked body
// + a steady amber light), 1 fuse (the light blinks red fast — clear off!), 2
// spent (a dark scorched crater). The trigger radius is left invisible in play;
// the editor shows it.
function drawMine(x, y, state) {
    var cfg = config.hazards.mine;
    var r = cfg.bodyRadius;
    gameContext.save();
    if (state === 2) {
        // Spent crater.
        gameContext.beginPath();
        gameContext.arc(x, y, r * 1.4, 0, 2 * Math.PI);
        gameContext.fillStyle = "rgba(20,16,14,0.55)";
        gameContext.fill();
        gameContext.restore();
        return;
    }
    // Spikes.
    gameContext.strokeStyle = "#222";
    gameContext.lineWidth = 3;
    for (var s = 0; s < 8; s++) {
        var a = (s / 8) * 2 * Math.PI;
        gameContext.beginPath();
        gameContext.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
        gameContext.lineTo(x + Math.cos(a) * (r + 5), y + Math.sin(a) * (r + 5));
        gameContext.stroke();
    }
    // Body.
    gameContext.beginPath();
    gameContext.arc(x, y, r, 0, 2 * Math.PI);
    gameContext.fillStyle = "#2b2b2b";
    gameContext.fill();
    // Light: steady amber when armed, a slower red countdown blink while the fuse
    // burns (paced to read as "you've got a moment to get clear").
    var lit = (state === 1) ? ((Date.now() % 360) < 200) : true;
    if (lit) {
        gameContext.beginPath();
        gameContext.arc(x, y, r * 0.4, 0, 2 * Math.PI);
        gameContext.fillStyle = (state === 1) ? "#ff2e2e" : "#ffc24b";
        gameContext.fill();
    }
    gameContext.restore();
}

// A vortex well: a circular pull zone. The interior reads as a BLURRED, hazy swirl
// — the blur effect is a soft violet haze + a smeared spiral baked ONCE into an
// offscreen sprite (the getBlackoutHoleSprite pattern: ctx.filter blur is applied
// at BAKE time, never per frame — a per-frame canvas filter is a mobile GPU
// killer). The sprite is rotated and blitted each frame (one cheap drawImage) so
// the blur churns; a crisp rim, a couple of sharp swirl strokes, and the dark core
// sit on top so the structure stays legible. Violet = the force-field palette.
var vortexHazeSprite = null;
function getVortexHazeSprite() {
    if (vortexHazeSprite != null) { return vortexHazeSprite; }
    var cfg = config.hazards.vortexWell;
    var R = cfg.radius;
    var blurPx = Math.max(6, Math.round(R * 0.14));
    var pad = blurPx + 6;
    var size = (R + pad) * 2;
    var cv = document.createElement("canvas");
    cv.width = size; cv.height = size;
    var ctx = cv.getContext("2d");
    var cx = size / 2, cy = size / 2;
    ctx.filter = "blur(" + blurPx + "px)";   // BAKE-TIME blur (once), never per frame
    // Smeared swirl arms (baked blurred -> reads as motion-blurred churn).
    ctx.lineCap = "round";
    ctx.strokeStyle = cfg.color;
    ctx.globalAlpha = 0.5;
    for (var a = 0; a < 3; a++) {
        var base = (a / 3) * Math.PI * 2;
        ctx.beginPath();
        var first = true;
        for (var t = 0; t <= 1.001; t += 0.05) {
            var rr = R * (1 - t) + cfg.coreRadius * t;
            var ang = base + t * Math.PI * 1.9;
            var px = cx + Math.cos(ang) * rr, py = cy + Math.sin(ang) * rr;
            if (first) { ctx.moveTo(px, py); first = false; } else { ctx.lineTo(px, py); }
        }
        ctx.lineWidth = 16;
        ctx.stroke();
    }
    // Frosted haze: denser toward the eye, fading to nothing at the rim.
    ctx.globalAlpha = 1;
    var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    g.addColorStop(0, "rgba(167,123,255,0.42)");
    g.addColorStop(0.55, "rgba(150,110,235,0.16)");
    g.addColorStop(1, "rgba(167,123,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2 * Math.PI); ctx.fill();
    vortexHazeSprite = cv;
    return cv;
}
function drawVortexWell(x, y, radius) {
    var cfg = config.hazards.vortexWell;
    var maxR = cfg.radius;
    var R = (radius != null && radius > 0) ? radius : maxR;   // per-instance authored size
    var coreR = cfg.coreRadius * (R / maxR);                  // scale the centre with the well
    var spin = (Date.now() / 1100) % (Math.PI * 2);
    gameContext.save();
    // Blurred haze swirl (baked once at max size), rotated so the blur churns and
    // scaled to this well's radius. One cheap blit (no per-frame filter).
    var sprite = getVortexHazeSprite();
    if (sprite != null) {
        var s = R / maxR;
        gameContext.save();
        gameContext.translate(x, y);
        gameContext.rotate(spin);
        gameContext.scale(s, s);
        gameContext.drawImage(sprite, -sprite.width / 2, -sprite.height / 2);
        gameContext.restore();
    }
    // Faint crisp reach rim.
    gameContext.beginPath();
    gameContext.arc(x, y, R, 0, 2 * Math.PI);
    gameContext.strokeStyle = "rgba(167,123,255,0.22)";
    gameContext.lineWidth = 2;
    gameContext.stroke();
    // A couple of crisp swirl strokes on top so the structure stays legible.
    gameContext.lineCap = "round";
    gameContext.globalAlpha = 0.6;
    gameContext.strokeStyle = cfg.color;
    gameContext.lineWidth = 2.5;
    for (var a = 0; a < 2; a++) {
        var base = spin + (a / 2) * Math.PI * 2;
        gameContext.beginPath();
        var first = true;
        for (var t = 0; t <= 1.001; t += 0.08) {
            var rr = R * (1 - t) + coreR * t;
            var ang = base + t * Math.PI * 1.6;
            var px = x + Math.cos(ang) * rr, py = y + Math.sin(ang) * rr;
            if (first) { gameContext.moveTo(px, py); first = false; }
            else { gameContext.lineTo(px, py); }
        }
        gameContext.stroke();
    }
    gameContext.globalAlpha = 1;
    // Dark core (crisp).
    gameContext.beginPath();
    gameContext.arc(x, y, coreR, 0, 2 * Math.PI);
    gameContext.fillStyle = "#2a1f44";
    gameContext.fill();
    gameContext.strokeStyle = cfg.color;
    gameContext.lineWidth = 2;
    gameContext.stroke();
    gameContext.restore();
}

// Per-pair portal colour: the two halves of a warp pair share a hue so a player can
// see at a glance which pad sends where. `pair` is the netState the server ships
// (the map entry's pairing id); index a fixed palette of cool "portal" hues by it.
var WARP_PAIR_COLORS = ["#C24DFF", "#36C5F0", "#F45D9C", "#7C6BFF", "#33D6C0", "#FF8A3D"];
function warpPairColor(pair) {
    var i = (typeof pair === "number" && isFinite(pair)) ? (((pair | 0) % WARP_PAIR_COLORS.length) + WARP_PAIR_COLORS.length) % WARP_PAIR_COLORS.length : 0;
    return WARP_PAIR_COLORS[i];
}
// A warp pad: one half of a paired teleporter. A glowing portal ring in the pair's
// hue with a rotating energy swirl and a bright core — reads as "step here and you're
// whisked away", distinct from the vortex well's violet pull-haze (which sucks you to
// a dark centre; this one is a clean, spinning gateway). `pair` is the netState the
// server ships so both halves match colour. No timed state — static portal.
function drawWarpPad(x, y, pair) {
    var R = config.boons.warpPad.radius;
    var col = warpPairColor(pair);
    var spin = (Date.now() / 700) % (Math.PI * 2);
    gameContext.save();
    // Soft outer glow ring (the portal's reach).
    gameContext.beginPath();
    gameContext.arc(x, y, R, 0, 2 * Math.PI);
    gameContext.strokeStyle = col;
    gameContext.globalAlpha = 0.25;
    gameContext.lineWidth = 6;
    gameContext.stroke();
    gameContext.globalAlpha = 1;
    // Two counter-rotating energy arcs (the "active gateway" cue).
    gameContext.lineCap = "round";
    gameContext.lineWidth = 3;
    gameContext.strokeStyle = col;
    for (var a = 0; a < 2; a++) {
        var dir = a === 0 ? 1 : -1;
        var base = spin * dir + a * Math.PI;
        gameContext.beginPath();
        gameContext.arc(x, y, R * 0.7, base, base + Math.PI * 1.1);
        gameContext.stroke();
    }
    // Inward swirl toward the core (a few arms) — the "whisk away" read.
    gameContext.globalAlpha = 0.55;
    gameContext.lineWidth = 2;
    for (var s = 0; s < 3; s++) {
        var ba = spin + (s / 3) * Math.PI * 2;
        gameContext.beginPath();
        var first = true;
        for (var t = 0; t <= 1.001; t += 0.1) {
            var rr = R * 0.62 * (1 - t) + R * 0.12 * t;
            var ang = ba + t * Math.PI * 1.4;
            var px = x + Math.cos(ang) * rr, py = y + Math.sin(ang) * rr;
            if (first) { gameContext.moveTo(px, py); first = false; } else { gameContext.lineTo(px, py); }
        }
        gameContext.stroke();
    }
    gameContext.globalAlpha = 1;
    // Bright core.
    gameContext.beginPath();
    gameContext.arc(x, y, R * 0.2, 0, 2 * Math.PI);
    gameContext.fillStyle = "#FFFFFF";
    gameContext.fill();
    gameContext.beginPath();
    gameContext.arc(x, y, R * 0.32, 0, 2 * Math.PI);
    gameContext.strokeStyle = col;
    gameContext.lineWidth = 2.5;
    gameContext.stroke();
    gameContext.restore();
}

// A laser gate: an energy barrier strung between two pylons that blinks on a timed
// cycle. `angle` (fixed, from the creation row) runs the beam from its anchor along
// the pylon axis; `state` is the live netState — 0 open (beam off, faint dotted
// guide), 1 warn (a flickering shimmer telegraph), 2 solid (a bright, blocking beam).
// Cyan = the energy-barrier palette (distinct from bumper-orange and vortex-violet).
function drawLaserGate(x, y, angle, state) {
    var cfg = config.hazards.laserGate;
    var rad = (angle || 0) * (Math.PI / 180);
    var bx = x + Math.cos(rad) * cfg.width;
    var by = y + Math.sin(rad) * cfg.width;
    gameContext.save();
    gameContext.lineCap = "round";
    // Pylons (the emitters at each end) — always drawn.
    for (var p = 0; p < 2; p++) {
        var px = p === 0 ? x : bx, py = p === 0 ? y : by;
        gameContext.beginPath();
        gameContext.arc(px, py, 7, 0, 2 * Math.PI);
        gameContext.fillStyle = "#1d3a44";
        gameContext.fill();
        gameContext.lineWidth = 2.5;
        gameContext.strokeStyle = cfg.color;
        gameContext.stroke();
    }
    if (state === 2) {
        // Solid: a bright glowing beam (outer halo + core) — this blocks.
        gameContext.globalAlpha = 0.35;
        gameContext.strokeStyle = cfg.color;
        gameContext.lineWidth = cfg.height + 8;
        gameContext.beginPath(); gameContext.moveTo(x, y); gameContext.lineTo(bx, by); gameContext.stroke();
        gameContext.globalAlpha = 1;
        gameContext.strokeStyle = "#EAFBFF";
        gameContext.lineWidth = cfg.height;
        gameContext.beginPath(); gameContext.moveTo(x, y); gameContext.lineTo(bx, by); gameContext.stroke();
    } else if (state === 1) {
        // Warn: a flickering shimmer telegraph — still passable, your cue to commit or
        // wait. Date.now drives the flicker; no game state needed.
        var flick = 0.3 + 0.45 * (0.5 + 0.5 * Math.sin(Date.now() / 60));
        gameContext.globalAlpha = flick;
        gameContext.setLineDash([10, 8]);
        gameContext.lineDashOffset = -(Date.now() / 40) % 18;
        gameContext.strokeStyle = cfg.color;
        gameContext.lineWidth = cfg.height;
        gameContext.beginPath(); gameContext.moveTo(x, y); gameContext.lineTo(bx, by); gameContext.stroke();
        gameContext.setLineDash([]);
        gameContext.globalAlpha = 1;
    } else {
        // Open: a faint dotted guide so authors/players see where the beam will be.
        gameContext.globalAlpha = 0.22;
        gameContext.setLineDash([3, 11]);
        gameContext.strokeStyle = cfg.color;
        gameContext.lineWidth = 2;
        gameContext.beginPath(); gameContext.moveTo(x, y); gameContext.lineTo(bx, by); gameContext.stroke();
        gameContext.setLineDash([]);
        gameContext.globalAlpha = 1;
    }
    gameContext.restore();
}

// A crusher: a heavy bolted steel BLOCK that slides along a rail (Thwomp). Drawn
// deliberately chunky — a riveted metal body with a 3D bevel and a row of crushing
// TEETH on its two slam faces — so it reads as a piston block, NOT a barrier/fence.
// `railX/railY` is the rail origin and `angle` (fixed, from the creation row) the
// slide direction (a recessed channel + a motor base plate mark the rail). `x,y` is
// the live slab CENTER (smoothed); the block is broadside to the rail, so its slam
// faces point along the slide axis.
function drawCrusher(x, y, railX, railY, angle) {
    var cfg = config.hazards.crusher;
    var rad = (angle || 0) * (Math.PI / 180);
    var dirX = Math.cos(rad), dirY = Math.sin(rad);            // along the rail
    var hw = cfg.width / 2, hh = cfg.height / 2;
    // Rail: a recessed steel channel from the anchor, with a motor base plate at the
    // origin — mechanical hardware, not a dotted line.
    gameContext.save();
    gameContext.lineCap = "butt";
    gameContext.strokeStyle = "rgba(58,61,64,0.55)";
    gameContext.lineWidth = 7;
    gameContext.beginPath();
    gameContext.moveTo(railX, railY);
    gameContext.lineTo(railX + dirX * cfg.railLength, railY + dirY * cfg.railLength);
    gameContext.stroke();
    gameContext.strokeStyle = "rgba(120,126,132,0.5)";
    gameContext.lineWidth = 1.5;
    gameContext.beginPath();
    gameContext.moveTo(railX, railY);
    gameContext.lineTo(railX + dirX * cfg.railLength, railY + dirY * cfg.railLength);
    gameContext.stroke();
    gameContext.translate(railX, railY);
    gameContext.rotate(rad + Math.PI / 2);
    gameContext.fillStyle = "#33363a";
    gameContext.fillRect(-hw - 4, -8, cfg.width + 8, 16);      // base plate / motor housing
    gameContext.restore();
    // The block — centered on (x,y), broadside to the rail.
    gameContext.save();
    gameContext.translate(x, y);
    gameContext.rotate(rad + Math.PI / 2);                     // long axis = perpendicular to rail; slam faces at y = +/-hh
    // Crushing teeth on both slam faces (triangles pointing OUT along the slide axis).
    gameContext.fillStyle = "#6c7176";
    var teeth = 7, tw = cfg.width / teeth, tooth = 6;
    for (var ti = 0; ti < teeth; ti++) {
        var tx0 = -hw + ti * tw;
        gameContext.beginPath();
        gameContext.moveTo(tx0, -hh); gameContext.lineTo(tx0 + tw, -hh); gameContext.lineTo(tx0 + tw / 2, -hh - tooth);
        gameContext.closePath(); gameContext.fill();
        gameContext.beginPath();
        gameContext.moveTo(tx0, hh); gameContext.lineTo(tx0 + tw, hh); gameContext.lineTo(tx0 + tw / 2, hh + tooth);
        gameContext.closePath(); gameContext.fill();
    }
    // Beveled steel body (light top edge -> dark bottom along the thickness = 3D heft).
    var grad = gameContext.createLinearGradient(0, -hh, 0, hh);
    grad.addColorStop(0, "#c4c9ce");
    grad.addColorStop(0.45, cfg.color);
    grad.addColorStop(1, "#54585d");
    gameContext.fillStyle = grad;
    gameContext.fillRect(-hw, -hh, cfg.width, cfg.height);
    gameContext.strokeStyle = "#303336";
    gameContext.lineWidth = 2;
    gameContext.strokeRect(-hw, -hh, cfg.width, cfg.height);
    // Inset seam + corner rivets.
    gameContext.strokeStyle = "rgba(48,51,54,0.6)";
    gameContext.lineWidth = 1;
    gameContext.strokeRect(-hw + 4, -hh + 4, cfg.width - 8, cfg.height - 8);
    gameContext.fillStyle = "#3c4044";
    var rvx = hw - 6, rvy = hh - 5;
    var corners = [[-rvx, -rvy], [rvx, -rvy], [rvx, rvy], [-rvx, rvy]];
    for (var ci = 0; ci < 4; ci++) {
        gameContext.beginPath();
        gameContext.arc(corners[ci][0], corners[ci][1], 2.2, 0, 2 * Math.PI);
        gameContext.fill();
    }
    gameContext.restore();
}

// Sentry turret: a stationary emplacement with a barrel that tracks (h.angle, the
// smoothed streamed facing) and a phase glow (h.state: 0 idle, 1 charging telegraph,
// 2 firing). The rotating barrel + charge ring ARE the dodge telegraph — break the
// barrel's line during the charge and the shot aborts (server). The full firing arc
// is shown in the editor (it has the fixed mount angle); live, the barrel is the cue.
function drawSentryTurret(x, y, angle, state) {
    var cfg = config.hazards.sentryTurret;
    var rad = (angle || 0) * (Math.PI / 180);
    gameContext.save();
    // Destroyed (state 3): a smashed, dead emplacement — a charred broken-off barrel
    // stub and a cracked grey dome with no red glow, so it reads instantly as "this
    // one's been knocked out". No telegraph ring, no muzzle.
    if (state === 3) {
        // snapped barrel stub, drooped off its mount facing
        var stubLen = cfg.barrelLength * 0.45;
        var sx = x + Math.cos(rad) * stubLen, sy = y + Math.sin(rad) * stubLen;
        gameContext.lineCap = "round";
        gameContext.strokeStyle = "#23262a";
        gameContext.lineWidth = 9;
        gameContext.beginPath();
        gameContext.moveTo(x, y);
        gameContext.lineTo(sx, sy);
        gameContext.stroke();
        // dead body: dim grey base, scorched dark dome (no hazard-red)
        gameContext.fillStyle = "#3f444a";
        gameContext.beginPath();
        gameContext.arc(x, y, cfg.radius, 0, 2 * Math.PI);
        gameContext.fill();
        gameContext.lineWidth = 3;
        gameContext.strokeStyle = "#202327";
        gameContext.stroke();
        gameContext.fillStyle = "#2a2d31";
        gameContext.beginPath();
        gameContext.arc(x, y, cfg.radius * 0.55, 0, 2 * Math.PI);
        gameContext.fill();
        // a couple of crack lines across the dome
        gameContext.strokeStyle = "#15171a";
        gameContext.lineWidth = 1.5;
        gameContext.beginPath();
        gameContext.moveTo(x - cfg.radius * 0.6, y - cfg.radius * 0.2);
        gameContext.lineTo(x + cfg.radius * 0.3, y + cfg.radius * 0.5);
        gameContext.moveTo(x - cfg.radius * 0.1, y - cfg.radius * 0.6);
        gameContext.lineTo(x + cfg.radius * 0.2, y + cfg.radius * 0.1);
        gameContext.stroke();
        gameContext.restore();
        return;
    }
    // Charging: a pulsing red telegraph ring around the body — "it's locking on".
    if (state === 1) {
        var pulse = 0.35 + 0.4 * (0.5 + 0.5 * Math.sin(Date.now() / 70));
        gameContext.globalAlpha = pulse;
        gameContext.strokeStyle = cfg.color;
        gameContext.lineWidth = 3;
        gameContext.beginPath();
        gameContext.arc(x, y, cfg.radius + 7, 0, 2 * Math.PI);
        gameContext.stroke();
        gameContext.globalAlpha = 1;
    }
    // Barrel.
    var bx = x + Math.cos(rad) * cfg.barrelLength, by = y + Math.sin(rad) * cfg.barrelLength;
    gameContext.lineCap = "round";
    gameContext.strokeStyle = "#34383d";
    gameContext.lineWidth = 9;
    gameContext.beginPath();
    gameContext.moveTo(x, y);
    gameContext.lineTo(bx, by);
    gameContext.stroke();
    // Muzzle flash on the firing tick.
    if (state === 2) {
        gameContext.globalAlpha = 0.6;
        gameContext.fillStyle = cfg.color;
        gameContext.beginPath();
        gameContext.arc(bx, by, 12, 0, 2 * Math.PI);
        gameContext.fill();
        gameContext.globalAlpha = 1;
        gameContext.fillStyle = "#fff2c8";
        gameContext.beginPath();
        gameContext.arc(bx, by, 6, 0, 2 * Math.PI);
        gameContext.fill();
    }
    // Body: a bolted base ring with a red dome (the hazard-orange "this hurts" cue).
    gameContext.fillStyle = "#5a6066";
    gameContext.beginPath();
    gameContext.arc(x, y, cfg.radius, 0, 2 * Math.PI);
    gameContext.fill();
    gameContext.lineWidth = 3;
    gameContext.strokeStyle = "#2b2f33";
    gameContext.stroke();
    gameContext.fillStyle = cfg.color;
    gameContext.beginPath();
    gameContext.arc(x, y, cfg.radius * 0.55, 0, 2 * Math.PI);
    gameContext.fill();
    gameContext.restore();
}

// --- Antlions brutal round: antlion + thumper hazard rendering -----------------
// Ported from docs/spikes/antlion-prototype.html (drawAntlion, hl2 palette) and
// docs/spikes/restrictor-prototype.html (drawThumper, Nova Prospekt heavy
// variant). Hot-path rules: every gradient/shadowBlur surface is baked ONCE into
// an offscreen sprite (zombie-sheet pattern); per-frame work is shadow ellipses,
// rotated blits, and cheap stroked arcs/fills. Coordinates are raw world coords,
// the same convention as drawBumper/the map blit they share drawMap with.

var ANTLION_FRAMES = 12;
var ANTLION_FRAME_PX = 128;
var ANTLION_SPAN = 122;        // design units per frame (~118 box + margin)
var ANTLION_WORLD_SPAN = 42;   // world px the frame box spans on screen
var ANTLION_RATE = 9;          // rad/s skitter; one baked cycle = 2PI/9 s
var ANTLION_PAL = {
    shell: '#cfc29a', shellDark: '#8e8560', belly: '#b7a87c',
    plate: '#a8bb8a', plateDark: '#6f8a5c',
    mandible: '#4f3f2a', mandibleHi: '#8a774f',
    leg: '#7d7252', legDark: '#4e4734',
    glow: '#9fe6b8', eye: '#1f241c'
};
var antlionSheet = null;

function antlionBakeLeg(ctx, P, hx, hy, kx, ky, fx, fy, w) {
    ctx.strokeStyle = P.legDark; ctx.lineWidth = w + 2.4;
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(kx, ky); ctx.lineTo(fx, fy); ctx.stroke();
    ctx.strokeStyle = P.leg; ctx.lineWidth = w;
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(kx, ky); ctx.lineTo(fx, fy); ctx.stroke();
    // claw tip
    ctx.strokeStyle = P.legDark; ctx.lineWidth = Math.max(1.4, w * 0.45);
    ctx.beginPath(); ctx.moveTo(fx, fy);
    ctx.lineTo(fx + (fx - kx) * 0.18, fy + (fy - ky) * 0.18); ctx.stroke();
}
function antlionBakeGrad(ctx, x0, y0, x1, y1, c0, c1) {
    var g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, c0); g.addColorStop(1, c1);
    return g;
}
// One pose of the skitter cycle, origin = body centre, facing -y. ph runs 0..2PI
// and every sine rate is an integer multiple of it so the baked loop closes
// seamlessly. Gradients/shadowBlur are fine HERE (bake time only).
function bakeAntlionFrame(ctx, ph) {
    var S = Math.sin, C = Math.cos, PI = Math.PI;
    var P = ANTLION_PAL;
    var s, i;
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.translate(0, S(ph) * 0.8); // idle bob (snapped to 1x leg rate)

    // rear legs (under everything)
    for (i = 0; i < 2; i++) {
        s = (i === 0) ? 1 : -1;
        var phR = ph + (s > 0 ? 2.1 : 2.1 + PI * 0.8);
        antlionBakeLeg(ctx, P,
            s * 8, 1,
            s * (27 + S(phR) * 1.2), 9 + C(phR) * 1.0,
            s * (39 + S(phR) * 2.2), 20 + C(phR) * 1.6,
            3.4);
    }
    // abdomen — tail first so forward segments overlap
    var segs = [
        { y: 12, rx: 12.5, ry: 8 },
        { y: 21.5, rx: 10.8, ry: 7 },
        { y: 30, rx: 8.8, ry: 6 },
        { y: 38, rx: 6.2, ry: 4.6 },
        { y: 44, rx: 3.8, ry: 3 }
    ];
    for (i = segs.length - 1; i >= 0; i--) {
        var g = segs[i];
        var rx = g.rx * (1 + 0.02 * S(ph + i));
        ctx.fillStyle = antlionBakeGrad(ctx, 0, g.y - g.ry, 0, g.y + g.ry, P.shell, P.shellDark);
        ctx.strokeStyle = P.shellDark; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.ellipse(0, g.y, rx, g.ry, 0, 0, PI * 2);
        ctx.fill(); ctx.stroke();
    }
    // glow vents between segments (2x rate pulse)
    for (i = 0; i < 3; i++) {
        var vy = (segs[i].y + segs[i + 1].y) / 2;
        var vx = segs[i + 1].rx * 0.55;
        ctx.fillStyle = P.glow;
        ctx.globalAlpha = Math.min(1, Math.max(0, (0.25 + 0.35 * S(ph * 2 + i * 1.3)) * 0.6));
        ctx.beginPath(); ctx.arc(-vx, vy, 1.5, 0, PI * 2); ctx.arc(vx, vy, 1.5, 0, PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
    }
    // front legs — big digging scythes
    for (i = 0; i < 2; i++) {
        s = (i === 0) ? 1 : -1;
        var phF = ph + (s > 0 ? 0 : PI * 0.8);
        antlionBakeLeg(ctx, P,
            s * 9, -12,
            s * (28 + S(phF) * 1.4), -27 + C(phF) * 1.2,
            s * (43 + S(phF) * 2.6), -40 + C(phF) * 2.0,
            4.6);
    }
    // thorax
    ctx.fillStyle = antlionBakeGrad(ctx, 0, -20, 0, 5, P.shell, P.belly);
    ctx.strokeStyle = P.shellDark; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(0, -8, 14, 12.5, 0, 0, PI * 2); ctx.fill(); ctx.stroke();
    // elytra (wing carapace)
    for (i = 0; i < 2; i++) {
        s = (i === 0) ? 1 : -1;
        ctx.fillStyle = antlionBakeGrad(ctx, 0, -6, s * 16, -6, P.plate, P.plateDark);
        ctx.strokeStyle = P.plateDark; ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(s * 0.9, -21);
        ctx.bezierCurveTo(s * 12, -20, s * 17, -9, s * 14.5, 1);
        ctx.bezierCurveTo(s * 12.5, 8, s * 6, 11, s * 0.9, 10.5);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(s * 3, -19);
        ctx.quadraticCurveTo(s * 12, -15, s * 11.5, -2);
        ctx.stroke();
    }
    // glowing carapace seam — shadowBlur is OK at bake time only
    ctx.save();
    ctx.globalAlpha = Math.min(1, Math.max(0, (0.35 + 0.25 * S(ph)) * 0.6));
    ctx.strokeStyle = P.glow; ctx.lineWidth = 1.4;
    ctx.shadowColor = P.glow; ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.moveTo(0, -20); ctx.lineTo(0, 10); ctx.stroke();
    ctx.restore();
    // head shield
    ctx.fillStyle = antlionBakeGrad(ctx, 0, -36, 0, -14, P.shell, P.shellDark);
    ctx.strokeStyle = P.shellDark; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-10, -18);
    ctx.quadraticCurveTo(-12, -28, -6, -33);
    ctx.quadraticCurveTo(0, -37, 6, -33);
    ctx.quadraticCurveTo(12, -28, 10, -18);
    ctx.quadraticCurveTo(0, -13, -10, -18);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.strokeStyle = P.shellDark; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, -34.5); ctx.lineTo(0, -15); ctx.stroke();
    // eye pits
    ctx.fillStyle = P.eye;
    for (i = 0; i < 2; i++) {
        s = (i === 0) ? 1 : -1;
        ctx.beginPath(); ctx.arc(s * 5.2, -26.5, 1.4, 0, PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(s * 7.6, -21.5, 1.0, 0, PI * 2); ctx.fill();
    }
    // antennae (1x rate sway)
    ctx.strokeStyle = P.legDark; ctx.lineWidth = 1.1;
    for (i = 0; i < 2; i++) {
        s = (i === 0) ? 1 : -1;
        ctx.beginPath();
        ctx.moveTo(s * 4.2, -32.5);
        ctx.quadraticCurveTo(s * 8.5, -39 + S(ph + s) * 1.2, s * 12, -45 + S(ph + s) * 2);
        ctx.stroke();
    }
    // mandibles — crescent hooks that snap once per cycle
    var snap = Math.pow(Math.max(0, S(ph - 1)), 6) * 0.5;
    var open = 0.10 + snap;
    for (i = 0; i < 2; i++) {
        s = (i === 0) ? 1 : -1;
        ctx.save();
        ctx.scale(s, 1);
        ctx.translate(8.5, -29.5);
        ctx.rotate(open);
        ctx.fillStyle = P.mandible;
        ctx.strokeStyle = P.mandibleHi; ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.moveTo(-2, 2.5);
        ctx.bezierCurveTo(7.5, 1.5, 11, -9, 1.5, -20);
        ctx.bezierCurveTo(5.5, -11.5, 4, -5.5, -3.2, -0.5);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        // inner teeth
        ctx.fillStyle = P.mandible;
        ctx.beginPath();
        ctx.moveTo(3.2, -5.5); ctx.lineTo(0.8, -7.4); ctx.lineTo(4.0, -8.8); ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(4.4, -10.5); ctx.lineTo(1.9, -12.0); ctx.lineTo(4.6, -13.8); ctx.closePath();
        ctx.fill();
        ctx.restore();
    }
    ctx.restore();
}
function buildAntlionSheet() {
    antlionSheet = document.createElement('canvas');
    antlionSheet.width = ANTLION_FRAMES * ANTLION_FRAME_PX;
    antlionSheet.height = ANTLION_FRAME_PX;
    var ctx = antlionSheet.getContext('2d');
    for (var i = 0; i < ANTLION_FRAMES; i++) {
        ctx.save();
        ctx.translate(i * ANTLION_FRAME_PX + ANTLION_FRAME_PX / 2, ANTLION_FRAME_PX / 2);
        ctx.scale(ANTLION_FRAME_PX / ANTLION_SPAN, ANTLION_FRAME_PX / ANTLION_SPAN);
        bakeAntlionFrame(ctx, (i / ANTLION_FRAMES) * Math.PI * 2);
        ctx.restore();
    }
}

// Per-tick packets carry no angle, so the heading is derived client-side from
// the (already render-smoothed) position deltas and eased so it can't twitch.
function antlionHeading(hz) {
    if (hz.headAngle == null) { hz.headAngle = 0; }
    var lx = (hz._hx == null) ? hz.x : hz._hx;
    var ly = (hz._hy == null) ? hz.y : hz._hy;
    var dx = hz.x - lx, dy = hz.y - ly;
    hz._hx = hz.x; hz._hy = hz.y;
    if (dx * dx + dy * dy > 0.05) {
        var target = Math.atan2(dy, dx);
        var diff = target - hz.headAngle;
        while (diff > Math.PI) { diff -= Math.PI * 2; }
        while (diff < -Math.PI) { diff += Math.PI * 2; }
        hz.headAngle += diff * 0.22;
    }
    return hz.headAngle;
}

function drawAntlionHazard(hz) {
    if (antlionSheet == null) { buildAntlionSheet(); }
    var ctx = gameContext;
    var now = Date.now();
    var heading = antlionHeading(hz);
    var frame = Math.floor((cartSkinAnimTime * ANTLION_RATE / (2 * Math.PI)) * ANTLION_FRAMES) % ANTLION_FRAMES;
    if (frame < 0) { frame += ANTLION_FRAMES; }
    // Emergence: scale/fade up out of the sand over the first ~0.7s after the
    // applyHazards stamp, with a sand mound + dust ring (cheap fills only).
    var e = 1;
    if (hz.spawnAt != null) {
        e = (now - hz.spawnAt) / 700;
        if (e >= 1) { e = 1; hz.spawnAt = null; }
    }
    ctx.save();
    try {
        if (e < 1) {
            // sand mound swell under the digger
            ctx.globalAlpha = 0.5 * (1 - e);
            ctx.fillStyle = '#c7b078';
            ctx.beginPath();
            ctx.ellipse(hz.x, hz.y, 16 + 14 * e, 9 + 8 * e, 0, 0, Math.PI * 2);
            ctx.fill();
            // kicked-up dust ring
            ctx.fillStyle = '#d9c9a0';
            for (var d = 0; d < 7; d++) {
                var da = d * (Math.PI * 2 / 7) + 0.4;
                var dd = 12 + e * 30;
                ctx.globalAlpha = 0.45 * (1 - e);
                ctx.beginPath();
                ctx.arc(hz.x + Math.cos(da) * dd, hz.y + Math.sin(da) * dd, 2 + e * 3, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.globalAlpha = 1;
        }
        // soft ground shadow
        ctx.globalAlpha = Math.min(1, 0.25 * (0.3 + 0.7 * e));
        ctx.fillStyle = 'black';
        ctx.beginPath();
        ctx.ellipse(hz.x, hz.y + 3, ANTLION_WORLD_SPAN * 0.18, ANTLION_WORLD_SPAN * 0.09, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = Math.min(1, 0.25 + 0.75 * e);
        ctx.translate(hz.x, hz.y);
        ctx.rotate(heading + Math.PI / 2); // sheet faces -y; heading 0 = due east
        var span = ANTLION_WORLD_SPAN * (0.35 + 0.65 * e);
        ctx.drawImage(antlionSheet, frame * ANTLION_FRAME_PX, 0, ANTLION_FRAME_PX, ANTLION_FRAME_PX,
            -span / 2, -span / 2, span, span);
    } finally {
        ctx.restore();
    }
}

// Burrow-away FX: the dig-down fade played where a despawned antlion was
// (fed by removeHazards in gameboard.js).
var antlionBurrows = [];
function spawnAntlionBurrowFX(x, y) {
    antlionBurrows.push({ x: x, y: y, at: Date.now() });
}
function drawAntlionBurrows() {
    if (antlionBurrows.length === 0) { return; }
    if (antlionSheet == null) { buildAntlionSheet(); }
    var ctx = gameContext;
    var now = Date.now();
    for (var i = antlionBurrows.length - 1; i >= 0; i--) {
        var b = antlionBurrows[i];
        var e = (now - b.at) / 500;
        if (e >= 1) { antlionBurrows.splice(i, 1); continue; }
        ctx.save();
        try {
            // sinking, shrinking body
            ctx.globalAlpha = 0.9 * (1 - e);
            var span = ANTLION_WORLD_SPAN * (1 - 0.7 * e);
            ctx.translate(b.x, b.y + e * 4);
            ctx.drawImage(antlionSheet, 0, 0, ANTLION_FRAME_PX, ANTLION_FRAME_PX,
                -span / 2, -span / 2, span, span);
            // collapsing sand dimple + dust
            ctx.globalAlpha = 0.5 * (1 - e);
            ctx.fillStyle = '#c7b078';
            ctx.beginPath();
            ctx.ellipse(0, 2, 18 * (1 - 0.4 * e), 10 * (1 - 0.4 * e), 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#d9c9a0';
            for (var d = 0; d < 5; d++) {
                var da = d * (Math.PI * 2 / 5) + 1.1;
                ctx.beginPath();
                ctx.arc(Math.cos(da) * (10 + e * 16), Math.sin(da) * (10 + e * 16), 2.4, 0, Math.PI * 2);
                ctx.fill();
            }
        } finally {
            ctx.restore();
        }
    }
}

// --- Thumper ---
var THUMPER_SPAN = 122;        // design units (~118 box + margin)
var THUMPER_WORLD_SPAN = 100;  // world px the frame box spans on screen
var THUMPER_BULK = 1.22;       // Nova Prospekt heavy variant
var THUMPER_PAL = {
    pad: '#6b6e72', padDark: '#44474b', metal: '#767e88', metalDark: '#454c55',
    slab: '#5f6873', stripe: '#c9a23a', stripeDark: '#26262a', rust: '#704832',
    light: '#ff7030', dust: '#a8a298', glow: '#ffb060'
};
var thumperPadSprite = null;   // static base pad (gradients baked once)
var thumperHeadSprite = null;  // piston head at rest scale (radial grad baked once)
var THUMPER_HEAD_PX = 128;

function buildThumperSprites() {
    var P = THUMPER_PAL;
    var B = THUMPER_BULK;
    var E = 22 * B;
    var PI = Math.PI;
    // -- base pad --
    thumperPadSprite = document.createElement('canvas');
    thumperPadSprite.width = THUMPER_HEAD_PX;
    thumperPadSprite.height = THUMPER_HEAD_PX;
    var ctx = thumperPadSprite.getContext('2d');
    ctx.save();
    ctx.translate(THUMPER_HEAD_PX / 2, THUMPER_HEAD_PX / 2);
    ctx.scale(THUMPER_HEAD_PX / THUMPER_SPAN, THUMPER_HEAD_PX / THUMPER_SPAN);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    var pg = ctx.createLinearGradient(0, -E, 0, E);
    pg.addColorStop(0, P.pad); pg.addColorStop(1, P.padDark);
    ctx.fillStyle = pg;
    ctx.strokeStyle = P.padDark; ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.roundRect(-E, -E, E * 2, E * 2, 7 * B);
    ctx.fill(); ctx.stroke();
    // hazard chevrons along top + bottom edges
    ctx.save();
    ctx.beginPath(); ctx.roundRect(-E + 2, -E + 2, E * 2 - 4, E * 2 - 4, 5 * B); ctx.clip();
    var eys = [-E + 4, E - 8];
    for (var c = 0; c < 2; c++) {
        var ey = eys[c];
        for (var i = 0; i < 9; i++) {
            var x = -E + 3 + i * (E * 2 - 6) / 9;
            ctx.fillStyle = (i % 2 === 0) ? P.stripe : P.stripeDark;
            ctx.beginPath();
            ctx.moveTo(x, ey + 4); ctx.lineTo(x + 3, ey);
            ctx.lineTo(x + 8, ey); ctx.lineTo(x + 5, ey + 4);
            ctx.closePath(); ctx.fill();
        }
    }
    ctx.restore();
    // corner bolts + struts
    var signs = [1, -1];
    for (var sx = 0; sx < 2; sx++) {
        for (var sy = 0; sy < 2; sy++) {
            var kx = signs[sx], ky = signs[sy];
            ctx.strokeStyle = P.metalDark; ctx.lineWidth = 3;
            ctx.beginPath(); ctx.moveTo(kx * (E - 5), ky * (E - 5)); ctx.lineTo(kx * 8 * B, ky * 8 * B); ctx.stroke();
            ctx.strokeStyle = P.metal; ctx.lineWidth = 1.4;
            ctx.beginPath(); ctx.moveTo(kx * (E - 5), ky * (E - 5)); ctx.lineTo(kx * 8 * B, ky * 8 * B); ctx.stroke();
            ctx.fillStyle = P.metalDark;
            ctx.beginPath(); ctx.arc(kx * (E - 4), ky * (E - 4), 1.6, 0, PI * 2); ctx.fill();
        }
    }
    // rust streaks (heavy variant)
    ctx.strokeStyle = P.rust; ctx.globalAlpha = 0.5; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(-10 * B, 10 * B); ctx.quadraticCurveTo(-14 * B, 15 * B, -12 * B, E - 3); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(12 * B, 8 * B); ctx.quadraticCurveTo(15 * B, 13 * B, 14 * B, E - 5); ctx.stroke();
    ctx.globalAlpha = 1;
    // fixed column collar
    ctx.strokeStyle = P.metalDark; ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.arc(0, 0, 10 * B, 0, PI * 2); ctx.stroke();
    ctx.restore();
    // -- piston head (rest scale; live draw scales it with the lift) --
    var R = 16 * B;
    thumperHeadSprite = document.createElement('canvas');
    thumperHeadSprite.width = THUMPER_HEAD_PX;
    thumperHeadSprite.height = THUMPER_HEAD_PX;
    ctx = thumperHeadSprite.getContext('2d');
    ctx.save();
    ctx.translate(THUMPER_HEAD_PX / 2, THUMPER_HEAD_PX / 2);
    // the head only spans ~2R of the 122 box — bake it larger for crispness
    var headScale = THUMPER_HEAD_PX / (R * 2 + 14);
    ctx.scale(headScale, headScale);
    var hg = ctx.createRadialGradient(-R * 0.3, -R * 0.3, R * 0.15, 0, 0, R * 1.05);
    hg.addColorStop(0, P.metal); hg.addColorStop(1, P.metalDark);
    ctx.fillStyle = hg; ctx.strokeStyle = P.metalDark; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, PI * 2); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = P.metalDark; ctx.lineWidth = 1.1;
    ctx.beginPath(); ctx.arc(0, 0, R - 2.6, 0, PI * 2); ctx.stroke();
    ctx.fillStyle = P.slab;
    ctx.beginPath(); ctx.arc(0, 0, R * 0.66, 0, PI * 2); ctx.fill();
    ctx.strokeStyle = P.metalDark;
    ctx.beginPath(); ctx.arc(0, 0, R * 0.66, 0, PI * 2); ctx.stroke();
    var cg = ctx.createRadialGradient(-2, -2, 1, 0, 0, R * 0.36);
    cg.addColorStop(0, P.metal); cg.addColorStop(1, P.metalDark);
    ctx.fillStyle = cg;
    ctx.beginPath(); ctx.arc(0, 0, R * 0.36, 0, PI * 2); ctx.fill();
    ctx.fillStyle = P.metalDark;
    ctx.beginPath(); ctx.arc(0, 0, 2.2, 0, PI * 2); ctx.fill();
    ctx.strokeStyle = P.metal; ctx.lineWidth = 0.9;
    ctx.beginPath(); ctx.moveTo(-1.4, 0); ctx.lineTo(1.4, 0); ctx.stroke();
    ctx.fillStyle = P.metalDark;
    for (var rb = 0; rb < 6; rb++) {
        var ra = rb * PI / 3 + 0.26;
        ctx.beginPath(); ctx.arc(Math.cos(ra) * (R - 5), Math.sin(ra) * (R - 5), 1.3, 0, PI * 2); ctx.fill();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1.1;
    for (var tk = 0; tk < 3; tk++) {
        ctx.beginPath();
        ctx.moveTo(-R * 0.52 + tk * 3.4, -R * 0.78); ctx.lineTo(-R * 0.52 + tk * 3.4 + 1.6, -R * 0.62);
        ctx.stroke();
    }
    ctx.restore();
}

// Slam moment feedback: deep synth thump + camera trauma + a rumble pulse on
// each local pad, all attenuated by that kart's distance. Race states only —
// thumpers also render on the overview/recap-free map states where feedback
// would be noise.
function onThumperSlamFX(hz) {
    if (currentState != config.stateMap.racing && currentState != config.stateMap.collapsing) { return; }
    var level = (typeof antlionSfxLevel === "function") ? antlionSfxLevel(hz.x, hz.y) : 0.5;
    if (typeof playThumperSlam === "function") { playThumperSlam(level); }
    if (level > 0.45) { addTrauma(0.16 * level); }
    if (typeof padPulseForId === "function" && typeof localPlayers !== "undefined" && localPlayers) {
        for (var s = 0; s < localPlayers.length; s++) {
            var lp = localPlayers[s];
            if (lp == null || lp.myID == null) { continue; }
            var p = playerList[lp.myID];
            if (p == null) { continue; }
            var d = Math.sqrt((p.x - hz.x) * (p.x - hz.x) + (p.y - hz.y) * (p.y - hz.y));
            var lvl = 1 - d / 650;
            if (lvl > 0.1) { padPulseForId(lp.myID, 0.45 * lvl, 0.25 * lvl, 140); }
        }
    }
}

function drawThumperHazard(hz) {
    if (thumperPadSprite == null) { buildThumperSprites(); }
    var ctx = gameContext;
    var now = Date.now();
    var cfg = config.brutalRounds.antlion;
    var period = cfg.thumperPeriod * 1000;
    if (hz.nextSlamAt == null) { hz.nextSlamAt = now + period; hz.lastSlamAt = 0; }
    // Hidden-tab catch-up: fast-forward whole missed cycles silently so a
    // refocus doesn't machine-gun the slam FX.
    if (now - hz.nextSlamAt > period) {
        hz.nextSlamAt += Math.ceil((now - hz.nextSlamAt) / period) * period;
    }
    if (now >= hz.nextSlamAt) {
        hz.lastSlamAt = hz.nextSlamAt;
        hz.nextSlamAt += period;
        onThumperSlamFX(hz);
    }
    // Lift phase: slow rise over most of the cycle, brief hold, fast drop that
    // lands exactly on the server's slam tick (u = 1).
    var u = 1 - (hz.nextSlamAt - now) / period;
    if (u < 0) { u = 0; }
    var h;
    if (u < 0.82) { var k = u / 0.82; h = k * k * (3 - 2 * k); }
    else if (u < 0.93) { h = 1; }
    else { h = 1 - (u - 0.93) / 0.07; }
    var s = (hz.lastSlamAt > 0) ? (now - hz.lastSlamAt) / 1000 : 9; // s since slam
    var worldScale = THUMPER_WORLD_SPAN / THUMPER_SPAN;
    var B = THUMPER_BULK, R = 16 * B * worldScale, E = 22 * B * worldScale;
    ctx.save();
    try {
        ctx.translate(hz.x, hz.y);
        // repel-radius ground ring (true gameplay radius), flashing on the slam
        ctx.save();
        ctx.setLineDash([6, 6]);
        ctx.strokeStyle = THUMPER_PAL.stripe;
        ctx.globalAlpha = 0.10 + 0.30 * Math.exp(-s * 3);
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(0, 0, cfg.repelRadius, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
        // shockwave rings
        for (var w = 0; w < 2; w++) {
            var wr = 18 * B * worldScale + (s + w * 0.06) * 170;
            if (wr > cfg.repelRadius * 1.25) { continue; }
            var wa = Math.max(0, 0.5 * Math.exp(-s * 2.2) - w * 0.12);
            if (wa <= 0.01) { continue; }
            ctx.strokeStyle = 'rgba(230,225,210,' + wa.toFixed(3) + ')';
            ctx.lineWidth = 2.5 - w;
            ctx.beginPath(); ctx.arc(0, 0, wr, 0, Math.PI * 2); ctx.stroke();
        }
        // dust puffs
        var dustA = 0.35 * Math.exp(-s * 3.5);
        if (dustA > 0.02) {
            ctx.fillStyle = THUMPER_PAL.dust;
            for (var dp = 0; dp < 8; dp++) {
                var dpa = dp * Math.PI / 4 + 0.3;
                var dpd = 19 * B * worldScale + s * 60;
                ctx.globalAlpha = dustA;
                ctx.beginPath();
                ctx.arc(Math.cos(dpa) * dpd, Math.sin(dpa) * dpd, 2.2 + s * 3, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.globalAlpha = 1;
        }
        // ground jitter right after impact
        var j = Math.exp(-s * 9) * 1.4;
        ctx.translate(Math.sin(s * 70) * j, Math.cos(s * 55) * j);
        // base pad (baked)
        ctx.drawImage(thumperPadSprite, -THUMPER_WORLD_SPAN / 2, -THUMPER_WORLD_SPAN / 2, THUMPER_WORLD_SPAN, THUMPER_WORLD_SPAN);
        // indicator lights — blink faster while the head is up (cheap arcs)
        var animT = now / 1000;
        for (var li = 0; li < 2; li++) {
            var ls = (li === 0) ? 1 : -1;
            var on = Math.sin(animT * (4 + h * 6) + ls) > 0;
            ctx.fillStyle = THUMPER_PAL.light;
            ctx.globalAlpha = on ? 1 : 0.22;
            ctx.beginPath(); ctx.arc(ls * (E - 4 * worldScale * B), E - 4 * worldScale * B, 1.7, 0, Math.PI * 2); ctx.fill();
            ctx.globalAlpha = 1;
        }
        // piston head drop shadow slides out as it lifts
        ctx.fillStyle = 'rgba(0,0,0,' + (0.18 + h * 0.14).toFixed(3) + ')';
        ctx.beginPath();
        ctx.ellipse(h * 6, h * 8, R * (1 + 0.1 * h), R * (0.92 + 0.1 * h), 0, 0, Math.PI * 2);
        ctx.fill();
        // piston head (baked; scales up with lift = closer to camera)
        var headSpan = (R * 2 + 14 * worldScale) * (1 + 0.22 * h);
        ctx.drawImage(thumperHeadSprite, -headSpan / 2, -headSpan / 2, headSpan, headSpan);
        // protective cage (heavy variant) — cheap strokes over the head
        ctx.strokeStyle = THUMPER_PAL.metalDark; ctx.lineWidth = 2.6;
        ctx.beginPath(); ctx.arc(0, 0, R + 4.5, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = THUMPER_PAL.metal; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(0, 0, R + 4.5, 0, Math.PI * 2); ctx.stroke();
        var cageAngles = [Math.PI / 4, 3 * Math.PI / 4, 5 * Math.PI / 4, 7 * Math.PI / 4];
        ctx.strokeStyle = THUMPER_PAL.metalDark; ctx.lineWidth = 2.2;
        for (var ca = 0; ca < 4; ca++) {
            var a = cageAngles[ca];
            var den = Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
            ctx.beginPath();
            ctx.moveTo(Math.cos(a) * (R + 4.5), Math.sin(a) * (R + 4.5));
            ctx.lineTo(Math.cos(a) * (E - 4 * worldScale) / den, Math.sin(a) * (E - 4 * worldScale) / den);
            ctx.stroke();
        }
    } finally {
        ctx.restore();
    }
}

// Dash Arrows — a teal directional speed pad: a translucent pill footprint with
// two chevrons pointing along `angle` (the boost direction). Teal (not bumper
// orange) so "this helps you" reads as the opposite of the hazard palette.
function drawDashArrows(x, y, angle) {
    var cfg = config.boons.dashArrows;
    var rad = (angle || 0) * (Math.PI / 180);
    var w = cfg.width, hgt = cfg.height;
    gameContext.save();
    gameContext.translate(x, y);
    gameContext.rotate(rad);
    // Faint footprint that blends into the terrain — a barely-there tint + a soft,
    // very transparent rim, so the pad reads as "ground", not a hard-edged decal.
    // The chevrons carry the signal.
    gameContext.beginPath();
    gameContext.rect(-w / 2, -hgt / 2, w, hgt);
    gameContext.fillStyle = "rgba(63,193,201,0.06)";
    gameContext.fill();
    gameContext.strokeStyle = "rgba(63,193,201,0.12)";
    gameContext.lineWidth = 1;
    gameContext.stroke();
    // two chevrons pointing +x (the boost direction), each over a dark contrast halo
    gameContext.lineCap = "round";
    gameContext.lineJoin = "round";
    var ch = hgt * 0.32;
    for (var i = 0; i < 2; i++) {
        var cx = -w * 0.16 + i * (w * 0.30);
        gameContext.beginPath();
        gameContext.moveTo(cx - 8, -ch);
        gameContext.lineTo(cx + 8, 0);
        gameContext.lineTo(cx - 8, ch);
        gameContext.strokeStyle = BOON_HALO; gameContext.lineWidth = 8; gameContext.stroke();
        gameContext.strokeStyle = cfg.color; gameContext.lineWidth = 5; gameContext.stroke();
    }
    gameContext.restore();
}

// Dark contrast halo stroked UNDER every boon's signal art (chevrons, cross, rings,
// streamlines) so the light-blue/green palette stays legible on any terrain — light
// cyan ice in particular would otherwise swallow it. Drawers stroke each path twice:
// this wider dark stroke first, the colored stroke on top.
var BOON_HALO = "rgba(10,40,55,0.6)";

// True when a boon at (x,y) is sitting on a water tile, so its drawer can switch to
// the foam "water variant" that reads against blue water. Cheap nearest-cell lookup
// (gameboard.tileIdAt); recomputed per frame so it stays correct if the terrain under
// the boon mutates mid-round (tileSwap / heatwave / orbital beam).
function boonOnWater(x, y) {
    return typeof tileIdAt === "function" && config.tileMap != null && config.tileMap.water != null
        && tileIdAt(x, y) === config.tileMap.water.id;
}

// Recharge Spring — a SHARED "pit stop" pad with a global charge (server netState,
// arriving as `state`: 0 = just drained .. 100 = ready). Ready: a gently pulsing ring
// (land) or expanding foam ripple + bubbles (water) with a bright restore cross — it's
// available. Recharging (state < 100): the pulse/ripple stop, a fill ring sweeps
// clockwise from the top to the refill percent, and the cross dims — a clear "wait, it's
// refilling" tell. On water the palette is foam-white so it reads against blue. No
// shadowBlur/filter; animation is cheap sin/phase math.
function drawRechargeSpring(x, y, state) {
    var cfg = config.boons.rechargeSpring;
    var r = cfg.radius;
    var onWater = boonOnWater(x, y);
    var ready = (state == null || state >= 100);
    var accent = onWater ? cfg.colorWater : cfg.color;
    gameContext.save();
    gameContext.translate(x, y);
    // Faint footprint (matches the boon visual language; fainter per feedback).
    gameContext.beginPath();
    gameContext.arc(0, 0, r, 0, 2 * Math.PI);
    gameContext.fillStyle = onWater ? "rgba(234,251,255,0.05)" : "rgba(91,227,160,0.04)";
    gameContext.fill();
    if (!ready) {
        // Refilling: dim track + a bright arc filling clockwise from the top to `state`%.
        var frac = Math.max(0, Math.min(1, state / 100));
        gameContext.lineWidth = 3;
        gameContext.beginPath();
        gameContext.arc(0, 0, r * 0.78, 0, 2 * Math.PI);
        gameContext.strokeStyle = accent;
        gameContext.globalAlpha = 0.18;
        gameContext.stroke();
        gameContext.beginPath();
        gameContext.arc(0, 0, r * 0.78, -Math.PI / 2, -Math.PI / 2 + frac * 2 * Math.PI);
        gameContext.globalAlpha = 0.9;
        gameContext.lineCap = "round";
        gameContext.strokeStyle = BOON_HALO; gameContext.lineWidth = 5; gameContext.stroke();
        gameContext.strokeStyle = accent; gameContext.lineWidth = 3; gameContext.stroke();
        gameContext.globalAlpha = 1;
    } else if (onWater) {
        var t = (Date.now() / 900) % 1; // ripple phase 0..1
        // Expanding foam ripple ring.
        gameContext.beginPath();
        gameContext.arc(0, 0, r * (0.35 + 0.6 * t), 0, 2 * Math.PI);
        gameContext.strokeStyle = accent;
        gameContext.globalAlpha = 0.6 * (1 - t);
        gameContext.lineWidth = 2.5;
        gameContext.stroke();
        // Rising bubbles.
        gameContext.fillStyle = accent;
        for (var bi = 0; bi < 3; bi++) {
            var bph = ((Date.now() / 700) + bi * 0.33) % 1;
            var bx = (bi - 1) * r * 0.28;
            var by = r * 0.5 - bph * r;
            gameContext.globalAlpha = 0.7 * (1 - bph);
            gameContext.beginPath();
            gameContext.arc(bx, by, 2.2, 0, 2 * Math.PI);
            gameContext.fill();
        }
        gameContext.globalAlpha = 1;
    } else {
        var pulse = 0.5 + 0.5 * Math.sin(Date.now() / 320);
        // Pulsing recharge ring.
        gameContext.beginPath();
        gameContext.arc(0, 0, r * (0.62 + 0.28 * pulse), 0, 2 * Math.PI);
        gameContext.strokeStyle = accent;
        gameContext.globalAlpha = 0.35 + 0.45 * (1 - pulse);
        gameContext.lineWidth = 3;
        gameContext.stroke();
        gameContext.globalAlpha = 1;
    }
    // Green restore cross in the middle (the shared identity on land + water), over a
    // dark contrast halo so it reads on any terrain — dimmed while refilling so the
    // spent state reads at a glance.
    var arm = r * 0.42;
    gameContext.globalAlpha = ready ? 1 : 0.3;
    gameContext.lineCap = "round";
    gameContext.beginPath();
    gameContext.moveTo(-arm, 0);
    gameContext.lineTo(arm, 0);
    gameContext.moveTo(0, -arm);
    gameContext.lineTo(0, arm);
    gameContext.strokeStyle = BOON_HALO; gameContext.lineWidth = 8; gameContext.stroke();
    gameContext.strokeStyle = cfg.color; gameContext.lineWidth = 5; gameContext.stroke();
    gameContext.globalAlpha = 1;
    gameContext.restore();
}

// Slipstream — a current corridor. On land it's a wind tunnel: faint footprint plus
// straight light-blue streamlines that scroll along the push axis. On water it's a
// river current: foam-white waves. The streamlines + arrowheads always get a dark
// contrast halo stroked underneath so they stay legible on any terrain (light cyan ice
// in particular would otherwise swallow the light-blue art). Cheap: stroked
// dashes/short segments, no shadowBlur/filter.
function drawSlipstream(x, y, angle) {
    var cfg = config.boons.slipstream;
    var rad = (angle || 0) * (Math.PI / 180);
    var w = cfg.width, hgt = cfg.height;
    var onWater = boonOnWater(x, y);
    var halo = BOON_HALO;
    var flow = (Date.now() / 14) % 28; // scroll the dashes toward +x
    gameContext.save();
    gameContext.translate(x, y);
    gameContext.rotate(rad);
    // Faint footprint.
    gameContext.beginPath();
    gameContext.rect(-w / 2, -hgt / 2, w, hgt);
    gameContext.fillStyle = onWater ? "rgba(234,248,255,0.035)" : "rgba(127,216,255,0.03)";
    gameContext.fill();
    gameContext.strokeStyle = onWater ? "rgba(234,248,255,0.06)" : "rgba(127,216,255,0.05)";
    gameContext.lineWidth = 1;
    gameContext.stroke();
    var stroke = onWater ? cfg.colorWater : cfg.color;
    gameContext.lineCap = "round";
    gameContext.lineJoin = "round";
    var rows = [-hgt * 0.28, 0, hgt * 0.28];
    var x0 = -w / 2 + 8, x1 = w / 2 - 16;
    for (var i = 0; i < rows.length; i++) {
        var ly = rows[i];
        if (onWater) {
            // Wavy foam streamline (a river ripple) scrolling toward +x.
            gameContext.beginPath();
            for (var sx = x0; sx <= x1; sx += 8) {
                var wy = ly + Math.sin((sx + flow * 2) / 18 + i) * 4;
                if (sx === x0) { gameContext.moveTo(sx, wy); } else { gameContext.lineTo(sx, wy); }
            }
        } else {
            // Straight scrolling dash (a wind streak).
            gameContext.setLineDash([18, 10]);
            gameContext.lineDashOffset = -flow;
            gameContext.beginPath();
            gameContext.moveTo(x0, ly);
            gameContext.lineTo(x1, ly);
        }
        gameContext.strokeStyle = halo; gameContext.lineWidth = 6; gameContext.stroke();
        gameContext.strokeStyle = stroke; gameContext.lineWidth = 3; gameContext.stroke();
        gameContext.setLineDash([]);
        // arrowhead at the leading (+x) end
        gameContext.beginPath();
        gameContext.moveTo(w / 2 - 22, ly - 7);
        gameContext.lineTo(w / 2 - 10, ly);
        gameContext.lineTo(w / 2 - 22, ly + 7);
        gameContext.strokeStyle = halo; gameContext.lineWidth = 6; gameContext.stroke();
        gameContext.strokeStyle = stroke; gameContext.lineWidth = 3; gameContext.stroke();
    }
    gameContext.restore();
}

// Launch Pad — a CHEVRON KICKER ramp you drive over to be flung airborne along its facing.
// A trapezoid ramp rises from a low back edge to a tall, bright launch lip at the front (+x),
// shaded dark->light along the slope; three orange speed chevrons point up the ramp and pulse
// (brightening toward the lip) on a live bounce so it reads "launch THIS way". Orange palette
// (pale on water). Dark contrast halo under the art. Shared shape in drawKickerRamp so the
// live drawer + editor painter match. Cheap: one gradient + strokes, no shadowBlur/filter.
function drawKickerRamp(ctx, r, accent, light, mid, dark, bounce) {
    var hwBack = r * 0.5, hwFront = r * 0.82, frontX = r * 0.92;
    function rampPath() {
        ctx.beginPath();
        ctx.moveTo(-r, -hwBack);
        ctx.lineTo(frontX, -hwFront);
        ctx.lineTo(frontX, hwFront);
        ctx.lineTo(-r, hwBack);
        ctx.closePath();
    }
    rampPath();
    var g = ctx.createLinearGradient(-r, 0, r, 0);
    g.addColorStop(0, dark);
    g.addColorStop(0.6, mid);
    g.addColorStop(1, light);
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = BOON_HALO; ctx.lineWidth = 2.5; ctx.stroke();
    // Three speed chevrons up the ramp, brightening toward the lip with the bounce.
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    var cw1 = r * 0.2, cw2 = r * 0.15;
    for (var i = 0; i < 3; i++) {
        var cx = -r * 0.4 + i * r * 0.42;
        var ch = r * (0.34 + i * 0.08);
        ctx.globalAlpha = 0.45 + 0.55 * bounce * ((i + 1) / 3);
        ctx.beginPath();
        ctx.moveTo(cx - cw1, ch);
        ctx.lineTo(cx + cw2, 0);
        ctx.lineTo(cx - cw1, -ch);
        ctx.strokeStyle = accent; ctx.lineWidth = Math.max(3, r * 0.16); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // Bright raised launch lip at the front (+x) edge.
    var lift = bounce * r * 0.06;
    ctx.beginPath();
    ctx.moveTo(frontX, -hwFront - lift);
    ctx.lineTo(frontX, hwFront + lift);
    ctx.strokeStyle = BOON_HALO; ctx.lineWidth = 7; ctx.stroke();
    ctx.strokeStyle = light; ctx.lineWidth = 4; ctx.stroke();
}
function drawLaunchPad(x, y, angle) {
    var cfg = config.boons.launchPad;
    var r = cfg.radius;
    var rad = (angle || 0) * (Math.PI / 180);
    var onWater = boonOnWater(x, y);
    var accent = onWater ? cfg.colorWater : cfg.color;
    var light = onWater ? "#ffe9cf" : "#ffc890";
    var mid = onWater ? "#e0b483" : "#c0651f";
    var dark = onWater ? "#b58a5a" : "#7e3d14";
    var bounce = 0.5 + 0.5 * Math.sin(Date.now() / 230);
    gameContext.save();
    gameContext.translate(x, y);
    gameContext.rotate(rad);
    drawKickerRamp(gameContext, r, accent, light, mid, dark, bounce);
    gameContext.restore();
}

// Barrel Cannon — a chunky wooden launch cannon you drive into to be loaded, then fired
// along its facing. Top-down: a rounded barrel body shaded with a cross-axis gradient
// (lit top -> shadowed bottom) for a cylindrical read, lengthwise wood staves + a specular
// streak, riveted iron hoop bands, a recessed wooden breech at the back, and a flared iron
// muzzle ring with a warm pulsing bore at the firing (+x) end (which way it shoots). A soft
// grounding shadow sits underneath. Brown palette (pale on water). Cheap — one gradient +
// fills/strokes, no shadowBlur/filter. Shared shape: drawBarrelBody (reused by the editor).
function barrelTones(onWater, cfg) {
    return onWater
        ? { mid: cfg.colorWater, light: "#f3fbff", dark: "#9bc0d4", bore: "#bfe9ff" }
        : { mid: cfg.color, light: "#e8a866", dark: "#7c4a25", bore: "#ffc24a" };
}
// Draw the barrel into `ctx`, centred at the origin and already rotated to its facing.
// `glow` is the bore brightness 0..1 (animated live, fixed in the editor). Used by both the
// in-game drawer and the editor painter so they always match.
function drawBarrelBody(ctx, r, tones, glow) {
    var iron = "#3a2614", ironHi = "#7a5e44", ironDk = "#22160b";
    var bodyLen = r * 2.2, bodyW = r * 1.7;
    var hx = bodyLen / 2, hy = bodyW / 2;
    function capsule(ax, ay) {
        var rr = ay;
        ctx.beginPath();
        ctx.moveTo(-ax + rr, -ay);
        ctx.lineTo(ax - rr, -ay);
        ctx.arc(ax - rr, 0, rr, -Math.PI / 2, Math.PI / 2);
        ctx.lineTo(-ax + rr, ay);
        ctx.arc(-ax + rr, 0, rr, Math.PI / 2, -Math.PI / 2);
        ctx.closePath();
    }
    // Body with a cross-axis gradient (lit top -> shadowed bottom = a rounded cylinder).
    capsule(hx, hy);
    var grad = ctx.createLinearGradient(0, -hy, 0, hy);
    grad.addColorStop(0, tones.light);
    grad.addColorStop(0.42, tones.mid);
    grad.addColorStop(1, tones.dark);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = ironDk;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    // Two riveted iron hoop bands, clustered toward the centre (the icon look — no busy
    // staves/specular, and the back end stays clean rounded wood, not a second iron ring).
    var bands = [-bodyLen * 0.16, bodyLen * 0.0];
    for (var b = 0; b < bands.length; b++) {
        var bxh = bands[b];
        ctx.strokeStyle = ironDk; ctx.lineWidth = 5;
        ctx.beginPath(); ctx.moveTo(bxh, -hy + 1); ctx.lineTo(bxh, hy - 1); ctx.stroke();
        ctx.strokeStyle = ironHi; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(bxh - 1.4, -hy * 0.66); ctx.lineTo(bxh - 1.4, hy * 0.66); ctx.stroke();
        ctx.fillStyle = ironHi;
        for (var rv = -1; rv <= 1; rv += 2) {
            ctx.beginPath(); ctx.arc(bxh, rv * hy * 0.62, 1.6, 0, 2 * Math.PI); ctx.fill();
        }
    }
    // Iron muzzle ring at the firing (+x) end + a warm pulsing glowing bore (the only ring
    // — so it clearly reads as "this end fires", matching the icon).
    var mx = hx - hy * 0.28;
    ctx.beginPath();
    ctx.ellipse(mx, 0, hy * 0.34, hy * 0.98, 0, 0, 2 * Math.PI);
    ctx.fillStyle = iron; ctx.fill();
    ctx.strokeStyle = ironHi; ctx.lineWidth = 1.4; ctx.stroke();
    var g = (glow == null) ? 0.6 : glow;
    ctx.globalAlpha = g;
    ctx.beginPath();
    ctx.ellipse(mx, 0, hy * 0.16, hy * 0.55, 0, 0, 2 * Math.PI);
    ctx.fillStyle = tones.bore; ctx.fill();
    ctx.globalAlpha = g * 0.55;
    ctx.beginPath();
    ctx.ellipse(mx, 0, hy * 0.07, hy * 0.28, 0, 0, 2 * Math.PI);
    ctx.fillStyle = "#fff3c8"; ctx.fill();
    ctx.globalAlpha = 1;
}
function drawBarrelCannon(x, y, angle) {
    var cfg = config.boons.barrelCannon;
    var r = cfg.radius;
    var rad = (angle || 0) * (Math.PI / 180);
    var onWater = boonOnWater(x, y);
    var tones = barrelTones(onWater, cfg);
    gameContext.save();
    gameContext.translate(x, y);
    // Soft grounding shadow (world-space, so it stays put regardless of facing).
    gameContext.globalAlpha = 0.2;
    gameContext.fillStyle = "#000";
    gameContext.beginPath();
    gameContext.ellipse(0, r * 0.32, r * 1.2, r * 0.85, 0, 0, 2 * Math.PI);
    gameContext.fill();
    gameContext.globalAlpha = 1;
    gameContext.rotate(rad);
    var glow = 0.55 + 0.3 * (0.5 + 0.5 * Math.sin(Date.now() / 320));
    drawBarrelBody(gameContext, r, tones, glow);
    gameContext.restore();
}

// Slingshot Rings — a ring you drive THROUGH for a speed pulse along its axis, scaled by
// how centred your pass is. Drawn as a glowing torus seen edge-on (a tall ellipse facing
// the pass axis) with a brighter aimed sheen + small axis arrows so the throw direction
// reads. Violet palette (pale on water). Pulses; dark contrast halo under the ring. Cheap.
function drawSlingshotRings(x, y, angle) {
    var cfg = config.boons.slingshotRings;
    var r = cfg.radius;
    var rad = (angle || 0) * (Math.PI / 180);
    var onWater = boonOnWater(x, y);
    var accent = onWater ? cfg.colorWater : cfg.color;
    var pulse = 0.5 + 0.5 * Math.sin(Date.now() / 300);
    gameContext.save();
    gameContext.translate(x, y);
    gameContext.rotate(rad);
    // The ring is perpendicular to the pass axis, so edge-on it's a tall, thin ellipse
    // (narrow along the axis, full height across it).
    var rx = r * 0.42, ry = r * 0.95;
    gameContext.beginPath();
    gameContext.ellipse(0, 0, rx, ry, 0, 0, 2 * Math.PI);
    gameContext.strokeStyle = BOON_HALO; gameContext.lineWidth = 8; gameContext.stroke();
    gameContext.strokeStyle = accent; gameContext.lineWidth = 4 + 1.5 * pulse; gameContext.stroke();
    // Inner sheen ellipse (the "through here" hole).
    gameContext.globalAlpha = 0.35 + 0.3 * pulse;
    gameContext.beginPath();
    gameContext.ellipse(0, 0, rx * 0.5, ry * 0.66, 0, 0, 2 * Math.PI);
    gameContext.strokeStyle = accent; gameContext.lineWidth = 2; gameContext.stroke();
    gameContext.globalAlpha = 1;
    // Small axis arrows fore + aft so the pulse direction reads.
    gameContext.lineCap = "round";
    gameContext.lineJoin = "round";
    for (var s = -1; s <= 1; s += 2) {
        var ax = s * r * 1.05;
        gameContext.beginPath();
        gameContext.moveTo(ax - s * 7, -6);
        gameContext.lineTo(ax, 0);
        gameContext.lineTo(ax - s * 7, 6);
        gameContext.strokeStyle = BOON_HALO; gameContext.lineWidth = 6; gameContext.stroke();
        gameContext.strokeStyle = accent; gameContext.lineWidth = 3; gameContext.stroke();
    }
    gameContext.restore();
}

// Shared Zipline look — "Rope & Wooden Poles" cable with a "Parked Trolley" mount marker
// (the in-game drawer + the editor painter render identically). cap = the canvas 2d context.
// The rope is two twisted golden strands over a dark halo; a wooden pole stands at each end;
// the START end (x,y) carries a pulley trolley (wheel on the rope + a little hanging hook) as
// the mount marker — no big disc. Purely strokes/arcs (no shadowBlur/filter), so it's cheap.
var ZIP_ROPE_DARK = "#C79A33", ZIP_ROPE_DARK_W = "#E6CF95"; // 2nd twist strand (land / water)
var ZIP_WOOD = "#6b4a26", ZIP_WOOD_DARK = "#4a3119", ZIP_STEEL = "#2a2018", ZIP_STRAP = "#2a2e33";
function paintZiplineLook(cap, x, y, angle, length, accent, ropeDark) {
    var rad = (angle || 0) * (Math.PI / 180);
    var dirX = Math.cos(rad), dirY = Math.sin(rad);
    var ex = x + dirX * length, ey = y + dirY * length;
    var perpX = -dirY, perpY = dirX;
    cap.save();
    cap.lineCap = "round";
    // Rope cable: a slight droop, a dark halo, then two offset golden strands for the twist.
    var sag = Math.min(20, length * 0.07);
    var mx = (x + ex) / 2 + perpX * sag, my = (y + ey) / 2 + perpY * sag;
    cap.beginPath();
    cap.moveTo(x, y); cap.quadraticCurveTo(mx, my, ex, ey);
    cap.strokeStyle = BOON_HALO; cap.lineWidth = 9; cap.stroke();
    for (var o = -1; o <= 1; o += 2) {
        cap.beginPath();
        cap.moveTo(x + perpX * o * 2, y + perpY * o * 2);
        cap.quadraticCurveTo(mx + perpX * o * 2, my + perpY * o * 2, ex + perpX * o * 2, ey + perpY * o * 2);
        cap.strokeStyle = o < 0 ? accent : ropeDark; cap.lineWidth = 2.5; cap.stroke();
    }
    // Wooden poles: a stub across the cable at each end + a darker cap segment.
    for (var p = 0; p < 2; p++) {
        var px = p === 0 ? x : ex, py = p === 0 ? y : ey;
        cap.strokeStyle = ZIP_WOOD; cap.lineWidth = 8;
        cap.beginPath();
        cap.moveTo(px - perpX * 16, py - perpY * 16); cap.lineTo(px + perpX * 16, py + perpY * 16); cap.stroke();
        cap.strokeStyle = ZIP_WOOD_DARK; cap.lineWidth = 8;
        cap.beginPath();
        cap.moveTo(px + perpX * 16, py + perpY * 16); cap.lineTo(px + perpX * 22, py + perpY * 22); cap.stroke();
    }
    // Parked trolley at the START (the mount): a pulley wheel ON the rope + a hanging hook.
    cap.beginPath(); cap.arc(x, y, 6, 0, 2 * Math.PI); cap.fillStyle = ZIP_STEEL; cap.fill();
    cap.strokeStyle = "#e9eef2"; cap.lineWidth = 2; cap.stroke();
    cap.beginPath(); cap.arc(x, y, 2, 0, 2 * Math.PI); cap.fillStyle = accent; cap.fill();
    var hx = x + perpX * 12, hy = y + perpY * 12;
    cap.strokeStyle = ZIP_STRAP; cap.lineWidth = 3;
    cap.beginPath(); cap.moveTo(x, y); cap.lineTo(hx, hy); cap.stroke();
    cap.strokeStyle = accent; cap.lineWidth = 2.5;
    cap.beginPath(); cap.arc(hx, hy, 4, 0.5, 5.6); cap.stroke();
    cap.restore();
}

// Zipline (in-game) — "Rope & Wooden Poles" cable + "Parked Trolley" mount (see
// paintZiplineLook). x,y = the START post (rail origin); the cable runs along `angle` for the
// author-set `length` to the far post. On water it switches to the pale rope palette.
function drawZipline(x, y, angle, length) {
    var cfg = config.boons.zipline;
    var len = (typeof length === "number" && isFinite(length) && length > 0) ? length : cfg.minLength;
    var onWater = boonOnWater(x, y);
    var accent = onWater ? cfg.colorWater : cfg.color;
    var ropeDark = onWater ? ZIP_ROPE_DARK_W : ZIP_ROPE_DARK;
    paintZiplineLook(gameContext, x, y, angle, len, accent, ropeDark);
}

// Lily Pad — a drivable stepping-stone over water that SINKS while stood on. `state` is the
// server sink % (netState: 0 = floating .. 100 = fully sunk). As it sinks the leaf shrinks a
// touch and a water film creeps over it, so a pad about to drop you reads at a glance. Art is
// the "Cartoon Pop" style: saturated green, a thick dark outline, a rim-light crescent + gloss
// dot. ~30% of pads (deterministic from the baked random `angle`) also carry a little pink
// LOTUS bloom that fades as the pad goes under. Cheap (filled arcs + strokes, no filter).
var LILY_OUTLINE = "#16331d", LILY_RIMLIGHT = "#c8ffce", LILY_VEIN = "rgba(20,60,30,0.5)";
var LILY_PETAL = "#f6b0cb", LILY_CENTER = "#ffd24a";
// A near-full disc with a wedge notch cut toward the centre (the lily-leaf silhouette).
function lilyLeafPath(cap, r) {
    cap.beginPath();
    cap.arc(0, 0, r, 0.42, 2 * Math.PI - 0.42);
    cap.lineTo(0, 0);
    cap.closePath();
}
// ~30% of pads bloom — keyed off the baked random angle so it's stable per pad + identical on
// every client (angles ending 0,1,2 hit, spread evenly across all rotations).
function lilyHasFlower(angle) {
    return (Math.round(angle || 0) % 10 + 10) % 10 < 3;
}
// The lotus bloom (also used by the editor painter via paintLilyBloom — kept here as the single
// source for the in-game look). alpha lets it fade out as the pad sinks.
function drawLilyBloom(cap, r, alpha) {
    if (alpha <= 0) { return; }
    cap.save();
    cap.globalAlpha = alpha;
    var pr = r * 0.42;
    cap.fillStyle = LILY_PETAL;
    for (var p = 0; p < 6; p++) {
        cap.save(); cap.rotate(p / 6 * Math.PI * 2);
        cap.beginPath(); cap.ellipse(0, -pr * 0.55, pr * 0.34, pr * 0.62, 0, 0, 2 * Math.PI); cap.fill();
        cap.restore();
    }
    cap.fillStyle = LILY_CENTER; cap.beginPath(); cap.arc(0, 0, pr * 0.34, 0, 2 * Math.PI); cap.fill();
    cap.restore();
}
function drawLilyPad(x, y, state, radius, angle) {
    var cfg = config.boons.lilyPad;
    var sink = Math.max(0, Math.min(100, state == null ? 0 : state)) / 100;
    var baseR = (typeof radius === "number" && isFinite(radius) && radius > 0) ? radius : cfg.radius;
    var r = baseR * (1 - 0.16 * sink); // settles a little as it goes under
    gameContext.save();
    gameContext.translate(x, y);
    // Soft contact shadow on the water (drawn unrotated — it's symmetric).
    gameContext.beginPath();
    gameContext.arc(0, 0, r + 2, 0, 2 * Math.PI);
    gameContext.fillStyle = "rgba(8,35,26,0.20)";
    gameContext.fill();
    gameContext.rotate((angle || 0) * (Math.PI / 180)); // baked per-pad random rotation
    // Saturated leaf.
    lilyLeafPath(gameContext, r);
    gameContext.fillStyle = cfg.color;
    gameContext.fill();
    // Rim-light crescent (upper-left), under the outline.
    gameContext.save();
    gameContext.globalAlpha = 0.5; gameContext.strokeStyle = LILY_RIMLIGHT; gameContext.lineWidth = 3;
    gameContext.beginPath(); gameContext.arc(0, 0, r * 0.86, Math.PI * 1.05, Math.PI * 1.7); gameContext.stroke();
    gameContext.restore();
    // Thick dark cartoon outline.
    lilyLeafPath(gameContext, r);
    gameContext.strokeStyle = LILY_OUTLINE; gameContext.lineWidth = 4; gameContext.stroke();
    // Gloss dot + a single bold vein.
    gameContext.fillStyle = "rgba(255,255,255,0.7)";
    gameContext.beginPath(); gameContext.arc(-r * 0.32, -r * 0.34, r * 0.16, 0, 2 * Math.PI); gameContext.fill();
    gameContext.strokeStyle = LILY_VEIN; gameContext.lineWidth = 2;
    gameContext.beginPath(); gameContext.moveTo(0, 0); gameContext.lineTo(r * 0.8, r * 0.1); gameContext.stroke();
    // Lotus bloom on ~30% of pads, fading as the pad submerges.
    if (lilyHasFlower(angle)) { drawLilyBloom(gameContext, r, Math.max(0, 1 - sink)); }
    // Water film creeping over it as it sinks.
    if (sink > 0.5) {
        gameContext.globalAlpha = 0.55 * ((sink - 0.5) * 2);
        gameContext.beginPath(); gameContext.arc(0, 0, r, 0, 2 * Math.PI);
        gameContext.fillStyle = config.tileMap.water != null ? config.tileMap.water.color : "#2f6fb0";
        gameContext.fill();
        gameContext.globalAlpha = 1;
    }
    gameContext.restore();
}

// Guard Halo — a floating shield ring you drive over for a one-hit shield. It carries
// the same global-charge telegraph as the Recharge Spring (server netState arriving as
// `state`: 0 = just claimed .. 100 = ready). Ready: a gently pulsing gold ring with a
// bright shield crest in the middle — available. Recharging (state < 100): the pulse
// stops, a fill arc sweeps clockwise to the refill percent, and the crest dims. On
// water the palette is pale-gold so it reads against blue. Cheap sin/phase math, no
// shadowBlur/filter.
function drawGuardHalo(x, y, state) {
    var cfg = config.boons.guardHalo;
    var r = cfg.radius;
    var onWater = boonOnWater(x, y);
    var ready = (state == null || state >= 100);
    var accent = onWater ? cfg.colorWater : cfg.color;
    gameContext.save();
    gameContext.translate(x, y);
    // Faint footprint.
    gameContext.beginPath();
    gameContext.arc(0, 0, r, 0, 2 * Math.PI);
    gameContext.fillStyle = onWater ? "rgba(255,243,196,0.05)" : "rgba(255,209,102,0.05)";
    gameContext.fill();
    if (!ready) {
        // Refilling: dim track + a bright arc filling clockwise from the top to `state`%.
        var frac = Math.max(0, Math.min(1, state / 100));
        gameContext.beginPath();
        gameContext.arc(0, 0, r * 0.78, 0, 2 * Math.PI);
        gameContext.strokeStyle = accent;
        gameContext.globalAlpha = 0.18;
        gameContext.lineWidth = 3;
        gameContext.stroke();
        gameContext.beginPath();
        gameContext.arc(0, 0, r * 0.78, -Math.PI / 2, -Math.PI / 2 + frac * 2 * Math.PI);
        gameContext.globalAlpha = 0.9;
        gameContext.lineCap = "round";
        gameContext.strokeStyle = BOON_HALO; gameContext.lineWidth = 5; gameContext.stroke();
        gameContext.strokeStyle = accent; gameContext.lineWidth = 3; gameContext.stroke();
        gameContext.globalAlpha = 1;
    } else {
        var pulse = 0.5 + 0.5 * Math.sin(Date.now() / 340);
        gameContext.beginPath();
        gameContext.arc(0, 0, r * (0.6 + 0.3 * pulse), 0, 2 * Math.PI);
        gameContext.strokeStyle = accent;
        gameContext.globalAlpha = 0.35 + 0.45 * (1 - pulse);
        gameContext.lineWidth = 3;
        gameContext.stroke();
        gameContext.globalAlpha = 1;
    }
    // Shield crest in the middle (the identity), over a dark contrast halo so it reads
    // on any terrain — dimmed while re-arming so the spent state reads at a glance.
    var s = r * 0.5;
    gameContext.globalAlpha = ready ? 1 : 0.3;
    gameContext.lineCap = "round";
    gameContext.lineJoin = "round";
    gameContext.beginPath();
    gameContext.moveTo(0, -s);
    gameContext.lineTo(s * 0.8, -s * 0.45);
    gameContext.lineTo(s * 0.8, s * 0.2);
    gameContext.lineTo(0, s);
    gameContext.lineTo(-s * 0.8, s * 0.2);
    gameContext.lineTo(-s * 0.8, -s * 0.45);
    gameContext.closePath();
    gameContext.strokeStyle = BOON_HALO; gameContext.lineWidth = 7; gameContext.stroke();
    gameContext.strokeStyle = cfg.color; gameContext.lineWidth = 4; gameContext.stroke();
    gameContext.globalAlpha = 1;
    gameContext.restore();
}

// Second Wind Totem — a respawn FLAG (Mario-Odyssey-checkpoint style). Drawn as a thin
// pole with a triangular pennant near the top, on a small base. The cloth is a NEUTRAL
// colour by default and recolours to YOUR kart colour (client-only) the moment a local
// kart touches it, so it reads as "you activated this". Any kart driving over it bumps
// the pennant, which springs back on a little rubber-band (a critically-ish-damped
// spring on the pennant's lean). Once the collapse consumes the flag (wire netState 0)
// it's drawn as a charred stub. All anim state lives on the hazard object (h._fb), so
// it's per-instance and survives across frames; the static recap/preview path calls
// drawFlagShape directly. Cheap: a couple of strokes/fills + scalar spring, no filter.
function drawFlagShape(x, y, clothColor, bend, consumed) {
    var poleTopY = -30;
    gameContext.save();
    gameContext.translate(x, y);
    // Shadowy base mound.
    gameContext.beginPath();
    gameContext.ellipse(0, 4, 9, 4, 0, 0, 2 * Math.PI);
    gameContext.fillStyle = "rgba(18,28,42,0.30)";
    gameContext.fill();
    gameContext.lineCap = "round";
    gameContext.lineJoin = "round";
    if (consumed) {
        // Charred stub — the lava ate the flag.
        gameContext.strokeStyle = "rgba(45,32,30,0.75)";
        gameContext.lineWidth = 3;
        gameContext.beginPath();
        gameContext.moveTo(0, 4);
        gameContext.lineTo(0, -11);
        gameContext.stroke();
        gameContext.restore();
        return;
    }
    // Pole.
    gameContext.strokeStyle = "rgba(28,34,46,0.92)";
    gameContext.lineWidth = 3;
    gameContext.beginPath();
    gameContext.moveTo(0, 4);
    gameContext.lineTo(0, poleTopY);
    gameContext.stroke();
    // Triangular pennant from the top, free end bent by `bend` (the rubber-band lean).
    var len = 22, hgt = 13;
    var tipX = len + bend, tipY = poleTopY + hgt * 0.5;
    gameContext.beginPath();
    gameContext.moveTo(0, poleTopY);
    gameContext.quadraticCurveTo(len * 0.5 + bend * 0.6, poleTopY - 2, tipX, tipY);
    gameContext.lineTo(0, poleTopY + hgt);
    gameContext.closePath();
    gameContext.fillStyle = clothColor;
    gameContext.fill();
    gameContext.strokeStyle = BOON_HALO;
    gameContext.lineWidth = 1.5;
    gameContext.stroke();
    gameContext.restore();
}
function secondWindClothColor(onWater) {
    var cfg = config.boons.secondWindTotem;
    return onWater ? cfg.colorWater : cfg.color;
}
function drawSecondWindTotem(h) {
    if (h == null || h.x == null) { return; }
    var consumed = (h.state === 0); // wire netState mirror: 0 = lava-consumed
    if (consumed) { h._claimColor = null; drawFlagShape(h.x, h.y, "#000", 0, true); return; }
    var onWater = boonOnWater(h.x, h.y);
    if (h._fb == null) { h._fb = { bend: 0, vel: 0, t: 0, overlap: {} }; }
    var fb = h._fb;
    var now = Date.now();
    var dt = fb.t ? Math.min(0.05, (now - fb.t) / 1000) : 0;
    fb.t = now;
    // Proximity: any kart entering the flag bumps the pennant; a LOCAL kart re-anchors
    // here (secondWindClaimByPlayer[id] = this flag), which is what tints the cloth below.
    // Same reach as the server hitbox (radius + a kart radius) so it fires on visible
    // contact. The claim is per-flag-INSTANCE (h.ownerId), so driving to a new flag
    // automatically drops the colour from the old one (it no longer matches any claim).
    if (typeof playerList !== "undefined" && playerList != null) {
        var reach = config.boons.secondWindTotem.radius + (config.playerBaseRadius || 7.5);
        for (var pid in playerList) {
            var p = playerList[pid];
            if (p == null || p.x == null) { continue; }
            var dx = p.x - h.x, dy = p.y - h.y;
            var over = (dx * dx + dy * dy) <= reach * reach;
            if (over && fb.overlap[pid] !== true) {
                var vx = p.velX || 0;
                var spd = Math.min(1, Math.abs(vx) / 250);
                fb.vel += (vx >= 0 ? 1 : -1) * (120 + spd * 120); // kick the pennant
            }
            if (over && typeof isLocalId === "function" && isLocalId(pid) && p.color != null
                && typeof secondWindClaimByPlayer !== "undefined") {
                secondWindClaimByPlayer[pid] = h.ownerId;
            }
            fb.overlap[pid] = over;
        }
    }
    // Cloth colour: a LOCAL player whose active anchor is THIS flag → their colour;
    // otherwise neutral. (Only your active flag wears your colour — re-anchoring repaints
    // the old one neutral.) Cached on the hazard for the recap snapshot.
    var claimColor = null;
    if (typeof secondWindClaimByPlayer !== "undefined") {
        for (var lpid in secondWindClaimByPlayer) {
            if (secondWindClaimByPlayer[lpid] === h.ownerId
                && playerList[lpid] != null && playerList[lpid].color != null) {
                claimColor = playerList[lpid].color; // co-op: last local match wins
            }
        }
    }
    h._claimColor = claimColor;
    // Rubber-band: a lightly-damped spring eases the lean back to rest (with overshoot).
    fb.vel += (-320 * fb.bend - 14 * fb.vel) * dt;
    fb.bend += fb.vel * dt;
    if (Math.abs(fb.bend) < 0.04 && Math.abs(fb.vel) < 0.04) { fb.bend = 0; fb.vel = 0; }
    var wave = Math.sin(now / 420) * 1.4; // idle flutter
    var cloth = claimColor != null ? claimColor : secondWindClothColor(onWater);
    drawFlagShape(h.x, h.y, cloth, fb.bend + wave, false);
}
