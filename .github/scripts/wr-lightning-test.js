'use strict';

// Focused regression harness for the WR-lightning fix (Task 1).
//
// recordPlayerFinish() emits `playerPbResult` with `isWorldRecord` when a finish
// is the map's #1 time. A Lightning brutal round speeds up the whole field, so a
// time set there isn't comparable to a normal run — it may still be a personal
// best (isNewRecord) but it must NOT be crowned a world record. This drives the
// real Game.recordPlayerFinish() with the leaderboard/auth deps mocked and asserts:
//   * Lightning active   -> isNewRecord:true,  isWorldRecord:FALSE
//   * Lightning inactive  -> isNewRecord:true,  isWorldRecord:TRUE  (control)

const path = require('path');
const repoRoot = path.join(__dirname, '..', '..');
const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
const game = require(path.join(repoRoot, 'server', 'game.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));
const auth = require(path.join(repoRoot, 'server', 'auth.js'));
const leaderboard = require(path.join(repoRoot, 'server', 'leaderboard.js'));

const LIGHTNING_ID = config.brutalRounds.lightning.id;
let failures = 0;
function check(cond, msg) { if (!cond) { failures++; console.log('::error::' + msg); } else { console.log('  ok: ' + msg); } }

// io stand-in so messenger doesn't throw if it's ever touched.
messenger.build({ to() { return { emit() {} }; }, sockets: { emit() {} } });

// Mock the async deps recordPlayerFinish awaits: a PB-improving finish that ranks #1.
auth.getDisplayName = async () => 'Tester';
leaderboard.upsertBestTime = async () => ({ isNewRecord: true });
leaderboard.getLeaderboardForPlayers = async () => [{ rank: 1 }];

// Capture the playerPbResult emit.
let lastPb = null;
messenger.messageRoomBySig = function (sig, event, payload) {
    if (event === 'playerPbResult') { lastPb = payload; }
};

async function runFinish(lightningActive) {
    lastPb = null;
    const room = game.getRoom('wrtest-' + (lightningActive ? 'L' : 'N'), 4);
    const g = room.game;
    g.raceStartedAt = 0;
    g.gameBoard.isPreview = false;
    g.gameBoard.currentMap = { id: 'wr-map', name: 'WR Map' };
    g.isStillOnMap = () => true; // map doesn't change mid-test
    g.gameBoard.checkForActiveBrutal = (id) => lightningActive && id === LIGHTNING_ID;
    const player = {
        id: 'wr-p1', isAI: false, verifiedUserId: 'user-1',
        reachedGoal: true, timeReached: 1500, pbWritten: false
    };
    g.recordPlayerFinish(player);
    // Let the mocked async chain (two awaits) settle.
    await Promise.all(g.pendingPbWrites.slice());
    await new Promise((r) => setTimeout(r, 20));
    return lastPb;
}

(async function () {
    const lit = await runFinish(true);
    check(lit != null, 'Lightning finish emitted a playerPbResult');
    if (lit) {
        check(lit.isNewRecord === true, 'Lightning: isNewRecord stays TRUE (PB float still shows)');
        check(lit.isWorldRecord === false, 'Lightning: isWorldRecord is FALSE (no world-record banner)');
        check(lit.rank === 1, 'Lightning: rank is still reported (=1) for the PB payload');
    }

    const norm = await runFinish(false);
    check(norm != null, 'Control (non-lightning) finish emitted a playerPbResult');
    if (norm) {
        check(norm.isNewRecord === true, 'Control: isNewRecord TRUE');
        check(norm.isWorldRecord === true, 'Control: isWorldRecord TRUE (a real #1 still crowns a world record)');
    }

    if (failures > 0) { console.log('\nWR-lightning test FAILED (' + failures + ').'); process.exit(1); }
    console.log('\nWR-lightning test passed.');
    process.exit(0);
})();
