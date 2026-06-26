'use strict';

// Room roster + standings snapshot — Phase 2 of seamless-reconnect.
//
// At SIGTERM we serialize each live room's roster + standings to a CROSS-PROCESS
// store (Supabase — the only store that survives a Heroku dyno cutover; the FS is
// per-dyno/ephemeral and there is no Redis). On boot the new process restores those
// rooms (same sig, held at a between-rounds/lobby state, excluded from matchmaking)
// and seeds the reconnect seat-index so a returning player (matched by userId/
// deviceId) is re-seated with their notches/team/cosmetics intact. Bots are NOT
// snapshotted — they refill fresh (Phase 3).
//
// Dependency-injected (hostess/reconnect/game passed in) so this module has no
// require cycle and is unit-testable with an in-memory store.

// --- snapshot shape (illustrative) -----------------------------------------
//  { sig, gameModeId, notchesToWin, round, currentState, savedAt, expiresAt,
//    players: [ { key, name, notches, teamId, color, cart, pattern, trailFx, border } ] }
// `key` is reconnect.reconnectKey(verifiedUserId, deviceId, slot) — the stable
// identity the returning socket re-keys on.

// How long a restored room + its seats stay claimable. Matches the restart grace
// ballpark (a reload + new-dyno boot + re-join), deliberately short so an abandoned
// snapshot doesn't hold a sig hostage.
var SNAPSHOT_TTL_MS = 2 * 60 * 1000;

// Serialize ONE room to a snapshot, or null if it shouldn't be snapshotted
// (preview/tarpit/Discord-instance rooms, or rooms with no reconnectable human).
function serializeRoom(room, reconnect, nowMs) {
    if (room == null || room.game == null) { return null; }
    if (room.isPreview || room.game.gameBoard.isPreview) { return null; }
    if (room.isTarpit || room.discordInstanceId) { return null; }
    var players = [];
    var pl = room.playerList || {};
    for (var id in pl) {
        var p = pl[id];
        if (p == null || p.isAI) { continue; } // bots refill fresh
        var key = reconnect.reconnectKey(p.verifiedUserId, p.deviceId, p.coopSlot != null ? p.coopSlot : 0);
        if (key == null) { continue; } // no stable identity -> can't reconnect this seat
        players.push({
            key: key,
            name: (p.name != null ? p.name : null),
            notches: (p.notches != null ? p.notches : 0),
            teamId: (p.teamId != null ? p.teamId : null),
            color: (p.color != null ? p.color : null),
            cart: (p.cart != null ? p.cart : null),
            pattern: (p.pattern != null ? p.pattern : null),
            trailFx: (p.trailFx != null ? p.trailFx : null),
            border: (p.border != null ? p.border : null)
        });
    }
    if (players.length === 0) { return null; } // nobody to bring back
    var gb = room.game.gameBoard;
    return {
        sig: room.sig,
        gameModeId: (gb.gameModeId != null ? gb.gameModeId : null),
        notchesToWin: (room.game.notchesToWin != null ? room.game.notchesToWin : null),
        round: (gb.round != null ? gb.round : 0),
        currentState: (room.game.currentState != null ? room.game.currentState : null),
        savedAt: nowMs,
        expiresAt: nowMs + SNAPSHOT_TTL_MS,
        players: players
    };
}

// Snapshot every eligible room. Returns an array of snapshots (callers persist them).
function snapshotAllRooms(hostess, reconnect, nowMs) {
    var out = [];
    var rooms = hostess.getRooms();
    for (var sig in rooms) {
        var snap = serializeRoom(rooms[sig], reconnect, nowMs);
        if (snap != null) { out.push(snap); }
    }
    return out;
}

// Restore ONE snapshot into the live registry: re-create the room at its sig, set the
// match config, mark it awaiting-reconnect (so matchmaking skips it), and seed the
// reconnect index with each saved seat's standings so enterGame can re-seat by identity.
function restoreSnapshot(snap, deps, nowMs) {
    if (snap == null || snap.sig == null) { return false; }
    if (snap.expiresAt != null && nowMs > snap.expiresAt) { return false; } // stale — skip
    var hostess = deps.hostess, reconnect = deps.reconnect;
    var room = hostess.restoreRoomAtSig(snap.sig);
    if (room == null) { return false; } // sig already taken (collision) — skip
    // Apply the saved match config so the room resumes consistently next round.
    if (snap.notchesToWin != null) { room.game.notchesToWin = snap.notchesToWin; }
    if (snap.gameModeId != null && room.game.gameBoard != null) { room.game.gameBoard.gameModeId = snap.gameModeId; }
    room.awaitingReconnect = true;          // excluded from findARoom until a saved seat returns
    room.reconnectExpiresAt = snap.expiresAt; // GC the held room if nobody comes back
    // Seed each saved seat into the reconnect index, carrying its standings so the
    // re-seat in enterGame can restore them onto the returning player's fresh kart.
    for (var i = 0; i < snap.players.length; i++) {
        var ps = snap.players[i];
        reconnect.recordSeat(ps.key, snap.sig, { restore: true, standings: ps });
        // Park it on the restore TTL so an abandoned seat self-evicts.
        reconnect.parkSeat(ps.key, nowMs, (snap.expiresAt - nowMs));
    }
    return true;
}

// Restore every fresh snapshot from the store. Returns the count restored.
function restoreAll(snapshots, deps, nowMs) {
    var n = 0;
    if (!Array.isArray(snapshots)) { return 0; }
    for (var i = 0; i < snapshots.length; i++) {
        if (restoreSnapshot(snapshots[i], deps, nowMs)) { n++; }
    }
    return n;
}

// Apply a restored seat's standings onto a freshly-spawned player (called from the
// enterGame re-seat path). Returns true if standings were applied. Does NOT restore
// `color` blindly (room-unique invariant) — the caller decides; here we apply notches/
// team/name/cosmetics, which are the standings a player cares about.
function applyStandings(player, standings) {
    if (player == null || standings == null) { return false; }
    if (standings.notches != null) { player.notches = standings.notches; }
    if (standings.teamId != null) { player.teamId = standings.teamId; }
    if (standings.name != null) { player.name = standings.name; }
    if (standings.cart != null) { player.cart = standings.cart; }
    if (standings.pattern != null) { player.pattern = standings.pattern; }
    if (standings.trailFx != null) { player.trailFx = standings.trailFx; }
    if (standings.border != null) { player.border = standings.border; }
    return true;
}

// --- stores ---------------------------------------------------------------------
// In-memory store: process-local (NOT cross-process) — for tests and a graceful
// degrade when Supabase is absent (reconnect simply won't survive a real restart).
function makeMemoryStore() {
    var rows = {};
    return {
        kind: 'memory',
        writeAll: function (snaps) { for (var i = 0; i < snaps.length; i++) { rows[snaps[i].sig] = snaps[i]; } return Promise.resolve(snaps.length); },
        readAllFresh: function (nowMs) {
            var out = [];
            for (var sig in rows) { if (rows[sig].expiresAt == null || nowMs <= rows[sig].expiresAt) { out.push(rows[sig]); } }
            return Promise.resolve(out);
        },
        purge: function (sigs) { for (var i = 0; i < sigs.length; i++) { delete rows[sigs[i]]; } return Promise.resolve(); },
        _rows: rows
    };
}

// Supabase store: the cross-process store that survives a dyno cutover. Reuses the
// shared auth.supabase client (no own connection). Table `room_snapshots` (migration
// supabase/migrations/<ts>_room_snapshots.sql): sig int PK, payload jsonb, expires_at
// timestamptz. Writes guard on auth.writesEnabled (NOT just enabled) — a writes-blocked
// tripwire would otherwise silently persist nothing.
function makeSupabaseStore(auth) {
    return {
        kind: 'supabase',
        available: function () { return !!(auth && auth.enabled && auth.supabase); },
        writable: function () { return !!(auth && auth.writesEnabled && auth.supabase); },
        writeAll: function (snaps) {
            if (!this.writable() || snaps.length === 0) { return Promise.resolve(0); }
            var rows = snaps.map(function (s) {
                return { sig: s.sig, payload: s, expires_at: new Date(s.expiresAt).toISOString() };
            });
            return auth.supabase.from('room_snapshots').upsert(rows, { onConflict: 'sig' })
                .then(function () { return rows.length; })
                .catch(function () { return 0; });
        },
        readAllFresh: function (nowMs) {
            if (!this.available()) { return Promise.resolve([]); }
            return auth.supabase.from('room_snapshots').select('payload,expires_at')
                .then(function (res) {
                    var data = (res && res.data) || [];
                    var out = [];
                    for (var i = 0; i < data.length; i++) {
                        var p = data[i].payload;
                        if (p && (p.expiresAt == null || nowMs <= p.expiresAt)) { out.push(p); }
                    }
                    return out;
                })
                .catch(function () { return []; });
        },
        purge: function (sigs) {
            if (!this.writable() || !sigs || sigs.length === 0) { return Promise.resolve(); }
            return auth.supabase.from('room_snapshots').delete().in('sig', sigs).then(function () {}).catch(function () {});
        }
    };
}

module.exports = {
    SNAPSHOT_TTL_MS: SNAPSHOT_TTL_MS,
    serializeRoom: serializeRoom,
    snapshotAllRooms: snapshotAllRooms,
    restoreSnapshot: restoreSnapshot,
    restoreAll: restoreAll,
    applyStandings: applyStandings,
    makeMemoryStore: makeMemoryStore,
    makeSupabaseStore: makeSupabaseStore
};
