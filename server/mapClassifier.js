'use strict';

// Boot-time map classifier. Derives a `meta` object from a map's GEOMETRY
// (deterministic, no telemetry) the same way par-time is derived in
// utils.loadMaps(). Two outputs matter downstream:
//
//   - character tags (length / dominantTrait) — power the themed playlists.
//   - a balanceScore + tier (featured|community) — the auto-quality gate.
//
// Featured = "balanced, fair, sensible-length" maps; everything else is still
// playable, it just routes to a themed or Wild playlist instead of being
// rejected. The same score drives the editor's soft submit-warning, so authors
// see exactly which deduction sank their map.
//
// Thresholds live in config.balance so they're tunable without a code change;
// every read falls back to a sane default so an older/partial config still
// classifies. See docs/spikes/map-playlists-and-ratings.md for the rationale.

var cellGraph = require('./cellGraph.js');

// Resolve a tileMap name -> numeric id from the live config (don't hardcode).
function tileId(config, name) {
    var t = config && config.tileMap && config.tileMap[name];
    return (t && typeof t.id === 'number') ? t.id : -1;
}

function bal(config, key, dflt) {
    var b = config && config.balance;
    return (b && b[key] != null) ? b[key] : dflt;
}

// Median par-time pooled from a SINGLE start edge. cellGraph.computeMapParTime
// already pools across every start edge; for fairness we want each edge alone,
// so we hand it a shallow clone pinned to one edge.
function parForEdge(map, edge) {
    var clone = Object.assign({}, map, { startEdges: [edge] });
    return cellGraph.computeMapParTime(clone);
}

function startEdgesOf(map) {
    return (Array.isArray(map.startEdges) && map.startEdges.length > 0) ? map.startEdges : ['left'];
}

// Tile-composition ratios over DRIVABLE cells (background/empty excluded), plus
// the drivable fraction of the whole board.
function composition(map, config) {
    var bg = tileId(config, 'background'), empty = tileId(config, 'empty');
    var names = ['slow', 'normal', 'fast', 'lava', 'ice', 'ability', 'goal', 'bumper', 'random'];
    var idOf = {};
    names.forEach(function (n) { idOf[n] = tileId(config, n); });

    var counts = {}, total = 0, drivable = 0;
    var cells = Array.isArray(map.cells) ? map.cells : [];
    for (var i = 0; i < cells.length; i++) {
        var id = cells[i].id;
        counts[id] = (counts[id] || 0) + 1;
        total++;
        if (id !== bg && id !== empty) { drivable++; }
    }
    var ratios = {};
    var denom = Math.max(1, drivable);
    names.forEach(function (n) { ratios[n] = (counts[idOf[n]] || 0) / denom; });
    return { ratios: ratios, total: total, drivable: drivable, drivableFrac: drivable / Math.max(1, total) };
}

// Every character trait a map qualifies for (a map can be both ice AND pinball).
// Bumper/pinball identity comes from EITHER bumper tiles OR a high density of
// bumper hazards (BumperCity & friends place bumpers as hazards, not tiles, so
// a tile-only check misses them). dominantTrait is just traits[0] for display.
function deriveTraits(ratios, hazardDensity, config) {
    var th = bal(config, 'traitThresholds', { ice: 0.20, lava: 0.20, bumper: 0.12, ability: 0.10, bumperHazardDensity: 0.20 });
    var traits = [];
    var bumperish = (ratios.bumper || 0) >= th.bumper || hazardDensity >= (th.bumperHazardDensity || 0.20);
    if (bumperish) { traits.push('bumper'); }
    if (ratios.ice >= th.ice) { traits.push('ice'); }
    if (ratios.lava >= th.lava) { traits.push('lava'); }
    if (ratios.ability >= th.ability) { traits.push('ability'); }
    if (traits.length === 0) { traits.push('pure'); }
    return traits;
}

function lengthClass(par, config) {
    if (par < bal(config, 'lengthSprintMax', 14)) { return 'sprint'; }
    if (par > bal(config, 'lengthMarathonMin', 45)) { return 'marathon'; }
    return 'standard';
}

// Main entry: map (reconstructed, full geometry) + config -> meta object.
// `parTime` is read from the map if already computed (loadMaps does this) and
// otherwise computed here, so the classifier is safe to call standalone.
function classify(map, config) {
    var comp = composition(map, config);
    var r = comp.ratios;
    var par = (map.parTime != null) ? map.parTime : cellGraph.computeMapParTime(map);
    var edges = startEdgesOf(map);
    var hazardCount = Array.isArray(map.hazards) ? map.hazards.length : 0;
    var hazardDensity = hazardCount / Math.max(1, comp.drivable);

    // --- hard gates: any failure => never Featured (but still playable) ---
    var hardFail = [];
    for (var e = 0; e < edges.length; e++) {
        if (!cellGraph.reachableFromEdge(map, edges[e])) {
            hardFail.push('goal unreachable from ' + edges[e] + ' start');
        }
    }
    var minDrive = bal(config, 'minDrivableFrac', 0.40);
    if (comp.drivableFrac < minDrive) {
        hardFail.push('only ' + Math.round(comp.drivableFrac * 100) + '% drivable (< ' + Math.round(minDrive * 100) + '%)');
    }
    var parMin = bal(config, 'parMin', 8), parMax = bal(config, 'parMax', 90);
    if (par < parMin) { hardFail.push('par ' + par.toFixed(1) + 's too short (< ' + parMin + 's)'); }
    if (par > parMax) { hardFail.push('par ' + par.toFixed(1) + 's too long (> ' + parMax + 's)'); }

    // --- spawn fairness (2-edge maps only): symmetry of per-edge par-times ---
    var fairness = 1;
    if (edges.length > 1) {
        var ps = [];
        for (var k = 0; k < edges.length; k++) {
            var p = parForEdge(map, edges[k]);
            if (p > 0) { ps.push(p); }
        }
        if (ps.length >= 2) {
            fairness = Math.min.apply(null, ps) / Math.max.apply(null, ps);
        }
    }

    // --- soft deductions from 100 ---
    var score = 100;
    var deductions = [];
    function deduct(amount, label) {
        if (amount > 0) { score -= amount; deductions.push(label + ' -' + amount); }
    }

    if (edges.length > 1) {
        deduct(Math.round((1 - fairness) * 25), 'fairness');
    }
    // hazard sanity: heavy lava and bumper-walls punish; near-zero hazard is bland
    var hd = 0;
    if (r.lava > 0.30) { hd += Math.min(15, Math.round((r.lava - 0.30) * 60)); }
    if (r.lava > 0 && r.lava < 0.02) { hd += 4; }
    if (r.bumper > 0.22) { hd += Math.min(8, Math.round((r.bumper - 0.22) * 40)); }
    deduct(Math.min(20, hd), 'hazard');
    // length comfort: distance from the ideal par band
    var idealLow = bal(config, 'idealParLow', 18), idealHigh = bal(config, 'idealParHigh', 40);
    if (par < idealLow) { deduct(Math.min(15, Math.round((idealLow - par) * 1.5)), 'length'); }
    else if (par > idealHigh) { deduct(Math.min(15, Math.round((par - idealHigh) * 0.6)), 'length'); }
    // whole-map ice (frictionless everywhere) is a coin-flip, not a race
    if (r.ice > 0.45) { deduct(Math.min(10, Math.round((r.ice - 0.45) * 30)), 'ice'); }
    // tiny boards collapse into a scrum
    if (comp.total < 120) { deduct(8, 'tiny'); }

    if (score < 0) { score = 0; }
    if (score > 100) { score = 100; }

    var featuredScore = bal(config, 'featuredScore', 90);
    var tier = (hardFail.length === 0 && score >= featuredScore) ? 'featured' : 'community';

    var traits = deriveTraits(r, hazardDensity, config);

    return {
        parTime: par,
        length: lengthClass(par, config),
        traits: traits,
        dominantTrait: traits[0],
        ratios: r,
        drivableFrac: comp.drivableFrac,
        cellCount: comp.total,
        hazardCount: hazardCount,
        hazardDensity: hazardDensity,
        startEdgeCount: edges.length,
        fairness: fairness,
        balanceScore: score,
        tier: tier,
        hardFail: hardFail,
        deductions: deductions,
        rating: null,      // filled by the ratings layer (Phase 4); null until then
        playlists: []      // filled by resolvePlaylists() once playlist defs are known
    };
}

// Does a map's meta satisfy a single playlist's filter? An empty filter matches
// everything ("Everything"). Unknown keys are ignored so new filters degrade to
// "match" rather than silently excluding every map.
function matches(meta, filter) {
    if (!filter) { return true; }
    if (filter.tier != null && meta.tier !== filter.tier) { return false; }
    if (filter.trait != null) {
        var traits = Array.isArray(meta.traits) ? meta.traits : [meta.dominantTrait];
        if (traits.indexOf(filter.trait) === -1) { return false; }
    }
    if (filter.length != null && meta.length !== filter.length) { return false; }
    if (filter.minScore != null && !(meta.balanceScore >= filter.minScore)) { return false; }
    if (filter.minRating != null) {
        // Crowd Favorites: requires a real rating aggregate. No data => excluded
        // (selection falls back to Featured when a playlist is too thin).
        if (!meta.rating || !(meta.rating.bayesian >= filter.minRating)) { return false; }
    }
    return true;
}

// Given a map's meta and the config.playlists[] defs, return the ids of every
// playlist it belongs to. A map can sit in several (e.g. featured + ice + sprint).
function resolvePlaylists(meta, playlistDefs) {
    var ids = [];
    if (!Array.isArray(playlistDefs)) { return ids; }
    for (var i = 0; i < playlistDefs.length; i++) {
        var def = playlistDefs[i];
        if (def && def.id && matches(meta, def.filter)) { ids.push(def.id); }
    }
    return ids;
}

module.exports = {
    classify: classify,
    matches: matches,
    resolvePlaylists: resolvePlaylists
};
