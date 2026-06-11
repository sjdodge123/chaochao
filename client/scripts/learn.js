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
//     + facing-based clashes. Reconcile here if player.js / config punch* changes.
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
                    id: "collapse", name: "The Collapse", icon: tex("lava.png"), anim: "collapse",
                    blurb: "The floor turns to lava and squeezes everyone inward.",
                    detail: "Once the front-runners are home, the arena turns to lava from the edges inward, shrinking the safe ground and herding everyone toward the middle. It's the round's clock — but when one racer is left, the lava eases up to give them a fair shot at the goal."
                },
                {
                    id: "punching", name: "Punching", icon: emoji("👊"), anim: "punch",
                    blurb: "Timing and positioning, not mashing.",
                    detail: "Punching is about commitment, not how fast you tap. A swing pops out around your kart and shoves anyone touching it — no aim, just position — and lands as hard as the speed you carry into the hit, which a glowing halo previews. Hold the button to wind up a heavier, telegraphed haymaker, but overcharge and it fizzles, leaving you winded. Every swing drains a stamina ring, so mashing runs you dry, and punches clash: charge into a rival who's swinging back and an even match sends both flying, while a clearly stronger punch bowls straight through a weak one."
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
                  detail: "Deep water barely lets you drift on your own — to really move, PUNCH to swim: each stroke shoves you the way you're steering. It's slow going and strokes spend stamina, so only dive in when the shortcut genuinely pays. Climbing out leaves you dripping wet and sluggish for a moment, water snuffs out a burning kart with a hiss, and where water meets lava the edge hardens into stone you can't cross. In infection rounds zombies can't swim at all, so water is a true escape from the horde." },
                { id: "tile-lava", name: "Lava", icon: tex("lava.png"), anim: "lavaBurn",
                  blurb: "Touch it and you burn out of the round.",
                  detail: "A fiery dunk and you're done — burned out and respawned, out of the round. The collapse turns the whole arena into this, and a well-aimed punch can post a rival straight into it." },
                { id: "tile-goal", name: "Goal", icon: swatch("#FFCB30"), anim: "goalRun",
                  blurb: "Reach it to bank a notch.",
                  detail: "The finish zone, glowing gold. Reaching it banks you a notch toward the match win. It's the one tile everyone is racing toward, every single round." },
                { id: "tile-ability", name: "Ability Pad", icon: swatch("#C8C8C8"), anim: "pickup",
                  blurb: "Grab a random single-use power.",
                  detail: "A pickup pad. Roll across it to grab a random single-use power. It goes dormant briefly after someone claims it, then lights back up for the next racer." },
                { id: "tile-bumper", name: "Bumpers", icon: art("bumper"), anim: "bumper",
                  blurb: "Springy obstacles that fling you back.",
                  detail: "Bump one and you're flung away — maddening in a hurry, but a clever way to launch a chasing rival off their line. Some maps add moving bumpers that sweep across the track, so the safe lane keeps shifting." },
                { id: "tile-random", name: "Random Ground", icon: swatch("#7c3aed"), anim: "randomTile",
                  blurb: "A wildcard disguised as another surface.",
                  detail: "A trickster tile. It masquerades as one of the ordinary surfaces, so you won't know whether you're about to hit speedy grass or draggy sand until you're already committed to it." }
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
                  detail: "One racer starts infected and their touch spreads it — get tagged and you turn too, joining a horde that hunts whoever's left. The last clean racer wins; once infected, there's no winning, so your only job is to drag everyone else down with you." },
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
