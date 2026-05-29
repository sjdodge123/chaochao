# Marketing captures

Drop the portal/social marketing assets here. Spec + per-portal sizes live in
[`../distribution-assets-checklist.md`](../distribution-assets-checklist.md).

Status:
- **OG cover** — done, committed at `client/assets/img/og-cover.png` (1200×630).
- **Screenshots (5) + gameplay GIF** — **operator to capture.** The agent could
  not auto-capture these: browser screenshots in this environment don't reach the
  shell's filesystem, so they can't be cropped/committed here. Capturing a real
  match also produces far better action shots anyway.

Suggested files to add (1280×720 PNGs unless a portal asks otherwise):
- `screenshot-1-race.png` — busy mid-race, several karts, varied terrain
- `screenshot-2-brutal.png` — a brutal round (volcano / lightning / infection)
- `screenshot-3-ability.png` — a bomb explosion or ice cannon firing
- `screenshot-4-finish.png` — goal/finish moment or the scoreboard
- `screenshot-5-editor.png` — the map editor (`create.html`)
- `gameplay.gif` — 10–30s, ≤5 MB (spawn → race → brutal round → finish)

Capture tips:
- Record at 1280×720. For the GIF:
  `ffmpeg -i clip.mp4 -vf "fps=15,scale=800:-1:flags=lanczos" -loop 0 gameplay.gif`
  then check it's < 5 MB (drop fps/scale if not).
