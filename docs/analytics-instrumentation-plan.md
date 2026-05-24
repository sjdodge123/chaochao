# Analytics Instrumentation & Data Hygiene Plan

**Branch:** `worktree-analytics-instrumentation`
**Status:** plan only — implement this.
**Why this is the next step:** A GA4 review (2026-05-23) showed the all-time "1.8K users"
topline is ~90% data-center/bot traffic (China ~50%, Singapore ~43%, both ~0s engagement).
The real audience is ~300 genuinely-engaged **US desktop** players, but GA fires **only
default/enhanced-measurement events** (`page_view`, `session_start`, `scroll`, `first_visit`,
`form_submit`) — so we are blind to actual gameplay and retention. Before driving any traffic
(portals/SEO), we must (A) clean the data and (B) instrument real gameplay events, so we can
tell whether distribution actually produces players who play and return.

**Scope:** client-side analytics events + GA config. Nothing else. No gameplay logic changes,
no server changes.

---

## Constraints (read first)

- **Stay client-side.** All events fire from the browser via `gtag('event', ...)`. Do NOT
  touch `server/game.js`, `server/engine.js`, or `server/config.json` — those trigger the
  release-notes-check workflow. (Note: `client/scripts/game.js` is the *client* file and is
  fine to edit; the protected one is `server/game.js`.) This task needs no CHANGELOG entry.
- **GA tag coverage:** the gtag snippet is currently confirmed only in `client/index.html`
  (lines ~8-16, measurement ID `G-832XFC4F84`). It must be present on every page where we
  want events — `play.html`, `join.html`, `create.html` — or events there silently no-op.
  Add the same gtag snippet to those pages' `<head>` (or factor a shared include).
- **Bundle rule:** if you add a new client script file (e.g. `analytics.js`), register it in
  BOTH `build.js`'s bundle list for each page AND that page's `<!-- BUILD: bundle-start --> …
  <!-- BUILD: bundle-end -->` block (per CLAUDE.md). Inline `gtag('event', …)` calls at the
  hook points avoid this, but a tiny shared `trackEvent()` wrapper is cleaner — your call.
- **Don't double-count / don't break gameplay.** Events are fire-and-forget; never block or
  await them in the game loop. Guard for `typeof gtag === 'function'` so missing gtag can't
  throw.

---

## Part A — Custom gameplay events (code)

Add a thin helper, e.g. `function trackEvent(name, params){ if (typeof gtag==='function') gtag('event', name, params||{}); }`
and call it at these hook points. Event names use GA4 snake_case.

**Landing page (`client/index.html`):**
- `cta_click` with `{ target: 'play' | 'join' | 'create' }` on the Play/Join/Create
  buttons (`#playButton`, `#joinButton`, `#createButton`). Measures landing→game conversion.

**In-game client (`client/scripts/client.js` socket handlers — these already exist):**
- `match_start` — when the local player actually begins a match. Fire when the client enters
  the racing state (find where `currentState` becomes `config.stateMap.racing`). Include
  `{ players: <count if available>, map: <map name/id if available> }`.
- `lobby_entered` — in the `startLobby` handler (`client.js:208`). Optional but useful for
  funnel (joined a room vs. actually played).
- `round_complete` — in the `startOverview` handler (round transition).
- `match_end` — in the `startGameover` handler (`client.js:245`). Include
  `{ won: (packet.winner === myID) }` so we can later distinguish winners. This is the key
  retention signal (a completed match).

**Map editor (`client/scripts/create.js`):**
- `map_submitted` on a successful `submitNewMap` (distinct from the auto `form_submit`).

Keep params minimal and non-PII. No player names, no IDs beyond what's already public.

## Part B — GA4 data hygiene (operator does this in the GA UI; document it)

The implementing agent can't do these (no GA access) — include them as a checklist in the PR
description / a short README note so the repo owner can action them:

1. **Internal/developer traffic:** Admin → Data Streams → (web stream) → Configure tag
   settings → "Define internal traffic" → add the dev's IP. Then Admin → Data Settings →
   Data Filters → set the **Internal Traffic** filter to **Active** (not just Testing).
   Removes the dev's own testing from reports.
2. **Known-bot filtering** is automatic in GA4 (IAB/MRC list, can't be disabled) — note that
   the China/Singapore traffic is NOT on that list (it's data-center/headless), so:
3. **Real-users comparison for ongoing analysis:** GA4 standard data filters only support
   internal/developer exclusion, so the data-center spam can't be fully removed from reports.
   Create a saved **Comparison** (or Exploration segment) such as `Engaged sessions > 0` or
   `Country = United States` to analyze real users going forward.
4. **Optional follow-up (not this task):** block the data-center spam at the edge
   (Cloudflare/host rules) if it keeps polluting — flag it, don't build it here.
5. **Mark a key event:** once `match_end` (or `match_start`) appears in Admin → Events,
   toggle it as a **Key event** so engagement/retention reports populate on real gameplay.

---

## Verification

1. `npm start`, open each page, perform the actions (click CTAs, play a match to gameOver,
   submit a map). In GA4 **DebugView** (or Realtime) confirm each custom event fires with the
   expected params. (Use the GA debug extension or `?_dbg=1`/`debug_mode` as needed.)
2. Confirm no console errors when gtag is absent (e.g. ad-blocker) — the `typeof gtag` guard
   must hold.
3. Confirm gameplay is unaffected (events are non-blocking).

## Done criteria

- [ ] gtag snippet present on `play.html`, `join.html`, `create.html` (not just index).
- [ ] `trackEvent` helper (or inline calls) added; guarded against missing gtag.
- [ ] Events firing: `cta_click`, `match_start`, `round_complete`, `match_end` (+ `won`),
      `lobby_entered`, `map_submitted`.
- [ ] New script file (if any) registered in `build.js` + the page `<!-- BUILD -->` block.
- [ ] No edits to `server/game.js` / `server/engine.js` / `server/config.json` (no CHANGELOG).
- [ ] GA data-hygiene checklist (Part B) included in the PR description for the owner.
- [ ] Verified via DebugView/Realtime; no console errors; gameplay unaffected.
