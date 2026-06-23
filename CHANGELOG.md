# Changelog

All notable player-facing changes land here. Anything that changes a game mechanic — gameplay tuning, game state/round logic, or physics — MUST add an entry under "Unreleased" in the same change (the `Game mechanic changes need release notes` CI job enforces this).

Write entries in the same player-friendly style as the GitHub releases: a bold lead-in plus one or two tight sentences describing what a player will notice (`- **New chill track.** Added a dreamy synth tune to the calm rotation.`). Keep the deep mechanics to a sub-bullet or a short `- *Why:* …` line rather than one long paragraph — the rendered notes are meant to scan.

Group bullets under `### Heading` subsections. Headings are normalised to a fixed category taxonomy and rendered in this marquee→minor order: **New Hazards, New Boons, New Abilities, New Brutal Rounds, New Maps & Modes, Map Editor, AI Racers, Gameplay & Balance, Controls & Couch Co-op, Audio & Visuals, Quality of Life, Bug Fixes** (see `HEADING_ALIASES`/`CATEGORY_ORDER` in `.github/scripts/changelog-lib.mjs`). Use a `### New Hazards`/`### New Boons`/`### New Abilities`/`### New Brutal Rounds` heading when you ship a brand-new one of those so it leads the notes; common aliases fold automatically (`### General` → Quality of Life, `### Ability changes`/`### Combat` → Gameplay & Balance, `### Display`/`### Animations & game feel` → Audio & Visuals, etc.). An unrecognised heading still renders (kept verbatim, just before Bug Fixes) but CI warns about it.

Releases are cut automatically on merge to `main` by the `Release on merge to main` workflow: when `## Unreleased` has notes, it moves them under a new `## vX.Y.Z — YYYY-MM-DD` heading, resets `Unreleased`, bumps `package.json`, tags `vX.Y.Z`, and publishes the GitHub release using that section as the body. The version bump comes from the merged PR's label — `release:major`, `release:minor`, or `release:patch` (default `patch`). PRs that add no notes don't trigger a release.

After each release the same workflow also rolls every `vX.Y.Z` from the current calendar week (Monday–Sunday, UTC) into a single consolidated `week-YYYY-MM-DD` GitHub release, and the landing-page banner shows **one headline for the week** linking to it. To feature a bullet, prefix it with `[headline]`, e.g. `- [headline] Now with controller support!` — the most recent flagged bullet of the week drives the banner, and the marker is stripped everywhere it's shown (banner, per-PR release notes, weekly digest). Up to three flagged bullets (newest first) also name the digest's release title; by default the short name is taken from the bold lead-in (`- [headline] **New hazard: Magpie Drone.** …` → "Magpie Drone"), or set it explicitly with `[headline:Short Name]`. With nothing flagged the title stays the bare "Week of …". Keep headline bullets to **180 characters max** (CI-enforced) — the banner clamps to three lines, so put the detail in regular bullets instead.

To re-render a past week's digest with the current formatting, run the `Release on merge to main` workflow manually (Actions → Run workflow) with the **week** input set to any date in that week — it rebuilds just that `week-YYYY-MM-DD` release and cuts no new version.

## Unreleased

### Controls & Couch Co-op

- **Touch controls got a glow-up.** The on-screen joystick and punch button are redrawn as chunky, tactile pads — a filled thumb-stick with direction arrows and a glossy punch button — so it reads at a glance where to move and attack. First-timers now get a one-time guided walkthrough that takes them through every control one step at a time — move in each direction, punch, hold to kick, then the settings / emoji / fullscreen buttons — and you can Skip it anytime.
- **Phone camera sits closer.** On touch devices the race camera zooms in a touch tighter so karts read clearly on smaller screens.

### Map editor

- **Barriers now block exactly where a kart can't drive.** The fairness check used to seal a map off the moment a wall *visually* crossed the straight line between two regions — even when you'd left a clear lane to drive through — so maps got a false "No goal is reachable" rejection. It now traces the actual gaps a kart drives through: weaving wall mazes with real lanes pass, while a wall that genuinely **divides the map** (even one running straight through the middle of a region) is still correctly rejected as unfinishable.
- **Estimated racing lines respect your walls.** The fairness overlay's routes used to draw straight through solid barriers; they now thread the gaps and route around walls — the exact same path the AI racers steer, so the preview line and the bots agree.

### AI Racers

- **Bots steer around barriers.** AI racers used to aim at cell centres and try to drive straight through a wall; they now thread the doorways between walls, following the same line the fairness preview draws.
- **Bots grab Checkpoints.** AI racers now detour to attune to a Checkpoint flag (Second Wind Totem) when one is roughly on their way — banking the free revive like a smart player would, then carrying on to the goal.
- **Bots break out of vortex wells.** A bot pulled to a near-stop in a vortex's ring now double-taps a dash to burst free toward its route, instead of crawling against the pull.
- **Bots fight off antlions too.** The racing bots now swing at an antlion that's right on top of them — knocking it back into the sand — instead of only trying to dodge away, so they no longer get helplessly herded into the lava on sand-heavy maps.

### Gameplay & Balance

- **Walls have real thickness.** Barriers are 14px-wide bars, so you now stop with your kart's edge against the wall instead of sliding to its centre line — no more parking in the middle of a wall.
- **You can fight back against antlions now — punch them.** A solid swing knocks an antlion back into the sand and it burrows away, so a well-timed lunge clears a path through the swarm (and a wide swing can scatter a whole cluster at once). Antlion rounds were brutal on sand-heavy maps where there was nowhere to run; now the swarm has a real answer.
- **Antlion rounds eased up.** Their shove hits softer (so a bump is far less likely to launch you straight into the lava), fewer of them turn up at once, they jab a little slower, and you get a longer grace period on the sand before one erupts. The mode should be survivable on maps where the route forces you across the dunes.

### Quality of Life

- **Gentler idle handling inside Discord Activities.** In a Discord voice-channel Activity you're no longer kicked for a short idle — you sit out the current round and drop back in the moment you move. Only after a long stretch away (about 15 min in the lobby, 20 in a match) does it pause you with a one-tap "rejoin" screen, so an abandoned window stops tying up a game while your voice chat stays connected the whole time.
- **Connection indicator.** A small ping/latency badge now sits in the bottom-left corner so you can see your connection at a glance — green when it's healthy, amber/red as it climbs. If your connection ever drops onto the slow fallback mode (the cause of "only I was lagging" hitches), it turns into a red "Slow link — tap to fix" chip that reconnects you on the better path; out of a race it also tries to recover on its own.

### Bug Fixes

- **Barrier ends don't snag you anymore.** Grazing the tip of a wall — especially where two wall ends meet — used to wedge your kart in the notch. The rounded ends now behave like smooth caps, so you slide cleanly around them instead of getting stuck.
- **Vortex wells: the calm eye is truly calm, and water sets you free.** The drawn centre of a well now has zero pull, so you can actually rest and wind up speed in the eye before powering out. And a well over deep water no longer traps you — its pull can't grip a swimming kart, so you swim straight through.

## v0.49.1 — 2026-06-20

### Gameplay & Balance

- **Checkpoint flags no longer drag rounds out.** When everyone still in the race is just respawning on checkpoint (Second Wind) flags and nobody's pushing for the goal, the round now triggers its hurry-up collapse instead of stalling — the closing lava burns the flags and forces a finish. A racer who's leaned on a respawn counts like a downed racer for the "last one standing" timer; touching a flag while still actually racing for the goal doesn't, so you keep your shot at the win.

## v0.49.0 — 2026-06-16

### Map editor

- [headline:New Hazards & Boons] **A huge map-editor content drop** — two new hazards and eight new boons to build with: ability-stealing drones, shooting turrets, ziplines, warp pads, launch pads and more.
- **New hazard: Magpie Drone.** A thieving drone that patrols a rail and **snatches the ability you're holding** the moment it touches you — then flies off carrying your loot in plain sight (you'll see the stolen ability bobbing above it). Get it back by **punching the drone**: a solid hit makes it drop the ability onto the ground as a pad anyone can grab — so a stolen Bomb or Star can change hands mid-race. A re-grabbed ability arms after a brief beat, so mashing punch to free it won't fire it off by accident the instant you scoop it back up. Catch it while you're **empty-handed** and there's nothing to steal, so it just zaps a chunk of your stamina instead. A drone that's already carrying loot is harmless until someone frees it, so the steal → punch → grab-it-back scramble is the whole game. It rides its rail like a Moving Bumper, so you can time your dash through the gap — but if you're holding something good, give it a wide berth. Authors place it from the hazards palette and **draw its patrol rail by dragging the rail-end handle** — aim it and set how far it ranges in one motion, from a short hover to a long sweeping patrol. Rival AI racers carrying an ability now keep their distance from a hungry drone.

## v0.48.0 — 2026-06-16

### Map editor

- **New placeable: Zipline.** A two-post cable — a boon. Drive onto the start post and you're **carried along the line**, sailing over everything beneath you: lava, hazards, water and rivals all pass harmlessly under you while you ride (you hang from the cable on a little trolley), and you can't be punched off. It's a **slow, deliberate glide** — slower than driving — so it's not a fast-travel shortcut; it's a *safe* one, trading speed for a lava-proof crossing. Punch to **drop off early** — and however you leave the cable (early, at the far post, or if you run out of juice) you keep the line's speed and fling forward off the end. The catch: **holding the cable drains your punch meter**, and if it empties you're dropped right there — so a long zipline is a real gamble over whatever's below. Authors place it from the **boons** palette with **two clicks** (the start post, then the far post), which sets the cable's direction *and* length. Rival AI racers understand the cable and route **through** it when it's genuinely the best way across (e.g. a lava chasm they can't drive), but skip it on open ground where driving is faster.
- **Map balance check now catches zipline traps.** A zipline auto-grabs anyone who drives onto its start post, so one placed on the natural racing line over open ground is a *trap* — a racer driving the line gets snatched onto a slow ride and loses time. The fairness/balance score now measures that setback and docks the map for it (a catastrophic one fails outright), showing the author a `ziptrap` line and dropping the map from Featured until it's moved off the racing line — while a cable that genuinely spans a gap (a lava crossing) is left alone. Ziplines must also start **and** land on solid ground (the cable itself can fly over lava/water/holes, but boarding on or landing in them is rejected).
- **New placeable: Lily Pads.** Drivable stepping-stones over deep water — a boon. A pad is **solid to drive across** (you skim over the water instead of having to punch-swim), so a cluster of them makes a path across water that would otherwise slow you to a crawl, and standing on one **recharges your punch meter faster** — a quick breather to win back the strokes the swim cost. But a pad **sinks while you stand on it** — linger and it slips under, dumping you into the swim below — so you have to keep moving from pad to pad. Step off and it bobs back up, ready again. Authors place them from the **boons** palette (over water only — enforced) and can **resize each pad** with its handle — big stable stones or tight skip-stones — to shape a route across the deep. Rival AI racers understand a pad path too: they'll **skim across a line of pads** instead of taking the slow swim around, when it's the faster way to the goal.

## v0.47.0 — 2026-06-16

### Map editor

- **New placeable: Warp Pads.** Paired teleporters — a boon. Drive onto one pad and you're whisked to its linked partner across the map, **keeping all your speed and heading**, so a well-placed pair is a real shortcut; the linked pads glow in a matching colour so you can tell which goes where. It's not instant — you commit on contact and ride a brief warp: the camera **pulls back and sweeps across to the exit**, then you emerge there (invulnerable while you travel, so you can't be knocked out of the portal). The trip is longer for a longer hop, so a cross-map jump really feels like a journey. The catch: the exit throws you out facing whatever way you came in, and an author can aim a partner's mouth right at lava — so punch a rival onto a pad whose far end opens over the fire and let the portal finish the job. Stepping in plays a rising "vwoop" and popping out a bright chime, and the combat feed logs who warped. You won't bounce straight back — a pad won't grab you again until you've rolled off it. Authors place them as a **pair** (click pad A, then pad B) from the **boons** palette, on solid ground (not over lava, a hole, or a locked door); the editor and the next-map preview draw each pair in its in-game colour so the preview is accurate. Rival AI racers understand the link and route THROUGH a pad pair when it genuinely shortens their way to the goal — but the warp's travel time means they'll skip a pair that barely helps.
- **Map balance check now catches bad teleports.** A Warp Pad whose far mouth sits right on the natural racing line is a *trap* — a racer driving the line straight hits it and gets flung all the way back toward the start, even though the map's "best" time looks fine. The fairness/balance score now measures that setback (using the real warp travel times) and docks the map hard for it (a catastrophic one fails outright), so the editor's balance overlay shows a `warptrap` deduction and the map drops out of Featured until you move the exit mouth off the racing line (a side pocket is safe). Place teleports as genuine shortcuts, not line-of-fire traps.

## v0.46.2 — 2026-06-16

### Bug fixes

- **Phone layout fixes.** On phones the map list and the map editor no longer run off the side of the screen — the map browser fits the screen instead of scrolling sideways with its header clipped, and the editor's action buttons (Preview, Copy, Upload…) all stay on-screen and reachable. Editing in **landscape** now shows a much bigger map: the toolbar packs into a single row instead of stacking, freeing the space for the canvas. The in-game **settings menu** also lays its options out in two columns in landscape so they all fit on screen instead of clipping off the top and bottom. And the lobby's **mode/sign-in banner** now stays a readable size on phones instead of shrinking to tiny text. The in-game settings gear has also moved out from under that banner (it now tucks beside the fullscreen button), so they no longer overlap in landscape.

## v0.46.1 — 2026-06-16

### General

- **New chill track.** Added a dreamy synth tune to the calm music rotation, so the laid-back maps have a fresh backing track in the mix.

## v0.46.0 — 2026-06-16

### Map editor

- **Three new Boons: Launch Pad, Barrel Cannon & Slingshot Rings.** A trio of helpful placeables that send you flying. Drive over a **Launch Pad** to be flung through the air in the direction it points — while you're airborne nothing can touch you (lava and hazards included), and you land wherever the arc drops you, so authors aim it across gaps and over danger. A **Barrel Cannon** scoops you in DK-style: the barrel **spins on its own** with a **burning fuse**, and you **time your punch** to fire in whatever direction it's pointing — or let the fuse burn all the way down and it launches you automatically. It's a longer, committed flight than the Launch Pad, and in the editor a dashed ring shows how far it throws so authors can place it. **Slingshot Rings** give you a speed burst as you drive *through* them, along the ring's axis; the more **centered** your pass, the bigger the kick, and hitting a **row of rings** in quick succession stacks the boost into a real launch. Authors place all three from the **Boons** palette and rotate them to aim; as with every boon, rival AI racers drive straight through them, and each switches to a watery look when placed on water.

## v0.45.0 — 2026-06-16

### General

- **Sentry Turrets can now be punched out.** That fixed gun emplacement isn't invincible anymore — land a solid punch on it and it's smashed offline for the rest of the round (a grey debris burst and a metallic crunch, leaving a cracked, dead wreck). The charge-up is your opening: rush it while it's locking on, or pick it off from outside its firing arc where it can't shoot back. Rival AI stops avoiding a turret once it's been knocked out.

## v0.44.0 — 2026-06-16

### General

- **Bots can now solve locked-door maps.** AI racers understand keys and doors: when a locked door is sealing off the only way to the finish, a bot will break off, fetch the matching key, carry it to the door and unlock it for everyone — then get back to racing. The rest wait at the door ready to pour through the moment it opens, so locked-door maps work in bot-heavy rooms instead of stalling at the barrier. Bots also treat a door as an optional **shortcut**: if the goal is reachable the long way but opening a door would be meaningfully shorter, some bots will peel off to grab the key and cut through while others race the open route — including snapping up a key another racer dropped if it's a worthwhile detour.

## v0.43.0 — 2026-06-15

### Map editor

- **New hazard: the Sentry Turret.** The first hazard that *shoots back*. A fixed gun emplacement tracks the nearest racer inside its firing arc, charges up with a warning glow, then fires a glowing bolt at them with its own zap-and-thunk sound. The bolt doesn't freeze or kill you — it bursts on impact and **knocks you off your line** — but a shove into lava or off a ledge does the rest, so it's brutal guarding a narrow pass. The charge-up is your tell: break out of the barrel's line while it's locking on and the shot fizzles, so juke across the arc rather than crawl through it. **Duck behind a wall or fence and you're safe** — a barrier blocks the turret's line of sight (it won't even fire at you) and stops any bolt already in the air. In an **Antlion** round the turret also targets the antlions — a hit knocks them back, so a well-placed turret helps fend off the swarm. Authors place it from the hazards palette and aim its mount facing (the centre of its firing cone, shown right in the editor); rival AI racers keep out of the line of fire. Lightning rounds leave it alone (it's a stationary, timed hazard).
- **Editor: placed objects are selected right away.** Drop a hazard or boon and it's immediately selected in the cursor tool — grab, rotate, resize, or delete it on the spot without first clicking Select. Place the next one by picking it from the palette again.

## v0.42.0 — 2026-06-15

### Map editor

- **Two new Boons: Guard Halo & Second Wind Flag.** Two helpful placeables that change how a fight or a fall plays out. Drive through a **Guard Halo** to pick up a **one-hit shield** — the next hit that would knock you around (a punch, a bumper, a bomb, an ice shot, a slice) is absorbed and the shield pops, leaving you put. You can only hold one at a time, and each halo recharges for a few seconds after someone grabs it (a filling ring shows when it's ready again), so racing a rival to it matters. A **Second Wind Flag** is a respawn checkpoint: drive over it to plant your claim (the flag flutters and turns your colour), and from then on **every time you'd die you respawn back at your flag** instead of being knocked out — over and over, for the whole round. When you go down there's a brief beat where the camera sweeps from where you fell to your flag, then you pop back in. The flag keeps saving you until the closing lava finally swallows it — once it burns, you're on your own. (It won't save you from being turned into a zombie either.) Drive over a different flag to move your checkpoint. Authors place both from the **Boons** palette, and as with every boon, rival AI racers drive straight through them. Place either on **water** and it switches to a watery look so it still reads against the blue.

## v0.41.1 — 2026-06-14

### General

- **Locked doors and keys.** Some maps now have a locked door sealing off the way through — a dark barrier stamped with a shape (a circle, triangle, diamond…). Somewhere on the map sits a matching shaped key. Grab the key and you carry it like an ability (it orbits your kart, and you can still punch and use abilities normally); the camera pulls back so everyone sees which door it opens. Carry it into that door and it swings open for *all* players, with a zoom-out and a little unlock flourish. Get knocked out or infected while holding a key and you drop it on the ground for someone else to grab — and if the collapse lava reaches a dropped key, it's gone for the round, so the door stays shut. Every grab, drop, and unlock shows up in the combat log. Which key opens which door (and the shapes) is shuffled every round.

### Map editor

- **Place a locked door + key.** New "Door" tool in the editor: click to drop a door, then click again to place its key — doors and keys are always paired one-to-one. Right-click a door or key to remove the pair. The shapes and pairing are assigned in-game each round, so you just decide where they go.

## v0.41.0 — 2026-06-14

### Map editor

- **Two new placeables: Laser Gate & Crusher.** The Hazards palette gets two timing puzzles. A **Laser Gate** is a laser barrier strung between two pylons that blinks on a steady rhythm — it sits open, shimmers a warning, then snaps solid and blocks the lane, then opens again. While it's solid you bounce right off it (it won't kill you — but park one over lava and the shove sends a message), so read the beat and slip through on the off-beat. A **Crusher** is a heavy steel slab that slides back and forth across a corridor on a rail like a Thwomp: get clipped mid-swing and it shoves you aside, but get caught as it slams home against the wall and it crushes you flat. Authors place and rotate both from the editor; rival AI racers time the gaps and cross when the coast is clear.

## v0.40.2 — 2026-06-14

### General

- **Double-tap punch to lunge — now on dry land, not just water.** Tap punch twice quickly while holding a direction and your kart hops forward, the land version of the swim stroke you use to cross water. It's a quick repositioning move to dodge a hazard, scoot off sand, or duck a burn — *not* a way to go faster: the hop is short, it empties your whole stamina bar, and you're left slow and winded for a moment afterward, so a racer who didn't lunge will pull ahead. Like the swim stroke it's still a punch, so it shoves anyone you barge into. Speed-streaks and a whoosh sell the burst.
- **Bots now lunge to save themselves.** The racing bots use the new lunge to dodge a closing zombie, antlion, or hockey puck — a quick shove clear when contact is about to land.

## v0.40.1 — 2026-06-14

### Map editor

- **Maps can have fences and walls now.** The editor has a new two-point Barriers tool: pick **Fence** (a top-down wooden plank fence with posts) or **Barrier** (a concrete highway barrier with hazard stripes), click a start point, then click an end point to drop a solid line across the map. With the Select tool you can click a placed barrier to grab and drag either end, and delete it with the ✕ handle, the Delete key, or a right-click. Press Escape mid-placement to cancel.

### General

- **You can't drive through fences and walls.** The new map barriers are solid — run into one and you'll slide along it instead of passing through, exactly like the stone seam between water and lava. They don't hurt you; they just block the way, so maps can now have corridors, pens, and chicanes. AI racers know about them too: they route around barriers toward the open ends instead of grinding into them.

## v0.40.0 — 2026-06-14

### Map editor

- **Two new Boons: Recharge Spring & Slipstream.** The helpful-placeable family grows. Drive over a **Recharge Spring** and your punch bar instantly refills and your punch comes off cooldown — a pit stop that makes you immediately battle-ready. The spring is a shared charge: once a racer drinks from it, it visibly drains and refills over a few seconds (a filling ring shows when it's ready again), so timing and racing a rival to it matter. A **Slipstream** is a wind-current corridor that steadily carries you along the way it points — get shoved or driven backwards through it and the current fights you and pushes you forward again. Authors place both from the **Boons** palette (rotate the Slipstream to aim it; chain a few to build a long tunnel). Place either one on **water** and it switches to a watery look — the spring bubbles up as a foam-white well, and the Slipstream becomes a flowing river current — so it reads against the blue. As with all boons, rival AI racers drive straight through them.

## v0.39.0 — 2026-06-14

### Map editor

- **New placeable: Vortex Well.** A whole new flavour of hazard — a force field that pulls your kart around instead of bonking it. It drags everything inside its ring toward the centre: carry speed and you slingshot past, but crawl in and you're drawn down into the swirl. The very middle is calm, so if you get caught you can build up speed in the centre and power back out through the ring — annoying and slow, never a dead end (unless someone parked it over lava). It even tugs on antlions during an Antlion round — the whirlpool drags the burrowers off their hunt, though they keep clawing toward you. Authors place it from the editor's Hazards palette and drag a handle to size it from a small eddy up to a wide whirlpool; rival AI racers steer around the core.

## v0.38.2 — 2026-06-14

### Bug fixes

- **In team modes you can tell who's holding an ability again.** The dashed "ability armed" ring now always sits in a clear gap *outside* a kart's Crimson/Jade team glow instead of merging into it — on bigger or cosmetic-skinned karts the two rings used to overlap into one band, hiding whether a teammate or rival was loaded.

## v0.38.1 — 2026-06-14

### Brutal rounds

- **Antlions can't cross water now.** In an Antlions round, water is a hard wall to the swarm — they prowl the shoreline instead of walking across it, just like zombies can't. Put a pool, river, or moat between you and the antlions and you've shaken them; an island in the water is a safe haven.

## v0.38.0 — 2026-06-14

### General

- **Water doesn't flash to lava when the world collapses anymore — it slow-boils.** When the closing lava front reaches a patch of water it now spends about three seconds heating up — a tiered simmer → boil → rolling-boil warning with bubbles and rising steam — before it finally turns to lava. That's a few extra seconds to scramble across (or off) the water while it's still safe.
- **A killstreak fire shield now lets you walk on water.** Carry a flame into water and instead of getting doused on the spot, your shield lets you *stride straight across* — no swimming, with steam hissing off you the whole way. The flame burns down while you cross (just like it does on lava), so a big pond can still snuff it mid-crossing and drop you into the swim. Fire is now a real shortcut across water.
- **Flames burn out instead of blinking off.** A fire shield running out — on lava or boiling away on water — now fades out with a last steam puff rather than vanishing in a single frame, and burning karts kick up matching effects underfoot: embers on lava, steam on water.

## v0.37.0 — 2026-06-14

### General

- **There's a combat log now.** A small feed in the top-right corner flashes the moments as they happen — who knocked out whom, who melted into the lava, who grabbed an Ice Cannon, who snagged a bonus orb, and who's crossing the finish line — each with the racer's kart and name. In team modes the names and kart rings show their team colors, and finishes (and orbs) show the points they banked. Rows fade after a few seconds, and the ones you're in stand out.

## v0.36.0 — 2026-06-13

### Map editor

- **New placeable: Dash Arrows.** The first of a new family of *Boons* — helpful objects that aid racers, the flip side of hazards. Drive over a Dash Arrows pad and it gives you a quick burst of speed in the direction it points; hit it backwards and it fights you, so aim matters. Authors place and rotate them from the new **Boons** palette section in the editor. Rival AI racers treat boons as free help — they drive straight through instead of dodging.

## v0.35.5 — 2026-06-13

### Brutal rounds

- **New brutal round: Antlions!** Sand is no longer just slow — linger on it for a couple of seconds and an antlion erupts from a nearby dune and comes after you (and staying put just keeps summoning more). Antlions can chase you anywhere, but they're a touch slower than your kart on good ground and they burrow back home a second or two after you lead them off the sand. They don't kill on contact — they shove, and a shove at the wrong moment is what puts you in the lava. Industrial thumpers pound the ground on a steady beat at a few spots in the sand: antlions can't stand the pounding, so inside a thumper's ring is sanctuary — every slam hurls them back out, while your kart rolls through untouched. Maps with barely any sand never roll the round, and it won't stack with Heatwave (the heat would cook the habitat).

## v0.35.4 — 2026-06-13

### General

- **New hazard: the Rotor.** A bumper mounted on a spinning arm that sweeps a full circle around its pivot like a clock hand — touch the head and you're flung off just like a regular bumper, but the safe gap comes around and around, so you have to time your dash through its ring. Map authors can place and aim them in the editor (Hazards palette). Rival AI racers dart across the ring between passes rather than treating it as a wall.
- **New hazard: the Geyser.** A vent that sits quiet, bubbles up a warning, then erupts and launches anyone standing on or near it — harmless between bursts, so the telegraph is your cue to step off (and a chance to time a rival onto it). Map authors place them from the editor's Hazards palette.
- **New hazard: the Proximity Mine.** Sits armed and quiet until a kart strays too close, then blinks down a fuse — just long enough to scramble clear if you're quick — before blowing up and flinging everyone still nearby, so the leader who trips it can catch the chasing pack in the blast. One use each. Map authors place them from the editor's Hazards palette.

## v0.35.3 — 2026-06-13

### Team modes

- **Bonus orbs are now scattered on the map in team modes.** Every round in a team mode drops one or two glowing golden orbs out on the course (more on bigger maps). The first racer from either team to drive over one banks **+1 point for their team** — a quick side objective to fight over while you race. Orbs favor the quieter corners off the direct line to the goal, so grabbing one means leaving the racing pack to detour for it. Each orb is a one-time grab: once it's collected it's gone until the next round, and the round summary now tallies how many bonus orbs each team snagged.

## v0.35.2 — 2026-06-13

### General

- **Karts now build up to speed.** Instead of hitting full pace the instant you press a direction, your kart starts a little slower and winds up to its top speed over a couple of seconds of holding a steady line. Cut a hard turn or stomp the brakes and you dump that momentum and have to wind back up — so committing to a clean racing line is now faster than constantly jinking around. Top speed itself is unchanged; you just have to earn it.

## v0.35.1 — 2026-06-13

### General

- **New hazard: the Bumper Wall.** A pinball-style slingshot line that flings your kart straight off its face the instant you touch it — same springy sting as a round bumper, stretched into a whole wall. Map authors can place and rotate them in the editor (look in the Hazards palette) to fence off shortcuts or bank karts around corners. Rival AI racers steer wide of them rather than ride them.

### Bug fixes

- Join a room mid-round and the moving bumpers' rails now draw where they actually are — they used to show the rail starting from wherever the bumper happened to be at the moment you joined, instead of its true track.
- Two map hazards placed so their coordinates added up to the same total used to silently cancel one of them out at round start — every authored hazard now spawns.

## v0.35.0 — 2026-06-12

### General

- **Matches now warm up before they bite.** The first couple of rounds favor friendlier, more open maps so everyone gets racing — the real gauntlets (the maps where karts barely make it off the start line) are kept out of rounds 1–2 whenever the playlist has anything gentler to offer. Mid-match the map draw is the same shuffle as before, but once anyone reaches match point the rotation turns up the heat and deciding rounds skew toward the catalog's hardest maps. Works in every playlist — one with no easy maps just shuffles like it always did.

## v0.34.1 — 2026-06-12

### General

- **The lobby got a full redesign.** You now spawn on a grass plaza with all four stations arced around the spawn pad — Skins and Bots front and center by the road, Playlist and Game Mode on the plaza's edges — and a grass road leads straight to the start spinner on its own clean clearing, ringed by a few slippery ice patches in the surrounding dirt. The practice terrain moved out to the edges where it can't ambush you: an ability alley up north (bomb, speed, slow, cut pads), an ice rink in the north-east corner with a lava pocket melted into its edge, a bumper court and splash pool to the east — the pool's far shore runs into the lava springs and its sand beach, so you can see how water, lava, and sand collide (and walk the stone seam that forms where water meets lava) — and a sand drag strip down south. The sand hides treats too: Speed-Up and Ice Cannon pads in the drag strip, and Star Power pads on the lava springs' shore for the brave.

## v0.34.0 — 2026-06-11

### General

- [headline] **Team modes are here — Crimson vs Jade!** Pick **Team Race** or **Brutal Teams**: finishes and knockouts bank team points, deaths cost one, and the first finish past the target wins.
- Team scoring in full: first across the line banks **+5** for your side, second **+3**, every other finisher **+1**, and knocking an enemy out earns **+2** — but **every death costs your team a point**. Points float over the kart that earned (or lost) them. Once your team holds the target score, the next FIRST-PLACE finish by anyone on it wins the match on the spot — and deaths can knock your team back under the line, so match point is something you defend. If the rounds run out first, the leading team takes it. Your kart keeps its own colors and cosmetics; your team shows as a Crimson or Jade glow under your wheels, with the team score front and center all race.
- Teams stay fixed for the whole match — nobody gets shuffled mid-game. New players joining a team match are placed on the smaller team, and with bots set to Auto the grid fills to an even split.
- **No friendly fire from punches**: a teammate's punch simply does nothing, so you can brawl shoulder-to-shoulder without launching your own side into the lava. Abilities are still everyone's problem — a bomb doesn't care what team you're on (but you earn nothing for roasting a teammate with one, and their death still costs your team a point — careful with those). During an infection round, zombies bite whoever they like — even old teammates.
- In a **Brutal Teams** bunker round, the vault door opens once only one team is left standing — then the whole surviving squad races for the goal together.
- AI racers understand teams: bots never waste punches or abilities on their own side, and they'll aim their bombs, swaps, and blindfolds at the enemy team.
- The lobby's room settings now read as **one tidy status card** — Mode, Bots, and Playlist side by side in a single panel (with the limited-time claim banner riding on top when one is live) — instead of a stack of separately-floating pills.

## v0.33.0 — 2026-06-11

### General

- New **Game Mode station** in the lobby (the ⚔️ purple ring, top-right): drive in to pick what kind of game your room plays. The pick is room-wide, shows on a banner at the top of the lobby for everyone, and locks in when the race starts.
- New game mode — **Brutal FFA**: every single round is a brutal round. No mercy rolls, no warm-up — the chaos starts at round 1 and never lets up (brutal rounds can still stack extra modes on top, just like before). A warning banner at the round-1 gate reminds everyone what they signed up for. Standard FFA stays the default — and the mode your room picked sticks around for the next match, too.
- The **join page now shows each room's game mode** on its card (brutal modes get a red badge), so you know what kind of game you're walking into before you click Join.

### Bug fixes

- Firing the **Ice Cannon** (or tossing a bomb) while facing an in-between angle — easy to do steering with the mouse — no longer launches a broken projectile that could **crash the whole room**. The shot now flies exactly where you're facing.

## v0.32.3 — 2026-06-11

### Bug fixes

- AI racers can finally get past **moving bumpers**. They used to treat the bumper's whole sweep as a wall — lining up in front of it and shuffling back and forth forever without ever crossing. Now they time it like a player: hold just outside the strike zone, drift toward the end of the bumper's run where the gap stays open longest, and dart through behind it as it sweeps away. On slow ground, where no perfectly safe window exists, they'll chance a crossing right behind the bumper rather than freeze.

## v0.32.2 — 2026-06-11

### General

- The in-game Codex now covers the **Bunker** brutal round and the **Water** tile — both had shipped without their reference cards, so the Learn page finally explains the buried goal, the closing lava ring, and how punch-swimming works.

## v0.32.1 — 2026-06-11

### Brutal rounds

- New brutal round — **Heatwave**: as the camera pulls out before the race, a heatwave rolls across the arena and you watch it transform — patches of sand bake into lava, ice melts into open water, grass dries out to dirt, and some dirt cracks open around bonus ability pickups (with good odds of an Ice Cannon — the heat scatters its own antidote). Every changed tile keeps a **scorched rim** so you can always tell what's new, and there's always still a path to the goal.
- Heatwave strikes twice: partway through the race a **second, smaller wave** hits — a "Heatwave incoming!" warning flashes on screen with an alarm, and the doomed tiles flicker with what they're about to become, so get clear before they flip.
- Heatwave rounds feel hot: a warm haze settles over the arena, embers rise off freshly scorched ground, the burn rolls in with a searing sizzle, and a low heat-shimmer drone hums under the music until the round ends.
- New medal — **Firewalker** 👣: finish Heatwave rounds without ever touching a scorched tile. The arena changed; you refused to acknowledge it.
- Heatwave joins the normal brutal rotation and can stack with other twists (it skips maps without enough sand or ice to scorch, so it always lands with real drama).

## v0.32.0 — 2026-06-10

### Map editor

- The **Featured** bar is a touch friendlier: maps now make the Featured playlist at a balance score of **85+** (was 90+), so a few more well-built tracks earn the badge.
- The map editor's fairness check now works fully on a controller: when a pad is connected, the "press Esc to hide" prompt shows the right face button (**B** / **○**) and you can dismiss the balance overlay with it.
- Maps built with **water** are now scored and sorted correctly — water counts toward a map's character and balance check instead of being treated as blank ground, so a water-heavy map gets the credit (and the right playlist) it deserves.
- Map names now follow one consistent style (Title Case With Spaces) across the whole library — so names read cleanly everywhere instead of a mix of `swim_fish_swim`, `RaceCondition`, and `4suns!`. New submissions are tidied up automatically.

## v0.31.4 — 2026-06-10

### General

- Controllers now rumble. Feel the hits you land and take, the heavy shake of a volcano or a collapsing arena, the green-light launch at race start, the splash and paddle of swimming, the steam hiss when water snuffs your flame, the rising countdown and ground-shaking blast of an Orbital Beam strike, and a jolt when you fall to lava, turn zombie, or cross the finish. New "Rumble" toggle in the settings menu (on by default) if you'd rather race quiet.

## v0.31.3 — 2026-06-10

### Ability changes

- [headline] New ability — **Orbital Beam**: call down a telegraphed strike from orbit that melts ice to water, scorches sand into lava, and torches any kart caught in its line.
- Aim the Orbital Beam like a bomb and fire it: the strike locks onto that line "from orbit" and a clearly-marked beam glows and pulses faster and redder for a 5-second countdown so everyone can see exactly where it's about to hit. Invulnerable karts, Star Power holders, and zombies shrug off the burn — but **watch your own footing: it'll torch you too if you linger in your own beam**, so fire it and clear out. Carve a new hazard across the track, cut off a chokepoint, or zap a rival caught in the open — a quick racer has five seconds to escape the line.
- Where the Orbital Beam drops fresh water right beside the lava it just made, that new edge hardens into the same impassable **stone seam** as natural water-and-lava borders, so you bump along it instead of being shoved across into the lava.
- AI racers now **read telegraphs and scramble clear** — they steer out of an Orbital Beam's marked strike line before it fires, and out of a charging lava-explosion blast, instead of sitting in ground that's about to turn deadly.

### Bug fixes

- An ability grabbed in the lobby but not used no longer **lingers on your HUD** once the race starts. The server already dropped it at the gate (lobby pickups don't carry into the race), but the icon used to stick around looking usable; now it clears with the rest of the lobby.

## v0.31.2 — 2026-06-10

### General

- The AI racers can **swim** now. Bots punch-to-swim across deep water just like you do, so they'll stroke their way over a water crossing instead of getting stuck at the shoreline — and they'll cut through a stretch of water when it's genuinely the faster line, while still taking the dry route when one's clearly quicker. (Water is slow going for everyone, bots included, so they won't dive in unless it pays off.)

## v0.31.1 — 2026-06-09

### Brutal rounds

- New **Bunker** brutal round — a last-one-standing battle royale. The goal sinks underground behind a silo door at the start, so there's nothing to race for: a wall of lava closes in from the edges, herding everyone together until only one racer is left alive. The moment you're the sole survivor the goal erupts back up for you to claim the win. Zombies don't count as "alive," so an infection can't keep the goal buried. Works on every map.

## v0.31.0 — 2026-06-09

### General

- New terrain: **Water**. You barely drift in deep water on your own — to actually move, **punch to swim**: each stroke shoves you in the direction you're holding, so good swimmers can cut a watery shortcut across a map in a pinch. Swimming is a real punch, so it still knocks rivals around (and spends stamina), and the water drags on the hit. Climb out and you're briefly **dripping wet** and sluggish until you shake it off. Bonus: water **puts out your flame** — drive in while you're burning from a killstreak and the fire hisses out.
- Where water meets lava, the water's edge hardens into **stone you can't cross** — you bump along it like the edge of a hole, so a swimmer can't be shoved into the lava across that seam. Water is otherwise fully open to swim through.
- In **infection** rounds, zombies can't swim — water is a wall to them, bouncing them off the edge like a hole. So diving into water is a genuine escape from the horde (you swim, they can't follow).

### Map editor

- New **Water** tile in the paint palette, so you can build swimming shortcuts and water-and-lava gauntlets of your own.

## v0.30.3 — 2026-06-08

### General

- New "Default" map playlist — now the lobby default. It plays mostly Featured maps but rolls a wildcard each round, so about 1 in 5 races pulls in a community map for variety. The plain "Featured" playlist (Featured only) is still there if you want the curated mix with no surprises.

- AI racers (and the editor's balance-check routes) no longer try to thread pin-point gaps between cells that a kart physically can't fit through — those count as walls now, and tight-but-passable squeezes are only taken when no wider lane exists. Maps whose only entrance really is a pin-point now correctly read as having an unreachable goal.

### Map editor

- When the balance check says your map won't make Featured, the editor now draws the evidence right on the map: the race route from each start gate with its time (green = the faster side, red = the slower one — that gap is the fairness penalty), a marker showing how far off-centre your goal sits, and a legend translating every deduction into a concrete fix. Routes are drawn as real racing lines — straight across open ground, bending only for lava, holes, and bumpers (which they dodge the same way the AI racers do). The overlay stays up while you paint corrections; press Esc to hide it.
- Fixed: clicking the buttons on the "Submit anyway?" dialog (or any editor confirm dialog) no longer paints the map underneath — your brush is fully inert while a dialog is open.
- New "Start:" picker next to the AI toggle on two-gate maps: choose which start gate YOU spawn at when previewing (Auto keeps the old balanced placement), so you can test each side on demand instead of hoping the coin flip lands your way. Bots still fill both gates.
- Turning on "AI racers" for a preview now fields a proper grid of 6 bots to race against, instead of the lone bot the lobby's auto-scaling used to give a solo tester.
- New "Fairness" button: run the balance check any time while editing — no upload needed, no name/author required. It now fans out several routes from different start points along each gate (not just one), with each gate's time and spread shown, so you can see at a glance how even the start is. Same legend of fixes the submit check shows, and a ★ toast when your map would make Featured.
- The balance check is friendlier to real maps where the routes are just estimates: the race-length penalty now weighs less, since estimated racing lines can't account for ability pickups or skilled ice/grass play. Most maps keep their tier; the change only stops near-miss maps from being sunk by route-estimate noise.
- Spawn fairness now looks at every start point on every gate (not just one per side): the ideal is that they all reach the goal within about a fifth of a second of each other, and a broadly uneven start — whether between two gates or across one wide gate — costs a bit toward the Featured bar. The routes and their spread are drawn right on the overlay so you can see exactly where the unfairness is.

## v0.30.2 — 2026-06-08

### General

- You can now DRIFT on ice: hold your punch charge while sliding and your kart digs in — you slow down a touch and get real steering control back. Your charge ring frosts over icy blue, frost spray kicks up behind you, your kart visibly leans into the carve, and you hear the skid hiss (nearby rivals' drifts too), so a drift never reads as a wind-up punch.
- New end-of-match medal: **Smooth Operator** — awarded for drifting the furthest on ice. Only clean drifts count: if your charged punch lands on (or clashes with) someone it was a wind-up, not a drift, and burning up in lava wipes the run you were on.
- New achievement trail: earn the Smooth Operator medal 20 times to unlock **Powder**, a kicked-up frost spray trail — and while it's equipped, your drift lean gets noticeably more dramatic.
- Releasing a punch on ice now scrubs a little less of your speed than on solid ground (15% more glide kept), so coming out of a drift doesn't slam you to a halt.
- AI racers have learned to drift: when a bot starts skating off its line on ice it now digs in with a held charge to regain control, releasing as soon as it's back on course — you'll see their charge rings frost over too.

## v0.30.1 — 2026-06-05

### General

- Three new soundtracks join the music rotation: two high-energy chiptune tracks during races, and one chill chiptune track for calmer moments (Bogart VGM's "8Bit Action" series).
- Music mood changes are much smoother: the hype track now carries the leader all the way over the finish line and the new mood washes in on the round-results screen (instead of the music abruptly switching mid-race the moment someone gained or lost match point), with the old track fading gently underneath.

## v0.30.0 — 2026-06-05

### Ability changes

- New ability: Star Power! Grab the star tile and pop it to go full invincible for a few seconds — you glow in cycling rainbow colours, leave a trail of rainbow stars, your own theme music plays while it lasts, and the camera eases out wide until the star fades. Punches and pucks bounce off you, bombs and cuts can't fling you, slowdowns and swaps pass you by, a blindfold can't blind you — and even lava can't burn you, so you can shortcut straight across it. You can still punch everyone else, so plow through the pack. Watch the blink: when the glow starts flashing the star is about to wear off, and lava stops being a road the instant it does.

## v0.29.3 — 2026-06-05

### General

- Shaped cart skins (Drone, Dino, Hoverbike, Starfighter, and friends) now ride 20% larger, so they read clearly bigger than the base sphere cart — looks only, hitboxes are exactly the same.
- The in-game HUD got a face-lift: every round now opens with a proper map announcement card (map name + author — taking its turn politely after any Brutal Round reveal), the race timer sits in its own dark pill so it's readable over any terrain, the map name & author keep a subtle credit in the corner, brutal-round badges have rounded tiles, and the "Waiting for more players" notice is a centered banner with an animated ellipsis. The lobby's info banners (seasonal claim, AI bots, playlist) stack neatly at the top of the screen, and the game ID / player count / round readout is a clean, frameless strip up top that fades out of your way once the race is on.

## v0.29.2 — 2026-06-05

### Bug fixes
- "Start a new game" on the join screen now always opens a fresh game, instead of quietly dropping you into someone else's room that had space.

## v0.29.1 — 2026-06-05

### General
- The dynamic camera now rides a little closer to your kart (your skin is easier to admire), looks further ahead in the direction you're driving, and punches in for an intense close-up as you and the goal converge at the finish line — without ever letting a local player slip off screen.
- Round intros got cinematic: the countdown camera now opens tight on your kart at its spawn, pans out to reveal the whole arena, then dives back in right as the gate opens.

## v0.29.0 — 2026-06-04

### General

- Leveling up is way faster now — and unlocking something new feels like it! XP needed per level has been massively reduced (no level ever costs more than ~10 matches' worth, and nobody loses progress — most players will jump several levels and find new cosmetics waiting). Unlocks now land every few matches instead of dozens.
- New celebration screens: earning XP fills an animated level bar, leveling up gets a proper fanfare, and unlocking a cosmetic shows the actual item spinning in your color with confetti and a crowd cheer — plus a peek at the next skin you're closing in on.

## v0.28.5 — 2026-06-04

### General

- Lobby station menus (Skins, AI Bots, Playlist) are much easier to read: when you're the only one with a menu open it now draws nearly twice as large — bigger skin cells, labels and the Equipped preview. With two menus open they share the screen at a medium size, and the 3-4 player couch grid keeps the familiar compact layout, so everything always fits on screen without overlapping.
- Couch co-op: while another player has a station menu open, every controller seat sees a "P2 Ⓐ Join" button (✕ on PlayStation) pinned right under that menu — one press opens your own copy of the same shop from anywhere in the lobby, no need to hunt for your kart and drive it into the zone.

## v0.28.4 — 2026-06-04

### General

- The game now warns you before the server goes down for an update: a banner counts down the final 30 seconds, new races stop starting while a restart is pending (races already underway get to finish), and you're brought back in automatically once the server is back.

## v0.28.3 — 2026-06-04

### General

- The Skins station has a new 🎲 Random button — one press dresses your kart in a random colour plus a random set of the carts, patterns, borders and trails you've unlocked. Works with touch, mouse, keyboard and controller.
- The Skins station now shows an "Equipped" preview beside the picker: a live in-game render of your kart with its trail flowing behind it, plus a row for each slot (colour, cart, pattern, border, trail) naming exactly what you're wearing.
- Couch co-op: when two or more players open lobby station menus at the same time, the panels now spread out into their own corners of the screen (tagged P1/P2/…) instead of piling up on top of each other.

## v0.28.2 — 2026-06-02

### Bug fixes

- Ads no longer appear before you've played — they only show between matches now, never on the first lobby when you open the game.

## v0.28.1 — 2026-06-02

### General

- Trail effects now trace the path you actually walked: hearts, music notes, smoke, confetti, crystals and bubbles ride along your trail for a beat before floating off and fading, instead of drifting away the instant they appear. They also no longer flicker.

## v0.28.0 — 2026-06-01

### General

- After a match you can watch a short ad to **double the XP you earned that match** — handy when you're close to a level-up. It's a quick optional prompt as you head back to the lobby (it never interrupts the results/recap screen). Signed-in players only; the bonus is credited once per match.

## v0.27.4 — 2026-06-01

### General

- The end-of-game recap now opens each clip on the action already in motion — like a camera catching the moment — instead of starting from a frozen pose.
- New recap highlight: when a punch sends a kart flying a long way (sliding across the ice, say), the recap turns it into its own "Sent Flying!" clip.

### Bug fixes

- The end-of-game recap now replays the action it was missing: punch lunges and their shockwaves, landed-hit sparks, parry clashes, and kart reflections on ice all show up in the highlight clips, matching what you saw live.

## v0.27.3 — 2026-06-01

### General

- Fully charged punches now land harder — a maxed charge hits about 50% stronger than before, so committing to the full wind-up pays off, especially from a standstill.

## v0.27.2 — 2026-06-01

### General

- [headline] Local co-op with controller support — up to 4 players on one screen (controllers plus one on keyboard/mouse), all in the same game as anyone online.

### Bug fixes

- Your equipped skin and cosmetics now stick to your account: sign in and they load straight away — even on a different device, or when you hop into a match that's already running. Picks you made while playing as a guest no longer overwrite the look you'd saved to your account when you sign in.

## v0.27.1 — 2026-06-01

### Bug fixes

- The start of a race opens on the whole-map overview again and smoothly zooms in on your kart during the countdown, instead of snapping straight to a full close-up.

## v0.27.0 — 2026-06-01

### General

- **Early Adopter trail — claim it before August!** Sign in to your account any time this summer to permanently unlock the exclusive **Solar Flare** trail: a molten-gold flare with drifting embers that everyone sees as you race. The claim closes August 1st and it's gone for good after that — sign in once and it's yours forever.

## v0.26.4 — 2026-05-31

### General

- Free play now shows the occasional short ad between matches (at most once every couple of matches). It plays after the end-of-match results screen, as the next match's lobby comes up — so it never covers your medals or holds up play. If the ad fails to load it's simply skipped.

## v0.26.3 — 2026-05-31

### General

- New **Feedback** button on the menu pages — report a bug or pitch an idea right from the site, and it lands straight in the dev's inbox. Works with touch and controller (on-screen keyboard) too.

## v0.26.2 — 2026-05-31

- Idle-kick fix: flipping through a lobby station's menus keeps you active as intended, but simply parking your kart on a station pad and stepping away no longer makes you immune to the idle kick — you have to actually be using the menu.

## v0.26.1 — 2026-05-31

### General

- [headline] Every match now earns you XP — play to level up and unlock cosmetics. Win for a fat XP bonus (and runner-up gets a little something too).
- Mix-and-match cosmetics: your kart now has three separate slots — a **cart** body, a **pattern**, and a **trail** — and you can wear one of each at the same time, all in your chosen colour. Patterns paint over your colour and trails fly in your colour, so a Dino body + Checkered pattern + Sparkle trail in blue all reads as one kart.
- New unlock ladder: a fresh cosmetic every two levels, rotating pattern → trail → cart. To level 30 that's 5 carts (Truck, Drone, Dino, Hoverbike, Starfighter), 5 patterns (Racing Stripes, Polka, Checkered, Flames, Nebula), and 5 trails (Dashes, Sparkle, Comet, Bubbles, Aurora) to chase.
- The lobby skin station is now four groups — Colour, Carts, Patterns, Trails — each cell showing a live preview and a 🔒 with what unlocks it. Equip each slot independently; your picks are remembered between sessions.
- Medal cosmetics: stacking up honours over time unlocks special items in matching slots — Golden Champion and Warlord carts, Executioner and Punching Bag patterns, and Guardian and Survivor trails. The thresholds are a long-haul grind (50–100 of a medal).
- Tons more cart bodies to drive — from a Hoverbike and Starfighter to a whole zoo of novelty karts (8-Ball, Donut, Disco Ball, Compass, Pizza, and dozens more), each tinted to your colour.
- New motion trails with real personality: Ribbon, Lightning, Hearts, Smoke, Confetti, Crystals, Tire Tracks, Music Notes, Neon Wall, and Ripples — all flying in your colour.
- More patterns for your kart, all tinted to your colour: Carbon Fiber, Camo, Hazard, Circuit, Scales, Electric, Tiger, Waves, Honeycomb, and Splatter.
- New **Borders** cosmetic: a decorative rim that rings your kart in your colour and shows over any body — including the shaped carts. Pick from 18 styles, from a clean Ring, Studs, and Chevrons to animated Flames, Electric, Sawblade, and Orbit, up to a regal Laurel, Crown, and Plasma. Borders are their own slot, so you can wear a pattern AND a border at once.

### Bug fixes

- You won't get kicked for being idle while you're browsing a lobby station (skin shop, AI, or map picker) — flipping through the menus now counts as being active.
- End-of-match medals are now human-only — bots no longer take a medal off the card (or the progress it counts toward), so the awards reflect what the players actually did.
- Wins and end-of-match medals now only count toward unlocks in matches with at least two human players — so racing alone (or against only bots) won't auto-grant competitive rewards. You still earn XP, level up, and progress the "play a lot" unlocks solo.

## v0.26.0 — 2026-05-31

### General

- Four new end-of-match medals to chase: Zombie Slayer (most kills while infected), Heavy Hitter (most fully-charged punches), Pinball (most bumper bonks), and Ice Skater (furthest slide across ice).
- The end-of-game medals are now shown on a polished award card — each medal has its own icon and a one-line description of how it was earned.

## v0.25.7 — 2026-05-30

### General

- You can now rate the map you just played right on the round-results screen, while it's fresh — a 5-star strip above the next-map preview. Works with mouse, touch, and controller (◄ ► to pick a star, Ⓐ to confirm). It's still on the match-over screen too.

## v0.25.6 — 2026-05-30

### General

- Maps are now sorted into playlists. A new **Featured** mix gives you the better-balanced maps by default, and there are themed packs too — Slip & Slide (ice), Hardcore (lava), Pinball (bumpers), Pure Racing, Quick Sprints, Marathon, and Wild for the wild ones. Pick one at the lobby playlist board.
- Rate the map you just played with 1–5 stars on the game-over screen. The best-loved maps rise into a new **Crowd Favorites** playlist, and the map editor now shows each map's rating and balance.

## v0.25.5 — 2026-05-30

### General

- A fully charged punch now hits noticeably harder — winding all the way up sends rivals flying much further than before.

## v0.25.4 — 2026-05-29

### General

- The whole board got a visual pass. Terrain now has richer, warmer colours and a subtle per-tile depth shading, so the ground reads as distinct tiles instead of one flat sheet.
- The goal tile now glows like a beacon — a soft breathing light with an outward pulse ring — so it's easier to spot where you're racing to.
- Lava churns and bubbles with rolling hot spots, and ice shows a soft reflection of the karts gliding over it.
- Ability pickup icons now float and bob above their tile with a little shadow, so they read as a pickup to grab rather than a flat marking.
- These animated touches scale with your graphics setting and turn off on the lowest setting, where the terrain still shows its new colours and depth.

## v0.25.3 — 2026-05-29

### General

- Cart skins now show everywhere your kart appears — on the round-overview scoreboard and in the end-of-match recap — and they read more cleanly with no colour circle poking out behind them. When you catch fire, the skin itself glows red-hot and burns instead of the flames hiding behind it. Your trail always uses your own colour now, even with a skin equipped.
- Brutal-round icons now appear next to the round-start announcement and stay as a small badge in the top-right for the whole round, so you can always tell which modes are active.
- A racer one notch from winning has a bold, shimmering trail again, so the about-to-win player is easy to spot.
- The slowdown ability now shows a clear "drag" effect closing in on whoever's slowed.

### Bug fixes

- You now slide along the edge of a hole when you push into it at an angle, instead of stopping dead.
- Fixed the game-over screen not showing when a match ended during a blackout (or blindfold) round.
- Fixed the between-rounds map preview showing the poison-green "zombie" lava colour left over from a just-finished infection round.

## v0.25.2 — 2026-05-29

### Ability changes

- Bots now play their banked abilities like a thinking opponent instead of firing the moment something wanders into range. A held bomb is aimed at the racer ahead of you (or whoever it can catch the most of at once) and lobbed where you're headed, not where you were; a held swap waits for the actual leader and won't steal you onto a patch of lava it'd just die on; a debuff is saved for when the racers ahead are the ones who'll feel it; and a room-wide blindfold is held back until rivals are in a spot where going blind really hurts — at a lava edge or fighting over the finish — and the bot itself is on safe ground.
- Bots now visibly line a held bomb (and, as before, a held cut) up on a target, so you can read the threat coming and react before they pull the trigger.

## v0.25.1 — 2026-05-28

### General

- New cart skins! Equip a Five-Alarm fire truck or a dinosaur in the skin shop — each has its own animated wheels/legs and a custom fiery or earthy trail, layered on top of your usual color.

## v0.25.0 — 2026-05-28

### Map editor

- New **Empty** tile (number key `9`) lets map makers carve open holes into a map. Holes aren't solid ground — you can see straight through them to the sky below, and driving into one bounces you back off the edge just like the boundary of the map. A glowing rim marks every hole so it's clear where you can't go.

### Bug fixes

- Sand trenches now disappear when the sand does. Previously, if a tile stopped being sand — a bomb flattening it, an ice cannon, a tile-swap, or the lobby resetting itself — the groove your kart had carved stayed painted on the new surface. Trenches now only linger on ground that's still sand.

## v0.24.1 — 2026-05-28

### General

- The arena now floats in space: the blank space around the map is a starfield with twinkling stars, faint nebulae, and a distant planet, and each landmass has a 3D extruded edge so it reads as a chunk of land adrift in the void.
- The starting gate is now a glowing energy containment field that pulses softly, and the start line pulses faster and brighter as the countdown closes in, then flashes green the instant the gate opens.
- The lobby "start game" spinner is reworked into a glowing portal that revs up — its rings spin faster and tighten as players gather to launch.

## v0.24.0 — 2026-05-28

### Bug fixes

- Driving across sand now reads like trudging through a dune: your kart carves a trench that stays for the rest of the round and kicks up a puff of sand the whole time you're on it, instead of only flicking a few flecks the instant you crossed onto it.
- Moving bumpers no longer occasionally fly off their rails and get stuck out in the open after a lag spike — they now stay locked to their track no matter what.

## v0.23.1 — 2026-05-28

### Bug fixes

- When a player leaves mid-round, any ability indicator, swap/explosion targeting circle, or bomb/ice projectile they were holding now vanishes with them instead of lingering as a ghost stuck to a player who's no longer there.

## v0.23.0 — 2026-05-28

### General

- Signed-in players now have a **per-map global leaderboard**. Every time you reach the goal your best time on that map is saved, and the overview screen between rounds shows a card under the next-map preview listing every signed-in racer in the room — their global rank on this map and their personal-best time. Beat your own best and the row lights up gold with a **NEW!** badge.

## v0.22.1 — 2026-05-28

### General

- The game now reaches the lobby much faster, especially on phones and slower or far-away connections — it no longer waits for the entire sound library to download before letting you in. Music and effects stream in quietly in the background instead. (Fixes players, e.g. on mobile in Vietnam, getting stuck on the loading bar.)
- Smaller, faster downloads: background music tracks were re-compressed, assets are now cached by your browser between visits, and the game connects over a faster realtime channel where available.

## v0.22.0 — 2026-05-28

### General

- Driving into lava now shows your kart **sinking and burning** — it shrinks, darkens, and bobs under for a few seconds while still on fire, with embers and bubble pops rising around it. Works on the lobby's lava-and-respawn teaching pool too.
- Player trails behind each kart now **fade out after about 5 seconds** instead of building up the whole round, and the trail itself is a little thinner — keeps your line readable without filling the map.
- Ice now leaves skate marks at any speed (was only at a full glide), and bare dirt picks up a subtle puff at a walk. On phone-class devices these subtler effects are skipped to keep frames smooth.

## v0.21.1 — 2026-05-28

### Bug fixes

- Moving bumpers no longer freeze mid-track after running their first round-trip on maps where the rail isn't axis-aligned (e.g. *What Goes Up*) — they keep oscillating back and forth as intended.
- After an infection round, the poison-green lava texture used to linger into the next round; lava now snaps back to red the moment the infection wears off.
- The "next map" preview between rounds now shows bumpers and moving bumpers so you can see what's coming, and random ("?") tiles render with their ? icon instead of a flat purple cell.

## v0.21.0 — 2026-05-28

### General

- The lobby's **AI bots** station's **Auto** mode now scales with the lobby: solo gets 1 bot, two players get 2 bots, a small group gets a few, and a packed lobby fills the room. So a quiet lobby races something close to a 1-v-1, and a full lobby still races a full grid.

## v0.20.1 — 2026-05-28

### General

- Punches hit in every direction again — your swing pops out around your whole kart instead of only landing in front of you. A rival pressed against your side gets shoved away just like one head-on, and the new charge-up glow rings your kart so the wind-up is visible from any angle. The momentum, charge meter, stamina ring, overcharge fizzle, and counter-clash all still work the same.

## v0.20.0 — 2026-05-28

### General

- You can now join a match that's already in progress from the **Join** menu (or with a Game ID / shared link): in-progress games show a **Spectate** button instead of a greyed-out "In progress". You watch the current round, then race in when the next round starts — an on-screen banner shows the kart colour you'll race as. Only genuinely full games stay unjoinable.
- Plug in a second controller mid-race for **local couch co-op** and your friend now gets the same Spectate-then-race-next-round treatment, with the banner fading down so it doesn't get in your way while you're still racing.

## v0.19.0 — 2026-05-28

### General

- Plug in a controller mid-game and you can now actually join: pressing to join part-way through a match adds you as the next racer (you hop in when the round resets) instead of flashing "joined" and immediately booting you.
- The lobby's **Skins** and **AI bots** stations now sit on the grass — the AI bots station moved up front next to the spawn so it's the first thing you reach.

### Bug fixes

- The air-hockey puck no longer keeps ricocheting around after a round is decided, so its bounce sound stops spamming once the round ends.
- Fixed not being able to join a game from the **Join** menu by tapping its button on a touchscreen (the list could refresh out from under your tap).
- The crowd on the right side of the screen now hugs the arena edge like the other sides.
- The end-of-game winner screen text is now always readable, whatever colour the winner is.

## v0.18.0 — 2026-05-27

### Map editor

- The map editor has been rebuilt with an MS-Paint-style layout: a top action bar, a left tool rail (Select, Eraser, tiles, hazards, start edge), and the canvas filling the rest. On phones and tablets it reflows to a top tool strip and a bottom action bar, and — for the first time — the editor is fully usable by **touch** (the tools used to disappear entirely on small screens).
- Added **Undo/Redo** (Ctrl+Z / Ctrl+Shift+Z) covering tile painting, hazard placement, deletion, and rotation.
- Added **keyboard shortcuts**: `S` select, `E` eraser, `1`–`8` tiles, `B`/`M` hazards, `R` / `Shift+R` rotate, `Delete` to remove a selected hazard.
- Selected hazards now show on-canvas handles you can grab to **rotate** (any angle) or **delete**, plus toolbar buttons to rotate in 15° steps either direction (it only rotated one way before).
- **Right-click** a hazard to delete it, or right-drag to erase tiles back to dirt.
- The map list now has a **search box** to filter by name or author, a responsive grid, and the "Create a new map" tile is relabelled **"Continue editing"** while you have an in-progress map.
- Copy/Upload now tell you when the author or map name is missing (they used to silently fall back to "anonymous"/"unknown"), and status messages clear themselves instead of lingering.
- The tile and hazard buttons now show the **actual texture** they paint (grass, lava, ice, dirt, sand, the bomb tile, etc.) instead of flat colours — the tile's name shows on hover.
- Opening a different map while you have **unsaved edits** now asks for confirmation first, so you can't lose your work by clicking back and picking another map.

## v0.17.0 — 2026-05-27

### General

- Touch: the camera now follows you in the lobby (like it does during a race), instead of showing the whole lobby zoomed out — so you're not a tiny dot on a phone screen while walking to a station.
- Touch: a translucent settings (gear) button now appears at the top of the screen while you're in fullscreen, opening the same Settings panel the controller's Start button does (sound, music, camera, colour-blind, theme) — tap a row to change it and **Done** to close. Previously fullscreen touch players had no way to reach Settings.

### Bug fixes

- Touch: the Fullscreen button now actually enters fullscreen. It was firing the request the instant your finger touched down, which browsers reject (fullscreen must be requested as your finger lifts) — so it silently did nothing. It now triggers on release.
- Touch: tapping the screen no longer fires a phantom punch, and double-tapping no longer flips on the desktop "mouse-drive" mode (which could send your kart driving off on its own to its death). Tablets/phones were quietly delivering simulated mouse clicks on top of every tap, so taps — including on the Fullscreen button — were also registering as clicks.
- Touch: the on-screen buttons now line up exactly with where you tap, even when the browser renders the play area at a slightly different size than expected (which made the top-right Fullscreen button especially easy to miss into a punch on iPad).
- Touch: punching now works on tablets and iPads. There's a clear **Attack** button in the lower-right corner that lights up when you press it, and tapping anywhere on the right side of the screen throws a punch — previously the punch target was a small invisible circle stuck in the screen's middle, so on bigger screens a thumb resting in the corner missed it every time.
- Touch: the top-corner Fullscreen and Emoji buttons are bigger and have a visible backing, and tapping near them no longer throws a punch by mistake.
- Touch: the on-screen controls no longer vanish during the Blackout brutal round — they now stay visible on top of the darkness.

## v0.16.0 — 2026-05-27

### General

- The game now picks a graphics-detail level to match your device, dialing back heavy effects (particles, glows, the crowd, trail length) on phones and small or low-powered screens so it runs smoother — desktops keep the full show. A new "Graphics detail" control in the top bar (and in the controller Settings panel) lets you override it: Auto, High, Balanced, or Low. Your choice is remembered.
- Movement is smoother across the board — karts, bumpers and other moving things now glide between updates instead of stepping, so motion looks fluid even on high-refresh and mobile screens.

## v0.15.0 — 2026-05-27

### General

- AI racers handle ice a lot better. They now slow down before sliding onto an icy stretch and look much farther ahead while on it, so they curve around lava instead of skating straight into it — they make it across slippery, lava-lined maps far more often than before.

### Bug fixes

- AI racers no longer sit frozen forever in a lava-walled corner. A bot that gets wedged with no way forward — most often boxed in near the starting edge — now commits straight toward the goal to break out instead of loitering in one spot for the whole race (it either threads back onto the track or goes down trying).

## v0.14.0 — 2026-05-27

- New **Learn** page, reachable from the landing screen — an in-game Codex that explains every tile, ability, brutal round, and medal, each with a plain-English "how it works and feels" description and a little live animated example built from the real in-game effects. Search the codex or filter it by category, and browse it all with a controller or by touch.

## v0.13.0 — 2026-05-27

### General

- Punching is about timing and positioning now, not mashing. Your punch hits as hard as the speed you carry into it — a standing tap barely nudges, but driving into someone at full speed lands a real shove. A glow in front of your kart previews how hard you'd hit right now.
- Hold the punch button to charge a heavier hit: the longer you hold, the more of your stamina bar you pour in and the harder it lands (force = your speed × your charge). A fist winds up in front of your kart as you charge — and everyone can see it coming, so a big haymaker can be dodged or beaten to the punch. A full charge empties your bar. Landing a fully-charged punch connects with a meaty *thwack* and a real screen-kick, and your view rumbles while you wind one up.
- Don't hold a charge too long: past a few seconds a dark-red "overcharge" meter fills around your kart, and if you don't let go in time the charge fizzles out and you're left winded — stuck moving slow for a few seconds with nothing to show for it.
- Punching draws from a stamina meter that wraps around your kart: you get a couple of taps (or one big charge) before you run dry, then have to let it recharge a bit before you can punch again, so spamming punch no longer pays off. While you're winded you move a little slower until you've recovered a punch's worth. The meter only shows up once you've started punching and fades away once you've recovered.
- Head-on punches clash. If two players punch into each other at the same moment while facing off, an evenly-matched pair both get flung back — hardest on whoever committed the most force — but a clearly stronger punch (like a charged one) bowls straight through a weak one. So you can counter an incoming punch by swinging back at the right time, and over-committing a big charge into someone who counters can backfire and send you flying.

## v0.12.3 — 2026-05-27

### Bug fixes

- Fixed a bug where being knocked onto an ability tile at the same time as another player (by an explosion or a punch) could hand the single pickup to both of you.

## v0.12.2 — 2026-05-27

### General

- The lobby's skin and AI stations swapped sides — the skin station is now on the left, the AI station on the right.

## v0.12.1 — 2026-05-26

### General

- The maps got a visual refresh: terrain colours are re-graded into one cohesive palette so tiles no longer clash (the neon grass and washed-out ice are gone), every region now has a crisp edge so tiles read more clearly, the random tile is purple instead of harsh electric blue, bumpers and the goal sit better with everything else, and the arena has a subtle vignette around the edges.

## v0.12.0 — 2026-05-26

### General

- The end-of-game recap is a real highlight reel now: clips are pulled from across the whole match (not just the final round), feature different players and moments instead of only the winner, and replay over the map as it looked during the action instead of a field of lava. Karts show their flames, ability aimers and zombie auras, brutal-round props like pucks, bombs and clouds replay too, karts leave their coloured trails and name labels, throw their emotes, and show speed-boost streaks, the map itself evolves as it did during the round (lava spreading in, tiles flipping), and the full effects layer comes along for the ride — bomb/ice explosions, muzzle flashes, rising embers off burning karts, dust kicked up behind movers, collapse shockwaves, charging ability reticles and the screen-shake of a blast. The clip window is larger now, the brutal round and any vision effects (blindfold/blackout/cloudy) are shown with their familiar in-game icons in the corner rather than covering the clip, the action replays in a slight slow-motion for a more cinematic feel, and players who get eliminated or score now go out with a quick poof instead of hovering in place.

## v0.11.0 — 2026-05-26

### General

- A live crowd now fills the empty space around the arena on wider/taller screens — a stadium of fans that bobs along with the audience and leaps up, waves, and throws confetti on big plays. (On a perfectly 16:9 screen there's no empty space, so no crowd.)

## v0.10.0 — 2026-05-26

### Map editor

- Map makers can now pick which edge the race starts from — left, right, top, or bottom — instead of always starting on the left. You can also choose a two-sided start (left + right, or top + bottom) that splits the racers across opposite edges for a head-on dash to the middle. The editor draws the start gate(s) where you picked so you can line up your goal; two-sided maps play fairest with a goal near the center.

## v0.9.1 — 2026-05-26

### General

- The lobby now has walk-up "hub" stations: drive onto the **AI Bots** pad to choose how many bots join the next race (or turn them off), and the **Skins** pad to recolour your kart from the palette. Open a station's panel with E / a tap / the A button, and each couch player can set their own station at the same time. By default the grid auto-fills toward ~8 racers, so bots make up the difference as players join and leave — and the current setting is shown to the whole lobby.
- The room list (join page) now shows a room's bots — the live count mid-race, or the number queued up for the next race from the lobby.

## v0.9.0 — 2026-05-26

### General

- Controllers can now open an in-game **Settings** menu (press Y / △) to change sound effects, music, dynamic camera, colour-blind assist, and the light/dark theme without reaching for the mouse. In local co-op, only Player 1 can open it — the settings are shared by everyone on the screen.

## v0.8.4 — 2026-05-26

### Map editor

- Previews now run solo by default — it's just you and your map, no bots. Flip the new "AI racers" button on before hitting Preview / Playtest to fill the grid with AI opponents like before. Your choice is remembered for next time.

## v0.8.3 — 2026-05-26

- Playtest maps with friends: local co-op now works in the editor's Preview — extra players can press to join during the countdown, and the designer (or any player) can leave anytime to head back to the editor.

## v0.8.2 — 2026-05-25

### Bug fixes

- Flame and burn kills now credit the player who shoved you onto the lava, even if your fire shield kept you burning for a few seconds before you went down.

## v0.8.1 — 2026-05-25

### Bug fixes

- AI racers no longer get stuck dithering or grinding to a halt in tight, winding corridors (most noticeable on Sidewinder) — they hold a steadier line, spot thin slivers of lava sooner, and push through a narrow pinch instead of lining up and waiting on it.
- An AI racer holding the Cut ability now points its beam at the nearest rival instead of letting the line spin around aimlessly.
- The room list no longer hides games that are full or already in progress — they now show up greyed out as "Full" or "In progress" so you can see what's happening (and can't accidentally drop into a match mid-race).

## v0.8.0 — 2026-05-25

### General

- Other players' karts and trails now fade a little during a race, so your own kart stands out in a crowded pack (danger like fire and ability rings stays at full brightness).
- Other players' emote bubbles are fainter and fade away over a few seconds, so chat stops cluttering the action.
- Kart colours are now chosen to be as visually distinct as possible, so you're far less likely to see two players in lookalike shades.
- New colour-blind assist toggle in the top bar recolours every kart with a colour-blind-friendly palette.
- Tile Swap's warning now reads as a calmer glow instead of an intense flicker.

### When you're knocked out

- Press attack while you're down to ping where players fell — it reveals every knocked-out player's spot at once, so you can read the whole board.
- The skull markers left by knocked-out players now fade away after a few seconds so they stop cluttering the board (a ping brings them back).

### Controller & couch co-op

- [headline] Local co-op with controller support — up to 4 players on one screen (controllers plus one on keyboard/mouse), all in the same game as anyone online.
- Leaving the game on a controller now takes a deliberate button hold, so a mashed attack can't make you quit by accident.
- In couch co-op, each player's on-screen controller guide (which pad you are, plus your buttons) now stays put instead of fading out.

### Display

- Fullscreen no longer stretches the game on non-16:9 screens — it fits with clean letterbox bars instead of looking squished.
- On a phone held in portrait, a prompt now asks you to rotate to landscape (the game is built for a wide view).

## v0.7.0 — 2026-05-25

### General
- End-of-game recap: the win screen now replays short highlight clips from the match — one per medal, zoomed in on the action.

## v0.6.3 — 2026-05-24

### AI racers

- Bots now take the ice: they'll route onto grass→ice lanes to carry a fast, frictionless glide instead of avoiding the ice.
- Bots steer clear of the whole path of a moving bumper instead of pinballing into it, so they stop getting stuck on bumper hazards.
- Bots now bank their abilities like a patient player and spend them at a real moment — a speed boost while chasing or on the final dash, a rival-slow when they're behind in a pack — instead of firing the instant they pick one up. Anything still held when the floor starts collapsing gets used rather than wasted.

## v0.6.2 — 2026-05-24

### Bug fixes

- You can no longer throw a punch (or hear the punch sound) on the "next map" screen between rounds — punching now only works during a race, at the starting gate, and in the practice lobby.
- Getting knocked back behind the starting gate no longer leaves you sliding around like you're still on ice — your grip returns to normal off the track.

## v0.6.1 — 2026-05-24

### General

- Your kart now wears a glowing ring in its own colour so you can spot yourself in a crowded pack; in couch co-op each player gets their own coloured glow.

### Bug fixes

- Dark mode no longer hides the on-screen fullscreen and emoji buttons on touchscreens — they now show up clearly against the dark board.

## v0.6.0 — 2026-05-24

### Animations & game feel

- A big animation & game-feel pass — punches, hits, explosions and ability casts now land with real weight and screen shake.
- Players kick up dust at speed and trail embers while on fire.

### Combat

- Punches are now directional — face an opponent to knock them away. (Hockey-puck bashes and swatting the infected stay all-directional; zombies must face their prey to bite.)

### Abilities

- Tile Swap telegraphs before it fires: the tiles about to flip pulse and flicker, then swap a few seconds later.

### AI racers

- AI racers move a little faster, closer to human pace.

## v0.5.0 — 2026-05-24

### AI racers

- Solo and small games now fill out with named AI racers that drive the course — pathfinding to the goal, braking through corners, and avoiding lava and bumpers — so there's always a full grid.
- They play the whole game: grabbing and using abilities (bombs, boosts, slows, swaps, ice, blindfolds) and throwing punches — including shoving you toward the lava when you leave an opening.
- They handle brutal rounds too: infected bots turn zombie and chase you (healthy bots fend them off), they bash and dodge the hockey puck, ease up for lightning, and get just as lost in blackout, blindfold and clouds as you do.
- Each racer has a personality — a clean pace-setter, a punch-happy wrecking ball, a corner-cutting high-roller, a rival who fixates on you, a chaos-merchant, a cautious tortoise, and a hothead who tilts when behind — and they rubber-band to your pace so a win feels earned. Names and in-character taunts show under each kart.

### Solo play

- Playing solo is winnable: when you're alone, the lava closes in from the goal nearest you at a pace tuned to the distance, so a clean run beats the map instead of a random, map-blind collapse.

### Brutal rounds

- The collapse telegraphs itself — an erupting shockwave sweeps from where the lava starts toward the goal it's closing on (with the volcano rumble), so you can read which way to run.
- Volcano eruptions are timed to map size (about how long it takes to reach the nearest goal) instead of a fixed delay, so bigger maps give proportionally more warning.

## v0.4.0 — 2026-05-24

### Audience

- A stadium crowd now watches and reacts — quiet early, but as someone nears the win they roar for multi-kills and sprees, cheer kills, "ooh" at fights, gasp at near-lava escapes, and erupt when you beat the lava to the goal.

## v0.3.3 — 2026-05-24

### General

- The lobby is now a hands-on practice area: before a match you can roam curated patches of terrain (lava, ice, sand, grass, goals) and try a handful of ability pickups to learn the controls and the feel of each surface. Touch lava and you respawn safely with a few seconds of invulnerability; reach a goal for the victory cue. Nothing counts toward your score, and stepping into the center start circle keeps you invulnerable until the match begins.

### Bug fixes

- Sliding bumpers no longer freeze at the end of their track once a match starts — they turn around and keep sweeping as intended.

## v0.3.2 — 2026-05-24

### General

- Optimized server performance for smoother gameplay, especially in busy rooms.

## v0.3.1 — 2026-05-24

### Bug fixes

- Sliding bumpers no longer jitter or get stuck off the end of their track. After a hitch they now snap back onto their rail and keep moving smoothly.

## v0.3.0 — 2026-05-24

### Map editor

- You can now preview a map you're building straight from the editor and play-test it solo before saving. Hitting Preview drops you right into the race — no lobby to wait through. When you die or reach the goal, you're dropped back into the editor with your map intact so you can keep tweaking and try again. Maps without a goal tile can't be previewed.

## v0.2.0 — 2026-05-24

### General
- [headline] Local co-op with controller support — up to 4 players on one screen (controllers plus one on keyboard/mouse), all in the same game as anyone online.
- Plug in controllers and they show up in a header at the top of the screen; press A on one to jump in. The first controller (with no keyboard player) becomes Player 1, and each player gets their own color so you can tell who's who.
- Each player has their own on-screen controls, emoji wheel, and a "Leave?" prompt (B on a controller, Esc on keyboard) — one player leaving or unplugging never ends everyone else's game.

## v0.1.6 — 2026-05-23

### General
- Everyone in a game now hears the same background music at the same time, and it switches moods together — calm normally, intense when someone's one win away, and ominous on brutal rounds.

### Bug fixes
- Background music no longer cuts out to silence mid-round when a track finishes; it rolls straight into the next one.
- Background music now plays continuously through the round-transition and map-load screens instead of restarting at the start of every race.

## v0.1.5 — 2026-05-23

### Bug fixes
- Fixed a crash that could take down a game when a room filled with many players.

## v0.1.4 — 2026-05-23

### General
- [headline] Now with controller support! Plug in a controller and play

## v0.1.3 — 2026-05-23

### Bug fixes

- Using an ability no longer brings your character to a stop. Only punching without an ability slows you down now.

## Older versions

For releases before this CHANGELOG existed, see https://github.com/sjdodge123/chaochao/releases.
