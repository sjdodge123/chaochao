# Backlog

Tracked work that is known and intentionally deferred. The currently-in-progress changes are not listed here.

## In-game play (`client/scripts/input.js`, `client/play.html`)

### Bugs

- **Touch handlers crash when `virtualButtonList` is null.** The `touchstart`/`touchend`/`touchmove` listeners are registered unconditionally (`input.js:22-24`), but `virtualButtonList` starts as `null` (`input.js:6`) and is only built by `setupVirtualbuttons()` when `isTouchDevice()` is true (`input.js:30-32`). On a hybrid device where `isTouchDevice()` returns false but the browser still dispatches touch events (touchscreen laptop + trackpad, a force-touch trackpad, or Chrome touch emulation), `onTouchStart`/`onTouchEnd` iterate `virtualButtonList.length` and throw `Cannot read properties of null (reading 'length')`. It doesn't break gameplay — the handlers just abort — but it spams the console. Fix: guard the touch handlers with an early `if (!virtualButtonList) return;`, or build the button list unconditionally at init. Pre-existing; surfaced during local-multiplayer controller testing but unrelated to it (touch input is out of scope for local MP).

## Map editor (`client/scripts/create.js`, `client/create.html`)

### Bugs

- **Duplicate-hazard selection collisions.** `updateSelectedObject` and `removeSelectedObject` match by `id + x + y`, so two same-type hazards stacked at identical coordinates can only be edited/deleted as the first one found. Track the array index of the selected hazard instead.
- **Map JSON is larger than it needs to be.** `vMap.cells` is the raw voronoi structure with `edge` objects shared (and serialized) twice per pair of cells, plus per-halfedge `angle`. Existing maps in `client/maps/` are hundreds of KB largely from this. A minimal export — site coords + tile id, with the voronoi recomputed on load (or just edge endpoints stored once) — would shrink JSON dramatically.

### UX

- **No feedback for missing inputs.** Copy-to-clipboard silently substitutes `"anonymous"`/`"unknown"` for empty author/name. Email is only validated at submit time. Highlight required fields before allowing export.
- **Submit status button never resets.** "Submitting…"/"Success"/"Failed" lingers indefinitely. Reset on any input change, on a fresh submit attempt, or after a short timeout.
- **Rotate is fixed at +15° clockwise.** No counter-rotation, no finer step. Cheap upgrade: shift-click for -15°, or a number input for absolute angle.
- **No undo.** A full undo stack across tile paints would be expensive, but at minimum "undo last hazard placement" is trivial and would prevent a lot of frustration.
- **No keyboard shortcuts** for switching brushes/tools. Purely mouse-driven editing slows experienced users.
- **Right-click is suppressed but does nothing useful.** Common expectation: right-click on a hazard deletes it; right-click drag erases to default tile.

### Performance

- **`cellIdFromPoint` runs an O(N × edges) point-in-polygon over all 250 cells on every mousemove.** A coarse spatial grid keyed by site x/y would cut this dramatically; matters on low-end laptops and touch devices.
- **`locateObject` / `addObjectToMap` do nested loops to look up a hazard config by id.** Build a `hazardById` map once when config arrives and use it everywhere.
- **Tiny: `makePattern`/`makeSeamlessPattern` retain the source canvas in closure scope.** Only matters if patterns are ever rebuilt; currently they aren't.

## Join page (`client/join.html`, `client/scripts/join.js`, related CSS)

### Bugs

- **`getRooms` server response silently drops full/locked rooms.** A room that locks (e.g. mid-race with no joinable slots) just disappears from the list with no UI signal. Consider showing them greyed out with a "Full" or "In progress" label so users can see what's happening, or at least surfacing a count.

### UX

- **The Round / Map / Players labels repeat inline inside every card.** A single shared header above the list, or a more table-like grid, would scan faster when many rooms are listed.
- **Game ID is shown on the card but there's no copy/share affordance.** Add a "copy invite link" button so a host can paste the link into chat instead of dictating a Game ID over voice.
- **State is plain text with no joinability cue.** A coloured badge (green = Lobby/joinable, yellow = Racing in progress, grey = Game Over) would tell players at a glance whether mid-game joining is a good idea.

### CSS / Layout

- **No responsive design / no mobile-specific layout.** At narrow widths the flex card may still need a column layout (stat group on top, button on bottom).
- **`section { margin-top: var(--navbar-height); height: 100vh }`** leaves a big empty area below the card list on tall screens. Either centre the join UI vertically or let it hug the top with a sensible cap.

## Landing page (`client/index.html`, related CSS)

### UX

- **No live "X games in progress / Y players online" signal.** The server already serves this data via `getRooms` / `config`. Reuse the join-page pattern (socket connect → roomListing → DOM update) on the landing page so visitors can tell at a glance whether to click Play or Join. Include a stale-data fallback ("Server sleeping…") if no response arrives.
- **Patch Notes opens GitHub Releases in a new tab.** Now that `CHANGELOG.md` exists, an in-page modal (fetching the latest release notes from GitHub or the local CHANGELOG) would be friendlier to non-technical players.
- **No "how to play" / controls hint.** WASD-vs-mouse drive isn't obvious to newcomers; one line + a short link is enough.

### Polish

- **`#game-title { font-family: "San Francisco" }`** renders only on macOS. Either ship a real web font or pick a system stack with broader cross-platform fidelity.
- **No screenshot / animated preview.** A small hero image (or a rotating row of map thumbnails — we already serve them via `contentDelivery`) would set expectations for the game.
- **No mobile-specific layout** beyond Bootstrap defaults. Card and title don't reflow; consider a proper mobile pass.
