'use strict';

// Phase 1 check: playlist-aware map rotation.
//
// Exercises GameBoard's selection methods (determineNextMap / getEligibleMapIndices
// / setPlaylist) directly against the REAL classified map pool, without booting a
// full room/world (the heavy constructor needs a live world+engine, none of which
// the selection logic touches). Verifies that a chosen playlist only ever yields
// eligible maps, that no-repeat rotation holds, that a too-thin playlist falls back
// to the full pool, and that setPlaylist validates ids. Any failure exits 1.

const path = require('path');
const repoRoot = path.join(__dirname, '..', '..');
// Require game.js first so the game<->gameBoard circular dependency fully resolves
// before we destructure GameBoard (otherwise it can be undefined mid-cycle).
require(path.join(repoRoot, 'server', 'game.js'));
const { GameBoard } = require(path.join(repoRoot, 'server', 'entities', 'gameBoard.js'));
const utils = require(path.join(repoRoot, 'server', 'utils.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));

let failures = 0;
function fail(msg) { failures++; console.log('::error::' + msg); }
function ok(msg) { console.log('  ok: ' + msg); }

// A minimal GameBoard with only the fields the selection logic reads.
function makeBoard() {
    const gb = Object.create(GameBoard.prototype);
    gb.maps = utils.loadMaps().filter(function (m) { return !m.lobbyOnly; });
    gb.mapsPlayed = [];
    gb.isPreview = false;
    gb.previewMap = null;
    gb.playlistId = 'featured';
    return gb;
}

const board = makeBoard();
const byId = {};
board.maps.forEach(function (m) { byId[m.id] = m; });
function metaOf(id) { return byId[id] && byId[id].meta; }

// How many maps each playlist actually resolves to (pre-fallback).
function poolSize(pid) {
    if (pid === 'all') { return board.maps.length; }
    return board.maps.filter(function (m) {
        return m.meta && m.meta.playlists.indexOf(pid) !== -1;
    }).length;
}

// 1) Every pick from a playlist with a real (>=2) pool is eligible for it.
(config.playlists || []).forEach(function (p) {
    const size = poolSize(p.id);
    if (size < 2) { return; } // thin pools are tested separately (fallback)
    const gb = makeBoard();
    gb.playlistId = p.id;
    let bad = 0;
    const seen = new Set();
    for (let i = 0; i < 300; i++) {
        const id = gb.determineNextMap();
        gb.mapsPlayed.push(id); // mimic loadNextMap recording the played map
        seen.add(id);
        const meta = metaOf(id);
        if (p.id !== 'all' && (!meta || meta.playlists.indexOf(p.id) === -1)) { bad++; }
    }
    if (bad > 0) { fail(p.id + ': ' + bad + '/300 picks were NOT eligible'); }
    else { ok(p.id + ': 300 picks all eligible (pool ' + size + ', ' + seen.size + ' distinct)'); }
    // rotation should eventually surface (nearly) the whole pool
    if (p.id !== 'all' && seen.size < Math.min(size, 5)) {
        fail(p.id + ': rotation only surfaced ' + seen.size + ' of ' + size + ' maps');
    }
});

// 2) Featured picks are all tier=featured.
(function () {
    const gb = makeBoard();
    gb.playlistId = 'featured';
    let bad = 0;
    for (let i = 0; i < 200; i++) {
        const id = gb.determineNextMap();
        gb.mapsPlayed.push(id);
        const meta = metaOf(id);
        if (!meta || meta.tier !== 'featured') { bad++; }
    }
    if (bad > 0) { fail('featured: ' + bad + '/200 picks were not tier=featured'); }
    else { ok('featured: every pick is tier=featured'); }
})();

// 3) No immediate repeats while the eligible pool has >1 unplayed map.
(function () {
    const gb = makeBoard();
    gb.playlistId = 'all';
    let last = null, repeats = 0;
    for (let i = 0; i < 200; i++) {
        const id = gb.determineNextMap();
        gb.mapsPlayed.push(id);
        if (id === last) { repeats++; }
        last = id;
    }
    if (repeats > 0) { fail('all: ' + repeats + ' back-to-back repeats'); }
    else { ok('all: no back-to-back repeats over 200 rounds'); }
})();

// 4) A too-thin playlist falls back to the full pool (no crash, keeps rotating).
(function () {
    const thin = (config.playlists || []).map(function (p) { return p.id; })
        .filter(function (id) { return id !== 'all' && poolSize(id) < 2; });
    if (thin.length === 0) { ok('(no sub-2 playlist to fallback-test)'); return; }
    thin.forEach(function (pid) {
        const gb = makeBoard();
        gb.playlistId = pid;
        const eligible = gb.getEligibleMapIndices();
        if (eligible.length !== gb.maps.length) {
            fail(pid + ': thin pool (' + poolSize(pid) + ') did not fall back to full pool');
        } else {
            // and it still produces valid picks
            let bad = 0;
            for (let i = 0; i < 20; i++) { if (metaOf(gb.determineNextMap()) == null) { bad++; } }
            if (bad > 0) { fail(pid + ': fallback produced invalid picks'); }
            else { ok(pid + ': thin pool falls back to full pool, still rotates'); }
        }
    });
})();

// 5) setPlaylist validates ids and resets the played set.
(function () {
    const gb = makeBoard();
    gb.mapsPlayed = ['x', 'y'];
    if (gb.setPlaylist('definitely-not-a-playlist') !== false) { fail('setPlaylist accepted an unknown id'); }
    else { ok('setPlaylist rejects unknown id'); }
    if (gb.mapsPlayed.length !== 2) { fail('setPlaylist mutated played set on a rejected id'); }
    const changed = gb.setPlaylist('hardcore');
    if (changed !== true || gb.playlistId !== 'hardcore' || gb.mapsPlayed.length !== 0) {
        fail('setPlaylist did not apply a valid change + reset played set');
    } else { ok('setPlaylist applies valid id and resets played set'); }
    if (gb.setPlaylist('hardcore') !== false) { fail('setPlaylist reported a no-op change as changed'); }
    else { ok('setPlaylist treats same-id as no-op'); }
})();

if (failures > 0) {
    console.log('\nplaylist-selection-test FAILED with ' + failures + ' error(s)');
    process.exit(1);
}
console.log('\nplaylist-selection-test passed');
