// ============================================================================
// learn.js — the Codex / "Learn" page (client-only, no game loop, no socket).
//
// LAYOUT: a responsive full-info CARD GRID grouped by category. Each card shows
// a live in-game animation (drawn by learnScenes.js), an icon + name, and the
// full plain-English description. A sticky toolbar at the top has a search box
// and category-filter chips. Chosen over master-detail because it fills the
// width (no whitespace), needs no modal, and degrades to 1 column on phones.
//
// DUAL PURPOSE — keep both in mind when editing:
//   1. PLAYER REFERENCE: how every mechanic/tile/ability/brutal round/medal
//      WORKS AND FEELS. Deliberately NO numbers / percentages / durations —
//      describe the feel ("a short fuse", "skates", "briefly"), never the value.
//   2. AGENT KNOWLEDGE BASE: the CODEX array is the canonical plain-English
//      description of what the game does. When you change a mechanic in
//      server/config.json / game.js / engine.js, update the matching entry here
//      in the SAME change. (Contract recorded in MEMORY.md → "Learn/Codex page".)
//
// SOURCING + GOTCHAS:
//   • Behaviour confirmed in server/engine.js, game.js, entities/player.js,
//     achievements.js (medals; note the source typo "Resouceful" → shown
//     "Resourceful"). Tuning lives in server/config.json.
//   • PUNCH entry: omnidirectional radial hit (hitbox at the puncher's position;
//     no aim). Momentum-scaled bonus + hold-to-charge ring + stamina + overcharge
//     + facing-based clashes + the full-bar double-tap land lunge (config.landLunge).
//     Reconcile here if player.js / config punch*/landLunge changes.
//   • Each entry has `anim`: a scene name registered in learnScenes.js. Add a
//     card → add a SCENES[name] there too. Scenes reuse the REAL game art (kart
//     disc, fire sprites, bumper disc+ring, terrain PNGs, gold goal).
//   • Icons: ability/brutal SVGs are BLACK SILHOUETTES → shown on a light chip
//     (.codex-icon--svg) so they survive dark theme. The bumper head-icon is
//     drawn procedurally via LearnAnim.staticIcon (matches in-game).
//   • Only brutal rounds active:true are shown; parked ones (gravity/fiesta/
//     golden) stay in CODEX with show:false so the knowledge survives.
//   • Page is socket-free / no config fetch (static, instant, can't error).
//
// CONTROLLER / TOUCH:
//   • Search box + chips + every card carry data-gp-nav; shared menuGamepad.js
//     does 2D-spatial focus (A=activate, B=back). Cards are focusable so a pad
//     can scroll the whole grid. osk.js gives pad-driven typing in the search.
//   • Tap targets (search, chips) are >=44px; see styles.css.
// ============================================================================

(function () {
    "use strict";

    var IMG = "assets/img/";
    function svg(file) { return { kind: "svg", src: IMG + file }; }
    function tex(file) { return { kind: "texture", src: IMG + file }; }
    function swatch(color) { return { kind: "swatch", color: color }; }
    function emoji(glyph) { return { kind: "emoji", glyph: glyph }; }
    function art(name) { return { kind: "art", art: name }; }   // procedural in-game art

    // ------------------------------------------------------------------------
    // THE CODEX. `blurb` = short line (also fuels search). `detail` = full prose
    // (string or array of paragraphs) shown on the card. `anim` = scene name in
    // learnScenes.js. `id` must be unique (used for the deep-link hash).
    // ------------------------------------------------------------------------
    var CODEX = [
        {
            id: "basics",
            label: "Basics",
            entries: [
                {
                    id: "winning", name: "Winning a Match", icon: swatch("#FFD700"), anim: "goalRun",
                    blurb: "Reach the goal to score — first to enough wins.",
                    detail: "Every round is a dash to the glowing goal zone — cross into it and you bank a notch toward the match win. The more racers in the room, the fewer notches it takes, and leading is dangerous: fall just short and rivals gun for you, eager to knock the leader down."
                },
                {
                    id: "momentum", name: "Building Speed", icon: swatch("#5ad1ff"), anim: "goalRun",
                    blurb: "Hold a line to wind up to top speed.",
                    detail: "Your kart doesn't snap to full pace the instant you push a direction — it starts a touch slower and winds up to its top speed over a couple of seconds of holding a steady heading. Small steering corrections keep that momentum, but cut a hard turn or stomp the brakes and you dump it and have to wind back up. Your top speed itself hasn't changed; you just have to earn it, so committing to a clean racing line beats constantly jinking around. (Surface still rules: this rides on top of each tile's own grip.)"
                },
                {
                    id: "collapse", name: "The Collapse", icon: tex("lava.png"), anim: "collapse",
                    blurb: "The floor turns to lava and squeezes everyone inward.",
                    detail: "Once the front-runners are home, the arena turns to lava from the edges inward, shrinking the safe ground and herding everyone toward the middle. It's the round's clock — but when one racer is left, the lava eases up to give them a fair shot at the goal. Water is the one exception: when the front reaches it, it slow-boils for a few seconds — bubbling and steaming through a tiered warning — before it finally turns to lava, so a flooded shortcut stays open a little longer than the dry ground around it."
                },
                {
                    id: "punching", name: "Punching", icon: emoji("👊"), anim: "punch",
                    blurb: "Timing and positioning, not mashing.",
                    detail: "Punching is about commitment, not how fast you tap. A swing pops out around your kart and shoves anyone touching it — no aim, just position — and lands as hard as the speed you carry into the hit, which a glowing halo previews. Hold the button to wind up a heavier, telegraphed haymaker, but overcharge and it fizzles, leaving you winded. Every swing drains a stamina ring, so mashing runs you dry, and punches clash: charge into a rival who's swinging back and an even match sends both flying, while a clearly stronger punch bowls straight through a weak one. There's one repositioning move: double-tap punch while holding a direction to LUNGE — a short forward hop, the same stroke you use to swim, but on dry land. It's for dodging a hazard or scooting off bad ground, not for speed: the hop is small, it drains your whole stamina bar, and you're left slow for a beat after, so it actually costs you ground against someone who just kept driving."
                },
                {
                    id: "fire", name: "Fire & Killstreaks", icon: tex("redFire.png"), anim: "fire",
                    blurb: "Kills set you ablaze and hit harder.",
                    detail: "Knock a rival into the lava and you catch fire — flames trail your kart, your hits land meaner, and you move faster. Keep the streak alive and the arena escalates the call-out from Killing Spree to Rampage to Godlike, but the flames paint a target on your back."
                },
                {
                    id: "pickups", name: "Ability Pickups", icon: svg("toolbox-solid.svg"), anim: "pickup",
                    blurb: "Roll over a pad to pocket a single-use power.",
                    detail: "Some maps scatter ability pads around the track; roll over one to pocket a single-use power, from a lobbed bomb to a blinding fog to a swap with a rival. You hold one at a time, so save it for the perfect moment or burn it to escape trouble — a used pad goes quiet briefly, then re-arms."
                },
                {
                    id: "map-ramp", name: "Map Difficulty Ramp", icon: emoji("🌡️"), anim: "goalRun",
                    blurb: "Early rounds favor friendly maps; match point brings out the gauntlets.",
                    detail: "The map shuffle reads the room. Rounds 1 and 2 lean toward the catalog's friendlier, more open maps so everyone gets racing — the true meat grinders sit out that early whenever anything gentler is left in the rotation. Through the middle of a match every map gets its fair shake, same as always. But the moment anyone reaches match point, the rotation turns up the heat: deciding rounds skew toward the hardest maps in the playlist, so closing out a win means surviving the gauntlet. It's a lean, not a lock — every map in your playlist stays in rotation, no map repeats until the pool runs dry, and a playlist with no easy maps simply shuffles like it always did."
                },
                {
                    id: "game-modes", name: "Game Modes", icon: emoji("⚔️"), anim: "brutalIntro",
                    blurb: "The lobby's mode station sets what kind of game your room plays.",
                    detail: "Drive into the purple ⚔️ Game Mode station in the lobby to pick the room's mode — the pick is room-wide (last pick wins, like the playlist board), shows in the lobby's status card for everyone, and locks in once the race starts. Standard FFA is the classic free-for-all. Brutal FFA makes EVERY round a brutal round, from round 1 on — the brutal twist still varies (and can still stack) each round. Your room keeps its mode between matches, and the join page shows each room's mode before you join."
                },
                {
                    id: "team-modes", name: "Team Modes", icon: emoji("🛡️"), anim: "goalRun",
                    blurb: "Crimson vs Jade — racing AND fighting score team points; deaths cost them.",
                    detail: "Team Race and Brutal Teams split the room into Crimson and Jade — your team shows as a colored glow under your kart while your own colors and cosmetics stay yours. Teams play for a shared POINTS score: first across the line +5, second +3, any other finisher +1, an enemy knockout +2 — and every death on your side costs a point (the score floors at 0). One or two glowing golden BONUS ORBS also sit out on the map each round (more on bigger maps), tucked into the quieter areas off the direct line to the goal; the first racer from either team to drive over one banks +1 for their team, and it's a one-time grab — once it's collected it's gone until the next round. Points float over the kart that earned or lost them. Once your team HOLDS the target score, the next first-place finish by anyone on it wins the match on the spot — and deaths can drop your team back under the line, so match point must be defended. If the round cap runs out first, the leading team takes it, and a tie plays on. Teams are fixed for the whole match; new arrivals join the smaller side. Teammate punches do nothing (brawl shoulder-to-shoulder safely), but abilities stay team-blind — a bomb is everyone's problem, you just earn nothing for clipping your own side and their death still costs your team. Zombies ignore teams entirely, and in a Brutal Teams bunker round the door opens once only one team is left standing."
                }
            ]
        },
        {
            id: "terrain",
            label: "Terrain",
            entries: [
                { id: "tile-normal", name: "Normal Ground", icon: tex("dirt.png"), anim: "terrainNormal",
                  blurb: "The default footing — your baseline.",
                  detail: "Plain dirt with predictable grip and steady acceleration. This is the feel every other surface is measured against — nothing surprising, just honest traction." },
                { id: "tile-fast", name: "Fast Ground", icon: tex("grass.png"), anim: "terrainFast",
                  blurb: "Slick and speedy — easy to overshoot.",
                  detail: "Grass that lets you accelerate harder and carry more speed. Brilliant for overtakes and breakaways, but all that pace makes it easy to blow straight past a tight turn." },
                { id: "tile-slow", name: "Slow Ground", icon: tex("sand.png"), anim: "terrainSlow",
                  blurb: "Draggy sand that saps your momentum.",
                  detail: "Sand grabs at your wheels and bleeds off speed the moment you touch it — you trudge through it, carving a trench and throwing up dust in your wake. Plowing through a patch costs you, so it's often worth the longer line around it." },
                { id: "tile-ice", name: "Ice", icon: tex("ice.png"), anim: "terrainIce",
                  blurb: "Almost no grip — you keep sliding.",
                  detail: "Ice barely bites — you keep gliding long after you ease off, steering only suggests where you'd like to go, and any shove sends you skating helplessly. There is one trick: hold your punch charge while on ice to DRIFT — you slow slightly and your edge digs in, giving back real steering control (your charge ring frosts over icy blue and you hear the skid hiss while it's working). Drift far enough without your punch landing on anyone — and without burning up in lava — and you're in the running for the Smooth Operator medal." },
                { id: "tile-water", name: "Water", icon: swatch("#2f6fb0"), anim: "terrainWater",
                  blurb: "Punch to swim — slow but crossable.",
                  detail: "Deep water barely lets you drift on your own — to really move, PUNCH to swim: each stroke shoves you the way you're steering. It's slow going and strokes spend stamina, so only dive in when the shortcut genuinely pays. Climbing out leaves you dripping wet and sluggish for a moment, and where water meets lava the edge hardens into stone you can't cross. Carry a killstreak fire shield in, though, and you don't swim at all — the flame lets you stride straight across with steam hissing off you, burning down as you go just like it would on lava (a wide pond can snuff it mid-crossing and drop you into the swim). In infection rounds zombies can't swim at all, so water is a true escape from the horde." },
                { id: "tile-lava", name: "Lava", icon: tex("lava.png"), anim: "lavaBurn",
                  blurb: "Touch it and you burn out of the round.",
                  detail: "A fiery dunk and you're done — burned out and respawned, out of the round. The collapse turns the whole arena into this, and a well-aimed punch can post a rival straight into it." },
                { id: "tile-goal", name: "Goal", icon: swatch("#FFCB30"), anim: "goalRun",
                  blurb: "Reach it to bank a notch.",
                  detail: "The finish zone, glowing gold. Reaching it banks you a notch toward the match win. It's the one tile everyone is racing toward, every single round." },
                { id: "tile-ability", name: "Ability Pad", icon: swatch("#C8C8C8"), anim: "pickup",
                  blurb: "Grab a random single-use power.",
                  detail: "A pickup pad. Roll across it to grab a random single-use power. It goes dormant briefly after someone claims it, then lights back up for the next racer." },
                { id: "tile-bumper", name: "Bumpers & Placeables", icon: art("bumper"), anim: "bumper",
                  blurb: "Maps are dotted with hazards and boons — see those categories.",
                  detail: "Bump a bumper and you're flung away — maddening in a hurry, but a clever way to launch a chasing rival off their line. Bumpers are just the most familiar of the placeables map makers scatter around a track: spinning rotors, erupting geysers, proximity mines, vortex wells, laser gates, crushers, sentry turrets and more on the hazard side, plus helpful boons like dash arrows, warp pads, ziplines and lily pads. Each has its own card — see the Hazards and Boons categories for how every one behaves and how to play around it. Rival AI racers read them too, timing the moving ones and routing around the rest." },
                { id: "tile-barrier", name: "Fences & Walls", icon: swatch("#9aa0a8"), anim: "barrier",
                  blurb: "Solid barriers you can't drive through.",
                  detail: "Some maps wall off part of the track with fences and walls — solid lines you simply can't cross. Run into one and you don't stop dead; you slide along its face, exactly like the hardened stone where water meets lava. They don't hurt you, they just block the way, so map makers use them to carve corridors, pen off shortcuts, and bend the route into chicanes. They're finite, though — every fence has ends, so look for the way around — and rival AI racers know that too, routing around a barrier toward its open ends." },
                { id: "tile-random", name: "Random Ground", icon: swatch("#7c3aed"), anim: "randomTile",
                  blurb: "A wildcard disguised as another surface.",
                  detail: "A trickster tile. It masquerades as one of the ordinary surfaces, so you won't know whether you're about to hit speedy grass or draggy sand until you're already committed to it." },
                { id: "tile-door", name: "Locked Doors", icon: emoji("🔒"), anim: "lockedDoor",
                  blurb: "A shaped barrier — find its key to open it.",
                  detail: "Some maps seal the way through with a locked door — a dark barrier stamped with a shape (a circle, triangle, diamond…). Somewhere on the map is a key wearing that same shape. Drive over the key to carry it: it orbits your kart like a held ability, and you can still punch and use powers normally. Picking it up pulls the camera back so everyone sees which door it fits. Carry it into that matching door and it swings open for ALL players. Get knocked out or infected while holding a key and you drop it on the ground for anyone to grab — and if the collapse lava reaches a dropped key, it's gone for the round and that door stays shut. The shapes and which key opens which door are shuffled every round." }
            ]
        },
        {
            id: "abilities",
            label: "Abilities",
            entries: [
                { id: "ability-blindfold", name: "Blindfold", icon: svg("low-vision.svg"), anim: "blindfold",
                  blurb: "Blinds the whole room but you.",
                  detail: "Drops a blackout over everyone's view except your own. For a few seconds the entire room is driving blind while you see just fine — pure chaos when you spring it right before the goal." },
                { id: "ability-swap", name: "Swap", icon: svg("random.svg"), anim: "swap",
                  blurb: "Trade places with a nearby racer.",
                  detail: "Marks the ground with a growing ring everyone can see, then trades your position with a racer caught inside it. Steal a leader's safe spot at the last instant, or escape the lava by dumping someone else into it." },
                { id: "ability-bomb", name: "Bomb", icon: svg("bomb.svg"), anim: "bomb",
                  blurb: "Lob an explosive that flings karts.",
                  detail: "Lobs an explosive on a short fuse that flings every kart caught in the blast — including you, if you linger. Where it lands it scorches the ground into draggy sand, clearing a crowd off the goal and gumming up the spot they were fighting for." },
                { id: "ability-speedbuff", name: "Speed Burst", icon: svg("wind-solid.svg"), anim: "speedBurst",
                  blurb: "A burst of extra speed for you.",
                  detail: "A shot of extra pace for a short while. Pop it to run down a leader, outrun the closing lava, or simply blitz a long straightaway before anyone reacts." },
                { id: "ability-speeddebuff", name: "Slowdown", icon: svg("hourglass-start-solid.svg"), anim: "slowdown",
                  blurb: "Bogs down everyone but you.",
                  detail: "Saps the speed of every other racer at once, miring the whole pack in molasses while you carry on at full clip. Drop it as you make your break and watch the field bog down behind you." },
                { id: "ability-tileswap", name: "Tile Swap", icon: svg("copy-regular.svg"), anim: "tileSwap",
                  blurb: "Flips the fast and icy patches.",
                  detail: "After a telegraphed wind-up, the arena's fast lanes and icy patches trade places — the grass you were counting on turns to treacherous ice, and vice versa. Time it to flip a rival's line out from under them." },
                { id: "ability-icecannon", name: "Ice Cannon", icon: svg("snowflake-solid.svg"), anim: "iceCannon",
                  blurb: "Freeze the ground where it lands.",
                  detail: "Fires a frozen shot that turns the patch where it lands into slick ice. Lay a trap on a tight corner and watch chasers skate helplessly off the track." },
                { id: "ability-cut", name: "Cut", icon: svg("scissors-solid.svg"), anim: "cut",
                  blurb: "A short-range swipe that shoves rivals aside.",
                  detail: "A quick, close-range swipe with no wind-up or aiming: it carves a line through the pack and flings nearby racers away from it, throwing those on each side opposite ways. An instant shove to clear bodies off you or fling a clinging rival off course." },
                { id: "ability-starpower", name: "Star Power", icon: svg("star-solid.svg"), anim: "starPower",
                  blurb: "A few seconds of glowing invulnerability.",
                  detail: "Light up in rainbow colours and become untouchable for a few seconds: punches and pucks bounce off, bombs and cuts can't fling you, slowdowns and swaps pass you by, a blindfold can't blind you — and even lava can't burn you, so you can shortcut straight across it. You can still punch everyone else, so plow through the pack. Just watch the flashing: when the glow starts blinking the star is wearing off, and lava stops being a road the instant it does." },
                { id: "ability-orbitalbeam", name: "Orbital Beam", icon: svg("orbital-beam-solid.svg"), anim: "orbitalBeam",
                  blurb: "Call down a strike that melts a line of the track.",
                  detail: "Aim it and fire, and a strike locks onto that line 'from orbit' — the path lights up and pulses faster and redder for a full five seconds so everyone sees it coming. When it lands it melts any ice it crosses into water, scorches sand into lava, and torches any kart still standing in the line like lava itself. (Invulnerable karts, Star Power holders and zombies ride it out.) It doesn't spare you, though — linger in your own beam and it burns you too, so fire it and get clear. Lay a fresh hazard across a chokepoint, or punish a rival who lingers — but they've got five seconds to clear the line, so time it for when they can't." }
            ]
        },
        {
            id: "brutal",
            label: "Brutal Rounds",
            entries: [
                { id: "brutal-what", name: "What Is a Brutal Round?", icon: emoji("🔥"), anim: "brutalIntro",
                  blurb: "Special rounds where the arena turns nasty.",
                  detail: "Now and then a round goes brutal: the arena bends a rule and dares everyone to survive it. The music shifts, an icon flashes up, and the race becomes a fight to last. The closer the match is to ending, the likelier these are — and sometimes several twists stack on one round." },
                { id: "brutal-ability", name: "Ability", icon: svg("toolbox-solid.svg"), anim: "abilityRain",
                  blurb: "Every racer starts holding an ability.",
                  detail: "Every racer starts already holding a random ability, so powers fly from the opening moment instead of having to be hunted down. Bombs, blinds, swaps and freezes go off back to back — an instant free-for-all of effects." },
                { id: "brutal-cloudy", name: "Cloudy", icon: svg("cloud-solid.svg"), anim: "cloudy",
                  blurb: "Drifting clouds hide the track.",
                  detail: "Banks of cloud roll across the arena, blotting out patches of the track as they drift. Hazards and rivals vanish into the fog and reappear without warning — you're racing half-blind through the gaps." },
                { id: "brutal-lightning", name: "Lightning", icon: svg("bolt-solid.svg"), anim: "lightning",
                  blurb: "Every racer is sped up.",
                  detail: "Everyone gets a jolt: every racer is sped up for the whole round and the hazards whip around faster too. The pace turns twitchy and unforgiving, with far less time to read the track before you overshoot it." },
                { id: "brutal-volcano", name: "Volcano", icon: svg("volcano-solid.svg"), anim: "volcano",
                  blurb: "The ground erupts mid-round.",
                  detail: "Partway through, the arena erupts — lava blooms out and floods inward with only a brief warning before it blows. Read the rumble, get clear of where it's about to open, and ride out the eruption to claim the goal." },
                { id: "brutal-infection", name: "Infection", icon: svg("biohazard-solid.svg"), anim: "infection",
                  blurb: "Get tagged and you join the horde.",
                  detail: "One racer starts infected and their touch spreads it — get tagged and you turn too, joining a horde that hunts whoever's left. Infected racers lose their kart entirely and shamble on as green, arms-out zombies, so you can spot the horde at a glance. The last clean racer wins; once infected, there's no winning, so your only job is to drag everyone else down with you." },
                { id: "brutal-hockey", name: "Air Hockey", icon: svg("hockey-puck-solid.svg"), anim: "hockey",
                  blurb: "A puck rockets around, launching karts.",
                  detail: "A giant puck ricochets around the arena, gaining speed with every wall it slams into. Get clipped and you're launched across the map; smack it to redirect it into rivals, but stay clear of its line because it only gets faster." },
                { id: "brutal-explosive", name: "Explosive", icon: svg("explosion-solid.svg"), anim: "explosive",
                  blurb: "Every death blasts a crater of lava.",
                  detail: "Every kart is a walking powder keg. When a racer goes down, the spot swells with a warning and detonates — flinging everyone nearby and scorching the ground into lava. Deaths chain, so a crowded scramble can erupt into a string of blasts that pocks the arena with fire." },
                { id: "brutal-blackout", name: "Blackout", icon: svg("moon-solid.svg"), anim: "blackout",
                  blurb: "The lights go out.",
                  detail: "The arena goes dark and you can only see a small pool of light around your own kart. The goal, the lava and your rivals all lurk in the black until you're nearly on top of them — every move is a gamble into the unknown." },
                { id: "brutal-bunker", name: "Bunker", icon: svg("bunker-door.svg"), anim: "bunker",
                  blurb: "Last one standing claims the buried goal.",
                  detail: "The goal sinks underground behind a silo door, so there's nothing to race to — instead a wall of lava closes in from every edge, herding everyone together. It's a battle royale: outlive the rest and the silo bursts open for you to stroll in and claim the win. Zombies don't count as survivors, so an infected horde can't keep the goal buried — and you can't stall it out either: camp too long and the round simply voids with no winner." },
                { id: "brutal-heatwave", name: "Heatwave", icon: svg("heatwave-solid.svg"), anim: "heatwave",
                  blurb: "The arena scorches over before your eyes.",
                  detail: "As the camera pulls out before the race, a heatwave rolls across the arena: patches of sand bake into lava, ice melts into open water, grass dries out to dirt — and some dirt cracks open around bonus ability pickups, with good odds of an Ice Cannon (the heat scatters its own antidote). Every changed tile keeps a scorched rim so you can read what's new at a glance, and there is always still a path to the goal. Don't settle in: partway through the race a second, smaller wave hits — tiles flicker with what they're about to become, so get off them. Finish without touching a single scorched tile and you've earned the Firewalker medal." },
                { id: "brutal-antlion", name: "Antlions", icon: svg("bug-solid.svg"), anim: "antlion",
                  blurb: "Linger on sand and the swarm comes for you.",
                  detail: "Sand turns predatory: spend more than a couple of seconds on it and an antlion bursts out of a nearby dune and gives chase — and standing your ground just summons more. They'll follow you off the sand, but they're a touch slower than a kart on good terrain and they burrow back underground after a few seconds away from it. They never kill you directly; they shove — and a shove at the wrong moment is what slides you into the lava or off your racing line. You can fight back, though: a solid punch knocks an antlion back into the sand and it burrows away, so a well-timed lunge clears a path through the swarm and a wide swing can scatter a whole cluster at once. They can't cross water either, so a pool or a moat is a wall to them — put water between you and the swarm and they'll prowl the shore while you slip away. Listen for the thumpers: industrial pistons pounding the ground at a steady beat on a few sand patches. Antlions can't stand the pounding, so a thumper's marked ring is sanctuary — every slam hurls them back out while karts roll through untouched. The round skips maps with barely any sand, and you'll never see it during a Heatwave (the heat cooks the habitat)." },
                // --- Parked brutal modes (active:false in config today). Flip show:true when re-enabled. ---
                { id: "brutal-gravity", name: "Gravity", icon: svg("infinity-solid.svg"), anim: "_blank", show: false,
                  blurb: "(disabled) Pull warps your movement.",
                  detail: "Currently disabled. A gravity twist that warps how karts drift across the arena." },
                { id: "brutal-fiesta", name: "Fiesta", icon: svg("cake-candles-solid.svg"), anim: "_blank", show: false,
                  blurb: "(disabled) A party-themed twist.",
                  detail: "Currently disabled. A celebratory chaos round." },
                { id: "brutal-golden", name: "Golden", icon: svg("sack-dollar-solid.svg"), anim: "_blank", show: false,
                  blurb: "(disabled) A high-stakes gold round.",
                  detail: "Currently disabled. A high-value scoring twist." }
            ]
        },
        {
            id: "hazards",
            label: "Hazards",
            entries: [
                { id: "hazard-bumper", name: "Bumper", icon: art("bumper"), anim: "bumper",
                  blurb: "Springy post that flings you back.",
                  detail: "Bump one and you're flung away — maddening in a hurry, but a clever way to launch a chasing rival off their line. They sit still and never hurt you on their own, so the trick is to use them as a weapon: line a rival up and shove them into one." },
                { id: "hazard-movingbumper", name: "Moving Bumper", icon: art("movingBumper"), anim: "movingBumper",
                  blurb: "A bumper that sweeps across the lane.",
                  detail: "A bumper that slides back and forth across the track on a rail, so the safe lane keeps shifting. Time your run for the gap — the opening lingers longest at the ends of its sweep, where it pauses to turn around. Rival AI racers read the same rhythm and dart through right behind it." },
                { id: "hazard-bumperwall", name: "Bumper Wall", icon: art("bumperWall"), anim: "bumperWall",
                  blurb: "A whole pinball wall that kicks you off.",
                  detail: "The same springy sting stretched into a whole pinball-style line. Drive into its face and it kicks you straight back off — great for shrugging karts back onto the racing line or guarding a shortcut. There's no passing through it, only around." },
                { id: "hazard-rotor", name: "Rotor", icon: art("rotor"), anim: "rotor",
                  blurb: "A bumper on a spinning arm.",
                  detail: "A bumper mounted on a spinning arm that sweeps a full circle around its pivot like a clock hand, so the safe moment comes round and round. Dash across the ring between passes; get clipped and you're flung like any bumper." },
                { id: "hazard-geyser", name: "Geyser", icon: art("geyser"), anim: "geyser",
                  blurb: "A vent that erupts and launches you.",
                  detail: "A vent that sits quiet, then bubbles up a warning and erupts, launching anyone standing on or near it. The telegraph is your cue: read the rumble and step off before it blows." },
                { id: "hazard-mine", name: "Proximity Mine", icon: art("mine"), anim: "mine",
                  blurb: "Stray too close and it counts down, then blows.",
                  detail: "A mine waits, armed and silent, until a kart strays too close — then it blinks down a fuse before detonating and flinging whoever's still nearby. There's a moment to scramble clear if you're quick, and springing one as the leader can wreck the racers chasing you." },
                { id: "hazard-antlion", name: "Antlion", icon: svg("bug-solid.svg"), anim: "antlion",
                  blurb: "Linger on sand and it erupts to chase you.",
                  detail: "Spend more than a moment on sand and an antlion bursts from a nearby dune to chase you — standing your ground just summons more. They never kill you directly; they shove, and a shove at the wrong moment slides you into lava or off your line. Punch one and it's knocked back into the sand and burrows away, so a swing clears them off your tail. They're a touch slower than a kart on good ground, they burrow back under after a few seconds off the sand, and they can't cross water — a pool is a wall to them. (Mostly seen in the Antlions brutal round.)" },
                { id: "hazard-thumper", name: "Thumper", icon: art("thumper"), anim: "thumper",
                  blurb: "A pounding piston — sanctuary from antlions.",
                  detail: "An industrial piston that pounds a patch of sand on a steady beat. Antlions can't stand the pounding, so a thumper's marked ring is sanctuary — every slam hurls them back out while karts roll through untouched. When the swarm closes in, make for the nearest thumper." },
                { id: "hazard-vortexwell", name: "Vortex Well", icon: art("vortexWell"), anim: "vortexWell",
                  blurb: "Pulls everything inside its ring inward.",
                  detail: "The opposite of a bumper: it pulls everything inside its ring toward the centre. Carry enough speed and you slingshot right past, but get caught crawling and you're reeled in — which is why you'll often find one parked over lava or just off the fast line. The very centre is calm, though: if you do get pulled in, keep driving to wind up speed in the quiet middle and power back out through the ring." },
                { id: "hazard-lasergate", name: "Laser Gate", icon: art("laserGate"), anim: "laserGate",
                  blurb: "An energy fence that blinks open and shut.",
                  detail: "An energy barrier strung between two pylons that blinks on a steady cycle — open, then a shimmering warning, then solid. While it's solid you can't pass: drive into it and you bounce straight off. It won't kill you, but a gate parked over lava turns that bounce into a problem, so read the rhythm and slip through on the gap." },
                { id: "hazard-crusher", name: "Crusher", icon: art("crusher"), anim: "crusher",
                  blurb: "A sliding slab that flattens you against the wall.",
                  detail: "A heavy slab that slides back and forth across a corridor on a rail, like a Thwomp. Clip it mid-swing and it just shoves you aside, but get caught as it slams home against the wall and it crushes you flat. Time your run for when the slab's pulled back." },
                { id: "hazard-sentryturret", name: "Sentry Turret", icon: art("sentryTurret"), anim: "sentryTurret",
                  blurb: "A gun that tracks you and shoots you off your line.",
                  detail: "A fixed gun emplacement that tracks the nearest racer inside its firing arc, charges with a warning glow, then fires a glowing bolt. The bolt won't freeze or kill you — it bursts on impact and knocks you off your line — but a shove into lava or off a ledge does the rest. The charge-up is your tell: juke across the arc to make the shot fizzle, hide behind a wall (it can't see through one), or land a solid punch to smash it offline for the round — easiest from outside its arc, where it can't shoot back." },
                { id: "hazard-magpiedrone", name: "Magpie Drone", icon: art("magpieDrone"), anim: "magpieDrone",
                  blurb: "Steals the ability you're holding and flies off with it.",
                  detail: "A drone that patrols a rail and snatches the ability you're holding the moment it touches you, then flies off with it bobbing above its head. Punch the drone and it drops the loot onto the ground as a pad anyone can grab, so a stolen power can change hands mid-race. Catch it empty-handed and there's nothing to take, so it just zaps a little of your stamina. Like a moving bumper it rides its rail, so you can time your dash through — but think twice if you're carrying something good." }
            ]
        },
        {
            id: "boons",
            label: "Boons",
            entries: [
                { id: "boon-dasharrows", name: "Dash Arrows", icon: art("dashArrows"), anim: "dashArrows",
                  blurb: "Drive over them for a free speed boost.",
                  detail: "A run of glowing arrows painted on the track. Drive over them in the arrow's direction for a burst of speed — a free launch down a straight or out of a corner. They only push the way they point, so taking them backwards does nothing." },
                { id: "boon-rechargespring", name: "Recharge Spring", icon: art("rechargeSpring"), anim: "rechargeSpring",
                  blurb: "A pit stop that refills your punch stamina.",
                  detail: "A drive-over pit stop that instantly tops your punch-stamina bar back to full and resets your punch cooldown, so you're ready to swing again at once. It's a shared charge: the first racer who needs it and reaches it claims it, then it drains and slowly refills before it can help anyone again — its glow shows when it's ready. Rolling over it with a full bar doesn't waste it." },
                { id: "boon-slipstream", name: "Slipstream", icon: art("slipstream"), anim: "slipstream",
                  blurb: "A wind corridor that carries you along.",
                  detail: "A wind-current corridor that gently carries you along its length while you're inside it, building you up to a steady cruise. The push runs purely along the corridor, so being shoved backwards through it just means the current fights you and carries you forward again. Chain several to build a long tunnel of momentum." },
                { id: "boon-guardhalo", name: "Guard Halo", icon: art("guardHalo"), anim: "guardHalo",
                  blurb: "Pick up a one-hit shield.",
                  detail: "A floating ring you drive over to pick up a one-hit shield. The shield soaks the next hit that comes your way — a punch, a bumper, a bomb, a puck, anything — and then pops, with no knockback. You can only hold one at a time, and the halo is a shared charge: the first unshielded racer to reach it claims the shield, then it re-arms before it can grant another." },
                { id: "boon-secondwindtotem", name: "Checkpoint", icon: art("secondWindTotem"), anim: "secondWindTotem",
                  blurb: "Drive over the flag to respawn there on death.",
                  detail: "A checkpoint flag you drive over to claim. Once it's yours, every death that round respawns you at the checkpoint instead of ending your run — over and over, for as long as the flag survives. The death plays as a beat: you freeze, the camera pans to the flag, and you reappear there with a moment of grace. The flag burns up the instant the collapsing lava reaches it, so it won't save you forever — and in team modes a checkpoint respawn costs your team nothing (only a real death does)." },
                { id: "boon-launchpad", name: "Launch Pad", icon: art("launchPad"), anim: "launchPad",
                  blurb: "Flung on a committed arc, untouchable in the air.",
                  detail: "Drive over it to be flung on a committed arc along the way it faces. While you're airborne you ignore everything — ground, lava, hazards, punches — then you land where the arc ends and normal rules resume. There's no steering mid-flight, so where it's aimed is everything: a pad pointed at lava drops you straight into it, so mind the landing." },
                { id: "boon-barrelcannon", name: "Barrel Cannon", icon: art("barrelCannon"), anim: "barrelCannon",
                  blurb: "Loaded and spun — punch to fire on your aim.",
                  detail: "Drive in to be loaded like a Donkey Kong barrel: the cannon captures you and spins on its own. It's a timing shot — a fuse burns down, and you press punch to launch in whatever direction the barrel's pointing right then, or it auto-fires when the fuse runs out. The launch is a committed airborne arc, untouchable in the air, with the same land-where-it-ends rules as the launch pad." },
                { id: "boon-slingshotrings", name: "Slingshot Rings", icon: art("slingshotRings"), anim: "slingshotRings",
                  blurb: "Thread the centre for a speed pulse; chain to stack it.",
                  detail: "Drive through a ring for a speed pulse along its axis, scaled by how centred your pass was — thread the middle for the full kick, clip the rim and you barely move. Chain consecutive rings quickly and the boost stacks higher with each one, so a line of rings launches you further than any single ring could. Like every axial boost, a backward pass fights it." },
                { id: "boon-warppad", name: "Warp Pad", icon: art("warpPad"), anim: "warpPad",
                  blurb: "Linked portals — keep your speed across the map.",
                  detail: "A glowing portal that comes in linked pairs. Drive onto one and you commit to a warp: the camera sweeps across to the exit and you emerge at the partner pad keeping all your speed and heading — and you're invulnerable while you travel, so nobody can knock you out of it. The trip takes longer the farther apart the pads are. The exit throws you out facing whatever way you came in, so an author can aim a partner right at lava — punch a rival onto a pad whose far end opens over the fire and let the portal finish the job." },
                { id: "boon-zipline", name: "Zipline", icon: art("zipline"), anim: "zipline",
                  blurb: "A slow, untouchable cable crossing.",
                  detail: "A two-post cable you ride for a safe crossing. Drive onto the start post and you're carried along the line toward the far post, untouchable the whole way — you ignore ground, lava, hazards and punches while aloft. It's deliberately slow, a glide rather than a shortcut, and holding the cable drains your stamina: run the bar dry and you're dropped automatically. Punch to drop off early; either way you keep your along-the-line speed when you land." },
                { id: "boon-lilypad", name: "Lily Pads", icon: art("lilyPad"), anim: "lilyPad",
                  blurb: "Stepping-stones over water that sink under you.",
                  detail: "Drivable stepping-stones laid over deep water. While you're on an un-sunk pad you skim across solid ground instead of swimming — but a pad sinks while you stand on it, and a fully-sunk pad drops you into the water below. Step off and it refloats, ready again. Cluster-hop across them to cross deep water, and don't camp a single pad — keep moving. Standing on one also recharges your punch stamina faster, helping you recover the strokes a swim costs." }
            ]
        },
        {
            id: "medals",
            label: "Medals",
            entries: [
                { id: "medal-intro", name: "About Medals", icon: emoji("🏅"), anim: "medalShine",
                  blurb: "Honours handed out when the match ends.",
                  detail: "When the match wraps, the game looks back over everything that happened and hands out medals for how each racer played — who racked up kills, who kept reaching the goal, who couldn't catch a break. They're bragging rights, awarded automatically." },
                { id: "medal-serialkiller", name: "Serial Killer", icon: emoji("🔪"), anim: "medalShine",
                  blurb: "Most kills across the whole match.",
                  detail: "Goes to the racer who knocked out the most rivals over the entire match. The arena's apex predator — more interested in the body count than the finish line." },
                { id: "medal-savior", name: "Savior", icon: emoji("🛡️"), anim: "medalShine",
                  blurb: "Took down a rival on the brink of winning.",
                  detail: "Earned by eliminating someone who was one step from taking the match, snatching victory out of their hands at the last possible second. The crowd loves a spoiler." },
                { id: "medal-survivalist", name: "Survivalist", icon: emoji("🏁"), anim: "medalShine",
                  blurb: "Reached the goal the most times.",
                  detail: "For the racer who crossed into the goal the most often — slippery, relentless, and somehow always still alive when it counts." },
                { id: "medal-brutalist", name: "Brutalist", icon: emoji("🔥"), anim: "medalShine",
                  blurb: "Most finishes during brutal rounds.",
                  detail: "Like Survivalist, but earned the hard way: the most goals reached during brutal rounds, when the arena is throwing everything it has at you and just finishing is an achievement." },
                { id: "medal-pickedon", name: "Picked On", icon: emoji("🎯"), anim: "medalShine",
                  blurb: "Killed the most by a single rival.",
                  detail: "The unlucky one — knocked out more times by the same rival than anyone else. Somebody clearly had a vendetta, and you were it." },
                { id: "medal-resourceful", name: "Resourceful", icon: emoji("🧰"), anim: "medalShine",
                  blurb: "Used the most abilities.",
                  detail: "For the racer who leaned hardest on pickups, always with a trick in their back pocket. Why win a fair fight when you can swap, bomb, or freeze your way through it?" },
                { id: "medal-bully", name: "Bully", icon: emoji("👊"), anim: "medalShine",
                  blurb: "Threw the most punches.",
                  detail: "Awarded for throwing more punches than anyone else — less interested in racing, more interested in shoving. Whether they connected is beside the point." },
                { id: "medal-multikill", name: "Multi-Kills", icon: emoji("💥"), anim: "medalShine",
                  blurb: "Double, Triple and Mega Kills.",
                  detail: "For stacking eliminations in a single breath: take out two in quick succession for a Double Kill, three for a Triple, and four or more for a Mega Kill. The more you fell before the dust settles, the louder the call-out." },
                { id: "medal-zombieslayer", name: "Zombie Slayer", icon: emoji("🧟"), anim: "medalShine",
                  blurb: "Most kills while infected.",
                  detail: "Earned during infection rounds for landing the most bites as a zombie — turning the tables and dragging the most rivals into undeath before the round ends." },
                { id: "medal-heavyhitter", name: "Heavy Hitter", icon: emoji("🥊"), anim: "medalShine",
                  blurb: "Most fully-charged punches.",
                  detail: "For the racer who threw the most fully wound-up punches — holding the charge to the top before letting fly, again and again. Patience rewarded with knockback." },
                { id: "medal-pinball", name: "Pinball", icon: emoji("🔵"), anim: "medalShine",
                  blurb: "Bounced off the most bumpers.",
                  detail: "Awarded to whoever got knocked around by bumpers more than anyone else — ricocheting across the arena like a ball in a pinball machine. Not necessarily on purpose." },
                { id: "medal-iceskater", name: "Ice Skater", icon: emoji("⛸️"), anim: "medalShine",
                  blurb: "Slid the furthest on ice.",
                  detail: "For covering the most distance gliding across ice tiles — embracing the slip instead of fighting it, and racking up the longest total slide of the match." },
                { id: "medal-smoothoperator", name: "Smooth Operator", icon: emoji("🏂"), anim: "medalShine",
                  blurb: "Drifted the furthest on ice.",
                  detail: "For the most distance covered DRIFTING — holding a punch charge while on ice to dig in for grip. Only clean drifts count: if the charged punch lands on someone the run was a wind-up (not a drift), and burning up in lava wipes it. Control, not aggression." },
                { id: "medal-firewalker", name: "Firewalker", icon: emoji("👣"), anim: "medalShine",
                  blurb: "Finished a Heatwave round on clean ground.",
                  detail: "Earned by finishing Heatwave rounds without ever touching scorched ground — none of the fresh lava's neighbours-turned-hazards, the melted water, the dried-out dirt, not even the heat-spawned ability pads. The arena changed and you refused to acknowledge it. Goes to whoever pulled it off the most times in the match." }
            ]
        }
    ];

    // ------------------------------------------------------------------------
    // Rendering + filtering. Cards are shown/hidden in place (display:none) so
    // focus and the menuGamepad cursor stay stable and off-screen canvases stop
    // animating (the IntersectionObserver in learnScenes.js handles that).
    // ------------------------------------------------------------------------
    var groupsEl, searchInput, filtersEl, emptyEl;
    var allRecords = [];     // [{ entry, card, catId, groupEl }]
    var groupEls = {};       // catId -> group wrapper element
    var activeCat = "all";
    var query = "";

    function paragraphs(detail) { return Array.isArray(detail) ? detail : [detail]; }

    function buildIcon(icon) {
        var wrap = document.createElement("span");
        wrap.className = "codex-icon";
        if (!icon) { return wrap; }
        if (icon.kind === "emoji") {
            wrap.classList.add("codex-icon--emoji");
            wrap.textContent = icon.glyph;
        } else if (icon.kind === "swatch") {
            wrap.classList.add("codex-icon--swatch");
            wrap.style.background = icon.color;
        } else if (icon.kind === "texture") {
            wrap.classList.add("codex-icon--texture");
            var t = document.createElement("img");
            t.src = icon.src; t.alt = ""; t.setAttribute("aria-hidden", "true");
            wrap.appendChild(t);
        } else if (icon.kind === "art") {
            // Procedural in-game art (e.g. the bumper disc + ring) drawn to a
            // tiny canvas so the list icon matches what's rendered in-game.
            wrap.classList.add("codex-icon--art");
            var cv = document.createElement("canvas");
            cv.setAttribute("aria-hidden", "true");
            wrap.appendChild(cv);
            if (typeof LearnAnim !== "undefined" && LearnAnim.staticIcon) { LearnAnim.staticIcon(cv, icon.art); }
        } else { // "svg" — black silhouette, needs the light chip to stay visible
            wrap.classList.add("codex-icon--svg");
            var s = document.createElement("img");
            s.src = icon.src; s.alt = ""; s.setAttribute("aria-hidden", "true");
            wrap.appendChild(s);
        }
        return wrap;
    }

    function buildCard(entry) {
        var card = document.createElement("article");
        card.className = "codex-card";
        card.id = "card-" + entry.id;
        card.setAttribute("data-entry-id", entry.id);
        card.setAttribute("data-gp-nav", "");        // pad can scroll through cards
        card.setAttribute("tabindex", "-1");

        var canvas = document.createElement("canvas");
        canvas.className = "codex-card-anim";
        canvas.setAttribute("aria-hidden", "true");
        card.appendChild(canvas);

        var body = document.createElement("div");
        body.className = "codex-card-body";

        var head = document.createElement("div");
        head.className = "codex-card-head";
        head.appendChild(buildIcon(entry.icon));
        var h = document.createElement("h3");
        h.textContent = entry.name;
        head.appendChild(h);
        body.appendChild(head);

        paragraphs(entry.detail).forEach(function (text) {
            var p = document.createElement("p");
            p.textContent = text;
            body.appendChild(p);
        });
        card.appendChild(body);

        // Clicking a card anchors it (shareable deep-link) without a modal.
        card.addEventListener("click", function () {
            try { history.replaceState(null, "", "#" + entry.id); } catch (e) { /* ignore */ }
        });

        // Wire the live animation (only runs while on-screen; see learnScenes.js).
        if (typeof LearnAnim !== "undefined" && LearnAnim.attach) {
            LearnAnim.attach(canvas, entry.anim, { glyph: entry.icon && entry.icon.glyph });
        }
        return card;
    }

    function buildFilters() {
        if (!filtersEl) { return; }
        var cats = [{ id: "all", label: "All" }];
        CODEX.forEach(function (g) { cats.push({ id: g.id, label: g.label }); });
        cats.forEach(function (c) {
            var chip = document.createElement("button");
            chip.type = "button";
            chip.className = "learn-chip" + (c.id === activeCat ? " is-active" : "");
            chip.setAttribute("data-gp-nav", "");
            chip.setAttribute("data-cat", c.id);
            chip.setAttribute("aria-pressed", c.id === activeCat ? "true" : "false");
            chip.textContent = c.label;
            chip.addEventListener("click", function () {
                activeCat = c.id;
                var chips = filtersEl.querySelectorAll(".learn-chip");
                for (var i = 0; i < chips.length; i++) {
                    var on = chips[i] === chip;
                    chips[i].classList.toggle("is-active", on);
                    chips[i].setAttribute("aria-pressed", on ? "true" : "false");
                }
                applyFilter();
            });
            filtersEl.appendChild(chip);
        });
    }

    function matchesQuery(entry) {
        if (!query) { return true; }
        var hay = (entry.name + " " + entry.blurb + " " + paragraphs(entry.detail).join(" ")).toLowerCase();
        return hay.indexOf(query) !== -1;
    }

    function applyFilter() {
        var anyVisible = false;
        var visibleByCat = {};
        allRecords.forEach(function (r) {
            var vis = (activeCat === "all" || r.catId === activeCat) && matchesQuery(r.entry);
            r.card.classList.toggle("is-hidden", !vis);
            if (vis) { anyVisible = true; visibleByCat[r.catId] = true; }
        });
        Object.keys(groupEls).forEach(function (catId) {
            groupEls[catId].classList.toggle("is-hidden", !visibleByCat[catId]);
        });
        if (emptyEl) { emptyEl.classList.toggle("is-hidden", anyVisible); }
    }

    function build() {
        groupsEl = document.getElementById("codexGroups");
        searchInput = document.getElementById("learnSearch");
        filtersEl = document.getElementById("learnFilters");
        if (!groupsEl) { return; }

        CODEX.forEach(function (group) {
            var groupEl = document.createElement("div");
            groupEl.className = "codex-group";
            groupEl.setAttribute("data-cat", group.id);

            var title = document.createElement("h2");
            title.className = "codex-group-title";
            title.textContent = group.label;
            groupEl.appendChild(title);

            var grid = document.createElement("div");
            grid.className = "codex-grid";
            group.entries.forEach(function (entry) {
                if (entry.show === false) { return; }
                var card = buildCard(entry);
                grid.appendChild(card);
                allRecords.push({ entry: entry, card: card, catId: group.id, groupEl: groupEl });
            });
            groupEl.appendChild(grid);
            groupsEl.appendChild(groupEl);
            groupEls[group.id] = groupEl;
        });

        emptyEl = document.createElement("p");
        emptyEl.className = "learn-empty is-hidden";
        emptyEl.textContent = "No matches — try a different search or category.";
        groupsEl.appendChild(emptyEl);

        buildFilters();
        if (searchInput) {
            searchInput.addEventListener("input", function () {
                query = (searchInput.value || "").trim().toLowerCase();
                applyFilter();
            });
        }

        // Deep-link: if the URL has #entry-id, scroll that card into view + flash.
        focusHashCard();
        window.addEventListener("hashchange", focusHashCard);
    }

    function focusHashCard() {
        var id = (location.hash || "").replace(/^#/, "");
        if (!id) { return; }
        var el = document.getElementById("card-" + id);
        if (!el) { return; }
        // If an active filter/search is hiding the target, clear it so the
        // deep-link actually lands (scrollIntoView no-ops on a display:none card).
        if (el.classList.contains("is-hidden")) { resetFilters(); }
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("is-anchored");
        setTimeout(function () { el.classList.remove("is-anchored"); }, 1600);
    }

    function resetFilters() {
        activeCat = "all";
        query = "";
        if (searchInput) { searchInput.value = ""; }
        if (filtersEl) {
            var chips = filtersEl.querySelectorAll(".learn-chip");
            for (var i = 0; i < chips.length; i++) {
                var on = chips[i].getAttribute("data-cat") === "all";
                chips[i].classList.toggle("is-active", on);
                chips[i].setAttribute("aria-pressed", on ? "true" : "false");
            }
        }
        applyFilter();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", build);
    } else {
        build();
    }
})();
