# Changelog

All notable player-facing changes land here. Anything that changes a game mechanic — gameplay tuning, game state/round logic, or physics — MUST add an entry under "Unreleased" in the same change (the `Game mechanic changes need release notes` CI job enforces this).

Write entries in the same player-friendly style as the GitHub releases: short bullets describing what a player will notice, grouped under section headings (`### General`, `### Ability changes`, `### Brutal rounds`, `### Map editor`, `### Bug fixes`, etc.).

Releases are cut automatically on merge to `main` by the `Release on merge to main` workflow: when `## Unreleased` has notes, it moves them under a new `## vX.Y.Z — YYYY-MM-DD` heading, resets `Unreleased`, bumps `package.json`, tags `vX.Y.Z`, and publishes the GitHub release using that section as the body. The version bump comes from the merged PR's label — `release:major`, `release:minor`, or `release:patch` (default `patch`). PRs that add no notes don't trigger a release.

After each release the same workflow also rolls every `vX.Y.Z` from the current calendar week (Monday–Sunday, UTC) into a single consolidated `week-YYYY-MM-DD` GitHub release, and the landing-page banner shows **one headline for the week** linking to it. To choose that headline, prefix the bullet you want featured with `[headline]`, e.g. `- [headline] Now with controller support!` — the most recent flagged bullet of the week wins, and the marker is stripped everywhere it's shown (banner, per-PR release notes, weekly digest). If no bullet is flagged, the week's first bullet is used.

## Unreleased

### General

- [headline] Every match now earns you XP — play to level up and unlock cosmetics. Win for a fat XP bonus (and runner-up gets a little something too).
- Mix-and-match cosmetics: your kart now has three separate slots — a **cart** body, a **pattern**, and a **trail** — and you can wear one of each at the same time, all in your chosen colour. Patterns paint over your colour and trails fly in your colour, so a Dino body + Checkered pattern + Sparkle trail in blue all reads as one kart.
- New unlock ladder: a fresh cosmetic every two levels, rotating pattern → trail → cart. To level 30 that's 5 carts (Truck, Drone, Dino, Hoverbike, Starfighter), 5 patterns (Racing Stripes, Polka, Checkered, Flames, Nebula), and 5 trails (Dashes, Sparkle, Comet, Bubbles, Aurora) to chase.
- The lobby skin station is now four groups — Colour, Carts, Patterns, Trails — each cell showing a live preview and a 🔒 with what unlocks it. Equip each slot independently; your picks are remembered between sessions.
- Medal cosmetics: stacking up honours over time unlocks special items in matching slots — Golden Champion and Warlord carts, Executioner and Punching Bag patterns, and Guardian and Survivor trails. The thresholds are a long-haul grind (50–100 of a medal).
- Tons more cart bodies to drive — from a Hoverbike and Starfighter to a whole zoo of novelty karts (8-Ball, Donut, Disco Ball, Compass, Pizza, and dozens more), each tinted to your colour.
- New motion trails with real personality: Ribbon, Lightning, Hearts, Smoke, Confetti, Crystals, Tire Tracks, Music Notes, Neon Wall, and Ripples — all flying in your colour.

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
