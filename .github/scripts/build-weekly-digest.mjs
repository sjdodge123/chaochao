// Build the consolidated weekly release digest from CHANGELOG.md.
//
// Reads CHANGELOG.md, groups the calendar week (Mon–Sun, UTC) of the most
// recent release into one set of notes, writes them to WEEKLY_NOTES.md, and
// emits the digest's tag/title as step outputs so the workflow can upsert a
// single "week-YYYY-MM-DD" GitHub Release. Per-PR releases are untouched.
//
// Outputs (GITHUB_OUTPUT): week_tag, week_title. Sets built=false (and writes
// nothing) when there are no releases to digest.

import fs from 'node:fs';
import { buildWeeklyDigest, renderDigestBody } from './changelog-lib.mjs';

function setOutput(key, value) {
    if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    }
}

const md = fs.readFileSync('CHANGELOG.md', 'utf8');
const digest = buildWeeklyDigest(md);

if (!digest) {
    console.log('No releases in CHANGELOG.md — nothing to digest.');
    setOutput('built', 'false');
    process.exit(0);
}

fs.writeFileSync('WEEKLY_NOTES.md', renderDigestBody(digest));
setOutput('built', 'true');
setOutput('week_tag', digest.weekTag);
setOutput('week_title', digest.weekTitle);

console.log(`Built ${digest.weekTag} (${digest.weekTitle}).`);
console.log(`Headline: ${digest.headline ?? '(none)'}`);
console.log(`Includes: ${digest.versions.join(', ')}`);
