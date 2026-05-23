# Backlog

Tracked work that is known and intentionally deferred. The currently-in-progress changes are not listed here.

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
- **Each card is still wrapped in a `<form>` that does nothing.** Now that cards are rebuilt via DOM and join uses `<a href>`, the surrounding form is dead markup — clean up the structural noise.

### UX

- **The table header (Round / Current Map / Players) is per-card inline labels.** A single shared header above the list, or a more table-like grid, would scan faster when many rooms are listed.
- **Game ID is in the join URL but has no copy/share affordance.** Add a "copy invite link" button so a host can paste the link into chat instead of dictating a Game ID.
- **State is plain text with no joinability cue.** A coloured badge (green = Lobby/joinable, yellow = Racing in progress, grey = Game Over) would tell players at a glance whether mid-game joining is a good idea.
- **No "join by Game ID" input.** The server already supports it (`play.html?gameid=N` + the `enterGame` socket event) but the UI doesn't expose it. A small "Enter Game ID" field would let a host share an ID verbally.

### CSS / Layout

- **`#joinMenu { height: 400px }` is fixed.** Overflows with many rooms, wastes space with few. Make it grow with content (capped to viewport with internal scroll).
- **`.mapData { width: 100% }` is declared twice** in the same rule — minor cleanup.
- **No responsive design / no mobile-specific layout.** At narrow widths the flex card may still need a column layout (stat group on top, button on bottom).
- **`section { margin-top: var(--navbar-height); height: 100vh }`** leaves a big empty area below the card list on tall screens. Either centre the join UI vertically or let it hug the top with a sensible cap.
- **`.join-btn { height: 100% }`** is no longer needed once cards are short. Audit and drop if the new card layout doesn't need it.
