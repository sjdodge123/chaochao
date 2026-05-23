// Shared CHANGELOG parsing for the weekly release digest.
//
// The CHANGELOG lists releases newest-first as "## vX.Y.Z — YYYY-MM-DD"
// sections, each with "### <Heading>" subsections of "- " bullets. Per-PR
// releases keep cutting their own section/tag; this module groups a calendar
// week's worth of those sections (Mon–Sun, UTC) into one consolidated digest
// and picks the week's headline bullet.
//
// A bullet may be flagged as the week's headline with a leading "[headline]"
// marker, e.g. "- [headline] Now with controller support!". The most recent
// such bullet in the week wins; the marker is stripped for display.
//
// NOTE: index.js (CommonJS, at the repo root) reproduces the headline +
// week-tag subset of this logic for the landing-page banner. The week-Monday
// computation and the "week-YYYY-MM-DD" tag format MUST stay identical in both
// places, or the banner link will 404 against the digest release.

const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
];

const HEADLINE_RE = /^(\s*-\s+)\[headline\]\s*/i;

// Remove a leading "[headline]" marker from a single bullet line (keeps the
// "- " prefix). Non-bullet lines and unmarked bullets pass through unchanged.
export function stripHeadlineMarker(line) {
    return line.replace(HEADLINE_RE, '$1');
}

// Strip "[headline]" markers from every bullet in a multi-line block.
export function stripHeadlineMarkers(body) {
    return body
        .split('\n')
        .map((l) => stripHeadlineMarker(l))
        .join('\n');
}

// Does this bullet line carry the [headline] marker?
function isHeadlineBullet(line) {
    return HEADLINE_RE.test(line);
}

// Bullet text without the "- " prefix and without any [headline] marker.
function bulletText(line) {
    return stripHeadlineMarker(line).replace(/^\s*-\s+/, '').trim();
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
// there are no releases yet. The "current week" is the calendar week of the
// most recent (topmost) release section, so the banner is never empty between
// releases.
export function buildWeeklyDigest(md) {
    const sections = parseSections(md);
    if (!sections.length) return null;

    const monday = mondayOf(sections[0].date);
    const weekSections = sections.filter((s) => mondayOf(s.date) === monday);

    // Merge groups across the week, preserving heading first-seen order and
    // dropping duplicate bullets (by stripped text).
    const order = [];
    const byHeading = new Map();
    const seen = new Set();
    let headline = null;

    for (const s of weekSections) {
        for (const g of s.groups) {
            const key = g.heading || '';
            if (!byHeading.has(key)) { byHeading.set(key, []); order.push(key); }
            for (const b of g.bullets) {
                const text = bulletText(b);
                if (headline === null && isHeadlineBullet(b)) headline = text;
                if (seen.has(text)) continue;
                seen.add(text);
                byHeading.get(key).push(text);
            }
        }
    }
    // Fallback headline: the first bullet of the week.
    if (headline === null) {
        const firstKey = order.find((k) => byHeading.get(k).length);
        if (firstKey !== undefined) headline = byHeading.get(firstKey)[0];
    }

    const groups = order
        .map((k) => ({ heading: k || null, bullets: byHeading.get(k) }))
        .filter((g) => g.bullets.length);

    return {
        weekMonday: monday,
        weekTag: `week-${monday}`,
        weekTitle: weekTitle(monday),
        headline,
        groups,
        versions: weekSections.map((s) => `v${s.version}`),
    };
}

// Render the digest's body as Markdown for the GitHub release notes.
export function renderDigestBody(digest) {
    const out = [];
    if (digest.headline) out.push(`> **${digest.headline}**`, '');
    for (const g of digest.groups) {
        if (g.heading) out.push(`### ${g.heading}`);
        for (const b of g.bullets) out.push(`- ${b}`);
        out.push('');
    }
    if (digest.versions.length) {
        out.push('---', `Includes ${digest.versions.join(', ')}.`);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
