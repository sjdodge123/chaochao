# Cosmetics ladder — full 97-item mapping (Lv1–100 + medal achievements)

Supersedes the original Lv1–30 draft. Approved direction (operator, 2026-05-30):

- **Unlock every 2 levels**, ladder runs **Lv2 → Lv100 = 50 level unlocks**.
- The level ladder hands out the **commons + uncommons** (steady drip, low rarity).
- **Achievements hand out the rares/epics/legendaries** — 47 items spread across
  **18 medal counters** (6 original + 4 from main's v0.26.0 medal card —
  `zombieSlayer`/`heavyHitter`/`pinball`/`iceSkater` — + 8 new ours), so each medal has
  only 2–4 gentle tiers and there are many varied ways to earn cosmetics. The 4 v0.26.0
  medals are competitive ("most in a match"); thresholds for them are "win the medal N
  times," matching the other competitive-medal cosmetics.
- **Borders are mixed into both** ladders like any other slot.

Four independent equip slots: **cart** (shape) · **pattern** (texture, sphere only) ·
**border** (rim, shares the pattern column, composes over any cart) · **trail**.
All tint to the per-match player color (trails always render in player color).

Inventory: **45 carts · 17 patterns · 17 trails · 18 borders = 97**.
Split: **50 level · 47 achievement**. Every id appears exactly once below.

---

## A. Level ladder — Lv2–100 (50 unlocks, every 2 levels)

Commons fill the early ramp (Lv2–54), uncommons the back half (Lv56–100). Slots are
interleaved for variety, weighted to carts (they're the biggest roster).

| Lv | Slot | Item id | Display | Rarity |
|----|------|---------|---------|--------|
| 2  | pattern | `stripes` | Racing Stripes | common |
| 4  | cart | `pizza` | Pizza | common |
| 6  | trail | `dashes` | Dashes | common |
| 8  | cart | `donut` | Donut | common |
| 10 | border | `border_ring` | Ring | common |
| 12 | cart | `cookie` | Cookie | common |
| 14 | pattern | `hazard` | Hazard Stripes | common |
| 16 | cart | `beach_ball` | Beach Ball | common |
| 18 | trail | `smoke` | Smoke | common |
| 20 | cart | `soccer_ball` | Soccer Ball | common |
| 22 | border | `border_double` | Double Ring | common |
| 24 | cart | `basketball` | Basketball | common |
| 26 | pattern | `waves` | Waves | common |
| 28 | cart | `watermelon` | Watermelon | common |
| 30 | trail | `tracks` | Tire Tracks | common |
| 32 | cart | `tire` | Tire | common |
| 34 | border | `border_ticks` | Ticks | common |
| 36 | cart | `smiley` | Smiley | common |
| 38 | pattern | `splatter` | Splatter | common |
| 40 | cart | `eight_ball` | 8-Ball | common |
| 42 | trail | `snow` | Snowfall | common |
| 44 | cart | `citrus` | Citrus | common |
| 46 | border | `border_dashed` | Dashed | common |
| 48 | cart | `cheese` | Cheese | common |
| 50 | cart | `coin` | Coin | common |
| 52 | border | `border_chevrons` | Chevrons | common |
| 54 | cart | `mouse` | Mouse | common |
| 56 | pattern | `polka` | Polka | uncommon |
| 58 | cart | `firetruck` | Drone | uncommon |
| 60 | trail | `sparkle` | Sparkle | uncommon |
| 62 | cart | `earth` | Earth | uncommon |
| 64 | border | `border_studs` | Studs | uncommon |
| 66 | cart | `vinyl` | Vinyl | uncommon |
| 68 | pattern | `camo` | Camo | uncommon |
| 70 | cart | `compass` | Compass | uncommon |
| 72 | trail | `hearts` | Hearts | uncommon |
| 74 | cart | `clock` | Clock | uncommon |
| 76 | border | `border_scales` | Scaled Rim | uncommon |
| 78 | cart | `eyeball` | Eyeball | uncommon |
| 80 | pattern | `scales` | Dragon Scales | uncommon |
| 82 | cart | `shuriken` | Shuriken | uncommon |
| 84 | trail | `confetti` | Confetti | uncommon |
| 86 | cart | `dartboard` | Dartboard | uncommon |
| 88 | pattern | `honeycomb` | Honeycomb | uncommon |
| 90 | cart | `sun` | Sun | uncommon |
| 92 | trail | `notes` | Music Notes | uncommon |
| 94 | cart | `moon` | Moon | uncommon |
| 96 | cart | `snowflake` | Snowflake | uncommon |
| 98 | cart | `flower` | Flower | uncommon |
| 100 | cart | `ok_hand` | OK Hand | uncommon |

Per-slot in the level ladder: **27 carts · 8 patterns · 8 trails · 7 borders**.

---

## B. Achievement ladder — 47 unlocks across 18 medal counters

Each medal is a short tiered ladder; the **threshold** = the cumulative `medal_counts[stat]`
value. Items are themed to the medal. **★ = already tracked** by the server (6 medals);
the other 12 need a new `medal_counts` key + an increment hook (see §D for where).

### Skill / prestige medals (epics + legendaries)

**★ `wins`** — victory (4) · *1st-place finishes*
| Thr | Slot | Item id | Display |
|----:|------|---------|---------|
| 25  | cart | `galaxy` | Galaxy |
| 50  | border | `border_laurel` | Laurel |
| 100 | cart | `golden_champion` | Golden Champion |
| 200 | border | `border_crown` | Crown |

**★ `brutalist`** — brutal-round wins (3)
| Thr | Slot | Item id | Display |
|----:|------|---------|---------|
| 25  | cart | `warlord` | Warlord |
| 60  | border | `border_runes` | Runes |
| 120 | border | `border_plasma` | Plasma |

**★ `mostKills`** — lethality (3)
| Thr | Slot | Item id | Display |
|----:|------|---------|---------|
| 30  | pattern | `executioner` | Executioner |
| 75  | pattern | `electric` | Electric |
| 150 | cart | `aperture` | Aperture |

**★ `survivalist`** — last-one-standing (3)
| Thr | Slot | Item id | Display |
|----:|------|---------|---------|
| 25  | trail | `survivor` | Survivor |
| 60  | cart | `hoverbike` | Hoverbike |
| 120 | trail | `aurora` | Aurora |

**`winStreak`** — consecutive wins, best streak (3)
| Thr | Slot | Item id | Display |
|----:|------|---------|---------|
| 3   | trail | `comet` | Comet |
| 5   | border | `border_electric` | Electric Rim |
| 8   | cart | `starfighter` | Starfighter |

### Mid skill medals (rares + epics)

**★ `savior`** — saves (3)
| Thr | Slot | Item id | Display |
|----:|------|---------|---------|
| 15  | trail | `ribbon` | Ribbon |
| 50  | trail | `guardian` | Guardian |
| 100 | pattern | `flames` | Flames |

**★ `mostMurdered`** — took a beating (3)
| Thr | Slot | Item id | Display |
|----:|------|---------|---------|
| 30  | pattern | `punching_bag` | Punching Bag |
| 75  | trail | `bubbles` | Bubbles |
| 150 | pattern | `nebula` | Nebula |

**`zombieSlayer`** — won the Zombie Slayer medal (main's medal, v0.26.0) (2)
| Thr | Slot | Item id | Display |
|----:|------|---------|---------|
| 15  | trail | `bolt` | Bolt |
| 50  | trail | `neon` | Neon |

**`abilitiesUsed`** — abilities triggered (3)
| Thr | Slot | Item id | Display |
|----:|------|---------|---------|
| 50  | cart | `yin_yang` | Yin-Yang |
| 200 | cart | `hypno` | Hypno |
| 500 | border | `border_orbit` | Orbit |

**`goalsReached`** — reached the goal tile (3)
| Thr | Slot | Item id | Display |
|----:|------|---------|---------|
| 25  | cart | `ferris_wheel` | Ferris Wheel |
| 75  | cart | `wheel_of_fortune` | Wheel of Fortune |
| 200 | cart | `disco_ball` | Disco Ball |

### Participation / grind medals (uncommons + rares)

**`gamesPlayed`** — matches played (4)
| Thr | Slot | Item id | Display |
|----:|------|---------|---------|
| 10  | cart | `turtle` | Turtle |
| 50  | cart | `pumpkin` | Pumpkin |
| 150 | cart | `saw_blade` | Saw Blade |
| 400 | border | `border_gear` | Gear Rim |

**`heavyHitter`** — won the Heavy Hitter medal (main's medal, v0.26.0) (2)
| Thr | Slot | Item id | Display |
|----:|------|---------|---------|
| 20  | cart | `gear` | Gear |
| 60  | cart | `dino` | Dino |

**`cosmeticGames`** — matches with a cart/pattern/border equipped (2)
| Thr | Slot | Item id | Display |
|----:|------|---------|---------|
| 10  | pattern | `tiger` | Tiger |
| 50  | cart | `pinwheel` | Pinwheel |

**`pinball`** — won the Pinball medal (main's medal, v0.26.0) (2)
| Thr | Slot | Item id | Display |
|----:|------|---------|---------|
| 25  | border | `border_spikes` | Spikes |
| 80  | border | `border_sawblade` | Sawblade Rim |

**`iceSkater`** — won the Ice Skater medal (main's medal, v0.26.0) (2)
| Thr | Slot | Item id | Display |
|----:|------|---------|---------|
| 20  | trail | `ripple` | Ripple |
| 60  | border | `border_glow` | Glow |

**`recapAppearances`** — featured in an end-game recap (2)
| Thr | Slot | Item id | Display |
|----:|------|---------|---------|
| 10  | cart | `helm` | Helm |
| 40  | border | `border_flames` | Flame Rim |

**`joinInProgress`** — joined a match already racing (1)
| Thr | Slot | Item id | Display |
|----:|------|---------|---------|
| 15  | pattern | `circuit` | Circuit |

**`mapsSubmitted`** — maps submitted via the editor (2)
| Thr | Slot | Item id | Display |
|----:|------|---------|---------|
| 1   | pattern | `carbon` | Carbon Fiber |
| 5   | pattern | `checkered` | Checkered |

Per-slot in achievements: **18 carts · 9 patterns · 9 trails · 11 borders** (47 total,
every id once). Medals: **6 existing (★) + 12 new = 18**.

---

## C. Rarity totals (sanity)

| Rarity | Count | Source |
|--------|------:|--------|
| common | 27 | all level |
| uncommon | 29 | 23 level + 6 achievement |
| rare | 18 | all achievement |
| epic | 18 | all achievement |
| legendary | 5 | all achievement |
| **total** | **97** | 50 level + 47 achievement |

---

## D. Implementation (after this mapping is approved)

For each `open` item in `client/scripts/skinRegistry.js` **and** `server/skinRegistry.js`,
replace `unlock: { kind: 'open' }` with either:

- `unlock: { kind: 'level', level: N }`, or
- `unlock: { kind: 'achievement', stat: '<medal>', threshold: T }`.

The 21 items that already have level/achievement homes get **re-pointed** to the rows
above (several move — e.g. `firetruck` 12→58, `dino` 18→`windupPunchHits` 100, `checkered`
14→`mapsSubmitted` 5, the cosmic carts to medal ladders). `UNLOCK_ALL_COSMETICS` stays the
local test override; nothing here changes the server-authoritative gate or the
`ALLOW_SUPABASE_WRITES` kill-switch. Achievement gating reads `medal_counts[stat] >= threshold`.

### New medal counters to track (12)

All viable today — each needs a `medal_counts` key + one increment site:

| Medal | Where to increment |
|-------|--------------------|
| `gamesPlayed` | match-end tally, once per player per match |
| `goalsReached` | when a player reaches the goal tile (`reachedGoal`) |
| `winStreak` | match-end: bump on win, reset to 0 on loss; store best |
| `abilitiesUsed` | ability-activation path (per trigger) |
| `recapAppearances` | match-end, for each player included in the recap payload |
| `cosmeticGames` | match-end if any of cart/pattern/trail ≠ default |
| `joinInProgress` | on join when room state is `racing` |
| `mapsSubmitted` | `messenger` `submitNewMap` handler (note: currently unauth) |

Counters live in the `progression.medal_counts` jsonb (no schema migration needed —
it's already a free-form jsonb). All writes stay behind `ALLOW_SUPABASE_WRITES`.

Painter contract unchanged (see git history of this file / `draw.js`):
cart/pattern/border painters `draw…(ctx, anim, paint[, heading, hot])`; trails select an
effect rendered in `player.color`.
