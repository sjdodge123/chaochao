# Contributing

## Game mechanic changes must ship with player-facing release notes

Any change that touches one of these files counts as a "game mechanic" change:

- `server/config.json` — gameplay tuning (player speed, ability params, brutal-round configuration, timers, …)
- `server/game.js` — game state machine, scoring, round/lobby logic
- `server/engine.js` — physics, collision, hazard/projectile updates

For any such change, add a bullet under `## Unreleased` in `CHANGELOG.md` in the same commit/PR, written in the same player-friendly tone as the existing GitHub releases (https://github.com/sjdodge123/chaochao/releases). Describe what a player will *notice*, not what the code does.

The `Game mechanic changes need release notes` GitHub Actions check enforces this on every PR and push to `main`.

### Cutting a release

1. Move the `## Unreleased` block under a new `## vX.Y.Z — YYYY-MM-DD` heading in `CHANGELOG.md`. Leave a fresh empty `## Unreleased` at the top.
2. Bump `version` in `package.json`.
3. Commit, tag (`git tag vX.Y.Z`), push.
4. Publish a GitHub release with the same tag, pasting the `vX.Y.Z` section as the body.

### Recommended repo settings

For full enforcement, enable branch protection on `main` in GitHub settings:

- Require a pull request before merging
- Require status check `check-release-notes` to pass

Without branch protection a direct push to `main` will still get a red check on the commit, but the push isn't blocked.

## What doesn't need release notes

Bug fixes that don't change observable behaviour, perf work, UI/CSS tweaks, build/CI changes, map JSON submissions through the editor, and refactors are exempt. If you're unsure, write the note — it's cheap, and players appreciate the changelog.
