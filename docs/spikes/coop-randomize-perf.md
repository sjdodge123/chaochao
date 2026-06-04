# Couch co-op render perf — skin-hub 🎲 randomize spike + 4-local steady-state (2026-06-04)

Operator report: visible lag when two controller players hammer the skin-hub 🎲
random-loadout button (branch `worktree-skin-hub-random-button`). This round
reproduced it with 4 simulated local players (the couch cap), found the root
cause, fixed it, and verified couch co-op steady-state racing — the last
render-coverage gap from the PR #259/#261 cosmetic-perf rounds.

Conditions: branch `worktree-coop-render-perf` = skin-hub-random-button rebased
onto main `ba9846f` (includes the PR #259 perf fixes — measuring without the
rebase would re-measure already-fixed collapse paths). Real input path: synthetic
standard-mapping pads behind a monkey-patched `navigator.getGamepads()` drive
gamepad.js end-to-end (A-edge join → per-slot sockets → D-pad panel nav → A-press
randomize); P1 keyboard via the input-agnostic handlers. Profile pinned High,
1400px popup viewport, display cap 120 (rAF on this Mac), gl=1.0 every sample.
Worst-frame = max rAF delta in the 0–500ms window after each press.

## Root cause of the randomize spike

`tfxRGB` (trailEffects.js) and `cartSkinRGB` (draw.js) parsed colours by painting
one pixel on a **freshly created 1×1 canvas** and reading it back with
`getImageData` — a synchronous GPU pipeline flush per call. Results are cached
per colour string, but every 🎲 press picks a NEW colour, so each press
cache-missed in several painters at once (trail + cart shades + border), ~5–15ms
per painter, stacking across the up-to-4 open co-op panels (each panel's
"Equipped" preview paints the trail + kart through the real chokepoints).
Measured isolated: first-call sparkle 45.4ms, per-new-colour sparkle 13.7ms /
comet 14.6ms / most painters 4–8ms; same-colour repeat ~0ms. Profiler breakdown
of a spike frame: drawObjects 35.4 → drawStationPanel 35.0 → drawEquippedPreview
34.9 → paintTrailFx 38.8 (its glow scratch helpers only 0.6).

Fix (`2bd22b7`): pure-JS colour parse (`tfxParseColorFast`: hex/rgb()/hsl()),
shared by both call sites; exotic strings fall back to ONE persistent
`willReadFrequently` canvas instead of a fresh canvas per miss. Parser verified
value-identical to the readback for all 22 palette colours + rgb/hsl forms
(alpha-carrying inputs now return un-premultiplied rgb — more correct; game
colours are always opaque hex).

## Randomize-spike results (4 locals at the skin hub, lobby, worst-frame ms)

92 presses/round: 32 singles rotating P1–P4, rapid doubles (150ms apart, P2-pad),
rapid triples (P3-pad), 8 simultaneous pair presses (P2+P3 — the operator's
2-controller repro), 6 simultaneous quad presses. Pads press through the real
gamepad path; P1 through the keyboard handler.

| series                         | pre-fix (cold page) | post-fix (cold page) |
|--------------------------------|---------------------|----------------------|
| singles (32)                   | 11–69.7 (8 > 40ms)  | 8.7–16.4             |
| rapid doubles ×2 (P2)          | 12.6–55.2           | 10.9–13.6            |
| rapid triples ×3 (P3)          | 16.8–53.7           | 12.4–14.0            |
| simultaneous pairs P2+P3 (8)   | 15.8–21.3           | 11.3–14.4            |
| simultaneous quads ×4 (6)      | 14.1–44.1           | 13.0–15.0            |
| **worst overall**              | **69.7**            | **16.4**             |

Pre-fix spikes were first-use-per-(painter,colour) — warm repeats sat at 11–21ms
even for quads; the fix removes the cold cliff entirely. Post-fix worst frame =
one dropped frame at 120Hz, none at 60Hz.

## Co-op steady-state (4 locals + 6 bots = 10 karts, racing, High)

All in random cosmetics (bots via the uncommitted world.js dev patch, locals
re-randomized each lobby cycle). 224 valid gated 1.7s windows across ~15
race cycles on auto-cycling maps (ice present), interleaved `__none__`
baselines, alive-count recorded at window start+end.

| state, grid              | `__none__` baseline (n, min/med) | random cosmetics (n, min/med) |
|--------------------------|----------------------------------|-------------------------------|
| gated, full grid         | 12, 117.8 / 120                  | 10, 119.9 / 120               |
| racing, ≥8 alive         | 40, 85.7 / 120                   | 36, **119.6 / 120**           |
| racing, <8 alive         | 58, 119.6 / 120                  | 60, 116.1 / 120               |
| collapsing (late grid)   | 3, 119.9 / 120                   | 5, 119.9 / 120                |

Random-cosmetics windows never dipped below 116; the only sub-90 readings were
on *baseline* (cosmetics-off) windows — environmental, per the known
brutal-overlay whole-frame effect. Co-op-specific per-local UI (halos ×4,
stamina meters ×4, pad blocks) is included in every window. Matches the
single-player verification numbers (docs/spikes/cosmetic-perf-verification.md)
— no co-op regression.

Collapsing full-grid windows rarely validate (state transitions cut them);
captured collapsing windows all read ~120 but coverage there is thin.

## Re-randomize cache growth (scenario 3)

15 lobby cycles × 4 players × 5-slot randomize (≈300 cosmetic swaps): skin-layer
cache plateaued at 8 entries, glyph cache 0, tfx colour cache 37, cart colour
cache 24 — all bounded by palette × painters; JS heap flat at 60–67MB. No
texture-upload stutter signature, no unbounded growth.

## Auto-resolved tier pass

Auto resolves by window width (`detectPerfTier`), so both resolutions were run
post-fix:

- **Auto→High** (1512px window — what a desktop player gets): full 92-press
  suite on a cold page, worst frame 28.9ms (a single; quads 13.7, doubles 9.4,
  triples 9.6, pairs 10.9). Consistent with the pinned-High round.
- **Auto→Balanced** (870px window — the iPad-class tier): 28 presses
  (16 singles + 3 simultaneous quads), worst frame **11.5ms**; steady-state
  racing at 10 karts on Balanced: baseline n=126 min 118.4 / med 120, random
  cosmetics n=128 min 119.5 / med 120.

## Traps hit this round (added to the harness memory)

- Parked pad players idle out: pad slots emit no movement packets while parked;
  emit `lobbyActivity` per slot every ~15s (the panel-activity AFK deferral).
- `setCosmetic` is lobby-only server-side — per-round re-randomize must happen in
  the lobby phase (which is also the real usage pattern).
- Lobby race start needs a MAJORITY of players standing on the start button
  (`lobbyButtonPressedCount / playerCount > 50%`) — send all locals, not just P1.
- Two agent sessions sharing one Chrome window fight over tab visibility; run the
  game in a `window.open` popup (own OS window, independent visibility). Popup
  needs a trusted click: arm a one-shot in-page click handler, then click via the
  computer tool.
