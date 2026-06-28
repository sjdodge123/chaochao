// draw_hud.js — HUD / combat-log / overview boards, extracted verbatim from
// draw.js (phase 4 of docs/spikes/client-refactor.md). Pure file split: no
// logic, naming, or order changes. Loaded after draw.js in the play bundle;
// all references are runtime calls (resolved before the first render frame).
// Contents: locateColor/voronoi geometry helpers, drawHUD, team-score HUD,
// brutal badges, combat log, world-record/spectator banners, race timer,
// touch controls, title screen, overview boards + standings + overview kart
// render, record floats, camera recenter helpers.

function locateColor(id) {
    if (id == null) {
        return "purple";
    }
    if (id > 99) {
        return config.tileMap.ability.color;
    }
    for (var type in config.tileMap) {
        if (id == config.tileMap[type].id) {
            return config.tileMap[type].color;
        }
    }
}
function locateSymbol(id) {
    for (var type in config.tileMap.abilities) {
        if (id == config.tileMap.abilities[type].id) {
            return config.tileMap.abilities[type].symbol;
        }
    }
}

function getStartpoint(halfedge) {
    if (compareSite(halfedge.edge.lSite, halfedge.site)) {
        return halfedge.edge.va;
    }
    return halfedge.edge.vb;
}
function getEndpoint(halfedge) {
    if (compareSite(halfedge.edge.lSite, halfedge.site)) {
        return halfedge.edge.vb;
    }
    return halfedge.edge.va;
}

function compareSite(siteA, siteB) {
    if (siteA.voronoiId != siteB.voronoiId) {
        return false;
    }
    if (siteA.x != siteB.x) {
        return false;
    }
    if (siteA.y != siteB.y) {
        return false;
    }
    return true;
}

// --- HUD overlap probe (opt-in: ?hudprobe=1) -----------------------------------
// Publishes the current frame's top-edge HUD element rects (in LOGICAL canvas
// coords) to window.__hudRects so the headless CI guard (mobile-layout-test.js)
// can assert no two collide — the exact class of bug where a newly-added lobby
// banner overlapped the settings gear. Zero cost unless the flag is set.
var hudProbeOn = (typeof location !== "undefined" && !!location.search &&
    /[?&]hudprobe=1\b/.test(location.search));
function hudProbeReset() {
    if (hudProbeOn && typeof window !== "undefined") {
        window.__hudRects = [];
    }
}
function hudProbeRect(name, x, y, w, h) {
    if (!hudProbeOn || typeof window === "undefined" || !window.__hudRects) {
        return;
    }
    // Idempotent per name within a frame: if an element re-draws, keep the latest
    // rect rather than appending a duplicate (a same-name pair would self-overlap
    // and false-fail the guard).
    var rects = window.__hudRects;
    for (var i = 0; i < rects.length; i++) {
        if (rects[i].name === name) { rects[i] = { name: name, x: x, y: y, w: w, h: h }; return; }
    }
    rects.push({ name: name, x: x, y: y, w: w, h: h });
}

function drawHUD() {
    drawGameInfo();
    drawRaceTimer();
    drawTeamScoreHud();
    drawBrutalBadges();
    drawCombatLog();
    drawSkillProgressHud();
    drawSpectatorLeaderboard();
    drawWorldRecordBanner();
    drawHeatwaveWarnBanner();
    drawMaintenanceBanner();
    drawVirtualButtons();
    drawTouchControls();
    drawTitle();
    drawMapAnnouncement();
}

// Second-wave HUD warning (top-center, world-record-banner styling): armed by
// the heatwavePending handler alongside the warning chirps and lasting the whole
// telegraph window, so the audio cue always has a visual twin — the tile flicker
// alone is easy to miss at racing speed. Cleared on newMap; self-expires.
var heatwaveWarnBanner = null;
function drawHeatwaveWarnBanner() {
    if (heatwaveWarnBanner == null) { return; }
    var dur = heatwaveWarnBanner.duration || 3000;
    var t = (Date.now() - heatwaveWarnBanner.startedAt) / dur;
    if (t >= 1) { heatwaveWarnBanner = null; return; }
    // Slide-down + fade-in, hold, slide-up + fade-out (worldRecordBanner timing),
    // with an urgent pulse riding the hold.
    var alpha, slide;
    if (t < 0.12) { var k = t / 0.12; alpha = k; slide = -40 * (1 - k); }
    else if (t > 0.78) { var k2 = (t - 0.78) / 0.22; alpha = 1 - k2; slide = -40 * k2; }
    else { alpha = 1; slide = 0; }
    alpha *= 0.75 + 0.25 * Math.sin(Date.now() / 140);
    var cx = LOGICAL_WIDTH / 2;
    var by = 70 + slide;
    gameContext.save();
    gameContext.globalAlpha = Math.max(0, Math.min(1, alpha));
    gameContext.textAlign = "center";
    gameContext.textBaseline = "alphabetic";
    gameContext.font = "bold 22px Arial";
    gameContext.lineWidth = 3;
    gameContext.strokeStyle = "rgba(0,0,0,0.85)";
    gameContext.strokeText("Heatwave incoming!", cx, by);
    gameContext.fillStyle = "#ff7a26";
    gameContext.fillText("Heatwave incoming!", cx, by);
    gameContext.font = "15px Arial";
    gameContext.strokeText("Flickering ground is about to burn over", cx, by + 19);
    gameContext.fillStyle = "white";
    gameContext.fillText("Flickering ground is about to burn over", cx, by + 19);
    gameContext.restore();
}

// Teams modes: the shared Crimson-vs-Jade score, centre-top through the race so
// both sides always know it. One pill, each side's name+score in its team colour.
// Racing/collapsing ONLY: in the overview the team panels carry the score (and
// the pill's overview slot sat on top of the GAME/PLAYERS/ROUND readout — browser-
// verified overlap), and the lobby/gate slot belongs to the mode-intro banners.
function drawTeamScoreHud() {
    if (typeof teamInfo === "undefined" || teamInfo == null || teamInfo.score == null) { return; }
    if (currentState != config.stateMap.racing && currentState != config.stateMap.collapsing) { return; }
    var defs = (Array.isArray(teamInfo.defs) && teamInfo.defs.length >= 2) ? teamInfo.defs : null;
    if (defs == null) { return; }
    var a = defs[0], b = defs[1];
    var sa = teamInfo.score[a.id] || 0, sb = teamInfo.score[b.id] || 0;
    gameContext.save();
    gameContext.font = "bold 16px sans-serif";
    var segA = a.name + " " + sa;
    var segMid = (teamInfo.target != null) ? ("  /" + teamInfo.target + "  ") : "  –  ";
    var segB = sb + " " + b.name;
    var wA = gameContext.measureText(segA).width;
    var wM = gameContext.measureText(segMid).width;
    var wB = gameContext.measureText(segB).width;
    var w = wA + wM + wB + 28;
    var h = 30;
    var x = (LOGICAL_WIDTH - w) / 2;
    // Below the session readout (GAME/PLAYERS/ROUND ends ~y30) — and below the
    // deploy/maintenance panel (y44..94) when one is up, mirroring the lobby
    // banner stack's shift, so a restart countdown never hides the team score.
    var y = (typeof serverMaintenance !== "undefined" && serverMaintenance != null) ? 102 : 38;
    drawHudPanel(x, y, w, h, { fill: "rgba(10,12,16,0.78)", alpha: 0.92, border: "rgba(255,255,255,0.35)" });
    gameContext.textBaseline = "middle";
    gameContext.textAlign = "left";
    var tx = x + 14, ty = y + h / 2 + 1;
    gameContext.fillStyle = a.color; gameContext.fillText(segA, tx, ty); tx += wA;
    gameContext.fillStyle = "#cfd6dd"; gameContext.fillText(segMid, tx, ty); tx += wM;
    gameContext.fillStyle = b.color; gameContext.fillText(segB, tx, ty);
    gameContext.restore();
}

// Deploy heads-up banner (top-center, every state — drawHUD runs in both the
// main loop and the overview pass). A 'restart' shows a live countdown to the
// server-sent deadline ("back in a moment" — client.js auto-reloads after the
// drop); a 'drain' shows a static "new races paused" notice until the restart
// that always follows it takes over. Self-expires past expiresAt so a
// canceled deploy clears the banner without a server round-trip.
function drawMaintenanceBanner() {
    if (serverMaintenance == null) { return; }
    var now = Date.now();
    if (serverMaintenance.expiresAt != null && now > serverMaintenance.expiresAt) {
        serverMaintenance = null;
        return;
    }
    var line1, line2;
    if (serverMaintenance.reason === "restart") {
        var secsLeft = Math.max(0, Math.ceil((serverMaintenance.deadline - now) / 1000));
        line1 = secsLeft > 0 ? ("Server restarting in " + secsLeft + "s") : "Server restarting…";
        line2 = "Game update — you'll be back in the action in a moment";
    } else {
        line1 = "Server update coming up";
        line2 = "New races are paused — a quick restart follows shortly";
    }
    var cx = LOGICAL_WIDTH / 2;
    var by = 66; // headline baseline — panel sits below the session info bar
    // Urgency pulse on the headline once a restart countdown is live, same
    // accelerating-sine trick as the gate line.
    var alpha = 1;
    if (serverMaintenance.reason === "restart") {
        alpha = 0.75 + 0.25 * Math.sin(now / 180);
    }
    gameContext.save();
    gameContext.textAlign = "center";
    gameContext.textBaseline = "alphabetic";
    // Dark alert panel behind both lines so the warning reads over any terrain
    // (and over the HUD chrome) without per-glyph stroking.
    gameContext.font = "bold 20px Arial";
    var mw1 = gameContext.measureText(line1).width;
    gameContext.font = "14px Arial";
    var mw2 = gameContext.measureText(line2).width;
    var mW = Math.max(mw1, mw2) + 36;
    drawHudPanel(cx - mW / 2, by - 22, mW, 50, {
        fill: "rgba(12, 14, 18, 0.78)", alpha: 1,
        border: "rgba(255, 179, 71, 0.65)", borderWidth: 1.5
    });
    gameContext.font = "bold 20px Arial";
    gameContext.globalAlpha = alpha;
    gameContext.fillStyle = "#ffb347";
    gameContext.fillText(line1, cx, by);
    gameContext.globalAlpha = 1;
    gameContext.font = "14px Arial";
    gameContext.fillStyle = "white";
    gameContext.fillText(line2, cx, by + 19);
    gameContext.restore();
}

// Persistent top-right badge (just under the race timer) showing one icon per active
// brutal-round mode for the whole round — so a player who looked away, or who joined
// after the announcement card faded, can always tell which modes are live. Reuses the
// recap badge style (light tile + dark silhouette) so the icons read over any terrain.
function drawBrutalBadges() {
    if (brutalRound != true || brutalRoundConfig == null || brutalRoundConfig.brutalTypes == null) { return; }
    if (currentState != config.stateMap.racing && currentState != config.stateMap.collapsing) { return; }
    if (typeof brutalRoundImages === "undefined" || brutalRoundImages == null) { return; }
    var icons = [];
    for (var i = 0; i < brutalRoundConfig.brutalTypes.length; i++) {
        var img = brutalRoundImages[brutalRoundConfig.brutalTypes[i]];
        if (img != null) { icons.push(img); }
    }
    if (icons.length === 0) { return; }
    var bw = 30, bh = 28, gap = 5, topY = 56;
    var totalW = icons.length * bw + (icons.length - 1) * gap;
    var startX = LOGICAL_WIDTH - 20 - totalW; // right-aligned under the timer
    gameContext.save();
    for (var k = 0; k < icons.length; k++) {
        var bx = startX + k * (bw + gap);
        // Rounded tile, matching the shared HUD-panel chrome (light bg kept so
        // the dark icon silhouettes stay readable in both themes).
        gameContext.fillStyle = "rgba(255,255,255,0.88)";
        roundRectPath(gameContext, bx, topY, bw, bh, 6);
        gameContext.fill();
        gameContext.strokeStyle = "rgba(0,0,0,0.45)";
        gameContext.lineWidth = 1.5;
        gameContext.stroke();
        var ic = icons[k];
        if (ic.complete !== false && (ic.naturalWidth == null || ic.naturalWidth > 0)) {
            try {
                var ratio = (ic.width && ic.height) ? (ic.height / ic.width) : 0.88;
                var iw = bw - 8;
                var ih = iw * ratio;
                if (ih > bh - 6) { ih = bh - 6; iw = ih / ratio; }
                gameContext.drawImage(ic, bx + (bw - iw) / 2, topY + (bh - ih) / 2, iw, ih);
            } catch (e) { /* icon not decoded — badge tile still flags it */ }
        }
    }
    gameContext.restore();
}

// ---------------------------------------------------------------------------
// Combat log — a small right-edge feed of recent moments (kills, environmental
// deaths, ability pickups, scoring finishes). Each row carries the cart cosmetic
// thumbnail(s) + player name(s); in teams modes the name uses the team colour and
// the thumbnail gets a team-coloured ring (the "team cosmetic"). Entries are
// pushed by the matching socket handlers in client.js and self-expire here.
// Sits below the race timer + brutal badges, screen-space (drawn inside drawHUD).
var combatLog = []; // newest first
var COMBAT_LOG_MAX = 6;
var COMBAT_LOG_LIFE_MS = { kill: 6500, death: 6500, ability: 4500, score: 7500, orb: 6500, keyPickup: 5000, keyDrop: 5000, doorUnlock: 7000, warp: 4500 };
var _combatAbilityLabels = null;
var _combatAbilityIcons = null;

function combatLogReset() { combatLog.length = 0; }

// Resolve a player's display name at event time (cached on the entry so a player
// who later leaves the room still reads correctly in the feed).
function combatNameOf(id) {
    var p = (typeof playerList !== "undefined" && playerList) ? playerList[id] : null;
    return (p != null && typeof Colors !== "undefined") ? Colors.nameFor(p) : "Someone";
}

// Live colour for a name/ring: team colour in teams modes, else the kart colour.
function combatColorOf(id, fallback) {
    var p = (typeof playerList !== "undefined" && playerList) ? playerList[id] : null;
    if (p != null && p.teamId != null && typeof teamInfo !== "undefined" && teamInfo != null && Array.isArray(teamInfo.defs)) {
        for (var i = 0; i < teamInfo.defs.length; i++) {
            if (teamInfo.defs[i] != null && teamInfo.defs[i].id === p.teamId) { return teamInfo.defs[i].color; }
        }
    }
    if (p != null && p.color) { return p.color; }
    return fallback || "#dfe6ee";
}

function abilityLabelFor(id) {
    if (_combatAbilityLabels == null && typeof config !== "undefined" && config != null &&
        config.tileMap != null && config.tileMap.abilities != null) {
        var ab = config.tileMap.abilities, m = {};
        function put(entry, label) { if (entry != null && entry.id != null) { m[entry.id] = label; } }
        put(ab.blindfold, "Blindfold"); put(ab.swap, "Swap"); put(ab.bomb, "Bomb");
        put(ab.bombTrigger, "Bomb"); put(ab.speedBuff, "Speed Burst"); put(ab.speedDebuff, "Slowdown");
        put(ab.tileSwap, "Tile Swap"); put(ab.iceCannon, "Ice Cannon"); put(ab.cut, "Cut");
        put(ab.starPower, "Star Power"); put(ab.orbitalBeam, "Orbital Beam");
        _combatAbilityLabels = m;
    }
    return (_combatAbilityLabels != null && _combatAbilityLabels[id]) ? _combatAbilityLabels[id] : "Ability";
}

// Ability id → icon Image (reusing the HUD ability sprites). Used in place of the
// ability name in the combat log; falls back to the name text if the icon for an
// ability is missing or not yet decoded.
function abilityIconFor(id) {
    if (_combatAbilityIcons == null && typeof config !== "undefined" && config != null &&
        config.tileMap != null && config.tileMap.abilities != null) {
        var ab = config.tileMap.abilities, m = {};
        function put(entry, img) { if (entry != null && entry.id != null && img != null) { m[entry.id] = img; } }
        put(ab.blindfold, typeof blindfoldIcon !== "undefined" ? blindfoldIcon : null);
        put(ab.swap, typeof transferIcon !== "undefined" ? transferIcon : null);
        put(ab.bomb, typeof bombIcon !== "undefined" ? bombIcon : null);
        put(ab.bombTrigger, typeof bombIcon !== "undefined" ? bombIcon : null);
        put(ab.speedBuff, typeof windIcon !== "undefined" ? windIcon : null);
        put(ab.speedDebuff, typeof hourglassIcon !== "undefined" ? hourglassIcon : null);
        put(ab.tileSwap, typeof copyIcon !== "undefined" ? copyIcon : null);
        put(ab.iceCannon, typeof snowFlakeIcon !== "undefined" ? snowFlakeIcon : null);
        put(ab.cut, typeof cutIcon !== "undefined" ? cutIcon : null);
        put(ab.starPower, typeof starIcon !== "undefined" ? starIcon : null);
        put(ab.orbitalBeam, typeof orbitalBeamIcon !== "undefined" ? orbitalBeamIcon : null);
        _combatAbilityIcons = m;
    }
    return (_combatAbilityIcons != null && _combatAbilityIcons[id]) ? _combatAbilityIcons[id] : null;
}

// A white circular token carrying a dark ability glyph (the ability SVGs are dark
// silhouettes, so they need a light backing to read — same trick as drawBrutalBadges).
function drawAbilityIconToken(img, cx, cy, r) {
    gameContext.beginPath();
    gameContext.arc(cx, cy, r, 0, Math.PI * 2);
    gameContext.fillStyle = "rgba(255,255,255,0.92)";
    gameContext.fill();
    gameContext.lineWidth = 1.2;
    gameContext.strokeStyle = "rgba(0,0,0,0.35)";
    gameContext.stroke();
    if (img != null && img.complete !== false && (img.naturalWidth == null || img.naturalWidth > 0)) {
        try {
            var ratio = (img.width && img.height) ? (img.height / img.width) : 0.88;
            var iw = r * 1.5, ih = iw * ratio;
            if (ih > r * 1.6) { ih = r * 1.6; iw = ih / ratio; }
            gameContext.drawImage(img, cx - iw / 2, cy - ih / 2, iw, ih);
        } catch (e) { /* not decoded yet — the token still marks the pickup */ }
    }
}

function pushCombatEntry(entry) {
    entry.bornAt = Date.now();
    combatLog.unshift(entry);
    if (combatLog.length > COMBAT_LOG_MAX) { combatLog.length = COMBAT_LOG_MAX; }
}

// playerDied → either a kill (a real attacker) or an environmental/self death.
function combatLogDeath(victimId, attackerId, cause) {
    if (victimId == null) { return; }
    if (attackerId != null && attackerId !== victimId) {
        pushCombatEntry({
            type: "kill", attackerId: attackerId, victimId: victimId,
            attackerName: combatNameOf(attackerId), victimName: combatNameOf(victimId)
        });
    } else {
        pushCombatEntry({ type: "death", victimId: victimId, victimName: combatNameOf(victimId), cause: cause || null });
    }
}

function combatLogAbility(ownerId, abilityId) {
    if (ownerId == null) { return; }
    pushCombatEntry({ type: "ability", ownerId: ownerId, ownerName: combatNameOf(ownerId), abilityId: abilityId });
}

// Teams modes: a racer drove over a bonus orb and banked points for their team.
function combatLogOrb(ownerId, points) {
    if (ownerId == null) { return; }
    pushCombatEntry({ type: "orb", ownerId: ownerId, ownerName: combatNameOf(ownerId), points: (points != null) ? points : 1 });
}

// Locked-door key picked up / dropped / used to unlock a door. The shape token reads
// true to the in-world key/door so the feed says which objective just moved.
function combatLogKeyPickup(ownerId, shape) {
    if (ownerId == null) { return; }
    pushCombatEntry({ type: "keyPickup", ownerId: ownerId, ownerName: combatNameOf(ownerId), shape: shape });
}
function combatLogKeyDrop(ownerId, shape) {
    if (ownerId == null) { return; }
    pushCombatEntry({ type: "keyDrop", ownerId: ownerId, ownerName: combatNameOf(ownerId), shape: shape });
}
function combatLogDoorUnlock(ownerId, shape) {
    pushCombatEntry({ type: "doorUnlock", ownerId: ownerId, ownerName: (ownerId != null) ? combatNameOf(ownerId) : "", shape: shape });
}
// A racer used a Warp Pad (boon): logged on the warpStart edge so the feed shows the warp
// even though the kart vanishes for the transit.
function combatLogWarp(playerId) {
    if (playerId == null) { return; }
    pushCombatEntry({ type: "warp", playerId: playerId, playerName: combatNameOf(playerId) });
}

// Scoring finishes. firstPlaceWinner / secondPlaceWinner / playerConcluded all
// fire for a podium finisher, and teams modes add a teamPointsDelta — so this
// upgrades an existing recent row (better rank / +points) instead of stacking
// duplicates for the same player.
var _combatRankRank = { "Finished": 1, "2nd": 2, "1st": 3 };
function combatLogScore(playerId, rankLabel, points) {
    if (playerId == null) { return; }
    for (var i = 0; i < combatLog.length; i++) {
        var e = combatLog[i];
        if (e.type === "score" && e.playerId === playerId) {
            if (rankLabel != null && (_combatRankRank[rankLabel] || 0) > (_combatRankRank[e.rankLabel] || 0)) {
                e.rankLabel = rankLabel;
            }
            if (points != null) { e.points = points; }
            e.bornAt = Date.now();
            return;
        }
    }
    pushCombatEntry({
        type: "score", playerId: playerId,
        playerName: combatNameOf(playerId),
        rankLabel: rankLabel || "Finished",
        points: (points != null) ? points : null
    });
}

// Action markers reuse the game's established emoji iconography (the same glyphs
// the standings board stamps over karts and the gameOver medals card uses):
// 💥 a kill, 💀 a death, 🥇/🥈 first/second place, 🏁 any other finish. Ability
// pickups lead with the ability's own sprite token (drawAbilityIconToken).
function combatScoreEmoji(rankLabel) {
    if (rankLabel === "1st") { return "🥇"; }
    if (rankLabel === "2nd") { return "🥈"; }
    return "🏁";
}

// Bonus-orb marker — the same gold sphere the player sees on the map (radial
// sheen + config orb colour), shrunk to a row token so the feed reads true to
// the in-game pickup.
function drawCombatOrbToken(cx, cy, r) {
    var color = (typeof config !== "undefined" && config && config.bonusOrb && config.bonusOrb.color) ? config.bonusOrb.color : "#FFD54A";
    var grad = gameContext.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
    grad.addColorStop(0, "#FFFDF0");
    grad.addColorStop(0.45, color);
    grad.addColorStop(1, "#C9962E");
    gameContext.beginPath();
    gameContext.arc(cx, cy, r, 0, Math.PI * 2);
    gameContext.fillStyle = grad;
    gameContext.fill();
    gameContext.lineWidth = 1.3;
    gameContext.strokeStyle = "rgba(255,255,255,0.85)";
    gameContext.stroke();
}

// Locked-door key marker — the shape silhouette in its key colour on a white disc,
// matching the in-world key/door glyph.
function drawCombatKeyToken(shape, cx, cy, r) {
    gameContext.beginPath();
    gameContext.arc(cx, cy, r, 0, Math.PI * 2);
    gameContext.fillStyle = "rgba(255,255,255,0.92)";
    gameContext.fill();
    gameContext.lineWidth = 1.2;
    gameContext.strokeStyle = "rgba(0,0,0,0.35)";
    gameContext.stroke();
    if (typeof traceShapePath === "function") {
        traceShapePath(gameContext, shape, cx, cy, r * 0.62);
        gameContext.fillStyle = (typeof keyShapeColor === "function") ? keyShapeColor(shape) : "#ffca28";
        gameContext.fill();
    }
}

// Cart-cosmetic thumbnail for a live player, with a team-coloured ring in teams
// modes. Falls back to a plain disc if the player object is gone (left the room).
function drawCombatThumb(id, cx, cy, r) {
    var p = (typeof playerList !== "undefined" && playerList) ? playerList[id] : null;
    if (p != null && typeof drawOverviewKart === "function") {
        drawOverviewKart(p, cx, cy, r);
    } else {
        gameContext.beginPath();
        gameContext.arc(cx, cy, r, 0, Math.PI * 2);
        gameContext.fillStyle = "rgba(120,130,140,0.85)";
        gameContext.fill();
    }
    if (p != null && p.teamId != null && typeof teamInfo !== "undefined" && teamInfo != null && Array.isArray(teamInfo.defs)) {
        var tc = combatColorOf(id, null);
        gameContext.beginPath();
        gameContext.arc(cx, cy, r + 1.6, 0, Math.PI * 2);
        gameContext.lineWidth = 2;
        gameContext.strokeStyle = tc;
        gameContext.stroke();
    }
}

// Build the ordered segment list for one row. Segments: glyph (emoji marker) /
// abilityicon (ability sprite token) / thumb (cart cosmetic) / text.
function combatRowSegments(entry) {
    var segs = [];
    if (entry.type === "kill") {
        segs.push({ k: "glyph", emoji: "💥" });
        segs.push({ k: "thumb", id: entry.attackerId });
        segs.push({ k: "text", text: entry.attackerName, color: combatColorOf(entry.attackerId, "#ffffff"), bold: true });
        segs.push({ k: "thumb", id: entry.victimId });
        segs.push({ k: "text", text: entry.victimName, color: combatColorOf(entry.victimId, "#ffffff"), bold: false });
    } else if (entry.type === "death") {
        segs.push({ k: "glyph", emoji: "💀" });
        segs.push({ k: "thumb", id: entry.victimId });
        segs.push({ k: "text", text: entry.victimName, color: combatColorOf(entry.victimId, "#ffffff"), bold: false });
        if (entry.cause === "lava") { segs.push({ k: "text", text: "melted", color: "#9aa3ad", bold: false, small: true }); }
        else if (entry.cause === "crush") { segs.push({ k: "text", text: "crushed", color: "#9aa3ad", bold: false, small: true }); }
    } else if (entry.type === "ability") {
        // Lead with the ability's own icon as the action marker (operator request),
        // falling back to the name only if the sprite isn't decoded yet.
        var aimg = abilityIconFor(entry.abilityId);
        if (aimg != null && aimg.complete !== false && (aimg.naturalWidth == null || aimg.naturalWidth > 0)) {
            segs.push({ k: "abilityicon", img: aimg });
            segs.push({ k: "thumb", id: entry.ownerId });
            segs.push({ k: "text", text: entry.ownerName, color: combatColorOf(entry.ownerId, "#ffffff"), bold: false });
        } else {
            segs.push({ k: "thumb", id: entry.ownerId });
            segs.push({ k: "text", text: entry.ownerName, color: combatColorOf(entry.ownerId, "#ffffff"), bold: false });
            segs.push({ k: "text", text: abilityLabelFor(entry.abilityId), color: "#5fe0ee", bold: true });
        }
    } else if (entry.type === "orb") {
        // Bonus orb collected — the gold-sphere marker + the team points it banked.
        segs.push({ k: "orb" });
        segs.push({ k: "thumb", id: entry.ownerId });
        segs.push({ k: "text", text: entry.ownerName, color: combatColorOf(entry.ownerId, "#ffffff"), bold: false });
        segs.push({ k: "text", text: "+" + entry.points, color: "#ffd54a", bold: true });
    } else if (entry.type === "keyPickup") {
        segs.push({ k: "keyshape", shape: entry.shape });
        segs.push({ k: "thumb", id: entry.ownerId });
        segs.push({ k: "text", text: entry.ownerName, color: combatColorOf(entry.ownerId, "#ffffff"), bold: false });
        segs.push({ k: "text", text: "got key", color: "#cbd3da", bold: false, small: true });
    } else if (entry.type === "keyDrop") {
        segs.push({ k: "keyshape", shape: entry.shape });
        segs.push({ k: "thumb", id: entry.ownerId });
        segs.push({ k: "text", text: entry.ownerName, color: combatColorOf(entry.ownerId, "#ffffff"), bold: false });
        segs.push({ k: "text", text: "dropped key", color: "#cbd3da", bold: false, small: true });
    } else if (entry.type === "doorUnlock") {
        segs.push({ k: "glyph", emoji: "🔓" });
        segs.push({ k: "keyshape", shape: entry.shape });
        segs.push({ k: "thumb", id: entry.ownerId });
        segs.push({ k: "text", text: entry.ownerName, color: combatColorOf(entry.ownerId, "#ffffff"), bold: false });
        segs.push({ k: "text", text: "opened door", color: "#ffd54a", bold: true, small: true });
    } else if (entry.type === "warp") {
        // Warp Pad (boon) used — the 🌀 portal marker + who took the shortcut.
        segs.push({ k: "glyph", emoji: "🌀" });
        segs.push({ k: "thumb", id: entry.playerId });
        segs.push({ k: "text", text: entry.playerName, color: combatColorOf(entry.playerId, "#ffffff"), bold: false });
        segs.push({ k: "text", text: "warped", color: "#cbd3da", bold: false, small: true });
    } else { // score — 🥇/🥈/🏁 marker conveys the placement
        segs.push({ k: "glyph", emoji: combatScoreEmoji(entry.rankLabel) });
        segs.push({ k: "thumb", id: entry.playerId });
        segs.push({ k: "text", text: entry.playerName, color: combatColorOf(entry.playerId, "#ffffff"), bold: false });
        if (entry.points != null) { segs.push({ k: "text", text: "+" + entry.points, color: "#ffd54a", bold: true }); }
    }
    return segs;
}

function drawCombatLog() {
    if (typeof config === "undefined" || config == null || config.stateMap == null) { return; }
    if (currentState != config.stateMap.racing && currentState != config.stateMap.collapsing) { return; }
    if (combatLog.length === 0) { return; }
    var now = Date.now();
    // Prune expired rows.
    for (var i = combatLog.length - 1; i >= 0; i--) {
        var life = COMBAT_LOG_LIFE_MS[combatLog[i].type] || 6000;
        if (now - combatLog[i].bornAt > life) { combatLog.splice(i, 1); }
    }
    if (combatLog.length === 0) { return; }

    var rightX = LOGICAL_WIDTH - 16;
    var topY = 92;          // below the race timer + brutal-badge row
    var rowH = 26, gapY = 5, padX = 8, thumbR = 9, badgeR = 8, segGap = 5;
    var localId = (typeof myID !== "undefined") ? myID : null;

    gameContext.save();
    gameContext.textBaseline = "middle";
    for (var j = 0; j < combatLog.length; j++) {
        var entry = combatLog[j];
        var life = COMBAT_LOG_LIFE_MS[entry.type] || 6000;
        var age = now - entry.bornAt;
        var fadeIn = Math.min(1, age / 130);
        var fadeOut = (age > life - 500) ? Math.max(0, (life - age) / 500) : 1;
        var alpha = Math.max(0, Math.min(1, fadeIn * fadeOut));
        if (alpha <= 0) { continue; }
        var rowY = topY + j * (rowH + gapY);
        var cy = rowY + rowH / 2;

        // Measure.
        var segs = combatRowSegments(entry);
        var contentW = 0;
        for (var s = 0; s < segs.length; s++) {
            var seg = segs[s];
            if (seg.k === "glyph") { gameContext.font = "15px Arial"; seg.w = gameContext.measureText(seg.emoji).width; }
            else if (seg.k === "thumb") { seg.w = thumbR * 2; }
            else if (seg.k === "abilityicon") { seg.w = badgeR * 2; }
            else if (seg.k === "orb") { seg.w = badgeR * 2; }
            else if (seg.k === "keyshape") { seg.w = badgeR * 2; }
            else { // text
                gameContext.font = (seg.bold ? "bold " : "") + (seg.small ? "11px" : "13px") + " Arial";
                seg.w = gameContext.measureText(seg.text).width;
            }
            contentW += seg.w;
            if (s < segs.length - 1) { contentW += segGap; }
        }
        var pillW = contentW + padX * 2;
        var pillX = rightX - pillW;

        gameContext.globalAlpha = alpha;
        // Highlight rows the local player is involved in.
        var mine = (localId != null) && (entry.attackerId === localId || entry.victimId === localId ||
            entry.ownerId === localId || entry.playerId === localId);
        if (typeof drawHudPanel === "function") {
            drawHudPanel(pillX, rowY, pillW, rowH, {
                fill: mine ? "rgba(28,34,44,0.86)" : "rgba(10,12,16,0.74)",
                alpha: alpha,
                borderAlpha: alpha,
                radius: 7,
                border: mine ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.22)"
            });
        } else {
            gameContext.fillStyle = "rgba(10,12,16,0.74)";
            roundRectPath(gameContext, pillX, rowY, pillW, rowH, 7);
            gameContext.fill();
        }

        // Draw left → right.
        var cx = pillX + padX;
        gameContext.globalAlpha = alpha;
        for (var d = 0; d < segs.length; d++) {
            var sg = segs[d];
            if (sg.k === "glyph") {
                gameContext.font = "15px Arial";
                gameContext.textAlign = "left";
                gameContext.fillText(sg.emoji, cx, cy + 0.5);
            } else if (sg.k === "thumb") {
                drawCombatThumb(sg.id, cx + thumbR, cy, thumbR);
                gameContext.globalAlpha = alpha; // drawOverviewKart resets alpha via save/restore — re-assert
            } else if (sg.k === "abilityicon") {
                drawAbilityIconToken(sg.img, cx + badgeR, cy, badgeR);
            } else if (sg.k === "orb") {
                drawCombatOrbToken(cx + badgeR, cy, badgeR);
            } else if (sg.k === "keyshape") {
                drawCombatKeyToken(sg.shape, cx + badgeR, cy, badgeR);
            } else {
                gameContext.font = (sg.bold ? "bold " : "") + (sg.small ? "11px" : "13px") + " Arial";
                gameContext.textAlign = "left";
                gameContext.fillStyle = sg.color;
                gameContext.fillText(sg.text, cx, cy + 0.5);
            }
            cx += sg.w + segGap;
        }
    }
    gameContext.restore();
}

// ---- Live achievement-skin ticker (bottom-left) ----------------------------------------
// A transient personal corner bar tracking LIFETIME progress toward the next achievement
// SKIN for a skill stat. Two beats:
//   • CONTRIBUTION (mid-race): the server pushes `medalProgress` on each skill play (a kill,
//     a charged punch, a bumper bonk, …). We flash "+N <Skill>" + the in-match tally
//     ("N this match") and show the LIFETIME bar as the GOAL — base = your lifetime
//     medal_count for that stat, target = the next ACHIEVEMENT_UNLOCKS threshold above it,
//     labelled with the skin it unlocks ("Heavy Hitter 6/20 → Plasma"). The bar is STATIC
//     during the match: lifetime medals only bank at match-end, so a hint reminds you that
//     holding/winning this match's medal banks the next +1.
//   • ADVANCE (post-match): when progressionUpdate arrives with a higher lifetime count, the
//     bar animates old→new with a celebration, and an unlock flourish if it crossed a
//     threshold (new skin name).
// Signed-in only for the lifetime bar (guests have no medal_counts) — guests get just the
// "+N <Skill>" contribution pop. Latest-wins single slot, wall-clock timed, fades in/out.
// Bottom-left so it never collides with the combat log (top-right). Screen-space, logical
// coords — no camera offset, no DPR multiply.
var skillProgressHud = null;
var SKILL_HUD_LIFE_MS = 3000;        // contribution envelope
var SKILL_HUD_ADVANCE_MS = 4200;     // match-end advance envelope (a touch longer to read)
var SKILL_HUD_SWEEP_MS = 620;        // bar sweep base->shown
function skillProgressReset() { skillProgressHud = null; }

// LIFETIME achievement-skin progress for a medal stat: the player's lifetime count for that
// stat and the NEXT unearned ACHIEVEMENT_UNLOCKS threshold above it, labelled with the skin
// it unlocks. Mirrors the server's achievementsUnlocked (>= rule) and the lobby picker's
// val-vs-threshold derivation, but resolved per-STAT (next unmet rung). Returns null for
// guests (no myProgression — no lifetime ledger) or unknown/unladdered stats.
//   { base, target, skinName, skinId, maxed }   (maxed => every skin for the stat is earned)
function achievementProgressForStat(stat) {
    if (stat == null) { return null; }
    var prog = (typeof myProgression !== "undefined") ? myProgression : null;
    if (!prog) { return null; } // guests have no lifetime medal_counts
    var defs = (typeof config !== "undefined" && config && config.achievementDefs) ? config.achievementDefs : null;
    if (!defs) { return null; }
    var base = (stat === 'wins') ? (prog.wins || 0) : ((prog.medal_counts || {})[stat] || 0);
    var next = null;
    for (var i = 0; i < defs.length; i++) {
        var d = defs[i];
        if (d.stat !== stat) { continue; }
        if (base < d.threshold && (next == null || d.threshold < next.threshold)) { next = d; }
    }
    if (next == null) { return { base: base, target: null, skinName: null, skinId: null, maxed: true }; }
    return { base: base, target: next.threshold, skinName: next.name, skinId: next.id, maxed: false };
}

// CONTRIBUTION beat (mid-race medalProgress). Flash "+N <Skill>" + the in-match tally; the
// bar reflects the (static) lifetime base/target. Guests (life == null) get the pop only.
function setSkillProgressHud(p) {
    if (p == null || p.medal == null) { return; }
    var delta = (p.delta && p.delta > 0) ? p.delta : 1;
    var matchCount = (typeof p.current === "number" && p.current > 0) ? p.current : delta;
    skillProgressHud = {
        mode: 'contribution',
        medal: p.medal,
        label: p.label || p.medal,
        delta: delta,
        matchCount: matchCount,
        life: achievementProgressForStat(p.medal), // {base,target,skinName,maxed} | null (guest)
        bornAt: Date.now()
    };
}

// ADVANCE beat (post-match): the lifetime bar actually moved. Animate base(old)->base(new)
// toward the same target it was chasing; if the new count crossed the target, flag the
// unlock so the draw shows the skin-unlocked flourish. Called from the progressionUpdate
// diff (noteProgressionAdvance). `prevBase`/`newBase` are lifetime counts for the stat.
function setSkillAdvanceHud(opts) {
    if (opts == null || opts.medal == null) { return; }
    skillProgressHud = {
        mode: 'advance',
        medal: opts.medal,
        label: opts.label || opts.medal,
        prevBase: opts.prevBase,
        newBase: opts.newBase,
        target: opts.target,            // threshold the OLD count was chasing (may be null if maxed)
        crossed: !!opts.crossed,        // newBase >= that target
        skinName: opts.skinName || null,// skin unlocked when crossed
        nextTarget: opts.nextTarget,    // next rung after crossing (for the post-cross fill), may be null
        bornAt: Date.now()
    };
}

// The skill stats the live ticker follows (mirrors the reportSkillProgress call sites in
// server/entities/player.js). Only these drive the post-match advance beat, so banking a
// participation stat (gamesPlayed +1 every match, goalsReached, …) doesn't hijack the
// skill-play ticker every single round.
var SKILL_TICKER_STATS = ['mostKills', 'savior', 'heavyHitter', 'pinball'];

// The ascending ACHIEVEMENT_UNLOCKS defs for a stat (from config.achievementDefs), or [].
function achievementDefsForStat(stat) {
    var defs = (typeof config !== "undefined" && config && config.achievementDefs) ? config.achievementDefs : null;
    if (!defs) { return []; }
    var out = [];
    for (var i = 0; i < defs.length; i++) { if (defs[i].stat === stat) { out.push(defs[i]); } }
    out.sort(function (a, b) { return a.threshold - b.threshold; });
    return out;
}

// Compare the pre- and post-match progression rows and, if a tracked SKILL medal's lifetime
// count went up, play the advance beat (old->new) on the corner bar — celebrating the bank
// and flourishing an unlock if it crossed a skin threshold. Signed-in only (guests have no
// medal_counts). Called from the progressionUpdate handler with the row it's replacing.
function noteProgressionAdvance(prevProg, newProg) {
    if (!prevProg || !newProg || !prevProg.medal_counts || !newProg.medal_counts) { return; }
    var best = null; // prefer an advance that crossed a threshold (an unlock) over a plain bank
    for (var i = 0; i < SKILL_TICKER_STATS.length; i++) {
        var stat = SKILL_TICKER_STATS[i];
        var prevCount = prevProg.medal_counts[stat] || 0;
        var newCount = newProg.medal_counts[stat] || 0;
        if (newCount <= prevCount) { continue; }
        var defs = achievementDefsForStat(stat);
        if (!defs.length) { continue; }
        // The rung the OLD count was chasing (first threshold above it).
        var chasing = null, nextRung = null;
        for (var d = 0; d < defs.length; d++) {
            if (chasing == null && prevCount < defs[d].threshold) { chasing = defs[d]; }
            if (nextRung == null && newCount < defs[d].threshold) { nextRung = defs[d]; }
        }
        if (chasing == null) { continue; } // every skin for this stat already earned — nothing to show
        var crossed = newCount >= chasing.threshold;
        var cand = {
            medal: stat,
            label: chasing.title || stat,
            prevBase: prevCount,
            newBase: newCount,
            target: chasing.threshold,
            crossed: crossed,
            skinName: crossed ? chasing.name : null,
            nextTarget: nextRung ? nextRung.threshold : null
        };
        if (crossed) { best = cand; break; }   // an unlock wins outright
        if (best == null) { best = cand; }      // else remember the first plain bank
    }
    if (best) { setSkillAdvanceHud(best); }
}

function drawSkillProgressHud() {
    if (skillProgressHud == null) { return; }
    if (typeof config === "undefined" || config == null || config.stateMap == null) { return; }
    var h = skillProgressHud;
    var isAdvance = (h.mode === 'advance');
    // Contribution plays only happen mid-race; the post-match advance shows on the
    // game-over / overview / lobby screens where progressionUpdate lands.
    if (!isAdvance) {
        if (currentState != config.stateMap.racing && currentState != config.stateMap.collapsing) {
            skillProgressHud = null;
            return;
        }
    } else if (currentState == config.stateMap.racing || currentState == config.stateMap.gated) {
        // A fresh round started before the advance could play — drop it.
        skillProgressHud = null;
        return;
    }

    var now = Date.now();
    var life = (now - h.bornAt) / (isAdvance ? SKILL_HUD_ADVANCE_MS : SKILL_HUD_LIFE_MS);
    if (life >= 1) { skillProgressHud = null; return; }

    // Envelope: fade in (first 10%), hold, fade out (last 22%).
    var alpha;
    if (life < 0.10) { alpha = life / 0.10; }
    else if (life > 0.78) { alpha = 1 - (life - 0.78) / 0.22; }
    else { alpha = 1; }
    alpha = clamp01(alpha);

    // Resolve the bar numbers per mode.
    var hasBar, ratio, gold, headRight, hint, flashLeft;
    if (isAdvance) {
        hasBar = (typeof h.target === "number" && h.target > 0);
        // Sweep old->new lifetime count.
        var sweepT = clamp01((now - h.bornAt) / SKILL_HUD_SWEEP_MS);
        var ease = 1 - Math.pow(1 - sweepT, 3);
        var shown = h.prevBase + (h.newBase - h.prevBase) * ease;
        var fillTarget = (h.crossed && typeof h.nextTarget === "number" && h.nextTarget > 0) ? h.nextTarget : h.target;
        ratio = hasBar ? clamp01(shown / (fillTarget || 1)) : 0;
        gold = true; // a banked medal is always a celebratory beat
        flashLeft = "+1  " + h.label;
        if (h.crossed && h.skinName) {
            headRight = "UNLOCKED!";
            hint = h.skinName + " skin unlocked";
        } else if (hasBar) {
            headRight = Math.round(shown) + " / " + (fillTarget || h.target);
            hint = "Banked! → " + (h.skinName || "next skin");
        } else {
            headRight = "+1 lifetime";
            hint = "All " + h.label + " skins earned";
        }
    } else {
        var lf = h.life; // {base,target,skinName,maxed} | null
        hasBar = !!(lf && !lf.maxed && lf.target);
        gold = false;
        flashLeft = "+" + h.delta + "  " + h.label;
        if (lf == null) {
            // Guest: contribution pop only, no lifetime bar.
            headRight = h.matchCount + " this match";
            hint = null;
        } else if (lf.maxed) {
            headRight = h.matchCount + " this match";
            hint = "All " + h.label + " skins earned";
        } else {
            ratio = clamp01(lf.base / lf.target);
            headRight = lf.base + " / " + lf.target;
            hint = "Hold the medal to bank +1 → " + lf.skinName;
        }
    }

    var accent = gold ? "#ffd54a" : "#5ad1ff";
    var beat = gold ? (0.85 + 0.15 * Math.sin(now / 90)) : 1;

    var padX = 12, padY = 9;
    var w = 230, h2 = hasBar ? 58 : 44;
    var x = 16;
    var y = LOGICAL_HEIGHT - h2 - 78; // clear of the bottom touch controls
    var barH = 9;
    var barY = y + h2 - padY - barH;
    var barX = x + padX;
    var barW = w - padX * 2;

    gameContext.save();
    gameContext.globalAlpha = alpha;
    drawHudPanel(x, y, w, h2, {
        fill: "rgba(10,12,16,0.82)",
        alpha: alpha,
        borderAlpha: alpha,
        radius: 9,
        border: gold ? "rgba(255,213,74,0.85)" : "rgba(255,255,255,0.28)",
        glow: gold ? "rgba(255,213,74,0.55)" : null
    });

    // "+N <Skill>" flash (top-left) + the headline number / state (top-right).
    gameContext.globalAlpha = alpha * beat;
    gameContext.textBaseline = "alphabetic";
    gameContext.textAlign = "left";
    gameContext.font = "bold 14px Arial";
    gameContext.fillStyle = accent;
    gameContext.fillText(flashLeft, x + padX, y + padY + 12);
    gameContext.textAlign = "right";
    gameContext.font = "bold 12px Arial";
    gameContext.fillStyle = accent;
    gameContext.fillText(headRight, x + w - padX, y + padY + 12);

    // Hint line ("→ <Skin>" goal / bank reminder / unlock) under the headline.
    if (hint) {
        gameContext.globalAlpha = alpha;
        gameContext.textAlign = "left";
        gameContext.font = "10px Arial";
        gameContext.fillStyle = gold ? "#ffe9a8" : "#aeb6c0";
        gameContext.fillText(hint, x + padX, y + padY + 27);
    }

    // Track + fill (only when there's a lifetime target to chase).
    if (hasBar) {
        gameContext.globalAlpha = alpha;
        gameContext.fillStyle = "rgba(255,255,255,0.14)";
        roundRectPath(gameContext, barX, barY, barW, barH, barH / 2);
        gameContext.fill();
        if (ratio > 0) {
            gameContext.fillStyle = accent;
            roundRectPath(gameContext, barX, barY, Math.max(barH, barW * ratio), barH, barH / 2);
            gameContext.fill();
        }
    }
    gameContext.restore();
}

// Screen-space banner that drops in when ANY player (you, an opponent, an
// off-screen finisher) sets a top-10 world record. Visible regardless of
// where the camera is so a WR happening across the map isn't missed. Slides
// down from the top, holds, fades up. Self-clears after the animation; a new
// WR mid-animation replaces it.
var WORLD_RECORD_BANNER_DURATION_MS = 4800;
function drawWorldRecordBanner() {
    if (worldRecordBanner == null) { return; }
    var t = (Date.now() - worldRecordBanner.startedAt) / WORLD_RECORD_BANNER_DURATION_MS;
    if (t >= 1) { worldRecordBanner = null; return; }

    // Slide-down + fade-in (first 12%), hold (12-78%), slide-up + fade-out (last 22%).
    var alpha, slide;
    if (t < 0.12) {
        var k = t / 0.12;
        alpha = k;
        slide = -40 * (1 - k); // start 40px above target, ease in
    } else if (t > 0.78) {
        var k2 = (t - 0.78) / 0.22;
        alpha = 1 - k2;
        slide = -40 * k2;
    } else {
        alpha = 1;
        slide = 0;
    }

    var cx = LOGICAL_WIDTH / 2;
    var by = 70 + slide;
    var rankSuffix = (worldRecordBanner.rank != null) ? ("  ·  #" + worldRecordBanner.rank + " global") : "";
    var line1 = "New world record";
    var line2 = worldRecordBanner.displayName + " — " + worldRecordBanner.mapName;
    var line3 = formatRaceTime(worldRecordBanner.finishMs) + rankSuffix;

    gameContext.save();
    gameContext.globalAlpha = alpha;
    gameContext.textAlign = "center";
    gameContext.textBaseline = "alphabetic";
    // Headline — magenta, subtle outline; no glow.
    gameContext.font = "bold 22px Arial";
    gameContext.lineWidth = 3;
    gameContext.strokeStyle = "rgba(0,0,0,0.85)";
    gameContext.strokeText(line1, cx, by);
    gameContext.fillStyle = "#ff5fea";
    gameContext.fillText(line1, cx, by);
    // Who · where — white.
    gameContext.font = "15px Arial";
    gameContext.strokeText(line2, cx, by + 19);
    gameContext.fillStyle = "white";
    gameContext.fillText(line2, cx, by + 19);
    // Time + rank — gold.
    gameContext.font = "bold 16px Arial";
    gameContext.strokeText(line3, cx, by + 38);
    gameContext.fillStyle = "#ffd54a";
    gameContext.fillText(line3, cx, by + 38);
    gameContext.restore();
}

// Compact corner leaderboard shown while spectating (dead/finished during a
// race). Sources mapLeaderboardCurrent (server emits at startRace). Top-left
// of the HUD so the timer in the top-right and centered GameID row stay
// uncluttered. Renders even when the current map has no leaderboard rows yet
// — shows a "New map!" placeholder so the player understands the widget is
// alive, just unfilled. Hidden when the local racer is still actively racing.
function drawSpectatorLeaderboard() {
    if (mapLeaderboardCurrent == null) { return; }
    if (currentState != config.stateMap.racing && currentState != config.stateMap.collapsing) {
        return;
    }
    var local = (typeof myID !== "undefined" && playerList) ? playerList[myID] : null;
    if (local == null) { return; }
    // Only when the local racer is no longer active (died or finished).
    var spectating = (!local.alive) || local.reachedGoal || local.isSpectator;
    if (!spectating) { return; }

    var rows = mapLeaderboardCurrent.rows || [];
    var mapName = mapLeaderboardCurrent.mapName || "this map";
    var listX = 20;
    var listY = 50;
    var rowH = 18;

    gameContext.save();
    gameContext.fillStyle = "white";
    gameContext.font = "bold 14px Arial";
    gameContext.textBaseline = "alphabetic";
    gameContext.textAlign = "left";
    gameContext.fillText("Times to beat — " + mapName, listX, listY);

    if (rows.length === 0) {
        gameContext.font = "italic 13px Arial";
        gameContext.fillStyle = "#9b5";
        gameContext.fillText("New map!", listX, listY + 18);
        gameContext.restore();
        return;
    }

    gameContext.font = "12px Arial";
    var nameColX = listX + 38;
    var timeColX = listX + 240;
    for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var rowY = listY + 16 + i * rowH;
        gameContext.textAlign = "left";
        gameContext.fillStyle = "white";
        gameContext.fillText("#" + row.rank, listX, rowY);
        // "Anon" placeholder for nameless rows (same convention as the main
        // overview card and WR banner).
        var label = row.displayName || "Anon";
        var maxNameW = (timeColX - nameColX) - 14;
        var truncated = label;
        if (gameContext.measureText(label).width > maxNameW) {
            while (truncated.length > 1 && gameContext.measureText(truncated + "…").width > maxNameW) {
                truncated = truncated.slice(0, -1);
            }
            truncated += "…";
        }
        gameContext.fillText(truncated, nameColX, rowY);
        gameContext.textAlign = "right";
        gameContext.fillText(formatRaceTime(row.bestMs), timeColX, rowY);
    }
    gameContext.restore();
}

// "NEW personal record!!" / "NEW WORLD record!!!" float for each player who
// just set a PB this round. Server pushes records via playerPbResult after the
// per-finish upsert + rank lookup, which means the last finisher's float can
// arrive AFTER startOverview has already begun (their finish triggered it).
//
// Rendered in two contexts:
//   * Race/collapse — anchored above the kart's world position (it's at the
//     goal cell when they finished). Drawn from the world-space pass.
//   * Overview      — anchored to the player's notch row on the standings
//     column, so a late-arriving float still surfaces visibly. Drawn from
//     drawOverviewBoard.
//
// `drainRecordFloats` runs every frame so expired entries are pruned even when
// no render branch fires, keeping the array bounded across rounds.
var RECORD_FLOAT_DURATION_MS = 2400;

function drainRecordFloats() {
    if (recordFloats.length === 0) { return; }
    var now = Date.now();
    var w = 0;
    for (var r = 0; r < recordFloats.length; r++) {
        if (now - recordFloats[r].startedAt < RECORD_FLOAT_DURATION_MS) {
            recordFloats[w++] = recordFloats[r];
        }
    }
    recordFloats.length = w;
}

// Animation envelope (alpha, vertical rise) shared by both render contexts.
function recordFloatEnvelope(now, startedAt) {
    var t = (now - startedAt) / RECORD_FLOAT_DURATION_MS;
    var alpha;
    if (t < 0.1) { alpha = t / 0.1; }
    else if (t > 0.6) { alpha = Math.max(0, (1 - t) / 0.4); }
    else { alpha = 1; }
    var rise = 50 * (1 - Math.pow(1 - t, 2));
    return { alpha: alpha, rise: rise, t: t };
}

function paintRecordFloat(f, x, y, alpha) {
    var label = f.isWorldRecord ? "NEW WORLD record!!!" : "NEW personal record!!";
    var color = f.isWorldRecord ? "#ff5fea" : "#ffd54a";
    gameContext.globalAlpha = alpha;
    gameContext.font = "bold 18px Arial";
    gameContext.lineWidth = 4;
    gameContext.strokeStyle = "rgba(0,0,0,0.85)";
    gameContext.shadowColor = color;
    gameContext.shadowBlur = 10;
    gameContext.strokeText(label, x, y);
    gameContext.fillStyle = color;
    gameContext.fillText(label, x, y);
    gameContext.font = "bold 22px Arial";
    gameContext.strokeText(formatRaceTime(f.finishMs), x, y + 22);
    gameContext.fillText(formatRaceTime(f.finishMs), x, y + 22);
}

// World-space rendering — used during the racing/collapsing draw pass.
// Floating team-point deltas (+5 / +2 / -1) over the kart that caused them, in the
// team's colour: rise + fade over TEAM_FLOAT_MS, riding the kart while it exists
// (a removed kart's float parks at its last seen spot). World pass — camera offset
// applied per convention. `lane` stacks simultaneous same-kart floats upward.
function drawTeamPointFloats() {
    if (typeof teamPointFloats === "undefined" || teamPointFloats.length === 0) { return; }
    var now = Date.now();
    teamPointFloats = teamPointFloats.filter(function (f) { return now - f.start < TEAM_FLOAT_MS; });
    if (teamPointFloats.length === 0) { return; }
    gameContext.save();
    gameContext.textAlign = "center";
    gameContext.textBaseline = "alphabetic";
    gameContext.font = "bold 17px sans-serif";
    gameContext.lineWidth = 3.5;
    gameContext.lineJoin = "round";
    for (var i = 0; i < teamPointFloats.length; i++) {
        var f = teamPointFloats[i];
        var player = playerList ? playerList[f.id] : null;
        if (player != null && player.x != null && player.y != null) {
            f.x = player.x; f.y = player.y; // ride the kart while it exists
        }
        if (f.x == null || f.y == null) { continue; }
        var age = (now - f.start) / TEAM_FLOAT_MS;        // 0..1
        var rise = 26 * age;                              // drift upward
        var alpha = age < 0.6 ? 1 : (1 - (age - 0.6) / 0.4); // hold, then fade out
        var x = f.x + camera.getCameraX();
        var y = f.y + camera.getCameraY() - 26 - rise - f.lane * 16;
        gameContext.globalAlpha = Math.max(0, alpha);
        gameContext.strokeStyle = "rgba(0,0,0,0.85)";
        gameContext.strokeText(f.text, x, y);
        gameContext.fillStyle = f.color;
        gameContext.fillText(f.text, x, y);
    }
    gameContext.restore();
}

function drawRecordFloats() {
    drainRecordFloats();
    if (recordFloats.length === 0) { return; }
    var now = Date.now();
    gameContext.save();
    gameContext.textAlign = "center";
    gameContext.textBaseline = "alphabetic";
    for (var i = 0; i < recordFloats.length; i++) {
        var f = recordFloats[i];
        var player = playerList ? playerList[f.playerId] : null;
        if (player == null || player.x == null || player.y == null) { continue; }
        var env = recordFloatEnvelope(now, f.startedAt);
        var x = player.x + camera.getCameraX();
        var y = player.y + camera.getCameraY() - 40 - env.rise;
        paintRecordFloat(f, x, y, env.alpha);
    }
    gameContext.restore();
}

// Record floats during the overview pass. The world-space anchor doesn't apply
// (camera detached, players unrendered), so the float drops onto the player's
// standings row instead. Last-finisher records that arrive AFTER startOverview
// still surface here. Shares computeStandingsRowGeom so the rows line up exactly
// with drawStandingsPanel regardless of player count / column split.
function drawRecordFloatsOverview(page) {
    drainRecordFloats();
    if (recordFloats.length === 0) { return; }
    if (playerList == null || page == null) { return; }
    var g = page.geom || computeStandingsRowGeom(page); // reuse the frame's shared geometry
    if (g.count === 0) { return; }
    // playerId -> row index, matching the standings iteration order.
    var rowIdx = {};
    for (var i = 0; i < g.count; i++) { rowIdx[g.ids[i]] = i; }

    var now = Date.now();
    gameContext.save();
    gameContext.textAlign = "center";
    gameContext.textBaseline = "alphabetic";
    for (var k = 0; k < recordFloats.length; k++) {
        var f = recordFloats[k];
        if (!(f.playerId in rowIdx)) { continue; }
        var b = g.box(rowIdx[f.playerId]);
        var env = recordFloatEnvelope(now, f.startedAt);
        // Centre over the row's track, lifted above the row.
        var x = b.x + b.w * 0.55;
        var y = b.y - 4 - env.rise;
        paintRecordFloat(f, x, y, env.alpha);
    }
    gameContext.restore();
}

// Race elapsed-time timer in the top-right HUD corner. Active during racing /
// collapsing. Stores the frozen elapsed value directly (not a wall-clock
// timestamp) so the display never depends on subtracting a server clock from
// the browser's clock. Three states:
//   * Running   -> Date.now() - raceStartedAt, white
//   * Finished  -> player.finishMs (server-authoritative), gold
//   * Died      -> elapsed-at-receipt (client-relative), red
// Latched on the first transition; later state changes (zombie respawn etc.)
// can't unfreeze it.
function drawRaceTimer() {
    if (raceStartedAt == null) { return; }
    if (currentState != config.stateMap.racing && currentState != config.stateMap.collapsing) {
        return;
    }
    var local = (typeof myID !== "undefined" && playerList) ? playerList[myID] : null;

    if (local != null && localTimerStopAt == null) {
        if (local.reachedGoal && typeof local.finishMs === 'number') {
            // Goal-cross: server tells us the elapsed delta directly. Pin
            // the display to that value so it reads identical to the
            // server-side leaderboard, regardless of any client clock drift.
            localTimerStopAt = local.finishMs;
            localTimerStopByDeath = false;
        } else if (local.alive === false) {
            // Death: no server time was sent. Client-relative elapsed is fine
            // here because both endpoints (raceStartedAt and Date.now()) come
            // from the same browser clock.
            localTimerStopAt = Date.now() - raceStartedAt;
            localTimerStopByDeath = true;
        }
    }

    var elapsed = (localTimerStopAt != null) ? localTimerStopAt : (Date.now() - raceStartedAt);
    if (!(elapsed >= 0)) { elapsed = 0; }

    var color = "white";
    if (localTimerStopAt != null) {
        color = localTimerStopByDeath ? "#ff5a5a" : "#ffd54a";
    }
    gameContext.save();
    gameContext.font = "bold 28px Arial";
    var label = formatRaceTime(elapsed);
    // Fixed dark pill (not the theme surface) so the white/gold/red time keeps
    // contrast in BOTH themes and over any terrain.
    var tw = gameContext.measureText(label).width;
    drawHudPanel(LOGICAL_WIDTH - 20 - tw - 12, 10, tw + 24, 38, {
        fill: "rgba(12, 14, 18, 0.62)", alpha: 1,
        border: "rgba(255, 255, 255, 0.25)", borderWidth: 1.5
    });
    gameContext.fillStyle = color;
    gameContext.textAlign = "right";
    gameContext.textBaseline = "alphabetic";
    gameContext.fillText(label, LOGICAL_WIDTH - 20, 40);
    gameContext.restore();
}

// Local players (slots) that joined this match mid-race and are still waiting:
// the server parked them as temp spectators who race from the next round. Covers
// the primary AND any co-op pad seat that joined after the gate. The per-slot
// lateJoinSpectating flag distinguishes a late joiner from a racer who just died
// this round (both are !alive during racing).
function spectatingLocalPlayers() {
    var out = [];
    if (typeof localPlayers === "undefined" || typeof playerList === "undefined" || !playerList) {
        return out;
    }
    for (var s = 0; s < localPlayers.length; s++) {
        var lp = localPlayers[s];
        if (!lp || lp.myID == null || !lp.lateJoinSpectating) {
            continue;
        }
        var p = playerList[lp.myID];
        if (p != null && !p.alive) {
            out.push(p);
        }
    }
    return out;
}

// A centered hint for local players who joined a match mid-round: each races from
// the next round. Drawn in HUD (screen) space below the GameID/Players/Round row,
// ending with a mini kart per waiting player in the colour the server assigned it
// (same sprite + colour-blind remap as their real kart), so they know what
// they'll race as. State-gated to the live race so it never bleeds into the
// game-over / lobby screens. When a local player is actively RACING on this
// shared couch screen, the whole banner is faded so it doesn't obscure their run;
// at full strength only when everyone local is waiting.
function drawSpectatorBanner() {
    if (currentState != config.stateMap.racing && currentState != config.stateMap.collapsing) {
        return;
    }
    var specs = spectatingLocalPlayers();
    if (specs.length === 0) {
        return;
    }
    var racingPresent = livingLocalPlayers().length > 0;

    var swatchR = 10;          // kart disc radius drawn in the banner
    var discGap = 6;           // spacing between multiple kart discs
    var sprites = [];
    for (var i = 0; i < specs.length; i++) {
        if (specs[i].color != null) {
            sprites.push(getPlayerSprite(specs[i].color, swatchR, "black"));
        }
    }
    var hasSwatch = sprites.length > 0;
    var text = hasSwatch ? "Spectating — you'll race next round as"
        : "Spectating — you'll race next round";
    var gap = hasSwatch ? 10 : 0;  // text -> first swatch spacing
    var swatchW = hasSwatch ? (sprites.length * swatchR * 2 + (sprites.length - 1) * discGap) : 0;

    gameContext.save();
    // Considerate fade when a local kart is still racing; full strength otherwise.
    gameContext.globalAlpha = racingPresent ? 0.6 : 1.0;
    gameContext.font = "bold 18px Arial";
    gameContext.textAlign = "left";
    gameContext.textBaseline = "alphabetic";
    var textW = gameContext.measureText(text).width;
    var padX = 14;
    var w = textW + gap + swatchW + padX * 2;
    var cx = LOGICAL_WIDTH / 2;
    var y = 66; // below the session info bar (which spans y 8..38)
    var boxX = cx - w / 2;

    gameContext.fillStyle = "rgba(0, 0, 0, 0.55)";
    roundRectPath(gameContext, boxX, y - 19, w, 28, 9); // in the play bundle (audience.js)
    gameContext.fill();

    var textX = boxX + padX;
    gameContext.fillStyle = "white";
    gameContext.fillText(text, textX, y);

    var discCx = textX + textW + gap + swatchR;
    var discCy = y - 5; // vertical centre of the pill (top y-19, height 28)
    for (var j = 0; j < sprites.length; j++) {
        gameContext.drawImage(sprites[j], discCx - sprites[j].halfSize, discCy - sprites[j].halfSize);
        discCx += swatchR * 2 + discGap;
    }
    gameContext.restore();
}

// ---- Shared HUD chrome -----------------------------------------------------
// One rounded-panel language for every persistent HUD element (session info
// bar, map plaque, waiting banner), borrowed from the lobby-hub banners
// (lobbyHub.js drawLobbyBanner): theme surface fill, 2px ink border, 9px
// corners. Keeps the in-race HUD reading as the same family as the lobby UI.
function drawHudPanel(x, y, w, h, opts) {
    opts = opts || {};
    gameContext.save();
    if (opts.glow) { gameContext.shadowColor = opts.glow; gameContext.shadowBlur = 14; }
    gameContext.globalAlpha = (opts.alpha != null) ? opts.alpha : 0.88;
    gameContext.fillStyle = opts.fill || themeColor('surface', '#101216');
    roundRectPath(gameContext, x, y, w, h, (opts.radius != null) ? opts.radius : 9); // audience.js helper
    gameContext.fill();
    gameContext.shadowBlur = 0;
    gameContext.globalAlpha = (opts.borderAlpha != null) ? opts.borderAlpha : 1;
    gameContext.lineWidth = (opts.borderWidth != null) ? opts.borderWidth : 2;
    gameContext.strokeStyle = opts.border || themeColor('ink', 'black');
    gameContext.stroke();
    gameContext.restore();
}

// Persistent-chrome fade: the round panel and the map plaque render at full
// strength through the gate countdown, then ease down to a translucent
// watermark shortly after the race starts so they stop competing with the
// action. Re-arms every round (raceStartedAt is re-stamped on each startRace).
var HUD_FADE_DELAY_MS = 800;   // grace period after the gate drops
var HUD_FADE_MS = 900;         // fade duration
var HUD_FADED_ALPHA = 0.4;     // resting opacity while racing
function hudChromeAlpha() {
    if (raceStartedAt == null) { return 1; }
    if (currentState != config.stateMap.racing && currentState != config.stateMap.collapsing) { return 1; }
    var e = Date.now() - raceStartedAt - HUD_FADE_DELAY_MS;
    if (e <= 0) { return 1; }
    return 1 - clamp01(e / HUD_FADE_MS) * (1 - HUD_FADED_ALPHA);
}

// Top-centre session readout: GAME <id> · PLAYERS <n> · ROUND <r>. Frameless
// by design (operator preference — no panel box up here): small-caps dimmed
// labels + bold values in the theme ink/ink-outline text treatment so the row
// reads over any terrain, with small dot separators. GAME + PLAYERS always
// show (friends read the room id off the host's screen); ROUND joins once a
// race exists. The whole row fades to a watermark while racing (hudChromeAlpha).
// Extra top padding (LOGICAL units) for top-anchored HUD (session readout, lobby
// status card / banners) so it clears a Discord-mobile frame's notch + Discord header
// (safe-top). 0 on web/desktop — there the canvas is letterboxed, so the inset lives in
// the bars, not over the HUD. Gated to the Activity (matches the touch-HUD insets).
function hudTopInset() {
    if (typeof isDiscordActivity !== "function" || !isDiscordActivity()) { return 0; }
    if (typeof cssToLogical !== "function" || typeof safeInsetCss !== "function") { return 0; }
    return cssToLogical(safeInsetCss("top"));
}

function drawGameInfo() {
    var segs = [
        { label: "GAME", value: (gameID != null && gameID !== "") ? ("" + gameID) : "—" },
        { label: "PLAYERS", value: "" + totalPlayers }
    ];
    var inRace = currentState == config.stateMap.gated ||
        currentState == config.stateMap.racing ||
        currentState == config.stateMap.collapsing;
    if (inRace && round > 0) {
        segs.push({ label: "ROUND", value: "" + round });
    }

    var labelFont = "bold 10px sans-serif";
    var valueFont = "bold 15px sans-serif";
    var labelGap = 5, sepGap = 11;
    var ink = themeColor('ink', 'black');
    var outline = themeColor('inkOutline', 'white');
    var fade = hudChromeAlpha();

    gameContext.save();
    var total = 0;
    for (var i = 0; i < segs.length; i++) {
        gameContext.font = labelFont;
        segs[i].lw = gameContext.measureText(segs[i].label).width;
        gameContext.font = valueFont;
        segs[i].vw = gameContext.measureText(segs[i].value).width;
        segs[i].w = segs[i].lw + labelGap + segs[i].vw;
        total += segs[i].w;
    }
    var w = total + (segs.length - 1) * sepGap * 2;
    var cx = (LOGICAL_WIDTH - w) / 2;
    var cy = 21 + hudTopInset();

    gameContext.textBaseline = "middle";
    gameContext.textAlign = "left";
    gameContext.lineWidth = 3;
    gameContext.strokeStyle = outline;
    for (var k = 0; k < segs.length; k++) {
        if (k > 0) {
            // Small dot separator between segments.
            cx += sepGap;
            gameContext.globalAlpha = 0.45 * fade;
            gameContext.fillStyle = ink;
            gameContext.beginPath();
            gameContext.arc(cx, cy, 1.8, 0, Math.PI * 2);
            gameContext.fill();
            cx += sepGap;
        }
        gameContext.fillStyle = ink;
        gameContext.globalAlpha = 0.62 * fade;
        gameContext.font = labelFont;
        gameContext.strokeText(segs[k].label, cx, cy);
        gameContext.fillText(segs[k].label, cx, cy);
        gameContext.globalAlpha = fade;
        gameContext.font = valueFont;
        gameContext.strokeText(segs[k].value, cx + segs[k].lw + labelGap, cy);
        gameContext.fillText(segs[k].value, cx + segs[k].lw + labelGap, cy);
        cx += segs[k].w;
    }
    gameContext.restore();
}

function drawVirtualButtons() {
    if (virtualButtonList == null) {
        return;
    }
    for (var i = 0; i < virtualButtonList.length; i++) {
        var bound = virtualButtonList[i].bound;
        if (bound.render == true) {
            gameContext.save();
            gameContext.beginPath();
            gameContext.strokeStyle = "rgba(255, 0, 0, 1)";
            gameContext.rect(bound.x, bound.y, bound.width, bound.height);
            gameContext.stroke();
            gameContext.restore();
        }
    }
}

function drawTouchControls(ctx) {
    if (isTouchScreen == false) {
        return;
    }
    // Draw on the OVERLAY canvas (top layer) by default so the controls sit ABOVE
    // everything the game draws — including the blackout brutal round, which fills
    // the overlay with darkness. The control UI must never be hidden by a gameplay
    // effect. (Both canvases share the same transform; see applyCanvasTransform.)
    ctx = ctx || overlayContext;

    var exitToUse = exitIcon;
    var fullScreenToUse = fullscreenIcon;
    var chatToUse = commentIconSolid;

    // The default icons are dark (no SVG fill = black) and vanish on the dark
    // overview background or the dark-theme canvas surface, so swap in the white
    // PNG variants for both of those cases.
    var useWhiteIcons = currentState == config.stateMap.overview ||
        (typeof document !== 'undefined' &&
            document.documentElement.getAttribute('data-theme') === 'dark');
    if (useWhiteIcons) {
        exitToUse = exitIconWhite;
        fullScreenToUse = fullscreenIconWhite;
        chatToUse = commentIconWhite;
    }


    // When the tactile DOM HUD (hudOverlay.js) is active it paints the joystick
    // and attack button itself, so skip the canvas rings to avoid double-drawing.
    // The corner emoji/fullscreen icons stay canvas-drawn either way.
    var domHud = (typeof window !== 'undefined' && window.__touchHudDom === true);

    if (!domHud && joystickMovement != null && joystickMovement.isVisible()) {
        ctx.save();
        ctx.beginPath();
        ctx.lineWidth = 3;
        ctx.strokeStyle = themeColor('ink', 'black');
        ctx.arc(joystickMovement.baseX, joystickMovement.baseY, joystickMovement.baseRadius, 0, Math.PI * 2, false);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(joystickMovement.baseX, joystickMovement.baseY, joystickMovement.stickRadius, 0, Math.PI * 2, false);
        ctx.stroke();


        ctx.beginPath();
        ctx.arc(joystickMovement.stickX, joystickMovement.stickY, joystickMovement.stickRadius, 0, Math.PI * 2, true);
        ctx.fillStyle = "rgba(255, 0, 0, 0.2)";
        ctx.fill();
        ctx.stroke();
        ctx.restore();
        drawTouchLabel("Move", joystickMovement.baseX, joystickMovement.baseY + joystickMovement.baseRadius + 20, ctx);
    }
    if (joystickCamera != null && joystickCamera.isVisible()) {
        ctx.save();

        ctx.beginPath();
        ctx.lineWidth = 3;
        ctx.strokeStyle = themeColor('ink', 'black');
        ctx.arc(joystickCamera.baseX, joystickCamera.baseY, joystickCamera.baseRadius, 0, Math.PI * 2, false);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(joystickCamera.baseX, joystickCamera.baseY, joystickCamera.stickRadius, 0, Math.PI * 2, false);
        ctx.stroke();

        ctx.beginPath();
        ctx.fillStyle = "rgba(0, 255, 0, 0.2)";
        ctx.arc(joystickCamera.stickX, joystickCamera.stickY, joystickCamera.stickRadius, 0, Math.PI * 2, true);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }
    if (!domHud && attackButton != null && attackButton.isVisible()) {
        ctx.save();
        ctx.beginPath();
        ctx.lineWidth = 3;
        ctx.strokeStyle = themeColor('ink', 'black');
        // Punch-red so it reads as the attack control (mirrors the move ring on
        // the left); brighten the fill while held for tap/charge feedback.
        ctx.fillStyle = attackButton.pressed ? "rgba(255, 72, 56, 0.5)" : "rgba(255, 72, 56, 0.26)";
        ctx.arc(attackButton.baseX, attackButton.baseY, attackButton.radius, 0, Math.PI * 2, false);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
        drawTouchLabel("Attack", attackButton.baseX, attackButton.baseY + attackButton.radius + 20, ctx);
    }
    if (exitButton != null && exitButton.isVisible() && fullscreenSupported()) {
        var exitSize = exitButton.iconSize || 34;
        if (window.document.fullscreenElement) {
            ctx.save();
            ctx.drawImage(exitToUse, exitButton.baseX - exitSize / 2, exitButton.baseY - exitSize / 2, exitSize, exitSize);
            ctx.restore();
        } else {
            ctx.save();
            ctx.drawImage(fullScreenToUse, exitButton.baseX - exitSize / 2, exitButton.baseY - exitSize / 2, exitSize, exitSize);
            ctx.restore();
        }
        drawTouchLabel(window.document.fullscreenElement ? "Exit" : "Fullscreen", exitButton.baseX, exitButton.baseY + exitSize / 2 + 16, ctx);
        var exHit = exitButton.radius || exitSize / 2;
        hudProbeRect("touchExit", exitButton.baseX - exHit, exitButton.baseY - exHit, exHit * 2, exHit * 2);
    }
    if (chatButton != null && chatButton.isVisible()) {
        var chatSize = chatButton.iconSize || 34;
        ctx.save();
        ctx.drawImage(chatToUse, chatButton.baseX - chatSize / 2, chatButton.baseY - chatSize / 2, chatSize, chatSize);
        ctx.restore();
        drawTouchLabel("Emoji", chatButton.baseX, chatButton.baseY + chatSize / 2 + 16, ctx);
        var chHit = chatButton.radius || chatSize / 2;
        hudProbeRect("touchEmoji", chatButton.baseX - chHit, chatButton.baseY - chHit, chHit * 2, chHit * 2);
    }
}

// Surface the otherwise-invisible double-click "mouse-drive" mode so players can
// tell it's on (and how to toggle it). Desktop/mouse only (item 8).
function drawMouseDriveIndicator() {
    if (typeof movingByMouse === "undefined" || !movingByMouse || isTouchScreen) {
        return;
    }
    gameContext.save();
    gameContext.font = "bold 15px Arial";
    gameContext.textAlign = "center";
    gameContext.lineWidth = 4;
    // Theme-aware halo so the pink label reads on the dark board too.
    gameContext.strokeStyle = themeColor('inkOutline', 'white');
    gameContext.fillStyle = "#c87f8a";
    var label = "Mouse-drive ON — double-click to toggle";
    gameContext.strokeText(label, LOGICAL_WIDTH / 2, 44);
    gameContext.fillText(label, LOGICAL_WIDTH / 2, 44);
    gameContext.restore();
}

// Small caption under a touch control so mobile players know what it does.
function drawTouchLabel(text, x, y, ctx) {
    ctx = ctx || overlayContext;
    ctx.save();
    // The 1366x768 logical space is scaled down a lot on a phone, so a fixed
    // 16px label would render only a few CSS px tall. Size up as the fit ratio
    // shrinks to hold a roughly constant physical size (~15 CSS px), clamped so
    // it never goes below the original 16px or balloons on large displays.
    var fontPx = Math.round(Math.max(16, Math.min(40, 15 / (fitRatio || 1))));
    ctx.font = "bold " + fontPx + "px Arial";
    ctx.textAlign = "center";
    ctx.lineWidth = 4;
    // Theme-aware so the captions read correctly on the dark board too (matches
    // the rest of the renderer + the adjacent touch-control rings).
    ctx.strokeStyle = themeColor('inkOutline', 'white');
    ctx.fillStyle = themeColor('ink', 'black');
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
    ctx.restore();
}

function drawTitle() {

    if (brutalRound == true) {
        // Time-based entrance (so it plays the same on any refresh rate):
        // a quick scale-in with a little overshoot, a hold, then a fade. A
        // single red screen flash fires the moment the card appears.
        if (brutalRoundConfig.titleStart == null) {
            brutalRoundConfig.titleStart = Date.now();
            spawnScreenFlash("red", 0.4, 350);
        }
        var e = Date.now() - brutalRoundConfig.titleStart;
        var inMs = 350, holdMs = 2200, outMs = 1500;
        if (e <= inMs + holdMs + outMs) {
            var alpha, scale;
            if (e < inMs) {
                var ip = e / inMs;
                scale = lerp(0.4, 1, easeOutBack(ip));
                alpha = clamp01(ip);
            } else if (e < inMs + holdMs) {
                scale = 1;
                alpha = 1;
            } else {
                var fp = (e - inMs - holdMs) / outMs;
                scale = 1 + 0.06 * fp;
                alpha = clamp01(1 - fp);
            }
            gameContext.save();
            gameContext.textAlign = "center";
            // HUD/screen pass: anchor in logical space so it stays centered and
            // crisp at any DPR (this runs after applyCanvasTransform, not under
            // the world camera zoom/pan).
            gameContext.translate(LOGICAL_WIDTH / 2, LOGICAL_HEIGHT / 2 - 10);
            gameContext.scale(scale, scale);
            gameContext.strokeStyle = "rgba(255, 255, 255, " + alpha + ")";
            gameContext.lineWidth = 10;
            gameContext.fillStyle = "rgba(255, 0, 0, " + alpha + ")";
            gameContext.font = "50px Arial";
            gameContext.strokeText('Brutal Round', 0, 0);
            gameContext.fillText('Brutal Round', 0, 0);
            var titleRows = [];
            for (var i = 0; i < brutalRoundConfig.brutalTypes.length; i++) {
                for (var prop in config.brutalRounds) {
                    if (config.brutalRounds[prop].id == brutalRoundConfig.brutalTypes[i]) {
                        titleRows.push({ title: config.brutalRounds[prop].title, id: brutalRoundConfig.brutalTypes[i] });
                    }
                }
            }
            gameContext.font = "30px Arial";
            for (var j = 0; j < titleRows.length; j++) {
                var ty = 40 + (35 * j);
                gameContext.strokeText(titleRows[j].title, 0, ty);
                gameContext.fillText(titleRows[j].title, 0, ty);
                // Mode icon hugging the left edge of the title text — same iconography as
                // the recap badges + the persistent corner badge — fading with the card.
                var tImg = brutalRoundImages[titleRows[j].id];
                if (tImg != null && tImg.complete !== false && (tImg.naturalWidth == null || tImg.naturalWidth > 0)) {
                    var tw = gameContext.measureText(titleRows[j].title).width;
                    var iratio = (tImg.width && tImg.height) ? (tImg.height / tImg.width) : 0.88;
                    var iw2 = 30, ih2 = 30 * iratio;
                    var ix2 = -tw / 2 - 12 - iw2;
                    var iy2 = ty - 14 - ih2 / 2;
                    gameContext.save();
                    gameContext.globalAlpha = alpha;
                    gameContext.fillStyle = "rgba(255,255,255,0.85)";
                    gameContext.fillRect(ix2 - 3, iy2 - 3, iw2 + 6, ih2 + 6);
                    gameContext.strokeStyle = "rgba(0,0,0,0.55)";
                    gameContext.lineWidth = 1.5;
                    gameContext.strokeRect(ix2 - 3, iy2 - 3, iw2 + 6, ih2 + 6);
                    try { gameContext.drawImage(tImg, ix2, iy2, iw2, ih2); } catch (e) { /* icon not decoded — tile still flags it */ }
                    gameContext.restore();
                }
            }
            gameContext.restore();
        }
    }
    if (currentState == config.stateMap.waiting && lobbyStartButton == null) {
        // Properly-centred pill in the shared HUD chrome, with a slow animated
        // ellipsis so the screen reads "alive" while waiting. The panel is sized
        // for the full three dots so it never resizes as they cycle.
        var wMsg = "Waiting for more players";
        var dots = new Array((Math.floor(Date.now() / 450) % 3) + 2).join(".");
        var wFont = "bold 20px sans-serif";
        var wPadX = 24, wH = 44;
        gameContext.save();
        gameContext.font = wFont;
        var wTextW = gameContext.measureText(wMsg + "...").width;
        var wW = wTextW + wPadX * 2;
        var wX = (LOGICAL_WIDTH - wW) / 2;
        var wY = LOGICAL_HEIGHT / 2 - 60;
        drawHudPanel(wX, wY, wW, wH, null);
        gameContext.fillStyle = themeColor('ink', 'black');
        gameContext.textAlign = "left";
        gameContext.textBaseline = "middle";
        gameContext.fillText(wMsg + dots, wX + wPadX, wY + wH / 2 + 1);
        gameContext.restore();
    }
}

// ============================================================================
// OVERVIEW PAGE LAYOUT (between-rounds standings screen)
// ----------------------------------------------------------------------------
// A structured, panelled page rather than elements floating on black:
//   • Standings hero panel  — left ~62%, the racing tracks (karts ride the line)
//   • Right rail            — Next-map preview (top) + Times-to-beat (bottom)
//   • Rating strip          — full-width bottom panel
//   • GameID strip + WR toast at the top
// House style: borderless sections — content breathes on black under a small gold
// label; gold accent (OV.gold) for headings/highlights. headerH reserves the label band.
// ============================================================================
var OV = {
    gold: "#FFCB30",
    margin: 30,
    gap: 16,
    railW: 440,
    ratingH: 84,
    headerH: 34
};

// A section heading: a small gold label at the top-left of its region. No box, border,
// fill, or header band — structure comes from layout position + the label alone. Callers
// own their region rect; this only needs the label's anchor. headerH reserves the band.
function ovLabel(x, y, title) {
    if (!title) { return; }
    gameContext.save();
    gameContext.fillStyle = OV.gold;
    gameContext.font = "bold 13px Arial";
    gameContext.textAlign = "left";
    gameContext.textBaseline = "middle";
    gameContext.fillText(title.toUpperCase(), x + 6, y + OV.headerH / 2 + 1);
    gameContext.restore();
}

// Compute the page regions once per frame. Everything keys off these rects so the
// panels never overlap and the standings know exactly how much room they own.
function computeOverviewPage() {
    var wrActive = overviewWorldRecordActive();
    var topY = wrActive ? 108 : 52;       // drop below the WR toast while it shows
    var m = OV.margin, gap = OV.gap;
    var contentBottom = (LOGICAL_HEIGHT - 50) - OV.ratingH - gap; // clear controls + rating
    var railW = OV.railW;
    var leftW = LOGICAL_WIDTH - 2 * m - railW - gap;
    return {
        topY: topY, gap: gap, margin: m,
        standings: { x: m, y: topY, w: leftW, h: contentBottom - topY },
        railX: m + leftW + gap, railW: railW,
        contentBottom: contentBottom,
        rating: { x: m, y: contentBottom + gap, w: LOGICAL_WIDTH - 2 * m, h: OV.ratingH }
    };
}

// True while the "New world record" toast is on screen, so the standings band can
// drop below it. Mirrors drawWorldRecordBanner's own start/duration guard.
function overviewWorldRecordActive() {
    if (typeof worldRecordBanner === "undefined" || worldRecordBanner == null) { return false; }
    if (typeof worldRecordBanner.startedAt !== "number") { return false; }
    return (Date.now() - worldRecordBanner.startedAt) < WORLD_RECORD_BANNER_DURATION_MS;
}

function drawOverviewBoard() {
    drawBlackBackground();
    var page = computeOverviewPage();
    // Compute the per-frame geometry ONCE and hang it on `page` so every consumer
    // reuses it instead of recomputing (the standings sort + the rail split both used
    // to run twice per frame). All overview renderers read page.geom / page.rail.
    page.geom = computeStandingsRowGeom(page);
    page.rail = overviewRailRects(page);
    // Teams modes: the per-player notch track can't decide a team match, so the
    // standings band shows the two team score panels instead (totals + an itemized
    // "where this round's points came from" ledger).
    if (typeof teamInfo !== "undefined" && teamInfo != null) {
        drawTeamStandingsPanel(page);
    } else {
        drawStandingsPanel(page);
    }
    drawNextMap(page);
    drawMapLeaderboardCard(page);
    // Late-arriving PB floats — the last finisher's playerPbResult lands AFTER
    // startOverview because the server's per-finish upsert + rank lookup are async.
    // The world-space drawRecordFloats in the race pass never sees them; this
    // overview-context render catches them anchored to standings rows.
    drawRecordFloatsOverview(page);
    drawHUD(); // GameID strip + WR toast (race-only widgets early-return on overview)
    // Full-width "Rate this map" strip along the bottom. Guarded so a render error
    // can't break the overview.
    try {
        drawOverviewRating(page);
    } catch (e) {
        debugLog("rating draw error", e);
    }
}

// Bottom rating strip — spans the page width above the controls legend.
function drawOverviewRating(page) {
    if (typeof ratingMapId === "undefined" || ratingMapId == null) {
        ratingStarHits = [];
        return;
    }
    drawMapRating(LOGICAL_WIDTH / 2, page.rating.y + page.rating.h, page.rating.w);
}

// Trim `text` with a trailing "…" until it fits maxW under the CURRENT gameContext font.
// Shared by the overview name columns (standings + times-to-beat) so the ellipsis-fit
// loop lives in one place. Returns the original string when it already fits.
function fitWithEllipsis(text, maxW) {
    if (text == null) { return ""; }
    if (gameContext.measureText(text).width <= maxW) { return text; }
    var t = text;
    while (t.length > 1 && gameContext.measureText(t + "…").width > maxW) { t = t.slice(0, -1); }
    return t + "…";
}

// Format an elapsed-race time (milliseconds) as "m:ss.SS" — minutes are only
// shown when >0 so a typical sub-minute finish reads as "32.17".
function formatRaceTime(ms) {
    if (!Number.isFinite(ms) || ms < 0) { return "—"; }
    var totalCs = Math.floor(ms / 10);
    var cs = totalCs % 100;
    var s = Math.floor(totalCs / 100) % 60;
    var m = Math.floor(totalCs / 6000);
    var csStr = (cs < 10 ? "0" : "") + cs;
    var sStr = (s < 10 ? "0" : "") + s;
    return (m > 0 ? (m + ":" + sStr) : sStr) + "." + csStr;
}

// Vertical split of the right rail into the Next-map panel (top) and the
// Times-to-beat panel (bottom). Shared so both draw consistently and the rating
// avoidance / record floats can reason about the rail.
function overviewRailRects(page) {
    var x = page.railX, w = page.railW, top = page.standings.y;
    // Preview tile aspect ~0.56; panel = header + tile + title/author block.
    var tileW = w - 32;
    var tileH = Math.round(tileW * 0.56);
    var previewH = OV.headerH + 12 + tileH + 58;
    var timesY = top + previewH + page.gap;
    return {
        preview: { x: x, y: top, w: w, h: previewH, tileW: tileW, tileH: tileH },
        times: { x: x, y: timesY, w: w, h: page.contentBottom - timesY }
    };
}

function drawNextMap(page) {
    if (page == null) { return; }
    var rail = page.rail || overviewRailRects(page);
    var r = rail.preview;
    ovLabel(r.x, r.y, "Next Map");
    if (nextMapPreview == null) {
        gameContext.save();
        gameContext.fillStyle = "rgba(255,255,255,0.5)";
        gameContext.font = "italic 16px Arial"; gameContext.textAlign = "left"; gameContext.textBaseline = "middle";
        gameContext.fillText("Picking the next map…", r.x + 16, r.y + r.h / 2);
        gameContext.restore();
        return;
    }
    var thX = r.x + 6, thY = r.y + OV.headerH + 10;
    gameContext.save();
    // big preview tile — the thumbnail is the visual; rounded-clipped, no frame.
    if (nextMapThumbnail != null) {
        try {
            gameContext.save();
            drawRoundRectPath(thX, thY, r.tileW, r.tileH, 10);
            gameContext.clip();
            gameContext.drawImage(nextMapThumbnail, thX, thY, r.tileW, r.tileH);
            gameContext.restore();
        } catch (e) { /* thumbnail not ready — faint placeholder below */ }
    } else {
        // No image yet: a faint rounded placeholder so the space reads as the preview.
        gameContext.fillStyle = "rgba(255,255,255,0.05)";
        drawRoundRectPath(thX, thY, r.tileW, r.tileH, 10);
        gameContext.fill();
    }
    // title + author below the tile
    gameContext.fillStyle = "#fff"; gameContext.font = "bold 22px Arial";
    gameContext.textAlign = "left"; gameContext.textBaseline = "alphabetic";
    gameContext.fillText(nextMapPreview.name || "—", thX, thY + r.tileH + 28);
    if (nextMapPreview.author) {
        gameContext.fillStyle = "rgba(255,255,255,0.6)"; gameContext.font = "14px Arial";
        gameContext.fillText("by " + nextMapPreview.author, thX, thY + r.tileH + 48);
    }
    gameContext.restore();
}

// "Times to beat for <next map>" — right-rail panel below the next-map preview.
// Global top-10 PB times for the upcoming map; top-3 gold. "New map!" placeholder
// when empty. Row pitch shrinks to fit the panel height.
function drawMapLeaderboardCard(page) {
    if (page == null || mapLeaderboardData == null) { return; }
    var rail = page.rail || overviewRailRects(page);
    var r = rail.times;
    ovLabel(r.x, r.y, "Times to Beat");
    var allRows = mapLeaderboardData.rows || [];
    var bodyTop = r.y + OV.headerH + 10;

    gameContext.save();
    gameContext.textBaseline = "alphabetic";
    if (allRows.length === 0) {
        gameContext.font = "italic 15px Arial";
        gameContext.fillStyle = "#9b5";
        gameContext.textAlign = "left";
        gameContext.fillText("New map — be the first!", r.x + 6, bodyTop + 22);
        gameContext.restore();
        return;
    }

    // Fit rows at a legible pitch. Rather than crushing all 10 into a too-short panel
    // (which floored the font ABOVE the row pitch, so lines overlapped), cap the count to
    // what fits at a readable MIN_ROW_H and note the truncation. avail can never go
    // negative here because overviewRailRects keeps times.h >= 0 on the fixed canvas.
    var avail = Math.max(0, (r.y + r.h - 12) - bodyTop);
    var MIN_ROW_H = 18;
    var maxRows = Math.max(1, Math.floor(avail / MIN_ROW_H));
    var truncated = allRows.length > maxRows;
    var rows = truncated ? allRows.slice(0, maxRows - 1) : allRows; // leave a line for "+N more"
    var shown = rows.length + (truncated ? 1 : 0);
    var rowH = Math.min(26, avail / shown);
    var rowFontPx = Math.max(11, Math.min(15, Math.round(rowH - 9)));
    var rankColX = r.x + 6, nameColX = r.x + 40, timeColX = r.x + r.w - 4;
    var maxNameW = (timeColX - nameColX) - 70;
    for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var ty = bodyTop + i * rowH + rowH * 0.72;
        var isYou = (row.playerId === myID);
        gameContext.font = "bold " + rowFontPx + "px Arial";
        gameContext.textAlign = "left";
        gameContext.fillStyle = (i < 3) ? OV.gold : "rgba(255,255,255,0.5)";
        gameContext.fillText("#" + row.rank, rankColX, ty);
        var label = (row.displayName || "Anon") + (isYou ? " (YOU)" : "");
        gameContext.fillStyle = "#fff";
        gameContext.font = (isYou ? "bold " : "") + rowFontPx + "px Arial";
        gameContext.fillText(fitWithEllipsis(label, maxNameW), nameColX, ty);
        gameContext.textAlign = "right";
        gameContext.fillText(formatRaceTime(row.bestMs), timeColX, ty);
    }
    // "+N more" footer when the panel couldn't show the whole top-10.
    if (truncated) {
        var moreTy = bodyTop + rows.length * rowH + rowH * 0.72;
        gameContext.font = "italic " + rowFontPx + "px Arial";
        gameContext.fillStyle = "rgba(255,255,255,0.4)";
        gameContext.textAlign = "left";
        gameContext.fillText("+" + (allRows.length - rows.length) + " more", rankColX, moreTy);
    }
    gameContext.restore();
}
function drawBlackBackground() {
    gameContext.save();
    gameContext.beginPath();
    gameContext.fillStyle = "black";
    gameContext.rect(world.x, world.y, world.width, world.height);
    gameContext.fill();
    gameContext.restore();
}
// ---- STANDINGS HERO PANEL --------------------------------------------------
// The racing tracks, now inside a panel. Each row: rank badge · kart-on-line
// track (kart rides at its score position, full cosmetics + tail) · score.
// Auto 1/2 columns; rows GROW to fill the panel at low player counts.
// Shared standings geometry: ordered player ids + a per-index row box {x,y,w,h}.
// Both the panel renderer and the record-float overlay key off this so a float
// always lands on its player's row at any column/scale.
function computeStandingsRowGeom(page) {
    var r = page.standings;
    // Order by standing (notches desc) so the numeric rank badges and row order match
    // the actual leaderboard, not playerList insertion (join) order. Decorate-sort with
    // the original index as a stable tiebreak so equal-score rows keep a deterministic,
    // flicker-free order frame to frame.
    var deco = [];
    var k = 0;
    for (var pid in playerList) {
        var pl = playerList[pid];
        deco.push({ id: pid, notches: (pl && typeof pl.notches === "number") ? pl.notches : 0, ord: k++ });
    }
    deco.sort(function (a, b) { return (b.notches - a.notches) || (a.ord - b.ord); });
    var ids = deco.map(function (d) { return d.id; });
    var count = ids.length;
    var inX = r.x + 12, inY = r.y + OV.headerH + 6;
    var inW = r.w - 24, inH = r.h - OV.headerH - 14;
    var cols = count <= 11 ? 1 : 2;
    var perCol = Math.max(1, Math.ceil(count / cols));
    var colW = inW / cols;
    var rowH = Math.min(64, inH / perCol);
    var usedH = perCol * rowH;
    var padTop = Math.max(0, (inH - usedH) / 2);
    return {
        ids: ids, count: count, cols: cols, perCol: perCol, colW: colW, rowH: rowH,
        inX: inX, inY: inY, padTop: padTop,
        box: function (i) {
            var col = Math.floor(i / perCol), row = i % perCol;
            return {
                x: inX + col * colW,
                y: inY + padTop + row * rowH,
                w: colW - (cols > 1 ? 12 : 0),
                h: rowH
            };
        }
    };
}

// ---- Teams overview ---------------------------------------------------------
// The medal-card-style round summary for team modes: one panel per team showing
// the TOTAL points pool (vs the target) and an itemized list of where THIS
// round's points came from (teamRoundLedger, fed by the live teamPointsDelta
// events). Podium finishes name the racer; kills name the killer (up to 3, then
// roll up); finishes and deaths aggregate into one line each.
function teamLedgerLines(teamId) {
    var lines = [];
    var kills = [], finishes = 0, finishPts = 0, deaths = 0, deathPts = 0, orbs = 0, orbPts = 0;
    for (var i = 0; i < teamRoundLedger.length; i++) {
        var e = teamRoundLedger[i];
        if (e.teamId !== teamId) { continue; }
        if (e.reason === "first") { lines.push({ icon: "🏁", text: "First place — " + e.label, pts: e.amount }); }
        else if (e.reason === "second") { lines.push({ icon: "🥈", text: "Second place — " + e.label, pts: e.amount }); }
        else if (e.reason === "kill") { kills.push(e); }
        else if (e.reason === "finish") { finishes++; finishPts += e.amount; }
        else if (e.reason === "death") { deaths++; deathPts += e.amount; }
        else if (e.reason === "bonus_orb") { orbs++; orbPts += e.amount; }
        else { lines.push({ icon: "•", text: e.label, pts: e.amount }); }
    }
    for (var k = 0; k < kills.length && k < 3; k++) {
        lines.push({ icon: "⚔️", text: "KO — " + kills[k].label, pts: kills[k].amount });
    }
    if (kills.length > 3) {
        var extra = 0;
        for (var x = 3; x < kills.length; x++) { extra += kills[x].amount; }
        lines.push({ icon: "⚔️", text: "KOs ×" + (kills.length - 3) + " more", pts: extra });
    }
    if (finishes > 0) { lines.push({ icon: "🏳️", text: "Finished ×" + finishes, pts: finishPts }); }
    if (orbs > 0) { lines.push({ icon: "🔆", text: "Bonus orbs ×" + orbs, pts: orbPts }); }
    if (deaths > 0) { lines.push({ icon: "💀", text: "Deaths ×" + deaths, pts: deathPts }); }
    return lines;
}
function drawTeamStandingsPanel(page) {
    var r = page.standings;
    ovLabel(r.x, r.y, "Team Scores");
    var defs = (teamInfo && Array.isArray(teamInfo.defs) && teamInfo.defs.length >= 2) ? teamInfo.defs : null;
    if (defs == null) { return; }
    var top = r.y + OV.headerH;
    var h = r.h - OV.headerH;
    var gap = 14;
    var pw = (r.w - gap) / 2;
    for (var t = 0; t < 2; t++) {
        var def = defs[t];
        var px = r.x + t * (pw + gap);
        var total = (teamInfo.score && teamInfo.score[def.id] != null) ? teamInfo.score[def.id] : 0;
        var lines = teamLedgerLines(def.id);
        var net = 0;
        for (var n = 0; n < lines.length; n++) { net += lines[n].pts; }
        gameContext.save();
        // Panel: dark card with the team-colour border (the overview's row chrome).
        gameContext.fillStyle = "rgba(20,23,30,0.92)";
        drawRoundRectPath(px, top, pw, h, 12);
        gameContext.fill();
        gameContext.lineWidth = 2.5;
        gameContext.strokeStyle = def.color;
        gameContext.stroke();
        // Header: team name left, big total right ("23 / 60").
        gameContext.textBaseline = "middle";
        gameContext.textAlign = "left";
        gameContext.fillStyle = def.color;
        gameContext.font = "bold 24px Arial";
        gameContext.fillText(def.name, px + 18, top + 28);
        gameContext.textAlign = "right";
        gameContext.font = "bold 26px Arial";
        var totalStr = String(total) + ((teamInfo.target != null) ? ("  /" + teamInfo.target) : "");
        gameContext.fillText(totalStr, px + pw - 18, top + 28);
        // Round net under the header, signed and tinted by direction.
        gameContext.textAlign = "left";
        gameContext.font = "bold 14px Arial";
        gameContext.fillStyle = net > 0 ? "#7fe3a0" : (net < 0 ? "#ff7a7a" : "#9aa5b1");
        gameContext.fillText("this round: " + (net > 0 ? "+" : "") + net, px + 18, top + 52);
        // Divider.
        gameContext.strokeStyle = "rgba(255,255,255,0.14)";
        gameContext.lineWidth = 1;
        gameContext.beginPath();
        gameContext.moveTo(px + 14, top + 64);
        gameContext.lineTo(px + pw - 14, top + 64);
        gameContext.stroke();
        // Itemized lines (bounded by the panel height; the bottom band is reserved
        // for the member roster strip).
        var rowH = 26;
        var rosterH = 46;
        var maxRows = Math.max(1, Math.floor((h - 78 - rosterH) / rowH));
        var shown = Math.min(lines.length, maxRows);
        for (var li = 0; li < shown; li++) {
            var line = lines[li];
            var ly = top + 78 + li * rowH + rowH / 2;
            // A truncated list rolls its tail into the final visible row.
            if (li === maxRows - 1 && lines.length > maxRows) {
                var rest = 0;
                for (var ri = li; ri < lines.length; ri++) { rest += lines[ri].pts; }
                line = { icon: "…", text: "+" + (lines.length - li) + " more events", pts: rest };
            }
            gameContext.font = "16px Arial";
            gameContext.textAlign = "left";
            gameContext.fillStyle = "#e8edf2";
            gameContext.fillText(line.icon + "  " + line.text, px + 18, ly);
            gameContext.textAlign = "right";
            gameContext.font = "bold 16px Arial";
            gameContext.fillStyle = line.pts >= 0 ? "#7fe3a0" : "#ff7a7a";
            gameContext.fillText((line.pts > 0 ? "+" : "") + line.pts, px + pw - 18, ly);
        }
        if (lines.length === 0) {
            gameContext.font = "italic 15px Arial";
            gameContext.textAlign = "center";
            gameContext.fillStyle = "#8b95a1";
            gameContext.fillText("no scoring this round", px + pw / 2, top + 78 + rowH / 2);
        }
        // Member roster strip along the panel bottom: every kart on the team with
        // full cosmetics, and — crucially — their between-round chat emotes, which
        // in FFA render on the standings rows this panel replaces. Same reposition
        // trick as drawStandingsRow: drawEmoji anchors at player.x/y.
        var members = [];
        for (var pid in playerList) {
            if (playerList[pid] != null && playerList[pid].teamId === def.id) { members.push(playerList[pid]); }
        }
        var slotW = 34;
        var maxFit = Math.max(1, Math.floor((pw - 36) / slotW));
        var shownMembers = Math.min(members.length, maxFit);
        var ry = top + h - rosterH / 2 - 4;
        var rx0 = px + pw / 2 - ((shownMembers - 1) * slotW) / 2;
        for (var mi = 0; mi < shownMembers; mi++) {
            var member = members[mi];
            var mx = rx0 + mi * slotW;
            drawOverviewKart(member, mx, ry, 11);
            if (member.chatMessage != null) {
                var msx = member.x, msy = member.y;
                member.x = mx; member.y = ry - 8;
                drawEmoji(member);
                member.x = msx; member.y = msy;
            }
        }
        if (members.length > shownMembers) {
            gameContext.font = "bold 12px Arial";
            gameContext.textAlign = "left";
            gameContext.fillStyle = "#9aa5b1";
            gameContext.fillText("+" + (members.length - shownMembers), rx0 + shownMembers * slotW - 10, ry + 4);
        }
        gameContext.restore();
    }
}

function drawStandingsPanel(page) {
    var r = page.standings;
    ovLabel(r.x, r.y, "Round Standings");
    var g = page.geom || computeStandingsRowGeom(page);
    if (g.count === 0) { return; }

    for (var i = 0; i < g.count; i++) {
        var id = g.ids[i];
        // Preserve the sequential notch-slide cascade: the first not-yet-animated
        // player becomes the animator; it hands off when its slide completes.
        if (playerAnimating == null) { playerAnimating = id; }
        var b = g.box(i);
        drawStandingsRow(playerList[id], i, b.x, b.y, b.w, b.h);
    }
}

// Step a player's notch-slide animation one frame and return the current animated
// progress as a 0..1 fraction of the full track. Same stepping + hand-off logic as
// the legacy drawPlayerIcon, just decoupled from a fixed pixel pitch so the kart can
// ride a track of any width at a constant on-screen size.
function overviewAnimStep(player) {
    var unit = notchDistanceApart || 75;
    var gl = gameLength || (config && config.baseNotchesToWin) || 5;
    var notchX, moveAmt = 0;
    if (player.distanceToMove > 0) {
        moveAmt = 2; notchX = player.distanceTraveled + (oldNotches[player.id] * unit);
    } else if (player.distanceToMove < 0) {
        moveAmt = -2; notchX = player.distanceTraveled + (oldNotches[player.id] * unit);
    } else {
        notchX = player.notches * unit; playerAnimating = null;
    }
    if (playerAnimating === player.id) {
        if (player.distanceToMove - moveAmt < 0 && player.distanceToMove + moveAmt > 0) {
            player.distanceToMove = 0;
        } else {
            player.distanceToMove -= moveAmt;
            player.distanceTraveled += moveAmt;
        }
    }
    player.x = notchX; player.y = 0;
    // Track spans gl+1 segments, NOT gl: reaching gameLength notches is "near victory",
    // not a win — the match only ends when a player wins ANOTHER round while already at the
    // cap. So a kart at gameLength sits one segment SHORT of the goal flag (the decisive
    // final step), matching the legacy goal post reserved at (gameLength+1)*distanceApart.
    return Math.max(0, Math.min(1, notchX / ((gl + 1) * unit)));
}

// nearVictory transitions + their sounds, preserved from the legacy drawGoalPost.
function overviewVictoryState(player) {
    // Teams modes: personal notches parking at the cap means nothing — the team
    // POOL is the victory signal, and its one-shot sting fires from applyTeamUpdate
    // the moment a pool reaches the target. Suppress the per-player cues here so a
    // personally-capped kart doesn't false-alarm the room.
    if (typeof teamInfo !== "undefined" && teamInfo != null) { return; }
    var gl = gameLength || (config && config.baseNotchesToWin) || 5;
    if (player.distanceToMove == 0 && playerAnimating !== player.id) {
        if (player.notches == gl && player.nearVictory == false) {
            player.nearVictory = true;
            playSound(nearVictorySound);
        }
    }
    if (player.distanceToMove != 0 && playerAnimating === player.id) {
        if (oldNotches[player.id] == gl && player.notches != gl && player.nearVictory == true) {
            player.nearVictory = false;
            playSound(fallFromVictorySound);
        }
    }
}

// Row label + "is this one of MY karts" for the standings. In single-player the local
// kart reads "You"; in couch co-op there are up to four local seats sharing the screen,
// so each gets its seat identity — the primary stays "You" and the others read "P2".."P4"
// (slot+1, matching the gamepad HUD), so every player can find their own row. A bot /
// avatar-skin name is used when present; everyone else is nameless (kart colour = id).
function overviewSeatLabel(player) {
    // Ownership ("is this one of MY karts") delegates to the canonical isLocalId so the
    // standings agree with every other render path (kart dimming, halos) — including its
    // loose == handling of a number-vs-string id across the socket boundary.
    var local = (typeof isLocalId === "function") ? isLocalId(player.id) : (player.id === myID);
    if (!local) {
        return { label: (player.name != null ? player.name : ""), local: false };
    }
    // Local: derive the seat tag. Single joined seat → "You"; couch co-op → primary stays
    // "You", the others read "P2".."P4" (slot+1, matching the gamepad HUD).
    if (typeof localPlayers !== "undefined" && localPlayers) {
        var slot = -1, joinedCount = 0;
        for (var s = 0; s < localPlayers.length; s++) {
            var lp = localPlayers[s];
            if (!lp) { continue; }
            if (lp.joined) { joinedCount++; }
            if (lp.myID == player.id) { slot = s; } // == to match isLocalId's loose compare
        }
        var isPrimary = (typeof primarySlot === "number") ? (slot === primarySlot) : (slot === 0);
        if (slot >= 0 && joinedCount > 1 && !isPrimary) {
            return { label: "P" + (slot + 1), local: true };
        }
    }
    return { label: "You", local: true };
}

// One standings row. px,py = row top-left; pw,rh = row box.
function drawStandingsRow(player, idx, px, py, pw, rh) {
    var cy = py + rh / 2;
    var gl = gameLength || (config && config.baseNotchesToWin) || 5;
    var seat = overviewSeatLabel(player);
    var isYou = seat.local;

    // Step the slide FIRST, then run the victory-state check — overviewAnimStep clears
    // playerAnimating to null on the frame a slide settles, which is exactly what
    // overviewVictoryState's `playerAnimating !== player.id` guard needs to fire the
    // near-victory / fall sounds. Running the check first (as before) left the guard
    // permanently false for a leader that the panel had just assigned as the animator,
    // so the audio cues never played. Matches the legacy step-then-goalpost order.
    var frac = overviewAnimStep(player);
    overviewVictoryState(player);

    // NEAR-VICTORY WARNING — a player one round from winning is the threat everyone
    // should gang up on, so their whole row lights up gold and pulses. Derive the VISUAL
    // straight from the score, NOT the stateful player.nearVictory flag (which drives the
    // sound cue and only flips under specific animation timing). Two cases, mirroring the
    // legacy goal-post: (a) settled AT the win line, and (b) the legacy "pending" case — a
    // player who was at the win line last round (oldNotches==gl) whose down-slide hasn't
    // animated yet (distanceToMove!=0), so the gold holds through the wait instead of
    // vanishing instantly at overview entry.
    var atLine = (player.notches >= gl) && player.distanceToMove == 0;
    var pendingFromLine = (oldNotches[player.id] === gl) && player.distanceToMove != 0;
    var nearWin = atLine || pendingFromLine;
    // Teams modes: the threat is a TEAM whose pool is at the target — light up every
    // member's row (and nobody else's), instead of personally-capped individuals.
    if (typeof teamInfo !== "undefined" && teamInfo != null) {
        nearWin = (typeof isNearVictoryDisplay === "function") && isNearVictoryDisplay(player);
    }
    if (nearWin) {
        var pulse = 0.5 + 0.5 * Math.sin(Date.now() / 260);
        gameContext.save();
        gameContext.globalAlpha = 0.12 + 0.10 * pulse;
        gameContext.fillStyle = OV.gold;
        drawRoundRectPath(px + 2, py + 2, pw - 4, rh - 4, 8);
        gameContext.fill();
        gameContext.globalAlpha = 0.55 + 0.35 * pulse;
        gameContext.lineWidth = 1.5;
        gameContext.strokeStyle = OV.gold;
        gameContext.stroke();
        gameContext.restore();
    }

    // rank badge / medal at the front
    gameContext.save();
    gameContext.textAlign = "center";
    gameContext.textBaseline = "middle";
    if (player.firstPlace) { gameContext.font = "22px Arial"; gameContext.fillText("🥇", px + 22, cy); }
    else if (player.secondPlace) { gameContext.font = "22px Arial"; gameContext.fillText("🥈", px + 22, cy); }
    else if (player.downRank) { gameContext.font = "20px Arial"; gameContext.fillText("💀", px + 22, cy); }
    else { gameContext.font = "bold 15px Arial"; gameContext.fillStyle = "rgba(255,255,255,0.5)"; gameContext.fillText(idx + 1, px + 22, cy); }
    gameContext.restore();

    // name — humans are nameless on the board (server only sets player.name for bots /
    // avatar-skin players), so identity is carried by the kart colour/skin. Local seats
    // get "You"/"P2".."P4" (overviewSeatLabel) so couch co-op players each find their row;
    // others show a bot/avatar name when present, else blank — the kart speaks for itself.
    var nm = seat.label;
    if (nm) {
        gameContext.save();
        gameContext.textAlign = "left";
        gameContext.textBaseline = "middle";
        gameContext.fillStyle = isYou ? OV.gold : "#fff";
        gameContext.font = (isYou ? "bold " : "") + "15px Arial";
        gameContext.fillText(fitWithEllipsis(nm, 110), px + 46, cy);
        gameContext.restore();
    }

    // ---- track: kart rides the line ----
    var trackX0 = px + 184, trackX1 = px + pw - 52, trackW = trackX1 - trackX0;
    if (trackW < 40) { trackW = 40; trackX1 = trackX0 + trackW; }
    var fillX = trackX0 + frac * trackW;

    // base rail + notch pips. The track spans gl+1 segments (see overviewAnimStep): a pip
    // for each score 0..gl, so pip `gl` is one step short of the goal flag (trackX1) — the
    // kart parks there at near-victory and the flag marks the decisive final win.
    gameContext.save();
    gameContext.strokeStyle = "rgba(255,255,255,0.10)";
    gameContext.lineWidth = 3;
    gameContext.beginPath(); gameContext.moveTo(trackX0, cy); gameContext.lineTo(trackX1, cy); gameContext.stroke();
    for (var n = 0; n <= gl; n++) {
        var nx = trackX0 + (n / (gl + 1)) * trackW;
        gameContext.beginPath(); gameContext.arc(nx, cy, 2.5, 0, 2 * Math.PI);
        gameContext.fillStyle = "rgba(255,255,255,0.22)"; gameContext.fill();
    }
    gameContext.restore();

    // Will an equipped tail cosmetic draw over this segment? If so, the solid progress
    // line recedes to a faint thin guide so the COSMETIC trail is the main visual; with no
    // tail equipped the solid line is the whole show and stays bold.
    var hasTailFx = !nearWin && player.trailFx && typeof getTrailEffect === "function" &&
        typeof TRAIL_FX !== "undefined" && getTrailEffect(player.trailFx) &&
        TRAIL_FX[getTrailEffect(player.trailFx)] != null;

    // filled progress line (the player-colour "trail"). Near-victory players glow GOLD
    // and dash — the warning trumps their own colour so the threat reads instantly.
    gameContext.save();
    if (nearWin) {
        gameContext.shadowColor = OV.gold; gameContext.shadowBlur = 12;
        gameContext.strokeStyle = OV.gold; gameContext.lineWidth = 6; gameContext.lineCap = "round";
        gameContext.setLineDash([18, 6]);
    } else if (hasTailFx) {
        // Faint thin guide under the cosmetic trail — keeps the line readable as "progress"
        // without competing with the equipped effect.
        gameContext.globalAlpha = 0.22;
        gameContext.strokeStyle = player.color; gameContext.lineWidth = 2; gameContext.lineCap = "round";
    } else {
        gameContext.shadowColor = player.color; gameContext.shadowBlur = 6;
        gameContext.strokeStyle = player.color; gameContext.lineWidth = 5; gameContext.lineCap = "round";
    }
    gameContext.beginPath(); gameContext.moveTo(trackX0, cy); gameContext.lineTo(fillX, cy); gameContext.stroke();
    gameContext.restore();

    // equipped tail cosmetic overlaid along the filled segment (skipped for near-victory,
    // where the gold warning trail takes over the whole length).
    if (hasTailFx) { drawOverviewTailFx(trackX0, fillX, cy, player); }

    // goal flag at the finish — solid pulsing gold once a player reaches the win line.
    gameContext.save();
    gameContext.font = (nearWin ? "bold 16px" : "14px") + " Arial";
    gameContext.textAlign = "center"; gameContext.textBaseline = "middle";
    if (nearWin) {
        gameContext.shadowColor = OV.gold; gameContext.shadowBlur = 8;
        gameContext.fillStyle = OV.gold;
    } else {
        gameContext.fillStyle = (frac >= 0.999) ? OV.gold : "rgba(255,255,255,0.3)";
    }
    gameContext.fillText("⚑", trackX1 + 10, cy);
    gameContext.restore();

    // kart rides at the progress head, full cosmetics + fire
    drawFireOverview(fillX, cy, player);
    drawOverviewKart(player, fillX, cy, 12);

    // between-round emote — the server still broadcasts chat reactions during overview
    // and the input UI still sends them, so render them on the row above the kart.
    // drawEmoji anchors at player.x/player.y; overviewAnimStep left those in track-local
    // space, so point them at the kart's actual screen position for this draw.
    if (player.chatMessage != null) {
        var sx = player.x, sy = player.y;
        player.x = fillX; player.y = cy - 6;
        drawEmoji(player);
        player.x = sx; player.y = sy;
    }

    // delta float above the kart (this round's score change)
    drawOverviewDelta(player, fillX, cy - 18);

    // just-played PB tag — signed-in racers' global rank + time on the map they just
    // finished (sourced from mapLeaderboardJustPlayed). Lets the last finisher, who gets
    // almost no overview time, still see how they landed. Drawn in its OWN lane below the
    // track, ending left of the goal flag (trackX1) so it never crowds the flag/score
    // column at the row's right edge.
    drawStandingsPbTag(player, trackX1 - 6, cy, isYou);

    // score
    gameContext.save();
    gameContext.textAlign = "right"; gameContext.textBaseline = "middle";
    gameContext.fillStyle = "#fff"; gameContext.font = "bold 16px Arial";
    gameContext.fillText(player.notches, px + pw - 18, cy);
    gameContext.restore();
}

// Just-played global rank + PB time tag for a row, drawn right-aligned ending at xRight.
// No-op without a mapLeaderboardJustPlayed entry for this player (guests/bots, or a
// signed-in player with no PB). Mirrors the legacy inline-leaderboard data source.
function drawStandingsPbTag(player, xRight, cy, isYou) {
    if (mapLeaderboardJustPlayed == null || !mapLeaderboardJustPlayed.rows) { return; }
    if (player == null || !player.id) { return; }
    var rows = mapLeaderboardJustPlayed.rows, row = null;
    for (var i = 0; i < rows.length; i++) {
        if (rows[i].playerId === player.id) { row = rows[i]; break; }
    }
    if (row == null) { return; }
    gameContext.save();
    gameContext.textBaseline = "middle";
    gameContext.textAlign = "right";
    gameContext.font = (isYou ? "bold " : "") + "12px Arial";
    gameContext.fillStyle = "rgba(255,255,255,0.55)";
    gameContext.fillText("#" + row.rank + "  " + formatRaceTime(row.bestMs), xRight, cy + 13);
    gameContext.restore();
}

// Kart with full cosmetics at an explicit centre/radius (decoupled from the old
// transform-scaled icon). Border behind, then cart skin OR plain disc + pattern —
// same cosmetic dispatch as the legacy drawPlayerIcon.
function drawOverviewKart(player, cx, cy, radius) {
    // Paint the cosmetic stack UNSHADOWED into a small scratch canvas, then blit it
    // ONCE with the colored glow. Keeping shadowBlur=10 live across a procedural
    // skin's dozens of path/gradient ops rendered an intermediate blurred surface
    // per op — with a full board of skinned karts the overview paid that every frame.
    var ext = radius * 2.2; // covers border rim (~1.4r) with glow headroom
    var sx = (typeof canvasScaleX !== "undefined" && canvasScaleX) ? canvasScaleX : 1;
    var sy = (typeof canvasScaleY !== "undefined" && canvasScaleY) ? canvasScaleY : 1;
    var w = Math.ceil(ext * 2 * sx), h = Math.ceil(ext * 2 * sy);
    if (_overviewKartScratch == null) { _overviewKartScratch = document.createElement("canvas"); }
    var s = _overviewKartScratch;
    if (s.width < w) { s.width = w; }
    if (s.height < h) { s.height = h; }
    var sctx = s.getContext("2d");
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, w, h);
    sctx.setTransform(sx, 0, 0, sy, 0, 0);
    // The skin painters draw through the gameContext global, so point it at the
    // scratch for the repaint and ALWAYS restore (try/finally) so a throwing
    // painter can't hijack the rest of the frame.
    var prevCtx = gameContext;
    gameContext = sctx;
    try { drawOverviewKartBody(player, ext, ext, radius); } finally { gameContext = prevCtx; }
    gameContext.save();
    gameContext.shadowColor = player.color;
    gameContext.shadowBlur = 10;
    gameContext.drawImage(s, 0, 0, w, h, cx - ext, cy - ext, ext * 2, ext * 2);
    gameContext.restore();
}
var _overviewKartScratch = null;
// The actual cosmetic stack (border behind, then cart skin OR plain disc + pattern),
// shadow-free — drawOverviewKart composites it with the glow in one blit.
function drawOverviewKartBody(player, cx, cy, radius) {
    gameContext.save();
    // border FIRST (behind the body)
    var bid = player.border;
    var bskin = (typeof getSkin === "function" && bid) ? getSkin(bid) : null;
    if (bskin && bskin.slot === 'border') {
        var bpaint = (typeof getSkinPainter === "function") ? getSkinPainter(bid) : null;
        if (bpaint != null) { drawBorderOverlay(player, cx, cy, radius, bpaint); }
    }
    var painter = cartSkinPainter(player.cart);
    if (painter != null) {
        drawCartSkin(player, cx, cy, radius, painter, 0); // face right (toward finish)
    } else {
        gameContext.beginPath();
        gameContext.arc(cx, cy, radius, 0, 2 * Math.PI);
        gameContext.fillStyle = player.color;
        gameContext.fill();
        gameContext.save();
        gameContext.beginPath();
        gameContext.lineWidth = Math.max(2, radius * 0.33);
        gameContext.strokeStyle = "black";
        gameContext.arc(cx, cy, radius, 0, 2 * Math.PI);
        gameContext.stroke();
        gameContext.restore();
        // pattern overlays the plain sphere only
        var pid = player.pattern;
        var pskin = (typeof getSkin === "function" && pid) ? getSkin(pid) : null;
        if (pskin && pskin.slot === 'pattern') {
            var ppaint = (typeof getSkinPainter === "function") ? getSkinPainter(pid) : null;
            if (ppaint != null) { drawPatternOverlay(player, cx, cy, radius, ppaint); }
        }
    }
    gameContext.restore();
}

// Equipped tail cosmetic (player.trailFx) painted along the filled progress segment,
// using the same TRAIL_FX renderer as live racing / the recap. Synthesised verts march
// x0→x1 so the effect runs the length of the trail. No-op without an effect.
function drawOverviewTailFx(x0, x1, cy, player) {
    if (x1 - x0 <= 8 || !player.trailFx) { return; }
    if (typeof paintTrailFx !== "function") { return; }
    var fadeMs = (typeof TRAIL_FADE_MS !== "undefined") ? TRAIL_FADE_MS : 1700;
    var now = Date.now();
    var n = 14, verts = [];
    for (var i = 0; i < n; i++) {
        var f = i / (n - 1);
        verts.push({ x: x0 + (x1 - x0) * f, y: cy, t: now - fadeMs * 0.92 * (1 - f) });
    }
    gameContext.save();
    // The TRAIL_FX renderers are built for free 2D kart motion, so they add perpendicular
    // sway/drift/waves around the path. On the overview the trail must hug the FIXED notch
    // line, so clip the effect to a thin band centred on cy — each trail keeps its colour,
    // particles, and along-line motion, but its vertical scatter is trimmed to the line.
    var bandH = 12;
    gameContext.beginPath();
    gameContext.rect(x0 - 4, cy - bandH / 2, (x1 - x0) + 8, bandH);
    gameContext.clip();
    paintTrailFx(gameContext, player.trailFx, verts, player.color, { fadeMs: fadeMs });
    gameContext.restore();
}

// Rising/fading "+2"/"+1"/"−1" above the kart, showing this round's score change.
function drawOverviewDelta(player, cx, cy) {
    var delta = player.deltaNotches;
    if (!delta || notchFloatStart == null) { return; }
    var elapsed = Date.now() - notchFloatStart;
    if (elapsed < 0 || elapsed > NOTCH_FLOAT_DURATION) { return; }
    var t = elapsed / NOTCH_FLOAT_DURATION;
    var alpha = (t < 0.15) ? (t / 0.15) : (t > 0.6 ? Math.max(0, (1 - t) / 0.4) : 1);
    var rise = 14 * (1 - Math.pow(1 - t, 2));
    var label = (delta > 0 ? "+" : "−") + Math.abs(delta);
    var fill = delta < 0 ? "#ff5a5a" : (delta >= 2 ? "#ffd54a" : "#5be36a");
    gameContext.save();
    gameContext.globalAlpha = alpha;
    gameContext.font = "bold 15px Arial";
    gameContext.textAlign = "center"; gameContext.textBaseline = "middle";
    gameContext.lineWidth = 3; gameContext.strokeStyle = "rgba(0,0,0,0.85)";
    gameContext.shadowColor = fill; gameContext.shadowBlur = 6;
    gameContext.strokeText(label, cx, cy - rise);
    gameContext.fillStyle = fill;
    gameContext.fillText(label, cx, cy - rise);
    gameContext.restore();
}

function drawFireOverview(x, y, player) {
    if (player.onFire > 0) {
        gameContext.save();
        gameContext.shadowColor = "rgba(0, 0, 0, 0)";
        gameContext.translate(x - 5, y);
        gameContext.rotate(-90 * (Math.PI / 180));
        drawFlameColor(player, 90);
        gameContext.restore();
    }
}
/*
function drawAbiltiesOverview(notchX, player) {
    if (player.ability == null) {
        return;
    }

    gameContext.save();
    drawAbilityIndicator(notchX, 0, player);
    gameContext.restore();
}
*/

function createFirstRankSymbol(playerid) {
    var player = playerList[playerid];
    player.firstPlace = true;
    for (var prop in playerList) {
        if (playerid == prop) {
            continue;
        }
        playerList[prop].firstPlace = false;
    }
}
function createSecondRankSymbol(playerid) {
    var player = playerList[playerid];
    player.secondPlace = true;
    for (var prop in playerList) {
        if (playerid == prop) {
            continue;
        }
        playerList[prop].secondPlace = false;
    }
}
function createDownRankSymbol(playerid) {
    var player = playerList[playerid];
    player.downRank = true;
}

function resetPlayerRanks() {
    for (var prop in playerList) {
        playerList[prop].downRank = false;
        playerList[prop].secondPlace = false;
        playerList[prop].firstPlace = false;
    }
}
function calculateNotchMoveAmt() {
    notchDistanceApart = 75;//gameLength * 20;
    for (var id in playerList) {
        playerList[id].deltaNotches = playerList[id].notches - oldNotches[id];
        playerList[id].distanceToMove = playerList[id].deltaNotches * notchDistanceApart;
        playerList[id].distanceTraveled = 0;
    }
    // Arm the rising "+N"/"−1" floats for this round's standings board.
    notchFloatStart = Date.now();
}
function getBbox(cell) {
    var halfedges = cell.halfedges,
        iHalfedge = halfedges.length,
        xmin = Infinity,
        ymin = Infinity,
        xmax = -Infinity,
        ymax = -Infinity,
        v, vx, vy;
    while (iHalfedge--) {
        v = getStartpoint(halfedges[iHalfedge]);
        vx = v.x;
        vy = v.y;
        if (vx < xmin) { xmin = vx; }
        if (vy < ymin) { ymin = vy; }
        if (vx > xmax) { xmax = vx; }
        if (vy > ymax) { ymax = vy; }
    }
    return {
        x: xmin,
        y: ymin,
        width: xmax - xmin,
        height: ymax - ymin
    };
};

function cameraOnMyPlayer() {
    if (myPlayer != null) {
        recenterCamera(myPlayer);
    }
}

function recenterCamera(object) {
    camera.centerOnObject(object);
    camera.draw();
}
class SpriteSheet {
    constructor(image, x, y, frameWidth, frameHeight, rows, columns, loopAnimation) {
        this.image = image;
        this.x = x;
        this.y = y;
        this.frameWidth = frameWidth;
        this.frameHeight = frameHeight;
        this.frameIndex = [[], []];
        this.rows = rows;
        this.columns = columns;

        this.frameRate = 24;
        this.ticksPerFrame = 1 / this.frameRate;
        this.ticks = 0;
        this.loopAnimation = loopAnimation;
        this.animationComplete = false;

        for (var i = 0; i < rows; i++) {
            this.frameIndex[i] = [];
            for (var j = 0; j < columns; j++) {
                this.frameIndex[i][j] = { sx: j * frameWidth, sy: i * frameHeight };

            }
        }
        this.XframeIndex = 0;
        this.YframeIndex = 0;
    }
    move(x, y) {
        this.x = x;
        this.y = y;
    }
    changeFrame(x, y) {
        this.XframeIndex = x;
        this.YframeIndex = y;
    }
    update(dt) {
        this.ticks += dt / 1000;
        if (this.ticks > this.ticksPerFrame) {
            this.ticks = 0;
            if (this.XframeIndex < this.rows - 1) {
                this.XframeIndex += 1;
                return;
            }
            if (this.loopAnimation) {
                this.XframeIndex = 0;
            }
            else {
                this.animationComplete = true;
            }
        }
    }
    draw(width, height) {
        gameContext.drawImage(this.image, this.frameIndex[this.XframeIndex][this.YframeIndex].sx, this.frameIndex[this.XframeIndex][this.YframeIndex].sy, this.frameWidth, this.frameHeight, this.x - (width / 2), this.y - (height / 2), width, height);
    }
}



