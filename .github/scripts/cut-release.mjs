// Cut a release from the CHANGELOG's "## Unreleased" section.
//
// Reads CHANGELOG.md, and if the Unreleased section has any notes:
//   - moves those notes under a new "## v<VERSION> — <DATE>" heading,
//   - resets Unreleased to "(none yet)",
//   - bumps package.json "version" to <VERSION>,
//   - writes the notes to RELEASE_NOTES.md (used as the GitHub release body),
//   - sets the step output `released=true`.
// If Unreleased is empty (or "(none yet)"), it changes nothing and sets
// `released=false` so the workflow can skip tagging/publishing.
//
// Inputs (env): VERSION (e.g. "0.1.3"), RELEASE_DATE (e.g. "2026-05-23").

import fs from 'node:fs';

const version = process.env.VERSION;
const date = process.env.RELEASE_DATE;
if (!version || !date) {
  console.error('VERSION and RELEASE_DATE env vars are required');
  process.exit(2);
}

function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

const file = 'CHANGELOG.md';
const src = fs.readFileSync(file, 'utf8');
const lines = src.split('\n');

const unrelIdx = lines.findIndex((l) => /^##\s+Unreleased\s*$/.test(l));
if (unrelIdx === -1) {
  console.error('No "## Unreleased" heading found in CHANGELOG.md');
  process.exit(2);
}

// First "## " heading after Unreleased marks the end of the section.
let nextIdx = lines.length;
for (let i = unrelIdx + 1; i < lines.length; i++) {
  if (/^##\s+/.test(lines[i])) {
    nextIdx = i;
    break;
  }
}

const body = lines.slice(unrelIdx + 1, nextIdx).join('\n').trim();
const isEmpty = body === '' || /^\(none yet\)$/i.test(body);

if (isEmpty) {
  console.log('Unreleased section is empty — nothing to release.');
  setOutput('released', 'false');
  process.exit(0);
}

// Rebuild: empty Unreleased, then the new versioned section, then the rest.
const rebuilt = [
  ...lines.slice(0, unrelIdx + 1),
  '',
  '(none yet)',
  '',
  `## v${version} — ${date}`,
  '',
  body,
  '',
  ...lines.slice(nextIdx),
];
fs.writeFileSync(file, rebuilt.join('\n'));

// Bump package.json (4-space indent + trailing newline, matching repo style).
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = version;
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 4) + '\n');

fs.writeFileSync('RELEASE_NOTES.md', body + '\n');

console.log(`Prepared release v${version} (${date}).`);
setOutput('released', 'true');
