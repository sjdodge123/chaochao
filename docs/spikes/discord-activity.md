# Spike: chaochao as a Discord Activity

**Date:** 2026-06-20 · **Branch:** `worktree-discord-activity-spike` · **Status:** Phases 0–2 + **Phase 4 LIVE-VERIFIED** — a real match connects and ticks, AND a real Discord user is identified in-frame, bridged to a Supabase account, and defaults to their Discord-avatar skin (desktop, cloudflared tunnel, app `ChaoChao Dev` id `1509768531686723748`). See "Live bring-up results" (Phase 0–2) and "Phase 4 live results" below.

## Question

Can chaochao ship as a [Discord Activity](https://docs.discord.com/developers/activities/overview) (an embedded-iframe app using the Embedded App SDK), reusing the existing authoritative Socket.IO server, on desktop **and** mobile Discord clients?

## Verdict

**Yes — strong candidate, ~70% there.** The engine, networking model, responsive canvas, touch controls, and auth provider already fit. The gap is Discord-specific glue (Embedded App SDK + `/token` exchange, `/.proxy/` URL-mapping discipline, two CDN deps to vendor/proxy) plus two policy items for a *public* listing (Privacy Policy + ToS). Nothing structural blocks it.

---

## Audit findings (codebase vs. Discord requirements)

| # | Area | Verdict | Evidence / note |
|---|------|---------|-----------------|
| 1 | Embedding | needs-work | `index.js` CSP `frame-ancestors` lacked Discord origins (**fixed in this spike**). `client/scripts/embed.js` `isEmbedded()` (`window.self !== window.top`) already fires inside any iframe and trims chrome — reusable. |
| 2 | Networking | compatible (test WS) | Same-origin `io()` (`client/scripts/client.js`), no hardcoded server origin. WS upgrade **and** the long-polling fallback must route through `/.proxy/` — verify against the live tunnel. |
| 3 | Assets | needs-work | Game assets are relative (good). External CDNs in `play.html`: jQuery (googleapis) + Bootstrap CSS (bootstrapcdn) are **hard deps**; supabase-js + simple-keyboard (jsdelivr), gtag, gamemonetize ad SDK. Each non-Discord host needs a URL mapping or local vendoring or it fails `blocked:csp`. `cdn.discordapp.com` is exempt. |
| 4 | Auth | compatible model / needs in-frame flow | Supabase OAuth already supports **Discord** as a provider + guest fallback (`client/scripts/auth.js`); `cdn.discordapp.com` avatars allowlisted (`server/messenger.js`). But the current flow is a full-page redirect, which breaks in an iframe — replace with the SDK `authorize → /token (server) → authenticate` flow. |
| 5 | Hosting/HTTPS | compatible | Heroku terminates TLS; app speaks HTTP behind it; port is config/`PORT`-driven. Discord just needs a public HTTPS URL to map. |
| 6 | Mobile/touch | compatible | Mobile viewport + `viewport-fit=cover` (`play.html`), on-screen joystick/buttons (`input.js`, `joystick.js`). Add Discord safe-area insets when mobile is enabled. |
| 7 | Sizing | compatible | `game.js resize()` fits canvas to its **container** (not `window`) at uniform 16:9 with DPR cap — exactly right for Discord's variable iframe. Re-check the `innerWidth<900` perf-tier demotion under embed dimensions. |
| 8 | Analytics/3rd-party | needs-work | gtag/GA4 + ad SDK degrade to no-ops (safe) but should be gated off when embedded to avoid `blocked:csp` noise; Discord disallows third-party ad networks anyway. |

---

## Key technical findings (the real integration wrinkles)

1. **`/.proxy/` is the whole game.** All traffic is forced through `https://<APPLICATION_ID>.discordsays.com`; any request to a non-mapped external host fails with `blocked:csp`. Relative requests must be prefixed `/.proxy/`. The SDK's `patchUrlMappings()` monkey-patches `fetch`/`WebSocket`/`XMLHttpRequest.open` so dev (un-sandboxed) and prod (sandboxed) behave the same — **use it, always-`.proxy/`**.

2. **Bundle-model mismatch.** chaochao's `build.js` uses esbuild `transform` on *concatenated global-sharing scripts* — it does **not** resolve `node_modules` imports. The Embedded App SDK is an ESM npm package. So the Discord entry needs a real esbuild `build()` step (bundle + IIFE) separate from the existing concat path. This spike adds that step for `discord.bundle.min.js` and proves the SDK bundles.

3. **Separate entry, not a `play.html` retrofit.** A 4th entry (`discord.html` → `discord.bundle.min.js`) keeps the Discord SDK/auth out of the web + portal builds entirely. The harness initializes the SDK, then hands off to the existing game.

4. **Token exchange stays server-side.** Client secret never enters the bundle; add `POST /.proxy/api/token` on the existing Express server (Phase 4).

5. **WebRTC is blocked** in the sandbox — irrelevant to chaochao (Socket.IO/WebSocket only), but noted.

---

## Live bring-up results (Phase 0–2, verified 2026-06-20 desktop)

A real chaochao match connects and **ticks** inside the Discord Activity iframe on
desktop (Socket.IO over `/.proxy/` — `GAME …`, ~21 ms ping, terrain/stations/boons
rendering, round timer running). Socket.IO over the proxy needed **no** transport
change — the existing `["websocket","polling"]` + `tryAllTransports` config just
works. The actual blockers were elsewhere; five fixes landed on this branch:

1. **jQuery is a hard boot dep, and the sandbox CSP-blocks external `<script src>`.**
   `game.js` wraps its whole boot in `$(function(){…})`, so with jQuery's googleapis
   CDN blocked the page threw before connecting. `patchUrlMappings()` only reroutes
   fetch/WS/XHR, **not** parser-loaded `<script>`/`<link>`. Fix: vendor jQuery 3.5.1 +
   Bootstrap 4.1.3 under `client/vendor/`; the Discord handoff loads `play.html?discord=1`
   and the server swaps those two CDN tags for the local copies + drops the gtag loader
   for that request only (web build byte-identical). *(commit `a567025`)*
2. **Discord loads the Activity at the mapped ROOT `/`**, which served the marketing
   landing page, not the SDK bootstrap. The Discord client always appends launch params
   (`frame_id` is required by the SDK), so serve `discord.html` at `/` when `frame_id` is
   present; plain web `/` still gets the landing page. *(commit `525756b`)*
3. **Iframe keyboard focus.** All key/mouse handlers bind on `window`, which only gets
   keyboard events while the frame holds focus — so clicking Discord's chat stole WASD,
   and the first click back into the cross-origin frame was eaten focusing it (making DOM
   controls look dead). Fix: reclaim focus via `window.focus()` on pointer/touch when
   `isEmbedded()` (also benefits the CrazyGames/Poki/itch embeds). *(commit `3e13a57`)*
4. **AFK kick / leave navigated to `index.html`** — a dead end in-frame (its links lack
   `?discord=1`). Re-enter a fresh game (`play.html?discord=1`) in the Activity context
   instead. *(commit `1993e4b`)*
5. **Inline `on*=""` handlers don't fire in the sandbox.** The emoji wheel's close-X and
   emoji-send used inline `onclick=`; only real `addEventListener` handlers run in-frame
   (which is why right-click closed but left-click didn't). Replaced with one delegated
   `addEventListener` on `#emojiMenu` (`data-emoji-close` marks the X). This was the only
   inline handler in `play.html`. *(commit `2c8d98c`)*

**Operator setup that worked:** reused the existing OAuth app `ChaoChao Dev`; Activities
can't be enabled until a URL Mapping exists, so the order is tunnel-first → set Root
Mapping `/` → `<tunnel-host>` → enable Activities. `cloudflared tunnel --url
http://localhost:3000` (no account); `DISCORD_CLIENT_ID` set in the server env;
`DISCORD_MAPPING_TARGET` left unset (same-origin is correct for a root mapping). Quick
tunnels are ephemeral — the URL changes on restart and must be re-pasted into the mapping.

**Known follow-ups surfaced in-frame (not blockers):** AFK re-entry loops while idle (a
proper fix suppresses the AFK kick in Activities or shows an in-frame "click to rejoin"
panel); "Leave" can't truly exit (Discord closes the Activity via its own UI); the
`discord.html → play.html` redirect drops the SDK instance, so Phase 4/5 (auth/presence)
will want the game hosted in the Activity frame (or the SDK re-init'd) rather than redirected.

## Phase 4 live results (in-frame auth, verified 2026-06-20 desktop)

A real Discord user (`roknua`) signs in **inside the Activity** — no full-page OAuth
redirect — is bridged to a real Supabase user, and the game recognises them (log:
`exchange OK -> handshake token minted` → `socket … resolved to user <uuid>`). Their
Discord picture is their default kart skin. The shipped design + the fixes the live
bring-up forced:

**Auth-bridge decision (operator-resolved): server-minted ticket + identity-match.**
- `POST /api/token` (`server/discordAuth.js`, owns `DISCORD_CLIENT_SECRET`) exchanges the
  `authorize()` code, RE-VALIDATES via Discord `/users/@me` (never trusts SDK-supplied
  user data), then bridges to Supabase: `findOrCreateDiscordUser()` matches the validated
  snowflake to an existing account (web "Continue with Discord" OR a prior Activity launch)
  so unlocks carry over, else admin-creates + links one. Two-way unification via a
  SECURITY DEFINER migration (`find_user_by_discord_id` / `link_discord_identity`,
  service_role only) — applied + e2e-verified against the dev DB.
- **No shared HS256 secret exists** — the project signs with asymmetric keys
  (`SUPABASE_JWT_SECRET` is blank; the server runs `network verify`). So we can't mint a
  "real" Supabase token. Instead the bridge mints OUR OWN session ticket (HS256 with a
  server-only secret derived from the service-role key — stable across restarts, no new
  env var), and `verifyToken()` accepts it (issuer `chaochao-activity`) BEFORE the
  Supabase paths. The handshake then treats a Discord player exactly like a web player.
- **No client-side supabase-js in-frame** — the bridge is entirely server-side, so the
  leftover Phase 3 supabase-js vendoring is NOT needed for auth.

**The SDK-instance-drop:** auth runs in `discord.html` (where the SDK lives) and stashes
the minted ticket + validated profile in `sessionStorage` BEFORE the existing redirect to
`play.html?discord=1`; `auth.js` reads the stash and drives the socket handshake +
profile. (Hosting the game in-frame / re-init'ing the SDK was the heavier alt; deferred.)

**The blocker that ate ~5 relaunches — `patchUrlMappings`.** The in-frame `fetch('/api/token')`
silently never left the frame (guest fallback). Root cause: `discordActivity.js` called
`patchUrlMappings([{prefix:'/', target:''}])`, which monkey-patches fetch/XHR to rewrite
EVERY same-origin URL — with a root prefix + empty target the rewrite was malformed. The
Activity's **root URL Mapping already proxies all same-origin paths** (that's why the
game's Socket.IO on play.html, which never patches, connects fine), so `patchUrlMappings`
was both unnecessary and breaking. **Removed it; same-origin requests use plain relative
paths and ride the root mapping.** (For mapping EXTERNAL hosts it'd still be the tool.)

**Cache-busting was essential to even debug this:** Discord's sandbox caches in-frame JS
hard despite `no-cache`, and the bundle/script filenames are stable, so fixes appeared not
to take. The server now stamps the `discord.bundle` URL with its mtime and every in-frame
`play.html` script src with the server-boot id (both only for the Activity requests).

**Scopes:** `authorize({ identify, rpc.activities.write, guilds, rpc.voice.read })` —
`rpc.voice.read` wired now so Phase 5b lights up without re-consent.

**`rpc.voice.read` note:** the app owner consented fine in dev; confirm it's permitted
before relying on it for non-dev users (Phase 5b degrades silently if denied).

## Phase 5 as-built (instance→room routing + participant presence, 2026-06-20)

Everyone who launches the Activity in the same Discord voice channel now lands in the
**same chaochao room**; a different voice channel / instance gets a separate room.
Built on `worktree-discord-activity-spike`, headless-verified (instance-routing assertions
+ `npm run build` + `smoke-test.js` all green); **pending operator in-frame confirm**.

**The SDK-instance-drop (the central problem) — solved with approach (a).** Auth runs in
`discord.html`, then the redirect to `play.html?discord=1` *drops* the SDK instance — but
room-grouping needs `sdk.instanceId` in the *game* frame. New `client/scripts/discordPresence.js`
(a 2nd esbuild `build()` IIFE bundle, `discord-presence.bundle.min.js`, like discordActivity.js)
**re-inits the SDK in the game frame** and silently re-authenticates with the access token
already stashed in `sessionStorage` (Phase 4 kept it for exactly this; the one-time `code`
is spent, but the access token is reusable). discordActivity.js now also stashes the
`clientId` so presence can `new DiscordSDK(id)` without play.html needing a config tag.
Chose (a) over hosting the game in-frame: far lighter, and the redirect architecture +
the stashed token were already in place. index.js injects the presence bundle into
`play.html?discord=1` only (the `<!-- DISCORD_PRESENCE -->` placeholder; web build
byte-identical), before the game bundle so `window.discordPresence` exists in time.

**`window.discordPresence` API (the clean map Phase 5b reuses):**
- `.ready` → `Promise<{instanceId}>` — **never rejects**; resolves with `instanceId:null`
  on any init failure (8s backstop) so the game still launches. Resolves right after
  `sdk.ready()` (instanceId needs no auth), so room routing proceeds even if `authenticate()`
  later fails.
- `.instanceId` / `.channelId` / `.localUserId` — room key, voice channel (5b), local snowflake.
- `.getParticipants()` → `[{ id, name, avatarUrl, isLocal, bot, raw }]` — the live
  connected-participant list (Discord `user_id` → name/avatar), seeded from
  `getInstanceConnectedParticipants()` and kept current via the `ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE`
  subscription. `avatarUrl` is built the same way as the server (`avatarUrlFor`) so the 5b
  voice tray matches kart avatar skins.
- `.onParticipants(cb)` — subscribe to list changes (emits current state immediately). **This
  is the participant↔player hook Phase 5b lights the speaking kart from.**
- `.sdk` — the live instance for 5b's `subscribe('SPEAKING_START'/'SPEAKING_STOP', {channel_id})`.

**Routing (server).** Client: `clientSendStart` defers `enterGame` until `discordPresence.ready`,
then passes `{ discordInstanceId }` as a new 3rd opts arg (the legacy `coop` 2nd arg is
untouched). Server: `messenger.enterGame` reads/sanitizes `opts.discordInstanceId` (untrusted
grouping key — capped, char-filtered, never a trust boundary) and, when present, routes via
new `hostess.findOrCreateRoomForInstance(instanceId)` — which **takes precedence over the
matchmaking `id`** but still loses to the botGuard tarpit. The hostess keeps an
`instanceRoomMap` (instanceId → sig), tags the room `room.discordInstanceId`, returns a
started/locked room too (same voice group → late-join spectator, race next round), and spills
into a fresh room if one fills. The mapping is forgotten when the room empties
(`forgetInstanceRoom`, hooked into the existing `kickFromRoom` teardown — **integrates with
the existing disconnect/AFK lifecycle rather than adding a parallel one**: participant-leave
*is* the socket disconnect that already removes the player; couch co-op secondaries follow the
primary's gameID into the same room). **The web path is unchanged when no instanceId is present.**

**Identity anonymization (plan item).** Discord-keyed rooms are kept **private**: excluded from
`getRooms()` (never on the public join page) and `findARoom()` (web players never matchmade in).
So a Discord voice group is isolated — Discord players never mix with strangers — which
*structurally satisfies* the "anonymize for cross-server matchmaking" requirement: there is no
cross-server mixing to anonymize, and the only identity shown (the opt-in Discord avatar skin)
stays within the same voice group and is purely cosmetic.

**Files:** `client/scripts/discordPresence.js` (new), `discordActivity.js` (stash clientId),
`build.js` (2nd discord bundle), `client/play.html` (placeholder), `index.js` (inject + cache-bust),
`client/scripts/client.js` (`clientSendStart` defer+opts), `server/hostess.js` (instance map +
isolation + cleanup), `server/messenger.js` (route on `opts.discordInstanceId`). No
`game.js`/`config.json`/`engine.js` change → no CHANGELOG/Codex entry required (routing/infra).

**Next (Phase 5b):** wire `discordPresence.onParticipants` + `sdk.subscribe('SPEAKING_*')` to a
per-kart speaking indicator. The kart bridge (Discord snowflake → which kart) still needs the
server to stamp each player's validated snowflake (Phase 4's `discordAuth` validates it but the
profile sent to the client omits the id) — a small 5b addition.

## Phase 5b as-built (voice-activity visual, 2026-06-20)

Who's talking now shows in-game — a green **speaking ring** pulses beneath a kart whose
Discord user is talking, and a **voice tray** (a vertical column of participant avatars
down the left edge) glows the active speaker. Built on `worktree-discord-activity-spike`,
headless-verified (voice-id relay e2e + `npm run build` + `smoke-test.js` all green);
the SPEAKING visuals themselves need a real multi-user Discord voice channel to eyeball.

**Speaking events.** `discordPresence.js` (the in-frame SDK from Phase 5) subscribes
`SPEAKING_START`/`SPEAKING_STOP` on `sdk.channelId` (needs `rpc.voice.read`, already in the
Phase-4 scopes) and maintains a speaking set keyed by Discord `user_id`. New presence API:
`.isSpeaking(id)`, `.getSpeaking()`, `.onSpeaking(cb)`, plus `.localUser` (Promise resolving
the local snowflake). Degrades silently if the scope is denied or there's no voice channel.

**The snowflake→kart bridge (resolved: client-supplied, cosmetic).** SPEAKING events carry a
Discord `user_id`; karts are keyed by socket id, so each client needs `user_id → kart`. The
local SDK only knows the *local* user's snowflake, so the client reports its own snowflake to
the server (`setVoiceId`), which stamps `player.discordUserId` and relays it to the room two
ways: in the spawn/append packet (compressor `newPlayerPacket[18]`, decoded in lockstep in
`gameboard.updatePlayerList`) for late joiners, and a live `playerVoiceId` broadcast for the
common case where the id resolves *after* spawn (Discord `authenticate()` settles after
`enterGame`). This is **client-supplied on purpose** — it's exactly the cosmetic, non-trust
boundary Phase 5 set for presence data (worst-case spoof just lights the wrong kart's ring,
no gameplay effect), so it needs no auth-token / `discordAuth` change. Server-validated
(`/^[0-9]{1,20}$/`), allowed in any state (voice matters mid-race).

**Render (both gated on `isDiscord`; web/portal builds untouched).** New
`client/scripts/discordVoice.js` (normal play bundle — reads `window.discordPresence`, does
NOT import the SDK): (a) `drawSpeakingIndicator(player, sx, sy)` — a cheap pulsing arc+stroke
(no shadow/filter surfaces, per the cosmetic-perf notes), called next to `drawTeamUnderglow`
in both kart paths (live `drawPlayer` + the `drawKartAppearance` chokepoint, so it also shows
in the overview/reflection/recap); (b) a DOM voice tray (avoids tainting the canvas with
remote `cdn.discordapp.com` avatars), rebuilt from `onParticipants` and class-toggled from
`onSpeaking`.

**Files:** `client/scripts/discordPresence.js` (SPEAKING sub + speaking API + `.localUser`),
`client/scripts/discordVoice.js` (new — ring + tray), `server/compressor.js` (+field [18]),
`client/scripts/gameboard.js` (decode [18]), `server/messenger.js` (`setVoiceId`→`playerVoiceId`),
`client/scripts/client.js` (emit `setVoiceId` + handle `playerVoiceId`), `client/scripts/draw.js`
+ `draw_skins.js` (ring calls), `build.js` + `client/play.html` (bundle `discordVoice.js`). No
`game.js`/`config.json`/`engine.js` change → no CHANGELOG/Codex entry (Discord-only cosmetic UI).

## ⚠️ Architecture correction — approach (a) is dead; we shipped approach (b) (no-navigation, 2026-06-20)

The Phase 5 / 5b sections above describe the FIRST cut (approach (a): re-init the SDK in
the navigated game frame). **Live testing proved approach (a) cannot work**, and the build
was reworked to **approach (b): no navigation — the game IS the Activity entry and the SDK
initialises once, in that frame.** This is now **live-verified on desktop** (routing, in-frame
auth, participant tray, and the on-kart speaking ring all work). Read THIS section as the
current truth; the two above are kept for the API shape + the diagnosis trail.

**Why approach (a) failed (proven, not theorised).** The discord.html→play.html redirect
breaks the SDK two ways, both confirmed via a server-logged in-frame diag (`DISCORD_DEBUG=1`
→ `discordDiag`):
1. `new DiscordSDK()` reads its launch params (`frame_id`, `instance_id`, `platform`) from
   the URL — the clean `play.html?discord=1` dropped them (`"frame_id query param is not
   defined"`). *Forwarding the params got past this.*
2. Then `sdk.ready()` hangs forever. Root cause (SDK source `getRPCServerSource`): the SDK
   posts its handshake — and every later RPC — to `window.parent` with
   `targetOrigin = document.referrer`. After the same-origin navigation `document.referrer`
   is *discord.html's own URL*, not the Discord client origin, so the `postMessage` is
   dropped and `READY` never arrives. Forcing `sdk.sourceOrigin = '*'` + re-handshake STILL
   got no READY → **the Discord client completes the RPC handshake only ONCE per Activity
   frame, already consumed by discord.html.** A re-init in a navigated frame is impossible.

**Approach (b) as-built.**
- **Entry:** `index.js` serves `play.html` (with the Discord rewrite) at the mapped root
  when `frame_id` is present — *no* discord.html redirect. `<!-- DISCORD_CONFIG -->` +
  `<!-- DISCORD_PRESENCE -->` are injected into play.html.
- **One module, one SDK:** `client/scripts/discordPresence.js` is now the unified in-frame
  bootstrap — `new DiscordSDK()` + `ready()` → `authorize()` → `POST /api/token` →
  `authenticate()` → instanceId/participants/SPEAKING. The single live handshake (referrer
  is the Discord origin because there's no navigation) powers everything. `discordActivity.js`
  / `discord.html` are now DEAD (kept in-tree; candidates to delete before PR).
- **Auth handoff (no redirect):** the bootstrap calls `chaochaoAuth.adoptDiscordSession(token,
  profile)` (new in `auth.js`); `auth.js` detects the Activity context (`frame_id`), skips
  building a Supabase client, and makes `ready` await that adoption. `game.js`'s connect-gate
  waits on `chaochaoAuth.ready` with a **12s cap for Discord** (vs 2s web) so the socket
  handshake carries the token.
- **`isDiscordActivity()`** now keys on `frame_id` (or legacy `discord=1`).
- **localUserId fix:** `authenticate()` must be called ONCE — a second call throws "Already
  authenticated" and left `localUserId` null (no kart ring). The snowflake is captured from
  the single call.

**Codex review (P2) — FIXED.** If the in-frame OAuth finishes *after* the 12s connect-gate
cap (player lingered on consent), the socket already connected as guest and Socket.IO can't
re-auth a live connection. `adoptDiscordSession` now triggers a **one-shot `location.reload()`**
(sessionStorage-guarded) so the now-consented silent auth beats the gate. Safe because a
reload preserves the original Discord referrer (only cross-*page* nav broke it).

**AFK-rejoin voice-tray-disappears — FIXED.** The AFK/menu-exit path did
`window.location.href = <same Activity URL>` — a navigation that reset `document.referrer`
and killed the SDK (tray vanished). New `menuExit()` does `location.reload()` in the Activity
(SDK survives) and the normal nav on web.

**Verified:** desktop in-frame (routing → `Discord instance … -> room …`; auth OK; tray shows
participants; ring pulses on speak), `npm run build`, `smoke-test.js`, headless instance-route
+ voice-id e2e. **Diagnostic instrumentation** (`discordDiag` → server log under
`DISCORD_DEBUG=1`, `discordPresence.getDiag()`) is in-tree — decide keep-vs-strip before PR.

**Still open:**
- **Phase 6 mobile** — portal mobile platform enabled but Discord mobile still returns
  *"This Activity is not currently available on this OS"* (a client-side platform gate before
  our code runs; suspect manifest cache → force-quit the mobile app / propagation delay).
  Phase 6 CODE polish (safe-area insets, `innerWidth<900` perf-tier recheck under embed dims,
  voice-tray sizing on narrow screens) is NOT started.
- **Idle AFK loop** in the Activity (rejoin→idle→kick→rejoin) — pre-existing follow-up; the
  proper fix suppresses the AFK kick in Activities or shows a "click to rejoin" panel.
- **Dead code:** `discord.html` + `discordActivity.js` (+ the `discord.bundle` build step) are
  unused under approach (b) — delete before PR.
- **Not pushed / no PR** (operator gate).

## Implementation plan (9 phases; ~7–8 dev-days to testable, +~1d voice-activity delighter, +listing prereqs & ~2–3d skin shop for public/monetized)

### Phase 0 — Portal & dev harness *(operator-gated; ~0.5d)*
Create the Discord app, enable **Activities**, set **URL Mappings** (root `/` → tunnel host), stand up a `cloudflared`/`ngrok` tunnel to local `:3000`. See the operator recipe below.

### Phase 1 — Entry bundle + SDK bootstrap *(~1d)* — **scaffolded in this spike**
`client/discord.html` + `client/scripts/discordActivity.js` (ESM): init handshake (init → READY), `patchUrlMappings()` early, set an `isDiscord` flag, then hand off to the game. New `discord.bundle.min.js` esbuild `build()` step in `build.js`; served + prod-rewritten via `index.js`.

### Phase 2 — CSP + networking through the proxy *(~1d)* — **CSP done in this spike**
`frame-ancestors` Discord origins (**done**). Verify Socket.IO WS upgrade + polling fallback over `/.proxy/`; confirm `contentDelivery` manifests resolve; cookies (if any) `SameSite=None; Partitioned` on `discordsays.com`.

### Phase 3 — External deps: vendor/gate *(~1d)*
Vendor jQuery + Bootstrap for the Discord build (hard deps); map/vendor supabase-js + simple-keyboard; gate gtag + ad SDK off when `isDiscord`.

### Phase 4 — In-frame auth + token exchange *(~1.5d)* — **DONE, LIVE-VERIFIED**
`POST /api/token` (client secret server-side) → `authorize` → `authenticate` → bridge to a real Supabase user via a server-minted session ticket so cosmetics/progression work unchanged. Re-validate identity server-side. See "Phase 4 live results" above for the as-built design + the `patchUrlMappings` fix.

### Phase 5 — Multiplayer/presence reconciliation *(~1–1.5d)* — **DONE (headless-verified), pending operator in-frame confirm**
Scope rooms by Discord `instanceId`; subscribe `getInstanceConnectedParticipants()` + `ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE`; map onto the `hostess`/`Room` model so a voice group lands in one room. Anonymize identity by default for cross-server matchmaking. See "Phase 5 as-built" above for the as-shipped design (SDK re-init in the game frame, `window.discordPresence` map, instance-keyed private rooms).

### Phase 5b — Voice-activity visual (Discord-only delighter) *(~1d; depends on Phase 4 scope + Phase 5 presence)* — **DONE (headless-verified), pending operator multi-user in-frame confirm**
See "Phase 5b as-built" above for the as-shipped design (SPEAKING subscription, the client-supplied snowflake→kart bridge, the on-kart speaking ring + DOM voice tray).
Show who's talking, in-game — the touch that makes the Activity feel genuinely Discord-native. The SDK emits `SPEAKING_START` / `SPEAKING_STOP` (payload `{channel_id, user_id}`) for the subscribed voice channel.

- **Scope:** add `rpc.voice.read` to the `authorize()` scopes (wire in Phase 4).
- **Subscribe:** after auth, get the voice channel id (`sdk.channelId`) and `sdk.subscribe('SPEAKING_START', {channel_id}, …)` / `'SPEAKING_STOP'`.
- **Map:** Discord `user_id` → in-game kart via the Phase 5 participant↔player mapping; toggle an `isSpeaking` flag per player (server-broadcast so all clients render it, or client-local if the indicator is only for the local view).
- **Render (two surfaces, like other Discord Activities):** (a) a speaking indicator **on the kart** — reuse an existing draw path (a pulsing underglow ring like the team glow, or a small mic glyph above the kart in `draw.js` / `draw_skins.js`); and (b) an optional **voice tray** — a small row of participant avatars (`cdn.discordapp.com`, already allowlisted) that highlight the active speaker. Both gate on `isDiscord`; web/portal builds unaffected.
- **Caveat:** events fire only for the subscribed channel and need scope consent — degrade silently if denied. Confirm `SPEAKING_*` is exposed by the current SDK during build (historically gated; supported for Activities now, but verify).

### Phase 6 — Mobile polish *(~1d; mobile enabled per operator choice)*
Enable mobile in the portal; wire `--discord-safe-area-inset-*` (with `env()` fallback); re-check `innerWidth<900` Auto perf demotion under embed dims; optional thermal-state subscription → degrade rendering (chaochao already has perf tiers).

### Phase 7 — Listing prerequisites *(non-code; public-only)*
Publish **Privacy Policy + ToS** (neither exists today — hard blocker for Discovery); app **verification** → fill Discovery settings → Enable Discovery; confirm content-policy compliance. No allowlist/partner gating remains.

### Phase 8 — Skin shop (in-app purchases) *(~2–3d; depends on Phase 4)*
Monetize cosmetics via Discord's Embedded App SDK IAP — the blessed model, a clean fit for the planned purchasable-skin catalogue (chaochao's native unlocks stay **gameplay rewards**; bought skins are a separate paid layer).

- **Eligibility (operator, gating):** Enable Monetization for the app (verification + team/payout setup + age/region requirements — a stricter gate than running an Activity). Confirm the current revenue share when enabling — reported ~10% to Discord (you keep ~90%), but sources vary up to 30%, so verify.
- **SKUs:** each purchasable skin = one **DURABLE** SKU (permanent entitlement). Reserve **CONSUMABLE** for any repeatable buys (none planned). Create SKUs in the portal (publish "Store and the API" or "API Only").
- **Storefront:** build the shop UI inside the Activity (reuse the existing skin-hub/preview rendering — `skinRegistry.js`, recap/preview paths). List SKUs; on select call `discordSdk.commands.startPurchase(skuId)`.
- **Grant flow:** subscribe to `ENTITLEMENT_CREATE`; **verify the entitlement server-side** via Discord's HTTP API ("trust the SDK, verify via API"), then write the unlock into the existing cosmetic-ownership store. The Discord entitlement → an unlock record for that player.
- **Identity dependency:** entitlements exist only for Discord-authed players → requires Phase 4 (Discord token → Supabase session) so there's an account to attach ownership to. Honour [[cosmetic-persistence-invariant]]: signed-in = server-DB authoritative; never mirror paid unlocks through guest localStorage.
- **Design guardrails:** prefer **Discord-exclusive** cosmetics over selling XP-unlockable skins (avoids pay-to-skip devaluing progression). Keep paid items purely cosmetic — no gameplay advantage.
- **Caveat:** Activities are an additive revenue surface (thousands–tens-of-thousands of plays), not a primary funnel — size expectations accordingly.

> **Advertising is NOT a Discord monetization path.** Third-party ad SDKs (chaochao's `ads.js` / gamemonetize) are CSP-blocked in the sandbox *and* off-policy; the only platform ad surface is Discord-run **Quests** (opt-in, Discord-controlled, not a dev lever). Gate ads off when `isDiscord` (Phase 3) and treat in-Activity ad revenue as zero. The skin shop is the monetization strategy for this build.

---

## Operator test recipe (Phase 0, needed to verify the scaffold live)

The scaffold can't be verified headlessly — it needs a real Discord app + a public tunnel. Steps:

1. **Create the app:** https://discord.com/developers/applications → New Application. Note `APPLICATION_ID` and (Settings → OAuth2) the **Client Secret**.
2. **Enable Activities:** app → **Activities** → toggle on (auto-creates a Launch entry point).
3. **URL Mappings:** app → Activities → URL Mappings → add root `/` → `<your-tunnel-host>` (bare host, no `https://`).
4. **Tunnel to local:**
   ```bash
   # terminal 1 — the game (worktree)
   cd /Users/sdodge/Documents/Projects/chaochao/.claude/worktrees/discord-activity-spike
   npm install && npm run build && PORT=3000 node index.js
   # terminal 2 — public HTTPS tunnel
   cloudflared tunnel --url http://localhost:3000   # or: ngrok http 3000
   ```
   Put the tunnel's host in the URL Mapping (step 3). The Activity entry URL is `discord.html`.
5. **Launch in Discord:** Developer Mode on → join a voice channel → Activities → your app (in-development apps appear for the dev). Open devtools in the Activity frame.
6. **What to confirm:** frame loads (no CSP block — the `frame-ancestors` fix), `discordActivity.js` logs the READY handshake, and a match **connects + ticks** (Socket.IO over `/.proxy/`). That last point is the spike's core de-risking goal.

---

## Open decisions for the operator

- **Auth bridge (Phase 4):** ✅ RESOLVED — server-minted session ticket + identity-match (see "Phase 4 live results"). The FK from `progression` to `auth.users` forces a real Supabase user either way; matching the Discord snowflake carries existing web unlocks over. No client-side supabase-js, no dashboard wiring.
- **Vendor vs. map (Phase 3):** vendor jQuery/Bootstrap locally (simplest, larger bundle) or add URL mappings (keeps CDNs). Recommend vendoring for the Discord build.
- **Public listing:** decide whether/when to invest in Privacy Policy + ToS + verification.
- **Skin shop (Phase 8):** Discord-exclusive cosmetics vs. selling XP-unlockable skins (recommend exclusive); confirm the live revenue share at monetization-enable time.

## Follow-up prompt (operator-injectable)

> Continue the Discord Activity work from `docs/spikes/discord-activity.md` on `worktree-discord-activity-spike` (NOT pushed). Read the **"⚠️ Architecture correction — approach (b)"** section first: Phases 0–5b are DONE and desktop-live-verified — the game is served in-frame at the Activity root (no discord.html redirect), the SDK inits once in `discordPresence.js` for auth+instance→room routing+voice, and the on-kart speaking ring + avatar voice tray work. Codex's one P2 (late-token guest connect) and the AFK-rejoin tray-disappears bug are both fixed via `location.reload()` re-entry (reload preserves the SDK; cross-page nav does not). Open items, pick per priority: (1) **Phase 6 mobile** — I enabled the portal mobile platform but Discord mobile still says "not available on this OS" (client-side gate, likely manifest cache — confirm force-quit/propagation first); then the CODE polish: safe-area insets, `innerWidth<900` perf-tier recheck under embed dims, voice-tray sizing on narrow screens. (2) **Pre-PR cleanup:** delete the now-dead `discord.html` + `discordActivity.js` + the `discord.bundle` build step (approach (b) doesn't use them), and decide keep-vs-strip on the `DISCORD_DEBUG`/`discordDiag`/`getDiag()` diagnostics. (3) Phase 5b polish if wanted (ring color/steadiness; tray only renders for Discord-voice players by design). A `DISCORD_DEBUG=1` dev server is on :3700 behind the operator's cloudflared tunnel; relaunch the Activity to re-test in-frame (read `[discordDiag]`/`Discord instance` lines from the server log). Don't push or open a PR without the operator's go-ahead.
