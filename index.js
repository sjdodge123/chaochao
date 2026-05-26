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
    if (!APP_NEWS) {
        return '';
    }
    var href = 'https://github.com/' + RELEASES_REPO +
        '/releases/tag/' + encodeURIComponent(APP_NEWS.weekTag);
    return '<a class="news-banner" target="_blank" href="' + escapeHtml(href) + '">' +
        '<span class="news-badge">Patch notes</span>' +
        '<span class="news-headline">' + escapeHtml(APP_NEWS.headline) + '</span>' +
        '</a>';
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
        res.send(modified);
    });
});

app.use(express.static(htmlPath));

var utils = require('./server/utils.js');
var messenger = require('./server/messenger.js');
var hostess = require('./server/hostess.js');
var c = utils.loadConfig();

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

// Accept only a sane deviceId from the handshake (an opaque client UUID): a
// string of bounded length. Rejects junk/oversized values that would otherwise
// be persisted into the progression row's device_ids array.
function sanitizeDeviceId(raw) {
    if (typeof raw !== 'string') return null;
    if (raw.length < 8 || raw.length > 64) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
    return raw;
}

// Lightweight per-IP token-verification throttle so a client spamming
// connections with bogus tokens can't amplify into unbounded Supabase getUser()
// calls. Sliding 60s window; over the cap we skip verification (treat as guest)
// rather than reject — guests always connect.
var verifyHits = new Map();
var VERIFY_WINDOW_MS = 60 * 1000;
var VERIFY_MAX_PER_WINDOW = 60;
function allowVerify(ip) {
    var now = Date.now();
    var rec = verifyHits.get(ip);
    if (!rec || now - rec.start > VERIFY_WINDOW_MS) {
        verifyHits.set(ip, { start: now, count: 1 });
        if (verifyHits.size > 10000) { verifyHits.clear(); }
        return true;
    }
    rec.count++;
    return rec.count <= VERIFY_MAX_PER_WINDOW;
}

// Resolve every Socket.IO handshake to a Supabase user id when an access token
// is supplied, otherwise leave the connection as a guest. We NEVER reject here —
// anonymous play must keep working exactly as before. A valid token also ensures
// the user's durable `progression` row exists and records this device.
io.use(async (socket, next) => {
    var handshake = socket.handshake.auth || {};
    socket.deviceId = sanitizeDeviceId(handshake.deviceId);
    socket.userId = null;
    if (handshake.token && allowVerify(socket.handshake.address)) {
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
    next(); // never reject — guests are allowed
});

io.on('connection', (client) => {
    checkForWake();
    clientCount++;
    messenger.addMailBox(client.id, client, { userId: client.userId, deviceId: client.deviceId });

    client.on('disconnect', () => {
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
