# Distribution Assets Checklist (operator-fillable)

Companion to [`distribution-playbook-plan.md`](distribution-playbook-plan.md). The
**code prep is done** (SEO/OG/Twitter meta, JSON-LD, robots/sitemap, CSP
frame-ancestors, `isEmbedded()` + embedded-mode chrome trimming). This file lists
the **content the operator must author or approve** before the portal/community
submissions in [`portal-submission-checklist.md`](portal-submission-checklist.md).

Draft copy is provided below — edit in place, then check the box.

---

## ⚠️ Two things the agent could NOT finalize — do these first

1. **Production URL — CONFIRMED** as **`https://www.chaochaogame.com`**
   (operator-confirmed; already applied across the 5 client HTML pages,
   `robots.txt`, and `sitemap.xml`). The steps below are kept only as a
   reference in case the domain ever changes again. If the real host differs
   (custom domain, different Heroku app name), find-and-replace it in **all** of:
   - `client/index.html`, `client/play.html`, `client/join.html`,
     `client/create.html`, `client/learn.html` (canonical + `og:url` + `og:image`
     + `twitter:image` + the JSON-LD `url`/`image`)
   - `client/robots.txt` (the `Sitemap:` line)
   - `client/sitemap.xml` (every `<loc>`)
   ```
   # from the repo root, once you know the real URL:
   grep -rl 'chaochao.herokuapp.com' client | xargs sed -i '' 's#https://chaochao.herokuapp.com#https://YOUR-REAL-URL#g'
   ```

2. **OG/social image — PLACEHOLDER, replace manually.**
   `client/assets/img/og-cover.png` is currently an auto-generated 1200×630
   placeholder (a stylized Voronoi-board illustration). It is the single image
   every social/portal link preview uses, so it should be a polished,
   hand-crafted asset before launch — not good enough as-is for distribution.
   Replace it with a real branded 1200×630 PNG at this same path (keep the
   dimensions so the `og:image:width/height` tags stay accurate). Best source is
   a real gameplay grab + title treatment.
   - [ ] Polished 1200×630 `og-cover.png` produced and dropped in (replaces the placeholder)

---

## Stream 2 — SEO / social ground game

### Tagline (≤ 60 chars)
Shown on portal cards and as the meta hook.

> _Draft:_ **Free multiplayer browser arena racing — no signup.**  (51 chars)

- [ ] Tagline approved: `______________________________________________`

### 100-word description
Used for itch.io / CrazyGames / Poki "about" fields and the store blurbs.

> _Draft (≈ 95 words):_
> Chao Chao is a free, fast-to-join multiplayer arena racing game that runs
> right in your browser — no download, no signup. Spawn into a colorful arena,
> race across sand, ice, grass and lava to the goal, and survive "brutal rounds"
> that warp the rules: creeping volcanoes, lightning storms, infection, hockey
> chaos and more. Grab abilities — bombs, swaps, blindfolds, ice cannons — and
> outlast everyone. Play with friends on the same link across phone, controller,
> or keyboard, or build and share your own maps in the built-in editor. Quick
> matches, easy to learn, hard to put down.

- [ ] 100-word description approved (edit above)

### Screenshots (5) — operator to capture
Portals want clean, representative shots. Target **1280×720** (16:9, the game's
native ratio) unless a portal asks otherwise (see per-portal notes). Save into
[`marketing/`](marketing/) (see its README for filenames).

> **Note:** the agent could not auto-capture these. Browser screenshots in the
> build environment don't reach the shell's filesystem, so they can't be
> cropped/committed automatically — and a real match yields better action shots
> anyway. Capture these yourself from the live site.

Suggested set:
- [ ] 1. A busy mid-race moment (several karts, varied terrain)
- [ ] 2. A brutal round in action (volcano/lightning/infection — visually loud)
- [ ] 3. An ability firing (bomb explosion or ice cannon)
- [ ] 4. The goal/finish moment or scoreboard
- [ ] 5. The map editor (shows the create feature)

### Gameplay GIF (1)
- [ ] 10–30s, **≤ 5 MB**, shows a full mini-arc (spawn → race → brutal round → finish)
  - Capture tip: record at 1280×720, trim, then `ffmpeg -i in.mp4 -vf "fps=15,scale=800:-1" -loop 0 out.gif` and check it's under 5 MB (drop fps/scale if not).

### Suggested tags / categories
Final tag sets live per-portal in `portal-submission-checklist.md`; master list:
- `multiplayer`, `racing`, `arena`, `io`, `browser`, `casual`, `party`,
  `local-multiplayer`, `controller`, `mobile`, `level-editor`, `free`
- [ ] Tag set reviewed

### GitHub README polish
So repo visitors immediately see how to play + reach the live site.
- [ ] Add a top-of-README hero line + **▶ Play now: <prod URL>** link
- [ ] One-paragraph "what is it" (reuse the tagline + a trimmed description)
- [ ] A screenshot or the gameplay GIF near the top
- [ ] "Built with" / contributing pointer (link `CONTRIBUTING.md`, `ARCHITECTURE.md`)

---

## What's already wired in code (no operator action)
- Per-page `<title>`, `<meta name="description">`, canonical, Open Graph,
  Twitter `summary_large_image` on index/play/join/create/learn.
- `VideoGame` JSON-LD on `index.html` (validate at
  https://search.google.com/test/rich-results once deployed).
- `client/robots.txt` + `client/sitemap.xml`.
- CSP `frame-ancestors` allows CrazyGames / Poki / itch.io to iframe the game.
- `isEmbedded()` (`client/scripts/embed.js`) hides the brand link, version tag,
  GitHub patch-notes banner, and sign-in CTA when framed by a portal; play falls
  back to anonymous (the auth flow is untouched).
