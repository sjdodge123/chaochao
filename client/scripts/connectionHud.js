// connectionHud.js — live connection-quality indicator + transport auto-recovery.
//
// Why this exists: a Socket.IO client can silently fall back to (or get stuck on)
// HTTP long-polling — the slowest transport — when its WebSocket upgrade fails or a
// live WS drops mid-session (a Cloudflare PoP hiccup, a NAT/middlebox killing the
// long-lived socket, a transient proxy). See the SOCKET_TRANSPORT_OPTS note in
// client.js: prod has hit this before. It degrades ONLY the affected client (everyone
// else stays on WebSocket), so it never shows up as a server-wide incident and is
// impossible to confirm in-game after the fact — exactly the "only me lagging, and
// Discord was fine at the same time" report. This surfaces it live: an unobtrusive
// RTT/transport badge that escalates to a tap-to-fix warning on polling, plus a
// bounded automatic WebSocket re-upgrade.
//
// Decoupled by design: RTT is measured with its OWN ack ping ('cc:netping') and this
// module NEVER touches timeSinceLastCom. The gameUpdates-fed stall watchdog in
// client.js must remain the sole authority on "is the game actually frozen" — a
// polling-but-alive heartbeat must not be allowed to mask a real freeze.

var connHud = {
	el: null,
	dot: null,
	text: null,
	sock: null,
	transport: "connecting",
	rtt: null,
	pollingSince: 0,
	pingTimer: null,
	recovering: false,
	_boundEngine: null
};

var CONN_PING_MS = 2000;        // RTT sample cadence
var CONN_POLL_STUCK_MS = 6000;  // stuck on polling this long -> escalate + auto-recover
var CONN_RTT_WARN = 120;        // ms: amber
var CONN_RTT_BAD = 250;         // ms: red

function connHudNow() { return Date.now(); }

function connectionHudInit() {
	if (connHud.el || typeof document === "undefined") { return; }
	var el = document.createElement("div");
	el.id = "connHud";
	el.style.cssText = [
		"position:fixed", "left:8px", "bottom:8px", "z-index:50",
		"display:flex", "align-items:center", "gap:6px",
		"padding:3px 8px", "border-radius:10px",
		"font:600 11px/1.2 system-ui,Segoe UI,Roboto,sans-serif",
		"color:#fff", "background:rgba(0,0,0,0.38)", "opacity:0.55",
		"pointer-events:auto", "user-select:none", "transition:opacity .2s,background .2s"
	].join(";");
	var dot = document.createElement("span");
	dot.style.cssText = "width:8px;height:8px;border-radius:50%;background:#888;flex:0 0 auto";
	var text = document.createElement("span");
	text.textContent = "connecting…";
	el.appendChild(dot);
	el.appendChild(text);
	// Tap/click while warning = manual recovery (touch users have no other affordance).
	el.addEventListener("click", function () {
		if (connHud.transport === "polling") { connectionHudRecover(true); }
	});
	(document.body || document.documentElement).appendChild(el);
	connHud.el = el;
	connHud.dot = dot;
	connHud.text = text;
	connectionHudRender();
}

// (Re)bind transport tracking to a socket. The engine.io transport object is
// recreated on every (re)connect, so this is called again from the 'connect' handler.
function connectionHudBindTransport(sock) {
	try {
		var eng = sock && sock.io && sock.io.engine;
		if (!eng) { return; }
		connHud.transport = (eng.transport && eng.transport.name) || "connecting";
		connectionHudMarkPolling();
		// One 'upgrade' listener per engine. bindTransport runs both directly from
		// attach and again from the 'connect' handler, and the engine is recreated per
		// (re)connect — so guard on the engine identity to avoid stacking listeners.
		if (connHud._boundEngine !== eng) {
			connHud._boundEngine = eng;
			// Fires when polling successfully upgrades to websocket.
			eng.on("upgrade", function (t) {
				connHud.transport = (t && t.name) || connHud.transport;
				connectionHudMarkPolling();
				connectionHudRender();
			});
		}
	} catch (e) { /* engine internals are best-effort */ }
}

function connectionHudMarkPolling() {
	if (connHud.transport === "polling") {
		if (!connHud.pollingSince) { connHud.pollingSince = connHudNow(); }
	} else {
		connHud.pollingSince = 0;
	}
}

function connectionHudIsRacing() {
	try {
		return typeof currentState !== "undefined" && typeof config !== "undefined" &&
			config && config.stateMap && currentState === config.stateMap.racing;
	} catch (e) { return false; }
}

// Attach the indicator to the primary socket. Idempotent: re-points at the current
// socket (e.g. when a pad slot is promoted to primary) and only ever runs one timer.
function connectionHudAttach(sock) {
	connectionHudInit();
	connHud.sock = sock;
	connectionHudBindTransport(sock);
	sock.on("connect", function () {
		connHud.recovering = false;
		connectionHudBindTransport(sock);
		connectionHudRender();
	});
	if (!connHud.pingTimer) {
		connHud.pingTimer = setInterval(connectionHudTick, CONN_PING_MS);
	}
}

function connectionHudTick() {
	var sock = connHud.sock;
	if (!sock || !sock.connected) {
		connHud.rtt = null;
		connectionHudRender();
		return;
	}
	// RTT sample via ack ping — independent of the gameplay stall watchdog. On an ack
	// timeout (a half-open websocket whose pongs have stopped) blank the RTT rather than
	// keep showing the last good value: a stale green latency would hide the very stall
	// this badge exists to surface. Re-render on the ack so the change shows promptly.
	var t0 = connHudNow();
	try {
		sock.timeout(CONN_PING_MS).emit("cc:netping", function (err) {
			connHud.rtt = err ? null : (connHudNow() - t0);
			connectionHudRender();
		});
	} catch (e) { /* older client without .timeout(): skip RTT, transport still tracked */ }

	connectionHudMarkPolling();
	// Auto-recover: stuck on polling past the grace window, at most once per tab session
	// (the reload one-shot lives in connectionHudRecover), and only when NOT racing (a
	// reload mid-race is worse than the polling lag). During a race the badge stays
	// tappable so the player can choose to recover.
	if (connHud.transport === "polling" && connHud.pollingSince &&
		(connHudNow() - connHud.pollingSince) > CONN_POLL_STUCK_MS &&
		!connHud.recovering && !connectionHudIsRacing()) {
		connectionHudRecover(false);
	}
	connectionHudRender();
}

// Recover a degraded transport by reloading the page. A reload re-runs the whole
// WebSocket-first connect + matchmake/join flow from scratch and preserves any
// ?gameid= in the URL, so shared/private rooms re-join correctly — it's the same
// recovery primitive the maintenance handler and the stall watchdog already use.
//
// We deliberately do NOT disconnect+reconnect the live socket: dropping the only
// client in a room makes the server reap it (hostess.kickFromRoom deletes rooms at
// clientCount 0), and the re-join would then bounce off roomNotFound to the join
// page — kicking solo/private-room players out instead of repairing the transport.
//
// isManual = the player tapped the chip (always honoured). Automatic recovery runs
// at most ONCE per tab session: if the reload lands us right back on long-polling the
// network is simply blocking WebSocket, and reloading again every few seconds would
// be a worse experience than living on polling with the warning shown.
function connectionHudRecover(isManual) {
	if (connHud.recovering) { return; }
	if (!isManual) {
		// Auto path needs the one-shot flag to avoid a reload loop on a WebSocket-blocked
		// network. If storage is unreadable, don't auto-reload at all — under-recovering is
		// safer than looping, and the player can still tap the chip to force a reload.
		var alreadyRecovered = true;
		try { alreadyRecovered = !!sessionStorage.getItem("connHudAutoRecovered"); } catch (e) { return; }
		if (alreadyRecovered) { return; }
	}
	try { sessionStorage.setItem("connHudAutoRecovered", "1"); } catch (e) { /* best-effort */ }
	connHud.recovering = true;
	connectionHudRender();
	try { window.location.reload(); } catch (e) { connHud.recovering = false; }
}

function connectionHudRender() {
	if (!connHud.el) { return; }
	var t = connHud.transport;
	var rtt = connHud.rtt;
	var connected = connHud.sock && connHud.sock.connected;
	var color, label, warn = false;
	if (!connected) {
		color = "#888"; label = "connecting…";
	} else if (t === "polling") {
		warn = true; color = "#ff5252";
		label = connHud.recovering ? "reconnecting…" : "Slow link — tap to fix";
	} else if (rtt == null) {
		color = "#888"; label = "— ms";
	} else {
		label = rtt + " ms";
		color = rtt > CONN_RTT_BAD ? "#ff5252" : (rtt > CONN_RTT_WARN ? "#ffb300" : "#4caf50");
	}
	connHud.dot.style.background = color;
	connHud.text.textContent = label;
	connHud.el.style.background = warn ? "rgba(176,32,32,0.92)" : "rgba(0,0,0,0.38)";
	connHud.el.style.cursor = warn ? "pointer" : "default";
	connHud.el.style.opacity = warn ? "1" : "0.55";
}
