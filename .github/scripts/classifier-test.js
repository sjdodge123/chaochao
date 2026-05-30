'use strict';

// Boot-time map-classifier check for PRs into main.
//
// Loads every committed race map through the REAL utils.loadMaps() path (which
// reconstructs sites-only maps and attaches map.meta via server/mapClassifier),
// then asserts each map classified into a sane shape and that the Featured pool
// is non-empty. Also prints the score table so a reviewer can eyeball how the
// committed rotation lands and pick the featuredScore threshold against reality.
//
// Any throw, a malformed meta, or an empty Featured pool fails the run (exit 1).

const path = require('path');
const repoRoot = path.join(__dirname, '..', '..');
const utils = require(path.join(repoRoot, 'server', 'utils.js'));
const config = require(path.join(repoRoot, 'server', 'config.json'));

let failures = 0;
function fail(msg) { failures++; console.log('::error::' + msg); }

const maps = utils.loadMaps().filter(function (m) { return !m.lobbyOnly; });
if (maps.length === 0) { fail('no race maps loaded'); }

const TRAITS = ['ice', 'lava', 'bumper', 'ability', 'pure'];
const LENGTHS = ['sprint', 'standard', 'marathon'];
const TIERS = ['featured', 'community'];

const rows = [];
let featured = 0;
maps.forEach(function (m) {
    const name = (m.name || m.id || '?');
    const meta = m.meta;
    if (!meta) { fail(name + ': no meta attached'); return; }
    if (typeof meta.balanceScore !== 'number' || meta.balanceScore < 0 || meta.balanceScore > 100) {
        fail(name + ': bad balanceScore ' + meta.balanceScore);
    }
    if (TIERS.indexOf(meta.tier) === -1) { fail(name + ': bad tier ' + meta.tier); }
    if (TRAITS.indexOf(meta.dominantTrait) === -1) { fail(name + ': bad trait ' + meta.dominantTrait); }
    if (LENGTHS.indexOf(meta.length) === -1) { fail(name + ': bad length ' + meta.length); }
    if (!Array.isArray(meta.playlists)) { fail(name + ': playlists not resolved'); }
    // "all" must always match; "featured" iff tier is featured.
    if (meta.playlists.indexOf('all') === -1) { fail(name + ': missing from "all" playlist'); }
    if ((meta.tier === 'featured') !== (meta.playlists.indexOf('featured') !== -1)) {
        fail(name + ': featured tier/playlist mismatch');
    }
    if (meta.tier === 'featured') { featured++; }
    rows.push({ name: name, meta: meta });
});

if (featured === 0) { fail('Featured pool is empty — threshold too high or classifier broken'); }

// --- score table ---
rows.sort(function (a, b) { return b.meta.balanceScore - a.meta.balanceScore; });
const pad = function (s, n) { return String(s).padEnd(n).slice(0, n); };
console.log('\n' + pad('MAP', 22) + pad('SCORE', 6) + pad('TIER', 10) + pad('TRAIT', 8) + pad('LEN', 9) + pad('PAR', 6) + 'NOTES');
console.log('-'.repeat(96));
rows.forEach(function (r) {
    const m = r.meta;
    const notes = m.hardFail.length ? ('HARD: ' + m.hardFail.join('; ')) : (m.deductions.join(', ') || 'clean');
    console.log(
        pad(r.name, 22) + pad(m.balanceScore, 6) + pad(m.tier, 10) + pad(m.dominantTrait, 8) +
        pad(m.length, 9) + pad(m.parTime.toFixed(0), 6) + notes
    );
});

// --- playlist membership counts ---
const counts = {};
(config.playlists || []).forEach(function (p) { counts[p.id] = 0; });
rows.forEach(function (r) { r.meta.playlists.forEach(function (id) { counts[id] = (counts[id] || 0) + 1; }); });
console.log('\nPlaylist membership:');
(config.playlists || []).forEach(function (p) {
    console.log('  ' + pad(p.name, 18) + (counts[p.id] || 0) + ' maps');
});

console.log('\n' + rows.length + ' race maps, ' + featured + ' Featured (threshold ' +
    ((config.balance && config.balance.featuredScore) || '?') + ')');

if (failures > 0) {
    console.log('\nclassifier-test FAILED with ' + failures + ' error(s)');
    process.exit(1);
}
console.log('classifier-test passed');
