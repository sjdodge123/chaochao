var lastFrame = new Date();
var fs = require('fs');
const { map } = require('jquery');
var maps = [];
var mapListing = [];
var editorMapListing = []; // mapListing minus lobbyOnly maps (the editor's list)
var soundListing = [];
var imgListing = [];

var c = require('./config.json');
var cellGraph = require('./cellGraph.js');
var mapFormat = require('./mapFormat.js');
c.port = process.env.PORT || c.port;

// Test-only config override seam (CI perf harness). When CHAO_PERF_OVERRIDE is a
// JSON object, deep-merge it over the loaded config so a separate-process server
// can boot into a deterministic worst-case load scenario (e.g. forced grid size +
// brutal round) WITHOUT editing config.json. No effect in normal runs — nothing
// sets this env var outside the perf test.
// Never apply in production — even if the var somehow leaks into a prod env, the
// live game keeps its committed config.
if (process.env.CHAO_PERF_OVERRIDE && process.env.NODE_ENV !== 'production') {
    try {
        var __override = JSON.parse(process.env.CHAO_PERF_OVERRIDE);
        (function deepMerge(dst, src) {
            for (var k in src) {
                // Own keys only, and never prototype keys — guards against
                // prototype pollution from a stray __proto__/constructor in the JSON.
                if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
                if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
                if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k]) &&
                    dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) {
                    deepMerge(dst[k], src[k]);
                } else {
                    dst[k] = src[k];
                }
            }
        })(c, __override);
        console.log('[perf-override] applied config override keys:', Object.keys(__override).join(', '));
    } catch (e) {
        console.error('[perf-override] invalid CHAO_PERF_OVERRIDE JSON:', e.message);
    }
}

let octokitInstance;
async function getOctokit() {
    if (!octokitInstance) {
        const { Octokit } = await import("@octokit/core");
        octokitInstance = new Octokit({ auth: process.env.GITHUB_AUTH });
    }
    return octokitInstance;
}
loadMaps();
loadSounds();
loadImages();

Colors = {};
Colors.names = {
    Red: '#e6194B',
    Green: '#3cb44b',
    Yellow: '#ffe119',
    Blue: '#4363d8',
    Orange: '#f58231',
    Purple: '#911eb4',
    Cyan: '#42d4f4',
    Magenta: '#f032e6',
    Lime: '#bfef45',
    Pink: '#fabed4',
    Teal: '#469990',
    Lavender: '#dcbeff',
    Brown: '#9A6324',
    Beige: '#fffac8',
    Maroon: '#800000',
    Mint: '#aaffc3',
    Olive: '#808000',
    Apricot: '#ffd8b1',
    Navy: '#000075',
    Grey: '#8A8A8A',
    White: '#ffffff',
    DarkGrey: '#454545'
};
Colors.random = function () {
    var result;
    var count = 0;
    for (var prop in this.names) {
        if (Math.random() < 1 / ++count) {
            result = this.names[prop];
        }
    }
    return result;
};
Colors.decode = function (input) {
    for (var prop in this.names) {
        if (input == this.names[prop]) {
            return prop;
        }
    }
    return "A player";
};
exports.submitPullRequest = async function (map) {
    var returnToClient = { status: false, message: "" };
    if (process.env.GITHUB_AUTH == null) {
        console.log("github auth env variable not set");
        returnToClient.status = false;
        return returnToClient;
    }


    const owner = 'sjdodge123';
    const repo = 'chaochao';
    // Strip C0 control chars (\x00-\x1f) AND DEL (\x7f) from author/email —
    // they flow into the commit's committer fields and the PR title, and a
    // crafted payload could smuggle newlines past the client's <input
    // maxlength>. DEL is the orphan control byte between the C0 range and the
    // printable extended chars (which we keep so accented names work). Map name
    // has its own stricter rule below (it becomes a filename + branch ref).
    var author = String(map.author).replace(/ /g, '').replace(/[\x00-\x1f\x7f]/g, '');
    var mapName = String(map.name).replace(/ /g, '');
    var email = String(map.email).replace(/ /g, '').replace(/[\x00-\x1f\x7f]/g, '');
    if (author == '' || email == '' || mapName == '') {
        console.log("Can't submit to github; required info missing:" + author + ":" + email + ":" + mapName);
        returnToClient.status = false;
        returnToClient.message = "Map name, author, and email are all required.";
        return returnToClient;
    }
    // Length caps — the editor's <input maxlength> bounds these at the client
    // (author 15, email 50, name 15), so a crafted socket payload is the only
    // way past. RFC 5321 caps email at 254; author at 32 gives generous headroom
    // over the editor's 15 without letting an abusive payload bloat the commit.
    if (author.length > 32) {
        returnToClient.status = false;
        returnToClient.message = "Author name is too long (max 32 characters).";
        return returnToClient;
    }
    if (email.length > 254) {
        returnToClient.status = false;
        returnToClient.message = "Email address is too long.";
        return returnToClient;
    }
    // Mirror the client's validateEmail regex so a crafted socket payload
    // (which bypasses the editor's pre-submit check) is rejected here with a
    // clear reason instead of falling through to GitHub and surfacing the
    // friendly generic. Keep both regexes in lockstep — changing one without
    // the other lets a name that passes the editor fail at submit, or vice
    // versa. (client/scripts/create.js function validateEmail) The pattern is
    // deliberately non-backtracking (no nested quantifiers on overlapping char
    // classes) to avoid ReDoS on the single-event-loop server.
    if (!/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(email)) {
        returnToClient.status = false;
        returnToClient.message = "That email address looks invalid.";
        return returnToClient;
    }
    // mapName is interpolated into a repo file path (client/maps/<name>.json) and
    // into a git branch ref below, both written with the server's GitHub
    // credentials. The submitter is untrusted, so reject anything that could
    // escape the maps directory: path separators, leading dots (dotfiles / ".."),
    // and control characters. Ordinary punctuation real map names use
    // (apostrophes, "!") is left alone — only traversal-capable input is blocked.
    // The length cap keeps the resulting filename and ref sane.
    // Thumbnail size cap — the editor exports JPEG at quality 0.1 (a few KB
    // typical); 200 KB is comfortable headroom for higher-DPI editors, while
    // rejecting a crafted blob that would bloat the repo or the socket payload.
    if (typeof map.thumbnail === "string" && map.thumbnail.length > 200 * 1024) {
        returnToClient.status = false;
        returnToClient.message = "Map thumbnail is too large.";
        return returnToClient;
    }
    if (mapName.length > 64 || /[\\/\x00-\x1f\x7f]/.test(mapName) || mapName[0] === '.') {
        console.log("Rejected map submission; unsafe map name: " + JSON.stringify(map.name));
        returnToClient.status = false;
        returnToClient.message = "Map name can't contain slashes or control characters, or start with a dot.";
        return returnToClient;
    }
    // The branch ref is created through the GitHub API and must satisfy git's
    // ref-name rules (git-check-ref-format): no "..", no trailing dot, none of
    // ~ ^ : ? * [ \ or spaces. Map names legitimately carry punctuation
    // ("What Goes Up...") that's fine in the filename above but illegal in a
    // ref — those dots are exactly what produced the rejected
    // "mapchange-whatgoesup...-832465". Slug the name down to [a-z0-9-] for the
    // branch only; the committed file still uses the real mapName. The random
    // code guarantees a unique, non-empty ref even if the slug collapses to "".
    var branchSlug = mapName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    var branchName = "mapchange-" + branchSlug + "-" + getRandomBranchCode();
    try {
        const octokit = await getOctokit();
        var result = await octokit.request('GET /repos/{owner}/{repo}/git/refs/heads', {
            owner,
            repo
        })
        var head = null;
        for (var i = 0; i < result.data.length; i++) {
            if (result.data[i].ref != 'refs/heads/main') {
                continue;
            }
            head = result.data[i];
        }
        if (head == null) {
            returnToClient.status = false;
            return returnToClient;
        }

        var path = 'client/maps/' + mapName + '.json';
        var shaOfFileAnswer = null;
        var insertion = false;
        try {
            var shaOfFileAnswer = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
                owner,
                repo,
                path
            });
        } catch (e) {
            if (e.message == 'Not Found') {
                insertion = true;
            }
        }

        var shaToUse = head.object.sha;
        if (shaOfFileAnswer != null && insertion == false) {
            shaToUse = shaOfFileAnswer.data.sha
        }
        var response = await octokit.request('POST /repos/{owner}/{repo}/git/refs', {
            owner,
            repo,
            ref: "refs/heads/" + branchName,
            sha: head.object.sha,
        })

        // Embed the canonical par time so the committed map carries it.
        if (map.parTime == null) {
            map.parTime = cellGraph.computeMapParTime(map);
        }
        // Commit in the compact sites-only format (full geometry is regenerated
        // on load), dropping the bulky voronoi diagram + thumbnail. The editor
        // sends full geometry; reduce it here so the on-disk map is ~16 KB, not
        // ~1.3 MB. parTime/metadata are carried through.
        var stored = mapFormat.isSitesOnly(map) ? map : mapFormat.toSitesOnly(map);
        var bufferObj = Buffer.from(JSON.stringify(stored, null, 2), 'utf8');
        var base64String = bufferObj.toString("base64");
        var title = 'INSERT - ' + map.name + "/" + map.author + " from " + email;
        if (insertion == false) {
            title = 'UPDATE - ' + map.name + "/" + map.author + " from " + email;
        }
        var answer = await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
            owner,
            repo,
            path,
            message: title,
            committer: {
                name: map.author,
                email: email,
            },
            branch: branchName,
            sha: shaToUse,
            content: base64String,
        })
        var pr = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
            owner,
            repo,
            title,
            body: title,
            head: branchName,
            base: 'main'
        })
        if (pr.status == 201) {
            returnToClient.status = true;
            returnToClient.message = pr.data.html_url;
            return returnToClient;
        }
        returnToClient.status = false;
        return returnToClient;
    } catch (e) {
        // Log the real error (GitHub API / network / par-time, etc.) to the
        // server console for debugging, but never surface raw exception text to
        // the player — "getaddrinfo ENOTFOUND api.github.com" means nothing to
        // them and can leak internals. Return one friendly, generic reason
        // instead. (Deliberate, player-actionable messages — missing info,
        // validation — are returned on their own paths above and reach the
        // client unchanged.) Also note this no longer reads e.response, so a
        // non-HTTP error can't throw back out of this catch.
        console.log(e);
        returnToClient.status = false;
        returnToClient.message = "Couldn't upload your map right now. Please try again in a moment.";
        return returnToClient;
    }

}

function getRandomBranchCode() {
    const codeLength = 6;
    var code = [];
    for (var i = 0; i < codeLength; i++) {
        code.push(getRandomInt(0, 9));
    }
    return code.join('');
}

function getRandomInt(min, max) {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function angle(originX, originY, targetX, targetY) {
    var dx = originX - targetX;
    var dy = originY - targetY;
    var theta = Math.atan2(-dy, -dx);
    theta *= 180 / Math.PI;
    if (theta < 0) theta += 360;
    return theta;
}
function pos(point, length, angle) {
    var a = angle * Math.PI / 180;
    var x = point.x + length * Math.cos(a);
    var y = point.y + length * Math.sin(a);
    return { x, y };
}

function cyrb53(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed,
        h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
        ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
};

exports.generateHash = function (baseID, seed) {
    return cyrb53(baseID, seed);
}

exports.angle = function (originX, originY, targetX, targetY) {
    return angle(originX, originY, targetX, targetY);
}
exports.pos = function (point, length, angle) {
    return pos(point, length, angle);
}

exports.getRandomInt = function (min, max) {
    return getRandomInt(min, max);
};

exports.getColor = function () {
    return Colors.random();
};

// Parse a '#rrggbb' (or '#rgb') hex string into {r,g,b}, else null. Non-hex
// inputs (the rare hsl() fallback below, or an unexpected value) return null and
// are simply skipped by the distance check, so they never throw.
function hexToRgb(hex) {
    if (typeof hex !== 'string') {
        return null;
    }
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) {
        return null;
    }
    var h = m[1];
    if (h.length === 3) {
        h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16)
    };
}

// Perceptual-ish distance between two hex colors using the "redmean" weighting
// (a cheap, dependency-free approximation of how different two colors LOOK,
// noticeably better than raw RGB). Returns Infinity if either color can't be
// parsed, so unparseable used-colors don't constrain the pick.
function colorDistance(a, b) {
    var ca = hexToRgb(a);
    var cb = hexToRgb(b);
    if (ca == null || cb == null) {
        return Infinity;
    }
    var rmean = (ca.r + cb.r) / 2;
    var dr = ca.r - cb.r;
    var dg = ca.g - cb.g;
    var db = ca.b - cb.b;
    return Math.sqrt(
        (((512 + rmean) * dr * dr) / 256) +
        4 * dg * dg +
        (((767 - rmean) * db * db) / 256)
    );
}

// Returns a color not already present in usedColors (a map of color -> true).
// Picks the unused palette color that is the most PERCEPTUALLY DISTINCT from the
// colors already in the room (greedy max-min distance), so a full lobby never
// hands out two lookalikes (e.g. Blue vs Navy, Red vs Maroon). The first player
// in an empty room gets a random palette color so games still vary. Once the
// palette is exhausted (a room can hold more players than there are named
// colors) it picks a random generated fallback color, retrying a bounded number
// of times to dodge collisions. Never recurses, so it can't blow the stack and
// crash the process when a room fills up.
exports.getUniqueColor = function (usedColors) {
    usedColors = usedColors || {};
    var available = [];
    for (var name in Colors.names) {
        if (!usedColors[Colors.names[name]]) {
            available.push(Colors.names[name]);
        }
    }
    if (available.length > 0) {
        var used = Object.keys(usedColors);
        if (used.length === 0) {
            return available[Math.floor(Math.random() * available.length)];
        }
        var best = available[0];
        var bestScore = -1;
        for (var i = 0; i < available.length; i++) {
            var minDist = Infinity;
            for (var j = 0; j < used.length; j++) {
                var d = colorDistance(available[i], used[j]);
                if (d < minDist) {
                    minDist = d;
                }
            }
            if (minDist > bestScore) {
                bestScore = minDist;
                best = available[i];
            }
        }
        // bestScore stays Infinity only when NO used color was parseable (e.g. the
        // whole room is on hsl() fallbacks): the greedy has nothing to measure, so
        // fall back to a random palette pick rather than deterministically
        // returning the first palette entry every time.
        if (bestScore === Infinity) {
            return available[Math.floor(Math.random() * available.length)];
        }
        return best;
    }
    var color = 'hsl(' + Math.floor(Math.random() * 360) + ', 70%, 50%)';
    for (var tries = 0; tries < 100 && usedColors[color]; tries++) {
        color = 'hsl(' + Math.floor(Math.random() * 360) + ', 70%, 50%)';
    }
    return color;
};

// SPIKE (lobby skin station): the named-color palette as a plain array, for the
// skin picker's choices and for server-side validation of a requested skin color.
exports.getColorPalette = function () {
    var out = [];
    for (var name in Colors.names) {
        out.push(Colors.names[name]);
    }
    return out;
};

exports.getDT = function () {
    var currentFrame = new Date();
    var dt = currentFrame - lastFrame;
    lastFrame = currentFrame;
    return dt / 1000;
}
exports.getMagSq = function (x1, y1, x2, y2) {
    var dx = x2 - x1;
    var dy = y2 - y1;
    return dx * dx + dy * dy;
}
exports.normalizedVectorFromAngle = function (angle) {
    // Calculate x and y components of vector
    const x = Math.cos(angle);
    const y = Math.sin(angle);

    // Calculate magnitude of vector
    const magnitude = Math.sqrt(x * x + y * y);

    // Normalize vector by dividing each component by magnitude
    return {
        x: x / magnitude,
        y: y / magnitude
    };
}
exports.normalizedVectorFromPoint = function (point) {
    /// Calculate magnitude of vector
    const magnitude = Math.sqrt(point.x * point.x + point.y * point.y);
    // Normalize vector by dividing each component by magnitude
    return {
        x: point.x / magnitude,
        y: point.y / magnitude
    };
}

exports.distanceBetweenPoints = function (point1, point2) {
    const dx = point2.x - point1.x;
    const dy = point2.y - point1.y;
    return Math.sqrt(dx * dx + dy * dy);
}

exports.getMag = function (x, y) {
    return Math.sqrt(x * x + y * y);
}

exports.dotProduct = function (a, b) {
    return a.x * b.x + a.y * b.y;
}
exports.loadConfig = function () {
    return c;
}
exports.loadMaps = function () {
    return maps;
}
// Shared structural validation for a map before it can be play-tested.
// Mirrored on the client (client/scripts/create.js) so the editor can give
// fast feedback; re-run here as the trust boundary before a preview room is
// created. Returns { valid: bool, reason: string }.
// Memoized known-id sets. Built defensively from config (skip entries without
// a numeric .id, e.g. tileMap.abilities), keyed by the config object so the
// rare test case that passes a different config still works correctly. The
// production caller always passes the cached `c`, which means one build over
// the process lifetime.
var _knownIdSetsCache = null;
var _knownIdSetsConfig = null;
function getKnownIdSets(config) {
    if (_knownIdSetsConfig === config && _knownIdSetsCache != null) {
        return _knownIdSetsCache;
    }
    var tile = {};
    for (var tk in config.tileMap) {
        if (config.tileMap[tk] && typeof config.tileMap[tk].id === "number") {
            tile[config.tileMap[tk].id] = true;
        }
    }
    var hazard = {};
    for (var hk in config.hazards) {
        if (config.hazards[hk] && typeof config.hazards[hk].id === "number") {
            hazard[config.hazards[hk].id] = true;
        }
    }
    _knownIdSetsCache = { tile: tile, hazard: hazard };
    _knownIdSetsConfig = config;
    return _knownIdSetsCache;
}

exports.validateMap = function (vMap, config) {
    if (vMap == null) {
        return { valid: false, reason: "No map data." };
    }
    if (!Array.isArray(vMap.cells) || vMap.cells.length === 0) {
        return { valid: false, reason: "Map has no cells." };
    }
    // Cap mirrored from mapFormat.MAX_MAP_CELLS (which the CI validator also
    // uses); rejects crafted/loaded maps that would otherwise hand a huge payload
    // to the engine on the shared server process.
    if (vMap.cells.length > mapFormat.MAX_MAP_CELLS) {
        return { valid: false, reason: "Map is too large (over " + mapFormat.MAX_MAP_CELLS + " cells)." };
    }
    // Module-level cached id sets (config is immutable across the process
    // lifetime). Built once at first validateMap call; the alternative —
    // rebuilding them on every preview/submit — was pure waste.
    var sets = getKnownIdSets(config);
    var validTileIds = sets.tile;
    var validHazardIds = sets.hazard;
    var hasGoal = false;
    for (var i = 0; i < vMap.cells.length; i++) {
        var cell = vMap.cells[i];
        if (cell == null || cell.site == null) {
            return { valid: false, reason: "Map has a malformed cell." };
        }
        // Number.isFinite is type-safe AND rejects NaN/Infinity — both pass the
        // old `typeof === "number"` and would propagate NaN through the engine.
        if (!Number.isFinite(cell.site.x) || !Number.isFinite(cell.site.y)) {
            return { valid: false, reason: "Map has a cell with an invalid position." };
        }
        if (!Array.isArray(cell.halfedges)) {
            return { valid: false, reason: "Map has a cell with no geometry." };
        }
        if (typeof cell.id !== "number" || !validTileIds[cell.id]) {
            return { valid: false, reason: "Map has a cell with an invalid tile." };
        }
        if (cell.id === config.tileMap.goal.id) {
            hasGoal = true;
        }
    }
    if (!hasGoal) {
        return { valid: false, reason: "Add a goal tile before previewing." };
    }
    if (vMap.hazards != null) {
        if (!Array.isArray(vMap.hazards)) {
            return { valid: false, reason: "Map has malformed hazards." };
        }
        for (var h = 0; h < vMap.hazards.length; h++) {
            var hazard = vMap.hazards[h];
            if (hazard == null || !validHazardIds[hazard.id] ||
                !Number.isFinite(hazard.x) || !Number.isFinite(hazard.y)) {
                return { valid: false, reason: "Map has a malformed hazard." };
            }
            // A moving bumper rides a rail at a given angle; a non-finite angle
            // sends the engine's rail math to NaN.
            if (hazard.id === config.hazards.movingBumper.id &&
                !Number.isFinite(hazard.angle)) {
                return { valid: false, reason: "Map has a moving bumper with no direction." };
            }
        }
    }
    // startEdges: optional; absent => default ["left"] (legacy maps). One edge for
    // a single start, or an OPPOSITE pair (left+right / top+bottom) for a two-sided
    // start. Adjacent pairs (e.g. left+top) and repeats are rejected.
    if (vMap.startEdges != null) {
        var startEdgeCheck = validateStartEdges(vMap.startEdges);
        if (!startEdgeCheck.valid) {
            return startEdgeCheck;
        }
        // Every start edge must have a goal reachable from it, or that side's
        // racers can never finish (most likely on an opposite-edge combo with an
        // off-center / walled-off goal). Server-only — the cell graph isn't in the
        // editor bundle, so the editor surfaces this via the preview/submit
        // rejection rather than inline.
        for (var se = 0; se < vMap.startEdges.length; se++) {
            if (!cellGraph.reachableFromEdge(vMap, vMap.startEdges[se])) {
                return { valid: false, reason: "No goal is reachable from the " + vMap.startEdges[se] + " start." };
            }
        }
    }
    return { valid: true };
}
// Shared start-edge rule used by validateMap on both sides. Kept as a standalone
// so the client editor can mirror it exactly.
function validateStartEdges(startEdges) {
    var OPPOSITE = { left: "right", right: "left", top: "bottom", bottom: "top" };
    if (!Array.isArray(startEdges) || startEdges.length < 1 || startEdges.length > 2) {
        return { valid: false, reason: "startEdges must list 1 or 2 edges." };
    }
    for (var i = 0; i < startEdges.length; i++) {
        if (OPPOSITE[startEdges[i]] == null) {
            return { valid: false, reason: "startEdges has an unknown edge." };
        }
    }
    if (startEdges.length === 2) {
        if (startEdges[0] === startEdges[1]) {
            return { valid: false, reason: "startEdges can't repeat the same edge." };
        }
        if (OPPOSITE[startEdges[0]] !== startEdges[1]) {
            return { valid: false, reason: "Two start edges must be opposite (left+right or top+bottom)." };
        }
    }
    return { valid: true };
}
exports.validateStartEdges = validateStartEdges;
exports.getContentCount = function () {
    return mapListing.length + soundListing.length + imgListing.length;
}
exports.getMapListings = function () {
    return mapListing;
}
// The map-editor map list excludes lobbyOnly maps (e.g. _lobbyTutorial.json):
// they're lobby/tutorial-only, not user-editable race maps. Built in loadMaps()
// from each map's own object (no index-alignment assumption). The full
// getMapListings() is still used for contentDelivery so the play client can
// preload the lobby map for client-side rendering.
exports.getEditorMapListings = function () {
    return editorMapListing;
}
exports.getSoundListings = function () {
    return soundListing;
}
exports.getImageListings = function () {
    return imgListing;
}

exports.getRandomProperty = function (obj) {
    var keys = Object.keys(obj);
    return obj[keys[keys.length * Math.random() << 0]];
}

exports.shuffleArray = function (array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const temp = array[i];
        array[i] = array[j];
        array[j] = temp;
    }
    return array;
}

function loadMaps() {
    var normalizedPath = require("path").join(__dirname, "../client/maps");
    fs.readdirSync(normalizedPath).forEach(function (file) {
        if (file == ".DS_Store") { return; }
        var loadedMap;
        try {
            loadedMap = require("../client/maps/" + file);
            // Compact sites-only maps store only voronoi sites + bbox; rebuild the
            // full diagram (cells/edges/geometry) before anything downstream — par-time,
            // adjacency, the engine and the renderer all expect full geometry. Legacy
            // full-geometry maps pass through unchanged.
            if (mapFormat.isSitesOnly(loadedMap)) {
                loadedMap = mapFormat.reconstruct(loadedMap);
            }
        } catch (e) {
            // A malformed/degenerate map must not take down the whole server at boot.
            // Skip it (and keep mapListing/maps/editorMapListing in lockstep by only
            // pushing on success) so the rest of the maps still load.
            console.error("Skipping map " + file + " — failed to load/reconstruct: " + e.message);
            return;
        }
        mapListing.push(file);
        // Par-time is a fixed property of a map's geometry; compute it once
        // at boot for any map lacking it (submitted maps embed it). Deep
        // copies (currentMap) preserve the number.
        if (loadedMap.parTime == null) {
            loadedMap.parTime = cellGraph.computeMapParTime(loadedMap);
        }
        maps.push(loadedMap);
        // The editor list excludes lobbyOnly maps (e.g. _lobbyTutorial.json).
        // Built here from this file's own map object so it never relies on
        // index alignment between mapListing and maps.
        if (!loadedMap.lobbyOnly) {
            editorMapListing.push(file);
        }
    });
}
function loadSounds() {
    var normalizedPath = require("path").join(__dirname, "../client/assets/sounds");
    fs.readdirSync(normalizedPath).forEach(function (file) {
        // Only ship actual audio to the client manifest; non-audio files living
        // alongside the sounds (e.g. CREDITS.md) must not be preloaded as sounds.
        if (/\.(mp3|wav|ogg|m4a)$/i.test(file)) {
            soundListing.push(file);
        }
    });
}
function loadImages() {
    var normalizedPath = require("path").join(__dirname, "../client/assets/img");
    fs.readdirSync(normalizedPath).forEach(function (file) {
        if (file != ".DS_Store") {
            imgListing.push(file);
        }
    });
}

