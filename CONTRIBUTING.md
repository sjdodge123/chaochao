# Contributing

## Game mechanic changes must ship with player-facing release notes

Any change that touches one of these files counts as a "game mechanic" change:

- `server/config.json` — gameplay tuning (player speed, ability params, brutal-round configuration, timers, …)
- `server/game.js` — game state machine, scoring, round/lobby logic
- `server/engine.js` — physics, collision, hazard/projectile updates

For any such change, add a bullet under `## Unreleased` in `CHANGELOG.md` in the same commit/PR, written in the same player-friendly tone as the existing GitHub releases (https://github.com/sjdodge123/chaochao/releases). Describe what a player will *notice*, not what the code does.

The `Game mechanic changes need release notes` GitHub Actions check enforces this on every PR and push to `main`.

### Weekly digest and the front-page headline

Every PR still cuts its own `vX.Y.Z` release, but the landing-page banner shows **one headline per calendar week** (Mon–Sun, UTC) linking to a consolidated `week-YYYY-MM-DD` GitHub release that the release workflow builds automatically. To pick the bullet featured as that week's headline, prefix it with `[headline]`:

```
### General
- [headline] Now with controller support!
- Smaller polish that won't be the headline
```

The most recent `[headline]` bullet in the week wins; if none is flagged, the week's first bullet is used. The marker is stripped wherever the line is shown (banner, per-PR release notes, and the weekly digest), so it only affects which line gets promoted.

### Cutting a release

1. Move the `## Unreleased` block under a new `## vX.Y.Z — YYYY-MM-DD` heading in `CHANGELOG.md`. Leave a fresh empty `## Unreleased` at the top.
2. Commit and push to `main`.
3. Tag the commit: `git tag vX.Y.Z && git push --tags`.
4. The `Sync package.json to release tag` workflow lands a follow-up commit on `main` bumping `package.json` to match the tag. Heroku deploys main HEAD, so the landing page picks up the new version automatically.
5. Publish a GitHub release with the same tag, pasting the `vX.Y.Z` section of `CHANGELOG.md` as the body.

### Recommended repo settings

For full enforcement, enable branch protection on `main` in GitHub settings:

- Require a pull request before merging
- Require status check `check-release-notes` to pass

Without branch protection a direct push to `main` will still get a red check on the commit, but the push isn't blocked.

Note: if you enable "require a PR before merging" for `main`, the `sync-package-version` workflow won't be able to push its bump commit directly — swap its push step for `peter-evans/create-pull-request` or similar so it opens a PR instead.

## What doesn't need release notes

Bug fixes that don't change observable behaviour, perf work, UI/CSS tweaks, build/CI changes, map JSON submissions through the editor, and refactors are exempt. If you're unsure, write the note — it's cheap, and players appreciate the changelog.
