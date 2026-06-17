// Shared CHANGELOG parsing for the release notes (per-PR and weekly digest).
//
// The CHANGELOG lists releases newest-first as "## vX.Y.Z — YYYY-MM-DD"
// sections, each with "### <Heading>" subsections of "- " bullets. Per-PR
// releases keep cutting their own section/tag; the weekly digest groups a
// calendar week's worth of those sections (Mon–Sun, UTC) into one consolidated
// set of notes.
//
// Both the per-PR body and the weekly digest are run through the SAME renderer:
// the author's free-text headings are normalised to a fixed category taxonomy
// (HEADING_ALIASES -> CATEGORY_ORDER), bullets are de-duplicated, groups are
// ordered marquee -> minor, and a feedback footer is appended.
//
// A bullet may be flagged as a week's headline with a leading "[headline]"
// marker, e.g. "- [headline] Now with controller support!". An optional short
// name for the digest title can be supplied as "[headline:Magpie Drone] ...".
// Up to three flagged bullets (newest first) name the week's digest title; the
// marker is stripped for display everywhere.
//
// NOTE: index.js (CommonJS, at the repo root) reproduces the headline +
// week-tag subset of this logic for the landing-page banner. The week-Monday
// computation and the "week-YYYY-MM-DD" tag format MUST stay identical in both
// places, or the banner link will 404 against the digest release. The banner
// also strips the "[headline]"/"[headline:Name]" marker — keep that in lockstep.

const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

// Canonical category order for the rendered notes, marquee -> minor. An
// author's "### Heading" is normalised through HEADING_ALIASES to one of these,
// and groups are rendered in this order.
export const CATEGORY_ORDER = [
    'New Hazards',
    'New Boons',
    'New Abilities',
    'New Brutal Rounds',
    'New Maps & Modes',
    'Map Editor',
    'AI Racers',
    'Gameplay & Balance',
    'Controls & Couch Co-op',
    'Audio & Visuals',
    'Quality of Life',
    'Bug Fixes',
];

// Free-text headings (lower-cased) -> canonical category. New marquee content
// (a new hazard/boon/ability/mode) should be authored under the matching
// "New ..." heading so it leads the notes; everything else folds into the
// general buckets. Unknown headings are kept as-authored and sorted just before
// Bug Fixes (and the release-notes-check workflow warns about them).
const HEADING_ALIASES = new Map([
    ['new hazards', 'New Hazards'],
    ['new hazard', 'New Hazards'],
    ['hazards', 'New Hazards'],
    ['new boons', 'New Boons'],
    ['new boon', 'New Boons'],
    ['boons', 'New Boons'],
    ['new abilities', 'New Abilities'],
    ['new ability', 'New Abilities'],
    ['abilities', 'New Abilities'],
    ['new brutal rounds', 'New Brutal Rounds'],
    ['new brutal round', 'New Brutal Rounds'],
    ['brutal rounds', 'New Brutal Rounds'],
    ['brutal round', 'New Brutal Rounds'],
    ['new maps & modes', 'New Maps & Modes'],
    ['new maps', 'New Maps & Modes'],
    ['maps', 'New Maps & Modes'],
    ['modes', 'New Maps & Modes'],
    ['game modes', 'New Maps & Modes'],
    ['team modes', 'New Maps & Modes'],
    ['map editor', 'Map Editor'],
    ['editor', 'Map Editor'],
    ['ai racers', 'AI Racers'],
    ['ai', 'AI Racers'],
    ['bots', 'AI Racers'],
    ['gameplay & balance', 'Gameplay & Balance'],
    ['gameplay', 'Gameplay & Balance'],
    ['balance', 'Gameplay & Balance'],
    ['ability changes', 'Gameplay & Balance'],
    ['combat', 'Gameplay & Balance'],
    ['controls & couch co-op', 'Controls & Couch Co-op'],
    ['controller & couch co-op', 'Controls & Couch Co-op'],
    ['controls', 'Controls & Couch Co-op'],
    ['controller', 'Controls & Couch Co-op'],
    ['audio & visuals', 'Audio & Visuals'],
    ['audio', 'Audio & Visuals'],
    ['sound', 'Audio & Visuals'],
    ['music', 'Audio & Visuals'],
    ['display', 'Audio & Visuals'],
    ['animations & game feel', 'Audio & Visuals'],
    ['visuals', 'Audio & Visuals'],
    ['quality of life', 'Quality of Life'],
    ['general', 'Quality of Life'],
    ['solo play', 'Quality of Life'],
    ['audience', 'Quality of Life'],
    ['bug fixes', 'Bug Fixes'],
    ['bugfixes', 'Bug Fixes'],
    ['fixes', 'Bug Fixes'],
]);

// Bullets that appear before any "### " heading fold into this catch-all.
const DEFAULT_CATEGORY = 'Quality of Life';

// Closing community/feedback block, shown on every release body.
export const FEEDBACK_FOOTER =
    '**Feedback & bug reports** — [Play the update](https://www.chaochaogame.com) · ' +
    '[Report a bug](https://github.com/sjdodge123/chaochao/issues)';

// Matches a "[headline]" or "[headline:Short Name]" marker at the start of a
// bullet. Group 1 = the "- " prefix (preserved on strip); group 2 = the
// optional short name for the digest title.
const HEADLINE_RE = /^(\s*-\s+)\[headline(?::\s*([^\]]+))?\]\s*/i;

// Remove a leading headline marker from a single bullet line (keeps the "- "
// prefix). Non-bullet lines and unmarked bullets pass through unchanged.
export function stripHeadlineMarker(line) {
    return line.replace(HEADLINE_RE, '$1');
}

// Strip headline markers from every bullet in a multi-line block.
export function stripHeadlineMarkers(body) {
    return body
        .split('\n')
        .map((l) => stripHeadlineMarker(l))
        .join('\n');
}

// Does this bullet line carry the headline marker?
function isHeadlineBullet(line) {
    return HEADLINE_RE.test(line);
}

// Bullet text without the "- " prefix and without any headline marker.
function bulletText(line) {
    return stripHeadlineMarker(line).replace(/^\s*-\s+/, '').trim();
}

// Strip markdown link/emphasis/code so we can derive a plain short name.
function plainText(t) {
    return t
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [text](url) -> text
        .replace(/[*`_]/g, '')                    // emphasis/code markers
        .trim();
}

// Short name for a headline bullet used in the digest title. Prefers an
// explicit "[headline:Name]" override, then the bullet's bold lead-in
// ("**Orbital Beam**" -> "Orbital Beam"), else the bullet text. From that it
// pulls a short label: a "New <kind>: Name" / "New <kind> — Name" lead keeps
// the Name; otherwise it takes the first clause (up to sentence/colon/dash
// punctuation), capped to six words. Authors wanting a precise title should set
// "[headline:Short Name]" — this is a best-effort fallback.
const MAX_NAME_WORDS = 6;
function headlineName(line) {
    const m = line.match(HEADLINE_RE);
    if (m && m[2]) return m[2].trim();

    const raw = bulletText(line);
    const bold = raw.match(/\*\*(.+?)\*\*/);
    let s = plainText(bold ? bold[1] : raw);

    // "New hazard: Magpie Drone" / "New ability — Orbital Beam" -> the Name.
    const newKind = s.match(/^New\s+\w+\s*[:—–-]\s*(.+)$/i);
    if (newKind) s = newKind[1];

    // First clause: stop at sentence/colon/semicolon or a spaced dash (keeps
    // hyphenated words intact).
    s = s.split(/[.!?:;]|\s[—–-]\s/)[0].replace(/[.!?]+$/, '').trim();

    const words = s.split(/\s+/);
    return words.length > MAX_NAME_WORDS ? words.slice(0, MAX_NAME_WORDS).join(' ') : s;
}

// Join names with serial "&": ["A"] -> "A", ["A","B"] -> "A & B",
// ["A","B","C"] -> "A, B & C".
function joinAnd(arr) {
    if (arr.length <= 1) return arr[0] || '';
    if (arr.length === 2) return `${arr[0]} & ${arr[1]}`;
    return `${arr.slice(0, -1).join(', ')} & ${arr[arr.length - 1]}`;
}

// Normalise an author heading (or null) to a canonical category. Unknown
// headings are kept verbatim (trimmed).
export function canonicalHeading(heading) {
    if (heading == null) return DEFAULT_CATEGORY;
    const key = heading.trim().toLowerCase();
    return HEADING_ALIASES.get(key) || heading.trim();
}

// Is this heading one the taxonomy recognises? (Used by the warn-only CI check
// so authors get nudged toward the canonical set.)
export function isKnownHeading(heading) {
    if (heading == null) return true;
    const key = heading.trim().toLowerCase();
    return HEADING_ALIASES.has(key) || CATEGORY_ORDER.includes(heading.trim());
}

// Sort key for a canonical category: its index in CATEGORY_ORDER, or just
// before Bug Fixes for unknown (kept-verbatim) headings.
function orderIndex(canonical) {
    const i = CATEGORY_ORDER.indexOf(canonical);
    return i === -1 ? CATEGORY_ORDER.indexOf('Bug Fixes') - 0.5 : i;
}

// Collapse parsed section groups into canonical, de-duplicated, ordered groups.
// `sectionGroups` is [{ heading|null, bullets:[rawLine] }] (newest first). The
// optional `onBullet(rawLine, text)` hook lets a caller observe each unique
// bullet (the digest uses it to spot headline markers). Returns
// [{ heading, bullets:[text] }] in CATEGORY_ORDER.
function consolidateGroups(sectionGroups, onBullet) {
    const byCanon = new Map();   // canonical heading -> { firstSeen, bullets }
    const seen = new Set();
    let order = 0;

    for (const g of sectionGroups) {
        const canon = canonicalHeading(g.heading);
        if (!byCanon.has(canon)) byCanon.set(canon, { firstSeen: order++, bullets: [] });
        for (const raw of g.bullets) {
            const text = bulletText(raw);
            if (onBullet) onBullet(raw, text);
            if (seen.has(text)) continue;
            seen.add(text);
            byCanon.get(canon).bullets.push(text);
        }
    }

    return [...byCanon.entries()]
        .map(([heading, v]) => ({ heading, bullets: v.bullets, firstSeen: v.firstSeen }))
        .filter((g) => g.bullets.length)
        .sort((a, b) => orderIndex(a.heading) - orderIndex(b.heading) || a.firstSeen - b.firstSeen)
        .map(({ heading, bullets }) => ({ heading, bullets }));
}

// Monday (UTC) of the calendar week containing the given YYYY-MM-DD, returned
// as YYYY-MM-DD. Weeks run Monday–Sunday.
export function mondayOf(dateStr) {
    const d = new Date(`${dateStr}T00:00:00Z`);
    const dow = d.getUTCDay();              // 0=Sun..6=Sat
    const backToMonday = (dow + 6) % 7;     // Mon->0, Sun->6
    d.setUTCDate(d.getUTCDate() - backToMonday);
    return d.toISOString().slice(0, 10);
}

// "Week of May 18, 2026" for a YYYY-MM-DD Monday.
export function weekTitle(mondayStr) {
    const d = new Date(`${mondayStr}T00:00:00Z`);
    return `Week of ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

// Parse "## vX.Y.Z — YYYY-MM-DD" sections (newest first, as written). Each
// section becomes { version, date, groups: [{ heading|null, bullets:[line] }] }.
// "## Unreleased" and the intro prose are ignored.
export function parseSections(md) {
    const lines = md.split('\n');
    const sections = [];
    let cur = null;
    let group = null;

    const pushGroup = () => {
        if (group && group.bullets.length) cur.groups.push(group);
        group = null;
    };

    for (const line of lines) {
        const ver = line.match(/^##\s+v(\d+\.\d+\.\d+)\s+—\s+(\d{4}-\d{2}-\d{2})/);
        if (line.startsWith('## ')) {
            // Any "## " heading closes the current section.
            if (cur) { pushGroup(); sections.push(cur); cur = null; }
            if (ver) cur = { version: ver[1], date: ver[2], groups: [] };
            continue;
        }
        if (!cur) continue;
        const sub = line.match(/^###\s+(.*\S)\s*$/);
        if (sub) { pushGroup(); group = { heading: sub[1], bullets: [] }; continue; }
        if (/^\s*-\s+/.test(line)) {
            if (!group) group = { heading: null, bullets: [] };
            group.bullets.push(line);
        }
    }
    if (cur) { pushGroup(); sections.push(cur); }
    return sections;
}

// Build the consolidated weekly digest from CHANGELOG markdown, or null if
// there are no releases yet. By default the "current week" is the calendar week
// of the most recent (topmost) release section, so the banner is never empty
// between releases. Pass opts.weekMonday (any YYYY-MM-DD in the target week) to
// backfill a specific past week instead.
export function buildWeeklyDigest(md, opts = {}) {
    const sections = parseSections(md);
    if (!sections.length) return null;

    const monday = opts.weekMonday ? mondayOf(opts.weekMonday) : mondayOf(sections[0].date);
    const weekSections = sections.filter((s) => mondayOf(s.date) === monday);
    if (!weekSections.length) return null;

    // Flatten the week's groups (newest first) so consolidateGroups merges them.
    const allGroups = weekSections.flatMap((s) => s.groups);
    const headlineNames = [];
    let headline = null;
    const groups = consolidateGroups(allGroups, (raw, text) => {
        if (!isHeadlineBullet(raw)) return;
        if (headline === null) headline = text;
        headlineNames.push(headlineName(raw));
    });

    // The digest title names up to three flagged headline bullets (newest
    // first); with none flagged it stays the bare "Week of …".
    const headliners = [...new Set(headlineNames)].slice(0, 3);
    const base = weekTitle(monday);
    const title = headliners.length ? `${base} — ${joinAnd(headliners)}` : base;

    return {
        weekMonday: monday,
        weekTag: `week-${monday}`,
        weekTitle: base,
        title,
        headline,
        headliners,
        groups,
        versions: weekSections.map((s) => `v${s.version}`),
    };
}

// Render a release body as Markdown: an optional intro blockquote, the ordered
// "### Category" groups, then a footer (an "Includes …" version line when given,
// plus the feedback block).
export function renderReleaseBody({ intro = null, groups = [], versions = [] } = {}) {
    const out = [];
    if (intro) out.push(`> ${intro}`, '');
    for (const g of groups) {
        if (g.heading) out.push(`### ${g.heading}`);
        for (const b of g.bullets) out.push(`- ${b}`);
        out.push('');
    }
    out.push('---');
    if (versions.length) out.push(`Includes ${versions.join(', ')}.`, '');
    out.push(FEEDBACK_FOOTER);
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

// Greeting + one-line summary for the weekly digest intro.
function weeklyIntro(digest) {
    const summary = digest.headliners.length
        ? ` Highlights: ${joinAnd(digest.headliners)}.`
        : '';
    return `Hey racers!${summary} Here's everything new this week.`;
}

// Render the weekly digest body (greeting intro + categories + "Includes …").
export function renderDigestBody(digest) {
    return renderReleaseBody({
        intro: weeklyIntro(digest),
        groups: digest.groups,
        versions: digest.versions,
    });
}

// Render a single per-PR release body from the just-cut "## Unreleased" block
// (markdown WITHOUT the version heading). Categorised and footed like the
// digest, but with no greeting intro and no "Includes …" line (one version).
export function renderPerReleaseBody(body, version, date) {
    const sections = parseSections(`## v${version} — ${date}\n\n${body}\n`);
    const groups = sections.length ? consolidateGroups(sections[0].groups) : [];
    return renderReleaseBody({ groups });
}
