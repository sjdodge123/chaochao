'use strict';

// AI fitness harness — the measurement protocol from the PR #181 ice-nav work,
// made durable. For each seed it runs a full 120s race window on the pinned map
// with 6 cast bots (real engine, mocked clock, seeded RNG) and reports per-map:
//
//   finishers     cumulative finish EVENTS (reachedGoal rising edges — rounds
//                 cycle inside the window and reset the flag, so edges are
//                 counted, not the end-state)
//   frozen        bots alive but motionless (<40px) over the window's last 5s —
//                 the "parked at an obstacle" pathology
//   deaths        cumulative death events, with medianDeathX (how far along the
//                 map bots die)
//   avgX          mean of each bot's max x reached (progress proxy)
//
// Use it A/B: run the same maps+seeds against two checkouts (REPO_ROOT) and
// diff. Maps with no moving hazards should produce IDENTICAL lines for an
// AI-steering change — a built-in determinism check. Known-completable control
// maps: crossroads, FastandSlow, IcyLake.
//
// Usage: REPO_ROOT=<repo checkout> node ai-fitness.js <MapName> [nSeeds=8]
// Not CI-wired (a 14-map sweep is minutes of CPU); run it when touching
// server/aiController.js steering or pathing.
const W = process.env.REPO_ROOT;
const fs = require('fs');
// Mock clock + scheduled timeouts BEFORE requiring game modules (harness memo).
let simNow = 1e6; const realDateNow = Date.now; Date.now = () => simNow;
const pend = [];
global.setTimeout = (fn, d, ...a) => { pend.push({ at: simNow + (d || 0), fn, a }); return pend.length; };
global.clearTimeout = () => { };
function tickClock(ms) { simNow += ms; pend.sort((a, b) => a.at - b.at); while (pend.length && pend[0].at <= simNow) { const t = pend.shift(); try { t.fn(...t.a); } catch (e) { } } }
const messenger = require(W + '/server/messenger.js');
messenger.build({ to() { return { emit() { } }; }, sockets: { emit() { } } });
const config = require(W + '/server/config.json');
const mapFormat = require(W + '/server/mapFormat.js');
const game = require(W + '/server/game.js');
const DT = config.serverTickSpeed / 1000;
const TICKS = Math.round(120 / DT); // 120s window
const mapName = process.argv[2];
const N_SEEDS = parseInt(process.argv[3] || '8', 10);
const raw = JSON.parse(fs.readFileSync(W + '/client/maps/' + mapName + '.json'));
const cast = (config.aiRacers && config.aiRacers.cast) || [];

function mulberry32(seed) { let a = seed >>> 0; return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

let finishers = 0, frozen = 0, total = 0;
const deathXs = []; let sumMaxX = 0;
for (let s = 0; s < N_SEEDS; s++) {
  Math.random = mulberry32(0xA11CE + s * 7919);
  const map = raw.sites ? mapFormat.reconstruct(JSON.parse(JSON.stringify(raw))) : JSON.parse(JSON.stringify(raw));
  const room = game.getRoom('fit-' + mapName + '-' + s, 8);
  room.game.gameBoard.isPreview = true;
  room.game.gameBoard.previewMap = map;
  const bots = [];
  for (let i = 0; i < 6; i++) {
    const bid = 'fit' + s + '-bot' + i;
    const b = room.world.createNewBot(bid, cast.length ? cast[i % cast.length] : null);
    room.playerList[bid] = b; bots.push(b);
  }
  room.game.determineGameState(bots[0]);
  room.game.startLobby(); room.game.startGated();
  for (let g = 0; g < 30; g++) { tickClock(config.serverTickSpeed); room.update(DT); }
  room.game.startRace();
  const lateMark = TICKS - Math.round(5 / DT); // positions 5s before window end
  const lastPos = {}; const maxXById = {};
  // Rounds cycle inside the 120s window (reachedGoal/alive reset each round), so
  // count finish/death EVENTS on edges, cumulatively across the window.
  const prevGoal = {}, prevAlive = {};
  for (const b of bots) { prevGoal[b.id] = false; prevAlive[b.id] = true; }
  for (let f = 0; f < TICKS; f++) {
    room.game.notchesToWin = 99; // don't end the match on a finish; measure everyone
    tickClock(config.serverTickSpeed);
    try { room.update(DT); } catch (e) { console.log('TICK THROW seed ' + s + ': ' + e.message); break; }
    if (f === lateMark) { for (const b of bots) { lastPos[b.id] = { x: b.x, y: b.y }; } }
    if (f % 10 === 0) { for (const b of bots) { if (b.x > (maxXById[b.id] || -1e9)) { maxXById[b.id] = b.x; } } }
    for (const b of bots) {
      if (b.reachedGoal && !prevGoal[b.id]) { finishers++; }
      prevGoal[b.id] = !!b.reachedGoal;
      if (!b.alive && prevAlive[b.id]) { deathXs.push(Math.round(b.x)); }
      prevAlive[b.id] = !!b.alive;
    }
    if (room.game.currentState === config.stateMap.gameOver) { break; }
  }
  for (const b of bots) {
    total++;
    sumMaxX += (maxXById[b.id] != null ? maxXById[b.id] : b.x);
    if (b.alive && !b.reachedGoal) {
      const lp = lastPos[b.id];
      if (lp != null && Math.hypot(b.x - lp.x, b.y - lp.y) < 40) { frozen++; }
    }
  }
}
deathXs.sort((a, b) => a - b);
const med = deathXs.length ? deathXs[Math.floor(deathXs.length / 2)] : -1;
console.log(mapName + ': finishers=' + finishers + '/' + total + ' frozen=' + frozen + ' deaths=' + deathXs.length + ' medianDeathX=' + med + ' avgX=' + Math.round(sumMaxX / total));
process.exit(0);
