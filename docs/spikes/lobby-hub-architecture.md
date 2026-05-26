# Spike: lobby "hub station" architecture (walk-up zones)

Status: **spike complete.** Server vertical slice built + headless-validated on
branch `spike/lobby-hub-architecture` (based on `db85e0f`, ahead of `origin/main`
@ `f21ffc5` / v0.8.2). Client cross-input UI is **designed but not built** (see
§7 — it needs manual multi-input + multi-controller validation a headless harness
can't provide). Not pushed. This doc is the handoff for production implementation.

Backlog stories this enables: `backlog.md` → Lobby → Features: *"AI hub — toggle
bots and surface their count"* and (greenfield) skin selection. Related prior
spike: `docs/spikes/ai-toggle-preview.md` (the `fillGridWithBots` gate this reuses).

---

## TL;DR

- **Lobby stations are server-placed `Circle` zones**, modelled on `LobbyStartButton`
  but with a real **per-player enter/exit signal** instead of a momentary "on it"
  flag. Positions come from a small **code-side registry** (world-relative), optionally
  overridden by an authored `stations[]` array in the lobby map JSON. This is the
  lightest representation that still scales to skin / playlist / difficulty stations.
- **The per-slot signal is the whole trick:** enter/exit edges are emitted to the
  player's **own socket**. In local co-op each local player already has its own
  socket (`addLocalPlayer`), so per-slot routing is free — no slot bookkeeping in
  the event itself.
- **Cross-input UI extends the emoji-wheel ownership model, but goes beyond it:** the
  emoji wheel is a single shared element owned by one slot (`emojiOwnerSlot`).
  Stations need **two panels open at once** (P1 at skin, P2 at AI), so panel state is
  **per-slot** (`lp.stationPanel`), rendered on the canvas near each kart, with input
  routed per-slot through `pollPadForSlot` (controllers), the `menuOpen`/primary path
  (keyboard/mouse), and on-canvas hit-testing (touch).
- **AI station** (room-wide) reuses the already-proven bot gate: a `game.botOverride`
  read by `fillGridWithBots`, set by a new `setLobbyAI` event. **Skin station**
  (per-player) reuses `player.color` from the curated palette, set by a new `setSkin`
  event and synced with a **new `playerSkinChanged` broadcast** (color is not in the
  per-tick `gameUpdates`).
- **Recommended build order:** Phase 1 framework (de-risks the hard cross-input +
  per-slot requirement with a stub panel) → Phase 2 AI station (backlog value, lowest
  risk) → Phase 3 skin station (per-player sync + the colorblind/uniqueness wrinkles).

---

## 1. Existing anchors (verified this spike)

| Concern | Where | Note |
|---|---|---|
| Lobby state + map | `Game.startLobby` (`game.js`), `GameBoard.loadLobbyMap` | clones the only `lobbyOnly` map `_lobbyTutorial.json` (id `lobbyTutorialIslandsV1`), `spawnPad {cx:175,cy:384,r:75}` |
| Interactive object | `LobbyStartButton` (`entities/player.js`), spawned at world center in `GameBoard.startLobby`, pushed in `collectLobbyCollisionObjects` | **server-placed, not in map JSON** |
| Activation today | circle-circle collision → `Player.handleHit` sets `hittingLobbyButton`, consumed/reset in `Game.getPlayerCount` | momentary "on it" only — **no enter/exit edge** |
| Cross-input precedent | emoji wheel: `emojiOwnerSlot` (`game.js`), pad dispatch `pollPadForSlot` (`gamepad.js`), `menuOpen` (`input.js`), per-slot `lp.leaveConfirm` | single-element, single-owner |
| Local players | `localPlayers[]`, one socket per slot via `addLocalPlayer`; `registerSecondaryHandlers` (lifecycle only); render/audio on primary | UI must be per-slot, keyed on slot/player id |
| Skins | greenfield — appearance is just `player.color` (`world.js` → `utils.getUniqueColor`), drawn by `getPlayerSprite(color,…)`. Color ships only in `newPlayerPacket[3]` at spawn; per-tick `updatePlayerList` only carries x/y/vel/angle | a mid-session color change needs a **new broadcast** |
| Bot fill | `fillGridWithBots` (`game.js`) from `startGated`; grid total `botTarget` rolled once/game | no runtime override existed before this spike |
| Colorblind assist | client remaps colors per-client, storing the original in `_serverColor` (seen in `client.js`) | a skin change must update `_serverColor` + re-run the remap |

---

## 2. Station representation (design question 1)

**Options weighed:**

1. **Server-placed coordinates only** (like `LobbyStartButton`). Lightest, but a single
   hard-coded point per station doesn't scale: stations must sit on *safe, reachable*
   terrain specific to each lobby layout.
2. **A new reserved cell tile type.** Rejected — stations are circular walk-up *zones*,
   not tiles; coupling them to the Voronoi cell grid (and to `checkCollideCells`) is
   heavier and less precise than a `Circle` overlap, and tile ids are a scarce,
   gameplay-loaded namespace.
3. **A top-level `stations[]` array in the lobby map JSON** (like `hazards` / `spawnPad`).
   Scales and lets a map author place stations on safe ground, but forces every future
   lobby map to re-author the full station set.

**Recommendation — a hybrid (what the prototype does):** a **code-side registry**
defines *which* stations exist and *how they behave* (that is code, not map data),
positioned **world-relative** by default so the lobby always has stations even on a
plain field; an **optional** `stations[]` array in the lobby map JSON overrides
positions/colors per-map. Stations are then instantiated in `GameBoard.startLobby`
exactly the way bumpers are (`generateHazards`), and serialized to the client once
(static for the lobby's life).

```js
// buildLobbyStations() — code defaults, overridable by map JSON
var defaults = [
  { id: "skin", kind: "skin", cx: W*0.5, cy: H*0.78, color: "#36c" },
  { id: "ai",   kind: "ai",   cx: W*0.5, cy: H*0.22, color: "#3a3" }
];
var src = Array.isArray(currentMap.stations) ? currentMap.stations : defaults;
// new LobbyStation(s.cx, s.cy, s.r||60, s.id, s.kind, s.color)
```

Adding playlist/difficulty stations later = one entry in the registry + one panel
renderer + (for room-wide settings) one socket event. No map edits required.

---

## 3. Enter / exit detection (design question 2)

The start button only needs "currently on it." Stations need **edges**. The prototype
extends the same flag pattern into a once-per-tick diff:

- `Player.handleHit(station)` stamps `this.touchingStation = station.stationId`
  (per-tick; a player can only be inside one).
- After collisions each lobby tick, `GameBoard.updateStationProximity()` diffs
  `touchingStation` (this tick) against `nearStation` (latched):
  - newly inside → emit **`stationEnter`** `{id, kind}` to the player's socket
  - no longer inside → emit **`stationExit`** `{id}` to the player's socket
  - then reset `touchingStation` (re-stamped next tick by `handleHit`).
- **Emitted to the player's OWN socket** via `messenger.messageClientBySig(playerId,…)`.
  Bots are skipped (no socket, no UI). Exit is detected purely by *no longer
  overlapping* — no timers.

Ordering matters: `updateStationProximity()` runs **after** `checkCollisions()` in the
lobby branch of `GameBoard.update`, so `touchingStation` reflects the current tick.

```
handleHit (during checkCollisions)  ──► player.touchingStation = id
updateStationProximity (same tick)  ──► diff vs nearStation ──► emit enter/exit ──► reset
```

---

## 4. Per-slot independence in local co-op (design question 4)

This falls out of §3 almost for free, because **each local player already has its own
socket**:

- `stationEnter`/`stationExit` arrive on the *individual* player's socket. For P1 that
  is the primary socket; for P2+ it is the secondary socket.
- `registerSecondaryHandlers(sock, slot)` gains handlers that set
  `localPlayers[slot].nearStation = payload.id` (enter) / `null` (exit). The primary's
  own handler sets `localPlayers[primarySlot].nearStation`.
- The render loop draws a prompt/panel for **every** slot whose `nearStation` is set,
  and panel state lives **per slot** (`lp.stationPanel`). So P1 can be configuring the
  skin station while P2 configures the AI station while P3 keeps idling/racing.

This is the key departure from the emoji wheel (a single shared element). See §7.

---

## 5. Station scope & data flow (design question 5)

### 5a. AI control — room-wide

- **Setting:** on/off **plus** a bot count. `game.botOverride`:
  - `null` → legacy behaviour (random `botTarget` in `[minGrid,maxGrid]`).
  - `{ enabled:false }` → **0 bots** next race.
  - `{ enabled:true, count:N }` → **exactly N** bots next race (clamped to `maxGrid`).
- **Consumed by `fillGridWithBots`** (generalized this spike): override wins over the
  random roll. This is the same gate the preview spike added as `previewAI`, lifted to
  a first-class room setting.
- **Who may change it:** *any* player, **last-writer-wins**, broadcast `lobbyAIChanged`
  so every open AI panel reflects the live value. (Alternative: soft-lock to the first
  occupant of the AI zone — heavier, and against the lobby's communal "majority on the
  start button" ethos. Recommend last-writer-wins; revisit if griefing shows up.)
- **When it takes effect:** the next `startGated` (next match). The panel shows
  "applies next race." **Persists across games** (it's a room setting; unlike
  `botTarget`, it is *not* reset in `resetGame`).
- **Room listing:** `hostess.getRooms` should surface `+N AI` — read `botOverride`
  (or the live bot count in `playerList`) and add an `aiCount` field, consumed by the
  join page + lobby (closes the rest of the backlog story).
- **Event:** `setLobbyAI { enabled, count }` (lobby-only, clamped). Implemented.

### 5b. Skin change — per-player

- **MVP model = reuse `player.color`** from the curated named palette
  (`utils.getColorPalette()` — the 22 `Colors.names` hexes). No new server field, and
  color already flows through every draw path.
- **Set → sync → reflect:** `setSkin { color }` (lobby-only) validates the color is in
  the palette and **not already held by another player** (uniqueness is what keeps
  karts distinguishable — `getUniqueColor` enforces it at spawn; the picker must too).
  On success: set `player.color`, broadcast **`playerSkinChanged { id, color }`**.
  - The new broadcast is **required**: color is only in the spawn packet
    (`newPlayerPacket[3]`), never in `gameUpdates`, so without it other clients never
    see the change.
  - **Colorblind wrinkle:** the client remaps colors per-client for CVD assist and
    stores the original in `_serverColor`. The `playerSkinChanged` handler must update
    `_serverColor` and re-run the same remap, or the picked color won't display
    correctly for players with assist on.
  - **Palette delivery:** expose `utils.getColorPalette()` to the client (attach to the
    `config` payload) so the picker's swatches and the client-side "is it taken?"
    preview match the server.
- **Persistence:** lives on the `Player` for the session (until disconnect). Surviving
  across matches is automatic since `reset()` doesn't touch a player-chosen color.
- **True kart skins (future):** a separate `skin`/`variant` field (shape/pattern), new
  `getPlayerSprite` variants, added to `newPlayerPacket` + a sync broadcast. Heavier;
  out of scope for the first station.

---

## 6. Concurrency / conflict (design question 6)

| Case | Handling |
|---|---|
| Two players at the **same AI station** | last-writer-wins; `lobbyAIChanged` broadcast keeps both panels in sync (soft-lock alternative noted in §5a) |
| Two players want **the skin station** | per-player setting, no conflict; only the color **uniqueness** check can reject (→ `skinRejected`) |
| Player **leaves the lobby** mid-panel | `dropLocalPlayer` must close that slot's `stationPanel` (mirror the existing `emojiOwnerSlot` close already in `dropLocalPlayer`); primary leaving the tab → navigation handles it |
| **`startGated` fires** with a panel open | client state-change handler force-closes all station panels + clears prompts (like `lobbyStartButton = null` on state change); server `setSkin`/`setLobbyAI` are **lobby-only guarded** (done) so a late event is ignored |
| Panel open vs. **start vote** | a player parked at a station is physically off the start button, so they simply don't count toward the start-majority — no special handling needed |
| Can't **double-own** overlays | per-slot priority: `leaveConfirm` > `stationPanel` > emoji wheel > normal. A slot with a panel open consumes its emoji/`B` buttons as panel controls; opening the leave confirm closes the panel. The emoji wheel stays a single global owner; a slot can't hold the wheel and a panel at once. |

---

## 7. Cross-input UI (design question 3) — DESIGNED, NOT BUILT

The emoji wheel is a single shared DOM element owned by one slot at a time. Stations
must support **multiple simultaneous panels**, so the model is **per-slot panel state +
per-slot input routing**, with panels drawn on the **canvas** (camera-attached near
each kart) so two can coexist without DOM single-owner contention.

**State (per local player):** `lp.stationPanel = { id, kind, cursor } | null`, plus
`lp.nearStation` (set by the enter/exit handlers). Add a `stationPanelOpenCount` only if
needed for cheap "is any panel open" checks.

**Open is explicit, not on proximity:** entering a zone shows a per-slot **prompt**
near the kart ("Ⓐ Customize" / "Press E" / a tap button); the action button opens the
panel. Driving past never hijacks control. Leaving the zone hides the prompt and closes
the panel.

**Per input model:**

- **Controller (per slot, the load-bearing path):** route in `pollPadForSlot`, new
  branch ordered after `leaveConfirm`, before the wheel:
  ```
  if (lp.leaveConfirm)            pollLeaveConfirm(...)
  else if (lp.stationPanel)       pollStationPanel(pad, lp)   // NEW
  else if (iOwnWheel)             pollEmojiWheel(...)
  else if (B pressed)             openLeaveConfirm/Modal
  else if (EMOJI pressed)         openEmojiFromPad
  else if (near station && A)     openStationPanel(lp)         // NEW
  else                            normal play
  ```
  In `pollStationPanel`: left-stick/d-pad move `cursor`, `A` confirm (emit on
  `lp.socket`), `B`/EMOJI close. Already per-slot because `pollPadForSlot` runs per pad.
- **Keyboard (primary only):** when the primary is `nearStation` and no wheel/modal is
  up, `E`/`Enter` opens; arrows / `A`-`D` move the cursor; `Enter`/`E` confirm; `Esc`
  closes. Only the primary uses the keyboard, so there is only ever one kb panel.
- **Mouse (primary only):** click the on-canvas prompt to open; click a swatch/option;
  click confirm / the `✕`. Reuse the `primaryOwnsWheel()` guard idiom so a pad player's
  open panel never suppresses the mouse.
- **Touch (primary only):** entering shows a tap "Customize" button; the panel's options
  are large on-canvas hit-test targets (like `virtualButtonList` in `input.js`); tap to
  select, tap confirm / `✕`. Local co-op is controllers, so touch stays primary-only —
  no per-slot touch contention.

**Glyph hints:** reuse the existing per-slot glyph-bar/blocks system in `gamepad.js`
(the prompt shows the slot's button glyph).

**Why canvas over per-slot DOM panels:** canvas keeps "two panels at once" trivial
(just two draw calls keyed on slot) and matches the game's rendering; cloning DOM
panels per slot is more plumbing and z-index/focus management. Trade-off: DOM is
friendlier for screen readers and crisp text — if that matters later, the **primary**
slot's panel could be DOM (kb/m/touch) while pad slots stay canvas. Recommend
all-canvas for the first cut to keep one code path.

---

## 8. What the prototype actually builds (server slice) + how to validate

**Goal of the slice:** de-risk the *novel server surface* — the new station object,
the per-socket enter/exit signal, the per-player color re-sync, and the bot override —
with something runnable and asserted. The client UI is intentionally left as §7 design
because its validation (three input models × two controllers) is manual.

**Files touched (all behind the existing lobby; default behaviour unchanged):**

- `server/entities/player.js` — `LobbyStation` class; `Player.touchingStation` /
  `nearStation` fields; `isStation` branch in `handleHit`; export.
- `server/game.js` — `Game.botOverride`; `fillGridWithBots` honors it;
  `GameBoard.buildLobbyStations` / `updateStationProximity` / `emitStationEdge`;
  stations spawned in `startLobby`, pushed in `collectLobbyCollisionObjects`, diffed in
  the lobby branch of `update`; `lobbyStations` emit.
- `server/compressor.js` — `sendLobbyStations` serializer (`[id,kind,x,y,r,color]`).
- `server/utils.js` — `getColorPalette()`.
- `server/messenger.js` — `setSkin` and `setLobbyAI` handlers (lobby-only, validated).

**No `gameUpdates`/decoder change** — stations are sent once on `startLobby`; skin
changes ride their own `playerSkinChanged` broadcast.

**Validation — `node docs/spikes/lobby-hub-spike-test.js` (21 assertions, all pass):**
boots the real modules via the actual messenger handlers, drives a room into the lobby,
and asserts: stations spawn + join the collision set; `stationEnter`/`stationExit` fire
**once** on the player's own socket on entering/leaving (and don't repeat while inside);
`nearStation` latches/clears; `setSkin` applies + broadcasts + rejects off-palette and
taken colors; `setLobbyAI` → `botOverride` → `fillGridWithBots` yields 0 bots when
disabled and exactly N when `count:N`. The canonical `node .github/scripts/smoke-test.js`
still passes (full stack + 50 maps), confirming no lobby/race regression.

**Not built (Phase 1+ work):** the client — station rendering, the per-slot prompt +
panel, input routing for all three models, the `stationEnter`/`stationExit` handlers in
`registerPrimaryHandlers`/`registerSecondaryHandlers`, the `playerSkinChanged`/
`lobbyAIChanged`/`skinRejected` handlers, the colorblind `_serverColor` update, palette
delivery via `config`, the `gameState` mid-join rehydration of stations, and the
`startGated` force-close. Also not wired: `hostess.getRooms` `+N AI`.

---

## 9. Open questions / risks

1. **Station placement vs. lobby terrain.** Code defaults are world-relative and may
   land on lava/an island edge in `_lobbyTutorial.json`. Before shipping, either author
   a `stations[]` array in that map on safe ground, or have `buildLobbyStations` snap to
   the nearest safe (`background`/`normal`) cell. (Cosmetic for the headless test; real
   for play.)
2. **Mid-join rehydration.** A player who joins mid-lobby gets `startLobby` data only if
   it's re-sent, or via `gameState`. The prototype emits `lobbyStations` on `startLobby`;
   add stations to `compressor.gameState` (lobby branch) so a late joiner sees them too.
3. **Standing in a zone across `startLobby` re-runs** (the lobby map idle-reset cadence).
   `nearStation` should be cleared when stations are rebuilt, or the next diff may emit a
   spurious exit. Cheap: reset `nearStation` for all players in `buildLobbyStations`.
4. **AI count UX.** Is `count` the number of bots or the grid total (humans+bots)? The
   prototype treats it as **bot count** (matches "+N AI"). Confirm with design before the
   panel copy is written.
5. **Skin uniqueness when the palette is exhausted.** 22 colors; `maxPlayersInRoom` is
   25. The picker should grey out taken colors and handle "all taken" gracefully (the
   server already falls back to generated hsl colors at spawn, but the *picker* only
   offers the named palette).
6. **Touch + local co-op.** Co-op is controller-only today; if touch co-op ever lands,
   the primary-only touch panel assumption (§7) needs revisiting.
7. **Griefing the AI dial.** Last-writer-wins means one player can flip everyone's AI
   setting repeatedly. Acceptable for a co-located lobby; reconsider a lock/vote if
   public lobbies become a thing.

---

## 10. Recommended phasing

- **Phase 1 — Station framework (build first; de-risks the hard requirement).**
  `LobbyStation` + registry + enter/exit signal (server done) **+ the client per-slot
  prompt + a STUB panel** that opens, takes one input, and closes on keyboard, mouse,
  touch, and per-controller (incl. a 2nd pad). Manually validate the cross-input +
  per-slot matrix here with throwaway content, before either real station. This is the
  riskiest surface and the spike's hard requirement.
- **Phase 2 — AI station (lowest risk, clear backlog value).** Wire the `setLobbyAI`
  panel content + `lobbyAIChanged` handling + `hostess.getRooms` `+N AI`. Reuses the
  proven `botOverride` gate; no new sync-broadcast or colorblind complications.
- **Phase 3 — Skin station (per-player, the remaining wrinkles).** Wire the `setSkin`
  panel (palette swatches, taken-color greying), `playerSkinChanged` + `_serverColor`
  re-remap, palette delivery via `config`. Proves the per-player sync path end-to-end.

Rationale for AI-before-skin: Phase 1 already proves per-slot cross-input (the hard
part) with a stub, so the 2/3 ordering is about value + risk. AI is a named backlog
story, lower risk, and has no broadcast/colorblind/uniqueness edges; skin is greenfield
with all three.

**Production gate:** the first station to merge touches `game.js`/`config.json`, so it
**must** add a player-facing `## Unreleased` bullet in `CHANGELOG.md` (the spike branch
deliberately omits it — nothing here ships). See `CLAUDE.md` → "Release notes."
