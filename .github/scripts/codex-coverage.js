'use strict';

// Codex coverage gate: every player-facing mechanic the config/server defines
// must have a card in the learn-page Codex (client/scripts/learn.js), and every
// card's `anim` must reference a real scene (client/scripts/learnScenes.js —
// a typo'd anim silently renders the blank fallback).
//
// This exists because entries kept getting missed when features shipped (the
// Bunker brutal round and the Water tile both launched without cards). Checked
// dimensions, each derived from the same source of truth the game runs on:
//
//   brutal rounds  config.brutalRounds (active: true)        -> "brutal-<key>"
//   abilities      config.tileMap.abilities (spawnable: true) -> "ability-<key>"
//   tile types     config.tileMap (player-facing tiles)       -> "tile-<key>"
//   medals         progression.MEDAL_TITLES                   -> "medal-<key>" (with aliases)
//
// Adding a new mechanic without a Codex card fails this script. Either add the
// card (preferred) or — for a medal whose card legitimately covers several
// keys, like the multi-kill family — add an alias below.

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const utils = require(path.join(repoRoot, 'server', 'utils.js'));
const MEDAL_TITLES = require(path.join(repoRoot, 'server', 'progression.js')).MEDAL_TITLES;
const c = utils.loadConfig();

const learnSrc = fs.readFileSync(path.join(repoRoot, 'client', 'scripts', 'learn.js'), 'utf8');
const scenesSrc = fs.readFileSync(path.join(repoRoot, 'client', 'scripts', 'learnScenes.js'), 'utf8');

let failures = 0;
function check(cond, msg) {
    if (!cond) { failures++; console.log('::error::Codex coverage: ' + msg); }
    else { console.log('ok: ' + msg); }
}

// All card ids and anim references in the CODEX array.
const cardIds = new Set();
for (const m of learnSrc.matchAll(/id:\s*"([^"]+)"/g)) { cardIds.add(m[1]); }
const anims = new Set();
for (const m of learnSrc.matchAll(/anim:\s*"([^"]+)"/g)) { anims.add(m[1]); }
// All registered scenes.
const scenes = new Set();
for (const m of scenesSrc.matchAll(/SCENES\["([^"]+)"\]/g)) { scenes.add(m[1]); }

// --- Brutal rounds (active only; parked modes may keep show:false cards) ---
for (const key in c.brutalRounds) {
    if (c.brutalRounds[key].active !== true) { continue; }
    const id = 'brutal-' + key.toLowerCase();
    check(cardIds.has(id), 'brutal round "' + key + '" has Codex card ' + id);
}

// --- Abilities (spawnable only — internal ids like the bomb trigger are not pads) ---
for (const key in c.tileMap.abilities) {
    const def = c.tileMap.abilities[key];
    if (def == null || typeof def !== 'object' || def.spawnable !== true) { continue; }
    const id = 'ability-' + key.toLowerCase();
    check(cardIds.has(id), 'ability "' + key + '" has Codex card ' + id);
}

// --- Tile types (player-facing only: background/empty are renderer internals,
//     `abilities` is the nested ability table, not a tile) ---
const TILE_SKIP = { background: true, empty: true, abilities: true };
for (const key in c.tileMap) {
    if (TILE_SKIP[key] || typeof c.tileMap[key] !== 'object') { continue; }
    const id = 'tile-' + key.toLowerCase();
    check(cardIds.has(id), 'tile type "' + key + '" has Codex card ' + id);
}

// --- Hazards (config.hazards, ids 900+). The `_doc` siblings are plain strings,
//     not objects — the typeof guard skips them. ---
for (const key in c.hazards) {
    const def = c.hazards[key];
    if (def == null || typeof def !== 'object') { continue; }
    check(cardIds.has('hazard-' + key.toLowerCase()), 'hazard "' + key + '" has Codex card hazard-' + key.toLowerCase());
}

// --- Boons (config.boons, ids 950+). Same `_doc` string guard as hazards. ---
for (const key in c.boons) {
    const def = c.boons[key];
    if (def == null || typeof def !== 'object') { continue; }
    check(cardIds.has('boon-' + key.toLowerCase()), 'boon "' + key + '" has Codex card boon-' + key.toLowerCase());
}

// --- Medals. Most map 1:1 to "medal-<key>"; the aliases cover cards whose
//     names differ from the stat key or that cover a family of keys. ---
const MEDAL_ALIAS = {
    mostKills: 'medal-serialkiller',
    mostMurdered: 'medal-pickedon',
    doubleKill: 'medal-multikill',
    tripleKill: 'medal-multikill',
    megaKill: 'medal-multikill'
};
for (const key in MEDAL_TITLES) {
    const id = MEDAL_ALIAS[key] || ('medal-' + key.toLowerCase());
    check(cardIds.has(id), 'medal "' + key + '" has Codex card ' + id);
}

// --- Every referenced anim must be a real scene (missing ones silently render
//     the blank fallback, which reads as a broken card) ---
for (const anim of anims) {
    check(scenes.has(anim), 'anim "' + anim + '" exists in learnScenes');
}

if (failures > 0) { console.log('\nCodex coverage FAILED with ' + failures + ' missing entr' + (failures === 1 ? 'y' : 'ies') + '.'); process.exit(1); }
console.log('\nCodex coverage passed.');
process.exit(0);
