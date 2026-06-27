// reconnectOverlay.js — full-screen "we lost the server" reconnect overlay.
//
// Why this exists: when the socket actually DROPS (a maintenance restart cutover, a
// network outage, a long iframe suspend) the small connection chip / top banner aren't
// loud enough — the player is staring at a frozen world with no idea what's happening.
// This is the prominent, intentional state: a dark scrim that FADES the live canvas,
// a centered "Reconnecting…" message, and — after an exponential-backoff budget runs
// out (~2.5 min) — a manual Try-again / Leave decision. ONE pattern serves BOTH outage
// paths in client.js: (A) the maintenance-restart poll-and-reload, and (B) the transient
// drop where socket.io auto-reconnects underneath us.
//
// Self-contained: exposes globals (the bundle shares globals, not modules) and guards
// every DOM access behind `typeof document` so node --check + the headless bundle build
// (and any test harness) stay clean.

// Exponential backoff schedule + overall give-up budget. Shared by both outage paths so
// the "wait longer between tries" cadence is defined in exactly one place. delayFor is
// 0-indexed by attempt and caps at the last step (30s) for every attempt past the table.
var RECONNECT_BACKOFF = {
	steps: [1000, 2000, 4000, 8000, 15000, 30000],
	delayFor: function (attempt) {
		if (attempt == null || attempt < 0) { attempt = 0; }
		var i = attempt < this.steps.length ? attempt : this.steps.length - 1;
		return this.steps[i];
	},
	GIVE_UP_MS: 150000 // ~2.5 min total reconnect budget before we hand it to the player
};

// Singleton element refs (null when the overlay isn't mounted). Module-private; all
// access goes through the exported functions below so show/hide stay idempotent.
var _reconnectOverlayEl = null,
	_reconnectTitleEl = null,
	_reconnectSubEl = null,
	_reconnectSpinnerEl = null,
	_reconnectBtnRowEl = null;

// The canvases we fade so the player reads "this is paused" — looked up by id (they
// live in play.html). Missing ids are skipped (other pages / tests).
var _RECONNECT_CANVAS_IDS = ["gameCanvas", "overlayCanvas", "audienceCanvas"];

function _reconnectSetCanvasOpacity(value) {
	if (typeof document === "undefined") { return; }
	for (var i = 0; i < _RECONNECT_CANVAS_IDS.length; i++) {
		var el = document.getElementById(_RECONNECT_CANVAS_IDS[i]);
		if (!el) { continue; }
		try {
			// On restore (value === "") clear the inline transition too, so the canvases
			// don't keep a leftover opacity transition forever after one outage.
			el.style.transition = (value === "") ? "" : "opacity 0.35s ease";
			el.style.opacity = value;
		} catch (e) { /* style may be absent in odd hosts — best-effort */ }
	}
}

// Create (or re-text) the overlay. Idempotent: a second call with the overlay already up
// just updates the title/sub and re-shows the spinner row (drops any give-up button row).
function reconnectOverlayShow(opts) {
	if (typeof document === "undefined" || !document.body) { return; }
	opts = opts || {};
	var title = opts.title != null ? opts.title : "Reconnecting…";
	var sub = opts.sub != null ? opts.sub : "";
	if (!_reconnectOverlayEl) {
		var overlay = document.createElement("div");
		overlay.id = "reconnectOverlay";
		overlay.style.cssText = "position:fixed;inset:0;z-index:2147483600;display:flex;" +
			"flex-direction:column;align-items:center;justify-content:center;gap:16px;" +
			"background:rgba(8,10,14,0.92);color:#fff;font-family:inherit;text-align:center;" +
			"padding:24px;opacity:0;transition:opacity 0.3s ease;backdrop-filter:blur(2px);" +
			"-webkit-backdrop-filter:blur(2px);";

		var titleEl = document.createElement("div");
		titleEl.style.cssText = "font-size:32px;font-weight:800;letter-spacing:0.5px;color:#ffffff;" +
			"text-shadow:0 2px 14px rgba(0,0,0,0.7);";

		var spinner = document.createElement("div");
		spinner.id = "reconnectOverlaySpinner";
		spinner.style.cssText = "width:34px;height:34px;border-radius:50%;" +
			"border:4px solid rgba(255,255,255,0.2);border-top-color:#7ee787;" +
			"animation:reconnectSpin 0.9s linear infinite;";

		var subEl = document.createElement("div");
		subEl.style.cssText = "font-size:16px;color:#e6e9ef;opacity:0.95;max-width:440px;" +
			"line-height:1.45;text-shadow:0 1px 8px rgba(0,0,0,0.6);";

		var btnRow = document.createElement("div");
		btnRow.style.cssText = "display:none;flex-direction:row;gap:14px;margin-top:8px;";

		// One-time keyframes for the spinner (guarded so we don't stack duplicates).
		if (!document.getElementById("reconnectOverlayStyle")) {
			var styleEl = document.createElement("style");
			styleEl.id = "reconnectOverlayStyle";
			styleEl.textContent = "@keyframes reconnectSpin{to{transform:rotate(360deg);}}";
			document.head ? document.head.appendChild(styleEl) : document.body.appendChild(styleEl);
		}

		overlay.appendChild(titleEl);
		overlay.appendChild(spinner);
		overlay.appendChild(subEl);
		overlay.appendChild(btnRow);
		document.body.appendChild(overlay);

		_reconnectOverlayEl = overlay;
		_reconnectTitleEl = titleEl;
		_reconnectSubEl = subEl;
		_reconnectSpinnerEl = spinner;
		_reconnectBtnRowEl = btnRow;

		// Fade in on the next frame so the transition actually runs.
		var raf = (typeof requestAnimationFrame === "function") ? requestAnimationFrame : function (fn) { setTimeout(fn, 16); };
		raf(function () { if (_reconnectOverlayEl) { _reconnectOverlayEl.style.opacity = "1"; } });
	}

	_reconnectTitleEl.textContent = title;
	_reconnectSubEl.textContent = sub;
	// Re-show the spinner / clear any prior give-up buttons (a fresh retry loop).
	if (_reconnectSpinnerEl) { _reconnectSpinnerEl.style.display = ""; }
	if (_reconnectBtnRowEl) {
		_reconnectBtnRowEl.style.display = "none";
		_reconnectBtnRowEl.innerHTML = "";
	}
	_reconnectSetCanvasOpacity("0.25");
}

// Update just the status/sub line (e.g. "Trying again in 8s…"). No-op if not mounted.
function reconnectOverlayNote(text) {
	if (_reconnectSubEl) { _reconnectSubEl.textContent = text != null ? text : ""; }
}

// Switch to the GIVE-UP state: stop the spinner, swap copy, show Try-again / Leave.
function reconnectOverlayFail(o) {
	o = o || {};
	if (!_reconnectOverlayEl) {
		// Nothing mounted — bring it up first so the buttons have a home.
		reconnectOverlayShow({ title: "Couldn't reconnect", sub: "Check your connection." });
	}
	if (!_reconnectOverlayEl) { return; } // headless: still no DOM
	if (_reconnectTitleEl) { _reconnectTitleEl.textContent = "Couldn't reconnect"; }
	if (_reconnectSubEl) { _reconnectSubEl.textContent = "Check your connection."; }
	if (_reconnectSpinnerEl) { _reconnectSpinnerEl.style.display = "none"; }
	if (!_reconnectBtnRowEl) { return; }
	_reconnectBtnRowEl.innerHTML = "";
	_reconnectBtnRowEl.style.display = "flex";

	var makeBtn = function (label, accent, onClick) {
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
	};

	var retryBtn = makeBtn("Try again", true, o.onRetry);
	var leaveBtn = makeBtn("Leave", false, o.onLeave);
	_reconnectBtnRowEl.appendChild(retryBtn);
	_reconnectBtnRowEl.appendChild(leaveBtn);
	try { retryBtn.focus(); } catch (e) { /* focus is best-effort */ }
}

// Tear the overlay down + restore the canvas. Idempotent.
function reconnectOverlayHide() {
	if (_reconnectOverlayEl && _reconnectOverlayEl.parentNode) {
		_reconnectOverlayEl.parentNode.removeChild(_reconnectOverlayEl);
	}
	_reconnectOverlayEl = null;
	_reconnectTitleEl = null;
	_reconnectSubEl = null;
	_reconnectSpinnerEl = null;
	_reconnectBtnRowEl = null;
	_reconnectSetCanvasOpacity("");
}
