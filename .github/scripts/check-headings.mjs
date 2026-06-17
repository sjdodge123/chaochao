// Warn (never fail) when the "## Unreleased" section uses a "### Heading" the
// release-notes taxonomy doesn't recognise. Unknown headings still render —
// they're kept verbatim and sorted just before Bug Fixes — but nudging authors
// toward the canonical set keeps the generated notes tidy. Single source of
// truth for the known set is changelog-lib.mjs.

import fs from 'node:fs';
import { isKnownHeading, CATEGORY_ORDER } from './changelog-lib.mjs';

const md = fs.readFileSync('CHANGELOG.md', 'utf8');
const lines = md.split('\n');

let inUnreleased = false;
let unknown = 0;
for (const line of lines) {
    if (/^##\s+Unreleased\s*$/.test(line)) { inUnreleased = true; continue; }
    if (/^##\s+/.test(line)) { inUnreleased = false; continue; }
    if (!inUnreleased) continue;
    const m = line.match(/^###\s+(.*\S)\s*$/);
    if (m && !isKnownHeading(m[1])) {
        console.log(`::warning file=CHANGELOG.md::Unrecognised release-notes heading "### ${m[1]}" — it renders verbatim before Bug Fixes. Canonical categories: ${CATEGORY_ORDER.join(', ')}.`);
        unknown++;
    }
}

console.log(unknown
    ? `Found ${unknown} unrecognised heading(s) under ## Unreleased (warning only).`
    : 'All ## Unreleased headings map to the canonical taxonomy.');
// Warn-only: never blocks a merge.
process.exit(0);
