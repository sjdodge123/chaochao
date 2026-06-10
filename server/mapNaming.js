'use strict';

// Canonical map-name normalizer. ONE source of truth for the naming convention so
// the three places that care stay in lockstep:
//   - the submit path (utils.submitPullRequest) normalizes a name on the way in, so
//     every newly-committed map is already in the convention ("the CI fixes it");
//   - the content-validation CI warns if a committed map drifts from it;
//   - the one-time migration that normalized the existing library.
//
// Convention: "Title Case With Spaces". Mechanically derivable from snake_case,
// camelCase/PascalCase, and digit-smush — e.g. "swim_fish_swim" -> "Swim Fish
// Swim", "RaceCondition" -> "Race Condition", "4suns!" -> "4 Suns!". It is NOT a
// dictionary speller: a single smushed lowercase token ("everyonedies") can't be
// split mechanically and comes through as one word ("Everyonedies") — those few
// legacy names were hand-split in the migration; new submissions are typed with
// real word breaks, so the mechanical rule covers them.
//
// Idempotent: normalizeMapName(normalizeMapName(x)) === normalizeMapName(x).
// Punctuation a real name carries (apostrophes, "!") is preserved.
function normalizeMapName(raw) {
    var s = String(raw == null ? '' : raw);
    s = s.replace(/[_\-]+/g, ' ');                      // snake_case / kebab -> spaces
    s = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2');       // camelCase boundary: aB -> a B
    s = s.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');    // acronym->word: ABCar -> AB Car
    s = s.replace(/([A-Za-z])([0-9])/g, '$1 $2');       // letter->digit: suns4 -> suns 4
    s = s.replace(/([0-9])([A-Za-z])/g, '$1 $2');       // digit->letter: 4suns -> 4 suns
    s = s.replace(/\s+/g, ' ').trim();                  // collapse + trim
    // Title-case: capitalize the first character of each space-delimited token only,
    // leaving the rest untouched so "Mitch's" / "Knowin'" don't gain a stray capital
    // after the apostrophe and existing inner capitals survive.
    s = s.split(' ').map(function (w) {
        return w.length ? w.charAt(0).toUpperCase() + w.slice(1) : w;
    }).join(' ');
    return s;
}

// The committed file's base name for a (normalized) display name: the convention's
// existing rule — spaces removed — yielding a PascalCase file that matches the
// submit path's `client/maps/<name>.json`. Punctuation is kept (the repo already
// holds e.g. 4Suns!.json), only spaces are dropped.
function mapFileBase(name) {
    return normalizeMapName(name).replace(/ /g, '');
}

// True when a name already matches the convention (nothing to fix).
function isNormalized(name) {
    return String(name == null ? '' : name) === normalizeMapName(name);
}

module.exports = {
    normalizeMapName: normalizeMapName,
    mapFileBase: mapFileBase,
    isNormalized: isNormalized
};
