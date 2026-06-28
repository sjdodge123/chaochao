# Screenshot + GIF Capture Guide

Step-by-step for the 5 screenshots and 1 gameplay GIF the portals need. This is
the **critical-path blocker** for distribution — itch.io, CrazyGames, the GitHub
README hero, and every social post all need these. ~30–45 min of work.

> Why you (not the agent): browser screenshots in the build environment can't
> reach the shell filesystem, and a real, populated match yields far better
> action shots than anything synthetic.

---

## Setup (do this once)

1. Open **two browser windows** to <https://www.chaochaogame.com/play.html> so
   you've got at least 2 karts in the arena (more = better shots — pull in a
   friend or a phone on the same link if you can). Bots also fill out the field.
2. **Window size = 1280×720.** Portals want 16:9, and that's the game's native
   ratio. Either resize the window to ~1280×720, or capture larger and crop to
   16:9 afterward. Avoid capturing the OS title bar / browser chrome — grab just
   the canvas.
3. Hide the cursor where you can, and let the HUD settle (no open menus) unless
   the shot is specifically about UI.

**macOS capture:**
- Still: `Cmd+Shift+4` then `Space` to grab a single window, or drag a region.
  Tighten to the game canvas.
- Video (for the GIF): `Cmd+Shift+5` → record a region → save `.mov`.

---

## The 5 screenshots

Save into this folder (`docs/marketing/`) with these exact names so the README
and portal steps can find them. Target **1280×720 PNG** unless a portal asks for
a different size (see per-portal notes in `../portal-submission-checklist.md`).

| File | What to capture | Timing tip |
|------|-----------------|------------|
| `screenshot-1-race.png` | **Busy mid-race** — several karts spread across varied terrain (lava / grass / water / sand), goal visible | Early-mid race, karts still clustered, trails showing |
| `screenshot-2-brutal.png` | **A brutal round in action** — pick a visually loud one: volcano (creeping lava), lightning, or infection | Grab when the effect peaks (lava spreading / bolt flashing / infected glow) |
| `screenshot-3-ability.png` | **An ability firing** — a bomb explosion or ice-cannon beam mid-cast | Fire it near other karts so there's reaction; catch the FX frame |
| `screenshot-4-finish.png` | **The payoff** — a kart on the golden goal tiles, or the end-of-round scoreboard | Goal moment, or the overview/scoreboard screen between rounds |
| `screenshot-5-editor.png` | **The map editor** — go to <https://www.chaochaogame.com/create.html> with a colorful in-progress map | Show painted terrain + the tool palette |

Composition notes:
- Fill the frame with the board; avoid large empty dead-zones.
- Variety across the five (different terrain, different brutal round than the
  cover's lava) reads better on a portal card grid.
- No debug overlays, no half-open menus (except editor, where the palette is the point).

---

## The gameplay GIF

One file, `gameplay.gif`, **10–30 s, ≤ 5 MB**, showing a mini-arc:
**spawn → race across terrain → a brutal round → reaching the goal.**

1. Record the arc with `Cmd+Shift+5` (region over the canvas) → save e.g. `clip.mov`.
2. Convert + size it down with ffmpeg:
   ```sh
   # from docs/marketing/
   ffmpeg -i clip.mov -vf "fps=15,scale=800:-1:flags=lanczos" -loop 0 gameplay.gif
   # check size:
   ls -lh gameplay.gif
   ```
3. If it's over 5 MB, shrink until it fits (in order of preference):
   - lower fps: `fps=12`
   - smaller width: `scale=640:-1`
   - trim length: add `-t 15` (or `-ss 2 -t 15` to skip the first 2 s)
   A cleaner 2-pass palette (sharper colors, smaller file):
   ```sh
   ffmpeg -i clip.mov -vf "fps=15,scale=800:-1:flags=lanczos,palettegen" palette.png
   ffmpeg -i clip.mov -i palette.png -lavfi "fps=15,scale=800:-1:flags=lanczos[x];[x][1:v]paletteuse" -loop 0 gameplay.gif
   rm palette.png
   ```

---

## Optional: watermark the GIF

A transparent-background CHAO CHAO logotype lives at
[`chaochao-logo.png`](chaochao-logo.png) (552×82, extracted from the og-cover).
To stamp it top-right at ~60% opacity while converting:

```sh
ffmpeg -i clip.mov -i chaochao-logo.png -filter_complex \
  "[0]fps=15,scale=800:-1:flags=lanczos[v]; \
   [1]scale=160:-1,format=rgba,colorchannelmixer=aa=0.6[wm]; \
   [v][wm]overlay=W-w-10:10" -loop 0 gameplay.gif
```

- `scale=160:-1` sets the watermark width (~20% of an 800-px GIF); bump to taste.
- `aa=0.6` is the opacity; `1.0` = fully opaque.
- `overlay=W-w-10:10` = top-right with a 10-px inset; use `overlay=W-w-10:H-h-10`
  for bottom-right.
- For the 2-pass palette version, put the same chain before `palettegen` /
  `paletteuse`.

**Using Giphy (or any tool that can't resize/reposition the overlay):** use the
pre-positioned variants instead — [`chaochao-logo-corner.png`](chaochao-logo-corner.png)
(full opacity) or [`chaochao-logo-corner-60.png`](chaochao-logo-corner-60.png)
(60%). They're a 1600×900 transparent canvas with the logo already sized (20%
of frame width) and placed bottom-right with a 28-px inset — stamped full-frame
over a 16:9 GIF, the logo lands exactly in the corner. (16:9 GIFs only; a
different aspect would skew the placement.)

---

## When you're done

- Drop all 6 files into `docs/marketing/` and commit them (or hand them to me and
  I'll wire them into the README hero + flag the asset checklist boxes).
- Per-portal size variants (itch cover 630×500, CrazyGames 16:9 ~1600×900 + a
  square icon) can be re-cropped from these — see `../portal-submission-checklist.md`.
