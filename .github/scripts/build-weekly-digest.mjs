// Build the consolidated weekly release digest from CHANGELOG.md.
//
// Reads CHANGELOG.md, groups the calendar week (Mon–Sun, UTC) of the most
// recent release into one set of notes, writes them to WEEKLY_NOTES.md, and
// emits the digest's tag/title as step outputs so the workflow can upsert a
// single "week-YYYY-MM-DD" GitHub Release. Per-PR releases are untouched.
//
//   node build-weekly-digest.mjs                     # current week (topmost release)
//   node build-weekly-digest.mjs --week 2026-06-15   # backfill a specific week
//
// --week takes any YYYY-MM-DD in the target week; it's normalised to that
// week's Monday. Combine with `gh release edit week-<monday> --notes-file
// WEEKLY_NOTES.md --title "<week_title>"` to re-render a past week's digest.
//
// Outputs (GITHUB_OUTPUT): week_tag, week_title. Sets built=false (and writes
// nothing) when there are no releases in the target week to digest.

import fs from 'node:fs';
import { buildWeeklyDigest, renderDigestBody } from './changelog-lib.mjs';

function setOutput(key, value) {
    if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    }
}

// Parse an optional "--week YYYY-MM-DD" / "--week=YYYY-MM-DD" argument.
function parseWeekArg(argv) {
    const i = argv.findIndex((a) => a === '--week' || a.startsWith('--week='));
    if (i === -1) return null;
    const val = argv[i].includes('=') ? argv[i].split('=')[1] : argv[i + 1];
    if (!val || !/^\d{4}-\d{2}-\d{2}$/.test(val)) {
        console.error(`--week needs a YYYY-MM-DD date (got: ${val ?? '(missing)'})`);
        process.exit(2);
    }
    return val;
}

const weekArg = parseWeekArg(process.argv.slice(2));
const md = fs.readFileSync('CHANGELOG.md', 'utf8');
const digest = buildWeeklyDigest(md, weekArg ? { weekMonday: weekArg } : {});

if (!digest) {
    console.log(weekArg
        ? `No releases in the week of ${weekArg} — nothing to digest.`
        : 'No releases in CHANGELOG.md — nothing to digest.');
    setOutput('built', 'false');
    process.exit(0);
}

fs.writeFileSync('WEEKLY_NOTES.md', renderDigestBody(digest));
setOutput('built', 'true');
setOutput('week_tag', digest.weekTag);
setOutput('week_title', digest.title);

console.log(`Built ${digest.weekTag} (${digest.title}).`);
console.log(`Headliners: ${digest.headliners.join(', ') || '(none)'}`);
console.log(`Includes: ${digest.versions.join(', ')}`);
