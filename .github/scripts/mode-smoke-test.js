'use strict';

// Game-mode matrix smoke test.
//
// The room-wide game mode (lobby hub mode station) changes what a whole match
// IS — Brutal FFA guarantees a brutal round every round; team modes (when they
// ship) change scoring and the win condition. This test exists so that any
// future feature that breaks a mode — crashes a tick, corrupts a compressor
// payload, stalls the state machine, or silently un-forces the brutal floor —
// fails the PR that introduces it, in EVERY mode, not just Standard FFA.
//
// It iterates config.gameModes dynamically: a mode added to config (and marked
// active) is covered on the next run with zero edits here. Per ACTIVE mode it:
//
//   Session 1 — plumbing: setGameMode validates (active-only, lobby-only via the
//     real messenger handler), the change broadcasts, and the join-page room
//     listing (hostess.getRooms) exposes the mode.
//   Session 2 — a FULL match to gameOver: rounds are driven to a finish by
//     teleporting one player onto the goal (bunker-aware: waits for the goal to
//     emerge first), asserting per round that brutal modes really get a brutal
//     config, that compressor payloads stay well-formed every tick, that the
//     match ends with the right winner, and that the mode survives gameOver.
//   Session 3 — engine sweep: EVERY committed map ticks under EVERY active mode
//     (the per-map analogue of smoke-test.js Session B).
//
// Like the other headless tests this boots the REAL server modules and drives
// the live tick loop; Date.now AND setTimeout are mocked into a fake clock the
// loop advances, so infection resurrections, collapse grace timers, etc. fire
// deterministically instead of never.
//
// Any failed assertion or throw exits 1.

const fs = require('fs');
const path = require('path');

// ---- fake clock + timer queue (installed before any gameplay runs) ----------
const realNow = Date.now;
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
let fakeNow = 1000000;
Date.now = () => fakeNow;
let timerSeq = 1;
let timers = [];
global.setTimeout = function (fn, ms) {
    const args = Array.prototype.slice.call(arguments, 2);
    const id = { __fake: timerSeq++ };
    timers.push({ id: id.__fake, at: fakeNow + (Number(ms) || 0), fn: fn, args: args });
    return id;
};
global.clearTimeout = function (id) {
    const key = (id && id.__fake) ? id.__fake : id;
    timers = timers.filter(t => t.id !== key);
};
// Fire every timer whose due time has passed (in order). Timers scheduled by a
// firing timer for a past/now due time run in the same drain (capped).
function runDueTimers() {
    for (let pass = 0; pass < 10; pass++) {
        const due = timers.filter(t => t.at <= fakeNow).sort((a, b) => a.at - b.at);
        if (due.length === 0) { return; }
        timers = timers.filter(t => t.at > fakeNow);
        for (const t of due) { t.fn.apply(null, t.args); }
    }
}

const repoRoot = path.join(__dirname, '..', '..');
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const hostess = require(path.join(repoRoot, 'server', 'hostess.js'));
const game = require(path.join(repoRoot, 'server', 'game.js'));
const compressor = require(path.join(repoRoot, 'server', 'compressor.js'));
const utils = require(path.join(repoRoot, 'server', 'utils.js'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));
const c = utils.loadConfig();

const DT = c.serverTickSpeed / 1000;
let failures = 0;
function check(cond, msg) {
    if (!cond) { failures++; console.log('::error::Modes: ' + msg); }
    else { console.log('ok: ' + msg); }
}

// Record every room broadcast so sessions can assert on emitted events.
let roomEmits = [];
const fakeIo = {
    to() { return { emit(event, payload) { roomEmits.push({ event: event, payload: payload }); } }; },
    sockets: { emit() { } }
};
messenger.build(fakeIo);

function makeFakeSocket(id) {
    const handlers = {};
    return {
        id: id,
        handlers: handlers,
        on(event, fn) { handlers[event] = fn; },
        emit() { },
        join() { },
        leave() { },
        broadcast: { to() { return { emit() { } }; } },
        fire(event, payload) { if (handlers[event]) handlers[event](payload); }
    };
}

function activeModes() {
    return (c.gameModes || []).filter(m => m && m.active === true);
}

function pickMapWithGoal() {
    const dir = path.join(repoRoot, 'client', 'maps');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_'));
    for (const file of files) {
        let m = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        if (mapFormat.isSitesOnly(m)) { m = mapFormat.reconstruct(m); }
        if (m.cells && m.cells.some(cell => cell.id === c.tileMap.goal.id)) { return { name: file, map: m }; }
    }
    return null;
}

function buildRoom(sig, nPlayers, map) {
    const room = game.getRoom(sig, 8);
    room.game.gameBoard.isPreview = true; // pin the map; no bot grid-fill
    room.game.gameBoard.previewMap = map;
    for (let i = 0; i < nPlayers; i++) {
        const id = sig + '-p' + i;
        const player = room.world.createNewPlayer(id);
        room.playerList[id] = player;
        room.game.determineGameState(player);
    }
    return room;
}

// One server tick: advance the clock, fire due timeouts, keep everyone awake
// (no sockets here, so nobody ever sends the input/activity that defers the
// AFK kick), update, and verify the compressor still produces client-decodable
// arrays — the same bar smoke-test.js holds every tick to.
function tick(room, label) {
    fakeNow += Math.round(DT * 1000);
    runDueTimers();
    for (const id in room.playerList) {
        if (room.playerList[id] && typeof room.playerList[id].wakeUp === 'function') {
            room.playerList[id].wakeUp();
        }
    }
    room.update(DT);
    const checks = {
        playerList: compressor.sendPlayerUpdates(room.playerList),
        projList: compressor.sendProjUpdates(room.projectileList),
        aimerList: compressor.sendAimerUpdates(room.aimerList),
        hazardList: compressor.sendHazardUpdates(room.hazardList)
    };
    for (const key in checks) {
        if (!Array.isArray(checks[key])) {
            failures++;
            console.log('::error::Modes: ' + label + ': compressor.' + key + ' returned a non-array');
        }
    }
}

function findGoalCell(gb) {
    const cells = gb.currentMap.cells;
    for (let i = 0; i < cells.length; i++) {
        if (cells[i].id === c.tileMap.goal.id) { return cells[i]; }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Session 1: mode plumbing through the REAL messenger handler + room listing.
// ---------------------------------------------------------------------------
function sessionPlumbing() {
    const s = makeFakeSocket('mode-plumb-0');
    messenger.addMailBox(s.id, s);
    s.fire('enterGame', -1);
    const sigs = Object.keys(hostess.getRooms());
    if (sigs.length === 0) {
        check(false, 'Session 1: enterGame created no joinable room');
        return;
    }
    const room = hostess.getRoomBySig(sigs[0]);
    const gb = room.game.gameBoard;

    check(gb.gameModeId === (c.defaultGameMode || 'standard_ffa'), 'rooms start on the default mode');
    check(hostess.getRooms()[sigs[0]].mode === gb.gameModeId, 'join-page room listing exposes the mode');

    // The handler is lobby-only; put the room in the lobby for the happy path.
    room.game.startLobby();
    const modes = activeModes();
    const nonDefault = modes.find(m => m.id !== gb.gameModeId);
    if (nonDefault == null) {
        check(false, 'Session 1: config has no second ACTIVE mode to switch to');
        return;
    }
    roomEmits = [];
    s.fire('setLobbyGameMode', { id: nonDefault.id });
    check(gb.gameModeId === nonDefault.id, 'setLobbyGameMode switches the room mode in the lobby');
    check(roomEmits.some(e => e.event === 'lobbyGameModeChanged' && e.payload && e.payload.id === nonDefault.id),
        'mode change broadcasts lobbyGameModeChanged to the room');
    check(hostess.getRooms()[sigs[0]].mode === nonDefault.id, 'room listing reflects the new mode');

    // Inactive + unknown ids are refused.
    const inactive = (c.gameModes || []).find(m => m && m.active !== true);
    if (inactive != null) {
        s.fire('setLobbyGameMode', { id: inactive.id });
        check(gb.gameModeId === nonDefault.id, 'an INACTIVE configured mode cannot be selected');
    }
    s.fire('setLobbyGameMode', { id: 'no-such-mode' });
    check(gb.gameModeId === nonDefault.id, 'an unknown mode id is rejected');
    s.fire('setLobbyGameMode', { id: 42 });
    check(gb.gameModeId === nonDefault.id, 'a non-string mode payload is rejected');

    // Mode locks once the room leaves the lobby.
    room.game.currentState = c.stateMap.racing;
    s.fire('setLobbyGameMode', { id: c.defaultGameMode });
    check(gb.gameModeId === nonDefault.id, 'mode cannot change outside the lobby (locked at race start)');

    hostess.kickFromRoom(s.id);
    messenger.removeMailBox(s.id);
    if (failures === 0) { console.log('Session 1 passed: mode plumbing.\n'); }
}

// ---------------------------------------------------------------------------
// Session 2: a full match to gameOver in every active mode.
// ---------------------------------------------------------------------------
function playRound(room, finisherId, label) {
    const g = room.game, gb = g.gameBoard;
    g.startGated(); // loadNextMap -> brutal roll -> setupMap (the natural overview->gated hop)

    if (gb.isBrutalMode()) {
        check(gb.brutalConfig != null && gb.brutalConfig.brutal === true && gb.brutalConfig.brutalTypes.length >= 1,
            label + ': brutal mode guaranteed a brutal round (got ' +
            JSON.stringify(gb.brutalConfig && gb.brutalConfig.brutalTypes) + ')');
    }

    g.startRace();
    const finisher = room.playerList[finisherId];
    let guard = 0;

    // Bunker buries the goal: the round only finishes after the last player
    // standing makes it emerge. Kill the rest first, wait for emergence, then
    // claim it — the same lifecycle a real bunker round runs.
    if (gb.goalBuried === true) {
        for (const id in room.playerList) {
            if (id !== finisherId) { room.playerList[id].alive = false; }
        }
        while (gb.goalBuried && guard++ < 900) { tick(room, label); }
        check(gb.goalBuried === false, label + ': bunker goal emerged for the last player standing');
        if (gb.goalBuried) { return false; }
        finisher.x = gb.bunkerLoc.x;
        finisher.y = gb.bunkerLoc.y;
    } else {
        const goal = findGoalCell(gb);
        check(goal != null, label + ': map has a goal tile');
        if (goal == null) { return false; }
        finisher.x = goal.site.x;
        finisher.y = goal.site.y;
    }
    finisher.velX = 0;
    finisher.velY = 0;

    // Tick (re-pinning against knockback/hazards) until the finish registers.
    guard = 0;
    while (finisher.reachedGoal !== true && g.currentState !== c.stateMap.gameOver && guard++ < 300) {
        if (gb.goalBuried === false && gb.bunkerLoc != null) {
            finisher.x = gb.bunkerLoc.x; finisher.y = gb.bunkerLoc.y;
        } else {
            const goal = findGoalCell(gb);
            if (goal != null) { finisher.x = goal.site.x; finisher.y = goal.site.y; }
        }
        finisher.velX = 0; finisher.velY = 0;
        tick(room, label);
    }
    check(finisher.reachedGoal === true || g.currentState === c.stateMap.gameOver,
        label + ': the teleported finisher reached the goal');

    // Conclude everyone else so the round ends (infection resurrections etc.
    // run on the mocked timers and resolve inside the guard window).
    for (const id in room.playerList) {
        const p = room.playerList[id];
        if (id !== finisherId && p.reachedGoal !== true) { p.alive = false; }
    }
    guard = 0;
    while (g.currentState !== c.stateMap.overview && g.currentState !== c.stateMap.gameOver && guard++ < 1500) {
        tick(room, label);
    }
    check(g.currentState === c.stateMap.overview || g.currentState === c.stateMap.gameOver,
        label + ': round concluded to overview/gameOver (state=' + g.currentState + ')');
    return g.currentState === c.stateMap.overview || g.currentState === c.stateMap.gameOver;
}

function sessionFullMatchPerMode(picked) {
    const modes = activeModes();
    check(modes.length >= 1, 'config defines at least one active game mode');
    for (const mode of modes) {
        const label = 'mode ' + mode.id;
        const sig = 'mode-match-' + mode.id;
        const room = buildRoom(sig, 3, picked.map);
        const g = room.game, gb = g.gameBoard;

        g.startLobby();
        if (mode.id !== gb.gameModeId) {
            check(gb.setGameMode(mode.id) === true, label + ': setGameMode accepts the active mode');
        }
        check(gb.gameModeId === mode.id, label + ': room runs the requested mode');

        const finisherId = sig + '-p0';
        roomEmits = [];
        let rounds = 0;
        let teamsChecked = false;
        let round1Brutal = null;
        // Generous cap: a 3-player teams match nets ~+4/round, so it ends via the
        // maxRounds leader rule (round 12) rather than the points target.
        while (g.currentState !== c.stateMap.gameOver && rounds < 15) {
            rounds++;
            if (!playRound(room, finisherId, label + ' round ' + rounds)) { break; }
            if (failures > 0) { break; }
            if (rounds === 1) {
                round1Brutal = (gb.brutalConfig != null && gb.brutalConfig.brutal === true);
            }
            // Teams invariants, checked once after the first completed round.
            if (mode.teams === true && !teamsChecked) {
                teamsChecked = true;
                const counts = {};
                let unassigned = 0;
                for (const id in room.playerList) {
                    const t = room.playerList[id].teamId;
                    if (t == null) { unassigned++; } else { counts[t] = (counts[t] || 0) + 1; }
                }
                const sizes = Object.values(counts);
                check(unassigned === 0, label + ': every player has a team');
                check(sizes.length === 2 && Math.abs(sizes[0] - sizes[1]) <= 1,
                    label + ': teams are balanced (' + JSON.stringify(counts) + ')');
                // Points ledger after round 1: the finisher banked firstPlace (5),
                // minus at most one teammate death (-1) => their team holds >= 4 and
                // leads the opponents (whose deaths floor them at 0).
                const ft = room.playerList[finisherId].teamId;
                const pts = g.teamPointsCfg();
                check(g.teamPoints != null && g.teamPoints[ft] >= pts.firstPlace + pts.death,
                    label + ': first place + deaths settled into the team points (' + JSON.stringify(g.teamPoints) + ')');
            }
            if (mode.teams !== true && !teamsChecked) {
                teamsChecked = true;
                let anyTeam = false;
                for (const id in room.playerList) { if (room.playerList[id].teamId != null) { anyTeam = true; } }
                check(!anyTeam, label + ': FFA mode assigns no teams');
            }
        }
        if (failures > 0) { return; }

        check(g.currentState === c.stateMap.gameOver, label + ': match reached gameOver in ' + rounds + ' round(s)');
        const over = roomEmits.filter(e => e.event === 'startGameover').pop();
        check(over != null && over.payload && over.payload.winner === finisherId,
            label + ': the repeat first-finisher won the match');
        if (mode.teams === true) {
            const team = over && over.payload ? over.payload.team : null;
            check(team != null && team.id === room.playerList[finisherId].teamId
                && Array.isArray(team.members) && team.members.indexOf(finisherId) !== -1,
                label + ': gameOver names the clincher\'s TEAM (with members) as the winner');
        }

        // Standard (non-brutal) regression guard: round 1 rolls against a 0%
        // base chance, so a standard-mode match must NOT open on a brutal round —
        // a real assertion, so a regression that forces brutal rounds in standard
        // modes fails here. (Brutal modes assert the inverse inside playRound.)
        if (mode.brutal !== true) {
            check(round1Brutal === false, label + ': non-brutal mode left the brutal roller alone (round 1 not brutal)');
        }

        // Mode persistence: the room keeps its mode across gameOver (it only
        // resets when the room dies), so the NEXT match is the same kind of game.
        g.gameOverTimer = null;
        check(gb.gameModeId === mode.id, label + ': mode persisted through gameOver');
        console.log('Session 2 passed for ' + label + ' (' + rounds + ' rounds).\n');
    }
}

// ---------------------------------------------------------------------------
// Session 4: teams-specific mechanics — friendly fire, late-join balance, and
// the team-aware bunker emerge. Runs against the first ACTIVE teams mode.
// ---------------------------------------------------------------------------
function fakePunchFrom(attacker, victim) {
    return {
        clashed: false, mapOwned: false, landed: false, type: 'player',
        ownerId: attacker.id, ownerTeamId: attacker.teamId, ownerInfected: !!attacker.isZombie,
        x: victim.x + 6, y: victim.y, getBonus() { return 3; }
    };
}
function sessionTeamMechanics(picked) {
    const teamsMode = activeModes().find(m => m.teams === true);
    if (teamsMode == null) { console.log('Session 4 skipped: no active teams mode.'); return; }
    const sig = 'mode-teams-mech';
    const room = buildRoom(sig, 4, picked.map);
    const g = room.game, gb = g.gameBoard;
    g.startLobby();
    gb.setGameMode(teamsMode.id);
    g.startGated();
    g.startRace();
    for (let f = 0; f < 5; f++) { tick(room, 'teams-mech'); }

    const ids = Object.keys(room.playerList);
    const byTeam = { 0: [], 1: [] };
    for (const id of ids) { byTeam[room.playerList[id].teamId].push(room.playerList[id]); }
    check(byTeam[0].length === 2 && byTeam[1].length === 2, 'teams-mech: 4 players split 2v2');
    if (byTeam[0].length < 2 || byTeam[1].length < 2) { return; }

    // Friendly fire: a teammate's punch is a no-op; an enemy's punch shoves.
    const victim = byTeam[0][0], mate = byTeam[0][1], enemy = byTeam[1][0];
    victim.velX = 0; victim.velY = 0;
    victim.handlePunchHit(fakePunchFrom(mate, victim));
    check(victim.velX === 0 && victim.velY === 0 && victim.punchedBy == null,
        'teams-mech: teammate punch is a no-op (no shove, no attribution)');
    victim.handlePunchHit(fakePunchFrom(enemy, victim));
    check(victim.velX !== 0 || victim.velY !== 0, 'teams-mech: enemy punch still shoves');
    check(victim.punchedBy === enemy.id, 'teams-mech: enemy punch attributes the hit');
    // Zombified teammate overrides the team gate (infection round behaviour).
    victim.velX = 0; victim.velY = 0; victim.punchedBy = null;
    mate.isZombie = true;
    victim.handlePunchHit(fakePunchFrom(mate, victim));
    check(victim.velX !== 0 || victim.velY !== 0, 'teams-mech: a ZOMBIE teammate\'s bite still lands');
    mate.isZombie = false;

    // Late joiner mid-match: lands on the smaller team. Kill one Jade member off
    // the roster entirely (leave) to skew counts, then join someone new.
    const leaver = byTeam[1][1];
    delete room.playerList[leaver.id];
    const joiner = room.world.createNewPlayer(sig + '-late');
    room.playerList[joiner.id] = joiner;
    g.determineGameState(joiner);
    check(joiner.teamId === byTeam[1][0].teamId,
        'teams-mech: late joiner assigned to the smaller team');

    // The clinch: a team HOLDING the points target whose member takes first place
    // wins the match on the spot, mid-round (uses the TEAM_POINTS_START dev seam
    // to open round 1 at the target).
    process.env.TEAM_POINTS_START = '60';
    try {
        const room3 = buildRoom('mode-teams-clinch', 4, picked.map);
        room3.game.startLobby();
        room3.game.gameBoard.setGameMode(teamsMode.id);
        roomEmits = [];
        check(playRound(room3, 'mode-teams-clinch-p0', 'teams-clinch'),
            'teams-mech: seeded match-point round completed');
        check(room3.game.currentState === c.stateMap.gameOver,
            'teams-mech: first place AT the target clinched the match mid-round');
        const overC = roomEmits.filter(e => e.event === 'startGameover').pop();
        check(overC != null && overC.payload && overC.payload.team != null
            && overC.payload.team.id === room3.playerList['mode-teams-clinch-p0'].teamId,
            'teams-mech: the clincher\'s team is the winner');
    } finally {
        delete process.env.TEAM_POINTS_START;
    }

    // Team-aware bunker emerge: with Crimson fully dead and TWO Jade players still
    // alive, the door must open (one TEAM remains — not one player).
    c.brutalTypesForce = [c.brutalRounds.bunker.id];
    try {
        const room2 = buildRoom('mode-teams-bunker', 4, picked.map);
        const g2 = room2.game, gb2 = room2.game.gameBoard;
        room2.game.startLobby();
        gb2.setGameMode(teamsMode.id);
        g2.startGated();
        check(gb2.goalBuried === true, 'teams-mech: bunker round set up (goal buried)');
        g2.startRace();
        for (let f = 0; f < 5; f++) { tick(room2, 'teams-bunker'); }
        const teams2 = { 0: [], 1: [] };
        for (const id in room2.playerList) { teams2[room2.playerList[id].teamId].push(room2.playerList[id]); }
        teams2[0].forEach(p => { p.alive = false; });
        let guard = 0;
        while (gb2.goalBuried && guard++ < 600) { tick(room2, 'teams-bunker'); }
        const jadeAlive = teams2[1].filter(p => p.alive).length;
        check(gb2.goalBuried === false && jadeAlive === 2,
            'teams-mech: bunker emerged with one TEAM remaining (' + jadeAlive + ' teammates still alive)');
    } finally {
        delete c.brutalTypesForce;
    }
    if (failures === 0) { console.log('Session 4 passed: team mechanics.\n'); }
}

// ---------------------------------------------------------------------------
// Session 3: every committed map ticks under every active mode.
// ---------------------------------------------------------------------------
function sessionEveryMapEveryMode() {
    const mapsDir = path.join(repoRoot, 'client', 'maps');
    const files = fs.readdirSync(mapsDir).filter(f => f.endsWith('.json'));
    const modes = activeModes();
    let ran = 0;

    for (const mode of modes) {
        for (const file of files) {
            let map = JSON.parse(fs.readFileSync(path.join(mapsDir, file), 'utf8'));
            if (mapFormat.isSitesOnly(map)) { map = mapFormat.reconstruct(map); }
            const label = 'sweep ' + mode.id + ' / ' + file;
            const sig = 'mode-sweep-' + mode.id + '-' + ran;
            const room = buildRoom(sig, 2, map);
            try {
                room.game.startLobby();
                if (mode.id !== room.game.gameBoard.gameModeId) {
                    room.game.gameBoard.setGameMode(mode.id);
                }
                room.game.startGated();
                if (mode.brutal === true) {
                    const bc = room.game.gameBoard.brutalConfig;
                    if (!(bc != null && bc.brutal === true)) {
                        failures++;
                        console.log('::error::Modes: ' + label + ': brutal mode round was not brutal');
                    }
                }
                room.game.startRace();
                for (let f = 0; f < 40; f++) {
                    for (const id in room.playerList) {
                        const p = room.playerList[id];
                        p.moveForward = Math.random() < 0.5;
                        p.moveBackward = Math.random() < 0.5;
                        p.turnLeft = Math.random() < 0.5;
                        p.turnRight = Math.random() < 0.5;
                        p.attack = Math.random() < 0.5;
                        p.angle = Math.random() * 360;
                    }
                    tick(room, label);
                    if (failures > 0) { return; }
                }
            } catch (e) {
                failures++;
                console.log('::error::Modes: ' + label + ' broke the engine: ' + e.message + '\n' + e.stack);
                return;
            }
            ran++;
        }
    }
    console.log('Session 3 passed: engine ran ' + ran + ' map×mode combination(s).');
}

const picked = pickMapWithGoal();
if (picked == null) {
    console.log('::error::Modes: no committed map with goal tiles found');
    process.exit(1);
}
console.log('Full-match map: ' + picked.name + '\n');

try {
    sessionPlumbing();
    if (failures === 0) { sessionFullMatchPerMode(picked); }
    if (failures === 0) { sessionTeamMechanics(picked); }
    if (failures === 0) { sessionEveryMapEveryMode(); }
} catch (e) {
    failures++;
    console.log('::error::Modes: unhandled exception: ' + e.message + '\n' + e.stack);
}

Date.now = realNow;
global.setTimeout = realSetTimeout;
global.clearTimeout = realClearTimeout;

if (failures > 0) {
    console.log('\nGame-mode matrix test FAILED with ' + failures + ' error(s).');
    process.exit(1);
}
console.log('\nGame-mode matrix test passed: every active mode boots, races, and ends a match.');
process.exit(0);
