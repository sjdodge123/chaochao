# Port BORDERS into the game — integration spec for a fresh agent

The border ART is already approved (18 painters). This is a PORT/INTEGRATION task in the
live cosmetics code on the **worktree-progression-system** branch
(`/Users/sdodge/Documents/Projects/chaochao/.claude/worktrees/progression-system`). It is
**tightly coupled** to the existing cosmetics architecture — follow this contract exactly,
don't redesign. There are uncommitted changes in the worktree; build on them, don't reset.

## Source of truth
- `docs/asset-prototypes/borders.painters.js` — 18 `drawXxxBorder(ctx, anim, paint)` painters
  (port-ready, perf-audited; NO P-shim, NO extra helpers, defaults already baked).
- `docs/asset-prototypes/borders.HANDOFF.md` — the 18 ids + display names + suggested rarities.

## The model (operator-decided): borders SHARE the pattern slot
There is NO 4th slot/column. Borders ride the existing **2nd cosmetic slot** — the
`player.pattern` field and the `selected_pattern` DB column — distinguished only by their
registry `slot: 'border'`. Rules:
- The 2nd slot holds **either** a pattern id **or** a border id (equipping one overwrites the other).
- A **border renders over ANY cart** (shaped or the plain sphere).
- A **pattern renders only on the plain/default cart** (already the case — sphere-only).
- Disambiguate at render time with `getSkin(id).slot` ('pattern' vs 'border').

## ID collision (must handle)
Border ids `flames`, `scales`, `electric` also exist as PATTERN ids. The registry is a flat
id→entry map, so **store border ids with a `border_` prefix** (e.g. `border_flames`). The
painter fn names (`drawFlamesBorder` vs `drawFlamesPattern`) already differ. Display names
stay clean ("Flames").

## Steps

### 1. Painters → `client/scripts/draw.js`
Port all 18 `drawXxxBorder(ctx, anim, paint)` near the pattern painters. They use
`cartSkinShade` / `cartSkinShadeA` (both already in draw.js). Borders draw AROUND the rim
(r ≈ 1.0–1.4), never fill the interior.

### 2. `drawBorderOverlay` → `client/scripts/draw.js`
Add next to `drawPatternOverlay`:
```js
function drawBorderOverlay(player, centerX, centerY, radius, painter) {
    var ctx = gameContext;
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.scale(radius, radius);                 // NO clip (border draws outside the rim),
    painter(ctx, cartSkinAnimTime, (player && player.color) ? player.color : null); // NO heading rotate
    ctx.restore();
}
```

### 3. Render coverage — branch the 2nd-slot render in ALL FOUR kart paths
Today each path renders the 2nd slot as: `getSkinPainter(player.pattern)` → `drawPatternOverlay`,
gated on "no cart equipped". Replace that with a slot-aware branch in **each** of:
- `drawKartAppearance` (draw.js — the chokepoint; covers overview scoreboard + ice reflection)
- `drawPlayer` (draw.js — live racing/lobby, inline, in the `!hasCartSkin` block)
- `drawPlayerIcon` (draw.js — overview standings disc)
- `recapDrawCar` (recap.js — game-over recap; uses `p.pattern`)

Branch logic (apply at each site, using that site's centre coords / radius):
```js
var pid = player.pattern;                      // the shared 2nd slot id
var pskin = (typeof getSkin === "function" && pid) ? getSkin(pid) : null;
if (pskin && pskin.slot === 'border') {
    var bp = getSkinPainter(pid);
    if (bp) { drawBorderOverlay(player, cx, cy, radius, bp); }   // ANY cart
} else if (pid) {                               // a pattern → sphere-only (keep the existing
    // ...existing drawPatternOverlay call, still gated on "no cart equipped"...
}
```
NOTE the recap path uses `p` (the synthetic recap player) and `p.pattern`; it's already captured
into `recapMeta`. Borders ride the same `p.pattern`, so no new recap capture is needed.

### 4. Registry — CLIENT `client/scripts/skinRegistry.js`
- Add 18 entries: `{ id: 'border_<id>', name: '<Display>', slot: 'border', rarity: '<from HANDOFF>', unlock: { kind: 'open' }, painter: drawXxxBorder }`.
- Add `'border'` to `COSMETIC_SLOTS`.
- Add `COSMETIC_SLOT_FIELD.border = 'pattern'` (borders use the pattern field — shared slot).
- `getSkinsForSlot('border')` already works (filters by slot, excludes 'pool'). The lobby's
  Borders tab auto-appears once these exist (`skinTabs` checks `getSkinsForSlot('border').length`).

### 5. Registry — SERVER `server/skinRegistry.js`
- Add 18: `{ id: 'border_<id>', slot: 'border', unlock: { kind: 'open' } }`.
- Add `'border'` to the `SLOTS` array.

### 6. Server equip + persist
- `server/messenger.js`: add `COSMETIC_SLOT_FIELD.border = 'pattern'` (so `setCosmetic({slot:'border',id})`
  writes `player.pattern`). `setCosmetic` already validates slot↔id and accepts `kind:'open'`.
- `server/auth.js`: add `COSMETIC_SLOT_COLUMN.border = 'selected_pattern'` (so a border persists
  to the shared column). `getProgression` already selects `selected_pattern`.
- **Restore (subtle — get this right):** `restorePersistedCosmetics` (messenger.js) iterates
  `skinRegistry.SLOTS` and for each reads `prog['selected_'+slot]`. There is NO `selected_border`
  column, so the 'border' iteration reads `undefined` and is skipped — fine. BUT the shared value
  lives in `selected_pattern`, restored by the 'pattern' iteration, whose `cosmeticUnlocked(prog,
  'pattern', id)` rejects a value whose real slot is 'border' → a persisted BORDER would fail to
  restore. FIX: in the 2nd-slot restore, validate the id by ITS OWN registry slot (cart/pattern/
  trail/border) and write to the mapped field, rather than forcing slot==='pattern'. (Equivalently:
  special-case the pattern restore to accept a border id and set `player.pattern`.) Verify a
  persisted border re-applies on rejoin (writes-on test, behind ALLOW_SUPABASE_WRITES).

### 7. Picker preview — `client/scripts/lobbyHub.js`
`drawCosmeticPreview(opt, cx, cy, r, paint, locked)` needs a `slot === 'border'` branch: draw a
ring/arc in `paint` (a representative border thumbnail). The Borders tab + per-slot equip +
`currentCosmetic(lp,'border')` (reads `player.pattern`) already work via `COSMETIC_SLOT_FIELD.border`.
The shared "None" default appears on both the Patterns and Borders tabs and clears the slot.

### 8. Ladder / unlock
All 18 borders are `kind:'open'` (unlock-all-for-testing, like the other new cosmetics); the
operator slots them onto the ladder later. Do NOT gate them by level/achievement yet.

### 9. CHANGELOG
Add a player-facing `## Unreleased` bullet listing the new Borders cosmetic.

## Verify before declaring done
- `npm run build` + `node .github/scripts/smoke-test.js` + `node .github/scripts/progression-test.js`
  all green.
- In-browser (`UNLOCK_ALL_COSMETICS=true PORT=<free> node index.js`): equip a border → it rings
  the kart over a SHAPED cart AND the plain sphere; equip a pattern on the plain cart → shows;
  switch to a shaped cart → Patterns tab hides, the border still shows; check the overview
  scoreboard + game-over recap show the border too.
- Do NOT commit/push or open a PR. Leave the worktree dirty for the main session to resume + re-verify.
