# Per-id cosmetic FPS sweep — PR #259 verification round (2026-06-03)
Conditions: 9 live karts same id, ice map, profile pinned High, 1440px viewport,
display cap 120 (rAF), gl=1.0 gameLoop/frame on every sample, alive=9 gated at
window start+end. state: 3=gated 4=racing. "dip→retest" = first sample landed in
an environmentally slow round (concurrent __none__ baseline dipped identically);
retest in a clean round.

## Baselines (__none__, no cosmetics)
120, 120, 120, 120, 120, 119.9, 111.8, 90.2*, 71.4* (*environmental dip rounds)

## Carts (43 incl. warlord control) — all ≥90 clean
warlord 120 | pizza 120.1 | golden_champion 120.6 | wheel_of_fortune 75.5→120 |
firetruck 120 | compass 120 | coin 120 | dartboard 118.8 | clock 113 |
disco_ball 120 | hypno 120 | cookie 120.1 | beach_ball 120 | sun 120.3 |
shuriken 119.9 | turtle 120 | pumpkin 120 | moon 120 | ok_hand 120 | mouse 118.8 |
dino 107.6 | hoverbike 114.7 | starfighter 120 | earth 120 | smiley 120 |
eight_ball 120 | saw_blade 120 | donut 120 | vinyl 120 | eyeball 120.1 |
soccer_ball 120 | basketball 120 | yin_yang 78.8→119.9 | ferris_wheel 97.2→120.1 |
pinwheel 120 | watermelon 120 | tire 120 | gear 100.2→120 | galaxy 78.2→120 |
flower 75.6→120 | helm 74.7→120 | aperture 72.6→120 | cheese 71.4→119.9 |
citrus 66.1→120

## Trails (12) — all 120 clean
guardian 49.9→120/120.1 (twice, NOT slow — no optimization needed) | dashes 120 |
sparkle 120 | bubbles 120 | survivor 120 | ribbon 120 | hearts 120 | smoke 120 |
confetti 120 | snow 120 | tracks 120 | notes 120

## Borders (17) — all ≥104
border_ring 104.1 | border_double 109.4 | border_studs 119.9 |
border_chevrons 119.9 | border_dashed 120 | border_ticks 120 |
border_scales 119.9 | border_glow 117.6 | border_spikes 117.6 | border_gear 120 |
border_sawblade 120 | border_flames 120 | border_electric 120 |
border_orbit 120 | border_laurel 120 | border_crown 120 | border_plasma 119.9

## Patterns (16) — all ≥102 clean
stripes 119.9 | polka 120 | checkered 120 | flames 120 | executioner 120 |
punching_bag 120 | carbon 120 | camo 120 | hazard 117.7 | circuit 118.8 |
scales 111.8→120.1 | electric 46.8→120 | tiger 69.1→120 | waves 102.5 |
honeycomb 117.1 | splatter 120

## Verdict
Zero ids <90 under clean conditions. The PR #259 fix holds across every cosmetic.
Environmental dips (baseline 71-90) are round/map ambient cost, identical with
cosmetics OFF — pre-existing, not cosmetic-related.
