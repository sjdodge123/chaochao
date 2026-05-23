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
};

// --- world bounds (config.json worldWidth/worldHeight) ---
const W = 1366;
const H = 768;
const bbox = { xl: 0, xr: W, yt: 0, yb: H };

// --- biome islands: larger, blended landmasses (dominant type + fringes) ---
// palette weights sum ~1; the dominant type owns the core, secondaries blend in
// toward the edges where the noise value runs higher.
const BIOMES = [
	{
		name: "volcano",
		cx: 340, cy: 240, r: 130,
		palette: [[ID.lava, 0.58], [ID.slow, 0.27], [ID.fast, 0.15]],
	},
	{
		name: "glacier",
		cx: 1030, cy: 240, r: 130,
		palette: [[ID.ice, 0.58], [ID.fast, 0.27], [ID.normal, 0.15]],
	},
	{
		name: "dunes",
		cx: 340, cy: 540, r: 130,
		palette: [[ID.slow, 0.58], [ID.normal, 0.27], [ID.fast, 0.15]],
	},
	{
		name: "meadow",
		cx: 1030, cy: 540, r: 130,
		palette: [[ID.fast, 0.58], [ID.normal, 0.27], [ID.ice, 0.15]],
	},
];

// --- pure (single-type) islands: kept un-blended for teaching clarity ---
const PURE = [
	{ id: ID.goal, cx: 1230, cy: 384, r: 90 }, // the objective (yellow)
	{ id: ID.bomb, cx: 683, cy: 150, r: 55 }, // ability tile (aim/fire)
	{ id: ID.bomb, cx: 683, cy: 620, r: 55 }, // ability tile
];

// Background spawn pad (just neutral background; recorded for spawn/respawn).
const SPAWN_PAD = { cx: 175, cy: 384, r: 75 };

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

function pickFromPalette(palette, val) {
	let acc = 0;
	for (const [id, w] of palette) {
		acc += w;
		if (val <= acc) return id;
	}
	return palette[palette.length - 1][0];
}

function classify(x, y) {
	// Spawn pad stays clean background.
	if (dist(x, y, SPAWN_PAD) <= SPAWN_PAD.r) return ID.background;
	// Pure islands (goal, bomb) win first and are never blended.
	for (const p of PURE) {
		if (dist(x, y, p) <= p.r) return p.id;
	}
	// Biome islands: blend the palette by noise, biased toward the dominant
	// type near the core so each biome stays recognizable.
	for (const b of BIOMES) {
		const d = dist(x, y, b);
		if (d <= b.r) {
			const dn = d / b.r; // 0 center .. 1 edge
			const val = noise(x, y) * 0.68 + dn * 0.32; // edges -> higher -> secondaries
			return pickFromPalette(b.palette, val);
		}
	}
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

	diagram.id = "lobbyTutorialIslandsV1";
	diagram.name = "LobbyTutorial";
	diagram.author = "system";
	diagram.email = "";
	diagram.thumbnail = "";
	diagram.hazards = [];
	diagram.lobbyOnly = true;
	diagram.spawnPad = SPAWN_PAD;

	const outPath = path.join(ROOT, "client/maps/_lobbyTutorial.json");
	fs.writeFileSync(outPath, JSON.stringify(diagram));

	const names = { 0: "slow", 1: "normal", 2: "fast", 3: "lava", 4: "ice", 6: "goal", 9: "background", 102: "bomb" };
	console.log("wrote", path.relative(ROOT, outPath));
	console.log("cells:", diagram.cells.length, "edges:", diagram.edges.length, "vertices:", diagram.vertices.length);
	console.log("cell ids:");
	Object.keys(counts)
		.sort((a, b) => a - b)
		.forEach((k) => console.log("  " + (names[k] || k) + " (" + k + "): " + counts[k]));
}

main();
