# Changelog

All notable player-facing changes land here. Anything that changes a game mechanic — gameplay tuning, game state/round logic, or physics — MUST add an entry under "Unreleased" in the same change (the `Game mechanic changes need release notes` CI job enforces this).

Write entries in the same player-friendly style as the GitHub releases: short bullets describing what a player will notice, grouped under section headings (`### General`, `### Ability changes`, `### Brutal rounds`, `### Map editor`, `### Bug fixes`, etc.).

Releases are cut automatically on merge to `main` by the `Release on merge to main` workflow: when `## Unreleased` has notes, it moves them under a new `## vX.Y.Z — YYYY-MM-DD` heading, resets `Unreleased`, bumps `package.json`, tags `vX.Y.Z`, and publishes the GitHub release using that section as the body. The version bump comes from the merged PR's label — `release:major`, `release:minor`, or `release:patch` (default `patch`). PRs that add no notes don't trigger a release.

After each release the same workflow also rolls every `vX.Y.Z` from the current calendar week (Monday–Sunday, UTC) into a single consolidated `week-YYYY-MM-DD` GitHub release, and the landing-page banner shows **one headline for the week** linking to it. To choose that headline, prefix the bullet you want featured with `[headline]`, e.g. `- [headline] Now with controller support!` — the most recent flagged bullet of the week wins, and the marker is stripped everywhere it's shown (banner, per-PR release notes, weekly digest). If no bullet is flagged, the week's first bullet is used.

## Unreleased

(none yet)

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
