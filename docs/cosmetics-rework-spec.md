# Cosmetics rework — spec for the next agent

**Status:** spec only. The progression-system branch currently ships a SINGLE-slot
cart-skin model; the operator wants a THREE-slot composable cosmetic model. Do NOT
ship the current single-slot skin set as-is — rework it per this spec first (or ship
the XP/level/achievement *system* without the new cosmetics and land cosmetics here).

Branch: `worktree-progression-system`
(`/Users/sdodge/Documents/Projects/chaochao/.claude/worktrees/progression-system`).

---

## The goal (operator's words, refined)

Three INDEPENDENT, simultaneously-equippable cosmetic slots, **all compatible with the
player's chosen color**:

1. **Cart (shape)** — the kart body silhouette. Current shapes: Drone, Dino, Truck.
   Tints to the player's color (already does).
2. **Pattern** — a texture painted ON the cart body. Current: Sunset, Bubblegum,
   Checkered. **MUST be reworked to tint to the player's color** (see §Pattern×color).
3. **Trail** — the motion trail. **Color is ALWAYS the player's color**; what varies
   between unlockable trails is the **effect/shape** (sparkles, dashes, glow, width,
   particles…), NOT the color.

A player can wear e.g. **Dino + Checkered + Sparkle-trail + Blue** all at once. Today
they can't: cart and pattern share one slot, and patterns ignore color.

---

## Decisions LOCKED by the operator (do not re-litigate)

- **Unlock cadence: cycle every 2 levels**, rotating pattern → trail → cart:
  - Lv2 = pattern, Lv4 = trail, Lv6 = cart, Lv8 = pattern, Lv10 = trail, Lv12 = cart, …
  - Keep going as far as there are items; when a category runs out of new items at its
    slot, skip to the next category's item (don't gate a level on a non-existent item).
    Propose the exact level→item table to the operator for approval before building.
- **Pattern × color = pattern TINTS to color.** The chosen color is the base; the
  pattern is the texture/overlay drawn in that color family. E.g. Checkered = player
  color + black squares; Bubblegum = player color + white dots; gradient patterns ramp
  within the player's hue. NO fixed-scheme patterns — every pattern must honor color.
  (This is a CHANGE: current Sunset/Bubblegum/Checkered painters ignore `paint`.)
- **Trail = always player color; effect/shape varies.** Build trail variants that
  differ by visual effect (e.g. solid, dashed, sparkle, glow, wide-comet), each
  rendered in `player.color`.
- **Achievement thresholds: scaled per-achievement (NOT flat).** Raise them a lot from
  today's 10–25. Propose a per-achievement table (operator example: rarer ones ~50,
  commoner ones ~100) for approval. Current values to raise: Executioner mostKills 10,
  Guardian savior 10, Survivor survivalist 15, Warlord brutalist 10, Golden Champion
  wins 25, Punching Bag mostMurdered 10.

---

## Current state to build FROM (verified facts)

- **One equip field today:** `player.cartSkin` (server) — `setCartSkin` REPLACES it
  (`server/messenger.js` ~line 513). Sent per-tick as `compressor.js` `packet[13]`,
  decoded in `client/scripts/gameboard.js:251`. The new model needs THREE values on the
  wire (shape, pattern, trail) — extend the packet + decoder IN LOCKSTEP (see CLAUDE.md
  networking contract). Consider packet[13]=shape, [14]=pattern, [15]=trail (or a small
  sub-array) — renumber carefully and update both sides.
- **Color is NOT a progression item.** `player.color` is a per-match pick from a shared
  palette via `setSkin` (`server/messenger.js`), uniqueness-enforced per room, and is
  NOT persisted to Supabase. Cosmetics must COMPOSE with whatever color the player picks
  each match. Do not try to "unlock" colors via levels.
- **Render composition (`client/scripts/draw.js`):**
  - Base colored sprite: `getPlayerSprite(player.color, …)` (~line 2374).
  - Cart-skin overlay: `getSkinPainter(player.cartSkin)` → `drawCartSkin(...)` (~line
    2451). The painter receives `(ctx, anim, paint)` where `paint = player.color`.
  - **Trail:** `drawTrail(player)` (~line 3127) — TODAY it overrides the trail color
    from the equipped skin (`getSkinTrailColor`). CHANGE: trail color = `player.color`
    always; select the effect/shape from the equipped trail id instead.
  - Shape painters honor `paint` (Drone/Dino/Truck); pattern painters currently ignore
    it (drawSunsetSkin/drawBubblegumSkin/drawCheckeredSkin) — rewrite them to paint in
    `paint`.
- **Registries (keep client/server in lockstep):**
  - `client/scripts/skinRegistry.js` — painters + metadata. Add a `slot` field
    ('cart' | 'pattern' | 'trail') and split into three registries or one with `slot`.
  - `server/skinRegistry.js` — id + unlock only (validation). Mirror the slots.
  - Server `setCartSkin` validates unlock by level/achievement and REPLACES within a
    slot — generalize to per-slot equips (e.g. `setCosmetic({slot, id})`), each
    validated independently; equipping a pattern must not clear the cart, etc.
- **Schema (`supabase/migrations/`):** `progression.selected_skin` is a SINGLE nullable
  `text` column (`0003_progression.sql`). **DECIDED (operator): three EXPLICIT columns**
  — `selected_cart`, `selected_pattern`, `selected_trail` (all nullable text), NOT a
  jsonb blob. New migration (next free number — note migration DRIFT below). Keep the
  legacy `selected_skin` column for now (don't drop) unless the operator approves a
  rename/migration of existing values. `unlocked_skins text[]` already holds achievement
  unlocks; level cosmetics stay level-gated (not stored).
  **Apply to DEV via the `supabase` MCP (write); give the operator the prod one-liner
  (prod is read-only via `supabase-prod`).** See `docs/supabase-dev-mirror-handoff.md`.

## MIGRATION DRIFT (must fix as part of this)

Dev's applied migrations: `0001_map_times`, `0002_upsert_map_time_if_better`,
`0003_progression`, `0003_progression_mirror_prod`, `0004_progression_revoke_client_writes`,
`0005_progression_pending_toasts`. The REPO only has `0001`, `0002`, `0003_progression`,
`0005_progression_pending_toasts` — the two middle ones were applied via MCP but never
written back. Pull them down from dev (read their SQL via the MCP) and commit so a clean
`db push` reproduces dev. Then add the new cosmetics migration after `0005`.

---

## Lobby UI (`client/scripts/lobbyHub.js`)

The skin station currently has a color grid + a "Karts"/"Patterns" two-group cart row.
Rework to FOUR sections: **Color** (existing), **Carts**, **Patterns**, **Trails** —
each its own labeled group of square cells with lock badges (`🔒 Lv N` / achievement
progress). Each slot is independently selectable (equipping in one doesn't clear the
others). Persist each slot's pick to localStorage for instant re-equip; server
re-validates every equip. Keyboard/gamepad cursor nav must traverse all four groups.

## Notifications

Lobby-arrival toast system already exists (`progressionToasts`, sequenced, drains on
lobby return). Extend the toast copy for the new item types: "New pattern unlocked: X",
"New trail unlocked: X", "New cart unlocked: X". The level→item map drives which toast.

---

## Design the first ~30 levels WITH the operator (do this FIRST, before coding)

The operator wants to collaboratively design the unlock ladder for **the first ~30
levels** and have **the actual assets in place to that depth** — not a formula with
placeholder art. Sequence:

1. **Co-design the ladder.** Propose a level→item table for Lv2–30 following the
   every-2-levels pattern→trail→cart cycle, and iterate WITH the operator until approved.
   ~15 unlocks across Lv2–30 (one per even level). Decide how many distinct carts /
   patterns / trails that implies (~5 each) and name/theme each. Also propose the scaled
   achievement-threshold table in the same pass.
2. **Then produce real assets to Lv30 depth** — every cart/pattern/trail in the approved
   ladder must have a working renderer before this ships. No placeholder-art slots in the
   shipping range (the operator explicitly rejected shipping placeholder art earlier).

### Asset-design session workflow (operator's required process)

Once design is underway, the agent provides the operator with **kickoff prompts to start
separate ASSET-DESIGN SESSIONS** (one per batch of assets, e.g. "the 5 trails", "the 5
patterns"). In each asset-design session:

- Build **standalone prototype HTML files** that render the asset(s) on a `<canvas>`
  in isolation — NOT wired into the game. One file per asset batch (e.g.
  `docs/asset-prototypes/trails.html`). Each prototype should: render every variant in
  the batch side-by-side, animate them, let the operator tweak (color swatches, a few
  params) live, so iteration is fast without a game build/deploy.
- Iterate in the prototype until the operator approves the look.
- ONLY THEN port the approved painter into the real registry (`skinRegistry.js` painters
  matching the `drawXxxSkin(ctx, anim, paint)` contract) + wire the slot.

This keeps asset iteration decoupled from integration. The main agent's job is the
SYSTEM (slots, cadence, schema, UI, network); the asset-design sessions produce the
APPROVED ART via prototypes, then it gets ported in.

## What's already DONE on this branch (don't redo)

- XP at gameOver (participation 50 / per-notch 15 / win 100 / runner-up 40), winner +
  runner-up both reachable (P1 + Codex#1 fixes). Level curve `round(50·n^1.6)` in
  `server/progression.js`. Achievement counters + `achievementsUnlocked`. All
  server-authoritative, behind `ALLOW_SUPABASE_WRITES`.
- Lobby Lv/XP badge, lobby-arrival sequenced toasts (incl. same-room return, Codex#2).
- `progression.pending_toasts` column live on dev + prod.
- Headless `.github/scripts/progression-test.js` (~30 assertions) + smoke + build green.

The XP/level/achievement-COUNTER system is solid and can ship independently. It's the
COSMETIC model (slots + cadence + pattern/trail/color compatibility) that this spec
reworks.

---

## Acceptance / done criteria for the next agent

1. Three independent equip slots (cart/pattern/trail) persisted + sent on the wire in
   lockstep (compressor + decoder); equipping one never clears another.
2. Patterns tint to `player.color`; trails render in `player.color` with varying
   effect/shape; carts still tint to color. A Dino+Checkered+sparkle-trail+blue kart
   renders correctly together.
3. Unlock cadence: pattern@2, trail@4, cart@6, repeating every 2 levels — operator-
   approved level→item table.
4. Achievement thresholds raised per the operator-approved scaled table.
5. Lobby UI: Color/Carts/Patterns/Trails groups, per-slot lock+equip, pad-navigable.
6. Toasts cover all three new item types.
7. Schema migration applied to dev via MCP + prod one-liner handed to operator; repo
   migration drift resolved.
8. Headless tests extended (per-slot equip validation, cadence unlock mapping, threshold
   crossings); smoke + build green. Update the CHANGELOG `## Unreleased` entry to match
   final scope (the current entry predates this rework — it still says ~10 skins).

## Operator-injectable kickoff prompt

> Read `docs/cosmetics-rework-spec.md` on the worktree-progression-system branch
> (`/Users/sdodge/Documents/Projects/chaochao/.claude/worktrees/progression-system`) and
> drive the cosmetics rework. **Start in DESIGN mode, not coding:** work WITH me to design
> the unlock ladder for the first ~30 levels — propose a level→item table following the
> every-2-levels cycle (pattern@2, trail@4, cart@6, …), iterate until I approve, and in
> the same pass propose the scaled per-achievement threshold table. That ladder implies
> ~5 carts / ~5 patterns / ~5 trails to Lv30 — we need REAL assets for all of them (no
> placeholder art in the shipping range).
>
> Then give me **kickoff prompts to run separate ASSET-DESIGN SESSIONS** (one per asset
> batch). In each of those sessions I want a **standalone prototype HTML file** (e.g.
> `docs/asset-prototypes/trails.html`) that renders the batch's variants on a canvas in
> isolation — animated, with live color/param tweaks — so we iterate fast without a game
> build. Only port approved painters into the real registry afterward.
>
> Build the SYSTEM around the approved design: three independent equip slots
> (cart+pattern+trail) — **explicit schema columns `selected_cart`/`selected_pattern`/
> `selected_trail`** (not jsonb) — all compatible with the player's color (patterns tint
> to color; trails render in the player's color with varying effect/shape; carts tint as
> today). Extend the compressor packet + client decoder in lockstep for the 3 slots.
> Four-group lobby picker (Color/Carts/Patterns/Trails), per-slot lock+equip, pad-
> navigable. Apply the schema migration to dev via the `supabase` MCP and hand me the
> prod one-liner (prod MCP is read-only). Fix the migration drift (pull dev's two
> MCP-only migrations into the repo). Keep everything server-authoritative behind
> ALLOW_SUPABASE_WRITES. Update the CHANGELOG `## Unreleased` entry to match final scope.
> Don't push or open a PR without asking.
