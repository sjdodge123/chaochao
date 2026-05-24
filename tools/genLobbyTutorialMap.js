/*
 * genLobbyTutorialMap.js
 *
 * Generates the lobby tutorial "islands" map (see docs/lobby-tutorial-analysis.md).
 *
 * Produces a full-coverage Voronoi field where most cells are the transparent
 * `background` terrain type (id 9) and a few larger clustered regions are
 * "biome" islands. Each biome blends several terrain types via coherent value
 * noise — a dominant type at the core with natural fringes of related types —
 * so islands read as organic landmasses rather than flat single-type blobs.
 * The goal and bomb tiles are kept pure (single type) for teaching clarity.
 *
 * A sprawling spider-like web of grass (fast) paths wires the islands together
 * (radial spokes from a cleared central disc + outer connecting strands), with
 * ice patches sprinkled along it for fun drifts and a few lava patches for
 * danger (kept away from the spawn side). Classify order keeps the spawn pad,
 * pure tiles, and biomes clean — patches/paths only fill the open ground.
 *
 * The game renders `background` cells as nothing (showing the plain lobby
 * behind) and treats them as neutral/normal ground — see the renderer skip in
 * draw.js and the handleHit branch in game.js.
 *
 * Deterministic: fixed seed -> identical map every run.
 *
 * Usage:  node tools/genLobbyTutorialMap.js
 * Output: client/maps/_lobbyTutorial.json
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const ROOT = path.join(__dirname, "..");

// --- terrain ids (mirror server/config.json tileMap) ---
const ID = {
	slow: 0,
	normal: 1,
	fast: 2,
	lava: 3,
	ice: 4,
	goal: 6,
	background: 9,
	bomb: 102,
	speedBuff: 104,
	speedDebuff: 105,
	iceCannon: 107,
	cut: 108,
};

// --- world bounds (config.json worldWidth/worldHeight) ---
const W = 1366;
const H = 768;
const bbox = { xl: 0, xr: W, yt: 0, yb: H };

// --- biome islands: larger, blended landmasses (dominant type + fringes) ---
// palette weights sum ~1; the dominant type owns the core, secondaries blend in
// toward the edges where the noise value runs higher.
const BIOMES = [
	// Near the spawn pad (left): safe-to-learn biomes, no lava.
	{
		name: "meadow",
		cx: 360, cy: 220, r: 128,
		palette: [[ID.fast, 0.58], [ID.normal, 0.27], [ID.ice, 0.15]],
	},
	{
		name: "dunes",
		cx: 360, cy: 548, r: 128,
		palette: [[ID.slow, 0.58], [ID.normal, 0.27], [ID.fast, 0.15]],
	},
	// Goal side (right): ice, and the lava danger guarding the goals — kept well
	// away from the spawn pad on the opposite side of the map.
	{
		name: "glacier",
		cx: 950, cy: 215, r: 122,
		palette: [[ID.ice, 0.58], [ID.fast, 0.27], [ID.normal, 0.15]],
	},
	{
		name: "volcano",
		cx: 950, cy: 553, r: 122,
		palette: [[ID.lava, 0.6], [ID.slow, 0.26], [ID.fast, 0.14]],
	},
];

// --- pure (single-type) islands: kept un-blended for teaching clarity ---
const PURE = [
	{ id: ID.bomb, cx: 683, cy: 150, r: 55 }, // ability tile (aim/fire)
	{ id: ID.bomb, cx: 683, cy: 620, r: 55 }, // ability tile
	// Corner ability pickups on the outskirts — the curated "safe" set (decision 5),
	// one per corner so players discover variety. swap/blindfold/tileSwap stay out.
	{ id: ID.speedBuff, cx: 200, cy: 145, r: 40 }, // top-left
	{ id: ID.iceCannon, cx: 1175, cy: 145, r: 40 }, // top-right
	{ id: ID.cut, cx: 200, cy: 623, r: 40 }, // bottom-left
	{ id: ID.speedDebuff, cx: 1175, cy: 623, r: 40 }, // bottom-right
];

// Two single goal tiles, each its own distinct little island on the goal side
// (far right). Placed as the lone nearest cell to each point (see main()).
const GOAL_POINTS = [
	{ x: 1235, y: 235 },
	{ x: 1235, y: 535 },
];

// --- hazards (config.hazards): {id,x,y,angle}; placed in open background ---
const HAZARD = { bumper: 900, movingBumper: 901 };
const HAZARDS = [
	// static bumper in the central crossing lane between spawn and the goal side
	{ id: HAZARD.bumper, x: 540, y: 384, angle: 0 },
	// moving bumper sweeping vertically in front of the goals (angle = rail dir)
	{ id: HAZARD.movingBumper, x: 1090, y: 384, angle: 90 },
];

// Background spawn pad (just neutral background; recorded for spawn/respawn).
const SPAWN_PAD = { cx: 175, cy: 384, r: 75 };

// --- grass web: sprawling spider-like grass (fast) paths connecting the islands ---
// Radial spokes emanate from a cleared central disc (the start button stays clear of
// grass) out to each island/goal, plus outer strands wire the islands together into a
// web. Cells within PATH_HALF of any strand (and outside the center disc) become grass.
const CENTER_CLEAR = { cx: 683, cy: 384, r: 92 }; // keep the start-button disc grass-free
const PATH_HALF = 34;
const HUBS = {
	center: { x: 683, y: 384 },
	spawn: { x: 255, y: 384 }, // just off the spawn pad (the pad itself stays clean bg)
	meadow: { x: 360, y: 220 },
	dunes: { x: 360, y: 548 },
	bombTop: { x: 683, y: 150 },
	bombBot: { x: 683, y: 620 },
	glacier: { x: 950, y: 215 },
	volcano: { x: 950, y: 553 },
	goalTop: { x: 1235, y: 235 },
	goalBot: { x: 1235, y: 535 },
};
const SEGMENTS = [
	// radial spokes from the (cleared) center out to every island
	["center", "spawn"], ["center", "meadow"], ["center", "dunes"],
	["center", "bombTop"], ["center", "bombBot"],
	["center", "glacier"], ["center", "volcano"],
	["center", "goalTop"], ["center", "goalBot"],
	// outer connecting strands — the web rings
	["spawn", "meadow"], ["spawn", "dunes"],
	["meadow", "bombTop"], ["bombTop", "glacier"], ["glacier", "goalTop"],
	["dunes", "bombBot"], ["bombBot", "volcano"], ["volcano", "goalBot"],
	["meadow", "dunes"], ["glacier", "volcano"], ["goalTop", "goalBot"],
];

// --- sprinkled patches: ice for fun drifts, lava for danger ---
// Checked before the grass web, so they interrupt the corridors (drift/dodge spots).
// They never override the spawn pad, the pure (goal/bomb) tiles, or the biomes
// (those are classified first), so islands stay clean and the spawn stays safe.
// Lava is deliberately kept to x > 700 so the spawn side never has danger underfoot.
const PATCH_ICE = [
	{ cx: 520, cy: 300, r: 42 },
	{ cx: 520, cy: 470, r: 42 },
	{ cx: 815, cy: 262, r: 36 },
	{ cx: 815, cy: 506, r: 36 },
	{ cx: 470, cy: 384, r: 34 },
];
const PATCH_LAVA = [
	{ cx: 770, cy: 320, r: 30 },
	{ cx: 770, cy: 448, r: 30 },
	{ cx: 1035, cy: 384, r: 30 },
];

// --- deterministic RNG (mulberry32) ---
function mulberry32(a) {
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		var t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const rand = mulberry32(0x10bb1);

// --- coherent value noise (seeded), used to blend biome terrain naturally ---
function makeNoise(seed) {
	function hash(ix, iy) {
		var n = (ix * 374761393 + iy * 668265263 + seed * 2654435761) | 0;
		n = Math.imul(n ^ (n >>> 13), 1274126177);
		return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
	}
	function smooth(t) { return t * t * (3 - 2 * t); }
	function lerp(a, b, t) { return a + (b - a) * t; }
	function n2(x, y) {
		var x0 = Math.floor(x), y0 = Math.floor(y);
		var tx = smooth(x - x0), ty = smooth(y - y0);
		return lerp(
			lerp(hash(x0, y0), hash(x0 + 1, y0), tx),
			lerp(hash(x0, y0 + 1), hash(x0 + 1, y0 + 1), tx),
			ty
		);
	}
	// two octaves for a little richness
	return function (x, y) {
		const f = 0.018;
		return n2(x * f, y * f) * 0.66 + n2(x * f * 2.3 + 100, y * f * 2.3 + 100) * 0.34;
	};
}
const noise = makeNoise(0x5eed);

function dist(x, y, c) {
	const dx = x - c.cx, dy = y - c.cy;
	return Math.sqrt(dx * dx + dy * dy);
}

// Shortest distance from point (px,py) to the segment a->b.
function distToSegment(px, py, ax, ay, bx, by) {
	const vx = bx - ax, vy = by - ay;
	const wx = px - ax, wy = py - ay;
	const len2 = vx * vx + vy * vy;
	let t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
	t = Math.max(0, Math.min(1, t));
	const cx = ax + t * vx, cy = ay + t * vy;
	const dx = px - cx, dy = py - cy;
	return Math.sqrt(dx * dx + dy * dy);
}

// True if (x,y) sits on a grass strand — within PATH_HALF of any web segment, but
// outside the cleared central disc (so the start button stays grass-free).
function onGrassPath(x, y) {
	if (dist(x, y, CENTER_CLEAR) <= CENTER_CLEAR.r) return false;
	for (const [aKey, bKey] of SEGMENTS) {
		const a = HUBS[aKey], b = HUBS[bKey];
		if (distToSegment(x, y, a.x, a.y, b.x, b.y) <= PATH_HALF) return true;
	}
	return false;
}

function pickFromPalette(palette, val) {
	let acc = 0;
	for (const [id, w] of palette) {
		acc += w;
		if (val <= acc) return id;
	}
	return palette[palette.length - 1][0];
}

function classify(x, y) {
	// Spawn pad stays clean background (always safe).
	if (dist(x, y, SPAWN_PAD) <= SPAWN_PAD.r) return ID.background;
	// Pure islands (goal, bomb) win first and are never blended.
	for (const p of PURE) {
		if (dist(x, y, p) <= p.r) return p.id;
	}
	// Biome islands next, so they stay recognizable and the sprinkled patches /
	// grass web below never carve into them. Blend the palette by noise, biased
	// toward the dominant type near the core.
	for (const b of BIOMES) {
		const d = dist(x, y, b);
		if (d <= b.r) {
			const dn = d / b.r; // 0 center .. 1 edge
			const val = noise(x, y) * 0.68 + dn * 0.32; // edges -> higher -> secondaries
			return pickFromPalette(b.palette, val);
		}
	}
	// Sprinkled patches interrupt the open ground / grass web (checked before the
	// paths so they punch through the corridors): ice for drifts, lava for danger.
	for (const p of PATCH_ICE) {
		if (dist(x, y, p) <= p.r) return ID.ice;
	}
	for (const p of PATCH_LAVA) {
		if (dist(x, y, p) <= p.r) return ID.lava;
	}
	// Grass web: sprawling spider-like paths wiring the islands together.
	if (onGrassPath(x, y)) return ID.fast;
	return ID.background;
}

// --- load the repo's Voronoi library in a vm sandbox ---
function loadVoronoi() {
	const code = fs.readFileSync(
		path.join(ROOT, "client/scripts/rhill-voronoi-core.js"),
		"utf8"
	);
	const ctx = {};
	vm.createContext(ctx);
	vm.runInContext(code + "\nthis.Voronoi = Voronoi;", ctx);
	return new ctx.Voronoi();
}

function main() {
	const voronoi = loadVoronoi();

	// Denser site field than the editor default for smoother islands / blends.
	const SITES = 470;
	const margin = 0.05;
	const xo = W * margin, dx = W - xo * 2;
	const yo = H * margin, dy = H - yo * 2;

	const sites = [];
	for (let i = 0; i < SITES; i++) {
		sites.push({
			x: Math.round((xo + rand() * dx) * 10) / 10,
			y: Math.round((yo + rand() * dy) * 10) / 10,
		});
	}

	const diagram = voronoi.compute(sites, bbox);

	const counts = {};
	for (const cell of diagram.cells) {
		const id = classify(cell.site.x, cell.site.y);
		cell.id = id;
		counts[id] = (counts[id] || 0) + 1;
	}

	// Exactly two goal tiles, one per distinct island: tag the single nearest
	// cell to each goal point (each becomes a lone 1-tile island on background).
	for (const g of GOAL_POINTS) {
		let best = null, bestD = Infinity;
		for (const cell of diagram.cells) {
			const dx = cell.site.x - g.x, dy = cell.site.y - g.y;
			const dd = dx * dx + dy * dy;
			if (dd < bestD) { bestD = dd; best = cell; }
		}
		if (best) {
			counts[best.id]--;
			best.id = ID.goal;
			counts[ID.goal] = (counts[ID.goal] || 0) + 1;
		}
	}

	diagram.id = "lobbyTutorialIslandsV1";
	diagram.name = "LobbyTutorial";
	diagram.author = "system";
	diagram.email = "";
	diagram.thumbnail = "";
	diagram.hazards = HAZARDS;
	diagram.lobbyOnly = true;
	diagram.spawnPad = SPAWN_PAD;

	const outPath = path.join(ROOT, "client/maps/_lobbyTutorial.json");
	fs.writeFileSync(outPath, JSON.stringify(diagram));

	const names = { 0: "slow", 1: "normal", 2: "fast", 3: "lava", 4: "ice", 6: "goal", 9: "background", 102: "bomb", 104: "speedBuff", 105: "speedDebuff", 107: "iceCannon", 108: "cut" };
	console.log("wrote", path.relative(ROOT, outPath));
	console.log("cells:", diagram.cells.length, "edges:", diagram.edges.length, "vertices:", diagram.vertices.length);
	console.log("hazards:", diagram.hazards.length, "(" + diagram.hazards.map((h) => (h.id === HAZARD.bumper ? "bumper" : "movingBumper")).join(", ") + ")");
	console.log("cell ids:");
	Object.keys(counts)
		.sort((a, b) => a - b)
		.forEach((k) => console.log("  " + (names[k] || k) + " (" + k + "): " + counts[k]));
}

main();
