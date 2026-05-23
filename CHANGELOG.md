# Changelog

All notable player-facing changes land here. Anything that changes a game mechanic — gameplay tuning, game state/round logic, or physics — MUST add an entry under "Unreleased" in the same change (the `Game mechanic changes need release notes` CI job enforces this).

Write entries in the same player-friendly style as the GitHub releases: short bullets describing what a player will notice, grouped under section headings (`### General`, `### Ability changes`, `### Brutal rounds`, `### Map editor`, `### Bug fixes`, etc.).

When cutting a release: move the `Unreleased` contents under a new `## vX.Y.Z — YYYY-MM-DD` heading, leave a fresh empty `Unreleased` block at the top, tag the commit, and publish the release on GitHub using that section as the body.

## Unreleased

(none yet)

## v0.1.3 — 2026-05-23

### Bug fixes

- Using an ability no longer brings your character to a stop. Only punching without an ability slows you down now.

## Older versions

For releases before this CHANGELOG existed, see https://github.com/sjdodge123/chaochao/releases.
