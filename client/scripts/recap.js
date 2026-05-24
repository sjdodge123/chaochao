// recap.js — End-of-game recap montage (client-only, MVP / Option A).
//
// Instead of capturing pixels or encoding real GIFs, we buffer the lightweight
// per-tick player positions the client already decodes every server tick
// (updatePlayerList), then on gameOver we replay short windows of that buffer
// into a small framed window — cycling one clip per achievement, credits style.
//
// Why this is cheap: the in-game camera is inactive (camera.active === false),
// so world coordinates map 1:1 onto gameCanvas. A clip renders by blitting the
// already-cached map (mapCanvas) and the buffered player dots through a single
// uniform scale into the recap window rect — no camera math, no per-frame
// pixel storage, no encoder. The whole buffer is just numbers.
//
// Highlight moments are derived from events the client already receives
// (deaths, multi-kills, sprees) so no server changes are needed; tying a clip
// to the *exact* play behind an achievement would need server-side timestamps
// and is left as a follow-up.

// --- tuning ---------------------------------------------------------------
var RECAP_BUFFER_MS = 14000;   // rolling history kept during the final round
var RECAP_CLIP_MS = 3000;      // playback length of each replayed clip
var RECAP_PRE_MS = 1200;       // portion of the clip BEFORE the highlight moment
var RECAP_DISPLAY_MS = 3500;   // how long each achievement + clip stays on screen
var RECAP_MAX_CLIPS = 4;       // keep the montage short within gameOverTime (20s)

// multi-kill achievement key -> the marker type recorded for it
var RECAP_TYPE_FOR_KEY = { doubleKill: "double", tripleKill: "triple", megaKill: "mega" };

// --- capture state --------------------------------------------------------
var recapFrames = [];   // [{ t, players: [[id, x, y, alive], ...] }]
var recapMarkers = [];  // [{ t, type, ids: [...] }] highlight moments
// --- playback state -------------------------------------------------------
var recapSequence = null; // [{ title, ids, frames, clipMs }] built at gameOver
var recapIndex = 0;
var recapElapsed = 0;     // ms spent on the current sequence item

// Clear all recap state. Called at the start of every race so the buffer only
// ever holds frames from the CURRENT map (the one a clip is rendered against).
function recapReset() {
	recapFrames = [];
	recapMarkers = [];
	recapSequence = null;
	recapIndex = 0;
	recapElapsed = 0;
}

// Snapshot the current player positions. Called once per server tick from the
// gameUpdates handler while racing/collapsing. Trims anything older than the
// rolling window so memory stays bounded regardless of round length.
function recapCaptureFrame() {
	if (playerList == null) {
		return;
	}
	var now = Date.now();
	var players = [];
	for (var id in playerList) {
		var p = playerList[id];
		if (p == null || p.x == null) {
			continue;
		}
		players.push([p.id, p.x, p.y, p.alive !== false]);
	}
	if (players.length === 0) {
		return;
	}
	recapFrames.push({ t: now, players: players });
	var cutoff = now - RECAP_BUFFER_MS;
	while (recapFrames.length > 0 && recapFrames[0].t < cutoff) {
		recapFrames.shift();
	}
}

// Record a highlight moment (from an existing client event). `ids` are the
// players the moment involves, used to bias a clip toward the right achievement.
function recapMarkHighlight(type, ids) {
	recapMarkers.push({ t: Date.now(), type: type, ids: ids || [] });
}

// Build the montage at gameOver: pick up to RECAP_MAX_CLIPS achievements that
// actually have winners and pair each with the most relevant buffered clip.
function recapBuild(achievementSet) {
	recapSequence = null;
	recapIndex = 0;
	recapElapsed = 0;
	if (recapFrames.length === 0 || achievementSet == null) {
		return; // nothing was captured (e.g. an instant finish) — skip the montage
	}

	var earned = [];
	for (var key in achievementSet) {
		var a = achievementSet[key];
		if (a == null || a.ids == null || a.ids.length === 0) {
			continue;
		}
		earned.push({ key: key, title: a.title, ids: a.ids });
		if (earned.length >= RECAP_MAX_CLIPS) {
			break;
		}
	}
	if (earned.length === 0) {
		return;
	}

	var usedMarker = {}; // index -> true, so clips don't all show the same moment
	var sequence = [];
	for (var i = 0; i < earned.length; i++) {
		var marker = recapPickMarker(earned[i], usedMarker);
		// Center the clip on the marker moment; with no marker, fall back to the
		// final moments of the round (the last RECAP_CLIP_MS of the buffer).
		var endT = recapFrames[recapFrames.length - 1].t;
		var startT = endT - RECAP_CLIP_MS;
		if (marker != null) {
			startT = marker.t - RECAP_PRE_MS;
		}
		var frames = recapSliceFrames(startT, startT + RECAP_CLIP_MS);
		if (frames.length === 0) {
			frames = recapSliceFrames(endT - RECAP_CLIP_MS, endT);
		}
		sequence.push({ title: earned[i].title, ids: earned[i].ids, frames: frames });
	}
	recapSequence = sequence.length > 0 ? sequence : null;
}

// Choose the best unused marker for an achievement: prefer a type match (the
// multi-kill medals), then a player-id overlap, then the most recent leftover.
function recapPickMarker(earned, usedMarker) {
	var wantType = RECAP_TYPE_FOR_KEY[earned.key];
	var best = -1;
	// newest-first so a tie picks the most recent moment
	for (var pass = 0; pass < 3 && best === -1; pass++) {
		for (var m = recapMarkers.length - 1; m >= 0; m--) {
			if (usedMarker[m]) {
				continue;
			}
			var mk = recapMarkers[m];
			var hit = false;
			if (pass === 0) {
				hit = wantType != null && mk.type === wantType;
			} else if (pass === 1) {
				hit = recapIdsOverlap(mk.ids, earned.ids);
			} else {
				hit = true;
			}
			if (hit) {
				best = m;
				break;
			}
		}
	}
	if (best === -1) {
		return null;
	}
	usedMarker[best] = true;
	return recapMarkers[best];
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

function recapSliceFrames(startT, endT) {
	var out = [];
	for (var i = 0; i < recapFrames.length; i++) {
		if (recapFrames[i].t >= startT && recapFrames[i].t <= endT) {
			out.push(recapFrames[i]);
		}
	}
	return out;
}

function recapActive() {
	return recapSequence != null && recapSequence.length > 0;
}

// Advance and render the montage. Called from drawGameOverScreen each frame.
// Wrapped by the caller in a guard so any render error can't break gameOver.
function recapDraw(dt) {
	if (!recapActive()) {
		return;
	}
	recapElapsed += dt;
	if (recapElapsed >= RECAP_DISPLAY_MS && recapIndex < recapSequence.length - 1) {
		recapIndex++;
		recapElapsed = 0;
	}
	var item = recapSequence[recapIndex];

	// Window geometry: a panel on the left half (the gameOver winner text sits
	// center, medals sit right — the left is free). Sized to the world's aspect.
	var winW = Math.min(360, gameCanvas.width * 0.32);
	var aspect = (world != null && world.width > 0) ? (world.height / world.width) : 0.75;
	var winH = Math.min(winW * aspect, gameCanvas.height * 0.42);
	var winX = Math.round(gameCanvas.width * 0.06);
	var winY = Math.round(gameCanvas.height / 2 - winH / 2);

	// Caption above the window.
	gameContext.save();
	gameContext.fillStyle = "black";
	gameContext.font = "20px serif";
	gameContext.fillText("Recap " + (recapIndex + 1) + "/" + recapSequence.length + " — " + item.title, winX, winY - 14);
	// involved player color chips
	for (var c = 0; c < item.ids.length && c < 6; c++) {
		var who = (playerList != null) ? playerList[item.ids[c]] : null;
		gameContext.beginPath();
		gameContext.arc(winX + 10 + c * 24, winY - 38, 9, 0, 2 * Math.PI);
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

	recapRenderClip(item, winX, winY, winW, winH);
	gameContext.restore();
}

// Render the current frame of `item`'s clip, fit into the window rect.
function recapRenderClip(item, winX, winY, winW, winH) {
	if (world == null || world.width == null) {
		return;
	}
	var s = Math.min(winW / world.width, winH / world.height);
	var originX = winX + (winW - world.width * s) / 2;
	var originY = winY + (winH - world.height * s) / 2;

	// Blit the cached map (built during the final round) under the same transform.
	if (typeof mapCanvas !== "undefined" && mapCanvas != null) {
		var destX = originX - mapCanvasPad * s;
		var destY = originY - mapCanvasPad * s;
		gameContext.drawImage(mapCanvas, destX, destY, mapCanvas.width * s, mapCanvas.height * s);
	}

	// Loop the clip: map elapsed time onto clip progress and pick the frame.
	var frame = recapFrameAt(item.frames, recapElapsed);
	if (frame == null) {
		return;
	}
	for (var i = 0; i < frame.players.length; i++) {
		var pr = frame.players[i];      // [id, x, y, alive]
		var live = playerList != null ? playerList[pr[0]] : null;
		var radius = (live != null && live.radius != null) ? live.radius : 12;
		gameContext.beginPath();
		gameContext.arc(originX + (pr[1] - world.x) * s, originY + (pr[2] - world.y) * s,
			Math.max(2, radius * s), 0, 2 * Math.PI);
		gameContext.globalAlpha = pr[3] ? 1 : 0.35; // dim eliminated players
		gameContext.fillStyle = (live != null) ? live.color : "grey";
		gameContext.strokeStyle = "black";
		gameContext.lineWidth = 1;
		gameContext.fill();
		gameContext.stroke();
	}
	gameContext.globalAlpha = 1;
}

// Pick the frame for the current loop position. The clip loops every
// RECAP_CLIP_MS; we map progress onto the frames' own timestamps.
function recapFrameAt(frames, elapsedMs) {
	if (frames == null || frames.length === 0) {
		return null;
	}
	if (frames.length === 1) {
		return frames[0];
	}
	var span = frames[frames.length - 1].t - frames[0].t;
	if (span <= 0) {
		return frames[0];
	}
	var progress = (elapsedMs % RECAP_CLIP_MS) / RECAP_CLIP_MS; // 0..1, loops
	var targetT = frames[0].t + progress * span;
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
