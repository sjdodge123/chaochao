/*
 * genLobbyTutorialMap.js
 *
 * Generates the lobby tutorial "islands" map (see docs/lobby-tutorial-analysis.md).
 *
 * Produces a full-coverage Voronoi field where most cells are the transparent
 * `background` terrain type (id 9) and a few clustered regions are tagged as
 * interactive islands (lava, ice, slow, fast, goal, bomb). The game renders
 * `background` cells as nothing (showing the plain lobby behind) and treats them
 * as neutral/normal ground — see the renderer skip in draw.js and the handleHit
 * branch in game.js.
 *
 * Deterministic: uses a fixed seed so re-running yields the identical map.
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

// --- island layout (all kept clear of the center start button @ (683,384) r75) ---
// Each island = a circle; a cell is tagged if its SITE falls inside the circle.
const ISLANDS = [
	{ id: ID.lava, cx: 380, cy: 200, r: 95 }, // top-left: the danger
	{ id: ID.ice, cx: 986, cy: 200, r: 95 }, // top-right: slippery
	{ id: ID.slow, cx: 380, cy: 568, r: 95 }, // bottom-left: sticky/sand
	{ id: ID.fast, cx: 986, cy: 568, r: 95 }, // bottom-right: speed
	{ id: ID.goal, cx: 1210, cy: 384, r: 80 }, // right-center: the objective (yellow)
	{ id: ID.bomb, cx: 683, cy: 130, r: 46 }, // top-center: ability (aim/fire)
	{ id: ID.bomb, cx: 683, cy: 638, r: 46 }, // bottom-center: ability
];

// Background spawn pad (just neutral background; recorded for spawn/respawn logic).
const SPAWN_PAD = { cx: 175, cy: 384, r: 70 };

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

function inCircle(x, y, c) {
	const dx = x - c.cx;
	const dy = y - c.cy;
	return dx * dx + dy * dy <= c.r * c.r;
}

function classify(x, y) {
	// Keep the spawn pad as clean background (skip island tagging there).
	if (inCircle(x, y, SPAWN_PAD)) return ID.background;
	for (const isl of ISLANDS) {
		if (inCircle(x, y, isl)) return isl.id;
	}
	return ID.background;
}

function main() {
	const voronoi = loadVoronoi();

	// Site placement: jittered, with the editor's 7% margin so cells near the
	// border stay well-formed. Denser than the editor default (320 vs 250) for
	// smoother island edges.
	const SITES = 320;
	const margin = 0.07;
	const xo = W * margin,
		dx = W - xo * 2;
	const yo = H * margin,
		dy = H - yo * 2;

	const sites = [];
	for (let i = 0; i < SITES; i++) {
		sites.push({
			x: Math.round((xo + rand() * dx) * 10) / 10,
			y: Math.round((yo + rand() * dy) * 10) / 10,
		});
	}

	const diagram = voronoi.compute(sites, bbox);

	// Tag every cell by the region its site lands in.
	const counts = {};
	for (const cell of diagram.cells) {
		const id = classify(cell.site.x, cell.site.y);
		cell.id = id;
		counts[id] = (counts[id] || 0) + 1;
	}

	// Metadata (matches the editor's saved-map shape).
	diagram.id = "lobbyTutorialIslandsV1";
	diagram.name = "LobbyTutorial";
	diagram.author = "system";
	diagram.email = "";
	diagram.thumbnail = ""; // excluded from map-select; no thumb needed
	diagram.hazards = []; // bumpers deferred for v1
	diagram.lobbyOnly = true; // determineNextMap() must skip this (no race rotation)
	diagram.spawnPad = SPAWN_PAD; // safe spawn/respawn region (background = sanctuary)

	const outPath = path.join(ROOT, "client/maps/_lobbyTutorial.json");
	fs.writeFileSync(outPath, JSON.stringify(diagram));

	// Summary
	const names = { 0: "slow", 1: "normal", 2: "fast", 3: "lava", 4: "ice", 6: "goal", 9: "background", 102: "bomb" };
	console.log("wrote", path.relative(ROOT, outPath));
	console.log("cells:", diagram.cells.length, "edges:", diagram.edges.length, "vertices:", diagram.vertices.length);
	console.log("cell ids:");
	Object.keys(counts)
		.sort((a, b) => a - b)
		.forEach((k) => console.log("  " + (names[k] || k) + " (" + k + "): " + counts[k]));
}

main();
