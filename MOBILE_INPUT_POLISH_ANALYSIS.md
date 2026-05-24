# Mobile / Gamepad / Keyboard+Mouse HTML Polish Analysis

How to polish the ChaoChao client HTML & front-end for the four input modes it
supports: **touch (mobile)**, **gamepad**, **keyboard+mouse (desktop)**, and the
display concerns that cut across all of them (**button sizing, DPI/text
scaling, page navigation**).

This is an analysis + recommendations doc, not a set of applied changes. Every
finding cites the file/line it came from so the work can be picked up directly.
Items are tagged **[P1]** (high impact / broken on a platform), **[P2]**
(noticeable polish), **[P3]** (nice-to-have). Each item carries a **DoD**
(definition of done / acceptance criteria) and an **Effort** estimate
(**S** ≈ <½ day · **M** ≈ 1–2 days · **L** ≈ multi-day / needs a spike), and §11
groups everything into PR-sized chunks with a suggested sequence.

---

## Verification pass — what was confirmed in code

A second read resolved the open questions from the first draft. Three first-draft
findings were **corrected** after checking the code:

- **§2.2 coordinate space is NOT a mismatch.** No map JSON overrides world size
  (`grep` of `client/maps/*.json` found no `worldWidth`/`worldHeight`), and
  `world` is populated from the server using `config.worldWidth/worldHeight =
  1366×768` (`server/config.json:5-6`, `worldResize` `gameboard.js:246-253`) —
  identical to the canvas backing store. Touch coords map into that same
  1366×768 space (`input.js:238`). So the virtual-button bound rects and the
  touch coordinates share **one** coordinate space; the §2.2 fix needs no
  coordinate reconciliation. (If a future map ever ships a non-1366×768 world,
  this assumption breaks — see §2.2.)
- **§4.5 controller focus styling is already covered.** `menuGamepad.js:14` uses
  `NAV_SELECTOR = "a.btn, button.btn, input.form-control"` and toggles `gp-focus`
  (`menuGamepad.js:116-120`); the landing CTAs, join cards (`a.join-btn` is also
  `a.btn`), refresh button, and join-by-id input all match. Only the plain
  keyboard-`Tab` `:focus-visible` case (non-gamepad) is still worth a glance.
- **§7 PlayStation glyph detection is already implemented.** `gamepad.js:624-632`
  (`detectGamepadType`, `gamepadType === "playstation"`) already swaps ✕/□/○ vs
  A/X/B. The first draft's P3 suggestion to add this was wrong and has been
  removed.

---

## 0. The single biggest structural gap: there are no responsive breakpoints

`client/css/styles.css` (650 lines) contains **zero `@media` queries**. Every
size is fixed: the navbar is `60px` tall (`:root --navbar-height`,
`styles.css:14`), the landing title is `4em` (`#game-title`, `styles.css:312`),
the emoji wheel is a hard-coded `100px` circle (`.emojiMenu`,
`styles.css:397`), and all the create-editor panels use fixed percentages
(`#mapEditor` 80%, `#controlPanel` 9%, `styles.css:183`/`212`).

Nothing adapts to viewport width, orientation, or pointer type. The pages
"work" on mobile only because Bootstrap 4.1.3's grid does some of the lifting on
the landing/join pages — the game canvas and overlay UI do their own scaling in
JS. This means most of the recommendations below reduce to: **introduce a small
set of breakpoints and a `(pointer: coarse)` / `(hover: none)` query**, then
hang the per-mode tweaks off them.

---

## 1. Display & DPI / text scaling

### 1.1 [P1] The game canvas never accounts for `devicePixelRatio` → blurry on every phone & Retina display

The canvas backing store is fixed at `1366×768`:

```html
<!-- client/play.html:38-39 -->
<canvas id="gameCanvas"  width="1366" height="768"></canvas>
<canvas id="overlayCanvas" width="1366" height="768"></canvas>
```

`resize()` (`game.js:185`) only ever sets the **CSS** size
(`gameCanvas.style.width/height`, `game.js:206-209`) — it scales the 1366×768
bitmap up or down with CSS but never changes the backing-store resolution.
There is no `devicePixelRatio` reference anywhere in `game.js`, `draw.js`,
`input.js`, or `client.js` (verified by grep).

Consequences:
- On a 3× phone or a Retina laptop the whole game is rendered at ~1/3 the native
  resolution and upscaled → soft edges on sprites and, most visibly, **fuzzy
  text**. Every canvas-drawn label goes through this: `drawTouchLabel`
  ("Move"/"Attack"/"Fullscreen"/"Emoji", `draw.js:1320`) and all the score/state
  HUD text in `draw.js`.
- This is the actual root cause of the "text DPI scaling" symptom — it is not a
  font/CSS problem, it's a canvas-resolution problem.

**Recommendation:** make the canvas DPR-aware. Set
`canvas.width = cssWidth * dpr; canvas.height = cssHeight * dpr;` inside
`resize()`, keep the CSS size as the layout size, and `ctx.scale(dpr, dpr)` once
per frame (or bake the ratio into the camera transform). Because all game logic
currently assumes a 1366×768 coordinate space (`camera` in `game.js:211`, touch
mapping in `input.js:238`), the cleanest approach is to keep the **logical**
coordinate space at 1366×768 and apply the DPR as an extra transform, so no
gameplay math changes. Cap `dpr` at ~2 to avoid over-rendering on 3× phones.

### 1.2 [P2] No `-webkit-text-size-adjust`; fixed `4em` title can overflow narrow phones

`#game-title { font-size: 4em }` (`styles.css:312`) on a 320px-wide device is
~64px and competes with the `.play-container` padding (`styles.css:329`). Add a
`clamp()` (e.g. `clamp(2.2rem, 12vw, 4em)`) and set
`html { -webkit-text-size-adjust: 100% }` so iOS doesn't auto-inflate text in
landscape.

### 1.3 [P3] Canvas-drawn HUD/label font sizes are constant px

`drawTouchLabel` uses `"bold 16px Arial"` (`draw.js:1322`) in the logical
coordinate space. Once 1.1 is fixed these will be crisp, but on very small
phones they're still 16/1366 of the width. Consider scaling label/HUD font with
the fitted canvas size so captions stay legible on small screens and don't
dominate on large ones.

---

## 2. Fullscreen controls

### 2.1 [P1] `requestFullscreen()` on a `<div>` is a no-op on iOS Safari

`goFullScreen()` calls `gameWindow.requestFullscreen()` (`game.js:317`) and
`initEventHandlers()` auto-invokes it on touch devices (`input.js:33`). **iOS
Safari does not support the Fullscreen API on arbitrary elements** (only
`<video>`), so on iPhone this silently rejects — the `.catch` at `game.js:319`
swallows it. Net effect: the prominent on-canvas "Fullscreen" button
(`draw.js:1302`, `drawTouchLabel("Fullscreen", …)` `draw.js:1307`) does nothing
on the single most common mobile platform.

**Recommendations:**
- Feature-detect (`if (el.requestFullscreen)`) and **hide the fullscreen
  touch button on platforms where it's unavailable** instead of drawing a
  dead control (gate `exitButton.isVisible()` / `drawTouchControls`
  `draw.js:1293`).
- For iOS, lean on the existing PWA meta tags — `apple-mobile-web-app-capable`
  is already set (`play.html:6`). Document "Add to Home Screen" as the
  fullscreen path on iOS, since launched-from-home-screen runs chromeless.
- Don't auto-request fullscreen on load (`input.js:33`) — browsers require a
  user gesture, so the first call frequently fails anyway; trigger it only from
  the explicit button tap (which already exists at `input.js:253-255`).

### 2.2 [P1] The fullscreen/emoji touch targets are thin top-corner strips that don't match the drawn icon

The fullscreen and emoji buttons are hit-tested against their **bounding
rectangle**, not the button's own radius:

```js
// input.js:206-207  (the bound rects)
upperLeftRect  = new VirtualButton(0, 10, world.width/16, 50, false);
upperRightRect = new VirtualButton(world.width - world.width/16, 10, world.width/16, 50, false);
// input.js:216-217  (radius 12.5 is set but unused for hit-testing)
exitButton = new Button(world.width - 50, 0, 0, 0, 12.5, false);
chatButton = new Button(50, 0, 0, 0, 12.5, false);
// input.js:241  hit test uses the bound rect, not the radius:
if (virtualButtonList[i].bound.pointInRect(touchX, touchY)) { ... }
```

So the **effective tap zone** for both fullscreen (top-right) and emoji
(top-left) is a strip only `world.width/16` wide and `50` tall pinned to the
very top edge — exactly where the mobile browser's URL bar, the notch, and the
status bar live. Meanwhile the **icon is drawn at ~57px** (`fullScreenToUse.width
* 0.1` on a 576-px source, `draw.js:1302`) centered in that strip, so the
visible target and the touchable target disagree, and the radius `12.5` set on
the button object is dead.

**Recommendations:**
- Make the tap zone match (or slightly exceed) the rendered icon — at least a
  44×44 CSS-px square once converted through the canvas scale. Either widen the
  bound rects or switch hit-testing to `button.pointInCircle` with a radius sized
  to the icon.
- Move both controls **down out of the top safe-area strip** (e.g. `y` below the
  status bar / notch) so they aren't competing with browser chrome.
- Reconcile the dead `radius` (12.5) vs. bound-rect logic so there's one source
  of truth for the target size.

> **Confirmed:** the bound rects (`world.*`) and touch coords (canvas `1366×768`)
> are the same space today (see Verification pass), so this is a straight
> resize/reposition — no coordinate conversion needed. Add a guard/comment so it
> stays true if a map ever ships a non-1366×768 world.

**DoD:** the fullscreen and emoji controls each have a tap zone ≥44×44 CSS-px that
visually matches the rendered icon, sit below the top safe-area strip, and
hit-testing uses a single source of truth (no dead `radius`). Verified by tapping
on a real phone with the URL bar visible. · **Effort: M**

### 2.3 [P2] Fullscreen state and `resize()` coupling

`resize()` special-cases `fullscreenElement` to use the raw viewport
(`game.js:191-193`) vs. the fitted 16:9 box otherwise. When the iOS path fails
(2.1) the game stays in the letterboxed branch, which is correct — but combined
with the dead button it's confusing UX. Hiding the button (2.1) resolves this.

---

## 3. Emoji button / wheel on mobile

### 3.1 [P2] The emoji wheel is a hard-coded 100px circle with point-sized slots

`.emojiMenu` is `100px × 100px` (`styles.css:397-411`) and opened by setting
`transform: scale(2)` (`input.js:378`) → a 200px wheel. The twelve emoji slots
are absolutely positioned at hard-coded pixel offsets for the *unscaled* 100px
circle (`#emojiMenu a:nth-child(n)`, `styles.css:421-473`) at `font-size: 12px`
(`styles.css:417`). After the 2× scale each emoji is ~24px.

Problems on mobile:
- 24px is **below the ~44px minimum touch target**; the slots sit close together
  on the 200px ring, so mis-taps are likely.
- The layout is brittle: it only looks right at exactly `scale(2)`. There's no
  responsive sizing for small vs. large phones.
- Slot positions are authored in raw px, so adding/removing emojis means
  re-doing the trig by hand.

**Recommendations:**
- Rebuild the wheel sizing with CSS custom properties / `calc()` driven by a
  single `--wheel-radius`, and size the wheel from viewport (`min(60vw, 320px)`)
  so it scales with the device instead of a fixed 100px×2.
- Bump per-slot hit area to ≥44px (pad the anchors, not just the glyph).
- Consider generating slot positions from JS (`setupEmojiWheel`,
  `client.js:60`) using `cos/sin` over the count, instead of 12 hard-coded
  `nth-child` rules — this also future-proofs the gamepad wheel navigation that
  reads these same anchors (`gamepad.js:390-409`, `emojiItems()`).

### 3.2 [P2] Open position can clip off-screen

On touch, the wheel opens at `rect.width/2 - 50, rect.height/2 - 50`
(`input.js:260`) and `moveEmojiMenu` sets `style.left/top` (`input.js:396-398`).
With mouse/keyboard it opens at the cursor (`input.js:71`,
`openEmojiWindow(mousex, mousey)`). Near a screen edge (cursor case) the 200px
wheel can clip. Clamp the open position to keep the full wheel within the
viewport.

### 3.3 [P3] Emoji control is consistent across modes — keep it that way

Good baseline already exists: right-click opens it on desktop (`input.js:67`),
the on-canvas chat button opens it on touch (`input.js:256`), and the gamepad
`X`/`Square` opens it with d-pad navigation (`gamepad.js:222`, `GP_BTN_EMOJI`).
Any redesign in 3.1 should preserve all three entry points and the gamepad
`emojiItems()` DOM contract (first `<a>` is the close button — see the comment at
`gamepad.js:391`).

---

## 4. Page navigation & the navbar

### 4.1 [P2] Navbar audio/gamepad toggles are tiny, label-less icon links

The top nav has `#masterControl` and `#musicControl` as bare `<a>` tags wrapping
Font Awesome glyphs with only `margin-left: 5px` (`.music-btn`, `styles.css:291`;
markup `play.html:28-31`). On a phone these are small, closely-spaced tap
targets with no visible hit area and no text label.

**Recommendations:**
- Give them a real padded hit box (≥44px), `cursor:pointer` is set but there's
  no padding. Add `aria-label`s (currently only `aria-hidden` icons).
- Consider collapsing them into the navbar with proper spacing at narrow
  widths, or a small settings popover.

### 4.2 [P2] The navbar isn't a real responsive Bootstrap navbar

Markup uses `<nav class="d-flex align-items-center px-3">` with a manual
`navbar-brand` (`play.html:23`, `index.html:25`, `join.html:22`) but none of
Bootstrap's `navbar`/`navbar-expand`/`collapse` machinery. It's fine because
there's little in it, but if nav grows, adopt the Bootstrap navbar pattern (or a
custom flex/`gap` layout) so it degrades on small screens.

### 4.3 [P2] Fixed 60px navbar eats vertical space in landscape mobile

`--navbar-height: 60px` is constant (`styles.css:14`) and the section height is
`calc(100vh - var(--navbar-height))` (`styles.css:45`). In landscape on a phone
(the natural orientation for this game) 60px + browser chrome is a big chunk of a
~375px-tall viewport. Consider a shorter navbar under `(orientation: landscape)
and (max-height: 480px)`, or hiding it during active gameplay (it's already
`position: fixed; z-index: 1005`).

### 4.4 [P2] `100vh` will be wrong on mobile browsers

`html, body { height: 100vh }` (`styles.css:19`) and
`section { height: calc(100vh - var(--navbar-height)) }` (`styles.css:45`) use
`vh`, which on mobile Safari/Chrome includes the area behind the dynamic URL
bar — causing the canvas to be slightly too tall and content to shift when the
bar collapses. Move to `100dvh` (dynamic viewport height) with a `vh` fallback.

### 4.5 [P3] Controller focus styling is covered — only plain `Tab` focus left to check

`menuGamepad.js` is loaded on landing and join (`index.html:54`, `join.html:62`),
uses `NAV_SELECTOR = "a.btn, button.btn, input.form-control"` (`menuGamepad.js:14`)
and toggles the `.gp-focus` ring (`styles.css:556`, applied at
`menuGamepad.js:116-120`). **Confirmed:** the landing CTAs
(`#playButton/#joinButton/#createButton`, all `a.btn`, `index.html:39-41`), the
join cards' button (`a.join-btn` is also `a.btn`, `styles.css:123`), the refresh
button (`button.btn`), and the join-by-id input (`input.form-control`) all match
the selector, so controller focus already reaches them.

The only remaining gap is **non-gamepad keyboard `Tab` focus**: confirm a visible
`:focus-visible` outline exists (Bootstrap 4's default may be suppressed) so
keyboard-only desktop users can see where they are.

**DoD:** tabbing through landing and join with a keyboard (no gamepad) shows a
clear focus indicator on every interactive element. · **Effort: S**

---

## 5. Button sizing & touch targets (cross-cutting)

### 5.1 [P2] Default Bootstrap `.btn` is below the 44px touch minimum

`.btn { font-size: 0.95rem }` (`styles.css:288`) with Bootstrap 4's default
padding yields ~38px-tall buttons. The landing CTAs are full-width
(`w-100`, `index.html:39`) so width is fine, but height and the join page's
inline buttons (`#refreshButton .btn-sm` `join.html:32`, `#joinByIdButton`
`join.html:50`, `.join-btn` `styles.css:123`) are small for touch.

**Recommendation:** under `(pointer: coarse)`, bump `.btn` min-height to 44px and
increase vertical padding; avoid `.btn-sm` on touch.

### 5.2 [P1/P2] On-canvas controls live in logical 1366×768 space — they shrink with the canvas, not with the finger

The joystick (`baseRadius: 200`, `stickRadius: 120`, `maxPullRadius: 100`,
`joystick.js:12-16`) and buttons are all sized in the logical coordinate space.
When the canvas is fitted to a narrow phone, everything is multiplied by the
fit ratio (`optimalRatio`, `game.js:189`), so a 200px joystick on a 375px-wide
screen renders at ~55px radius regardless of the player's hand. There's no
minimum physical size and no per-device tuning.

**Recommendations:**
- Define touch-control sizes in **CSS pixels** (or a physical target) and convert
  *into* logical space, rather than authoring in logical px — so a thumb-sized
  joystick stays thumb-sized on every screen.
- Reconsider the joystick `deadzone: 10` (`joystick.js:19`) and `maxPullRadius`
  relative to the rendered size on small screens.

### 5.3 [P3] `onMove` has an assignment-as-condition bug

`Joystick.onMove` and `Button.onMove` both do `if (this.pressed = true)`
(`joystick.js:130`, `joystick.js:238`) — assignment, not comparison. It happens
to work because the body always runs, but it silently forces `pressed = true` on
every move and is a latent bug. Fix to `==`/`===` or restructure.

---

## 6. Touch event handling & viewport meta

### 6.1 [P1] Viewport meta lacks `viewport-fit=cover` → no safe-area inset support

All pages use:

```html
<meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no">
```

(`play.html:4`, `index.html:5`, `join.html:4`). Without `viewport-fit=cover`,
`env(safe-area-inset-*)` is unavailable, so on notched/home-indicator phones:
- The fixed navbar (`styles.css:29`) can sit under the notch in landscape.
- The gamepad prompt bar (`.gamepad-prompts { bottom: 12px }`, `styles.css:484`)
  and the on-screen keyboard (`.osk-container { bottom: 16px }`, `styles.css:583`)
  can sit under the home indicator.

**Recommendation:** add `viewport-fit=cover` and pad fixed UI with
`env(safe-area-inset-bottom/top)`.

### 6.2 [P2] Touch listeners are `passive:false` but `touchmove` never calls `preventDefault` → page can scroll/rubber-band during a joystick drag

`touchstart/end/move` are registered `{ passive: false }` (`input.js:22-24`),
and `onTouchStart` calls `preventDefault` only for the right-click/context path,
not in `onTouchMove` (`input.js:287-314`). `body { overflow: hidden }` on
play.html (`play.html:22`) limits scrolling, but iOS pinch-zoom and rubber-band
overscroll can still fire mid-drag, making the joystick feel slippery.

**Recommendations:**
- Call `evt.preventDefault()` in `onTouchMove` when a control owns the touch
  (you already pay the `passive:false` cost, so you might as well use it).
- Add `touch-action: none` to the canvas/`#gameWindow` and
  `overscroll-behavior: none` to `body` to stop pull-to-refresh and zoom on the
  play page.
- Consider `user-scalable=no` **only on the play page** (keep pinch-zoom on
  landing/join for accessibility).

### 6.3 [P3] `isTouchDevice()` relies solely on `(hover: none)`

`isTouchDevice = () => window.matchMedia('(hover: none)').matches`
(`input.js:316`). Touch laptops and hybrid devices can report `hover: none` (or
the inverse), mis-classifying the input mode and showing/hiding the whole touch
UI incorrectly. Consider combining `(pointer: coarse)`, `'ontouchstart' in
window`, and `navigator.maxTouchPoints`, and/or switching control schemes
dynamically on first touch/mouse/gamepad event rather than once at init.

---

## 7. Gamepad (already strong — polish only)

The gamepad story is the most mature: in-game pad support (`gamepad.js`), menu
navigation (`menuGamepad.js`), editor support (`editorGamepad.js`), an on-screen
keyboard for text entry (`osk.js` + simple-keyboard, `join.html:18,58`), a
prompt/hint bar (`.gamepad-prompts`, `styles.css:483`), focus rings
(`.gp-focus`), and a leave-game confirm modal (`.confirm-modal`,
`styles.css:601`). Remaining polish:

- **[P3]** The prompt bar dims after ~60s (`.faded`, `styles.css:514`) and — by
  design — only un-dims on a scheme change or the Select/`H` toggle
  (`gamepad.js:664`, `714-732`), *not* on arbitrary input. That's a reasonable
  choice; the only action item is to make it respect safe-area (see §6.1) so the
  faded bar doesn't sit under the home indicator. · **DoD:** bar clears the home
  indicator on a notched phone. · **Effort: S**
- **[P3]** OSK width is `min(720px, 96vw)` (`styles.css:584`) — good; just verify
  it doesn't overlap the prompt bar on short landscape screens. · **Effort: S**
- *(PlayStation glyphs: already implemented — `gamepad.js:624-632`. No action.)*

---

## 8. Keyboard + mouse (desktop)

Largely fine. Notes:

- **[P2]** Right-click opens the emoji wheel (`input.js:67`) and `contextmenu` is
  globally suppressed (`input.js:26`). That's intentional, but document it —
  users may expect a context menu. Provide an on-screen hint.
- **[P2]** `dblclick` toggles `movingByMouse` (`input.js:93-98`) — a hidden
  mode-toggle with no on-screen indication. Surface the current mode somewhere.
- **[P3]** `calcMousePos` calls `preventDefault` on every `mousemove`
  (`input.js:39`) — usually harmless but can interfere with text selection
  outside the canvas; scope it to the canvas element instead of `window`.
- **[P3]** Movement keys are handled via `keyCode` (`input.js:108-110`, deprecated)
  — fine functionally; migrate to `event.code` if touched.

---

## 9. The map editor (`create.html`) is desktop-only by construction

Out of scope for the main ask but worth flagging: `create.html` uses fixed
percentage panels (`#mapEditor` 80%/`#controlPanel` 9%, `styles.css:183/212`)
and `.mapEditorBtn { font-size: 24px; width: 50%; float:left }`
(`styles.css:262`). It has gamepad support (`editorGamepad.js`) but no responsive
/ touch layout. If mobile map-editing is ever a goal it needs its own pass;
otherwise consider gating it behind a "desktop recommended" notice on small
screens.

---

## 10. Backlog — every item with priority, effort, PR group & DoD

Effort: **S** ≈ <½ day · **M** ≈ 1–2 days · **L** ≈ multi-day / needs a spike.
PR column maps to the chunks defined in §11.

| ID | Item | Pri | Effort | PR | Definition of done |
| --- | --- | --- | --- | --- | --- |
| 6.1 | `viewport-fit=cover` + `env(safe-area-inset-*)` padding | P1 | S | A | Fixed UI (navbar, prompt bar, OSK) clears notch & home indicator on a notched phone in both orientations. |
| 4.4 | `100vh` → `100dvh` (with `vh` fallback) | P2 | S | A | Canvas/section height doesn't shift when the mobile URL bar collapses. |
| 1.2 | `clamp()` title + `-webkit-text-size-adjust:100%` | P2 | S | A | `#game-title` never overflows at 320px wide; iOS doesn't auto-inflate text in landscape. |
| 4.5 | Visible `:focus-visible` for keyboard-only `Tab` | P3 | S | A | Tabbing landing+join with a keyboard (no pad) shows focus on every control. |
| 1.1 | DPR-aware canvas (backing store × `dpr`, capped ~2) | P1 | L | B | Game + canvas text render sharp on a 2×/3× device; gameplay coords unchanged; no perf regression. |
| 1.3 | Scale canvas HUD/label fonts to fitted size | P3 | S | B | `drawTouchLabel`/HUD text legible on a 320px phone and not oversized on desktop. |
| 2.1 | Fullscreen: feature-detect, hide button where unsupported, drop on-load auto-request | P1 | M | C | No fullscreen button shown on iOS Safari; button works via tap where supported; no failed auto-request on load. |
| 2.3 | Fullscreen ↔ `resize()` branch coupling | P2 | S | C | Falls out of 2.1; no letterbox/again-fullscreen confusion. |
| 2.2 | Fullscreen/emoji tap targets match icon, leave top strip, single hit source | P1 | M | D | Each control has a ≥44×44 zone matching its icon, below the safe-area strip; dead `radius` removed. |
| 5.2 | On-canvas controls sized in CSS px, converted into logical space | P1/P2 | M | D | Joystick/buttons keep a thumb-sized physical size across phone widths. |
| 5.3 | `if (this.pressed = true)` → comparison | P3 | S | D | `onMove` no longer force-sets `pressed`; behavior unchanged. |
| 3.1 | Rebuild emoji wheel: viewport-sized radius, ≥44px slots, JS-generated positions | P2 | M | E | Wheel scales with device; each slot ≥44px; adding/removing emojis needs no hand-authored CSS. |
| 3.2 | Clamp emoji-wheel open position on-screen | P2 | S | E | Full wheel stays in viewport when opened near an edge (cursor case). |
| 3.3 | Preserve all 3 entry points + `emojiItems()` contract | P3 | — | E | Constraint on 3.1, not separate work. |
| 4.1 | Navbar audio/gamepad toggles: ≥44px hit box + `aria-label` | P2 | S | F | Toggles are easily tappable on mobile and labelled for screen readers. |
| 4.3 | Shorter navbar under landscape/short-height media query | P2 | S | F | Navbar reclaims vertical space in landscape phone play. |
| 5.1 | `.btn` min-height 44px under `(pointer: coarse)`; avoid `.btn-sm` on touch | P2 | S | F | All buttons ≥44px tall on touch devices. |
| 4.2 | Adopt real responsive Bootstrap navbar (optional) | P2 | M | F | Navbar degrades gracefully if nav content grows; no regressions. |
| 6.2 | `preventDefault` in `onTouchMove`; `touch-action:none`; `overscroll-behavior:none` | P2 | S | G | Joystick drags don't scroll/zoom/rubber-band the play page on iOS. |
| 6.3 | Broaden `isTouchDevice()` / switch scheme on first input | P3 | M | G | Hybrid/touch-laptop devices classify correctly; control UI follows actual input. |
| 7a | Prompt bar respects safe-area | P3 | S | A/G | Faded bar clears home indicator. |
| 7b | OSK doesn't overlap prompt bar in short landscape | P3 | S | G | No overlap at ~480px height. |
| 8 | KB+M polish: right-click hint, dblclick-mode indicator, scope `mousemove` preventDefault, `keyCode`→`code` | P3 | S | H | Hidden modes are discoverable; no text-selection interference outside canvas. |

---

## 11. PR-sized grouping & suggested sequence

- **PR A — Viewport & text quick wins** *(S, P1+P2)* — `6.1, 4.4, 1.2, 4.5, 7a`.
  Pure CSS/HTML, low risk, unblocks safe-area for everything else. **Do first.**
- **PR B — DPR-aware canvas** *(L, P1)* — `1.1, 1.3`. The headline fix; isolated
  to `resize()` + the draw transform. Spike the camera-transform interaction
  first.
- **PR C — Fullscreen correctness** *(M, P1)* — `2.1, 2.3`. Removes the dead iOS
  control.
- **PR D — Touch targets & feel** *(M, P1/P2)* — `2.2, 5.2, 5.3`. The core
  "controls feel right on mobile" PR.
- **PR E — Emoji wheel rebuild** *(M, P2)* — `3.1, 3.2` (`3.3` as a constraint).
- **PR F — Responsive navbar & buttons** *(M, P2)* — `4.1, 4.3, 5.1, 4.2`.
  Establishes the §0 breakpoints + `(pointer: coarse)` query the rest reuse.
- **PR G — Touch event hardening** *(S/M, P2/P3)* — `6.2, 6.3, 7b`.
- **PR H — Desktop KB+M polish** *(S, P3)* — `8`.

**Sequence:** A → B → C → D, then E / F / G in parallel, then H. PRs A and F can
start in parallel since F introduces the breakpoint scaffolding that A's
`(pointer: coarse)` tweaks slot into.

**Still needs a decision (not blocking):** 6.3's static-vs-dynamic input-scheme
strategy, and whether 4.2 (full Bootstrap navbar) is worth it given how little
the navbar holds today.

---

### Appendix — files referenced

| Area | File(s) |
| --- | --- |
| Page markup / viewport meta | `client/play.html`, `client/index.html`, `client/join.html`, `client/create.html` |
| All styling (no media queries) | `client/css/styles.css` |
| Canvas sizing / fullscreen / resize | `client/scripts/game.js` (`resize` 185, `goFullScreen` 311) |
| Touch input, virtual buttons, emoji open | `client/scripts/input.js` |
| Joystick / button classes | `client/scripts/joystick.js` |
| On-canvas touch controls & labels | `client/scripts/draw.js` (`drawTouchControls` 1224, `drawTouchLabel` 1320) |
| Gamepad (in-game / menu / editor) | `client/scripts/gamepad.js`, `menuGamepad.js`, `editorGamepad.js` |
| On-screen keyboard | `client/scripts/osk.js` |
| Emoji wheel setup / send | `client/scripts/client.js` (`setupEmojiWheel` 60, `sendEmoji` 478) |
