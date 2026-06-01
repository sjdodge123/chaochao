// recap.js — End-of-game recap montage (client-only, no GIF encoding).
//
// We buffer the lightweight per-tick player state the client already decodes
// every server tick, then replay short windows of it into a small framed
// window on the gameOver screen — cycling one clip per highlight, credits style.
//
// Why this is cheap: the in-game camera is inactive on the gameOver screen, so
// the FX helpers (drawFire / drawAbilityIndicator / the kart sprite) all draw at
// raw world coordinates with a zero camera offset. A clip renders by setting up
// a single world->window transform (zoom + follow), blitting that round's baked
// map snapshot, and re-drawing the buffered karts through the SAME helpers the
// live game uses — so a clip looks like the real game (rotation-aware flames,
// ability aimers, infection auras), not a field of dots. The buffer is numbers
// plus one cached map image per round.
//
// Variety across rounds: a single round's buffer would only ever hold the FINAL
// round (each race resets the buffer), so instead we HARVEST the best clips of
// every round into a persistent archive (recapArchive) as each round ends, each
// paired with a clean pre-collapse snapshot of that round's map. At gameOver we
// pick a spread of clips across rounds / subjects / highlight types.
//
// Highlight moments are derived from events the client already receives (deaths,
// goals, multi-kills, sprees) — no server changes needed.

// --- tuning ---------------------------------------------------------------
var RECAP_BUFFER_MS = 14000;   // rolling per-round history kept while racing
var RECAP_CLIP_MS = 3000;      // length of real footage captured per clip (the slice window)
var RECAP_SLOWMO = 1.3;        // playback time-stretch: >1 = cinematic slow-mo, 1.0 = real-time
var RECAP_PLAY_MS = RECAP_CLIP_MS * RECAP_SLOWMO; // on-screen playback duration of one clip (slowed)
var RECAP_PRE_MS = 1400;       // portion of the captured footage BEFORE the highlight moment
var RECAP_LEADIN_MAX_MS = 800; // most of a clip's slow lead-in we'll skip so it opens mid-action
var RECAP_LEADIN_FRAC = 0.4;   // open once the framed karts reach this fraction of the clip's peak speed
var RECAP_SLIDE_DIST = 320;    // travel (world px, default-map scale) a punched kart must cover to count as "sent flying"
var RECAP_SLIDE_WINDOW_MS = 1500; // window after the hit we watch for that travel before giving up
var RECAP_DISPLAY_MS = RECAP_PLAY_MS; // hold each clip for one full (slowed) playthrough
var RECAP_MAX_CLIPS = 4;       // keep the montage short within gameOverTime (20s)
var RECAP_PER_ROUND = 2;       // most clips harvested from any single round (leave room for variety)
var RECAP_ZOOM = 2.4;          // camera zoom over fit-to-window (higher = tighter on the action)
var RECAP_CAM_LERP = 0.12;     // how fast the follow-cam glides toward the action each frame
var RECAP_WIN_W = 620;         // clip window width (logical px) — centred under the headline winner
var RECAP_HEADER_GAP = 84;     // headline baseline -> clip window top; the caption + player chips live here
var RECAP_EXIT_FX_MS = 750;    // how long a death/goal poof lingers before the kart vanishes
var RECAP_EXPLOSION_MS = 430;  // explosion effect lifetime (matches spawnExplosion's maxAge)
var RECAP_MUZZLE_MS = 160;     // muzzle-flash lifetime (matches spawnMuzzleFlash's maxAge)
var RECAP_SHOCKWAVE_MS = 1100; // one collapse-shockwave ring pass (600px/s out to ~650px)
var RECAP_PUNCH_MS = 220;      // punch shockwave lifetime (matches spawnPunchEffect's maxAge)
var RECAP_HIT_MS = 220;        // landed-hit ring lifetime (matches spawnHitEffect's maxAge)
var RECAP_CLASH_MS = 320;      // parry clash lifetime (matches spawnClashEffect's maxAge)
var RECAP_PUNCH_ANIM_MS = 220; // cart-skin punch lunge window (matches drawCartSkin's /220)
var RECAP_MAP_SNAP_MS = 450;   // min gap between dynamic-map snapshots (explosion/swap, slow racing changes)
var RECAP_MAP_SNAP_COLLAPSE_MS = 110; // finer gap while collapsing — lava grows every tick, and a 450ms
                               // gap left the killing lava up to ~half a second behind the death frame
                               // in the replay (so a kart "died to nothing" until the next snapshot)
var RECAP_MAP_SCALE = 0.6;     // downscale map snapshots (clips are small) to bound memory
var RECAP_MAP_MAX = 48;        // cap rolling map snapshots per round (downscaled, so cheap); higher to
                               // hold a finely-sampled collapse window without evicting the pre-collapse
                               // baseline that earlier (racing) clips render from

// per-player frame tuple: [id, x, y, angle, velX, velY, state, onFire, ability, infected, emote, speedFx, punchAge]
// emote = active emoji string or null; speedFx = 0 none / 1 buff / 2 debuff;
// punchAge = ms since this kart threw its melee punch (drives the cart-skin lunge), or -1 if not punching
var RF_ID = 0, RF_X = 1, RF_Y = 2, RF_ANGLE = 3, RF_VX = 4, RF_VY = 5, RF_STATE = 6, RF_FIRE = 7, RF_ABILITY = 8, RF_INFECTED = 9, RF_EMOTE = 10, RF_SPEEDFX = 11, RF_PUNCH = 12;
// per-frame screen-effect flag bit (blindfold ability — shown as a corner badge, not rendered)
var RFX_BLIND = 1;
// projectile tuple: [type, x, y, color, radius]; hazard tuple: [id, x, y, angle, railX, railY]
var RP_TYPE = 0, RP_X = 1, RP_Y = 2, RP_COLOR = 3, RP_RADIUS = 4;
var RH_ID = 0, RH_X = 1, RH_Y = 2, RH_ANGLE = 3, RH_RAILX = 4, RH_RAILY = 5;
// player.recapState values (also the RF_STATE values captured per frame)
var RECAP_ALIVE = 0, RECAP_DIED = 1, RECAP_SCORED = 2;

// Brutal-round captions: a themed tag prefixed onto a clip's title when the
// round it came from was a brutal round. Spatial brutal elements (pucks, bombs,
// clouds, zombies) are replayed; whole-screen effects (blackout) are not.
// Blindfold is an ABILITY (room-wide blind), not a brutal round — its icon badge
// is drawn separately. Other full-screen effects (cloudy/blackout) ARE brutal
// rounds, so their icons come from the brutal-round set (brutalRoundImages).
var RECAP_BLIND_ABILITY = "blind";

// Highlight-type metadata: caption shown over the clip + a selection priority
// (higher = more interesting, picked first) used to spread the montage.
var RECAP_TYPE_INFO = {
	mega: { title: "Mega Kill!", priority: 7 },
	triple: { title: "Triple Kill!", priority: 6 },
	double: { title: "Double Kill!", priority: 5 },
	godlike: { title: "Godlike!", priority: 5 },
	rampage: { title: "Rampage!", priority: 4 },
	spree: { title: "Killing Spree!", priority: 3 },
	slide: { title: "Sent Flying!", priority: 4 },
	goal: { title: "Goal!", priority: 2 },
	death: { title: "Eliminated", priority: 1 }
};
// multi-kill achievement key -> the marker type recorded for it (title refinement)
var RECAP_TYPE_FOR_KEY = { doubleKill: "double", tripleKill: "triple", megaKill: "mega" };

// --- per-round capture state ----------------------------------------------
var recapFrames = [];          // [{ t, players, projs, hazards }] for the CURRENT round
var recapMarkers = [];         // [{ t, type, ids: [...] }] highlight moments this round
var recapEffects = [];         // [{ t, type, x, y, params }] one-shot FX (explosions) this round
var recapMeta = {};            // id -> { color, radius, name }; survives playerList being cleared
var recapMaps = [];            // [{ t, image, pad, world, scale }] time-stamped map snapshots (dynamic map state)
var recapMapDirty = false;     // a map-mutating event fired -> take a fresh snapshot soon
var recapLastMapSnap = 0;      // throttle clock for map snapshots
var recapIceCells = [];        // [[{x,y},...], ...] this round's ice-tile polygons (world coords), captured
                               // at race start (clean map) so the replay can cast the same ice reflections
var recapSlideWatch = {};      // victimId -> { id, x, y, t }: punched karts being watched for a long knockback slide
// --- cross-round archive --------------------------------------------------
var recapArchive = [];         // [{ title, type, priority, ids, frames, map, exits }] harvested clips
// --- playback state -------------------------------------------------------
var recapSequence = null;      // [{ title, ids, frames, map, exits }] built at gameOver
var recapIndex = 0;
var recapElapsed = 0;          // ms spent on the current sequence item
var recapCamX = null;          // smoothed follow-camera centre (world coords); null = snap next frame
var recapCamY = null;

// Clear the per-round buffer. Called at the start of every race so capture only
// holds frames from the CURRENT round — the cross-round archive is left intact
// (that's what gives the montage clips from earlier rounds). Also re-arms each
// known player's recap state, since a new round revives everyone.
function recapReset() {
	recapFrames = [];
	recapMarkers = [];
	recapEffects = [];
	recapMaps = [];
	recapMapDirty = false;
	recapLastMapSnap = 0;
	recapSlideWatch = {};
	// Snapshot the ice footprint now, while the map is still clean — collapse later
	// overwrites ice cells to lava (cell.id changes), so harvesting it at round end
	// would miss them. Static for the round, so one capture covers every clip.
	recapIceCells = recapCaptureIceCells();
	if (typeof playerList !== "undefined" && playerList != null) {
		for (var id in playerList) {
			if (playerList[id] != null) {
				playerList[id].recapState = RECAP_ALIVE;
			}
		}
	}
}

// Collect this round's ice-tile polygons (world-coord vertex rings) from the live
// map, reusing the terrainfx vertex helper so the footprint matches the rendered
// terrain exactly. Returns [] if anything's unavailable (the reflection then no-ops).
function recapCaptureIceCells() {
	var out = [];
	if (typeof currentMap === "undefined" || currentMap == null || currentMap.cells == null) { return out; }
	if (typeof config === "undefined" || config == null || config.tileMap == null || config.tileMap.ice == null) { return out; }
	if (typeof tfxCellVerts !== "function") { return out; }
	var iceId = config.tileMap.ice.id;
	for (var i = 0; i < currentMap.cells.length; i++) {
		var cell = currentMap.cells[i];
		if (cell == null || cell.id !== iceId) { continue; }
		var verts = tfxCellVerts(cell);
		if (verts && verts.length > 0) { out.push(verts); }
	}
	return out;
}

// Clear EVERYTHING for a brand-new match (called when the lobby/waiting screen
// comes up). Otherwise last game's clips would carry into the next montage.
function recapNewMatch() {
	recapReset();
	recapArchive = [];
	recapMeta = {};
	recapSequence = null;
	recapIndex = 0;
	recapElapsed = 0;
	recapCamX = null;
	recapCamY = null;
}

// Snapshot the current player state. Called once per server tick from the
// gameUpdates handler while racing/collapsing. Trims anything older than the
// rolling window so memory stays bounded regardless of round length.
function recapCaptureFrame() {
	if (playerList == null) {
		return;
	}
	// Snapshot the map's CURRENT appearance (re-snapshotting as collapse lava /
	// exploded tiles / tile-swaps change it) so a clip replays the board as it looked
	// at that moment — not a single clean or all-lava image.
	recapCaptureMap();
	var now = Date.now();
	var nowMs = now;
	var players = [];
	for (var id in playerList) {
		var p = playerList[id];
		if (p == null || p.x == null) {
			continue;
		}
		// Liveness comes from the authoritative live flag each frame; recapState only
		// supplies the died-vs-scored flavour — so a stale recapState on a late-joining
		// or re-added player can't leave an alive kart poofed/invisible in the clip.
		var state = RECAP_ALIVE;
		if (p.alive === false) { state = (p.recapState === RECAP_SCORED) ? RECAP_SCORED : RECAP_DIED; }
		var speedFx = 0;
		if (p.speedBuffUntil != null && nowMs < p.speedBuffUntil) { speedFx = 1; }
		else if (p.speedDebuffUntil != null && nowMs < p.speedDebuffUntil) { speedFx = 2; }
		// Emote: capture [msg, ageMs, durationMs] so the bubble can fade in the replay
		// (drawEmoji needs chatMessageAt/Duration). Plain string is tolerated too (demo).
		var emote = (p.chatMessage != null)
			? [p.chatMessage, now - (p.chatMessageAt || now), p.chatMessageDuration || 4000]
			: null;
		// Punch lunge: store how long ago this kart swung (drawCartSkin animates the
		// forward lunge over RECAP_PUNCH_ANIM_MS). -1 once the window has passed.
		var punchAge = (p.punchAnimAt != null) ? (now - p.punchAnimAt) : -1;
		if (punchAge < 0 || punchAge >= RECAP_PUNCH_ANIM_MS) { punchAge = -1; }
		players.push([p.id, p.x, p.y, p.angle, p.velX, p.velY, state,
			(p.onFire != null ? p.onFire : 0), (p.ability != null ? p.ability : null), p.infected === true,
			emote, speedFx, punchAge]);
		// Keep the static per-player look so a clip can render even after the live
		// playerList drops bots at the gameOver->waiting transition.
		recapMeta[p.id] = {
			color: p.color,
			radius: (p.radius != null) ? p.radius : 12,
			name: p.name || null,
			// Cosmetic slots are fixed for the match, so the static look carries them (no
			// per-frame tuple slot). Lets the replay render the same cart + pattern + trail.
			cart: (p.cart != null) ? p.cart : null,
			pattern: (p.pattern != null) ? p.pattern : null,
			trailFx: (p.trailFx != null) ? p.trailFx : null,
			border: (p.border != null) ? p.border : null
		};
	}
	// Resolve any pending knockback-slide watches against this tick's live positions.
	recapCheckSlides(now);
	if (players.length === 0) {
		return;
	}
	// Blindfold ability active this frame — shown later as a corner icon badge, not
	// rendered (it'd just blind the clip). Blackout/cloudy are brutal rounds, so
	// their icon badges come from the brutal-round set instead.
	var fx = 0;
	if (typeof blindfold !== "undefined" && blindfold != null && blindfold.color != null) { fx |= RFX_BLIND; }
	// Also snapshot the brutal-round world objects (pucks/bombs/clouds + bumpers),
	// the active targeting aimers, and the current screen-shake so the clip can
	// replay them — not just the karts.
	recapFrames.push({
		t: now, players: players, projs: recapCaptureProjs(), hazards: recapCaptureHazards(),
		aimers: recapCaptureAimers(),
		trauma: (typeof shakeTrauma !== "undefined" && shakeTrauma > 0) ? shakeTrauma : 0,
		fx: fx
	});
	var cutoff = now - RECAP_BUFFER_MS;
	while (recapFrames.length > 0 && recapFrames[0].t < cutoff) {
		recapFrames.shift();
	}
	while (recapEffects.length > 0 && recapEffects[0].t < cutoff) {
		recapEffects.shift(); // keep the one-shot FX log bounded too
	}
	// Keep ONE map snapshot from before the window (a baseline for clips at the
	// window's leading edge), drop older ones.
	while (recapMaps.length > 1 && recapMaps[1].t < cutoff) {
		recapMaps.shift();
	}
}

// Called from the map-mutating event handlers (collapse / explosion / tile-swap)
// so the next captured frame grabs a fresh map snapshot reflecting the change.
function recapMarkMapDirty() {
	recapMapDirty = true;
}

// Snapshot the live map cache (downscaled) when there's none yet, or when the map
// just changed (throttled). Re-snapshotting as collapse/explosions/swaps mutate
// the board gives the clip the right terrain at every moment — not a stale clean
// image (which hid the lava) nor the final all-lava image.
function recapCaptureMap() {
	if (typeof mapCanvas === "undefined" || mapCanvas == null || world == null || world.width == null) {
		return;
	}
	var now = Date.now();
	var first = recapMaps.length === 0;
	// Sample finely while the map is collapsing (lava grows every tick) so the replay's
	// lava reaches each victim in step with their death; coarse otherwise (racing map
	// barely changes, so frequent snapshots would just burn memory).
	var collapsing = (typeof currentState !== "undefined" && typeof config !== "undefined" &&
		config != null && config.stateMap != null && currentState === config.stateMap.collapsing);
	var snapGap = collapsing ? RECAP_MAP_SNAP_COLLAPSE_MS : RECAP_MAP_SNAP_MS;
	if (!first && !(recapMapDirty && now - recapLastMapSnap >= snapGap)) {
		return;
	}
	var scale = RECAP_MAP_SCALE;
	var snap = document.createElement("canvas");
	snap.width = Math.max(1, Math.round(mapCanvas.width * scale));
	snap.height = Math.max(1, Math.round(mapCanvas.height * scale));
	snap.getContext("2d").drawImage(mapCanvas, 0, 0, snap.width, snap.height);
	recapMaps.push({
		t: now, image: snap, scale: scale,
		pad: (typeof mapCanvasPad !== "undefined") ? mapCanvasPad : 8,
		world: { x: world.x, y: world.y, width: world.width, height: world.height }
	});
	recapMapDirty = false;
	recapLastMapSnap = now;
	while (recapMaps.length > RECAP_MAP_MAX) {
		recapMaps.shift();
	}
}

// The map snapshot to render for a given clip time: the latest captured at or
// before frameT (fall back to the earliest).
function recapMapAt(maps, frameT) {
	if (maps == null || maps.length === 0) {
		return null;
	}
	var best = maps[0];
	for (var i = 1; i < maps.length; i++) {
		if (maps[i].t <= frameT) { best = maps[i]; } else { break; }
	}
	return best;
}

// Snapshot live projectiles (bomb / puck / cloud / snowFlake). These are decoded
// every tick into projectileList; we keep just what the replay renderer needs.
function recapCaptureProjs() {
	var out = [];
	if (typeof projectileList === "undefined" || projectileList == null) {
		return out;
	}
	for (var pid in projectileList) {
		var pr = projectileList[pid];
		if (pr == null || pr.x == null) {
			continue;
		}
		out.push([pr.type, pr.x, pr.y, pr.color || null, (pr.radius != null ? pr.radius : 0)]);
	}
	return out;
}

// Snapshot live hazards (static + moving bumpers). railX/railY are static (the
// bumper's rail anchor); angle animates, so it's captured per frame.
function recapCaptureHazards() {
	var out = [];
	if (typeof hazardList === "undefined" || hazardList == null) {
		return out;
	}
	for (var hid in hazardList) {
		var h = hazardList[hid];
		if (h == null || h.x == null) {
			continue;
		}
		out.push([h.id, h.x, h.y, (h.angle != null ? h.angle : 0),
			(h.railX != null ? h.railX : h.x), (h.railY != null ? h.railY : h.y)]);
	}
	return out;
}

// Snapshot active targeting aimers that are mid-countdown (swap / explosion warn
// reticles). The per-tick aimer packet lacks the countdown flags, so we read them
// off the live aimer object here: [x, y, radius, kind(0=swap,1=explosion), progress, color].
function recapCaptureAimers() {
	var out = [];
	if (typeof aimerList === "undefined" || aimerList == null) {
		return out;
	}
	for (var id in aimerList) {
		var a = aimerList[id];
		if (a == null || a.x == null || a.hide === true) {
			continue;
		}
		var prog = (typeof aimerCountdownProgress === "function") ? aimerCountdownProgress(a) : 0;
		if (a.startExplosionCountDown) {
			out.push([a.x, a.y, a.radius, 1, prog, a.color || "#ff8c3a"]);
		} else if (a.startSwapCountDown) {
			out.push([a.x, a.y, a.radius, 0, prog, "black"]);
		}
	}
	return out;
}

// Record a highlight moment (from an existing client event). `ids` are the
// players the moment involves, used to caption + focus the clip.
function recapMarkHighlight(type, ids) {
	recapMarkHighlightAt(type, ids, Date.now());
}

// Same, but stamped at an explicit time `t` — used when the moment is RECOGNISED
// later than it HAPPENED (a knockback slide is only confirmed once the kart has
// finished travelling), so the clip still centres on the original hit.
function recapMarkHighlightAt(type, ids, t) {
	recapMarkers.push({ t: (t != null ? t : Date.now()), type: type, ids: ids || [] });
}

// A punch landed on `victimId` at (x,y): start/refresh a watch. If that kart then
// travels RECAP_SLIDE_DIST within RECAP_SLIDE_WINDOW_MS, recapCheckSlides marks a
// "Sent Flying!" highlight at the hit time (so the clip catches the launch + slide).
function recapNotePunchLaunch(victimId, x, y) {
	if (victimId == null || x == null || y == null) {
		return;
	}
	recapSlideWatch[victimId] = { id: victimId, x: x, y: y, t: Date.now() };
}

// Per-tick: resolve pending knockback watches against the live positions. Fired far
// enough → a highlight; window elapsed or victim gone/dead → dropped (a slide INTO
// a hazard is already covered by the 'death' marker).
function recapCheckSlides(now) {
	if (typeof playerList === "undefined" || playerList == null) {
		return;
	}
	for (var id in recapSlideWatch) {
		var w = recapSlideWatch[id];
		var p = playerList[id];
		if (p == null || p.x == null || p.alive === false) {
			delete recapSlideWatch[id];
			continue;
		}
		var dx = p.x - w.x, dy = p.y - w.y;
		if (dx * dx + dy * dy >= RECAP_SLIDE_DIST * RECAP_SLIDE_DIST) {
			recapMarkHighlightAt("slide", [w.id], w.t);
			delete recapSlideWatch[id];
		} else if (now - w.t > RECAP_SLIDE_WINDOW_MS) {
			delete recapSlideWatch[id];
		}
	}
}

// Record a one-shot world effect (an explosion) so the clip can replay it in the
// effects layer — the live game draws these above projectiles, and they're what
// makes a bomb "go off". `params` carries the look (radius, color).
function recapMarkEffect(type, x, y, params) {
	if (x == null || y == null) {
		return;
	}
	recapEffects.push({ t: Date.now(), type: type, x: x, y: y, params: params || {} });
}

function recapSliceEffects(startT, endT) {
	var out = [];
	for (var i = 0; i < recapEffects.length; i++) {
		if (recapEffects[i].t >= startT && recapEffects[i].t <= endT) {
			out.push(recapEffects[i]);
		}
	}
	return out;
}

// Map snapshots a clip needs: those inside its window, plus the latest one BEFORE
// the window (the baseline the clip opens on).
function recapMapsForWindow(startT, endT) {
	var out = [];
	var baseline = null;
	for (var i = 0; i < recapMaps.length; i++) {
		var m = recapMaps[i];
		if (m.t < startT) { baseline = m; }
		else if (m.t <= endT) { out.push(m); }
	}
	if (baseline != null) { out.unshift(baseline); }
	// If every in-window snapshot was evicted (a very long, mutation-heavy round),
	// fall back to the EARLIEST surviving snapshot (least-collapsed), not the latest
	// — using the latest would replay the clip over the end-of-round lava field.
	if (out.length === 0 && recapMaps.length > 0) { out.push(recapMaps[0]); }
	return out;
}

// Did the blindfold ability fire during this clip? (Brutal rounds — incl. cloudy
// and blackout — are badged from clip.brutal, so only this ability is tracked here.)
function recapBlindInFrames(frames) {
	for (var i = 0; i < frames.length; i++) {
		if ((frames[i].fx || 0) & RFX_BLIND) { return true; }
	}
	return false;
}

// Ids of the players involved in markers near time `t` (within half a clip) — used
// to give a subject to markers that carry none (multi-kills: the server event has
// only a count, so we borrow the nearby death markers' victim ids).
function recapInferIds(t) {
	var out = [];
	for (var i = 0; i < recapMarkers.length; i++) {
		var mk = recapMarkers[i];
		if (mk.ids == null || mk.ids.length === 0) { continue; }
		if (Math.abs(mk.t - t) > RECAP_CLIP_MS / 2) { continue; }
		for (var j = 0; j < mk.ids.length; j++) {
			if (out.indexOf(mk.ids[j]) === -1) { out.push(mk.ids[j]); }
		}
	}
	return out;
}

// Round ended: bake the best clips of THIS round into the archive, each paired
// with the round's clean map snapshot. Called from startOverview (a normal round
// end) and startGameover (the final round) while currentMap is still this round's.
function recapHarvestRound() {
	if (recapFrames.length === 0 || recapMaps.length === 0) {
		return;
	}
	var endT = recapFrames[recapFrames.length - 1].t;
	// The brutal mode (if any) this round was played under — tags the clip's caption.
	var brutal = (typeof brutalRoundConfig !== "undefined" && brutalRoundConfig != null &&
		brutalRoundConfig.brutalTypes != null) ? brutalRoundConfig.brutalTypes.slice() : null;
	// Rank this round's markers by how interesting they are, newest-first on ties.
	var ranked = recapMarkers.slice();
	ranked.sort(function (a, b) {
		var pa = (RECAP_TYPE_INFO[a.type] || {}).priority || 0;
		var pb = (RECAP_TYPE_INFO[b.type] || {}).priority || 0;
		if (pb !== pa) { return pb - pa; }
		return b.t - a.t;
	});
	var taken = 0;
	var takenTimes = []; // times of markers already taken — dedup against ALL of them
	for (var i = 0; i < ranked.length && taken < RECAP_PER_ROUND; i++) {
		var mk = ranked[i];
		// Skip a near-duplicate of ANY already-taken moment (markers are iterated in
		// priority order, so comparing only against the previous one would dedup
		// time-unrelated markers — check every taken time instead).
		var tooClose = false;
		for (var d = 0; d < takenTimes.length; d++) {
			if (Math.abs(mk.t - takenTimes[d]) < RECAP_CLIP_MS / 2) { tooClose = true; break; }
		}
		if (tooClose) {
			continue;
		}
		var startT = mk.t - RECAP_PRE_MS;
		var frames = recapSliceFrames(startT, startT + RECAP_CLIP_MS);
		if (frames.length === 0) {
			continue;
		}
		// Some markers (multi-kills) carry no ids — the server event has only a count.
		// Borrow the ids of nearby markers (e.g. the victims' death markers) so the
		// clip still has a subject to frame, chip, and vary on.
		var ids = mk.ids.slice();
		if (ids.length === 0) { ids = recapInferIds(mk.t); }
		var info = RECAP_TYPE_INFO[mk.type] || { title: "Highlight", priority: 0 };
		recapArchive.push({
			title: info.title,
			type: mk.type,
			priority: info.priority,
			ids: ids,
			focusIds: mk.focusIds ? mk.focusIds.slice() : null,
			frames: frames,
			maps: recapMapsForWindow(startT, startT + RECAP_CLIP_MS),
			brutal: brutal,
			blind: recapBlindInFrames(frames),
			effects: recapSliceEffects(startT, startT + RECAP_CLIP_MS),
			ice: recapIceCells,
			exits: recapComputeExits(frames)
		});
		takenTimes.push(mk.t);
		taken++;
	}
	// If the round produced no usable markers, keep a "final moments" clip so a
	// quiet round still contributes something to the montage.
	if (taken === 0) {
		var tailFrames = recapSliceFrames(endT - RECAP_CLIP_MS, endT);
		if (tailFrames.length > 0) {
			recapArchive.push({
				title: "Final Moments", type: "tail", priority: 0, ids: [],
				frames: tailFrames, maps: recapMapsForWindow(endT - RECAP_CLIP_MS, endT), brutal: brutal,
				blind: recapBlindInFrames(tailFrames), ice: recapIceCells,
				effects: recapSliceEffects(endT - RECAP_CLIP_MS, endT), exits: recapComputeExits(tailFrames)
			});
		}
	}
}

// For each player, the first frame in this clip where they leave play (died or
// scored): { t, x, y, state }. Used to play a one-shot poof at that spot, then
// stop drawing the kart — so dead/scored karts don't hover over lava/goal for the clip.
function recapComputeExits(frames) {
	var exits = {};
	for (var f = 0; f < frames.length; f++) {
		var ps = frames[f].players;
		for (var i = 0; i < ps.length; i++) {
			var pr = ps[i];
			if (pr[RF_STATE] !== RECAP_ALIVE && exits[pr[RF_ID]] == null) {
				exits[pr[RF_ID]] = { t: frames[f].t, x: pr[RF_X], y: pr[RF_Y], state: pr[RF_STATE] };
			}
		}
	}
	return exits;
}

function recapSliceFrames(startT, endT) {
	var out = [];
	for (var i = 0; i < recapFrames.length; i++) {
		if (recapFrames[i].t >= startT && recapFrames[i].t <= endT) {
			out.push(recapFrames[i]);
		}
	}
	return out;
}

// Build the montage at gameOver. The current (final) round was already harvested
// by the startGameover handler, so we select a varied spread from the archive:
// prefer high-priority moments, but penalise repeating a subject or a type so the
// montage isn't four clips of the winner doing the same thing.
function recapBuild(achievementSet) {
	recapSequence = null;
	recapIndex = 0;
	recapElapsed = 0;
	recapCamX = null;
	recapCamY = null;

	if (recapArchive.length === 0) {
		return; // nothing captured (e.g. an instant finish) — skip the montage
	}

	var usedSubject = {};   // id -> times already featured
	var usedType = {};      // type -> times already featured
	var chosen = [];
	var remaining = recapArchive.slice();
	while (chosen.length < RECAP_MAX_CLIPS && remaining.length > 0) {
		var bestIdx = -1, bestScore = -Infinity;
		for (var i = 0; i < remaining.length; i++) {
			var clip = remaining[i];
			var score = (clip.priority || 0) * 4;
			score -= (usedType[clip.type] || 0) * 3;        // discourage repeating a type
			if (clip.brutal && clip.brutal.length) { score += 2; } // brutal moments are eye-catching
			for (var k = 0; k < clip.ids.length; k++) {     // discourage repeating a subject
				score -= (usedSubject[clip.ids[k]] || 0) * 2;
			}
			if (score > bestScore) {
				bestScore = score;
				bestIdx = i;
			}
		}
		if (bestIdx === -1) {
			break;
		}
		var pick = remaining.splice(bestIdx, 1)[0];
		usedType[pick.type] = (usedType[pick.type] || 0) + 1;
		for (var j = 0; j < pick.ids.length; j++) {
			usedSubject[pick.ids[j]] = (usedSubject[pick.ids[j]] || 0) + 1;
		}
		// Build a shallow COPY for the sequence and refine its caption there, so the
		// archived clip is never mutated — recapBuild stays idempotent if it re-runs
		// (e.g. a re-entered gameOver) without a recapNewMatch in between.
		var seqItem = {};
		for (var key in pick) { seqItem[key] = pick[key]; }
		seqItem.title = recapTitleFor(pick, achievementSet);
		chosen.push(seqItem);
	}

	// Replay roughly in the order the moments happened across the match.
	chosen.sort(function (a, b) {
		var ta = a.frames.length ? a.frames[0].t : 0;
		var tb = b.frames.length ? b.frames[0].t : 0;
		return ta - tb;
	});
	recapSequence = chosen.length > 0 ? chosen : null;
}

// Prefer an earned-achievement title whose winners overlap this clip's subjects;
// otherwise keep the highlight's own caption.
function recapTitleFor(clip, achievementSet) {
	if (achievementSet != null && clip.ids.length > 0) {
		for (var key in achievementSet) {
			var a = achievementSet[key];
			if (a == null || a.ids == null || a.ids.length === 0 || a.title == null) {
				continue;
			}
			// A multi-kill marker maps directly to its medal key.
			if (RECAP_TYPE_FOR_KEY[key] === clip.type) {
				return a.title;
			}
			if (recapIdsOverlap(a.ids, clip.ids)) {
				return a.title;
			}
		}
	}
	return clip.title;
}

function recapIdsOverlap(a, b) {
	if (a == null || b == null) {
		return false;
	}
	for (var i = 0; i < a.length; i++) {
		for (var j = 0; j < b.length; j++) {
			if (a[i] === b[j]) {
				return true;
			}
		}
	}
	return false;
}

function recapActive() {
	return recapSequence != null && recapSequence.length > 0;
}

// Caption for a clip: just the highlight title. The brutal-round / effect context
// is conveyed by the in-game icon badges (recapDrawBadges), not text.
function recapCaption(item) {
	return item.title;
}

// Logical canvas dims (the gameOver screen runs in LOGICAL space under
// applyCanvasTransform; gameCanvas.width/height is the device backing store).
function recapLogicalW() {
	if (typeof LOGICAL_WIDTH !== "undefined" && LOGICAL_WIDTH > 0) { return LOGICAL_WIDTH; }
	return (typeof gameCanvas !== "undefined" && gameCanvas) ? gameCanvas.width : 1366;
}
function recapLogicalH() {
	if (typeof LOGICAL_HEIGHT !== "undefined" && LOGICAL_HEIGHT > 0) { return LOGICAL_HEIGHT; }
	return (typeof gameCanvas !== "undefined" && gameCanvas) ? gameCanvas.height : 768;
}

// Clip window height — derived from the active clip's world aspect, capped. Falls
// back to the live world or a default so the header layout is stable even before
// a clip's map is known. Shared so draw.js sizes the header/clip block to match.
function recapWindowHeight() {
	var winW = Math.min(RECAP_WIN_W, recapLogicalW() * 0.52);
	var w = recapActiveWorld();
	var aspect = (w != null && w.width > 0) ? (w.height / w.width) : 0.6;
	return Math.min(winW * aspect, recapLogicalH() * 0.58);
}

// The world rect the current clip renders against (its baked map snapshot), or
// the live world as a fallback.
function recapActiveWorld() {
	if (recapActive() && recapSequence[recapIndex] != null) {
		var maps = recapSequence[recapIndex].maps;
		if (maps != null && maps.length > 0) { return maps[0].world; }
	}
	return (typeof world !== "undefined") ? world : null;
}

// Baseline for the gameOver header so the header + caption + clip-window block
// sits vertically centred on the page. With no active montage it returns the
// usual centred baseline, leaving vanilla gameOver unchanged. Called by BOTH
// draw.js (header text) and recapDraw (window placement) so they stay aligned.
function recapHeaderBaseline() {
	var CH = recapLogicalH();
	if (!recapActive()) {
		return (CH + 48) / 2; // no montage — leave the header where it always was
	}
	var headerCapTop = 38; // header text rises ~38px above its baseline (48px serif)
	var blockH = headerCapTop + RECAP_HEADER_GAP + recapWindowHeight();
	return Math.round((CH - blockH) / 2 + headerCapTop);
}

// Advance and render the montage. Called from drawGameOverScreen each frame.
// Wrapped by the caller in a guard so any render error can't break gameOver.
function recapDraw(dt) {
	if (!recapActive()) {
		return;
	}
	// Clamp per-frame advance: a single huge dt (first frame after the gameOver
	// screen is entered cold, or a backgrounded/refocused tab) must not blow past a
	// whole clip's display time and skip it. Capping at 100ms (> a frame, < a clip)
	// keeps the montage smooth and guarantees every clip gets its turn.
	recapElapsed += Math.min(dt, 100);
	if (recapElapsed >= RECAP_DISPLAY_MS && recapIndex < recapSequence.length - 1) {
		recapIndex++;
		recapElapsed = 0;
		recapCamX = null; // snap the follow-cam to the new clip's action
		recapCamY = null;
	}
	var item = recapSequence[recapIndex];

	// Draw in LOGICAL (1366x768) space: the gameOver screen runs under
	// applyCanvasTransform(), so the winner text/medals are in logical units.
	var CW = recapLogicalW();
	var CH = recapLogicalH();

	// Window geometry: sit it directly under the headline winner text, centred on
	// that text. The header + caption + window block is centred vertically on the
	// page (see recapHeaderBaseline, shared with draw.js). Caption fills the gap.
	var winW = Math.min(RECAP_WIN_W, CW * 0.52);
	var winH = recapWindowHeight();
	var headlineBaseline = recapHeaderBaseline();
	var winY = Math.round(headlineBaseline + RECAP_HEADER_GAP); // leave room for caption + chips above

	// The headline is drawn left-aligned at CW/2-400 (see drawGameOverScreen), so
	// its visual centre is offset from screen centre — measure it and align to it.
	var headlineStr = ((typeof decodedColorName !== "undefined" && decodedColorName != null) ? decodedColorName : "") + " won the game.";
	gameContext.save();
	gameContext.font = "48px serif";
	var headlineCX = (CW / 2 - 400) + gameContext.measureText(headlineStr).width / 2;
	gameContext.restore();
	// Centre on the headline, but stay clear of the medals column (CW/2+200) and
	// the left edge for long winner names.
	var medalsLeft = CW / 2 + 200;
	var winX = Math.round(headlineCX - winW / 2);
	winX = Math.max(16, Math.min(winX, Math.round(medalsLeft - winW - 12)));
	var winCX = winX + winW / 2;

	// Caption above the window, centred on the window (which is centred on the
	// headline) so the whole block reads as one balanced column.
	gameContext.save();
	gameContext.fillStyle = "black";
	gameContext.font = "20px serif";
	gameContext.textAlign = "center";
	gameContext.fillText("Recap " + (recapIndex + 1) + "/" + recapSequence.length + " — " + recapCaption(item), winCX, winY - 14);
	gameContext.textAlign = "left";
	// involved player colour chips, centred as a row above the caption
	var nChips = Math.min(item.ids.length, 6);
	var chipStartX = winCX - (nChips * 24) / 2 + 12;
	for (var c = 0; c < nChips; c++) {
		var who = recapMeta[item.ids[c]];
		gameContext.beginPath();
		gameContext.arc(chipStartX + c * 24, winY - 48, 9, 0, 2 * Math.PI);
		gameContext.fillStyle = (who != null) ? who.color : "grey";
		gameContext.strokeStyle = "black";
		gameContext.lineWidth = 2;
		gameContext.fill();
		gameContext.stroke();
	}
	gameContext.restore();

	// Panel backing + border (dark translucent so it reads on any winner color).
	gameContext.save();
	gameContext.fillStyle = "rgba(0,0,0,0.55)";
	gameContext.fillRect(winX, winY, winW, winH);
	gameContext.strokeStyle = "rgba(255,255,255,0.9)";
	gameContext.lineWidth = 3;
	gameContext.strokeRect(winX, winY, winW, winH);

	// Clip to the panel so the scaled map can't bleed past the frame.
	gameContext.beginPath();
	gameContext.rect(winX, winY, winW, winH);
	gameContext.clip();

	// try/finally so a throw inside the clip render can never leave this clip + its
	// save on the context stack — that would clip/scale the medals/headline on every
	// subsequent gameOver frame.
	try {
		recapRenderClip(item, winX, winY, winW, winH);
		recapDrawBadges(item, winX, winY);
	} finally {
		gameContext.restore();
	}
}

// Corner icon badges using the game's established iconography: one per active
// brutal round (brutalRoundImages[id] — puck for hockey, cloud for cloudy, moon
// for blackout, etc.) plus the blindfold ability if it fired. Full-screen effects
// (cloudy/blackout/blindfold) are badged, never rendered — they'd obscure the clip.
function recapDrawBadges(item, winX, winY) {
	// Collect the icon images to show: brutal-round icons + blindfold.
	var icons = [];
	if (item.brutal != null && typeof brutalRoundImages !== "undefined" && brutalRoundImages != null) {
		for (var i = 0; i < item.brutal.length; i++) {
			var img = brutalRoundImages[item.brutal[i]];
			if (img != null) { icons.push(img); }
		}
	}
	if (item.blind && typeof blindfoldIcon !== "undefined" && blindfoldIcon != null) {
		icons.push(blindfoldIcon);
	}
	if (icons.length === 0) {
		return;
	}
	var bw = 28, bh = 26, gap = 4;
	gameContext.save();
	for (var k = 0; k < icons.length; k++) {
		var bx = winX + 6 + k * (bw + gap);
		var by = winY + 6;
		// Light tile so the dark game icons read (they're black silhouettes).
		gameContext.fillStyle = "rgba(255,255,255,0.82)";
		gameContext.fillRect(bx, by, bw, bh);
		gameContext.strokeStyle = "rgba(0,0,0,0.55)";
		gameContext.lineWidth = 1.5;
		gameContext.strokeRect(bx, by, bw, bh);
		var ic = icons[k];
		if (ic.complete !== false && (ic.naturalWidth == null || ic.naturalWidth > 0)) {
			try {
				var ratio = (ic.width && ic.height) ? (ic.height / ic.width) : 0.88;
				var iw = bw - 8;
				var ih = iw * ratio;
				if (ih > bh - 6) { ih = bh - 6; iw = ih / ratio; }
				gameContext.drawImage(ic, bx + (bw - iw) / 2, by + (bh - ih) / 2, iw, ih);
			} catch (e) { /* icon not decoded — skip, badge tile still flags it */ }
		}
	}
	gameContext.restore();
}

// Render the current frame of `item`'s clip with a zoom-and-follow camera, using
// the SAME map snapshot + kart/FX helpers as the live game so the replay carries
// the real flames, ability aimers and infection auras — not flat dots.
function recapRenderClip(item, winX, winY, winW, winH) {
	if (item.maps == null || item.maps.length === 0 || item.maps[0].world == null || item.maps[0].world.width == null) {
		return;
	}
	var frame = recapFrameAt(item.frames, recapElapsed, recapEffectiveStartT(item));
	if (frame == null) {
		return;
	}
	var frameT = frame.t;
	// The map as it looked at this clip moment (collapse lava / swaps evolve). Use
	// THIS snapshot's own world rect for placement + camera math so they can't
	// disagree with the blitted image.
	var map = recapMapAt(item.maps, frameT);
	var w = (map != null && map.world != null) ? map.world : item.maps[0].world;

	// Scale: start from fit-to-window, then zoom in on the action.
	var fit = Math.min(winW / w.width, winH / w.height);
	var s = fit * RECAP_ZOOM;

	// Follow target: the involved players (centroid), clamped so the zoomed view
	// stays inside the map (no empty gutters). Smoothed so the cam glides.
	var focus = recapFocusCenter(item, frame, w);
	var halfW = (winW / 2) / s;
	var halfH = (winH / 2) / s;
	if (w.width > 2 * halfW) {
		focus.x = Math.max(w.x + halfW, Math.min(w.x + w.width - halfW, focus.x));
	} else {
		focus.x = w.x + w.width / 2;
	}
	if (w.height > 2 * halfH) {
		focus.y = Math.max(w.y + halfH, Math.min(w.y + w.height - halfH, focus.y));
	} else {
		focus.y = w.y + w.height / 2;
	}
	if (recapCamX == null || recapCamY == null) {
		recapCamX = focus.x;
		recapCamY = focus.y;
	} else {
		recapCamX += (focus.x - recapCamX) * RECAP_CAM_LERP;
		recapCamY += (focus.y - recapCamY) * RECAP_CAM_LERP;
	}

	// One world->window transform: screen = winCentre + (world - camera) * scale.
	// Every draw below is in world coordinates. The FX helpers add the live camera
	// offset internally, but it's zero on the gameOver screen, so they line up.
	// A captured impact's screen-shake jitters the whole clip view (screen-space,
	// before the scale), mirroring the live preShake — magnitude scales with trauma².
	var screenCX = winX + winW / 2;
	var screenCY = winY + winH / 2;
	// Combine the captured per-frame trauma with a contribution from any explosion
	// playing right now — the explosion's own addTrauma can land between server
	// ticks and be missed by the per-tick trauma sample, so derive shake from the
	// effect too, guaranteeing a blast actually shakes the clip.
	var trauma = frame.trauma || 0;
	if (item.effects != null) {
		for (var se = 0; se < item.effects.length; se++) {
			var ef = item.effects[se];
			if (ef.type !== "explosion") { continue; }
			var eage = frameT - ef.t;
			if (eage >= 0 && eage < 350) { trauma = Math.max(trauma, 0.55 * (1 - eage / 350)); }
		}
	}
	var shakeDx = 0, shakeDy = 0;
	if (trauma > 0) {
		var maxOff = (typeof maxShakeOffset !== "undefined") ? maxShakeOffset : 18;
		var mag = maxOff * trauma * trauma;
		shakeDx = (Math.random() * 2 - 1) * mag;
		shakeDy = (Math.random() * 2 - 1) * mag;
	}
	// Slow the flame sprite animation to match the clip's slow-mo (drawFire reads the
	// global dt). Saved + restored in the finally so a throw can't leave it scaled.
	var savedDt = (typeof dt !== "undefined") ? dt : null;
	if (savedDt != null && RECAP_SLOWMO > 0) { dt = savedDt / RECAP_SLOWMO; }
	gameContext.save();
	// try/finally: ANY helper below can throw (it reuses live draw code); the
	// finally guarantees the transform/clip save is popped, so a single bad frame
	// can't leave the whole gameOver screen clipped/zoomed on later frames.
	try {
		gameContext.translate(screenCX + shakeDx, screenCY + shakeDy);
		gameContext.scale(s, s);
		gameContext.translate(-recapCamX, -recapCamY);

		// Blit this clip-moment's map snapshot under the camera.
		if (map != null && map.image != null) {
			// Snapshots are downscaled to save memory; blit back up to full world size.
			var mscale = (map.scale != null && map.scale > 0) ? map.scale : 1;
			var fullW = map.image.width / mscale;
			var fullH = map.image.height / mscale;
			gameContext.drawImage(map.image, w.x - map.pad, w.y - map.pad, fullW, fullH);
		}

		// Match the live draw order: hazards, then trails, then karts, then projectiles.
		if (frame.hazards != null) {
			for (var h = 0; h < frame.hazards.length; h++) { recapDrawHazard(frame.hazards[h]); }
		}
		recapDrawTrails(item, frameT);
		// Ice reflections sit OVER the terrain and UNDER the karts (matches the live
		// drawTerrainFX order), so cast them before drawing the karts themselves.
		recapDrawIceReflections(item, frame);
		for (var i = 0; i < frame.players.length; i++) {
			recapDrawCar(frame.players[i], item.exits, frameT);
		}
		if (frame.projs != null) {
			for (var pj = 0; pj < frame.projs.length; pj++) { recapDrawProjectile(frame.projs[pj]); }
		}
		// Effects layer sits ABOVE projectiles (matches the live draw order): movement
		// dust + burn embers per kart, one-shot FX (explosions/muzzle/shockwaves), then
		// the targeting-aimer reticles.
		for (var pe = 0; pe < frame.players.length; pe++) {
			recapDrawKartParticles(frame.players[pe], frameT);
		}
		if (item.effects != null) {
			for (var e = 0; e < item.effects.length; e++) { recapDrawEffect(item.effects[e], frameT); }
		}
		if (frame.aimers != null) {
			for (var am = 0; am < frame.aimers.length; am++) { recapDrawAimer(frame.aimers[am], frameT); }
		}
	} finally {
		gameContext.restore();
		if (savedDt != null) { dt = savedDt; }
	}
}

// Kart trails: reproduce the live colored trail line by stroking each kart's
// buffered path up to the current clip time (grows as the clip plays, loops with
// it). Mirrors the live Trail look (width 5, soft black shadow, kart colour).
// The path ends where a kart died/scored. Whole-round trails aren't available —
// only the clip's buffered window — so it's the recent path, not the full lap.
function recapDrawTrails(item, frameT) {
	var frames = item.frames;
	var tracks = {}; // id -> flat [x0,y0,x1,y1,...]
	var vertsBy = {}; // id -> [{x,y,t}] for the rich trail renderers
	var order = [];
	for (var fi = 0; fi < frames.length; fi++) {
		var f = frames[fi];
		if (f.t > frameT) {
			break;
		}
		var ps = f.players;
		for (var pi = 0; pi < ps.length; pi++) {
			var pr = ps[pi];
			if (pr[RF_STATE] !== RECAP_ALIVE) {
				continue; // trail stops where the kart left play
			}
			var id = pr[RF_ID];
			if (tracks[id] == null) { tracks[id] = []; vertsBy[id] = []; order.push(id); }
			tracks[id].push(pr[RF_X], pr[RF_Y]);
			vertsBy[id].push({ x: pr[RF_X], y: pr[RF_Y], t: f.t });
		}
	}
	for (var oi = 0; oi < order.length; oi++) {
		var pts = tracks[order[oi]];
		if (pts.length < 4) {
			continue;
		}
		var meta = recapMeta[order[oi]] || { color: "grey" };
		// Cosmetic trail effect: dispatch to the same rich renderer as live racing using
		// timestamped verts; falls back to the plain colour stroke.
		var tfxId = (typeof getTrailEffect === "function" && meta.trailFx) ? getTrailEffect(meta.trailFx) : null;
		var fx = (tfxId && typeof TRAIL_FX !== "undefined") ? TRAIL_FX[tfxId] : null;
		if (fx) {
			var verts = vertsBy[order[oi]];
			if (verts && verts.length >= 2) {
				var fadeMs = (typeof TRAIL_FADE_MS !== "undefined") ? TRAIL_FADE_MS : 5000;
				var anim = (typeof cartSkinAnimTime !== "undefined") ? cartSkinAnimTime * 1000 : frameT;
				if (typeof tfxBaseAlpha !== "undefined") { tfxBaseAlpha = 1; }
				try { fx(gameContext, verts, meta.color, frameT, fadeMs, anim); } catch (e) {}
			}
			continue;
		}
		gameContext.save();
		gameContext.lineWidth = 5;
		gameContext.lineCap = "round";
		gameContext.lineJoin = "round";
		gameContext.shadowBlur = 3;
		gameContext.shadowColor = "black";
		gameContext.strokeStyle = meta.color;
		gameContext.beginPath();
		gameContext.moveTo(pts[0], pts[1]);
		for (var k = 2; k < pts.length; k += 2) {
			gameContext.lineTo(pts[k], pts[k + 1]);
		}
		gameContext.stroke();
		gameContext.restore();
	}
}

// Procedural movement dust + burn embers for one kart, driven purely by the
// buffered state (velocity / onFire) and the clip clock — no persistent particle
// list needed, and it loops cleanly with the clip. Skips exited karts.
function recapDrawKartParticles(pr, frameT) {
	if (pr[RF_STATE] !== RECAP_ALIVE) {
		return;
	}
	var x = pr[RF_X], y = pr[RF_Y];
	var meta = recapMeta[pr[RF_ID]] || { radius: 12 };
	var rad = meta.radius || 12;
	// Burn embers: a few rising, cooling sparks while on fire.
	if (pr[RF_FIRE] > 0) {
		var emberN = (typeof perfCount === "function") ? perfCount(4) : 4;
		for (var k = 0; k < emberN; k++) {
			var ph = (((frameT + k * 150) % 600) / 600);
			var ex = x + Math.sin(k * 1.7 + frameT / 180) * rad * 0.5;
			var ey = y - ph * (rad * 1.8 + 8);
			gameContext.save();
			gameContext.globalAlpha = (1 - ph) * 0.9;
			gameContext.fillStyle = "hsl(" + (18 + k * 9) + ", 100%, " + (62 - 22 * ph) + "%)";
			gameContext.beginPath();
			gameContext.arc(ex, ey, 2.5 * (1 - ph) + 0.6, 0, 2 * Math.PI);
			gameContext.fill();
			gameContext.restore();
		}
	}
	// Movement dust: puffs kicked out behind a kart that's actually moving.
	var sp = Math.sqrt(pr[RF_VX] * pr[RF_VX] + pr[RF_VY] * pr[RF_VY]);
	var walk = (typeof config !== "undefined" && config != null && config.playerMaxSpeed) ? config.playerMaxSpeed * 0.18 : 1.2;
	if (sp > walk) {
		var dir = Math.atan2(pr[RF_VY], pr[RF_VX]);
		var dustN = (typeof perfCount === "function") ? perfCount(3) : 3;
		for (var d = 0; d < dustN; d++) {
			var dph = (((frameT + d * 130) % 420) / 420);
			var dist = rad + dph * 16;
			var jit = (d - 1) * rad * 0.4;
			var px = x - Math.cos(dir) * dist - Math.sin(dir) * jit;
			var py = y - Math.sin(dir) * dist + Math.cos(dir) * jit;
			gameContext.save();
			gameContext.globalAlpha = (1 - dph) * 0.5;
			gameContext.fillStyle = "rgba(190,175,150,1)";
			gameContext.beginPath();
			gameContext.arc(px, py, 2.6 * (1 - dph) + 0.8, 0, 2 * Math.PI);
			gameContext.fill();
			gameContext.restore();
		}
	}
	gameContext.globalAlpha = 1;
}

// Replay a one-shot effect at the clip's current footage time. The clip loops, so
// frameT cycles and the effect re-fires each loop. Slow-mo applies for free (it's
// driven by the footage timeline, which the playback window stretches).
function recapDrawEffect(ef, frameT) {
	var age = frameT - ef.t;
	if (age < 0) {
		return;
	}
	if (ef.type === "explosion") {
		if (age <= RECAP_EXPLOSION_MS) {
			recapDrawExplosion(ef.x, ef.y, ef.params.radius || 70, ef.params.color || "#ff7a18", age / RECAP_EXPLOSION_MS);
		}
	} else if (ef.type === "muzzle") {
		if (age <= RECAP_MUZZLE_MS) {
			recapDrawMuzzle(ef.x, ef.y, ef.params.angle || 0, ef.params.color || "#ffcf8f", age / RECAP_MUZZLE_MS);
		}
	} else if (ef.type === "shockwave") {
		if (age <= RECAP_SHOCKWAVE_MS) {
			recapDrawShockwave(ef.x, ef.y, age / RECAP_SHOCKWAVE_MS);
		}
	} else if (ef.type === "punch") {
		if (age <= RECAP_PUNCH_MS) {
			recapDrawPunch(ef.x, ef.y, ef.params.radius || 24, ef.params.color || "white", age / RECAP_PUNCH_MS);
		}
	} else if (ef.type === "hit") {
		if (age <= RECAP_HIT_MS) {
			recapDrawHit(ef.x, ef.y, ef.params.color || "white", age / RECAP_HIT_MS);
		}
	} else if (ef.type === "clash") {
		if (age <= RECAP_CLASH_MS) {
			recapDrawClash(ef.x, ef.y, age / RECAP_CLASH_MS);
		}
	}
}

// Punch shockwave: an impact pop + expanding ring. Mirrors draw.js spawnPunchEffect
// (the omnidirectional radial burst); t is 0..1 over its lifetime.
function recapDrawPunch(x, y, baseRadius, color, t) {
	var grow = 1 - Math.pow(1 - t, 3); // easeOutCubic
	gameContext.save();
	gameContext.lineCap = "round";
	gameContext.globalAlpha = (1 - t) * 0.5;
	gameContext.fillStyle = color;
	gameContext.beginPath();
	gameContext.arc(x, y, baseRadius * (0.55 + 0.75 * grow), 0, 2 * Math.PI);
	gameContext.fill();
	gameContext.globalAlpha = (1 - t);
	gameContext.lineWidth = 2 * (1 - t) + 1;
	gameContext.strokeStyle = color;
	gameContext.beginPath();
	gameContext.arc(x, y, baseRadius * (0.8 + 0.8 * grow), 0, 2 * Math.PI);
	gameContext.stroke();
	gameContext.restore();
	gameContext.globalAlpha = 1;
}

// Landed-hit burst: a white flash ring + radiating sparks. Mirrors draw.js
// spawnHitEffect; t is 0..1 over its lifetime.
function recapDrawHit(x, y, color, t) {
	var p = 1 - Math.pow(1 - t, 3); // easeOutCubic
	gameContext.save();
	gameContext.translate(x, y);
	gameContext.lineCap = "round";
	gameContext.globalAlpha = (1 - t);
	gameContext.strokeStyle = "white";
	gameContext.lineWidth = 3 * (1 - t) + 1;
	gameContext.beginPath();
	gameContext.arc(0, 0, 6 + 22 * p, 0, 2 * Math.PI);
	gameContext.stroke();
	gameContext.strokeStyle = color || "white";
	gameContext.lineWidth = 2 * (1 - t) + 1;
	for (var i = 0; i < 6; i++) {
		var a = (i / 6) * Math.PI * 2 + 0.3;
		var r0 = 2.8 + 8.4 * p;
		var r1 = 8.4 + 18.2 * p;
		gameContext.beginPath();
		gameContext.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
		gameContext.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
		gameContext.stroke();
	}
	gameContext.restore();
	gameContext.globalAlpha = 1;
}

// Parry clash: a gold-over-white double ring + four-point spark star. Mirrors
// draw.js spawnClashEffect; t is 0..1 over its lifetime.
function recapDrawClash(x, y, t) {
	var p = 1 - Math.pow(1 - t, 3); // easeOutCubic
	gameContext.save();
	gameContext.translate(x, y);
	gameContext.lineCap = "round";
	gameContext.globalAlpha = (1 - t) * 0.9;
	gameContext.strokeStyle = "#ffd34d";
	gameContext.lineWidth = 3 * (1 - t) + 1.5;
	gameContext.beginPath();
	gameContext.arc(0, 0, 4 + 26 * p, 0, 2 * Math.PI);
	gameContext.stroke();
	gameContext.globalAlpha = (1 - t) * 0.7;
	gameContext.strokeStyle = "white";
	gameContext.lineWidth = 2 * (1 - t) + 1;
	gameContext.beginPath();
	gameContext.arc(0, 0, 2 + 16 * p, 0, 2 * Math.PI);
	gameContext.stroke();
	gameContext.globalAlpha = (1 - t);
	gameContext.strokeStyle = "#fff4c2";
	gameContext.lineWidth = 2 * (1 - t) + 1;
	var reach = 8 + 20 * p;
	for (var i = 0; i < 4; i++) {
		var a = (Math.PI / 4) + i * (Math.PI / 2);
		gameContext.beginPath();
		gameContext.moveTo(Math.cos(a) * reach * 0.35, Math.sin(a) * reach * 0.35);
		gameContext.lineTo(Math.cos(a) * reach, Math.sin(a) * reach);
		gameContext.stroke();
	}
	gameContext.restore();
	gameContext.globalAlpha = 1;
}

// Cast each alive kart's ice reflection, clipped to the round's ice footprint.
// Mirrors terrainfx.js tfxDrawIceReflections, but reads buffered frame positions
// (not the live playerList) and paths the captured ice verts directly (the live
// frustum-cull path keys off the in-game camera, which is inactive on gameOver).
function recapDrawIceReflections(item, frame) {
	var ice = (item != null) ? item.ice : null;
	if (ice == null || ice.length === 0 || frame == null || frame.players == null) {
		return;
	}
	var ctx = gameContext;
	ctx.save();
	ctx.beginPath();
	for (var c = 0; c < ice.length; c++) {
		var verts = ice[c];
		if (verts == null || verts.length === 0) { continue; }
		ctx.moveTo(verts[0].x, verts[0].y);
		for (var v = 1; v < verts.length; v++) { ctx.lineTo(verts[v].x, verts[v].y); }
		ctx.closePath();
	}
	ctx.clip();
	var useBlur = (typeof perfGlow === "function") ? perfGlow() : true;
	for (var i = 0; i < frame.players.length; i++) {
		var pr = frame.players[i];
		if (pr[RF_STATE] !== RECAP_ALIVE) { continue; }
		var p = recapAppearance(pr);
		var rad = p.radius || 16;
		var pivot = p.y + rad * 1.95;
		ctx.save();
		ctx.globalAlpha = 0.38;
		if (useBlur && "filter" in ctx) { ctx.filter = "blur(2.5px)"; }
		ctx.translate(p.x, pivot);
		ctx.scale(1.0, -0.85);
		ctx.translate(-p.x, -pivot);
		if (typeof drawKartAppearance === "function") {
			try { drawKartAppearance(p, p.x, pivot); } catch (e) { /* keep the montage alive */ }
		}
		ctx.restore();
	}
	ctx.restore();
}

// The minimal synthetic player the kart-appearance helpers need (skin-aware draw).
// World coords; the helpers' internal camera offset is zero on the gameOver screen.
function recapAppearance(pr) {
	var meta = recapMeta[pr[RF_ID]] || { color: "grey", radius: 12 };
	return {
		id: pr[RF_ID], x: pr[RF_X], y: pr[RF_Y], angle: pr[RF_ANGLE],
		velX: pr[RF_VX], velY: pr[RF_VY], color: meta.color,
		radius: (meta.radius != null) ? meta.radius : 12, onFire: pr[RF_FIRE],
		cart: meta.cart, pattern: meta.pattern, trailFx: meta.trailFx, border: meta.border
	};
}

// Muzzle flash: a short flash cone + white streaks in the firing direction.
// Mirrors draw.js spawnMuzzleFlash; t is 0..1 over its lifetime.
function recapDrawMuzzle(x, y, angleDeg, color, t) {
	var a = angleDeg * Math.PI / 180;
	var p = 1 - Math.pow(1 - t, 3); // easeOutCubic
	var reach = 8 + 20 * p;
	var spread = 6 * (1 - t) + 3;
	gameContext.save();
	gameContext.translate(x, y);
	gameContext.rotate(a);
	gameContext.globalAlpha = (1 - t) * 0.9;
	gameContext.fillStyle = color;
	gameContext.beginPath();
	gameContext.moveTo(0, 0);
	gameContext.lineTo(reach, -spread);
	gameContext.lineTo(reach + 6, 0);
	gameContext.lineTo(reach, spread);
	gameContext.closePath();
	gameContext.fill();
	gameContext.globalAlpha = (1 - t);
	gameContext.strokeStyle = "white";
	gameContext.lineCap = "round";
	gameContext.lineWidth = 2 * (1 - t) + 0.5;
	for (var i = -1; i <= 1; i++) {
		gameContext.beginPath();
		gameContext.moveTo(2, i * 3);
		gameContext.lineTo(reach * 0.8, i * 4);
		gameContext.stroke();
	}
	gameContext.restore();
	gameContext.globalAlpha = 1;
}

// Collapse shockwave: an expanding fading ring (one pass of the live telegraph).
function recapDrawShockwave(x, y, t) {
	var radius = 600 * (t * RECAP_SHOCKWAVE_MS / 1000); // 600 px/s, same as the live ring
	gameContext.save();
	gameContext.globalAlpha = (1 - t) * 0.6;
	gameContext.strokeStyle = "rgba(255,120,40,1)";
	gameContext.lineWidth = 4 * (1 - t) + 1;
	gameContext.beginPath();
	gameContext.arc(x, y, radius, 0, 2 * Math.PI);
	gameContext.stroke();
	gameContext.restore();
	gameContext.globalAlpha = 1;
}

// Targeting-aimer reticle (swap / explosion countdown), driven by the captured
// countdown progress. Mirrors draw.js drawAimer's look with a clip-clock pulse.
function recapDrawAimer(a, frameT) {
	var x = a[0], y = a[1], radius = a[2], kind = a[3], prog = a[4], color = a[5];
	var phase = (frameT / 1000) * (2 + 5 * prog) * Math.PI * 2;
	var pulse = 0.5 + 0.5 * Math.sin(phase);
	gameContext.save();
	gameContext.beginPath();
	gameContext.arc(x, y, radius, 0, 2 * Math.PI);
	if (kind === 1) { // explosion warn: fill swells as it charges
		gameContext.fillStyle = color;
		gameContext.globalAlpha = (0.12 + 0.5 * prog) * pulse;
		gameContext.fill();
		gameContext.globalAlpha = 1;
		gameContext.setLineDash([15, 3, 3, 3]);
		gameContext.lineWidth = 2 + 5 * pulse;
		gameContext.strokeStyle = color;
	} else { // swap countdown: dashed ring that reddens as it nears
		gameContext.setLineDash([15, 3, 3, 3]);
		gameContext.lineWidth = 2 + 8 * (pulse * (0.4 + 0.6 * prog));
		gameContext.strokeStyle = prog > 0.66 ? "red" : "black";
		gameContext.globalAlpha = 0.45 + 0.55 * pulse;
	}
	gameContext.stroke();
	gameContext.restore();
	gameContext.globalAlpha = 1;
}

// Bloom-and-fade explosion, mirrored from draw.js spawnExplosion so a replayed
// detonation looks like the real one. World coords; t is 0..1 over its lifetime.
function recapDrawExplosion(x, y, radius, color, t) {
	var p = 1 - Math.pow(1 - t, 3); // easeOutCubic
	gameContext.save();
	gameContext.translate(x, y);
	var coreR = radius * (0.4 + 0.9 * p);
	var grad = gameContext.createRadialGradient(0, 0, 0, 0, 0, coreR);
	grad.addColorStop(0, "rgba(255,245,200," + (1 - t) + ")");
	grad.addColorStop(0.5, color);
	grad.addColorStop(1, "rgba(0,0,0,0)");
	gameContext.globalAlpha = (1 - t) * 0.85;
	gameContext.fillStyle = grad;
	gameContext.beginPath();
	gameContext.arc(0, 0, coreR, 0, 2 * Math.PI);
	gameContext.fill();
	gameContext.globalAlpha = (1 - t);
	gameContext.strokeStyle = "rgba(255,255,255,0.9)";
	gameContext.lineWidth = 3 * (1 - t) + 1;
	gameContext.beginPath();
	gameContext.arc(0, 0, radius * (0.6 + 1.0 * p), 0, 2 * Math.PI);
	gameContext.stroke();
	gameContext.fillStyle = color;
	for (var i = 0; i < 10; i++) {
		var a = (i / 10) * Math.PI * 2 + 0.2;
		var r = radius * (0.3 + 1.1 * p);
		gameContext.globalAlpha = (1 - t);
		gameContext.beginPath();
		gameContext.arc(Math.cos(a) * r, Math.sin(a) * r, 2.5 * (1 - t) + 0.5, 0, 2 * Math.PI);
		gameContext.fill();
	}
	gameContext.restore();
	gameContext.globalAlpha = 1;
}

// Draw one buffered kart at its world position. Alive -> the real sprite plus any
// flame / ability indicator / infection aura. Dead or scored -> a brief poof at
// the exit spot, then nothing (so it doesn't hover over lava/goal for the clip).
function recapDrawCar(pr, exits, frameT) {
	var id = pr[RF_ID];
	var meta = recapMeta[id] || { color: "grey", radius: 12 };
	if (pr[RF_STATE] !== RECAP_ALIVE) {
		var ex = (exits != null) ? exits[id] : null;
		if (ex == null) {
			return;
		}
		var since = frameT - ex.t;
		if (since < 0 || since > RECAP_EXIT_FX_MS) {
			return; // exited before this frame's poof window, or already faded — gone
		}
		recapDrawExitFx(ex, since / RECAP_EXIT_FX_MS, meta.color);
		return;
	}

	// A synthetic player object the live FX helpers understand. World coords; the
	// helpers' internal camera offset is zero on the gameOver screen.
	var p = {
		id: id, x: pr[RF_X], y: pr[RF_Y], angle: pr[RF_ANGLE],
		velX: pr[RF_VX], velY: pr[RF_VY], color: meta.color,
		radius: meta.radius, onFire: pr[RF_FIRE], ability: pr[RF_ABILITY],
		name: meta.name,
		cart: meta.cart, pattern: meta.pattern, trailFx: meta.trailFx, border: meta.border,
		// rebuild the buff/debuff window flags drawSpeedFx checks (future expiry = active)
		speedBuffUntil: pr[RF_SPEEDFX] === 1 ? Date.now() + 99999 : null,
		speedDebuffUntil: pr[RF_SPEEDFX] === 2 ? Date.now() + 99999 : null
	};
	// Punch lunge: drawCartSkin animates off (Date.now() - punchAnimAt), so anchor
	// punchAnimAt the captured age back from now to replay the lunge at this frame.
	var recapPunchAge = pr[RF_PUNCH];
	if (recapPunchAge != null && recapPunchAge >= 0) {
		p.punchAnimAt = Date.now() - recapPunchAge;
	}
	// Emote: captured as [msg, ageMs, durationMs] (or a plain string from the demo).
	// Reconstruct chatMessageAt so drawEmoji applies its normal fade-out instead of a
	// static full-strength bubble for the whole looped clip.
	var em = pr[RF_EMOTE];
	if (em != null) {
		if (typeof em === "string") {
			p.chatMessage = em;
		} else {
			p.chatMessage = em[0];
			p.chatMessageAt = Date.now() - (em[1] || 0);
			p.chatMessageDuration = em[2] || 4000;
		}
	}

	// Speed buff/debuff streaks — reuse the live helper (needs velX/velY + radius).
	if (typeof drawSpeedFx === "function") {
		drawSpeedFx(p);
	}

	// Infection aura (matches drawPlayer's infected ring) if this kart is a zombie.
	if (pr[RF_INFECTED] && typeof config !== "undefined" && config != null && config.brutalRounds != null &&
		config.brutalRounds.infection != null && typeof patterns !== "undefined" &&
		patterns != null && patterns[config.brutalRounds.infection.id] != null) {
		gameContext.save();
		gameContext.beginPath();
		gameContext.lineWidth = 1;
		gameContext.arc(p.x, p.y, config.brutalRounds.infection.radius, 0, 2 * Math.PI);
		gameContext.fillStyle = patterns[config.brutalRounds.infection.id];
		gameContext.fill();
		gameContext.strokeStyle = "green";
		gameContext.stroke();
		gameContext.restore();
	}

	// Burn flame BEHIND the body/skin (matches live play) — the big flame sprite would
	// otherwise engulf the small kart and hide the skin entirely.
	if (p.onFire > 0 && typeof drawFire === "function") {
		drawFire(p);
	}

	// Kart body: a procedural cart skin replaces the coloured disc (matches live play,
	// where the skin is tinted by the player's colour and the base disc is suppressed).
	// Independent body cosmetics: border (p.border) rings ANY cart; pattern (p.pattern) is
	// sphere-only. Both can be present.
	// Border FIRST (behind the body) so the cart always sits on top.
	var recapBskin = (typeof getSkin === "function" && p.border) ? getSkin(p.border) : null;
	if (recapBskin && recapBskin.slot === 'border' && typeof drawBorderOverlay === "function") {
		var recapBorder0 = (typeof getSkinPainter === "function") ? getSkinPainter(p.border) : null;
		if (recapBorder0 != null) { try { drawBorderOverlay(p, p.x, p.y, p.radius, recapBorder0); } catch (e) {} }
	}
	var recapPainter = (typeof cartSkinPainter === "function") ? cartSkinPainter(p.cart) : null;
	if (recapPainter != null && typeof drawCartSkin === "function") {
		try {
			drawCartSkin(p, p.x, p.y, p.radius, recapPainter);
		} catch (e) { /* skin painter threw — skip, keep the montage alive */ }
	} else if (typeof getPlayerSprite === "function") {
		// The cached kart sprite (a coloured disc), blitted at world coords.
		var sprite = getPlayerSprite(p.color, p.radius, "black");
		try {
			gameContext.drawImage(sprite, p.x - sprite.halfSize, p.y - sprite.halfSize);
		} catch (e) { /* an undecoded sprite — skip this kart, keep the montage alive */ }
		// Pattern overlay on the plain sphere cart (patterns are sphere-scoped).
		var recapPskin = (typeof getSkin === "function" && p.pattern) ? getSkin(p.pattern) : null;
		if (recapPskin && recapPskin.slot === 'pattern') {
			var recapPat = (typeof getSkinPainter === "function") ? getSkinPainter(p.pattern) : null;
			if (recapPat != null && typeof drawPatternOverlay === "function") {
				try { drawPatternOverlay(p, p.x, p.y, p.radius, recapPat); } catch (e) {}
			}
		}
	}

	if (p.ability != null && typeof drawAbilityIndicator === "function") {
		drawAbilityIndicator(p.x, p.y, p);
	}
	// Emote bubble + name label (reuse the live helpers; world coords).
	if (p.chatMessage != null && typeof drawEmoji === "function") {
		drawEmoji(p);
	}
	if (p.name != null && typeof drawBotName === "function") {
		drawBotName(p);
	}
}

// One-shot exit flourish: a quick expanding ring + a rising marker (skull for a
// death, star for a goal) that fades over RECAP_EXIT_FX_MS. Drawn in world coords.
function recapDrawExitFx(ex, t, color) {
	var alpha = 1 - t;
	gameContext.save();
	gameContext.globalAlpha = alpha;
	gameContext.beginPath();
	gameContext.arc(ex.x, ex.y, 6 + t * 18, 0, 2 * Math.PI);
	gameContext.strokeStyle = (ex.state === RECAP_SCORED) ? "gold" : (color || "white");
	gameContext.lineWidth = 2;
	gameContext.stroke();
	gameContext.font = "18px serif";
	gameContext.textAlign = "center";
	gameContext.fillStyle = (ex.state === RECAP_SCORED) ? "gold" : "white"; // set explicitly so the glyph isn't drawn in leftover fill
	gameContext.fillText(ex.state === RECAP_SCORED ? "⭐" : "💀", ex.x, ex.y - 6 - t * 14);
	gameContext.textAlign = "left";
	gameContext.restore();
	gameContext.globalAlpha = 1;
}

// Replay one buffered projectile. Mirrors drawProjectiles, but spins from the
// wall clock (the live per-object rotation isn't buffered) — close enough for a
// short clip. World coords; wrapped so a missing/undecoded image can't break it.
function recapDrawProjectile(pr) {
	var type = pr[RP_TYPE], x = pr[RP_X], y = pr[RP_Y];
	if (x == null) {
		return;
	}
	if (type === "cloud") {
		return; // cloudy is a vision effect — shown as a corner badge, not rendered (would obscure the clip)
	}
	var rot = (Date.now() * 0.02) % 360 * (Math.PI / 180); // shared gentle spin
	try {
		if (type === "puck") {
			gameContext.save();
			gameContext.beginPath();
			gameContext.fillStyle = pr[RP_COLOR] || "black";
			gameContext.arc(x, y, (pr[RP_RADIUS] > 0 ? pr[RP_RADIUS] : 8), 0, 2 * Math.PI);
			gameContext.fill();
			gameContext.restore();
		} else if (type === "bomb" && typeof bombImage !== "undefined" && bombImage) {
			var bs = (typeof bombScale !== "undefined") ? bombScale : 0.025;
			gameContext.save();
			gameContext.translate(x, y);
			gameContext.rotate(rot);
			gameContext.scale(bs, bs);
			gameContext.drawImage(bombImage, -bombImage.width * 2, -bombImage.height * 2);
			gameContext.restore();
		} else if (type === "snowFlake" && typeof snowFlakeImage !== "undefined" && snowFlakeImage) {
			gameContext.save();
			gameContext.translate(x, y);
			gameContext.rotate(rot);
			gameContext.scale(snowFlakeImage.scale || 0.05, snowFlakeImage.scale || 0.05);
			gameContext.drawImage(snowFlakeImage, -snowFlakeImage.width / 2, -snowFlakeImage.height / 2);
			gameContext.restore();
		} else if (type === "cloud" && typeof cloudImage !== "undefined" && cloudImage) {
			gameContext.save();
			gameContext.translate(x, y);
			gameContext.rotate(rot);
			gameContext.scale(cloudImage.scale || 1, cloudImage.scale || 1);
			gameContext.drawImage(cloudImage, -cloudImage.width / 2, -cloudImage.height / 2);
			gameContext.restore();
		}
	} catch (e) { /* undecoded image — skip this prop, keep the montage alive */ }
}

// Replay one buffered hazard (static / moving bumper) via the live draw helpers.
function recapDrawHazard(h) {
	if (typeof config === "undefined" || config == null || config.hazards == null || h[RH_X] == null) {
		return;
	}
	try {
		if (config.hazards.bumper != null && h[RH_ID] === config.hazards.bumper.id && typeof drawBumper === "function") {
			drawBumper(h[RH_X], h[RH_Y]);
		} else if (config.hazards.movingBumper != null && h[RH_ID] === config.hazards.movingBumper.id && typeof drawMovingBumper === "function") {
			drawMovingBumper(h[RH_X], h[RH_Y], h[RH_RAILX], h[RH_RAILY], h[RH_ANGLE]);
		}
	} catch (e) { /* defensive — never let a prop break gameOver */ }
}

// Where the camera should look this frame: the centroid of the highlight's
// involved players, falling back to all live players, then the map centre.
function recapFocusCenter(item, frame, w) {
	var sumX = 0, sumY = 0, n = 0;
	// focusIds (if set) drives the camera independently of the subject ids that
	// caption/chips use — lets a clip frame extra karts (e.g. nearby zombies)
	// without changing whose moment it is.
	var ids = (item != null && item.focusIds != null) ? item.focusIds
		: ((item != null && item.ids != null) ? item.ids : []);
	for (var i = 0; i < frame.players.length; i++) {
		var pr = frame.players[i];
		for (var k = 0; k < ids.length; k++) {
			if (pr[RF_ID] === ids[k]) {
				sumX += pr[RF_X]; sumY += pr[RF_Y]; n++;
				break;
			}
		}
	}
	if (n === 0) { // no involved players in this frame — track the survivors
		for (var j = 0; j < frame.players.length; j++) {
			if (frame.players[j][RF_STATE] === RECAP_ALIVE) {
				sumX += frame.players[j][RF_X]; sumY += frame.players[j][RF_Y]; n++;
			}
		}
	}
	if (n === 0) { // everyone gone — track all captured dots
		for (var m = 0; m < frame.players.length; m++) {
			sumX += frame.players[m][RF_X]; sumY += frame.players[m][RF_Y]; n++;
		}
	}
	if (n === 0) {
		return { x: w.x + w.width / 2, y: w.y + w.height / 2 };
	}
	return { x: sumX / n, y: sumY / n };
}

// Pick the frame for the current loop position. The clip loops every
// RECAP_PLAY_MS (the slow-mo-stretched window); we map progress onto the frames'
// own timestamps, so the captured footage replays slower than real-time.
// Speed signal for lead-in trimming: the fastest FRAMED kart this frame (the
// subject ids the camera follows, or the whole alive field if none are present).
// Squared comparison internally; returns the real speed.
function recapClipSpeedSignal(frame, ids) {
	if (frame == null || frame.players == null) {
		return 0;
	}
	var subjMax = 0, sceneMax = 0, sawSubj = false;
	for (var i = 0; i < frame.players.length; i++) {
		var pr = frame.players[i];
		if (pr[RF_STATE] !== RECAP_ALIVE) { continue; }
		var vx = pr[RF_VX] || 0, vy = pr[RF_VY] || 0;
		var sp = vx * vx + vy * vy;
		if (sp > sceneMax) { sceneMax = sp; }
		if (ids != null && ids.length) {
			for (var k = 0; k < ids.length; k++) {
				if (pr[RF_ID] === ids[k]) { sawSubj = true; if (sp > subjMax) { subjMax = sp; } break; }
			}
		}
	}
	return Math.sqrt(sawSubj ? subjMax : sceneMax);
}

// The timestamp a clip should OPEN on: skip leading frames where the framed karts
// are barely moving, so the replay feels like a camera catching live action rather
// than a sim un-pausing from a frozen first frame. Bounded by RECAP_LEADIN_MAX_MS
// (and a fraction of the clip) so the highlight + its lead-up always survive.
// Memoized on the item — the speed scan is otherwise repeated every render frame.
function recapEffectiveStartT(item) {
	if (item == null || item.frames == null || item.frames.length < 2) {
		return (item != null && item.frames != null && item.frames.length) ? item.frames[0].t : null;
	}
	if (item._startT != null) {
		return item._startT;
	}
	var frames = item.frames;
	var t0 = frames[0].t;
	var span = frames[frames.length - 1].t - t0;
	var ids = (item.focusIds != null) ? item.focusIds : (item.ids != null ? item.ids : null);
	var speeds = [], peak = 0;
	for (var i = 0; i < frames.length; i++) {
		var s = recapClipSpeedSignal(frames[i], ids);
		speeds.push(s);
		if (s > peak) { peak = s; }
	}
	var startT = t0;
	if (peak > 0.1 && span > 0) { // there IS motion to find; a frozen scrum stays as-is
		var thresh = peak * RECAP_LEADIN_FRAC;
		var maxTrim = Math.min(RECAP_LEADIN_MAX_MS, span * 0.33);
		for (var j = 0; j < frames.length; j++) {
			if ((frames[j].t - t0) > maxTrim) { break; }
			if (speeds[j] >= thresh) { startT = frames[j].t; break; }
		}
	}
	item._startT = startT;
	return startT;
}

function recapFrameAt(frames, elapsedMs, startT) {
	if (frames == null || frames.length === 0) {
		return null;
	}
	if (frames.length === 1) {
		return frames[0];
	}
	// Open from the motion-onset time (startT) rather than the buffer's first frame,
	// so a clip catches the action already in progress (candid) instead of appearing
	// to start a fresh sim from a near-frozen pose. Defaults to frames[0].t.
	var t0 = (startT != null && startT >= frames[0].t && startT < frames[frames.length - 1].t)
		? startT : frames[0].t;
	var span = frames[frames.length - 1].t - t0;
	if (span <= 0) {
		return frames[frames.length - 1];
	}
	// Stretch playback: the captured span (~RECAP_CLIP_MS of real footage) is mapped
	// onto a longer RECAP_PLAY_MS window, so the action replays in slow motion.
	var progress = (elapsedMs % RECAP_PLAY_MS) / RECAP_PLAY_MS; // 0..1, loops
	var targetT = t0 + progress * span;
	// frames are time-ordered; linear scan (a clip is only ~90 frames)
	var best = frames[0];
	var bestDiff = Math.abs(best.t - targetT);
	for (var i = 1; i < frames.length; i++) {
		var diff = Math.abs(frames[i].t - targetT);
		if (diff < bestDiff) {
			bestDiff = diff;
			best = frames[i];
		}
	}
	return best;
}
