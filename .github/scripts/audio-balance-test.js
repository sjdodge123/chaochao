'use strict';

// Audio-balance gate for PRs into main.
//
// The mix in this game is balanced entirely by per-sound *coefficients* in
// audio.js `volumeChange()`. The source clips are mastered at wildly different
// levels, so each `sound.volume = COEFF * sfx` line scales a file down (or up)
// to the level the engine should actually play it at. The effective playback
// loudness of a cue is therefore:
//
//     effective_dBFS = file_mean_dBFS + 20*log10(COEFF)
//
// When a new feature adds a sound effect, the two ways it goes wrong are:
//   1. The author forgets to give it a coefficient at all (it plays at the raw
//      file level — usually a wall of sound, sometimes silence).
//   2. They set a coefficient, but it lands the cue far hotter or quieter than
//      everything else on its bus (it stomps the mix, or is inaudible).
//
// This gate catches both, with NO new npm dependency (pure fs + the `ffmpeg`
// that ships on the GitHub ubuntu runner). It is deliberately STATIC about the
// code (parses audio.js, does not execute it) and uses `ffmpeg volumedetect`
// for the per-file loudness numbers — the same measurement the coefficients
// were tuned against (see the volumeChange() comment and the audio-mixing notes).
//
// Bands are calibrated to PASS on the current tree with ~6 dB of headroom beyond
// the existing extremes, so only an egregiously-misbalanced NEW sound trips it.
// If you intentionally add a louder/quieter cue and this fails, retune its
// coefficient first; widen the band here only if the new level is genuinely
// correct (and say why in the PR).
//
// Exits 0 when the mix is balanced, 1 (with ::error:: annotations) otherwise.

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const repoRoot = path.join(__dirname, '..', '..');
const audioPath = path.join(repoRoot, 'client', 'scripts', 'audio.js');
const soundsDir = path.join(repoRoot, 'client', 'assets', 'sounds');

// Per-bus effective-loudness bands (dBFS) and the global anti-clipping peak
// ceiling. Calibrated 2026-06-10 against the committed corpus:
//   sfx   spread -50.9..-25.0   voice -40.9..-35.1
//   music spread -50.4..-36.4   crowd -37.0..-34.4
// hottest effective peak was sfx gameOverSound at -6.4 dBFS.
const BANDS = {
    sfx: { lo: -58, hi: -18 },
    voice: { lo: -48, hi: -28 },
    music: { lo: -57, hi: -30 },
    crowd: { lo: -44, hi: -28 },
};
const PEAK_CEILING_DBFS = -1.0; // a cue whose effective peak exceeds this will clip / jolt

const errors = [];
function fail(msg) {
    errors.push(msg);
    console.log('::error::' + msg);
}

// --- preflight: we need ffmpeg for the loudness half -------------------------
try {
    cp.execSync('ffmpeg -version', { stdio: 'ignore' });
} catch (e) {
    console.log('::error::audio-balance: `ffmpeg` not found on PATH — required to measure clip loudness.');
    process.exit(1);
}

const src = fs.readFileSync(audioPath, 'utf8');

// Normalize a makeSound src ("./assets/sounds/foo.mp3?v=3") to a bare filename.
function fileOf(s) {
    return s.replace(/^\.\//, '').replace(/^assets\/sounds\//, '').split('?')[0];
}
function busOf(opts) {
    if (!opts) { return 'sfx'; }
    const b = opts.match(/bus:\s*"(\w+)"/);
    return b ? b[1] : 'sfx';
}

// --- parse the sound registry -----------------------------------------------
// 1) `var NAME = makeSound("SRC"[, {opts}])`  (one per line)
const sounds = {}; // name -> { file, bus, coeff:null }
let resolvedMakeSound = 0;
const reSingle = /var\s+(\w+)\s*=\s*makeSound\(\s*"([^"]+)"\s*(?:,\s*(\{[^}]*\}))?\s*\)/g;
let m;
while ((m = reSingle.exec(src))) {
    sounds[m[1]] = { file: fileOf(m[2]), bus: busOf(m[3]), coeff: null };
    resolvedMakeSound++;
}

// 2) variant arrays: `var ARR = [ makeSound(...), ... ]` — balanced as a group
//    via setVariantVolume(ARR, COEFF * sfx). Register each member into `sounds`
//    NOW (coeff still null), so a variant clip whose array is missing its
//    setVariantVolume() call is still caught by the no-coefficient check below
//    instead of silently playing at raw volume 1.
const arrays = {}; // arrName -> [member keys into `sounds`]
const reArr = /var\s+(\w+)\s*=\s*\[([\s\S]*?)\];/g;
while ((m = reArr.exec(src))) {
    if (!/makeSound\(/.test(m[2])) { continue; }
    const keys = [];
    const r = /makeSound\(\s*"([^"]+)"\s*(?:,\s*(\{[^}]*\}))?\s*\)/g;
    let mm;
    while ((mm = r.exec(m[2]))) {
        const key = m[1] + '[' + keys.length + ']';
        sounds[key] = { file: fileOf(mm[1]), bus: busOf(mm[2]), coeff: null, variantOf: m[1] };
        keys.push(key);
        resolvedMakeSound++;
    }
    if (keys.length) { arrays[m[1]] = keys; }
}

// Parser-coverage guard: every makeSound CALL in the file (minus the function
// definition itself) must have been resolved above. A new sound declared in a
// shape this parser can't read (e.g. a multi-line call) would otherwise slip
// through unchecked — fail loudly instead so the parser gets updated.
const totalMakeSoundCalls = (src.match(/makeSound\(/g) || []).length - 1; // -1 for `function makeSound(`
if (totalMakeSoundCalls !== resolvedMakeSound) {
    fail(
        'audio-balance parser resolved ' + resolvedMakeSound + ' of ' + totalMakeSoundCalls +
        ' makeSound() call(s). A new sound is declared in a shape this parser does not understand — ' +
        'extend .github/scripts/audio-balance-test.js so it can read (and balance-check) it.'
    );
}

// --- parse the balancing coefficients in volumeChange() ----------------------
// `NAME.volume = COEFF * (sfx|music|masterVolume)`
const reVol = /(\w+)\.volume\s*=\s*([0-9.]+)\s*\*\s*(?:sfx|music|masterVolume)/g;
while ((m = reVol.exec(src))) {
    if (sounds[m[1]]) { sounds[m[1]].coeff = parseFloat(m[2]); }
}
// `setVariantVolume(ARR, COEFF * sfx)` — applies one coefficient to every clip
// in the array; fill it onto the members registered during array parsing.
const reVar = /setVariantVolume\(\s*(\w+)\s*,\s*([0-9.]+)\s*\*/g;
while ((m = reVar.exec(src))) {
    const keys = arrays[m[1]];
    if (!keys) { continue; }
    const coeff = parseFloat(m[2]);
    keys.forEach((k) => { if (sounds[k]) { sounds[k].coeff = coeff; } });
}

// --- static check: every sound must be balanced ------------------------------
for (const [name, s] of Object.entries(sounds)) {
    if (s.coeff !== null) { continue; }
    if (s.variantOf) {
        fail(
            'Sound "' + s.file + '" in variant array ' + s.variantOf + ' has no volume coefficient. ' +
            'Add a `setVariantVolume(' + s.variantOf + ', <coeff> * sfx);` line to volumeChange() in ' +
            'client/scripts/audio.js so it joins the balanced mix.'
        );
    } else {
        fail(
            'Sound "' + name + '" (' + s.file + ') has no volume coefficient. Add a ' +
            '`' + name + '.volume = <coeff> * ' + (s.bus === 'music' ? 'music' : 'sfx') +
            ';` line to volumeChange() in client/scripts/audio.js so it joins the balanced mix.'
        );
    }
}

// --- loudness check: measure each file, compare effective level to its band --
const meanCache = {};
function measure(file) {
    if (meanCache[file] !== undefined) { return meanCache[file]; }
    const fp = path.join(soundsDir, file);
    if (!fs.existsSync(fp)) { return (meanCache[file] = null); }
    let out;
    try {
        out = cp.execSync(
            'ffmpeg -hide_banner -nostats -i ' + JSON.stringify(fp) + ' -af volumedetect -f null - 2>&1',
            { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
        );
    } catch (e) {
        out = (e.stdout || '') + (e.stderr || '');
    }
    const mean = out.match(/mean_volume:\s*(-?[0-9.]+) dB/);
    const max = out.match(/max_volume:\s*(-?[0-9.]+) dB/);
    return (meanCache[file] = {
        mean: mean ? parseFloat(mean[1]) : null,
        max: max ? parseFloat(max[1]) : null,
    });
}

let checked = 0;
for (const [name, s] of Object.entries(sounds)) {
    if (s.coeff === null) { continue; } // already reported by the static check
    const band = BANDS[s.bus];
    if (!band) {
        fail('Sound "' + name + '" is on unknown bus "' + s.bus + '" — add a band for it in audio-balance-test.js.');
        continue;
    }
    const d = measure(s.file);
    if (!d) {
        // A case-only mismatch is the classic macOS (case-insensitive) -> Linux
        // (case-sensitive) trap: it plays locally but 404s on the prod server.
        // Call it out explicitly rather than just "missing".
        const sibling = fs.readdirSync(soundsDir).find((f) => f.toLowerCase() === s.file.toLowerCase());
        if (sibling) {
            fail('Sound "' + name + '" references "' + s.file + '" but the file on disk is "' + sibling +
                '" (case mismatch). This plays on macOS but 404s on the case-sensitive prod server — fix the case in client/scripts/audio.js.');
        } else {
            fail('Sound "' + name + '" references missing file ' + s.file + '.');
        }
        continue;
    }
    if (d.mean === null) { fail('Could not read loudness of ' + s.file + ' (ffmpeg returned no mean_volume).'); continue; }

    const gainDb = 20 * Math.log10(s.coeff);
    const effMean = d.mean + gainDb;
    const effPeak = (d.max !== null) ? d.max + gainDb : null;
    checked++;

    if (effMean > band.hi) {
        fail(
            name + ' (' + s.file + ') plays too LOUD: effective ' + effMean.toFixed(1) + ' dBFS, ' +
            'above the ' + s.bus + ' ceiling of ' + band.hi + ' dBFS. Lower its coefficient (' + s.coeff +
            ') in volumeChange().'
        );
    } else if (effMean < band.lo) {
        fail(
            name + ' (' + s.file + ') plays too QUIET: effective ' + effMean.toFixed(1) + ' dBFS, ' +
            'below the ' + s.bus + ' floor of ' + band.lo + ' dBFS. Raise its coefficient (' + s.coeff +
            ') in volumeChange().'
        );
    }
    if (effPeak !== null && effPeak > PEAK_CEILING_DBFS) {
        fail(
            name + ' (' + s.file + ') will CLIP: effective peak ' + effPeak.toFixed(1) + ' dBFS exceeds the ' +
            PEAK_CEILING_DBFS + ' dBFS ceiling. Lower its coefficient (' + s.coeff + ') in volumeChange().'
        );
    }
}

// --- report ------------------------------------------------------------------
if (errors.length > 0) {
    console.log('\nAudio-balance check FAILED with ' + errors.length + ' issue(s).');
    process.exit(1);
}
console.log('Audio balance OK — ' + checked + ' balanced sounds across ' + Object.keys(BANDS).join('/') + ' buses, all within band.');
