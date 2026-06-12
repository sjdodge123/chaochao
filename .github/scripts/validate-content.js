'use strict';

// Content validation gate for PRs into main.
//
// Catches broken game *data* that a JavaScript syntax check and bundle build
// cannot see: a malformed map JSON (the in-browser editor opens PRs that add
// these), or a config.json that no longer has the keys the engine reads. Both
// would pass `node --check` yet crash the server at boot or mid-game.
//
// Structural map validation reuses the server's own utils.validateMap() so this
// stays in lockstep with the trust-boundary check the live editor runs before a
// play-test — one source of truth, not a re-implementation that can drift.
//
// Note on ordering: server/utils.js require()s every map at module load, so a
// malformed map JSON would crash this script with an ugly stack trace before any
// of our checks run. We therefore JSON-parse config.json and all maps OURSELVES
// first (clean per-file ::error:: messages — these failures come from non-dev
// map submissions), and only require utils.js once we know everything parses.
//
// Exits 0 when everything is valid, 1 (with ::error:: annotations) otherwise.

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const mapsDir = path.join(repoRoot, 'client', 'maps');
const configPath = path.join(repoRoot, 'server', 'config.json');

const errors = [];
function fail(msg) {
    errors.push(msg);
    console.log('::error::' + msg);
}

// Non-fatal: surfaced as a GitHub Actions warning annotation (doesn't fail the
// build), for things a human should look at but that don't break the game.
function warn(msg) {
    console.log('::warning::' + msg);
}

function done() {
    if (errors.length > 0) {
        console.log('\nContent validation FAILED with ' + errors.length + ' error(s).');
        process.exit(1);
    }
}

// --- Phase 1: parse everything ourselves (no utils.js require yet) ----------
let config = null;
try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (e) {
    fail('server/config.json: invalid JSON — ' + e.message);
}

const parsedMaps = []; // { file, map }
const mapFiles = fs.readdirSync(mapsDir).filter(f => f.endsWith('.json'));
if (mapFiles.length === 0) {
    fail('client/maps contains no .json maps');
}
for (const file of mapFiles) {
    try {
        parsedMaps.push({ file, map: JSON.parse(fs.readFileSync(path.join(mapsDir, file), 'utf8')) });
    } catch (e) {
        fail('client/maps/' + file + ': invalid JSON — ' + e.message);
    }
}

// A parse failure (or unreadable config) means requiring utils.js below would
// itself crash. Bail now with the clean messages we already have.
done();

// --- Phase 2: structural checks (safe to load the server's own validator) ---
const utils = require(path.join(repoRoot, 'server', 'utils.js'));
const mapFormat = require(path.join(repoRoot, 'server', 'mapFormat.js'));

// config.json keys read unconditionally in game.js / engine.js / validateMap;
// if any go missing or change type, the server breaks on the first tick.
const numericKeys = [
    'port', 'serverTickSpeed', 'worldWidth', 'worldHeight',
    'worldCollapseSpeed', 'minPlayersToStart', 'maxPlayersInRoom',
    'forceConstant', 'baseNotchesToWin', 'minimumNotchesToWin'
];
for (const key of numericKeys) {
    if (typeof config[key] !== 'number') {
        fail('config.json: "' + key + '" must be a number, got ' + typeof config[key]);
    }
}

// The state machine indexes config.stateMap by name throughout game.js.
const requiredStates = ['waiting', 'lobby', 'overview', 'gated', 'racing', 'collapsing', 'gameOver'];
if (config.stateMap == null || typeof config.stateMap !== 'object') {
    fail('config.json: "stateMap" is missing or not an object');
} else {
    for (const s of requiredStates) {
        if (!(s in config.stateMap)) {
            fail('config.json: stateMap is missing state "' + s + '"');
        }
    }
}

// tileMap.goal.id is what utils.validateMap looks for to confirm a map is
// playable; the other tile types are referenced across engine.js.
const requiredTiles = ['slow', 'normal', 'fast', 'lava', 'ice', 'ability', 'goal', 'bumper', 'random', 'empty'];
if (config.tileMap == null || typeof config.tileMap !== 'object') {
    fail('config.json: "tileMap" is missing or not an object');
} else {
    for (const t of requiredTiles) {
        if (config.tileMap[t] == null) {
            fail('config.json: tileMap is missing tile "' + t + '"');
        }
    }
    if (config.tileMap.goal != null && typeof config.tileMap.goal.id !== 'number') {
        fail('config.json: tileMap.goal.id must be a number');
    }
}

// Balance coverage: warn (don't fail) when a paintable tile in config.tileMap isn't
// accounted for by the fairness model. mapClassifier.unbalancedTiles checks the SAME
// two lists the algorithm uses — its composition tiles (traits/interest/hazard
// deductions) and cellGraph's routing-cost tiles (par times + the fairness spread) —
// so adding a tile to config.tileMap without balancing it surfaces here instead of
// silently skewing or being ignored by the score. Required only after config parses.
if (config.tileMap != null && typeof config.tileMap === 'object') {
    const mapClassifier = require(path.join(repoRoot, 'server', 'mapClassifier.js'));
    const unbalanced = mapClassifier.unbalancedTiles(config);
    for (const t of unbalanced) {
        warn('config.json: tile "' + t.name + '" (id ' + t.id + ') is not balanced for ' +
            t.missing.join(' + ') + ' — give it ' +
            (t.missing.indexOf('composition') !== -1 ? 'a slot in mapClassifier.COMPOSITION_TILES' : '') +
            (t.missing.length === 2 ? ' and ' : '') +
            (t.missing.indexOf('routing') !== -1 ? 'a tileWeight in cellGraph (BALANCE_WEIGHTED_TILES)' : '') +
            ' so the map-fairness score accounts for it.');
    }
}

// utils.validateMap dereferences config.hazards.movingBumper.id.
if (config.hazards == null || config.hazards.movingBumper == null ||
    typeof config.hazards.movingBumper.id !== 'number') {
    fail('config.json: hazards.movingBumper.id must be a number');
}

// Naming convention: every map's display name should already be in the house
// "Title Case With Spaces" form (server/mapNaming.js — the same normalizer the
// submit path applies, so an editor submission is auto-fixed on the way in). A
// committed map that drifts (e.g. hand-added) is WARNED, not failed, and tells the
// author exactly what it should be.
const mapNaming = require(path.join(repoRoot, 'server', 'mapNaming.js'));
for (const { file, map } of parsedMaps) {
    if (map == null || typeof map.name !== 'string') { continue; }
    if (!mapNaming.isNormalized(map.name)) {
        warn('client/maps/' + file + ': map name ' + JSON.stringify(map.name) +
            ' is not in the standard format — expected ' +
            JSON.stringify(mapNaming.normalizeMapName(map.name)) +
            ' (Title Case With Spaces). The editor normalizes this on submit; fix it if added by hand.');
    }
}

// Difficulty-ramp data hygiene (server/mapDifficulty.json, keyed by map name
// with whitespace removed). Two failure modes:
//   - A key matching no map on disk is an ERROR: renaming or deleting a map
//     silently orphans its entry and drops the map to the geometry heuristic,
//     so force the rename/cleanup to travel with the map change.
//   - A racing map with no measured entry is a WARNING: it plays fine via the
//     heuristic, but the map-submission CI prints a measured value ready to
//     paste, so nudge until the data catches up.
{
    // Parse ourselves (like config/maps above) so a hand-edited trailing comma
    // yields a clean ::error:: instead of an unhandled require stack trace.
    let mapDifficulty = null;
    try {
        mapDifficulty = JSON.parse(fs.readFileSync(path.join(repoRoot, 'server', 'mapDifficulty.json'), 'utf8'));
    } catch (e) {
        fail('server/mapDifficulty.json: invalid JSON — ' + e.message);
    }
    const mapClassifier = require(path.join(repoRoot, 'server', 'mapClassifier.js'));
    const diskKeys = new Set(
        parsedMaps.filter(({ map }) => map && !map.lobbyOnly).map(({ map }) => mapClassifier.difficultyKey(map.name))
    );
    if (mapDifficulty != null) {
    for (const key of Object.keys(mapDifficulty.perRoundFrac || {})) {
        if (!diskKeys.has(key)) {
            fail('server/mapDifficulty.json: perRoundFrac key "' + key + '" matches no map in client/maps — ' +
                'if the map was renamed or removed, rename or delete this entry in the same PR ' +
                '(keys are the map name with whitespace removed).');
        }
    }
    for (const key of (mapDifficulty.aiArtifacts || [])) {
        if (!diskKeys.has(key)) {
            fail('server/mapDifficulty.json: aiArtifacts entry "' + key + '" matches no map in client/maps — ' +
                'rename or delete it alongside the map change.');
        }
    }
    const unmeasured = [...diskKeys].filter((k) => (mapDifficulty.perRoundFrac || {})[k] == null);
    if (unmeasured.length > 0) {
        warn('server/mapDifficulty.json: ' + unmeasured.length + ' map(s) have no measured perRoundFrac and use ' +
            'the geometry-heuristic difficulty tier: ' + unmeasured.join(', ') + '. Add the measured value from ' +
            'the map-submission PR review comment (or run node .github/scripts/measure-map-difficulty.js).');
    }
    }
}

for (const { file, map } of parsedMaps) {
    // Maps are stored sites-only; rebuild full geometry (cells) so validateMap can
    // check it, exactly as loadMaps does at boot.
    let full = map;
    try {
        full = mapFormat.hydrate(map);
    } catch (e) {
        fail('client/maps/' + file + ': could not reconstruct geometry — ' + e.message);
        continue;
    }
    const result = utils.validateMap(full, config);
    if (!result.valid) {
        fail('client/maps/' + file + ': ' + result.reason);
    }
}

done();
console.log('Content validation passed: config.json OK, ' + parsedMaps.length + ' map(s) valid.');
