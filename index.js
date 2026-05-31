// Load local .env (if present) before anything reads process.env. Harmless and
// silent when there's no .env file — Heroku injects config vars directly.
require('dotenv').config({ quiet: true });
const express = require('express');
const compression = require('compression');
const fs = require('fs');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const path = require('path');
const htmlPath = path.join(__dirname, 'client');

app.use(compression());

// Portal embeddability: CrazyGames / Poki / itch.io host the game inside an
// <iframe> on their own domain. Allow exactly those origins to frame us (plus
// our own pages) via CSP `frame-ancestors`, while every other site stays
// blocked. We deliberately send NO `X-Frame-Options` header: its only
// "allow a specific origin" value (ALLOW-FROM) is dead in modern browsers, and
// a bare DENY/SAMEORIGIN would block the portals — `frame-ancestors` is the
// modern, multi-origin-capable control. Only this one directive is set, so
// scripts/styles/etc. (the CDN assets) are left unrestricted. Runs before the
// page + static handlers so it covers every served response, including the
// HTML pages and the socket.io polling endpoint.
// Each portal is listed with BOTH its apex origin and a wildcard: a wildcard
// (e.g. https://*.poki.com) matches subdomains only, NOT the bare apex, and
// Poki/CrazyGames can frame from either, so both must be allowed explicitly.
// Outside production we ALSO allow localhost origins so the documented local
// embed test (embed-test.html served from a different port, framing
// localhost:3000) can load; prod stays locked to the portals only.
var FRAME_ANCESTORS =
    "frame-ancestors 'self' " +
    "https://crazygames.com https://*.crazygames.com " +
    "https://poki.com https://*.poki.com " +
    "https://itch.io https://*.itch.io https://*.itch.zone" +
    (process.env.NODE_ENV === 'production'
        ? ''
        : " http://localhost:* http://127.0.0.1:*");
app.use(function (req, res, next) {
    res.set('Content-Security-Policy', FRAME_ANCESTORS);
    next();
});

// Auth foundation: validates the Socket.IO handshake (below) and supplies the
// browser-safe Supabase config injected into served pages. No-ops when the
// Supabase env vars are absent, so the server boots and everyone is a guest.
const auth = require('./server/auth.js');

// Browser-safe Supabase config (URL + anon key only) injected via the
// <!-- SUPABASE_CONFIG --> placeholder. null when auth is disabled, in which
// case the placeholder is stripped and the client also treats everyone as a
// guest. The service-role key and JWT secret are NEVER referenced here.
function supabaseConfigTag() {
    var cfg = auth.getPublicConfig();
    if (!cfg) {
        return '';
    }
    // Escape characters that could break out of the inline <script> or terminate
    // the script element early (defense-in-depth — the values are operator-set env
    // vars, but never inline unescaped JSON into HTML).
    var json = JSON.stringify(cfg)
        .replace(/</g, '\\u003c')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
    return '<script>window.__SUPABASE__ = ' + json + ';</script>';
}

// Inject the running server's version and the latest release headline into
// index.html so the landing page always reflects what's actually deployed.
// Runs in both dev and prod; read once at startup so we don't hit disk on
// every request.
const APP_VERSION = require('./package.json').version;
const APP_NEWS = loadWeeklyNews();
const RELEASES_REPO = 'sjdodge123/chaochao';

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Monday (UTC, YYYY-MM-DD) of the calendar week containing a YYYY-MM-DD date.
// MUST match mondayOf() in .github/scripts/changelog-lib.mjs, which names the
// "week-YYYY-MM-DD" digest release this banner links to.
function mondayOf(dateStr) {
    var d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
}

// The news banner surfaces ONE headline for the latest week of releases and
// links to that week's consolidated digest release. The headline is the most
// recent bullet flagged "[headline]" within the week of the topmost release
// section, falling back to that week's first bullet. Returns null when there
// are no releases yet. Kept in lockstep with the digest built in
// .github/scripts/changelog-lib.mjs.
function loadWeeklyNews() {
    try {
        var md = fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf8');
        var lines = md.split('\n');
        var weekMonday = null;     // week of the topmost release section
        var inWeek = false;        // currently scanning a section in that week
        var headline = null;       // [headline]-marked bullet (first wins)
        var firstBullet = null;    // fallback: first bullet of the week
        var headlineRe = /^-\s+\[headline\]\s*/i;
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            var ver = line.match(/^##\s+v\d+\.\d+\.\d+\s+—\s+(\d{4}-\d{2}-\d{2})/);
            if (ver) {
                var monday = mondayOf(ver[1]);
                if (weekMonday === null) weekMonday = monday;
                inWeek = monday === weekMonday;
                continue;
            }
            if (line.indexOf('## ') === 0) { inWeek = false; continue; }
            if (!inWeek || line.indexOf('- ') !== 0) continue;
            var clean = function (t) {
                return t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [text](url) -> text
                    .replace(/[*`_]/g, '').trim();              // strip emphasis/code
            };
            if (firstBullet === null) firstBullet = clean(line.slice(2));
            if (headline === null && headlineRe.test(line)) {
                headline = clean(line.replace(headlineRe, ''));
            }
        }
        var text = headline || firstBullet;
        if (!text || !weekMonday) return null;
        return { headline: text, weekTag: 'week-' + weekMonday };
    } catch (e) {
        console.log('Could not read CHANGELOG.md for news banner:', e.message);
        return null;
    }
}

function newsBannerHtml() {
    // Both branches build the same `<a class="news-banner">` shell — only the
    // href, badge, and headline differ. `rel="noopener noreferrer"` guards the
    // target=_blank against reverse-tabnabbing on older Safari (modern browsers
    // imply noopener already, but it's free to be explicit).
    function bannerAnchor(href, badge, headline) {
        return '<a class="news-banner" target="_blank" rel="noopener noreferrer" href="' +
            escapeHtml(href) + '">' +
            '<span class="news-badge">' + escapeHtml(badge) + '</span>' +
            '<span class="news-headline">' + escapeHtml(headline) + '</span>' +
            '</a>';
    }
    if (!APP_NEWS) {
        // No flagged headline this week — fall back to a quiet link to the
        // releases index so the banner slot never goes silent.
        return bannerAnchor(
            'https://github.com/' + RELEASES_REPO + '/releases',
            "What's new",
            'See the latest releases'
        );
    }
    return bannerAnchor(
        'https://github.com/' + RELEASES_REPO + '/releases/tag/' + encodeURIComponent(APP_NEWS.weekTag),
        'Patch notes',
        APP_NEWS.headline
    );
}

const bundleMap = {
    '/play.html': 'scripts/dist/play.bundle.min.js',
    '/create.html': 'scripts/dist/create.bundle.min.js',
    '/join.html': 'scripts/dist/join.bundle.min.js'
};

// Single HTML page handler: applies all server-side string injections in one
// pass (version + news banner for the landing page, browser-safe Supabase
// config for auth pages, and in production the bundle-tag rewrite). Placeholders
// that aren't present on a given page are simply left untouched. Everything else
// (css/js/img/sounds) falls through to express.static below.
const HTML_PAGES = {
    '/index.html': true,
    '/play.html': true,
    '/create.html': true,
    '/join.html': true
};
app.use(function (req, res, next) {
    var url = req.path === '/' ? '/index.html' : req.path;
    if (!HTML_PAGES[url]) return next();
    fs.readFile(path.join(htmlPath, url), 'utf8', function (err, html) {
        if (err) return next();
        var modified = html
            .replace(/<!-- VERSION -->/g, 'v' + APP_VERSION)
            .replace(/<!-- NEWS_BANNER -->/g, newsBannerHtml())
            .replace(/<!-- SUPABASE_CONFIG -->/g, supabaseConfigTag());
        if (process.env.NODE_ENV === 'production' && (url in bundleMap)) {
            var bundleTag = '<script src="' + bundleMap[url] + '"></script>';
            modified = modified.replace(/<!-- BUILD: bundle-start -->[\s\S]*?<!-- BUILD: bundle-end -->/g, bundleTag);
        }
        res.set('Content-Type', 'text/html');
        // HTML carries the injected version/news/bundle tags and must reflect a
        // fresh deploy immediately, so never let a browser/CDN serve it stale —
        // revalidate every time (the ETag keeps the unchanged case a cheap 304).
        res.set('Cache-Control', 'no-cache');
        res.send(modified);
    });
});

// Static assets. The default (max-age=0) forces a revalidation round-trip for
// every file on every visit — brutal for distant players (e.g. a phone in
// Vietnam ~250ms from the US dyno re-checking ~150 files, tens of MB of audio).
// Set real cache lifetimes by kind so a browser/CDN can serve from the edge:
//   - /assets/** (images + sounds): content-stable media, cache hard (30 days).
//     A CDN edge-caches these near the player; purge the CDN on the rare change.
//   - everything else, INCLUDING /maps/**: JS bundles, CSS, and map JSON are all
//     unhashed and can change in place on deploy (e.g. the curated lobby map is
//     edited, not renamed), so use no-cache — a deploy/map edit is picked up at
//     once and the ETag keeps the unchanged case a cheap 304. (Map JSON is small;
//     the revalidation cost the asset cache avoids was about the tens-of-MB media,
//     not KB maps. A previous 1-day map cache made lobby/map edits lag a full day.)
var ASSET_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
app.use(express.static(htmlPath, {
    etag: true,
    lastModified: true,
    setHeaders: function (res, filePath) {
        var rel = path.relative(htmlPath, filePath);
        if (rel.indexOf('assets' + path.sep) === 0) {
            res.set('Cache-Control', 'public, max-age=' + Math.floor(ASSET_MAX_AGE_MS / 1000));
        } else {
            res.set('Cache-Control', 'no-cache');
        }
    }
}));

var utils = require('./server/utils.js');
var messenger = require('./server/messenger.js');
var hostess = require('./server/hostess.js');
var botGuard = require('./server/botGuard.js');
var c = utils.loadConfig();

// In-browser feedback / bug-report endpoint. The widget (client/scripts/feedback.js)
// POSTs here and utils.submitIssue files it as a GitHub issue using the server's
// GITHUB_AUTH token (same credential map-submit uses). Because it's unauthenticated
// and writes to GitHub, it's guarded by: a tight JSON body cap, a hidden honeypot
// field (any value = a bot, silently accepted-and-dropped), and a per-IP rate limit.
// Keyed by client IP. A Map (not a plain object) so a hostile IP string can never
// be a special property name (__proto__, constructor, …) — there's no prototype to
// pollute and key lookups stay O(1) on arbitrary strings.
var feedbackHits = new Map(); // ip -> [timestamps] within the window
var FEEDBACK_WINDOW_MS = 10 * 60 * 1000;
var FEEDBACK_MAX_PER_WINDOW = 5;
function feedbackRateLimited(ip) {
    var now = Date.now();
    var hits = (feedbackHits.get(ip) || []).filter(function (t) { return now - t < FEEDBACK_WINDOW_MS; });
    if (hits.length >= FEEDBACK_MAX_PER_WINDOW) {
        feedbackHits.set(ip, hits);
        return true;
    }
    hits.push(now);
    feedbackHits.set(ip, hits);
    return false;
}
// Sweep expired keys so a public endpoint hit by many distinct IPs can't grow
// feedbackHits without bound (entries are otherwise only pruned when that same IP
// submits again). Cheap (runs once per window) and harmless while the server sleeps.
setInterval(function () {
    var now = Date.now();
    feedbackHits.forEach(function (timestamps, ip) {
        var hits = timestamps.filter(function (t) { return now - t < FEEDBACK_WINDOW_MS; });
        if (hits.length === 0) { feedbackHits.delete(ip); }
        else { feedbackHits.set(ip, hits); }
    });
}, FEEDBACK_WINDOW_MS).unref();
app.post('/feedback', express.json({ limit: '16kb' }), function (req, res) {
    var body = req.body || {};
    // Honeypot: a real form leaves `website` empty (it's hidden off-screen). Any
    // value means a bot filled every field — respond 200 so it thinks it worked,
    // but file nothing.
    if (body.website) {
        return res.json({ status: true, message: "" });
    }
    // Resolve the client IP from the TRUSTED proxy hop (counting in from the right),
    // not the left-most X-Forwarded-For entry — a caller can forge that and rotate it
    // every request to bypass the limit. Reuses the same resolver the socket path uses.
    var ip = botGuard.resolveClientIp(req.headers['x-forwarded-for'], req.ip) || 'unknown';
    if (feedbackRateLimited(ip)) {
        return res.status(429).json({ status: false, message: "You've sent a lot of feedback — please wait a few minutes and try again." });
    }
    utils.submitIssue({
        type: body.type,
        message: body.message,
        email: body.email,
        page: body.page,
        context: body.context
    }).then(function (result) {
        res.json(result);
    }).catch(function (e) {
        console.log(e);
        res.json({ status: false, message: "Couldn't send your feedback right now. Please try again in a moment." });
    });
});

//Base Server vars
var serverSleeping = true,
    pendingReboot = false,
    clientCount = 0,
    serverTickSpeed = c.serverTickSpeed,
    serverUpdates = null;

server.listen(c.port, () => {
  console.log('listening on *:3000');
  messenger.build(io);
});

// Refresh per-map rating aggregates from Supabase into each map's classifier meta
// (drives the Crowd Favorites playlist + editor scores). No-op when auth is off, so
// local dev just shows no ratings. Once at boot, then on a slow interval — ratings
// change far slower than a tick, and the read is one small aggregate query.
var ratings = require('./server/ratings.js');
function refreshMapRatings() {
    ratings.loadSummaries(c).then(function (summaries) {
        // null = transient read error: keep the last good summaries (don't wipe
        // every aggregate + Favorites membership over a blip). {} = genuinely empty.
        if (summaries == null) { return; }
        utils.applyRatingSummaries(summaries);
        // Push the refreshed playlist summary to every connected client so active
        // lobbies pick up new counts / a Favorites playlist that crossed the
        // visibility threshold without needing to reconnect.
        messenger.broadcastAll("playlistInfo", utils.getPlaylistSummary());
    }).catch(function (e) {
        console.log('[ratings] refresh error:', e.message);
    });
}
refreshMapRatings();
setInterval(refreshMapRatings, 5 * 60 * 1000);

// Accept only a sane deviceId from the handshake (an opaque client UUID): a
// string of bounded length. Rejects junk/oversized values that would otherwise
// be persisted into the progression row's device_ids array.
function sanitizeDeviceId(raw) {
    if (typeof raw !== 'string') return null;
    if (raw.length < 8 || raw.length > 64) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
    return raw;
}

// Resolve every Socket.IO handshake to a Supabase user id when an access token
// is supplied, otherwise leave the connection as a guest. We NEVER reject here —
// anonymous play must keep working exactly as before. A valid token also ensures
// the user's durable `progression` row exists and records this device.
//
// No per-IP throttle here: behind Heroku's router socket.handshake.address is the
// PROXY ip shared by every client, so an IP throttle would be a global throttle
// that silently demotes all signed-in users to guests under normal load. Repeated
// tokens (good or verified-bad) are already cheap via auth.js's token cache, and
// each network verify is bounded by a timeout; a global cap can be added at the
// infra layer if abuse is ever observed.
io.use(async (socket, next) => {
    var handshake = socket.handshake.auth || {};
    socket.deviceId = sanitizeDeviceId(handshake.deviceId);
    socket.userId = null;
    if (handshake.token) {
        try {
            var userId = await auth.verifyToken(handshake.token);
            if (userId) {
                socket.userId = userId;
                // Fire-and-forget: recording the row must NOT block/stall the
                // handshake on Supabase latency — guests and gameplay don't wait on it.
                Promise.resolve(auth.ensureProgressionRow(userId, socket.deviceId))
                    .catch(function (e) { console.log('[auth] ensureProgressionRow failed:', e.message); });
                console.log('[auth] socket', socket.id, 'resolved to user', userId,
                    socket.deviceId ? '(device ' + socket.deviceId + ')' : '');
            }
        } catch (e) {
            console.log('[auth] handshake resolution error (continuing as guest):', e.message);
        }
    }
    // Resolve the real client IP for botGuard's datacenter check. socket.handshake.address is
    // the immediate peer (Heroku's shared router); a bot can PREPEND a spoofed hop to
    // x-forwarded-for, so botGuard counts trusted proxies in from the RIGHT rather than
    // trusting the left-most value. Used only to segment automated cloud/VPS traffic, never
    // as a per-IP throttle (see the note above).
    var xff = socket.handshake.headers['x-forwarded-for'];
    socket.clientIp = botGuard.resolveClientIp(xff, socket.handshake.address);
    // Hard-block only when botGuard.config.json sets datacenter.action='block' (default is
    // the softer 'tarpit', which lets them connect and then dead-ends them). Signed-in
    // users are exempt via bypassForAuthed.
    if (botGuard.shouldHardBlock(socket.clientIp, socket.userId != null)) {
        console.log('[botGuard] refusing datacenter handshake', socket.id, socket.clientIp);
        return next(new Error('connection refused'));
    }
    next(); // never reject guests
});

io.on('connection', (client) => {
    checkForWake();
    clientCount++;
    var verdict = botGuard.register(client.id, client.clientIp, client.userId != null);
    if (verdict.datacenter) {
        console.log('[botGuard] datacenter connection', client.id, client.clientIp, '-> action:', verdict.action);
    }
    messenger.addMailBox(client.id, client, { userId: client.userId, deviceId: client.deviceId });

    client.on('disconnect', () => {
      botGuard.unregister(client.id);
      hostess.kickFromRoom(client.id);
      messenger.removeMailBox(client.id);
      clientCount--;
      checkForSleep();
    });
  });
  
process.on( 'SIGINT', function() {
    console.log( "\nServer shutting down from (Ctrl-C)" );
    //io.sockets.emit("serverShutdown","Server terminated");
    process.exit();
});



/*
app.get("/create",function(request,response){
  response.render('pages/create');
});
*/


//Server updates
function update(){
  if(serverSleeping){
      return;
  }

  var dt = utils.getDT();
  hostess.updateRooms(dt);
  if(pendingReboot == false){
      //25000000
      /*
      var heapUsed = process.memoryUsage().heapUsed;
      if(heapUsed > 40000000){
          console.log("Performing Emergency reboot Memory Critical " + heapUsed);
          reboot();
      } else if(heapUsed > 32500000){
          console.log("Pending reboot.. Memory currently at " + heapUsed);
          pendingReboot = true;
      }
      */
  }
}

function checkForWake(){
	if(serverSleeping){
      console.log("Server wake");
      utils.getDT();
      serverSleeping = false;
      serverUpdates = setInterval(update,serverTickSpeed);
	}
}

function reboot(){
  console.log("Server rebooting.....");
  process.exit(1);
}

function checkForSleep(){
	if(clientCount == 0){
    if(pendingReboot){
        reboot();
    }
    console.log("Server sleep ZZZ..");
		serverSleeping = true;
		clearInterval(serverUpdates);
	}
}
