# Spike: chaochao as a Discord Activity

**Date:** 2026-06-20 · **Branch:** `worktree-discord-activity-spike` · **Status:** plan + Phase 0–2 scaffold (live verification operator-gated)

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

## Implementation plan (8 phases, ~7–8 dev-days to testable; +listing prereqs & ~2–3d skin shop for public/monetized)

### Phase 0 — Portal & dev harness *(operator-gated; ~0.5d)*
Create the Discord app, enable **Activities**, set **URL Mappings** (root `/` → tunnel host), stand up a `cloudflared`/`ngrok` tunnel to local `:3000`. See the operator recipe below.

### Phase 1 — Entry bundle + SDK bootstrap *(~1d)* — **scaffolded in this spike**
`client/discord.html` + `client/scripts/discordActivity.js` (ESM): init handshake (init → READY), `patchUrlMappings()` early, set an `isDiscord` flag, then hand off to the game. New `discord.bundle.min.js` esbuild `build()` step in `build.js`; served + prod-rewritten via `index.js`.

### Phase 2 — CSP + networking through the proxy *(~1d)* — **CSP done in this spike**
`frame-ancestors` Discord origins (**done**). Verify Socket.IO WS upgrade + polling fallback over `/.proxy/`; confirm `contentDelivery` manifests resolve; cookies (if any) `SameSite=None; Partitioned` on `discordsays.com`.

### Phase 3 — External deps: vendor/gate *(~1d)*
Vendor jQuery + Bootstrap for the Discord build (hard deps); map/vendor supabase-js + simple-keyboard; gate gtag + ad SDK off when `isDiscord`.

### Phase 4 — In-frame auth + token exchange *(~1.5d)*
`POST /.proxy/api/token` (client secret server-side) → `authorize` (scopes `identify`, `rpc.activities.write`, `guilds`) → `authenticate` → bridge to a Supabase session so cosmetics/progression work unchanged. Re-validate identity server-side; don't trust SDK-supplied user data.

### Phase 5 — Multiplayer/presence reconciliation *(~1–1.5d)*
Scope rooms by Discord `instanceId`; subscribe `getInstanceConnectedParticipants()` + `ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE`; map onto the `hostess`/`Room` model so a voice group lands in one room. Anonymize identity by default for cross-server matchmaking.

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

- **Auth bridge (Phase 4):** mint a Supabase session from the Discord token, or run Discord-authed players as a distinct lightweight identity? (Affects cross-device cosmetic persistence — see `cosmetic-persistence-invariant`.)
- **Vendor vs. map (Phase 3):** vendor jQuery/Bootstrap locally (simplest, larger bundle) or add URL mappings (keeps CDNs). Recommend vendoring for the Discord build.
- **Public listing:** decide whether/when to invest in Privacy Policy + ToS + verification.
- **Skin shop (Phase 8):** Discord-exclusive cosmetics vs. selling XP-unlockable skins (recommend exclusive); confirm the live revenue share at monetization-enable time.

## Follow-up prompt (operator-injectable)

> Continue the Discord Activity work from `docs/spikes/discord-activity.md`. Phase 0–2 scaffold is on `worktree-discord-activity-spike` (CSP origins added, `discord.html` + `discordActivity.js` SDK bootstrap, `discord.bundle.min.js` build step). I've created the Discord app (APPLICATION_ID=…, secret in env) and a tunnel; the frame loads and the READY handshake fires. Next: (1) verify/fix Socket.IO WS+polling over `/.proxy/` so a match ticks, then (2) implement Phase 3 (vendor jQuery+Bootstrap, gate gtag/ads off when isDiscord) and Phase 4 (`POST /.proxy/api/token` + authorize/authenticate bridged to a Supabase session). Mobile + desktop target — keep Phase 6 in scope.
