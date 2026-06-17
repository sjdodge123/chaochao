// Unit tests for the release-notes library (run: `node --test`).
//
// Guards the weekly digest + per-PR rendering: category taxonomy ordering,
// alias collapse, cross-version de-duplication, headline-title synthesis, the
// headline NON-duplication (the bug where a flagged bullet rendered both as a
// blockquote and under its heading), and the per-PR vs weekly body differences.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildWeeklyDigest,
    renderDigestBody,
    renderPerReleaseBody,
    canonicalHeading,
    isKnownHeading,
    CATEGORY_ORDER,
    FEEDBACK_FOOTER,
} from './changelog-lib.mjs';

// June 15 2026 is a Monday; v0.40.0 (June 10) is the previous week.
const MD = `# Changelog

Intro prose that must be ignored.

## Unreleased

(none yet)

## v0.49.0 — 2026-06-16

### Map editor

- [headline] **New hazard: Magpie Drone.** Steals abilities.

### Bug fixes

- Fixed a collapse-death crash.

## v0.48.0 — 2026-06-15

### General

- **A quality tweak.** Smoother.

### Boons

- [headline:Ziplines] **New placeable: Zipline.** Ride a cable.

### Bug fixes

- Fixed a collapse-death crash.

## v0.40.0 — 2026-06-10

### General

- An older-week note.
`;

test('digest groups follow the canonical category order', () => {
    const d = buildWeeklyDigest(MD);
    const headings = d.groups.map((g) => g.heading);
    assert.deepEqual(headings, ['New Boons', 'Map Editor', 'Quality of Life', 'Bug Fixes']);
    // Each heading is a recognised canonical category, in CATEGORY_ORDER order.
    const idxs = headings.map((h) => CATEGORY_ORDER.indexOf(h));
    assert.deepEqual(idxs, [...idxs].sort((a, b) => a - b));
});

test('only the topmost release week is included; older weeks are excluded', () => {
    const d = buildWeeklyDigest(MD);
    assert.equal(d.weekTag, 'week-2026-06-15');
    assert.deepEqual(d.versions, ['v0.49.0', 'v0.48.0']);
});

test('--week backfill selects a specific past week', () => {
    const d = buildWeeklyDigest(MD, { weekMonday: '2026-06-10' });
    assert.equal(d.weekTag, 'week-2026-06-08'); // Monday of the week containing the 10th
    assert.deepEqual(d.versions, ['v0.40.0']);
});

test('duplicate bullets across versions render once', () => {
    const body = renderDigestBody(buildWeeklyDigest(MD));
    const hits = body.split('Fixed a collapse-death crash.').length - 1;
    assert.equal(hits, 1);
});

test('headline bullet is NOT duplicated (no blockquote + heading double-render)', () => {
    const body = renderDigestBody(buildWeeklyDigest(MD));
    // The bullet body appears exactly once (under its heading), never as a
    // separate "> **…**" headline blockquote.
    assert.equal(body.split('Steals abilities.').length - 1, 1);
    assert.ok(!/^> \*\*New hazard/m.test(body), 'should not render a headline blockquote');
});

test('title names up to three flagged headliners, newest first', () => {
    const d = buildWeeklyDigest(MD);
    assert.deepEqual(d.headliners, ['Magpie Drone', 'Ziplines']);
    assert.equal(d.title, 'Week of June 15, 2026 — Magpie Drone & Ziplines');
});

test('title falls back to the bare week when nothing is flagged', () => {
    const plain = MD.replace(/\[headline(:[^\]]*)?\]\s*/g, '');
    const d = buildWeeklyDigest(plain);
    assert.equal(d.title, 'Week of June 15, 2026');
    assert.deepEqual(d.headliners, []);
});

test('weekly body has greeting intro, Includes line, and footer', () => {
    const body = renderDigestBody(buildWeeklyDigest(MD));
    assert.match(body, /^> Hey racers!/m);
    assert.match(body, /Includes v0\.49\.0, v0\.48\.0\./);
    assert.ok(body.includes(FEEDBACK_FOOTER));
});

test('per-PR body: categorised + footer, but no greeting and no Includes', () => {
    const body = renderPerReleaseBody(
        '### Map editor\n\n- [headline] **New hazard: Magpie Drone.** Steals abilities.\n',
        '0.49.0',
        '2026-06-16',
    );
    assert.match(body, /### Map Editor/);          // heading normalised
    assert.ok(!body.includes('[headline]'));        // marker stripped
    assert.ok(!body.includes('Hey racers'));        // no greeting
    assert.ok(!body.includes('Includes '));         // single version
    assert.ok(body.includes(FEEDBACK_FOOTER));
});

test('heading normalisation + known-heading check', () => {
    assert.equal(canonicalHeading('General'), 'Quality of Life');
    assert.equal(canonicalHeading('map editor'), 'Map Editor');
    assert.equal(canonicalHeading(null), 'Quality of Life');
    assert.equal(canonicalHeading('Frobnicator'), 'Frobnicator'); // unknown kept verbatim
    assert.ok(isKnownHeading('Bug fixes'));
    assert.ok(isKnownHeading('New Hazards'));
    assert.ok(!isKnownHeading('Frobnicator'));
});
