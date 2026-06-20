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
	recoverTried: false,
	recovering: false
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
		// Fires when polling successfully upgrades to websocket.
		eng.on("upgrade", function (t) {
			connHud.transport = (t && t.name) || connHud.transport;
			connectionHudMarkPolling();
			connectionHudRender();
		});
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
	// RTT sample via ack ping — independent of the gameplay stall watchdog.
	var t0 = connHudNow();
	try {
		sock.timeout(CONN_PING_MS).emit("cc:netping", function (err) {
			if (err) { return; } // ack timed out -> keep last rtt; render still flags polling
			connHud.rtt = connHudNow() - t0;
		});
	} catch (e) { /* older client without .timeout(): skip RTT, transport still tracked */ }

	connectionHudMarkPolling();
	// Auto-recover: stuck on polling past the grace window, once per page session, and
	// only when NOT racing (a reconnect blip mid-race is worse than the polling lag).
	// During a race the badge stays tappable so the player can choose to recover.
	if (connHud.transport === "polling" && connHud.pollingSince &&
		(connHudNow() - connHud.pollingSince) > CONN_POLL_STUCK_MS &&
		!connHud.recoverTried && !connHud.recovering && !connectionHudIsRacing()) {
		connectionHudRecover(false);
	}
	connectionHudRender();
}

// Force a WebSocket-first reconnect and re-join the room. The primary socket never
// re-sends enterGame on its own (client.js's maintenance handler notes this), so we
// re-emit it on the next connect — mirroring the pad-slot reconnect path.
function connectionHudRecover() {
	var sock = connHud.sock;
	if (!sock || connHud.recovering) { return; }
	connHud.recovering = true;
	connHud.recoverTried = true;
	var roomId = (typeof gameID !== "undefined") ? gameID : null;
	sock.once("connect", function () {
		connHud.recovering = false;
		if (roomId != null) {
			try { sock.emit("enterGame", roomId); } catch (e) { /* room re-join is best-effort */ }
		}
	});
	// tryAllTransports keeps polling as a fallback, but the retry leads with websocket.
	try { sock.io.opts.transports = ["websocket", "polling"]; } catch (e) { /* ignore */ }
	try {
		sock.disconnect();
		sock.connect();
	} catch (e) {
		connHud.recovering = false;
	}
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
