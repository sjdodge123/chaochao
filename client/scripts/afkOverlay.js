// afkOverlay.js — client-side AFK (idle) UX: a pre-kick "still there?" warning and a
// post-kick "removed for inactivity" screen, both styled to match reconnectOverlay.js
// (centered dark scrim + title/sub + data-gp-nav buttons).
//
// Why this is client-only: the AFK kick is server-authoritative (server/entities/player.js
// + server/game.js Room.checkAFK), but the server already SHIPS the thresholds to the client
// inside `config` (playerStartSleepTime / playerAFKKickTime / discordLobbyIdleKickTime /
// discordIdleKickTime), and every "I'm still here" reset the server honours is triggered by
// a packet the CLIENT itself sends ('movement' / 'lobbyActivity'). So the client can PREDICT
// the kick from its own last-input time + config and warn a few seconds early — no new server
// event, no touching config.json/game.js/engine.js (keeps it CHANGELOG/Codex-exempt).
//
// The prediction mirrors the server model:
//   web, lobby/waiting : kick at last-input + playerStartSleepTime          (~60s)
//   web, in-game       : kick at last-input + playerStartSleepTime+AFKKick  (~300s)
//   discord, lobby     : kick at last-input + discordLobbyIdleKickTime      (~900s)
//   discord, in-game   : kick at last-input + discordIdleKickTime           (~1200s)
// It's approximate (one-tick quantization + clock skew), so the warning is a heads-up, not a
// precise clock — and "I'm here" actually defers the real kick by emitting a 'movement' packet
// the server treats as activity (player.wakeUp()).
//
// Self-contained: exposes globals (the bundle shares globals, not modules) and guards every
// DOM/timer access behind `typeof document` so node --check + the headless bundle build (and
// the server-only smoke test, which never loads this file) stay clean.

// How long BEFORE the predicted kick to pop the warning. A heads-up wide enough to react to,
// but not so early it nags. Clamped so a short (60s lobby) window still has room for it.
var AFK_WARNING_LEAD_MS = 12000;

// Timestamp (ms) of the local/primary player's last real input. Bumped by markPlayerInput()
// from the same input paths that emit 'movement' / 'lobbyActivity' to the server, so the
// client mirror tracks the server's wakeUp() resets. Initialised to "now" so a freshly loaded
// page isn't instantly considered idle.
var afkLastInputAt = (typeof Date !== "undefined") ? Date.now() : 0;

// Singletons (null when not mounted). Two independent overlays: the transient warning and the
// terminal kicked screen. Kept separate so a kick cleanly replaces a lingering warning.
var _afkWarnEl = null, _afkWarnSubEl = null;
var _afkKickedEl = null;
var _afkIdleTimer = null;
var _afkPrevMyID = null;
// Whether the current idle period STARTED in-game. The server latches the long sleep+kick
// path once 60s of in-game idle elapses and does NOT re-shorten to the 60s lobby threshold
// when the round ends into lobby — so once idle began in-game we must keep predicting the
// long threshold (else we'd show a lying "removed in 0s" sitting in the post-round lobby).
var _afkIdleStartedInGame = false;

function _afkInLobby() {
	return (typeof config !== "undefined" && config && config.stateMap && typeof currentState !== "undefined") &&
		(currentState === config.stateMap.waiting || currentState === config.stateMap.lobby);
}

// --- activity stamping --------------------------------------------------------------------

// Record real local-player input + dismiss any visible warning. Call this ONLY from input
// paths the SERVER also treats as activity (movement / lobbyActivity emits) so the client
// estimate can never out-live the server's actual reset — never from 'mousemove' (the server
// ignores it for AFK) or it would suppress the warning while the kick still lands.
function markPlayerInput() {
	afkLastInputAt = (typeof Date !== "undefined") ? Date.now() : 0;
	_afkIdleStartedInGame = !_afkInLobby(); // remember which threshold governs this idle period
	if (_afkWarnEl) { afkWarningHide(); }
}

// --- shared style helpers (mirror reconnectOverlay.js) ------------------------------------

function _afkMakeOverlay(id) {
	var overlay = document.createElement("div");
	overlay.id = id;
	overlay.style.cssText = "position:fixed;inset:0;z-index:2147483600;display:flex;" +
		"flex-direction:column;align-items:center;justify-content:center;gap:16px;" +
		"background:rgba(8,10,14,0.92);color:#fff;font-family:inherit;text-align:center;" +
		"padding:24px;opacity:0;transition:opacity 0.3s ease;backdrop-filter:blur(2px);" +
		"-webkit-backdrop-filter:blur(2px);";
	return overlay;
}
function _afkMakeTitle(text) {
	var el = document.createElement("div");
	el.textContent = text;
	el.style.cssText = "font-size:32px;font-weight:800;letter-spacing:0.5px;color:#ffffff;" +
		"text-shadow:0 2px 14px rgba(0,0,0,0.7);";
	return el;
}
function _afkMakeSub(text) {
	var el = document.createElement("div");
	el.textContent = text;
	el.style.cssText = "font-size:16px;color:#e6e9ef;opacity:0.95;max-width:440px;" +
		"line-height:1.45;text-shadow:0 1px 8px rgba(0,0,0,0.6);";
	return el;
}
function _afkMakeBtn(label, accent, onClick) {
	var btn = document.createElement("button");
	btn.type = "button";
	btn.textContent = label;
	btn.setAttribute("data-gp-nav", "");
	btn.style.cssText = "padding:13px 26px;font-size:17px;font-weight:700;border:none;" +
		"border-radius:10px;cursor:pointer;" +
		(accent ? "color:#0c0e14;background:#7ee787;" : "color:#fff;background:rgba(255,255,255,0.16);");
	btn.addEventListener("click", function (e) {
		if (e) { try { e.preventDefault(); e.stopPropagation(); } catch (e2) {} }
		if (typeof onClick === "function") { onClick(); }
	});
	return btn;
}
function _afkFadeIn(el) {
	var raf = (typeof requestAnimationFrame === "function") ? requestAnimationFrame : function (fn) { setTimeout(fn, 16); };
	raf(function () { if (el) { el.style.opacity = "1"; } });
}

// --- pre-kick warning ---------------------------------------------------------------------

// Confirm the player is here without losing their slot: bump the client timer AND emit a
// neutral 'movement' packet (no keys held) on the primary socket, which the server maps to
// player.wakeUp() in EVERY state — deferring the real kick. Reuses an existing event; invents
// nothing server-side.
function afkImHere() {
	markPlayerInput();
	try {
		if (typeof server !== "undefined" && server && typeof server.emit === "function") {
			server.emit("movement", { turnLeft: false, moveForward: false, turnRight: false, moveBackward: false, attack: false });
		}
	} catch (e) { /* socket mid-reconnect — the client timer reset alone still defers our warn */ }
	afkWarningHide();
}

// Show (or re-text) the idle warning. Idempotent: while mounted, only the sub line updates so
// the per-second countdown can refresh without rebuilding the DOM.
function afkWarningShow(sub) {
	if (typeof document === "undefined" || !document.body) { return; }
	if (!_afkWarnEl) {
		var overlay = _afkMakeOverlay("afkWarnOverlay");
		var title = _afkMakeTitle("Still there?");
		var subEl = _afkMakeSub(sub || "You'll be removed for inactivity soon.");
		var btnRow = document.createElement("div");
		btnRow.style.cssText = "display:flex;flex-direction:row;gap:14px;margin-top:8px;";
		var imHere = _afkMakeBtn("I'm here", true, afkImHere);
		btnRow.appendChild(imHere);
		overlay.appendChild(title);
		overlay.appendChild(subEl);
		overlay.appendChild(btnRow);
		document.body.appendChild(overlay);
		_afkWarnEl = overlay;
		_afkWarnSubEl = subEl;
		_afkFadeIn(overlay);
		try { imHere.focus(); } catch (e) { /* focus is best-effort */ }
	} else if (sub != null && _afkWarnSubEl) {
		_afkWarnSubEl.textContent = sub;
	}
}

function afkWarningHide() {
	if (_afkWarnEl && _afkWarnEl.parentNode) {
		_afkWarnEl.parentNode.removeChild(_afkWarnEl);
	}
	_afkWarnEl = null;
	_afkWarnSubEl = null;
}

// --- post-kick screen ---------------------------------------------------------------------

// Terminal "you were removed" screen (web only — the Discord deep-idle path keeps its own
// tap-to-rejoin panel, see client.js showDiscordRejoinPanel). Replaces the old silent navigate
// so the player understands what happened and can choose to come back. o.onRejoin / o.onLeave
// are wired by the caller (client.js serverKick handler).
function afkKickedShow(o) {
	if (typeof document === "undefined" || !document.body) { return; }
	o = o || {};
	afkWarningHide(); // a kick supersedes any lingering warning
	// A kick supersedes the reconnect outage overlay too (mutually exclusive in practice, but
	// be safe): tear it down so its scrim doesn't sit under the kicked screen.
	if (document.getElementById("reconnectOverlay") && typeof reconnectOverlayHide === "function") { reconnectOverlayHide(); }
	if (_afkKickedEl) { return; } // already up (idempotent)
	var overlay = _afkMakeOverlay("afkKickedOverlay");
	var title = _afkMakeTitle("Removed for inactivity");
	var sub = _afkMakeSub("You were idle too long, so we freed up your spot. Jump back in whenever you're ready.");
	var btnRow = document.createElement("div");
	btnRow.style.cssText = "display:flex;flex-direction:row;gap:14px;margin-top:8px;";
	var rejoinBtn = _afkMakeBtn("Rejoin", true, function () { if (typeof o.onRejoin === "function") { o.onRejoin(); } });
	var leaveBtn = _afkMakeBtn("Leave", false, function () { if (typeof o.onLeave === "function") { o.onLeave(); } });
	btnRow.appendChild(rejoinBtn);
	btnRow.appendChild(leaveBtn);
	overlay.appendChild(title);
	overlay.appendChild(sub);
	overlay.appendChild(btnRow);
	document.body.appendChild(overlay);
	_afkKickedEl = overlay;
	_afkFadeIn(overlay);
	try { rejoinBtn.focus(); } catch (e) { /* focus is best-effort */ }
}

function afkKickedHide() {
	if (_afkKickedEl && _afkKickedEl.parentNode) {
		_afkKickedEl.parentNode.removeChild(_afkKickedEl);
	}
	_afkKickedEl = null;
}

// --- idle prediction loop -----------------------------------------------------------------

// Predicted ms from last input to the server's kick, given the live state + host. null when we
// can't/shouldn't predict (no config yet). Mirrors player.js/game.js (see file header).
function _afkKickThresholdMs() {
	if (typeof config === "undefined" || !config || !config.stateMap) { return null; }
	var inLobby = _afkInLobby();
	var isDiscord = (typeof isDiscordActivity === "function") && isDiscordActivity();
	var sec;
	if (isDiscord) {
		// Discord deep-idle reclaim reads the live state each tick, so no latch needed.
		sec = inLobby ? (config.discordLobbyIdleKickTime || 900) : (config.discordIdleKickTime || 1200);
	} else {
		var sleep = (config.playerStartSleepTime || 60);
		// Use the long (sleep+kick) threshold whenever we're in-game OR the idle period began
		// in-game (the server latched it and won't re-shorten on the round-end → lobby roll).
		var treatInGame = !inLobby || _afkIdleStartedInGame;
		sec = treatInGame ? (sleep + (config.playerAFKKickTime || 240)) : sleep;
	}
	return sec * 1000;
}

function _afkIdleTick() {
	if (typeof document === "undefined") { return; }
	// Only meaningful once we're an in-game player. previewMode is the editor play-test (it
	// returns to the editor, never AFK-kicks). The kicked screen owns the display once shown.
	if (_afkKickedEl) { return; }
	if (typeof myID === "undefined" || myID == null) { afkWarningHide(); _afkPrevMyID = null; return; }
	if (typeof previewMode !== "undefined" && previewMode) { afkWarningHide(); return; }
	// A fresh join / rejoin (new id) resets the activity baseline so the player isn't warned
	// off a stale timestamp from a previous session.
	if (myID !== _afkPrevMyID) { markPlayerInput(); _afkPrevMyID = myID; afkWarningHide(); return; }
	// Don't stack on top of the reconnect outage overlay — a dropped socket is a different,
	// louder story and the AFK clock is meaningless while disconnected.
	if (document.getElementById("reconnectOverlay")) { afkWarningHide(); return; }
	// Couch co-op: never cover an actively-played shared screen. If any non-primary local
	// (pad) seat is in the game, suppress the primary's idle warning — mirrors the kicked
	// path's afkHasSurvivor failover (client.js). P2's input doesn't reset P1's clock.
	if (typeof localPlayers !== "undefined" && localPlayers) {
		for (var _s = 0; _s < localPlayers.length; _s++) {
			if (localPlayers[_s] && !localPlayers[_s].isPrimary) { afkWarningHide(); return; }
		}
	}
	var threshold = _afkKickThresholdMs();
	if (threshold == null) { return; }
	var idle = Date.now() - afkLastInputAt;
	var warnAt = threshold - AFK_WARNING_LEAD_MS;
	if (warnAt < 0) { warnAt = 0; }
	if (idle >= warnAt) {
		var leftSec = Math.max(0, Math.ceil((threshold - idle) / 1000));
		afkWarningShow("You'll be removed for inactivity in " + leftSec + "s. Tap “I'm here” or move to stay.");
	} else if (_afkWarnEl) {
		afkWarningHide();
	}
}

// Arm the idle watcher once (idempotent). Called from initEventHandlers (browser only); a
// no-op in headless. 1s cadence is plenty for a per-second countdown and trivially cheap.
function startAfkIdleWatch() {
	if (typeof document === "undefined" || typeof setInterval === "undefined") { return; }
	if (_afkIdleTimer) { return; }
	markPlayerInput();
	_afkIdleTimer = setInterval(_afkIdleTick, 1000);
}
