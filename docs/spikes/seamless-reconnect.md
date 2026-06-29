# Spike: Seamless Reconnect / Reboot Survival

**Status:** Investigation + design complete; implementation NOT started (awaiting scope sign-off before Phase 2+).
**Branch:** `spike/seamless-reconnect` (off `origin/main` @ `b23cb32`).
**Scope target:** **Target 2** — re-seat returning humans into their room with **standings preserved** at a lobby/between-rounds boundary; bots refill fresh; racing resumes next round. **Exact mid-race position/velocity restore (Target 1) is explicitly OUT of scope** (see below).

> All file:line anchors below were verified against `origin/main` by a 5-way parallel code investigation (identity, maintenance/store, routing, standings, UX). They will drift — re-pin before editing.

---

## 1. TL;DR / recommendation

Today a server restart (Heroku deploy/dyno cycle) **wipes every room** — all per-room state is in-memory in `hostess.roomList` and nothing is persisted. After the existing maintenance reload, players fall into plain matchmaking and lose their match/standings/cosmetics, and can re-seat as a guest.

**The pragmatic, shippable win is Target 2:** when a restart is imminent, snapshot each room's **roster + standings** (notches, team, name, cosmetics, keyed by `deviceId`/`userId`) to **Supabase** (the only cross-process store that survives a dyno cutover), restore those rooms on boot, and re-seat returning players into their saved seat. Racing resumes from the next round; bots refill fresh.

**Drop Target 1 (exact position restore):** it would require serializing every `Player`/`Projectile`/`Hazard`/aimer + all `GameBoard` tile mutations + every `Game` timer + re-seeding `aiController`, and the multi-second reboot gap makes a frozen-then-teleport restore jarring regardless. High effort, low payoff.

**Ship the sit-tight warning with Phase 1** (it owns the reload/route UX), but sequence the *truthful* "Reconnecting you…" copy with Phase 2 (which actually re-seats the player) — the promise is only honest once re-seating works.

**Recommended sequencing:** Phase 0 (identity) and Phase 1 (routing + warning) are independently useful and lower-risk; Phase 2 (the snapshot/restore) is the load-bearing, higher-risk core; Phase 3 is polish. Each phase is its own branch/PR with its own investigate→implement→adversarially-verify cycle.

---

## 2. Why nothing survives today (confirmed)

- All per-room state lives in `hostess.roomList` / per-room `playerList` — **in-memory, process-local, wiped on restart**. `server/hostess.js:92` `countActiveRaces()` shows the traversal; nothing snapshots it.
- Supabase persists only **per-user progression** (`server/auth.js`) and **per-map best times** (`server/leaderboard.js`). **No room / standings / roster / position is persisted anywhere.**
- The single client blocker after a maintenance reload: matchmade players fall into `clientSendStart(-1)` → `findARoom` (`client/scripts/game.js:491`; `server/hostess.js:104`) instead of back to their room — and there's no room to return to.
- **Two enabling assets already exist:**
  - **Stable identity:** `socket.deviceId` (sanitized `index.js:674`, stamped `index.js:694`, carried to `player.deviceId` `messenger.js:606`) and, for signed-in users, `player.verifiedUserId` (`messenger.js:603`).
  - **A graceful window:** the 28s SIGTERM window (`index.js:765-772`) + the maintenance drain gate (`server/maintenance.js:43` `isRaceBlocked`) that already blocks **new** races.

---

## 3. Architecture findings (verified, per subsystem)

### 3a. Identity is socket.id, in three roles, across five maps (Phase 0 blast radius)

`socket.id` (aka `client.id`, called "sig" in comments) is used **simultaneously as**:
1. **hash-map key** — `mailBoxList`, `identityList`, `roomMailList` (`messenger.js:208,222`) + per-room `clientList`, `playerList` (`game.js:39`);
2. **the entity's own `player.id`** (`player.js:60`, set via `world.createNewPlayer(id)` `world.js:22`);
3. **the `ownerId`** on every owned entity — projectiles, `aimerList`, `abilityList`, `tempSpectatorList`, `Punch`, and event payloads (`gameBoard.js:2817` `removeOwnedEntities`, `:444`).

Critical constraints:
- **`player.id` is the WIRE identity.** `compressor.js:197` (`newPlayerPacket[0]=player.id`) and `:17` (per-tick rows) broadcast it every tick; the client decoder indexes remote karts by it, and one-shot emits (`myID`, `appendPlayer`, `playerLeft`, `playerCosmeticChanged`, emoji `ownerId`, …) all carry `{id: client.id}`. **Changing the broadcast id requires lockstep `client.js` decoder edits** (the compressor contract).
- **Stable handles already plumbed, just never used as a key:** `socket.deviceId` / `socket.userId` → `identityList` → `player.deviceId` / `player.verifiedUserId`.
- **Reverse-lookup precedent exists:** `messenger.liveClientIdForUser(userId)` (`messenger.js:1263`) scans `identityList`; the toast subsystem already tolerates socket churn across reconnect (the one place that does *not* assume `socket.id` is permanent).
- **Disconnect is destructive + immediate** (`index.js:745`: `kickFromRoom` + `removeMailBox`) — no tombstone, no grace. There is **no detached-player holding area**.
- **No deviceId/userId → room index.** `searchForRoom` (`hostess.js:297`) is an O(rooms×clients) linear scan keyed solely on `socket.id`.

**Design implication:** the lowest-risk Phase 0 keeps `player.id` (and thus the wire) **as the socket.id**, and adds a *parallel* `deviceId/userId → {roomSig, seat snapshot}` association used **only** by the reconnect/snapshot layer — rather than re-keying the five maps (which would ripple into the compressor/client contract). Re-keying the maps is a much larger, wire-touching change and is **not** required for Target 2.

### 3b. Supabase is the only viable cross-process store (Phase 2)

- **Two windows:** SIGTERM `restart` = **28s** deadline (`index.js:771`), `expiresAt = deadline + 2min` grace; `/ops/drain` = default **180s** (0–900), `expiresAt = deadline + 15min` grace (`maintenance.js:16,21`).
- **The 28s budget races `process.exit`:** `setTimeout(process.exit(0), 28000)` (`index.js:772`) hard-kills at 28s (2s inside Heroku's 30s SIGKILL). Any snapshot write must complete inside that window.
- **`clientCount===0` → immediate `exit(0)`** with no announcement/grace (`index.js:766`). A snapshot only ever has a window when clients are connected.
- **Supabase is the ONLY cross-process persistent store.** No Redis (zero deps), and **the filesystem is useless** — the only server FS write is the dev-only perf-harness log (`index.js:629`), and Heroku dyno filesystems are **ephemeral and per-dyno**: a file the dying dyno writes is on a *different* filesystem from the new dyno and dies at cutover.
- **The new dyno boots in parallel** (`index.js:758-763` comment) — it's already accepting reconnects during the 28s window. So the snapshot **must** be in the shared external store, and the row needs a **deadline/version marker** (mirror `maintenance.expiresAt` TTL) so the new dyno reads fresh, not stale.
- **Writes can be silently blocked even when Supabase is reachable:** `resolveWritesEnabled` (`auth.js:80`) blocks writes when a non-Heroku host targets the prod ref. A snapshot path must check `auth.writesEnabled`, not just `auth.enabled`, and **degrade gracefully to "no reconnect"** when Supabase is absent.

### 3c. Routing: the matchmaking-vs-direct-join asymmetry (Phase 1)

- Flow: `game.js enterLobby()` picks a sentinel/sig from the URL → `client.js clientSendStart(id)` emits `enterGame` → `messenger.js` resolves `roomSig` → `hostess.joinARoom` → server emits `gameState` which sets client-side `gameID` (`client.js:1148`).
- **Sentinels:** `-1` = matchmake (`findARoom`, **excludes locked rooms** `hostess.js:115`); `-2` = always fresh (`startNewRoom`); any other value = **literal sig** passed straight to `joinARoom`.
- **THE asymmetry:** a **direct-sig join lands in a started/LOCKED room** as a late-join spectator (`joinARoom` enforces only capacity, not lock — `hostess.js:189-198`), but **matchmaking skips locked rooms**. → **Reconnect must use the literal stored sig**, not `-1`.
- **But the literal-sig path bypasses `findARoom`'s `isPreview/isTarpit/discordInstanceId` exclusions** — only `joinARoom`'s tarpit-without-flag + preview-full guards apply. A recycled sig could route a reconnecting web player into a preview/tarpit/Discord room.
- **`generateRoomSig` is 0–999** (`hostess.js:307`), recurses on collision — only 1000 sigs, recycled. **Rooms are deleted when the last client leaves** → a solo-disconnecter has no room to return to (sig gone → `roomNotFound`).
- **The stash template already exists:** the editor writes `sessionStorage('previewMap')` before navigating (`create.js:5354`) and `enterLobby()` reads+injects it before `enterGame` (`game.js:461`). `?new=1` self-strips via `history.replaceState` (`game.js:486-490`) — the **consume-once** precedent.
- **The authoritative sig to stash is the `gameID` from `gameState`** (`client.js:1148`), not the requested sig, and it must be re-validated server-side (the room may have changed/recycled).

### 3d. Standings/roster + reset seams (Phase 2 snapshot shape, Phase 3)

- **Standings = `player.notches`** (per-match round-win count, `player.js:103`) + **`game.notchesToWin`** (target, `game.js:185`).
- **`round` and `gameModeId` live on `gameBoard`**, not `Game` (`gameBoard.js:71,119`). `gameModeId` and `botOverride` **persist across games**; `round`, `teamId`, `notches` are per-match.
- **No native `slot` field.** `playerList` is an unordered id-keyed object; closest ordinal is `gateIndex` (`player.js:90`). A snapshot "slot" is **synthetic** (derive from `gateIndex`/spawn order).
- **Reset-seam ordering matters:** `notches` is zeroed in `player.update` **only at `gameOver`** (`player.js:2345`), a *different* seam than `Game.resetGame` (`game.js:1745`, the match-boundary cleanup: `notchesToWin→base`, `resetTeams`, `removeBots`). **Snapshot BEFORE these fire.**
- **Cosmetics:** **DB-authoritative for signed-in** players via `restorePersistedCosmetics` (`messenger.js:173`, **async** after the progression row loads); **guests have NO server persistence** (client re-equips from localStorage). → The snapshot **must carry raw `cart/pattern/trailFx/border/color/name` for guests** or their look is lost.
- **`color` is room-unique** (`world.js:23` `getUniqueColorR`) assigned at spawn; restoring an old color could collide with another live player's color.
- **Bots:** `isAI=true`, no `verifiedUserId`, `deviceId` undefined → **exclude from the snapshot; refill fresh** via `fillGridWithBots` (`game.js:1080`).

### 3e. Sit-tight warning UX surface (extend, don't rebuild)

- `drawMaintenanceBanner()` (`draw_hud.js:178`) already renders the two-line panel, runs every frame via `drawHUD()` (`:92`), self-expires past `expiresAt` (`:181`), and other HUD shifts to `y=102` when `serverMaintenance` is set — **duplicated in `draw_hud.js:161` (team score) AND `lobbyHub.js:1131` (lobby stack)**.
- **`restart` branch** counts down `deadline` with a sine pulse; **`drain` branch** is static copy (`draw_hud.js:186-199`).
- **The reload WIPES the canvas + the `serverMaintenance` global** (`game.js:163`). The disconnect handler (`client.js:1095`) HEAD-polls every 2s and `window.location.reload()`s on first 200 (or after ~60s) (`client.js:1114-1129`). **Nothing survives the reload** to keep a "Reconnecting…" banner up.
- **Self-expiry only runs while the draw loop runs** — a hidden/background tab never ticks, so the disconnect handler re-validates `expiresAt` independently (`client.js:1108`). Any new flag must likewise carry its **own absolute TTL**, not rely on the draw loop.
- **HIDE trigger** for a post-reload banner = `gameID = gameState.gameID` (`client.js:1148`) — when the new server confirms the session is live.

---

## 4. Phased plan

### Phase 0 — identity association (server-only, no wire change)
**Goal:** be able to find "which room/seat does this returning device/user own" without re-keying the five socket.id maps.
- Keep `player.id` = `socket.id` (don't touch the compressor/client wire).
- Add a parallel **reconnect index** keyed by `verifiedUserId` (signed-in) / `deviceId` (guest) → `{ roomSig, seatSnapshot }`, populated when a player joins/scores and on the SIGTERM snapshot. Reuse the `liveClientIdForUser` (`messenger.js:1263`) pattern.
- **Per-slot discriminator for local co-op:** one device runs multiple seats (couch co-op), so the key must be `deviceId + slot` (the `localPlayers` slot index the client already sends), not `deviceId` alone.
- **Security:** `deviceId` is client-supplied + spoofable. For guest re-seating, mint a **server-side reconnect token** (HMAC over `deviceId+sig+seat+expiry`, like the Discord ticket in `auth.js`) rather than trusting the raw handshake `deviceId` to claim a seat.
- **Hard part:** distinguish a *transient disconnect* from a *true leave* so the AFK/Discord-deep-idle reclaim (`game.js:116,152`) and the immediate `kickFromRoom` (`index.js:745`) don't tear down a player mid-reconnect. Introduce a short **grace/tombstone** on disconnect during maintenance.

### Phase 1 — reload routing + the sit-tight warning (client UX)
**Goal:** after a maintenance reload, route the client back to its room and tell the player to sit tight.
- **Stash on disconnect-during-maintenance** (`client.js:1095`, before `window.location.reload()`): write `sessionStorage.reconnecting = { sig: gameID, slot, until: Date.now()+90_000 }` (own absolute TTL — `deadline`/`expiresAt` are gone post-reload).
- **Route on boot** in `enterLobby()` (`game.js:457`, before the param branches): if a fresh (non-expired) `reconnecting` stash exists, `clientSendStart(stashedSig)` instead of the `-1` matchmake (`game.js:491`), then **consume-once** (clear it, mirroring `?new=1` strip at `game.js:486`).
- **Sit-tight banner (EXTEND `drawMaintenanceBanner`):**
  - **Phase A (pre-reload):** extend the existing `restart`/`drain` line-2 copy to add "**SIT TIGHT — we'll reconnect you. Don't navigate away.**" so the reassurance is on screen *before* the socket drops.
  - **Phase B (post-reload):** rehydrate a **synthetic `serverMaintenance`** (or a sibling `reconnecting` state) from the sessionStorage flag so the *same* renderer shows "Reconnecting you to your game…" immediately on boot — preserving the `y=102` stack contract in **both** `draw_hud.js:161` and `lobbyHub.js:1131`. **Clear** it (and the stash) in the `gameState` handler (`client.js:1148`). Add a TTL fallback so a failed re-join can't strand a permanent banner.
- **Truthfulness note:** Phase 1 alone routes the client back, but **only Phase 2 makes "we'll reconnect you with your standings" true.** Ship the literal "Reconnecting…" promise copy with Phase 2; Phase 1 can ship the softer "Don't navigate away" reassurance.

### Phase 2 — SIGTERM roster + standings snapshot (the core)
**Goal:** persist + restore rooms across the restart.
- **On SIGTERM** (`index.js:765`, before exit, only when `clientCount>0`): for each non-preview/non-tarpit room, serialize a **compact snapshot** to Supabase within the 28s budget. **Must await the write** (existing auth writes are fire-and-forget; this must be durable) — keep it fast/bounded; if Supabase is absent/`!writesEnabled`, **degrade to no-op** (no reconnect).
- **Snapshot shape** (each field's source verified):
  ```
  { sig,                              // room.sig (hostess)
    gameModeId,                       // gameBoard.gameModeId
    round, notchesToWin, currentState,// gameBoard.round / game.notchesToWin / game.currentState
    expiresAt,                        // version/TTL marker (mirror maintenance.expiresAt)
    players: [{
      userId | deviceId, slot,        // verifiedUserId / deviceId (+ co-op slot)
      name, notches, teamId,          // player.name / .notches / .teamId
      color, cart, pattern, trailFx, border  // raw cosmetics (REQUIRED for guests)
    }] }                              // exclude isAI bots
  ```
- **On boot:** restore rooms into `roomList` at a **lobby/between-rounds** state holding the **same sig** (seed restored sigs *before* `generateRoomSig` so they can't collide). **Exclude restored rooms from `findARoom`** (mirror the `isPreview/isTarpit/discordInstanceId` exclusions, `hostess.js:115`) until re-seated, or strangers fill saved seats.
- **On re-entry** (`enterGame`, `messenger.js:538`) matching `userId`/`deviceId(+slot)`: re-seat into the saved seat with **notches/team/cosmetics restored**; assign a **fresh room-unique color** if the saved color now collides. **Expire unclaimed snapshots** after a deliberate TTL (match the 2min restart grace).

### Phase 3 — polish
- **Refill bots fresh** (`fillGridWithBots`/`botOverride`, `game.js:1080`) rather than snapshotting them.
- **Land scores at the next-round/lobby boundary** (notches persist across rounds, reset only at `Game.resetGame` `game.js:1745` / `gameOver` `player.js:2345` — natural seams).
- Telemetry: the existing `trackEvent('disconnect')` double-counts across the reload (fresh page re-fires `window.__disconnectSent`) — tag reconnect-driven reloads so the dashboard separates them.

---

## 5. Hard parts to design around (synthesized)

1. **Don't re-key the wire.** `player.id`/`ownerId` is broadcast every tick and decoded client-side; keep it as `socket.id` and add a *parallel* identity index. Re-keying the five maps is a separate, much larger change not needed for Target 2.
2. **28s budget races `process.exit`.** The snapshot write must be awaited and bounded; Supabase has no configured timeout (`auth.js:61`). Consider a hard cap (e.g. `Promise.race` with a ~5s timeout) so one slow room can't starve the rest.
3. **Cross-process only via Supabase.** No Redis, FS is per-dyno/ephemeral. Degrade to "no reconnect" when Supabase is unavailable or `!writesEnabled`.
4. **Read-before-write race at cutover.** New dyno boots in parallel; snapshot row needs an `expiresAt`/version so the new dyno reads fresh, not a half-written or stale row.
5. **Sig collision/recycle.** Only 1000 sigs; seed restored sigs before generating new ones, and re-validate a stashed sig server-side (it could now be a preview/tarpit/Discord/unrelated room).
6. **Vanished room.** Solo-disconnecters' rooms are deleted; the stashed-sig reconnect must fall back gracefully (to matchmaking or a fresh room) instead of stranding on `roomNotFound`.
7. **Grace vs reclaim.** A transient disconnect must not trip AFK/Discord-deep-idle reclaim or the immediate `kickFromRoom`.
8. **Guest cosmetics + color.** Guests have no DB cosmetics → snapshot must carry them raw; restored `color` may collide → reassign a fresh unique color.
9. **Reset-seam ordering.** `notches` zeroes at `gameOver` (`player.js:2345`), not `resetGame` — snapshot before either fires.
10. **Reload wipes the global.** The sit-tight "Reconnecting…" state needs a `sessionStorage` flag with its own absolute TTL; extend `drawMaintenanceBanner`, don't build a parallel banner (preserve the `y=102` contract in two files).

---

## 6. Open scope questions for the operator

1. **Identity strategy:** confirm the **parallel reconnect index** approach (keep `player.id` = socket.id, no wire change) vs. a full re-key of the five maps. Recommendation: parallel index for Target 2.
2. **Guest reconnect:** mint a server-side reconnect token, or accept that **only signed-in** players get seamless re-seat (guests just rematchmake)? Token is more work but covers the majority (most players are guests).
3. **Snapshot durability vs. budget:** is an awaited Supabase write at SIGTERM acceptable, with a per-room timeout and graceful no-op fallback? Any appetite for a lighter "best-effort" mode?
4. **Restore boundary:** confirm racing resumes from the **next round** (re-seat at lobby/between-rounds), never mid-race — i.e. Target 2 as scoped.
5. **Warning copy:** sign off the two-phase copy (pre-reload "Sit tight, don't navigate away" → post-reload "Reconnecting you to your game…").

---

## 7. Operator-injectable follow-up prompts

Paste any one of these to start that phase (each on its own branch off `origin/main`, investigate→implement→adversarially-verify, its own PR; CHANGELOG/Codex only if the phase touches `config.json`/`game.js`/`engine.js`):

**Phase 0 (identity index):**
> Implement Phase 0 of `docs/spikes/seamless-reconnect.md`: add a server-side reconnect identity index keyed by `verifiedUserId` / `deviceId(+co-op slot)` → `{roomSig, seat}`, WITHOUT re-keying the socket.id maps or touching the compressor/client wire (keep `player.id`=socket.id). Reuse the `liveClientIdForUser` pattern. Add a short disconnect grace/tombstone during maintenance so AFK/Discord-deep-idle reclaim and the immediate `kickFromRoom` don't tear down a mid-reconnect player. Headless-verify with the smoke-test harness (a fake socket reconnecting under a new id re-finds its seat). No wire/CHANGELOG change expected.

**Phase 1 (routing + sit-tight warning):**
> Implement Phase 1 of `docs/spikes/seamless-reconnect.md`: stash `{sig:gameID, slot, until}` to `sessionStorage` in the maintenance disconnect handler (`client.js:1095`) before reload; on boot in `enterLobby()` route via `clientSendStart(stashedSig)` (consume-once like `?new=1`) instead of `-1`; and EXTEND `drawMaintenanceBanner` with (A) pre-reload "Sit tight — don't navigate away" copy and (B) a post-reload "Reconnecting you…" state rehydrated from the sessionStorage flag (own TTL), cleared in the `gameState` handler. Preserve the `y=102` shift in both `draw_hud.js:161` and `lobbyHub.js:1131`. Client-only (CHANGELOG-exempt). Validate the reload→route→banner lifecycle in Chrome on a dev server.

**Phase 2 (snapshot/restore — the core; confirm scope first):**
> Implement Phase 2 of `docs/spikes/seamless-reconnect.md`: on SIGTERM (`index.js:765`, clients>0), await a bounded Supabase snapshot of each non-preview/non-tarpit room's roster+standings (shape in §4) with a per-room timeout and a no-op fallback when `!auth.writesEnabled`; on boot, restore rooms into `roomList` at a between-rounds state holding the same sig (seed restored sigs before `generateRoomSig`), excluded from `findARoom` until re-seated; and re-seat returning `userId`/`deviceId(+slot)` players with notches/team/cosmetics restored (fresh unique color on collision), expiring unclaimed snapshots after the restart grace. Add the Supabase table via a `supabase/migrations/<ts>_reconnect_snapshots.sql` migration (db-migrate CI path). Headless-verify: snapshot→simulated-restart→restore→re-seat with notches intact, and restored-room exclusion from matchmaking.

**Phase 3 (polish):**
> Implement Phase 3 of `docs/spikes/seamless-reconnect.md`: refill bots fresh on a restored room (`fillGridWithBots`), land scores at the next-round/lobby boundary, and split reconnect-driven reloads from real disconnects in `trackEvent('disconnect')` telemetry.

---

*Investigation: 5-way parallel code audit (identity blast-radius, maintenance/SIGTERM/store, reconnect-routing/stash, standings/roster/bots, sit-tight UX), anchors verified against `origin/main` @ `b23cb32`.*
