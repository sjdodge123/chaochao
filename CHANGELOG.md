# Changelog

All notable player-facing changes land here. Anything that changes a game mechanic — gameplay tuning, game state/round logic, or physics — MUST add an entry under "Unreleased" in the same change (the `Game mechanic changes need release notes` CI job enforces this).

Write entries in the same player-friendly style as the GitHub releases: short bullets describing what a player will notice, grouped under section headings (`### General`, `### Ability changes`, `### Brutal rounds`, `### Map editor`, `### Bug fixes`, etc.).

Releases are cut automatically on merge to `main` by the `Release on merge to main` workflow: when `## Unreleased` has notes, it moves them under a new `## vX.Y.Z — YYYY-MM-DD` heading, resets `Unreleased`, bumps `package.json`, tags `vX.Y.Z`, and publishes the GitHub release using that section as the body. The version bump comes from the merged PR's label — `release:major`, `release:minor`, or `release:patch` (default `patch`). PRs that add no notes don't trigger a release.

After each release the same workflow also rolls every `vX.Y.Z` from the current calendar week (Monday–Sunday, UTC) into a single consolidated `week-YYYY-MM-DD` GitHub release, and the landing-page banner shows **one headline for the week** linking to it. To choose that headline, prefix the bullet you want featured with `[headline]`, e.g. `- [headline] Now with controller support!` — the most recent flagged bullet of the week wins, and the marker is stripped everywhere it's shown (banner, per-PR release notes, weekly digest). If no bullet is flagged, the week's first bullet is used.

## Unreleased

(none yet)

## v0.6.0 — 2026-05-24

### Animations & game feel

- A big animation & game-feel pass — punches, hits, explosions and ability casts now land with real weight and screen shake.
- Players kick up dust at speed and trail embers while on fire.

### Combat

- Punches are now directional — face an opponent to knock them away. (Hockey-puck bashes and swatting the infected stay all-directional; zombies must face their prey to bite.)

### Abilities

- Tile Swap telegraphs before it fires: the tiles about to flip pulse and flicker, then swap a few seconds later.

### AI racers

- AI racers move a little faster, closer to human pace.

## v0.5.0 — 2026-05-24

### AI racers

- Solo and small games now fill out with named AI racers that drive the course — pathfinding to the goal, braking through corners, and avoiding lava and bumpers — so there's always a full grid.
- They play the whole game: grabbing and using abilities (bombs, boosts, slows, swaps, ice, blindfolds) and throwing punches — including shoving you toward the lava when you leave an opening.
- They handle brutal rounds too: infected bots turn zombie and chase you (healthy bots fend them off), they bash and dodge the hockey puck, ease up for lightning, and get just as lost in blackout, blindfold and clouds as you do.
- Each racer has a personality — a clean pace-setter, a punch-happy wrecking ball, a corner-cutting high-roller, a rival who fixates on you, a chaos-merchant, a cautious tortoise, and a hothead who tilts when behind — and they rubber-band to your pace so a win feels earned. Names and in-character taunts show under each kart.

### Solo play

- Playing solo is winnable: when you're alone, the lava closes in from the goal nearest you at a pace tuned to the distance, so a clean run beats the map instead of a random, map-blind collapse.

### Brutal rounds

- The collapse telegraphs itself — an erupting shockwave sweeps from where the lava starts toward the goal it's closing on (with the volcano rumble), so you can read which way to run.
- Volcano eruptions are timed to map size (about how long it takes to reach the nearest goal) instead of a fixed delay, so bigger maps give proportionally more warning.

## v0.4.0 — 2026-05-24

### Audience

- A stadium crowd now watches and reacts — quiet early, but as someone nears the win they roar for multi-kills and sprees, cheer kills, "ooh" at fights, gasp at near-lava escapes, and erupt when you beat the lava to the goal.

## v0.3.3 — 2026-05-24

### General

- The lobby is now a hands-on practice area: before a match you can roam curated patches of terrain (lava, ice, sand, grass, goals) and try a handful of ability pickups to learn the controls and the feel of each surface. Touch lava and you respawn safely with a few seconds of invulnerability; reach a goal for the victory cue. Nothing counts toward your score, and stepping into the center start circle keeps you invulnerable until the match begins.

### Bug fixes

- Sliding bumpers no longer freeze at the end of their track once a match starts — they turn around and keep sweeping as intended.

## v0.3.2 — 2026-05-24

### General

- Optimized server performance for smoother gameplay, especially in busy rooms.

## v0.3.1 — 2026-05-24

### Bug fixes

- Sliding bumpers no longer jitter or get stuck off the end of their track. After a hitch they now snap back onto their rail and keep moving smoothly.

## v0.3.0 — 2026-05-24

### Map editor

- You can now preview a map you're building straight from the editor and play-test it solo before saving. Hitting Preview drops you right into the race — no lobby to wait through. When you die or reach the goal, you're dropped back into the editor with your map intact so you can keep tweaking and try again. Maps without a goal tile can't be previewed.

## v0.2.0 — 2026-05-24

### General
- [headline] Local co-op with controller support — up to 4 players on one screen (controllers plus one on keyboard/mouse), all in the same game as anyone online.
- Plug in controllers and they show up in a header at the top of the screen; press A on one to jump in. The first controller (with no keyboard player) becomes Player 1, and each player gets their own color so you can tell who's who.
- Each player has their own on-screen controls, emoji wheel, and a "Leave?" prompt (B on a controller, Esc on keyboard) — one player leaving or unplugging never ends everyone else's game.

## v0.1.6 — 2026-05-23

### General
- Everyone in a game now hears the same background music at the same time, and it switches moods together — calm normally, intense when someone's one win away, and ominous on brutal rounds.

### Bug fixes
- Background music no longer cuts out to silence mid-round when a track finishes; it rolls straight into the next one.
- Background music now plays continuously through the round-transition and map-load screens instead of restarting at the start of every race.

## v0.1.5 — 2026-05-23

### Bug fixes
- Fixed a crash that could take down a game when a room filled with many players.

## v0.1.4 — 2026-05-23

### General
- [headline] Now with controller support! Plug in a controller and play

## v0.1.3 — 2026-05-23

### Bug fixes

- Using an ability no longer brings your character to a stop. Only punching without an ability slows you down now.

## Older versions

For releases before this CHANGELOG existed, see https://github.com/sjdodge123/chaochao/releases.
