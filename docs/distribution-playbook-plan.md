# Distribution Playbook — Portals + SEO + Social

**Branch:** `worktree-distribution-playbook`
**Status:** plan only — implement this.
**Why now:** GA data confirms distribution is THE bottleneck. ~300 real US-desktop players
have ever found ChaoChao; only **9 organic-search users all-time**; ~97% of traffic is
"Direct" (people handed the link). The product *retains* the people who find it
(~17 min/user, ~20% return). Pouring more effort into retention/skins without growing the
top-of-funnel optimizes the wrong variable. This chunk gets ChaoChao **in front of humans.**

**Scope:** code prep for portal embedding + SEO/social meta + a manual checklist for the
portal/community submissions only the operator can do. **No ad SDK integration** (that
bundles with the monetization chunk later). **No gameplay changes.** No CHANGELOG entry
required — this work doesn't touch `server/config.json`, `server/game.js`, or
`server/engine.js`.

---

## Stream 1 — Code prep (the implementing agent does this)

### 1a. SEO meta tags on every page

Add to `<head>` of `client/index.html`, `client/play.html`, `client/join.html`,
`client/create.html`, `client/learn.html`:
- Page-specific `<title>` and `<meta name="description">` tuned for search (example seed:
  *"Free multiplayer browser arena racing — play with friends, survive brutal rounds,
  build maps. No signup, plays in your browser."*).
- **Open Graph** (`og:title`, `og:description`, `og:image`, `og:url`, `og:type=game`).
- **Twitter Card** (`twitter:card=summary_large_image`, `twitter:image`).
- **Canonical** link per page.

An OG/Twitter image (1200×630) is needed. Reuse a landing screenshot or render a one-time
PNG (game title + brand colours over a gameplay grab). Save under `client/assets/img/` so
the existing manifest scan picks it up.

### 1b. Structured data (schema.org)

Add a `<script type="application/ld+json">` block to `client/index.html` with a
`VideoGame` schema (`name`, `description`, `applicationCategory: "Game"`,
`operatingSystem: "Web"`, `genre`, `playMode: "MultiPlayer"`, `image`, `url`,
`author`). Lifts organic-search appearance and unlocks the "Game" rich-result panel.

### 1c. `robots.txt` + `sitemap.xml`

Two static files served by the existing `express.static(htmlPath)` in `index.js:126`:
- `client/robots.txt` — `User-agent: *` / `Allow: /` / `Sitemap: <prod URL>/sitemap.xml`.
- `client/sitemap.xml` — list `index.html`, `play.html`, `join.html`, `create.html`,
  `learn.html`. Hardcode the prod URL (Heroku) — no need to template.

### 1d. Portal embeddability

CrazyGames and Poki embed games in iframes on their domains. Adjust:
- **Verify no `X-Frame-Options: DENY`/`SAMEORIGIN`** is being sent (Express doesn't add
  one by default — confirm `compression()` and `express.static` don't either).
- **CSP `frame-ancestors`** — set it explicitly to allow:
  `frame-ancestors 'self' https://*.crazygames.com https://*.poki.com https://itch.io https://*.itch.zone`.
  Apply via a small Express middleware in `index.js` *before* the static handler
  (`index.js:126`).
- **Socket.IO** connects to the same origin → fine inside iframes.
- **Supabase OAuth inside a portal iframe** — third-party-cookie restrictions can break
  the redirect flow. If sign-in fails inside a specific portal, the game must **fall back
  gracefully to anonymous play** (which is the default state anyway). Do NOT change the
  Supabase auth flow to accommodate portals.

### 1e. Embedded-mode UI adaptation

Detect iframe context at boot (`window.self !== window.top`) and on every page:
- Hide the landing-page navbar link back to `index.html` (portals don't want navigation
  away from their site).
- Hide any GitHub / source / version-tag link.
- Inside `play.html` lobby: hide the Discord/Google sign-in CTA only if the player is in
  an iframe AND a quick session check fails. Otherwise leave it.

Keep this behind a single `isEmbedded()` helper (one source of truth) — e.g., add it to
`client/scripts/utils.js`.

### 1f. Asset size pass

Portals cap bundle/asset size (Poki ~50 MB total, CrazyGames more lenient).
- Run `du -sh client/assets/sounds client/assets/img client/scripts/dist` and document the
  totals in the PR description.
- If anything is borderline, re-encode large WAVs to MP3 (the 2026-05-26 mobile loading
  fix already did the music pass; SFX may still be WAV).

### 1g. Smoke / manual checks

- Build (`npm run build`) and start (`npm run start:prod`); open each page and verify the
  new meta tags + JSON-LD render.
- Create a tiny local `embed-test.html` (gitignored) with `<iframe src="http://localhost:3000/play.html"></iframe>`
  and load it from a *different* localhost port — confirm the game runs and the embedded
  UI adaptations kick in.
- Validate JSON-LD via https://search.google.com/test/rich-results.

---

## Stream 2 — SEO/social ground game (agent drafts, operator approves)

The agent commits **`docs/distribution-assets-checklist.md`** listing the content the
operator needs to author (or approve drafts the agent provides). Required:
- One-line tagline (≤60 chars).
- 100-word description.
- 5 screenshots (resolution per portal spec).
- 1 short gameplay GIF (10-30s, ≤5 MB).
- Suggested tags / categories per portal.
- Drafted README polish for the GitHub repo (so visitors immediately see how to play +
  link to the live site).

---

## Stream 3 — Portal submissions (operator only — agent CANNOT do these)

The agent provides a **`docs/portal-submission-checklist.md`** with the exact URL,
account flow, and gotchas for each portal — but the operator must create accounts and
submit.

Recommended order:
1. **itch.io** (lowest friction, fastest live presence) —
   https://itch.io/dashboard → New project → HTML5, paste hosted URL or upload zip,
   description, tags, screenshots. Free. **Do this first** so the SEO/social work has a
   landing page to point at.
2. **CrazyGames** (largest .io audience, ad rev-share) —
   https://developer.crazygames.com → developer account → Submit a game → hosted URL.
   Review takes a few days; expect feedback.
3. **Poki** (most polish required) —
   https://developers.poki.com → developer account → Submit. Stricter review —
   they want clean game-end and pause hooks, specific UX patterns.

---

## Constraints

- **No gameplay edits.** Stay out of `server/game.js`, `server/engine.js`,
  `server/config.json`. No CHANGELOG entry needed.
- **No portal SDKs in this chunk.** CrazyGames/Poki SDKs bundle ads + analytics — defer
  to the monetization chunk so each PR stays small and reviewable.
- **Don't bend Supabase auth** to accommodate iframes — fall back to anonymous play
  inside any embed where sign-in misbehaves.
- New client script (if any, e.g. `isEmbedded()` helper) → register in `build.js` AND the
  page's `<!-- BUILD -->` block (per CLAUDE.md).

---

## Verification

1. After 1a-1c: confirm OG/Twitter/JSON-LD render via `curl` + the Google rich-results
   tester.
2. After 1d-1e: iframe-embed test loads cleanly; nav/GitHub links hidden; anonymous play
   works inside the iframe.
3. After 1f: each portal's size cap is documented and met.
4. After 2: `distribution-assets-checklist.md` lists everything the operator needs.

## Done criteria

- [ ] OG / Twitter Card / canonical / page-specific titles + descriptions on all 5 HTML
      pages.
- [ ] `VideoGame` JSON-LD on `index.html`.
- [ ] `robots.txt` + `sitemap.xml` served from `client/`.
- [ ] CSP `frame-ancestors` allows the three portals.
- [ ] `isEmbedded()` helper + UI adaptations in `play.html` / `index.html`.
- [ ] Asset sizes documented and within caps.
- [ ] `docs/distribution-assets-checklist.md` committed (Stream 2).
- [ ] `docs/portal-submission-checklist.md` committed (Stream 3).
- [ ] No edits to `server/game.js` / `server/engine.js` / `server/config.json`.
- [ ] Smoke + manual iframe verified.

---

## After this chunk (operator-only)

The operator (not the implementing agent) does:
- Submit to itch.io (~30 min).
- Submit to CrazyGames (~1-2 hours including review back-and-forth).
- Submit to Poki (~1-2 hours).
- Post in /r/iogames, /r/webgames, /r/browsergames (per each sub's posting rules).

That's when the ~17 DAU realistically starts to grow. The follow-on monetization chunk
(portal SDK + ads + paid store) becomes worth building once portal traffic is actually
arriving — measure first, monetize second.
