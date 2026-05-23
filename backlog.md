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

- **`cellIdFromPoint` runs an O(N × edges) point-in-polygon over all 250 cells on every mousemove** (create.js:635–644). A coarse spatial grid keyed by site x/y would cut this dramatically; matters on low-end laptops and touch devices.
- **`locateObject` / `addObjectToMap` do nested loops to look up a hazard config by id.** Build a `hazardById` map once when config arrives and use it everywhere. (create.js:537–571)
- **Tiny: `makePattern`/`makeSeamlessPattern` retain the source canvas in closure scope.** Only matters if patterns are ever rebuilt; currently they aren't.
