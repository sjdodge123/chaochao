# Codex coverage plan — keep the learn page current with every player-facing mechanic

## Why

The in-game **Codex** (`learn.html` → `client/scripts/learn.js`) is dual-purpose: a player reference *and* an agent knowledge base. It has silently fallen behind the placeables work, and nothing in CI catches it.

Audit (2026-06-17):
- **CI does not gate placeables.** `.github/scripts/codex-coverage.js` only enforces four dimensions — abilities (`ability-<key>`), brutal rounds (`brutal-<key>`), tiles (`tile-<key>`), medals (`medal-<key>`). It never reads `config.hazards` or `config.boons`, so every hazard/boon shipped with green CI regardless of Codex coverage.
- **Boons: 10 of 11 have zero Codex presence** (only Warp Pads is mentioned). Missing: `dashArrows`, `rechargeSpring`, `slipstream`, `guardHalo`, `secondWindTotem`, `launchPad`, `barrelCannon`, `slingshotRings`, `zipline`, `lilyPad`.
- **Hazards: all 13 exist but none has a dedicated card** — they're narrated in the prose of a single "Bumpers" terrain card (`tile-bumper`) plus antlion/thumper inside `brutal-antlion`.
- There is **no Hazards or Boons category** in the Codex, and **no learn-scene for any boon** (only `bumper` and `antlion` scenes exist for placeables).

Goal: (1) close the gap with a dedicated card + scene per placeable, (2) add CI so the Codex can never silently drift again — both for *new* registry entries and for *changes to existing* player-facing mechanics.

## Canonical worklist (what must have a card)

From `server/config.json`. Card-id scheme: `hazard-<key>` / `boon-<key>` (key lower-cased, matching the existing `ability-<key>` convention).

**Hazards** (`config.hazards`, ids 900–912) → 13 cards:
`bumper`, `movingBumper`, `bumperWall`, `rotor`, `geyser`, `mine`, `antlion`, `thumper`, `vortexWell`, `laserGate`, `crusher`, `sentryTurret`, `magpieDrone`

**Boons** (`config.boons`, ids 950–960) → 11 cards:
`dashArrows`, `rechargeSpring`, `slipstream`, `guardHalo`, `secondWindTotem`, `launchPad`, `barrelCannon`, `slingshotRings`, `warpPad`, `zipline`, `lilyPad`

→ **24 cards + 24 scenes** (reuse allowed where visually faithful; see below).

## How the pieces fit (verbatim patterns to replicate)

### Codex cards — `client/scripts/learn.js`

`CODEX` is an array of **category** objects, each `{ id, label, entries: [...] }`. Existing categories: `basics` (~L60), `terrain` (~L111), `abilities` (~L153), `brutal` (~L189), `medals` (~L241).

A card (ability/brutal cards share one shape):
```js
{ id: "brutal-ability", name: "Ability", icon: svg("toolbox-solid.svg"), anim: "abilityRain",
  blurb: "Every racer starts holding an ability.",
  detail: "Every racer starts already holding a random ability... an instant free-for-all of effects." },
```
Fields: `id` (unique, used for the deep-link hash → use `hazard-<key>` / `boon-<key>`), `name` (title), `icon` (helper: `swatch("#hex")`, `tex("file.png")`, `svg("file.svg")`, `emoji("👊")`, or `art("bumper")`), `anim` (scene name in learnScenes.js), `blurb` (short search line), `detail` (string or array of paragraphs). `show: false` parks a card.

**Plan:** add two new categories, `hazards` (label "Hazards") and `boons` (label "Boons"), after `brutal`. Move the hazard detail currently buried in `tile-bumper` into the dedicated hazard cards; leave a one-line pointer in the terrain card.

**Prose source:** the richest plain-English copy already exists — mine it, don't reinvent:
- `CHANGELOG.md` / the weekly release notes (each placeable shipped with a polished player-facing paragraph).
- `config.json` `_doc` strings on the richer entries (e.g. `rechargeSpring`, `slipstream`, `magpieDrone`).
- Trim to Codex voice: a one-line `blurb` + 1–3 short `detail` paragraphs (how it behaves + how to play around it).

### Learn-scenes — `client/scripts/learnScenes.js`

Each `anim` must resolve to `SCENES["<anim>"] = function (s) { ... }`. The state object `s` provides `s.ctx`, `s.t` (ms), `s.dt`, `s.p` (reusable kart), `s.mem` (scratch for `onCycle`). Globals: `W`, `H`, `MAXSPEED`, `RED`, `BLUE`; helpers `floor`, `kart`, `bumper`, `ping`, `loop`, `lerp`, `ease`, `clamp`, `img`, `ready`, `onCycle`, `spawn*`. The coverage gate already verifies every `anim` resolves to a real scene.

Reference scene (`bumper`, ~12 lines):
```js
SCENES["bumper"] = function (s) {
    floor(s.ctx, "dirt.png", 60);
    var bx = W * 0.66, by = H / 2, p = s.p; p.radius = 11; p.surface = "normal"; p.alive = true;
    var ph = ping(s.t, 2400), x = lerp(-20, bx - 26, ease(ph));
    p.velX = (ph < 0.5 ? 1 : -1) * MAXSPEED * 0.5; p.velY = 0; p.angle = ph < 0.5 ? 0 : 180;
    p.x = x; p.y = by;
    updateMovementParticles(p, s.dt);
    kart(s.ctx, x, by, p.radius, BLUE);
    bumper(s.ctx, bx, by, 11);
    onCycle(s.mem, s.t - 1200, 2400, "bounce", function () { spawnPunchEffect(bx - 16, by, 14, "#E5392B", 180); });
};
```
Per-scene effort: ~5–15 lines. **Reuse** the actual in-game sprite Images (the hazard/boon draw paths in `draw.js`) via `img(...)` where one exists, so the scene looks like the real thing. Two near-identical placeables (e.g. `bumper`/`movingBumper`) may share an anim if visually faithful — but default to one scene each.

### Coverage gate — `.github/scripts/codex-coverage.js`

It harvests card ids with `for (const m of learnSrc.matchAll(/id:\s*"([^"]+)"/g)) cardIds.add(m[1])` and reports via `check(cond, msg)` (→ `failures++`, `process.exit(1)`). The abilities loop is the pattern to mirror:
```js
for (const key in c.tileMap.abilities) {
    const def = c.tileMap.abilities[key];
    if (def == null || typeof def !== 'object' || def.spawnable !== true) { continue; }
    const id = 'ability-' + key.toLowerCase();
    check(cardIds.has(id), 'ability "' + key + '" has Codex card ' + id);
}
```

**Plan — add two loops:**
```js
for (const key in c.hazards) {
    const def = c.hazards[key];
    if (def == null || typeof def !== 'object') { continue; } // skips the _doc string siblings
    check(cardIds.has('hazard-' + key.toLowerCase()), 'hazard "' + key + '" has Codex card');
}
for (const key in c.boons) {
    const def = c.boons[key];
    if (def == null || typeof def !== 'object') { continue; }
    check(cardIds.has('boon-' + key.toLowerCase()), 'boon "' + key + '" has Codex card');
}
```
This runs in the `validate-content` job of `pr-validation.yml` (already wired: `node .github/scripts/codex-coverage.js`), so **every PR is gated** — a new hazard/boon without a card fails CI. Adding these loops first is the cheapest way to auto-generate the worklist (CI prints every missing `hazard-*`/`boon-*`).

## Keeping the Codex current for EVERY player-facing change

The static coverage gate catches **new registry entries** (ability/brutal/tile/medal/hazard/boon) — any new one fails until carded. It cannot catch **prose going stale** when an *existing* mechanic is retuned/reworked (no new key appears). Close that with two more levers:

1. **Diff-based "mechanic change ⇒ Codex touched" CI gate (warn-only to start).** Clone the proven pattern in `.github/workflows/release-notes-check.yml` (which already requires a CHANGELOG entry when `server/config.json`/`game.js`/`engine.js` change, with a conventional-commit exemption). Add a sibling check: when those files change in a PR, check whether `client/scripts/learn.js` **or** `client/scripts/learnScenes.js` was also touched — if not, **emit a `::warning::` annotation pointing at the Codex but do NOT fail the build** (`exit 0`). Keep the same conventional-commit exemption so refactors/perf/build don't trip it. Ship it warn-only for a settling period; once the Codex is caught up and the gate proves low-noise, promote it to required (flip the warn to `exit 1`) — a later, separate decision.
2. **Authoring rule in `CLAUDE.md` + `CONTRIBUTING.md`.** Add a short rule mirroring the existing release-notes rule: *"Any player-facing mechanic change must update the matching Codex card (`learn.js`) and its scene (`learnScenes.js`) in the same PR — new mechanic = new card+scene; changed mechanic = refreshed prose."* Link it from the existing `learn-codex-page` guidance.

Together: new mechanics are hard-gated by coverage; existing-mechanic edits are caught by the diff gate; the authoring rule documents the expectation.

## Implementation sequence

1. **CI first (worklist generator).** Add the `hazards`/`boons` loops to `codex-coverage.js`; run it locally → it prints all 24 missing cards. This is the live checklist.
2. **Categories + cards.** Add `hazards` and `boons` categories to `CODEX` in `learn.js`; write 13 + 11 cards, mining CHANGELOG/release-notes/`_doc` for prose. Refactor the `tile-bumper` card down to a pointer once hazards have their own cards.
3. **Scenes.** Add a `SCENES["<anim>"]` for every new card's `anim` in `learnScenes.js`, reusing real sprites/helpers; keep them 5–15 lines.
4. **Drift gate.** Add the mechanic⇒Codex diff check (new workflow or extend `release-notes-check.yml`) + the escape hatch.
5. **Authoring rule.** Update `CLAUDE.md` + `CONTRIBUTING.md`.
6. **Verify.**

## Acceptance criteria

- `node .github/scripts/codex-coverage.js` passes with the new hazard/boon loops (all 24 placeables carded; every `anim` resolves to a real scene — the existing anim→scene check stays green).
- `npm run build` and `node .github/scripts/smoke-test.js` pass; `node --check` clean.
- The learn page renders the new Hazards and Boons categories with working deep-link hashes (`#hazard-magpieDrone`, `#boon-zipline`, …) and animated scenes — visual spot-check.
- The mechanic⇒Codex diff gate **warns (does not fail)** on a test PR that edits `config.json` without touching `learn.js`/`learnScenes.js`, is silent when the Codex is updated or the commit is exempt, and never blocks a merge in this first iteration.
- `CLAUDE.md`/`CONTRIBUTING.md` document the rule.

## Notes / gotchas

- `config.json` placeable entries have **no** `name`/`desc`/`helpful` field — only `id`, `color`, and tuning numbers (plus an optional `_doc` prose string on richer entries). `helpful: true` is applied at registration in `server/entities/boons.js`, not in config. So the card `name`/`detail` come from human-written prose (CHANGELOG/release notes/`_doc`), not from config fields.
- The coverage loop's `typeof !== 'object'` guard is essential: `_doc` siblings are plain strings and must be skipped.
- Per `learn-codex-page` memory: the `CODEX` array is the canonical plain-English behavior reference — write the prose to be accurate for both players and future agents.
- This is a sizable content task (24 cards + 24 scenes). It splits cleanly: the CI loops + drift gate are quick; the cards are medium (prose mining); the scenes are the long pole. An implementing agent can pipeline placeable-by-placeable (card + scene together) once the coverage loop is printing the worklist.

---

## Hand-off prompt for a fresh implementation agent

> **Task: close the Codex coverage gap for hazards/boons and add CI so it can never drift again.** Work in the chaochao repo. Read `docs/codex-coverage-plan.md` first — it has the full design, verbatim code patterns, the 24-item worklist, and acceptance criteria. Create a git worktree before editing.
>
> Deliver, in this order:
> 1. **Extend `.github/scripts/codex-coverage.js`**: add two loops mirroring the abilities loop — `c.hazards` → require card id `hazard-<key>` (lower-cased), `c.boons` → `boon-<key>`, skipping non-object entries (the `_doc` string siblings). Run `node .github/scripts/codex-coverage.js` to print the full list of missing cards — that's your worklist (expect 24).
> 2. **Add cards to `client/scripts/learn.js`**: add two new `CODEX` categories `{ id: "hazards", label: "Hazards", entries: [...] }` and `{ id: "boons", label: "Boons", entries: [...] }` after `brutal`. Write one card per placeable (13 hazards + 11 boons) with `id` (`hazard-<key>`/`boon-<key>`), `name`, `icon` (reuse the real sprite via `tex`/`art`/`svg` where possible), `anim`, `blurb`, and `detail`. Mine the prose from `CHANGELOG.md`, the GitHub weekly release notes, and the `_doc` strings in `server/config.json` — keep it accurate and player-facing. Slim the existing `tile-bumper` terrain card to a short pointer once hazards have dedicated cards.
> 3. **Add scenes to `client/scripts/learnScenes.js`**: a `SCENES["<anim>"] = function (s) { ... }` for every new card's `anim`. Study `SCENES["bumper"]` and `SCENES["antlion"]` and reuse the in-game draw helpers/sprites so each looks like the real placeable. 5–15 lines each; sharing an anim between two visually identical placeables is fine.
> 4. **Add a drift gate (WARN-ONLY for now)**: clone the mechanic-detection in `.github/workflows/release-notes-check.yml` into a check that, when `server/config.json`/`server/game.js`/`server/engine.js` change in a PR, checks whether `client/scripts/learn.js` or `client/scripts/learnScenes.js` was also touched — if not, emit a `::warning::` pointing at the Codex but **`exit 0` (do not fail the build)**. Keep the conventional-commit exemption and diff-range handling from the CHANGELOG gate. Do not block merges in this iteration; leave a clear comment that flipping the warn to `exit 1` promotes it to required later.
> 5. **Document the rule** in `CLAUDE.md` (near the release-notes rule) and `CONTRIBUTING.md`: every player-facing mechanic change updates the matching Codex card + scene in the same PR.
>
> **Verify before finishing:** `node .github/scripts/codex-coverage.js` passes, `npm run build` and `node .github/scripts/smoke-test.js` pass, `node --check` is clean on changed JS, and the learn page renders the new categories with working scenes (spot-check `#hazard-magpieDrone`, `#boon-zipline`). Add a CHANGELOG `## Unreleased` entry only if a player-facing mechanic actually changed (Codex content/CI is exempt). Do not push or open a PR without operator go-ahead.
