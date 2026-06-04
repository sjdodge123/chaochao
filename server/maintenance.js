// Maintenance mode: announce an impending server restart to every connected
// client and stop NEW races from starting (a race already underway is left to
// finish). Two things turn it on:
//   - POST /ops/drain (index.js) — the deploy workflow calls it minutes ahead
//     of pushing the prod branch, so players get a heads-up and rooms drain.
//   - the SIGTERM handler in index.js — Heroku sends SIGTERM at every restart
//     and SIGKILLs 30s later, so this is the universal "30 seconds to go"
//     announcement, deploys and manual restarts alike.
// State auto-expires past `expiresAt` so a drained-but-never-restarted server
// (failed build, canceled run) resumes races on its own — no operator action.

// A drain's deadline marks the deploy *push*; the actual restart follows it by
// a Heroku build (minutes). The long grace keeps races blocked across that
// build window. A restart's deadline is the process exit itself — the small
// grace only matters if the exit somehow fails.
var DRAIN_GRACE_MS = 15 * 60 * 1000;
var RESTART_GRACE_MS = 2 * 60 * 1000;

var state = null; // { reason: 'drain'|'restart', deadline: ms, expiresAt: ms }

exports.begin = function (seconds, reason) {
	var now = Date.now();
	state = {
		reason: reason,
		deadline: now + seconds * 1000,
		expiresAt: now + seconds * 1000 + (reason === 'restart' ? RESTART_GRACE_MS : DRAIN_GRACE_MS),
	};
	// Lazy require: messenger -> hostess -> game must finish loading before
	// this module touches it (game.js requires us at its top).
	require('./messenger.js').broadcastAll('serverMaintenance', exports.getState());
	console.log('[maintenance] ' + reason + ' announced, deadline in ' + seconds + 's');
};

// null when inactive or expired. Broadcast on begin(); index.js also replays
// it to clients that connect mid-maintenance.
exports.getState = function () {
	if (state == null || Date.now() > state.expiresAt) { return null; }
	return state;
};

// Race-start gate, checked by game.js before the lobby->gated and
// overview->gated transitions.
exports.isRaceBlocked = function () {
	return exports.getState() != null;
};
