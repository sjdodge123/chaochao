// metrics.js — GA4 enrichment beyond the bare trackEvent() helper (play.html head).
//
// Owns the cross-cutting analytics that no single feature file should:
//   - USER-SCOPED properties (gtag 'set' user_properties): auth_state, player_level,
//     input_method, perf_profile, embed_host. These let GA cohort *users* (retention
//     by sign-in status, device class, portal) instead of only slicing events.
//   - first_match (lifetime-once, localStorage-flagged) + time_to_first_match,
//     the onboarding-friction key event.
//   - match_abandon on pagehide while mid-match — the churn/quit-point signal.
//
// Everything here is fail-open: gtag may be blocked by an ad/tracker blocker, so
// every call is guarded and analytics can never throw into gameplay. The file is
// part of the play bundle (shares globals with client.js/game.js/perf.js); all
// reads happen lazily at call time, so concat order doesn't matter.

// The portal hostname when running inside an iframe, else 'none'. ancestorOrigins
// is Chromium/WebKit-only; document.referrer is the cross-browser fallback (on an
// embedded first load it points at the embedding page). 'unknown_embed' = we know
// we're framed but the parent origin is unreadable (sandboxed/no-referrer portal).
function metricsEmbedHost() {
	try {
		if (typeof isEmbedded !== "function" || !isEmbedded()) { return "none"; }
		if (window.location.ancestorOrigins && window.location.ancestorOrigins.length) {
			return new URL(window.location.ancestorOrigins[0]).hostname || "unknown_embed";
		}
		if (document.referrer) {
			return new URL(document.referrer).hostname || "unknown_embed";
		}
	} catch (e) { /* URL parse / cross-origin read failed */ }
	return "unknown_embed";
}

// Coarse level buckets so the user property stays low-cardinality and readable in
// GA tables ('none' = no progression yet: guest, or signed-in pre-first-XP).
function metricsLevelBucket(level) {
	if (typeof level !== "number" || level < 1) { return "none"; }
	if (level <= 1) { return "1"; }
	if (level <= 5) { return "2-5"; }
	if (level <= 10) { return "6-10"; }
	if (level <= 20) { return "11-20"; }
	return "21+";
}

// Primary input this session. Gamepad wins over touch (a pad on an iPad is a pad
// player); touch wins over keyboard. Coarse by design — it's a cohorting axis.
function metricsInputMethod() {
	if (typeof gamepadConnected !== "undefined" && gamepadConnected === true) { return "gamepad"; }
	if (typeof isTouchScreen !== "undefined" && isTouchScreen === true) { return "touch"; }
	return "keyboard";
}

// Active graphics profile, distinguishing a manual pin ('low') from Auto's
// resolution ('auto_low') — the former is a player choice, the latter is the
// detector's verdict on the device.
function metricsPerfProfile() {
	try {
		var pref = (typeof getPerfPref === "function") ? getPerfPref() : "auto";
		if (pref === "auto") {
			return "auto_" + ((typeof perfTier !== "undefined" && perfTier) ? perfTier : "high");
		}
		return pref;
	} catch (e) { return "unknown"; }
}

// (Re)send the user-scoped properties. Cheap and idempotent — called at bundle
// eval (input/perf/embed are known immediately), again when auth resolves
// (auth.js calls this after applySession), and on every progressionUpdate so a
// level-up moves the player_level cohort mid-session. Properties only attach to
// events sent AFTER the set, hence the eager first call.
function updateGAUserProperties() {
	if (typeof gtag !== "function") { return; }
	try {
		var authState = "guest";
		if (window.chaochaoAuth && typeof window.chaochaoAuth.getAuthState === "function") {
			authState = window.chaochaoAuth.getAuthState();
		}
		gtag("set", "user_properties", {
			auth_state: authState,
			player_level: metricsLevelBucket((typeof myProgression !== "undefined" && myProgression) ? myProgression.level : null),
			input_method: metricsInputMethod(),
			perf_profile: metricsPerfProfile(),
			embed_host: metricsEmbedHost()
		});
	} catch (e) { /* analytics must never break gameplay */ }
}
// Expose for the standalone (non-bundled) auth.js, which refreshes auth_state
// after sign-in/out resolves.
window.updateGAUserProperties = updateGAUserProperties;
updateGAUserProperties();
// Re-send once everything has evaluated: metrics.js sits early in the bundle, so
// the eager call above ran before input.js set isTouchScreen (and before Auto's
// perf tier resolved). By DOMContentLoaded the bundle's sync scripts AND the
// deferred auth.js have run, so this pass has the real values — important for
// guests, who never get the auth-change/progressionUpdate refreshes.
document.addEventListener("DOMContentLoaded", updateGAUserProperties);

// A gamepad connecting mid-session flips the input_method cohort.
window.addEventListener("gamepadconnected", function () {
	updateGAUserProperties();
});

// --- first_match -------------------------------------------------------------
// Lifetime-once (per browser) "player actually raced" conversion, with
// time_to_first_match = seconds from navigation start to that first gate
// release. Fired from client.js's startRace handler. localStorage-flagged so
// returning players never re-fire; private-mode storage failures degrade to
// once-per-pageload via the in-memory flag.
var FIRST_MATCH_KEY = "playedFirstMatch";
var firstMatchTracked = false;
function trackFirstMatchIfNew() {
	if (firstMatchTracked) { return; }
	firstMatchTracked = true;
	try {
		if (window.localStorage.getItem(FIRST_MATCH_KEY)) { return; }
		window.localStorage.setItem(FIRST_MATCH_KEY, "1");
	} catch (e) { /* storage unavailable — still fire, deduped per pageload */ }
	var seconds = null;
	try { seconds = Math.round(performance.now() / 1000); } catch (e) { /* ancient browser */ }
	var params = {};
	if (seconds != null) { params.time_to_first_match = seconds; }
	trackEvent("first_match", params);
}

// --- match_abandon -------------------------------------------------------------
// The quit-point signal: the page is going away while the player is mid-match
// (gated/racing/collapsing/overview — NOT lobby/waiting/gameOver, where leaving
// is a natural stopping point). gtag transports unload-time events via
// sendBeacon, so firing inside pagehide is reliable. Once-guarded: pagehide can
// fire again on bfcache restore + re-leave, but that's the same abandonment.
var MATCH_ABANDON_STATES = ["gated", "racing", "collapsing", "overview"];
var matchAbandonSent = false;
window.addEventListener("pagehide", function () {
	if (matchAbandonSent) { return; }
	try {
		if (typeof config === "undefined" || !config || !config.stateMap ||
			typeof currentState === "undefined" || currentState == null) { return; }
		var stateName = null;
		for (var i = 0; i < MATCH_ABANDON_STATES.length; i++) {
			if (currentState === config.stateMap[MATCH_ABANDON_STATES[i]]) {
				stateName = MATCH_ABANDON_STATES[i];
				break;
			}
		}
		if (stateName == null) { return; }
		matchAbandonSent = true;
		trackEvent("match_abandon", {
			state: stateName,
			round_number: (typeof round === "number") ? round : 0,
			map: (typeof currentMap !== "undefined" && currentMap && currentMap.name) || "unknown",
			playlist: (typeof currentPlaylistIdForMetrics === "function") ? currentPlaylistIdForMetrics() : "unknown"
		});
	} catch (e) { /* analytics must never break page teardown */ }
});
