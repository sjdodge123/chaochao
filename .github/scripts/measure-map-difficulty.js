'use strict';

// Catalog-wide difficulty sweep: re-measures perRoundFrac for every racing map
// and (with --write) regenerates server/mapDifficulty.json. This is THE
// committed, reproducible procedure the _doc in that file refers to — run it
// after any aiController/steering/pathing change (which invalidates all stored
// measurements, per the AI-fitness protocol) or whenever maps are added in
// bulk. The methodology lives in lib/sim-window.js, shared with the per-map
// estimate the map-submission CI prints, so all three stay on one ruler.
//
// Usage:
//   node .github/scripts/measure-map-difficulty.js              # report only
//   node .github/scripts/measure-map-difficulty.js --write      # rewrite mapDifficulty.json
//   node .github/scripts/measure-map-difficulty.js "Gold Eyes"  # single map report
//
// --write preserves _doc and aiArtifacts verbatim and replaces perRoundFrac
// wholesale (sorted by key), INCLUDING entries for aiArtifacts maps — their
// values stay recorded for transparency; the classifier ignores them anyway.
// Review the printed tier diff before committing the result: a map crossing a
// cutoff changes when the ramp serves it.

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const dataPath = path.join(repoRoot, 'server', 'mapDifficulty.json');

const messenger = require(path.join(repoRoot, 'server', 'messenger.js'));
// io stand-in so room emits don't throw in this no-network harness.
messenger.build({ to() { return { emit() { } }; }, sockets: { emit() { } } });

const utils = require(path.join(repoRoot, 'server', 'utils.js'));
const config = utils.loadConfig();
const game = require(path.join(repoRoot, 'server', 'game.js'));
const mapClassifier = require(path.join(repoRoot, 'server', 'mapClassifier.js'));
const simWindow = require(path.join(__dirname, 'lib', 'sim-window.js'));

const WINDOWS = 8; // the sweep's seed count — keep unless recalibrating ALL cutoffs

const args = process.argv.slice(2);
const write = args.includes('--write');
const onlyName = args.find(a => a !== '--write') || null;

const existing = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const oldFracs = existing.perRoundFrac || {};

let maps = utils.loadMaps().filter(m => !m.lobbyOnly);
if (onlyName) {
    maps = maps.filter(m => m.name === onlyName || mapClassifier.difficultyKey(m.name) === mapClassifier.difficultyKey(onlyName));
    if (maps.length === 0) { console.log('::error::no map named ' + JSON.stringify(onlyName)); process.exit(1); }
}

const fracs = {};
let moved = 0, failed = 0;
for (const map of maps) {
    const key = mapClassifier.difficultyKey(map.name);
    let line = key + ': ';
    const m = simWindow.measurePerRoundFrac(game, config, map, WINDOWS);
    if (m == null) {
        // No round ever observed — keep the old value if there is one rather than
        // silently dropping the map to the heuristic tier.
        failed++;
        if (oldFracs[key] != null) { fracs[key] = oldFracs[key]; }
        console.log(line + 'MEASUREMENT FAILED (0 rounds observed)' + (oldFracs[key] != null ? ' — keeping old ' + oldFracs[key] : ''));
        continue;
    }
    fracs[key] = m.perRoundFrac;
    line += m.perRoundFrac + ' (' + mapClassifier.gradeDifficultyFrac(m.perRoundFrac, config) + ', ' + m.rounds + ' rounds)';
    if (oldFracs[key] != null) {
        const oldTier = mapClassifier.gradeDifficultyFrac(oldFracs[key], config);
        const newTier = mapClassifier.gradeDifficultyFrac(m.perRoundFrac, config);
        if (oldTier !== newTier) { moved++; line += '  << TIER MOVED ' + oldTier + ' -> ' + newTier + ' (was ' + oldFracs[key] + ')'; }
    } else {
        line += '  << NEW';
    }
    console.log(line);
}

console.log('\n' + maps.length + ' map(s) measured, ' + moved + ' tier move(s), ' + failed + ' failure(s).');

if (write) {
    if (onlyName) { console.log('::error::--write with a single-map filter would drop every other entry; run over the full catalog.'); process.exit(1); }
    const sorted = {};
    for (const k of Object.keys(fracs).sort()) { sorted[k] = fracs[k]; }
    const out = { _doc: existing._doc, aiArtifacts: existing.aiArtifacts, perRoundFrac: sorted };
    fs.writeFileSync(dataPath, JSON.stringify(out, null, 2) + '\n');
    console.log('Wrote ' + path.relative(repoRoot, dataPath) + '. Re-run validate-content + difficulty-ramp-test before committing.');
} else {
    console.log('Report only — re-run with --write to update server/mapDifficulty.json.');
}
