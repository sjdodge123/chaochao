# Gameplay balance — statistical distribution analysis (2026-06-11)

Three independent data sources, cross-referenced:

1. **GA4 prod events** (property 454757771, 2026-03-13 → 2026-06-11): `round_start`/`round_complete`/`match_end`/`match_abandon` with `map`, `playlist`, `won`, `duration_seconds`, `players`, `bots` params.
2. **Supabase prod DB** (read-only): `map_times` (40 personal-best rows over 22 maps), `progression` (6 signed-in users), `map_ratings` (5 votes).
3. **Headless autopilot sweep** (real server engine, no network): 51 maps × 8 seeds × 6 AI bots × 120 s windows via `.github/scripts/ai-fitness.js` plus an extension that tagged every death with its authoritative `playerDied.cause` and recorded per-round finish times. Raw per-map data: [`gameplay-balance-sim-results.json`](gameplay-balance-sim-results.json).

## Data-quality caveats (read first)

- GA "4Suns!" volume (173 round starts) averages **~21 bots/round** — that is perf-harness traffic, not organic play. Excluded from per-map conclusions.
- GA `round_complete`/`round_start` ratio measures **players still present at round end** (retention through the round), not round winnability.
- Prod DB has only 6 signed-in users / 5 map ratings — anecdotal, used only as corroboration.
- Sim rates are **bot** rates. Two maps are known-broken for AI, not balance signals: **GoodLuck** (spawn-lava map issue) and **TheIsland** (central ice/lava/bumper gauntlet is AI-uncompletable).
- GA map names are partly historical (pre-v0.32.0 Title-Case renames + since-removed maps like BumperGate, Zoomies, Valentine variants).

## 1. Map difficulty distribution (sim, per-round bot finisher fraction)

Distribution over 51 maps of "fraction of 6 bots that finish an observed round" (`perRoundFrac`):

| Band | Maps | Count |
|---|---|---|
| 0.00–0.10 (brutal) | EveryoneDies, GoodLuck†, TheIsland†, Sidewinder, MurderRow, Shortcut, HellsHelix, Valentine, WhatGoesUp, RiskIt, Damnation | 11 |
| 0.10–0.20 (hard) | ItsRightThere, PathOfPain, ChooseAPath, Zoomies, ToxicWasteland, RaceCondition, TheGauntlet | 7 |
| 0.20–0.35 (mid — the healthy band) | 23 maps incl. Crossroads, Pivot, ItsAnA, FastAndSlow, IcyLake, 4Suns!, RiskyBusiness | 23 |
| 0.35–0.50 (easy) | ItsGotLayers, JollyJaunt, YouGetAnAbility, Strand, LavaLakes, ThinBlackLine | 6 |
| 0.50–0.65 (very easy) | YouGotOptions, RushHour, GoldEyes, RandomLakes | 4 |

† known-broken for AI, not a difficulty signal.

The distribution is **wide and bottom-heavy**: ~35% of the catalog sits below 0.20 while the median map sits ~0.26. Full per-map table (rate, medFinishSec, spread, round duration, frozen count, death-cause split, medianDeathX, avgMaxX) is in the JSON next to this doc.

**The too-hard signature is consistent**: heavy *raw-lava-while-racing* deaths plus **medianDeathX ≈ 76** (the start line) on EveryoneDies / Sidewinder / HellsHelix / Valentine — karts burn before leaving spawn. WhatGoesUp is the exception: bots progress far (avgMaxX 1049) but rarely land the finish → hard final approach, not a hard map throughout.

**The too-easy cluster is not degenerate**: GoldEyes (rate 1.90 finishes/bot/window) had **1 raw-lava death in 384 bot-rounds**; RandomLakes/RushHour/YouGotOptions race in 22–27 s with the *widest* first-to-last finisher spreads (4.2–5.2 s), so they read as fast multi-finisher race maps rather than freeways. Still, they are near-zero-threat.

## 2. Death economy (sim, 3,739 cause-tagged deaths)

- **64%** raw lava while racing (2,394)
- **34%** caught by the collapse front (1,286)
- **1.6%** other — gate-wall/brutal effects (59), concentrated on EveryoneDies/Shortcut/Valentine/GoodLuck (gate spawns don't avoid lava)

Hard maps kill with raw lava; easy maps kill almost exclusively via collapse (BumperCity is the purest collapse-killer: 0 raw-lava vs 91 collapse). Balance implication: with scoring at **+2/+1 for finishers, −1 per death (floor 0)**, lava-heavy maps produce negative-sum rounds where nobody banks notches — 0-finisher maps (EveryoneDies) decide rounds purely by death attrition and stretch matches.

## 3. Round + match length distributions

- **Sim round duration**: 38–73 s (median ~47 s). **Sim median finish**: 22–82 s.
- **GA human round duration** (avg per map): 8–51.5 s — a **5–6× spread**. Longest: Good Luck 51.5, sidewinder 51, its_right_there 48.7, dragon breath 48, the lobster 48.2. Shortest: YouGotOptions 8, Zoomies 11, 4 Suns! 13, switch up 14.5.
- **Human PBs vs bots** (`map_times` vs sim): humans run ~1.3–2× faster than bots on the same maps (Crossroads 25.2 s human-median vs 30.7 s bot; ItsRightThere 46.3 vs 61.9) — direction and ranking agree, which validates the sim as a difficulty proxy.
- **GA match length**: ~6 min to a conclusion (360 s lost / 380 s won).
- The map-fairness CI gate's "ideal par" band is 18–40 s; the GA sub-15 s cluster and the 48 s+ cluster both sit outside it.

## 4. Humans vs bots (GA, match_end)

42 match-end reports: humans won **8 (19%)** at ~7.7 karts/match (~5.6 human + ~2.1 bots). Uniform-random baseline ≈ 13% per kart — humans outperform bots but bots stay competitive. No evidence bots steal wins disproportionately.

## 5. Churn / retention (GA)

- Overall round retention 74% (1,131 starts → 839 completes).
- **All 73 match abandons occur at round 1–2** (avg round_number 1.0–1.6), spread evenly across overview (26) / collapsing (23) / racing (21) states → this is a *first-impression* problem, not late-match balance fatigue.
- Per-map retention outliers (small n, treat as leads): Rush Hour 1/9, Murder Row 1/4, WhatAClown 8/16, Risky Business 13/21 — note Rush Hour is one of the *easiest* maps by sim, so its churn is likely not difficulty.
- Playlist retention: pure 90%, all 88%, featured 64%, default 57%. Featured also has the shortest avg round (22.8 s vs 34.2 s default).

## 6. AI navigation pathologies (regardless of balance)

Frozen-alive bots cluster on **NiceKnowin'Ya (13)**, **TheGauntlet (12)**, **RandomLakes (12)**, **Async (10)** across 8 seeds — pathing hot-spots worth an `ai-fitness.js` A/B if AI work touches these terrain types.

## Recommendations (ranked)

1. **Soften the spawn-kill cluster** — EveryoneDies, Sidewinder, HellsHelix, Valentine all show medianDeathX ≈ 76 with 76–124 raw-lava deaths/384 bot-rounds. A wider safe corridor off the start line moves them from "attrition lottery" toward raceable; gate spawns avoiding lava (known mechanic gap) would fix the `other`-cause deaths on the same maps.
2. **Re-par the duration outliers** — the sub-15 s GA maps (YouGotOptions-class) and 48 s+ maps sit outside the fairness gate's own 18–40 s ideal band; consider running the existing fairness scorer over the live catalog and retiring/retuning the tails.
3. **Investigate round-1–2 churn** — abandons are entirely early; the balance data says maps aren't the cause (abandon states spread evenly). Likely onboarding/clarity (overview screen is the single biggest abandon point at 26/73).
4. **Give the very-easy four some teeth** — GoldEyes/RandomLakes/RushHour/YouGotOptions have near-zero lava threat; small hazard additions would tighten the difficulty distribution's right tail without changing their fast-race feel.
5. **Fix the frozen-bot hot-spots** (NiceKnowin'Ya, TheGauntlet, RandomLakes, Async) — inflates apparent difficulty and makes bot lobbies feel dead on those maps.
6. **Data hygiene**: exclude `bots > players/2` sessions (or filter on the existing `bots` param) in balance Explorations, so perf-harness runs stop polluting per-map GA stats.

## Follow-up prompt (operator-injectable)

> Using docs/spikes/gameplay-balance-analysis.md as the source of truth: (1) run the map-fairness scorer over the full live catalog and list maps outside the 18–40 s ideal-par band or below score 60; (2) propose concrete tile edits for the spawn-kill cluster (EveryoneDies, Sidewinder, HellsHelix, Valentine) that widen the safe start corridor without changing each map's identity, and validate each edit with an ai-fitness A/B (expect perRoundFrac to move into the 0.15–0.35 band); (3) prototype gate spawns that avoid lava-adjacent cells and measure the change in `other`-cause deaths headlessly.
