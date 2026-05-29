# Portal Submission Checklist (operator-only)

The implementing agent **cannot** create accounts or submit games — these steps
are yours. Prereqs from [`distribution-assets-checklist.md`](distribution-assets-checklist.md):
confirmed **prod URL**, branded **og-cover.png**, **5 screenshots**, **1 gameplay
GIF**, tagline + 100-word description.

> The game is hosted on your own server and embeds in an iframe (CSP
> `frame-ancestors` already allows these three portals). For every portal below
> you can submit the **hosted URL** rather than uploading a zip — simplest, and
> updates go live when you deploy. itch.io also accepts an HTML5 zip if you ever
> want a self-contained upload.

Recommended order: **itch.io → CrazyGames → Poki** (rising friction/review bar).

---

## 1. itch.io  — do this first (lowest friction, instant live presence)
- URL: https://itch.io/dashboard → **Create new project**
- Flow:
  1. Kind of project: **HTML**.
  2. "This file will be played in the browser" — either upload an HTML5 zip, or
     (simpler) set the project to **embed your hosted URL**. Use a 16:9 embed,
     ~1280×720, and tick **fullscreen button** + **mobile friendly**.
  3. Pricing: **No payments** (free).
  4. Fill title, tagline, the 100-word description, 5 screenshots, the GIF as the
     cover if you like.
  5. Tags (itch allows up to ~10): `multiplayer`, `racing`, `arena`, `io`,
     `browser`, `casual`, `party`, `controller`, `level-editor`, `local-multiplayer`.
  6. Genre: **Racing**; also tick **Multiplayer**.
  7. Visibility: **Public** (or Draft → preview → Public).
- Gotchas:
  - Cover image is **630×500** on itch (NOT 1200×630) — make a separate crop;
    `og-cover.png` is for link previews, not the itch cover slot.
  - If embedding the hosted URL, itch serves the page over **https** inside
    `*.itch.zone` — already allowed by our `frame-ancestors`.
  - Set the embed background to match the game (dark) so letterboxing isn't jarring.
- [ ] itch.io page live; URL: `____________________`

## 2. CrazyGames  — largest .io audience, ad rev-share
- URL: https://developer.crazygames.com → create developer account → **Submit a game**
- Flow:
  1. Choose **hosted game** (provide the prod URL) or upload a build.
  2. Provide title, description, **tags/category**, thumbnails, and a logo.
  3. Submit for review — **takes a few days**; expect a feedback round.
- Gotchas:
  - They review on **desktop + mobile**; make sure the game loads cleanly in an
    iframe on both (our embedded mode hides nav/branding automatically).
  - They will eventually want the **CrazyGames SDK** (ads, events, invite links).
    That is **deliberately out of scope here** — it bundles ads and belongs to the
    monetization chunk. You can launch without it; add it later.
  - Thumbnail spec is strict (they publish current dimensions on the submit page —
    commonly a 16:9 cover ~1600×900 plus a square icon). Re-crop from the same art.
  - No external "back to my site" links inside the frame — already handled by
    `isEmbedded()`.
- [ ] CrazyGames submitted; review status: `____________________`

## 3. Poki  — most polish required, strictest review
- URL: https://developers.poki.com → create developer account → **Submit**
- Flow:
  1. Register the game, provide hosted URL/build, metadata, art.
  2. Integrate the **Poki SDK** for the gameplay-start/®commercial-break hooks
     they require — **NOTE: SDK work is out of scope for this chunk** (monetization
     chunk). Poki generally will not fully accept a game without their SDK, so
     expect this to land **after** itch.io + CrazyGames prove out traffic.
  3. Submit for review; they give detailed UX feedback.
- Gotchas:
  - Poki cares about a clean **game-start**, **pause**, and **game-over** so their
    ad breaks slot in — audit those moments before submitting.
  - **Asset-size cap ≈ 50 MB total.** Current footprint: `client/assets/sounds`
    ≈ **32 MB**, `client/assets/img` ≈ **1.4 MB**, JS bundles small → **comfortably
    under 50 MB**. Re-check after any large audio additions (re-encode WAV→MP3 if so).
  - They expect mobile + landscape handling — already present (rotate prompt).
- [ ] Poki submitted; review status: `____________________`

---

## After the portals (community — free, fast reach)
Post per each sub's rules (read the sidebar; many require flair / no reposts):
- [ ] r/iogames
- [ ] r/WebGames
- [ ] r/browsergames
- [ ] (optional) r/IndieGaming, relevant Discords

## Verification before you submit anywhere
- [ ] Open the prod URL in a private window — game loads, anonymous play works.
- [ ] Paste the prod URL into the Facebook Sharing Debugger / Twitter Card
      validator → preview shows the og-cover image + title + description.
- [ ] https://search.google.com/test/rich-results on the prod URL → VideoGame found.
- [ ] Load the game inside a test iframe (see `embed-test.html`) → nav/brand/version/
      sign-in chrome is hidden, gameplay works.
