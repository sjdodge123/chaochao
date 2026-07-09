# Discord Activity mid-match rejoin: sign-in identity / name / avatar loss — Final Investigation Report

**Scope:** bug observed on PROD (chaochaogame.com, Heroku, `origin/prod` = deps-bump on `c35fe33` = current `origin/main`, i.e. **the PR #365 seamless-reconnect era**). The `154a113` checkout (`/Users/sdodge/Documents/Projects/chaochao-serve3700`) was used only as a differential baseline. All conclusions below are weighted to MAIN.

**Bottom line:** the operator's suspicion is correct — **auto-sign-in almost certainly succeeded; only the DISPLAY of identity was lost.** The server re-authenticates the reconnected socket fine, but the re-seated `Player` object comes back with `name=null` / `avatarUrl=null` (fully or partially, depending on timing), and there is **no mechanism anywhere in the game that can repair name/avatar mid-match** — by design on both client and server. The recap symptom is purely downstream (PR #358 is sound).

---

## Confirmed root causes (main / prod)

### RC1 — Fast-reconnect race: a rejoin that beats the old socket's server-side disconnect restores NOTHING (name + avatar + notches all lost) — **CONFIRMED, repro-proven**
Standings are parked onto the reconnect seat **only inside the socket-disconnect handler** (`index.js:797` → `roomSnapshot.captureStandings`). `enterGame` records live seats with `seat=null` (`server/messenger.js:731`), and the restore gate requires `savedSeat.seat.standings != null` (`messenger.js:695`). A client that auto-reconnects in ~1–2s (typical Discord-iframe suspend/resume; the zombie socket survives up to ~35s server-side — `pingInterval 15000 + pingTimeout 20000`, `index.js:19`) lands `enterGame` **before** the old socket's disconnect fires → `ownsSavedSeat=true` but standings are null → `applyStandings` never runs → fresh `Player` with `name=null`, `avatarUrl=null`, `notches=0` (`server/entities/player.js:371,377`). The dup-kick loop (`messenger.js:701-711`) then destroys the old Player — the only object still holding the identity — without copying anything off it. The late zombie disconnect parks nothing (mailbox already removed). **This is the main-build path that produces the operator's full symptom (name AND avatar missing) while sign-in itself succeeds** (`verifiedUserId` re-stamped, `messenger.js:674`). Headless repro against the real main modules: scenario AR, 8/8 assertions (`scratchpad/repro-reconnect-main.js`). Adversarial status: **CONFIRMED by both judges.**

A sibling timing variant produces the same total loss without a race: if the outage exceeds the seat grace **GRACE_MS = 45s** (`server/reconnect.js:30`), the parked seat self-evicts → same zero-restore rejoin. One judge argued this expiry variant fits the incident even better than the race; either way the *code gap is the same class* (the re-seat misses, nothing is restored) and both variants are realistic for the reported drop.

### RC2 — PR #365's seat restore omits `avatarUrl`: the Discord photo is lost on EVERY re-seat, even when the restore works — **code defect verified, repro-proven** (CONTESTED only as the *sole* explanation, because it preserves the name)
`captureStandings` returns `{name, notches, teamId, color, cart, pattern, trailFx, border}` — **no `avatarUrl` field** (`server/roomSnapshot.js:32-43`); `applyStandings` mirrors the omission (`:135-145`). So even the happy path (disconnect seen first, rejoin within 45s) restores the name but permanently drops the Discord photo. `name`/`avatarUrl` travel **only** in spawn/append packets (`server/compressor.js:209` packet[10]=name, `:213` packet[12]=avatarUrl) plus the one-shot `playerAvatarChanged`; per-tick `gameUpdates` rows carry no identity fields (`compressor.js:12-33`) — so nothing ever heals it. Repro: scenarios A/B/C (parked standings object literally has no `avatarUrl` property; post-rejoin `name='Jake'`, `avatarUrl=null`; field-survival table shows avatarUrl is the only broadcast-visible identity field lost). One judge voted this REFUTED **as the operative mechanism of this specific incident** because its path keeps the name visible; the defect itself was verified by both judges and must be fixed regardless. Note the fix surface is proven: name demonstrably propagates `applyStandings → packet[10]`, so adding avatarUrl rides packet[12] through the identical already-decoded path (`client/scripts/gameboard.js:321,323`).

### RC3 — The only repair path is lobby-gated on both ends AND trigger-starved: any mid-match loss is locked in for the rest of the match — **CONFIRMED mechanism, repro-proven** (CONTESTED only on "root cause vs amplifier" framing)
The single event that sets a human's `name`/`avatarUrl` is `setAvatarSkin`, hard-gated server-side to LOBBY state and signed-in sockets (`server/messenger.js:937-944` — silent return). Client-side, the one-shot `maybeDefaultDiscordAvatar` (`client/scripts/client.js:670-695`) refuses to emit unless `currentState === config.stateMap.lobby` (`:689-690`), and its **sole trigger** is the `progressionUpdate` handler (`client.js:972`). Server `progressionUpdate` emits land (1) right after `enterGame` — mid-match on a rejoin, skipped; (2) after the post-match XP persist — during the ~20s `gameOver` state, skipped; (3) rewarded-ad claim / map-submit edges. **Nothing emits `progressionUpdate` on actual lobby arrival** (`startLobby → deliverRoomToasts` emits only `progressionToasts`), so the in-code promise at `client.js:687` ("progressionUpdate fires again on the next lobby arrival, which retries here") is **false**. PR #359's re-arm (`discordAvatarDefaulted=false`, `client.js:1361`) fires correctly but can never pay off. Repro: S2d/S3/S4a (0 progressionUpdate deliveries in lobby, mid-race `setAvatarSkin` silently rejected), and the S4b counterfactual proves a lobby-time trigger **fully self-heals** — the Discord profile survives in client JS memory (`auth.getProfile()`; the lobby skin-hub tile still renders the photo). This is why the loss persisted through the entire match and into the recap. Wrinkle: a player with a persisted cart cosmetic latches WITHOUT emitting (`client.js:684`), so even a lobby trigger wouldn't re-apply their name.

### How the observed incident is assembled
Sign-in survives (12h HS256 Discord session ticket "reused across reconnects", `server/auth.js:753-766`; auth passed as a socket.io **callback** re-run per reconnect attempt, `client.js:426-442,462`; `io.use` re-verifies per connection, `index.js:716-757` — **H1 contradicted for the transport path**). The re-seat then loses the identity (RC1 total loss, or RC2 avatar-only if the slow path ran), and RC3 guarantees it stays lost through the match, the recap, and typically the session. Every screen shows the loss because peers only ever learn name/avatar from the (now-null) spawn/append packet — the observers render server truth correctly (**H4 contradicted as stated; symptom real, mechanism is the server-side loss**).

---

## H6 verdict: recap — PR #358 is sound; symptom purely downstream — **CONFIRMED (both judges)**
`recapMeta` is upserted from the LIVE `playerList` every captured tick while racing/collapsing (`client/scripts/recap.js:210-224`, avatarUrl at `:223`, preload `:226-228`; driven from `client.js:1514-1517`). Archived clips store only id tuples; the look is resolved at render time from `recapMeta` (`recap.js:1462-1464`), the synthetic recap player carries avatarUrl (`:1486`), and the no-cart-skin branch still calls `drawAvatarSkin(p, sprite)` (`:1566-1567`) — verified against PR #358's merge commit `5549b69`, byte-identical between main and 154a113. Since the rejoiner returns under a NEW socket id whose live `avatarUrl` is null, every post-rejoin frame captures null — **the recap had nothing to draw. No residual recap defect exists.** Nuance: pre-drop clips reference the OLD frozen id and would still show the photo if featured; a judge also noted the `winner: player` payload in `startGameover` (`server/game.js:1992`) serializes the full server Player (minor over-broad payload, unrelated).

## Hypothesis scorecard
- **H1** (auth lost on reconnect): **contradicted** for the transport path (proven by repro — `verifiedUserId` re-stamped). **True only** for reload/navigation recoveries (see C6 below).
- **H2** (fresh Player, profile never re-populated): **confirmed** — the core server-side cause (RC1/RC2).
- **H3** (client never re-applies): **confirmed** — RC3; a client-only fix cannot work mid-match because the server gate rejects it anyway.
- **H4** (peers lose it via missing event): **contradicted as stated** — `playerJoin` fires with the fields, they're genuinely null.
- **H5** (#365 broke #359): **contradicted** — #365 modified #359's handler in place; overlay is display-only; the re-arm survives (`client.js:1361`). But #365's **own machinery carries the bug** (RC1/RC2 + Discord exclusions).
- **H6** (recap downstream): **confirmed** — see above.

## Secondary/adjacent findings (honest status)
- **C4 — Discord rooms excluded from every #365 preservation mechanism** — **REFUTED as this incident's cause** (both judges): a solo-drop deletes the room (`server/hostess.js:177-181`) and a dyno restart skips Discord rooms in snapshots (`server/roomSnapshot.js:50`), but both land the player in a **fresh lobby where identity re-applies** — "match evaporated", not "nameless inside the same match". Both exclusions are **real, separately-fixable defects** (Activity matches have zero reboot survival despite daily Heroku restarts).
- **C5 — `checkForTimeout` kill-switch** — **CONTESTED**: `client.js:3561-3568` fires after >5s comm silence, calls `server.disconnect()` (permanently kills socket.io auto-reconnect, verified in socket.io 4.8.3 dist) then `window.parent.location.reload()` — cross-origin in the Activity iframe, so it throws **after** the disconnect, stranding the player until the 150s give-up "Try again" (`reconnectOverlay.js:26`). One judge confirmed it as the funnel; the other argued the incident rode the fast path where it never fires. Either way it is a **verified reliability landmine** (also: mass-fire on any >5s server stall; Try-again can be re-killed within 1s because `timeSinceLastCom` only resets on the first `gameUpdates`).
- **C6 — reload/navigation recovery = TRUE sign-in loss** — **CONTESTED as this incident, verified as latent bug**: the Discord ticket+profile are memory-only (`auth.js:103-121`), the SDK handshake is once-per-frame-launch (`client.js:45-51`, "proven live"), and the #365 seat token is keyed `u:<userId>` while a reloaded guest's rcKey is `d:<deviceId>` (`server/reconnect.js:45-48`) → nothing restored, `setAvatarSkin` impossible even in lobby (`messenger.js:942`). The maintenance PATH-A reload (`client.js:1274`) has **no Discord gate** — every Heroku deploy/restart will reload Activity frames and downgrade players to guest with permanent voice loss. Repro: scenario A3, 5/5.
- **C7 — Discord deep-idle reclaim** (`server/game.js:140-154`) — **CONTESTED**: reproduces the identical loss with no network drop (kick-before-disconnect ordering parks no standings), but requires ~20 min continuous idle + a deliberate tap on the "you stepped away" panel — phenomenology doesn't match "connection drop". Real second trigger class; any fix must cover it.
- **C8 — avatar image failed-latch** (`draw.js:3962-3970`, one `onerror` latches `entry.failed=true` forever, no retry) — **REFUTED as cause** (cannot touch the name; entry was already `ready=true` pre-drop), **real secondary defect** worth a retry/TTL.
- **C11 — web AFK-kick `onRejoin` never re-arms `discordAvatarDefaulted`** (`client.js:1133-1144` vs `:97`/`:1361`) — **CONFIRMED adjacent gap**, web-only (Discord kicks route through `discordReenter`, which re-arms). Not this incident.
- **Ghost self-kart** (flagged, unconfirmed live): the transport re-entry path never prunes `playerList` and the rejoiner never receives its own `playerLeft`, so a frozen old-id kart (still wearing the photo) can linger on the rejoiner's screen and even leak into recap frames. Worth checking during the live run.
- **C10 — 154a113 baseline** — CONFIRMED: zero restore machinery; establishes exactly what #365 fixed (slow-path name) vs inherited (everything else). Cannot be the observed bug's home (prod runs #365).

## Evidence: key repro results (expected vs actual)
All scripts run the REAL server modules (messenger/hostess/game/reconnect/roomSnapshot/compressor) with recording fake sockets and a mocked clock. Scripts: `/private/tmp/claude-501/-Users-sdodge-Documents-Projects-chaochao/df3180a3-49ec-45ff-a244-82a6cf7a0c45/scratchpad/{repro-reconnect-main.js, repro-reconnect-old.js, discord-rejoin-identity-repro.js, one-shot-starvation-check.js}`.

| Scenario (main) | Expected if healthy | Actual |
|---|---|---|
| A: multi-player Discord room, drop → rejoin (slow path) | name+avatar restored, rebroadcast | auth OK (`verifiedUserId` re-stamped); **name restored, `avatarUrl=null`**; `playerJoin` row[12]=null to room; no later event ever carries the avatar; mid-match `setAvatarSkin` silently rejected (24/24 assertions) |
| AR: fast reconnect beats old socket's disconnect | standings restored regardless of ordering | `ownsSavedSeat=true` but `seat=null` → **name=null, avatarUrl=null, notches=0**; dup-kick destroys old Player; late zombie disconnect changes nothing (8/8) |
| A2: solo Discord player drops | held room or seat restores on return | room **deleted** (`hostess.js:177`); rejoin lands new sig; roomSig mismatch → nothing restored (6/6) |
| A3: reload recovery (guest + #365 token) | sessionStorage token re-seats | token key `u:<userId>` ≠ guest rcKey `d:<deviceId>` → nothing restored, `verifiedUserId=null`, lobby heal impossible (5/5) |
| C: reboot snapshot restore | full identity back; Discord covered | name/notches/cart back, **avatarUrl lost**; `serializeRoom` returns null for Discord rooms — Activity gets nothing (7/7) |
| One-shot sandbox (real function text, both builds) | re-armed one-shot re-emits | racing arrival: 0 emits, unlatched; gameOver arrival: 0 emits; lobby arrival: emits (proves fix works); lobby+cart: latched without emit |

**Code/repro-proven:** RC1, RC2, RC3 mechanisms end-to-end; H1 transport-path contradiction; H4 contradiction; H6 downstream verdict; C4/C6/C7/C8/C11 mechanisms.
**Still needs the live Discord run:** which exact trigger the operator hit (race vs 45s expiry vs reload vs idle); that a real Activity iframe drop takes the transport path (client timers frozen vs server ping timeout ordering on-device); the cross-origin `window.parent.location.reload()` throw (asserted from platform semantics, never executed in a real Activity frame); the ghost self-kart; whether `progressionUpdate` ever lands in-lobby on prod with DB writes on; the once-per-frame-launch SDK limitation (rests on prior "proven live" comments).

---

# Fix plan (from adversarially-verified investigation)

## 1. Add avatarUrl to the #365 seat standings (capture + apply)
**Files:** /Users/sdodge/Documents/Projects/chaochao/server/roomSnapshot.js

Add `avatarUrl: (p.avatarUrl != null ? p.avatarUrl : null)` to captureStandings (lines 32-43) and a matching `if (standings.avatarUrl != null) { player.avatarUrl = standings.avatarUrl; }` to applyStandings (lines 135-145). Re-validate on apply with the same CDN allowlist used by setAvatarSkin (isAllowedAvatarUrl in messenger.js) so a forged snapshot cannot inject an arbitrary URL. No wire change needed: the restored value ships automatically in spawn/append packet[12] (compressor.js:213), already decoded at gameboard.js:323 — compressor/client lockstep is untouched. Consider capturing discordUserId too (packet[18]) so the voice ring survives without relying on the client re-emitting setVoiceId. Also flows into the reboot room_snapshots path for free (shared captureStandings).

**Risk:** LOW. Server-only, two functions, restores a field through an already-proven propagation path (name via packet[10]). Not in config.json/game.js/engine.js so CHANGELOG-exempt, but a Codex prose touch is cheap insurance. Blast radius: reconnect + reboot restore paths only. Must add validation on apply or it becomes a URL-injection surface.

## 2. Close the fast-reconnect race: never destroy the old Player's identity without harvesting it
**Files:** /Users/sdodge/Documents/Projects/chaochao/server/messenger.js, /Users/sdodge/Documents/Projects/chaochao/server/roomSnapshot.js

In enterGame, before the dup-kick loop (messenger.js:701-711) evicts the old live Player for the same verified identity, capture roomSnapshot.captureStandings(oldPlayer) and apply it to the new Player (same code path as messenger.js:695-697). This covers BOTH orderings: rejoin-before-disconnect (seat still has seat=null from messenger.js:731) and the idle-reclaim kick (C7, which parks nothing). Alternatively/additionally, refresh the seat's standings periodically or at enterGame time instead of only in index.js:797's disconnect handler. Preserves name, avatarUrl (after fix #1), notches (score-integrity: the race currently silently zeroes mid-match score), teamId, cosmetics.

**Risk:** MEDIUM. Touches seat/ownership semantics in enterGame; must not let an attacker inherit someone else's standings (gate on the same ownsSavedSeat verified-userId/token check that already guards applyStandings). Verify with a headless test cloned from scratchpad/repro-reconnect-main.js scenario AR (port it into .github/scripts/ alongside reconnect-phase0/phase2). CHANGELOG-exempt (messenger.js) but this is a player-visible behavior fix — worth a release-notes bullet anyway since notches restoration is a mechanic-adjacent change.

## 3. Give the identity re-apply a real trigger: fire the avatar one-shot on lobby arrival
**Files:** /Users/sdodge/Documents/Projects/chaochao/client/scripts/client.js

Call maybeDefaultDiscordAvatar() from the client's startLobby handler (client.js:1779-1825), making the false comment at client.js:687 true. Also fix the cart-latch wrinkle at client.js:684 (currently latches WITHOUT emitting when me.cart is set, so cart-skin wearers would never re-apply their NAME): emit setAvatarSkin for name+avatar restoration independent of the cart default decision, or split the 'default the skin' one-shot from the 'restore identity' re-apply. Optional stronger variant (server-side): have the server re-stamp name/avatarUrl from the verified ticket's embedded claims at re-seat time (mintAccessToken already embeds them, server/auth.js:759-766), or relax the setAvatarSkin lobby gate (messenger.js:939) for a socket whose userId matches the seated player — that makes reconnects self-healing MID-match rather than at next lobby.

**Risk:** LOW for the client-only lobby trigger (CHANGELOG/Codex-exempt, no wire change; server gate already accepts lobby-state emits — proven by repro S4b). MEDIUM for the server-side gate relaxation (messenger.js — auth-sensitive; keep the userId gate and CDN allowlist; do NOT relax for guests). Do not emit progressionUpdate from game.js for this unless you want the CHANGELOG obligation game.js changes carry.

## 4. Defuse the checkForTimeout kill-switch inside the Activity
**Files:** /Users/sdodge/Documents/Projects/chaochao/client/scripts/client.js

In checkForTimeout (client.js:3561-3568): (a) skip entirely when the socket is already disconnected/reconnecting (socket.io owns recovery; Path B overlay is already the UX); (b) remove the server.disconnect() call (it permanently disables auto-reconnect — verified in socket.io 4.8.3 client dist); (c) never touch window.parent — in the Discord Activity iframe it is cross-origin and the reload line throws AFTER the disconnect ran; use window.location.reload() gated on !isDiscordActivity(), and inside the Activity fall back to the reconnect overlay instead of reloading; (d) reset timeSinceLastCom on 'connect'/'gameState' so the post-give-up Try-again isn't re-killed within 1 second. Same defect exists in connectionHud.js's auto-reload (146-181) — gate it on !isDiscordActivity() too.

**Risk:** LOW-MEDIUM. Client-only (CHANGELOG-exempt). The watchdog is currently the last-ditch recovery for a wedged web session, so keep the web reload path but make it Activity-safe and disconnect-aware. Contested whether it shaped THIS incident, but it is a verified stranding landmine for every >5s Activity outage and would mass-fire on any >5s server stall.

## 5. Make reload/maintenance recovery Activity-safe (the true sign-in-loss path)
**Files:** /Users/sdodge/Documents/Projects/chaochao/client/scripts/client.js, /Users/sdodge/Documents/Projects/chaochao/client/scripts/auth.js

PATH-A maintenance reload (client.js:1274) and the give-up onLeave navigation to join.html (client.js:1228) are identity-fatal inside the Activity (memory-only Discord ticket; SDK handshake once per frame launch). Gate both on isDiscordActivity() and route through the existing in-place discordReenter flow (client.js:59-107) instead of reload/navigation. Longer-term: persist/re-mint the Discord session ticket across reloads (e.g. sessionStorage stash written by applyDiscordSession, honored by getHandshake) so even an unavoidable reload re-authenticates — note the current 'chaochao.discordAuth' stash is read-only legacy with no writer.

**Risk:** MEDIUM. Touches auth/session handling; the ticket-persistence variant must consider token theft-surface in the iframe (sessionStorage is partitioned per-origin — acceptable, but review). Without this, every Heroku deploy/daily restart downgrades in-Activity players to guests with permanent voice loss. Client-only → CHANGELOG-exempt.

## 6. Housekeeping: re-arm the avatar one-shot in the web AFK onRejoin
**Files:** /Users/sdodge/Documents/Projects/chaochao/client/scripts/client.js

Add `discordAvatarDefaulted = false;` to the afkKickedShow onRejoin path (client.js:1133-1144), mirroring discordReenter (client.js:97) and the reconnect handler (client.js:1361). Fixes the confirmed web-only gap (C11) for Discord-OAuth web sign-ins.

**Risk:** TRIVIAL. One line, client-only, exactly matches two existing sibling paths.

## 7. Retry policy for the avatar image cache (failed latch)
**Files:** /Users/sdodge/Documents/Projects/chaochao/client/scripts/draw.js

In the avatarImageCache (draw.js:3954-3970), stop latching entry.failed=true forever on one onerror: delete the cache entry (or timestamp it and retry after N seconds / on next 'connect'). One transient CDN failure during the very flap that caused a reconnect currently hides the photo in live play + recap + lobby hub for the whole session even with avatarUrl intact.

**Risk:** LOW. Client-only render path; cap retries to avoid hammering a genuinely-404'd URL (avatar-hash rotation). Not this incident's cause but a verified look-alike incident source that would also mask fix #1 during flaky sessions.

## 8. Decide policy: Discord rooms in hold + reboot snapshots (separate scope)
**Files:** /Users/sdodge/Documents/Projects/chaochao/server/hostess.js, /Users/sdodge/Documents/Projects/chaochao/server/roomSnapshot.js

Today a solo Discord player's drop DELETES the instance room (hostess.js:177-181) and serializeRoom excludes discordInstanceId rooms from reboot snapshots (roomSnapshot.js:50) — Activity matches have zero survival across the daily Heroku restart. If Activity parity with web is wanted, hold Discord rooms for the same 45s grace and include them in snapshots (instance→room remapping on restore needs care: instanceRoomMap must be rebuilt). REFUTED as this incident's cause (produces a fresh-lobby symptom, not mid-match namelessness) — file as its own follow-up, not part of the identity fix.

**Risk:** HIGH relative to the others: touches room lifecycle + Discord instance routing; needs its own headless scenarios (solo drop, reboot restore with instance remap). Defer unless Activity reboot-survival is a product goal.

## 9. (Optional) prune the ghost self-kart on transport re-entry
**Files:** /Users/sdodge/Documents/Projects/chaochao/client/scripts/client.js, /Users/sdodge/Documents/Projects/chaochao/client/scripts/gameboard.js

The #359 transport re-entry path never prunes playerList and the rejoiner never receives its own playerLeft, so the old-id entry (still wearing the photo) can linger as a frozen duplicate kart and leak into recap capture. On the 'connect' re-enter (client.js:1342-1367), reconcile playerList against the incoming gameState playerSpawns set (remove ids not present), mirroring what discordReenter's resetGameboard achieves. Verify live first — flagged/inconclusive, not yet reproduced.

**Risk:** LOW-MEDIUM. Client-only; take care not to prune during normal mid-round joins (gameState is authoritative at re-entry, so reconciling against it is safe).


---

# Live e2e validation plan

GOAL: reproduce and characterize the identity-display loss live on Discord, on prod-equivalent code (current main / #365 paths), distinguishing the three candidate triggers (fast-reconnect race, >45s seat expiry, reload-as-guest), and verify self view + second-client view + recap. The bug lives on MAIN — the /Users/sdodge/Documents/Projects/chaochao-serve3700 checkout is at 154a113 and MUST NOT be used as-is.

PHASE 0 — Server prep
1. Create/refresh a prod-equivalent checkout WITHOUT touching the two read-only investigation checkouts: `git -C /Users/sdodge/Documents/Projects/chaochao worktree add /Users/sdodge/Documents/Projects/worktree-discord-e2e origin/main` (or fast-forward an existing worktree to origin/main = c35fe33-era code). Copy the main checkout's `.env` (DEV Supabase only, per the Supabase-writes gate) into the worktree.
2. Start the dev server on the Discord tunnel port with diagnostics: `cd /Users/sdodge/Documents/Projects/worktree-discord-e2e && npm install && PORT=3700 DISCORD_DEBUG=1 node index.js` (do NOT reap any other running dev servers; the named cloudflared tunnel discord-dev.chaochaogame.com -> localhost:3700 is already up via LaunchAgent). Confirm the tunnel serves the new build: `curl -s https://discord-dev.chaochaogame.com/ | head`.
3. Tail server logs in a second terminal. Log lines to watch: `[auth] socket <id> resolved to user <id>` (proves reconnect re-auth), `[discordDiag] ...` (DISCORD_DEBUG=1), `[skin] avatar skin equipped: socket <id> user <id> name <name>` (setAvatarSkin accepted), `Deleting room` (hostess room teardown). RECOMMENDED (worktree is writable): add three temporary log lines in server/messenger.js enterGame — ownsSavedSeat value, whether savedSeat.seat/standings was null, and post-applyStandings name/avatarUrl — this single log discriminates RC1 (race: seat=null) vs 45s expiry (savedSeat=null) vs slow-path (standings applied, avatarUrl still null).

PHASE 1 — Two-client baseline in the browser Discord client
4. Open Chrome via the claude-in-chrome / CDP tooling. Client A: discord.com, log into the dev Discord account, join the dev-app voice channel, launch the chaochao Activity (points at discord-dev.chaochaogame.com). Client B (keeps the room alive through the drop — REQUIRED, a solo drop deletes Discord rooms per hostess.js:177): second Chrome profile/window on discord.com with a second account in the same voice channel + Activity, or a phone/iPad Discord client.
5. Get into a match together (mode hub -> race) and confirm the healthy baseline on BOTH screens: Client A's kart shows the Discord display name under it and the Discord photo on the kart. Screenshot both.
6. Snapshot client state via CDP on the Activity iframe (select the discordsays.com frame): run in console —
   `({auth: window.chaochaoAuth && window.chaochaoAuth.getAuthState(), profile: window.chaochaoAuth && window.chaochaoAuth.getProfile(), myID: myID, me: playerList[myID] && {name: playerList[myID].name, avatarUrl: playerList[myID].avatarUrl, notches: playerList[myID].notches}, latch: discordAvatarDefaulted, ids: Object.keys(playerList)})`
   Record it. Expect profile.name/avatarUrl set, me.name/avatarUrl set, latch=true.

PHASE 2 — Trigger 1: fast transport drop MID-MATCH (the RC1 race)
7. While racing, force a short offline window on Client A via CDP: `Network.emulateNetworkConditions {offline:true}` (or the claude-in-chrome equivalent / OS-level toggle) for ~4 seconds — SHORT enough that checkForTimeout (>5s) does not fire — then restore. socket.io should auto-reconnect within 1-2s of restoration; the server's zombie socket survives up to ~35s (pingInterval 15s + pingTimeout 20s), so the rejoin's enterGame beats the old disconnect = the race.
8. Immediately re-run the Phase-1 console snapshot on Client A and screenshot BOTH clients. EXPECTED (bug present on current main): Client A back in the SAME match; server log shows `[auth] ... resolved to user` (sign-in survived — verify the XP/level badge still renders if visible); but `playerList[myID].name === null` and `avatarUrl === null` and `notches === 0`; kart label shows the colour word (e.g. "Red") on BOTH screens; temp enterGame log shows ownsSavedSeat=true with seat/standings=null. Also check `Object.keys(playerList)` for a lingering OLD socket id = the ghost self-kart (flagged, unconfirmed — screenshot if present).
9. Let the match run to completion WITHOUT touching the skin station. At gameOver, screenshot the recap montage on both clients. EXPECTED: recap karts for Client A render as plain discs (no photo) in all post-rejoin clips — confirming H6 downstream. Optionally inspect `recapMeta` in console: entries for the NEW id should have avatarUrl:null; an entry for the OLD id may still hold the photo (frozen).
10. In the post-match LOBBY, observe whether name/avatar come back WITHOUT player action (they should NOT on current main — RC3 trigger starvation; the latch is re-armed but nothing calls the one-shot in-lobby; note: on a writes-enabled server the post-match progressionUpdate may land late enough to arrive in-lobby and self-heal — record which happened, this resolves an open question). Then manually walk to the lobby skin station and re-pick the avatar tile — this MUST restore name+photo (proves the S4b counterfactual live).

PHASE 3 — Trigger 2: long drop (>45s seat expiry + checkForTimeout behavior)
11. Fresh match. Force offline on Client A for ~60s (exceeds GRACE_MS=45s). While offline, watch the Activity iframe console for the checkForTimeout behavior: expect `server.disconnect()` then a thrown SecurityError on `window.parent.location.reload()` repeating ~1/s (this live-confirms the cross-origin throw, currently only asserted), and the #365 reconnect overlay escalating to the give-up panel at ~150s. Screenshot the overlay states.
12. Restore network, click "Try again" on the give-up panel. EXPECTED: rejoin into the same room (Client B kept it alive) with name=null/avatarUrl=null/notches=0 (seat expired — temp log shows savedSeat missing). Re-run the console snapshot; verify sign-in still intact (`getAuthState()==='discord'`, profile populated) — i.e. display-only loss again, different timing path.
13. NEGATIVE CONTROL for RC2's slow path: repeat with an offline window of ~10s but keep Client A's tab/process suspended so the CLIENT reconnects only after ~40s while the SERVER saw the disconnect at ~35s (or simply kill Client A's socket server-side if easier). EXPECTED on current main: name/notches RESTORED (applyStandings ran) but avatarUrl still null — isolating the roomSnapshot avatarUrl omission on its own.

PHASE 4 — Trigger 3: reload-as-guest (C6, true sign-in loss)
14. Fresh match. In the Activity iframe, execute `window.location.reload()` on Client A (simulates the PATH-A maintenance reload). EXPECTED: SDK handshake does not complete again (once-per-frame-launch — this live-re-confirms the 'proven live' comment), the 12s Discord connect-gate expires, Client A re-enters the same instance room as a GUEST: `getAuthState()` not 'discord'/no profile, no XP badge, name/avatar gone, server log shows NO `[auth] resolved to user` for the new socket. This is the only variant where sign-in itself is lost — record it so the operator can distinguish it from what they saw.

PHASE 5 — Post-fix validation (rerun after fixes land)
15. Repeat Phases 2-4 on the fixed build. Acceptance: Phase 2 race → name+photo+notches all survive on both screens with no player action, recap shows the photo; Phase 3 expiry → at minimum identity re-applies automatically at the next lobby (or mid-match if the server-side re-stamp variant shipped); Phase 3 negative control → avatar now restored too; Phase 4 → per whatever reload policy shipped (in-place discordReenter instead of reload, or ticket persistence → still signed in). Also verify no checkForTimeout disconnect/throw during the 60s outage.

Artifacts to save for each phase: both clients' screenshots (kart + label, overlay states, recap), the console snapshot JSON, and the server log excerpt around enterGame/disconnect (with the temp ownsSavedSeat log). Keep everything in the scratchpad directory.

---

# Open questions
- Which exact trigger did the operator hit? Discriminators to ask/check: did their notches/score survive the rejoin (race/expiry zeroes them; slow path preserves them)? Did they see a full-screen reconnect overlay and click 'Try again' (long-drop path) vs a seamless return (fast path)? Did the XP/level badge survive (sign-in intact) vs disappear (reload-as-guest)? Heroku logs at the incident timestamp for '[auth] socket ... resolved to user' would settle H1 definitively.
- On real devices, does a Discord-iframe suspend/resume make the client rejoin BEFORE the server's ~35s ping-timeout (RC1 race) or after (slow path / 45s expiry)? Client timers freeze during suspend, so checkForTimeout may not fire even for long suspensions — needs the live run (Phase 2/3) to observe actual orderings.
- Does window.parent.location.reload() actually throw SecurityError inside the production Discord Activity iframe? Asserted from cross-origin platform semantics and the repo's own comments, never executed in a real Activity frame (Phase 3 step 11 tests this).
- On prod (DB writes on), does the post-match progressionUpdate ever land while the client is already in the LOBBY state (async Supabase persist ~100-500ms into the ~20s gameOver screen suggests no, but slow writes could slip it into the lobby and silently self-heal the avatar between matches)? Phase 2 step 10 observes this; it affects whether the loss is match-long or session-long in the wild.
- Ghost self-kart: does the transport re-entry path really leave a frozen old-id duplicate kart (with the photo) on the rejoiner's screen? Structurally predicted (no playerList prune, own playerLeft never received), not yet observed — check Object.keys(playerList) and the visual in Phase 2 step 8.
- Is the once-per-frame-launch Embedded SDK handshake limitation still true on current Discord clients? All reload-path conclusions (C6) rest on the repo's 'proven live' comments from the earlier Activity spike; if Discord now permits re-handshake on reload, the reload path self-heals and fix #5's ticket-persistence work shrinks.
- Policy: should Discord Activity rooms be included in the 45s hold and reboot room_snapshots (fix #8)? Today every daily Heroku restart and every solo-player drop destroys the Activity match outright — refuted as this incident's cause, but it is the other half of 'reboot survival' the operator may expect on Discord.
- Policy: relax the server setAvatarSkin lobby gate for a verified re-seat (self-healing mid-match) vs keep lobby-only and rely on standings restore + lobby trigger? The gate is currently the only thing preventing mid-match skin swaps; a userId-matched re-seat exception looks safe (payload already validated + CDN-allowlisted) but is an auth-adjacent change that deserves its own review.
- Minor: startGameover serializes the full winner Player object (server/game.js:1992), leaking server-internal fields (verifiedUserId, deviceId) to all room clients — tighten while in the area?
- Operator terminology check: 'connection drop' vs the C7 idle-reclaim panel ('Paused — you stepped away… Tap to jump back in') — if the operator actually tapped that panel, C7 is the trigger and the kick-before-disconnect park gap (covered by fix #2) is the operative hole.


---

# Judged root-cause candidates (adversarial verification, 2 lenses each)

- **C1-avatarUrl-omitted-from-365-standings** [CONTESTED] (main): PR #365 seat restore omits avatarUrl: every re-seat path on main loses the Discord photo
  - covers: own-avatar, others-view (avatar half), recap (via C9 downstream). Does NOT explain the missing NAME on main — that requires C3/C4/C6/C7.

- **C2-avatar-reapply-trigger-starved-plus-lobby-gate** [CONTESTED] (both): The only identity re-apply path (maybeDefaultDiscordAvatar -> setAvatarSkin) is trigger-starved and lobby-gated on both ends, making any mid-match loss permanent
  - covers: Persistence mechanism for all four symptoms: converts any transient loss of own-name/own-avatar/others-view into a match-long (usually session-long) loss, which is why the recap still showed it. Also independently proves 'sign-in succeeded, only display failed' — auth.getProfile() still holds the photo (lobby skin-hub tile renders it) while the kart cannot.

- **C3-fast-reconnect-race-restores-nothing** [CONFIRMED] (main): Fast reconnect race on main: rejoin that beats the old socket's server-side disconnect restores NOTHING (name AND avatar lost despite #365)
  - covers: own-name, own-avatar, others-view (both fields, via null playerJoin/gameState packets); recap downstream via C9. Together with C2 this fully reproduces the operator report on main for a multi-occupant Discord room with a short blip.

- **C4-discord-rooms-excluded-from-hold-and-reboot-snapshots** [REFUTED] (main): Discord-instance rooms are excluded from every #365 preservation mechanism (solo-drop room deletion + no reboot snapshots)
  - covers: own-name, own-avatar, others-view — total display-identity loss for the solo-Discord-drop and dyno-restart triggers; recap downstream via C9.

- **C5-checkForTimeout-kill-switch-in-activity-iframe** [CONTESTED] (both): checkForTimeout comm watchdog sabotages recovery inside the Activity: manual disconnect kills auto-reconnect, then cross-origin reload throws
  - covers: No symptom directly; contributor/funnel — determines whether the incident hit the slow path (name back, avatar lost = C1) or, if a reload actually completed, C6. Also independently strands players (frozen canvas) on any >5s Activity outage.

- **C6-reload-recovery-rejoins-as-guest** [CONTESTED] (both): Any page-reload/navigation recovery inside the Activity is a TRUE sign-in loss: memory-only Discord ticket lost and the #365 seat token cannot re-seat a guest
  - covers: All four symptoms PLUS genuine sign-in loss. Confidence capped at medium as the observed incident's mechanism: the operator's nuance that auto-sign-in likely DID succeed (and C1-C4 explaining the symptoms with sign-in intact) argues the incident was the transport path unless a full loading screen was visible during the drop.

- **C7-idle-reclaim-kick-same-symptom-no-drop** [CONTESTED] (both): Discord deep-idle reclaim kick reproduces the identical identity loss without any network drop (and parks no standings even on main)
  - covers: own-name, own-avatar, others-view; recap downstream via C9. Alternative trigger for the same downstream loss as C3/C4.

- **C8-avatar-image-failed-latch** [REFUTED] (both): avatarImageCache permanently latches a failed image load with no retry — hides the photo for the whole session even with avatarUrl intact
  - covers: own-avatar, others-view (avatar), recap (avatar) ONLY — leaves the name rendering, so it cannot be the primary mechanism for the observed name+avatar loss.

- **C9-recap-downstream-H6-verdict** [CONFIRMED] (both): H6 verdict: PR #358 recap wiring is intact — the missing recap avatar is purely downstream of the live identity loss (no residual recap bug)
  - covers: recap — fully explained as downstream; closes H6 with 'wiring fine, symptom downstream'.

- **C10-154a113-baseline-no-restore-at-all** [CONFIRMED] (old(154a113)): Differential baseline (NOT the observed prod bug): 154a113 has zero restore machinery — every rejoin loses name AND avatar unconditionally
  - covers: own-name, own-avatar, others-view, recap (downstream) — on the OLD build only; listed to delimit exactly what #365 fixed (slow-path name) vs inherited (everything else).

- **C11-web-afk-rejoin-missing-rearm** [CONFIRMED] (main): Adjacent #365 gap (web-only, not the observed incident): AFK-kick overlay's onRejoin never re-arms the Discord avatar one-shot
  - covers: own-name, own-avatar, others-view — for the web AFK-kick path only; none of the observed Discord Activity symptoms.

## Unexplained symptoms
- None — all four observed symptom classes (rejoiner's own missing name, own missing avatar, other players' view of the rejoiner, and the missing recap avatar) are covered by C1-C9. Residual uncertainty is only WHICH main-build trigger fired in the specific incident (fast-reconnect race C3 vs solo-Discord room deletion C4 vs reload-as-guest C6 vs idle-reclaim C7 all produce the full name+avatar loss; a multi-occupant slow-path drop produces avatar-only loss via C1) — indistinguishable from the operator report alone; a prod-log check for '[auth] socket <id> resolved to user' on the rejoin, the 'Deleting room' line, or '[skin] avatar skin equipped' would disambiguate.

---

# Live e2e session addendum (2026-07-09, desktop-Discord CDP against PROD)

Ran the real thing: desktop Discord relaunched with `--remote-debugging-port=9222`, the game
iframe attached as its own CDP target (JS eval in game context), network drops emulated
per-target. Harness + scripts: session scratchpad `e2e/` (cdp.js driver, RUNBOOK.md,
drop-test/race-drop-test/drive-to-start scripts, screenshots).

**Empirical results (signed-in roknua on prod, solo room + bots):**
1. **Lobby drop (~1 min) → rejoin: identity SURVIVED** (new socket id, name+avatar+sign-in intact).
   Consistent with RC3's own mechanics: in the lobby the re-apply path (progressionUpdate after
   enterGame + lobby gate) is allowed to run — the lobby is the ONE state that self-heals.
2. **Mid-race drop (~50s) → rejoin: landed in a FRESH LOBBY in a NEW room (285→439), identity
   intact, match lost.** Solo Discord room was deleted on drop (C4's mechanism, empirically
   confirmed as the fresh-lobby/match-loss symptom — refuted only as the identity-loss cause).
   NOTE: reproducing RC1/RC2 live needs a room that SURVIVES the drop, i.e. a second human in the
   instance — that is exactly the operator's real incident topology (multi-player match).
3. **GHOST KARTS confirmed + they ACCUMULATE:** each drop+rejoin left the old socket-id entry in
   client playerList (2 after first cycle, 3 after second), frozen clones wearing name+avatar,
   persisting even ACROSS the room switch. Server HUD counted PLAYERS 1 → client-side stale
   entries (the flagged-but-unproven fix-plan item #9 is now live-reproduced; the observers'-view
   half of field reports likely = this).
4. **Browser-Discord (discord.com in Chrome): the Embedded App SDK handshake NEVER completes**
   (`sdk.ready()` hangs before orientation-lock; no auth attempt; permanent guest, no name/avatar).
   Desktop Discord works. Any field report from a browser-Discord player is full sign-in absence,
   not a rejoin regression. Untracked candidate; needs its own investigation (SDK version bump?).
5. **AFK overlay stacks on top of the reconnect overlay** (seen on dev during a server restart
   while idle: "Paused — you stepped away / Tap to rejoin" over "Connection lost"). Relates to C7.

**Environment gotchas found (dev tunnel e2e):**
- Main-checkout `.env` lacks `DISCORD_CLIENT_ID` → server injects nothing → presence/auth disabled,
  everyone a colour-named guest. Dev app id = 1509768531686723748 (added to the e2e copy);
  prod app id = 1508914256769450044. (Also: the .env file has no trailing newline — a naive
  `echo >>` append corrupts the last secret.)
- Fresh worktrees must `npm run build` — `discord-presence.bundle.min.js` is served from dist/ even
  in dev mode.
- Dev Supabase project (ukfecygtfghiybasqgtl) is PAUSED (NXDOMAIN) → `findOrCreateDiscordUser`
  returns null → token=null → guests; signed-in dev e2e blocked until the operator restores it in
  the Supabase dashboard.
- **Graceful SIGTERM hangs indefinitely when Supabase is unreachable** (shutdown snapshot write has
  no timeout; needed SIGKILL). On Heroku that means a Supabase hiccup during a dyno restart
  silently loses the shutdown snapshot (adjacent to fix-plan item #8's scope).

**Still-running infra from this session:** e2e server on :3700 (checkout
`/Users/sdodge/Documents/Projects/chaochao-e2e-3700` @ origin/main 2e57d60, DISCORD_DEBUG=1,
log in session scratchpad `serve3700-main.log`); cloudflared tunnel unchanged; desktop Discord
running with the CDP flag (relaunch normally to drop it).
