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
// Heartbeat: ping a touch more often than the engine.io default (25s) but KEEP the
// generous 20s pong timeout. A client whose WebSocket silently dies (a Cloudflare PoP
// hiccup, a NAT/middlebox dropping the long-lived socket) is otherwise invisible for
// up to ~45s before the server gives up and the client auto-reconnects — and that
// reconnect is the only chance to get back onto WebSocket instead of limping along on
// long-polling. At 15s/20s a dead socket is detected in ~35s. We do NOT shorten
// pingTimeout: mobile browsers (iOS Safari especially) heavily throttle background
// timers, so a tight timeout would drop players who merely glanced away for a moment.
const io = new Server(server, { pingInterval: 15000, pingTimeout: 20000 });
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
// Discord Activities load the game inside an <iframe> hosted at
// https://discord.com (and the iframe's own sandbox origin
// <APPLICATION_ID>.discordsays.com). Both must be allowed to frame us, or the
// Activity shows a blank/blocked frame. discordsays.com is included so a nested
// reframe by the proxy is also permitted. Harmless for the normal web build.
var FRAME_ANCESTORS =
    "frame-ancestors 'self' " +
    "https://crazygames.com https://*.crazygames.com " +
    "https://poki.com https://*.poki.com " +
    "https://itch.io https://*.itch.io https://*.itch.zone " +
    "https://discord.com https://*.discord.com https://*.discordsays.com" +
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

// Discord Activity in-frame auth bridge (Phase 4). Owns the DISCORD_CLIENT_SECRET +
// the OAuth code exchange; backs the POST /api/token route below. Disabled (route
// 404s) when the secret is absent, so the normal web build is unaffected.
const discordAuth = require('./server/discordAuth.js');

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
    return '<script>window.__SUPABASE__ = ' + json + ';<\/script>';
}

// Browser-safe ad config injected via the <!-- ADS_CONFIG --> placeholder
// (play.html only). Carries ONLY the network name + public publisher id — both
// safe to expose (they end up in client SDK URLs anyway). Defaults to provider
// 'none' so local dev (no env vars) makes every ad call a graceful no-op. The
// client (ads.js) is network-agnostic; this is the single place the server tells
// it which network, if any, is wired.
function adsConfigTag() {
    var cfg = {
        provider: (process.env.ADS_PROVIDER || 'none'),
        publisherId: (process.env.ADS_PUBLISHER_ID || null)
    };
    // Same escaping as the Supabase tag - defense-in-depth against an env value
    // breaking out of the inline <script> (< closing the element; U+2028/U+2029
    // line separators, valid JS but breaking inline JSON-in-HTML).
    var json = JSON.stringify(cfg)
        .replace(/</g, '\\u003c')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
    return '<script>window.__ADS__ = ' + json + ';<\/script>';
}

// Browser-safe Discord Activity config (PUBLIC client id only) injected via the
// <!-- DISCORD_CONFIG --> placeholder. Approach (b): play.html IS the Activity entry,
// so the in-frame SDK bootstrap (discordPresence.js) reads window.__DISCORD__ from the
// game frame. The client SECRET is never referenced here — token exchange is
// server-side (POST /api/token). Stripped to '' when DISCORD_CLIENT_ID is unset. (No
// mappingTarget: we don't call patchUrlMappings — same-origin requests ride the root
// URL Mapping.)
function discordConfigTag() {
    if (!process.env.DISCORD_CLIENT_ID) {
        return '';
    }
    var cfg = { clientId: process.env.DISCORD_CLIENT_ID };
    // Escape '<' so a value cannot terminate the inline <script> (defense-in-depth;
    // the client id is a numeric snowflake, so it can't carry the U+2028/U+2029
    // separators the other tags guard against).
    var json = JSON.stringify(cfg).replace(/</g, '\\u003c');
    return '<script>window.__DISCORD__ = ' + json + ';<\/script>';
}

// Discord's iframe sandbox forces every request through https://<id>.discordsays.com
// and CSP-blocks any unmapped external origin. URL Mappings / patchUrlMappings can
// reroute fetch/WebSocket/XHR, but NOT resources the HTML parser loads via
// <script src> / <link href>. play.html pulls jQuery (a HARD boot dep — game.js wraps
// its entire boot in `$(function(){…})`) and Bootstrap CSS from external CDNs, so in
// the Activity the page would throw before a match could ever connect. The Activity
// serves play.html in-frame (root frame_id entry, or the legacy `?discord=1`); for
// those requests only we swap those two CDN tags for local same-origin copies (proxied
// transparently through `/.proxy/`) and drop the gtag loader (analytics is irrelevant
// in-frame and off-policy for Discord). supabase-js is left as-is — the in-frame SDK
// bootstrap mints its own handshake token (POST /api/token), so no supabase-js client is
// needed. The normal web build is served byte-identical (this only fires for the Activity
// requests). Keep these strings in lockstep with client/play.html.
function discordEmbedRewrite(html) {
    return html
        // Phase 5 presence: inject the SDK bundle (auth + instance->room routing +
        // participant presence) INTO the game frame — approach (b) inits the SDK once
        // here, no discord.html redirect. Empty comment on the web build. Placed before
        // the game bundle so window.discordPresence exists in time; the cache-bust replace
        // below stamps its ?v= too (it matches the scripts/ regex).
        .replace(
            '<!-- DISCORD_PRESENCE -->',
            '<script src="scripts/dist/discord-presence.bundle.min.js"></script>'
        )
        // jQuery 3.5.1 (boot-critical) -> vendored same-origin copy.
        .replace(
            'https://ajax.googleapis.com/ajax/libs/jquery/3.5.1/jquery.min.js',
            'vendor/jquery-3.5.1.min.js'
        )
        // Bootstrap 4.1.3 CSS -> vendored copy; drop SRI/crossorigin (same-origin now).
        .replace(
            /<link rel="stylesheet" href="https:\/\/stackpath\.bootstrapcdn\.com\/bootstrap\/4\.1\.3\/css\/bootstrap\.min\.css"[^>]*>/,
            '<link rel="stylesheet" href="vendor/bootstrap-4.1.3.min.css">'
        )
        // Drop the external gtag loader; the inline `function gtag(){…}` fallback stays
        // so trackEvent() calls remain harmless no-ops.
        .replace(
            /<script async src="https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=[^"]*"><\/script>/,
            '<!-- gtag loader disabled in Discord Activity -->'
        )
        // Discord's sandbox caches the in-frame JS aggressively, so stamp every
        // same-origin script src with the server-boot id. A redeploy/restart changes
        // the stamp -> the proxy/browser refetches; within a run the URL is stable.
        // Only fires on play.html?discord=1, so the normal web build is untouched.
        .replace(/(src="(?:scripts|vendor)\/[^"?]+\.js)"/g, '$1?v=' + BOOT_STAMP + '"');
}

// Inject the running server's version and the latest release headline into
// index.html so the landing page always reflects what's actually deployed.
// Runs in both dev and prod; read once at startup so we don't hit disk on
// every request.
const APP_VERSION = require('./package.json').version;

// Server-boot id, used to cache-bust the in-frame Activity scripts (Discord caches
// JS hard and the filenames are stable). Changes every restart/deploy.
const BOOT_STAMP = Date.now().toString(36);

// The banner must never take more vertical room than three of the landing
// menu buttons, so the headline is capped to this many characters (CSS also
// line-clamps it to 3 lines as the hard geometry guarantee). Keep in lockstep
// with the same constant enforced on new [headline] bullets by
// .github/workflows/release-notes-check.yml.
const MAX_HEADLINE_CHARS = 180;

// Truncate at a word boundary with an ellipsis; short text passes through.
// Trailing punctuation is trimmed so we never render "score:…".
function truncateHeadline(text) {
    if (text.length <= MAX_HEADLINE_CHARS) return text;
    return text.slice(0, MAX_HEADLINE_CHARS - 1)
        .replace(/\s+\S*$/, '')
        .replace(/[\s.,:;!?—–-]+$/, '') + '…';
}

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
        var firstLead = null;      // fallback: first bullet's bold lead-in
        // Accepts "[headline]" and "[headline:Short Name]" (the optional name
        // only labels the digest title; the banner shows the bullet text). Keep
        // in lockstep with HEADLINE_RE in .github/scripts/changelog-lib.mjs.
        var headlineRe = /^-\s+\[headline(?::[^\]]*)?\]\s*/i;
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
            // Fallback when no bullet is flagged: show the first bullet's BOLD
            // lead-in (e.g. "New hazard: Magpie Drone") rather than the whole
            // paragraph truncated mid-sentence. Falls back to the full text when
            // a bullet has no bold lead-in.
            if (firstLead === null) {
                var raw = line.slice(2);
                var bold = raw.match(/\*\*(.+?)\*\*/);
                firstLead = clean(bold ? bold[1] : raw);
            }
            if (headline === null && headlineRe.test(line)) {
                headline = clean(line.replace(headlineRe, ''));
            }
        }
        var text = headline || firstLead;
        if (!text || !weekMonday) return null;
        return { headline: truncateHeadline(text), weekTag: 'week-' + weekMonday };
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
    // Discord loads the Activity at the mapped ROOT ('/'), which would serve the marketing
    // landing page. The Discord client always appends launch params to the iframe URL
    // (frame_id is REQUIRED by the Embedded App SDK), so when we see one at the root we
    // serve the GAME directly (approach b: play.html IS the Activity entry — no discord.html
    // redirect, because that navigation broke the SDK handshake; the game frame keeps
    // Discord's launch params on the URL and inits the SDK once, in-frame). Plain web visits
    // to '/' (no frame_id) still get the landing page.
    var activityEntry = false;
    if (url === '/index.html' && req.query && req.query.frame_id) {
        url = '/play.html';
        activityEntry = true;
    }
    if (!HTML_PAGES[url]) return next();
    fs.readFile(path.join(htmlPath, url), 'utf8', function (err, html) {
        if (err) return next();
        var modified = html
            .replace(/<!-- VERSION -->/g, 'v' + APP_VERSION)
            .replace(/<!-- NEWS_BANNER -->/g, newsBannerHtml())
            .replace(/<!-- SUPABASE_CONFIG -->/g, supabaseConfigTag())
            .replace(/<!-- ADS_CONFIG -->/g, adsConfigTag())
            .replace(/<!-- DISCORD_CONFIG -->/g, discordConfigTag());
        if (process.env.NODE_ENV === 'production' && (url in bundleMap)) {
            var bundleTag = '<script src="' + bundleMap[url] + '"></script>';
            modified = modified.replace(/<!-- BUILD: bundle-start -->[\s\S]*?<!-- BUILD: bundle-end -->/g, bundleTag);
        }
        // Discord Activity: the game boots inside the sandbox, so swap external CDN tags for
        // vendored same-origin copies + inject the in-frame SDK bundle. Fires for the root
        // Activity entry (frame_id, approach b) and the legacy `play.html?discord=1`.
        if (url === '/play.html' && (activityEntry || (req.query && req.query.discord))) {
            modified = discordEmbedRewrite(modified);
        }
        // DEV-ONLY: force-show the touch-controls walkthrough on every play.html load so
        // it can be iterated without clearing the browser's once-only localStorage flag.
        // Gated on NON-production, so prod NEVER gets it (the walkthrough stays once-only
        // there). Mirrors the perfHarness/env-gated dev seams; inert on the live build.
        if (url === '/play.html' && process.env.NODE_ENV !== 'production' && process.env.NO_DEV_FORCE_WALKTHROUGH !== '1') {
            modified = modified.replace('</head>', '<script>window.__DEV_FORCE_WALKTHROUGH__=true;<\/script></head>');
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
var maintenance = require('./server/maintenance.js');
var reconnect = require('./server/reconnect.js');
var crypto = require('crypto');
var c = utils.loadConfig();

// Tiny per-IP sliding-window rate limiter, shared by the public endpoints
// below. Keyed by client IP. A Map (not a plain object) so a hostile IP string
// can never be a special property name (__proto__, constructor, …) — there's
// no prototype to pollute and key lookups stay O(1) on arbitrary strings.
// Each limiter sweeps its expired keys once per window so an endpoint hit by
// many distinct IPs can't grow the map without bound (entries are otherwise
// only pruned when that same IP calls again). Cheap (runs once per window)
// and harmless while the server sleeps.
function makeRateLimiter(windowMs, maxPerWindow) {
    var hitsByIp = new Map(); // ip -> [timestamps] within the window
    setInterval(function () {
        var now = Date.now();
        hitsByIp.forEach(function (timestamps, ip) {
            var hits = timestamps.filter(function (t) { return now - t < windowMs; });
            if (hits.length === 0) { hitsByIp.delete(ip); }
            else { hitsByIp.set(ip, hits); }
        });
    }, windowMs).unref();
    return function rateLimited(ip) {
        var now = Date.now();
        var hits = (hitsByIp.get(ip) || []).filter(function (t) { return now - t < windowMs; });
        if (hits.length >= maxPerWindow) {
            hitsByIp.set(ip, hits);
            return true;
        }
        hits.push(now);
        hitsByIp.set(ip, hits);
        return false;
    };
}

// In-browser feedback / bug-report endpoint. The widget (client/scripts/feedback.js)
// POSTs here and utils.submitIssue files it as a GitHub issue using the server's
// GITHUB_AUTH token (same credential map-submit uses). Because it's unauthenticated
// and writes to GitHub, it's guarded by: a tight JSON body cap, a hidden honeypot
// field (any value = a bot, silently accepted-and-dropped), and a per-IP rate limit.
var feedbackRateLimited = makeRateLimiter(10 * 60 * 1000, 5);
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

// Deploy-time ops endpoints, live only when OPS_SECRET is set (a Heroku config
// var). The deploy workflow POSTs /ops/drain minutes before pushing the prod
// branch — players get a "races paused" banner and rooms stop starting new
// races — then polls /ops/status until active races finish. Without the secret
// (local dev) or without the right header both endpoints 404, so probes can't
// even tell they exist.
var OPS_SECRET = process.env.OPS_SECRET || null;
function opsAuthorized(req) {
    if (!OPS_SECRET) { return false; }
    var given = req.headers['x-ops-secret'];
    if (typeof given !== 'string') { return false; }
    var a = Buffer.from(given), b = Buffer.from(OPS_SECRET);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Per-IP limiter shared by both ops endpoints, checked BEFORE the secret so
// brute-forcing OPS_SECRET is throttled too. The nightly workflow makes at
// most ~35 calls per run from one runner IP, so 120/10min is generous for
// legitimate use. A limited caller gets the same 404 the cloak uses — it
// can't even tell the endpoints exist. Same trusted-proxy IP resolution as
// /feedback (left-most x-forwarded-for entries are caller-forgeable).
var opsRateLimited = makeRateLimiter(10 * 60 * 1000, 120);
function opsGate(req) {
    var ip = botGuard.resolveClientIp(req.headers['x-forwarded-for'], req.ip) || 'unknown';
    if (opsRateLimited(ip)) { return false; }
    return opsAuthorized(req);
}
app.post('/ops/drain', function (req, res) {
    if (!opsGate(req)) { return res.status(404).end(); }
    // Bound the heads-up window: 0 (announce only) to 15 min, default 3 min.
    var seconds = parseInt(req.query.seconds, 10);
    if (isNaN(seconds)) { seconds = 180; }
    seconds = Math.max(0, Math.min(15 * 60, seconds));
    maintenance.begin(seconds, 'drain');
    res.json({ status: true, seconds: seconds });
});
app.get('/ops/status', function (req, res) {
    if (!opsGate(req)) { return res.status(404).end(); }
    res.json({
        clients: clientCount,
        activeRaces: hostess.countActiveRaces(),
        maintenance: maintenance.getState()
    });
});

// Discord Activity in-frame auth (Phase 4). The Activity POSTs the one-time OAuth
// `code` from sdk.commands.authorize() here; discordAuth exchanges it server-side
// (the client secret never leaves the env), re-validates the Discord identity via
// the Discord API, bridges it to a real Supabase user, and returns the token the
// socket handshake uses. Mounted at BOTH /api/token and /.proxy/api/token: Discord's
// sandbox forwards requests with a /.proxy prefix and may or may not strip it before
// it reaches our origin, so accept either. 404s when Discord auth isn't configured,
// so the route can't be probed on the normal web build. Rate-limited per IP (the
// exchange hits Discord + Supabase) using the same trusted-proxy IP resolution as
// /feedback. Body is tiny (just { code }).
var discordTokenRateLimited = makeRateLimiter(60 * 1000, 30);
// Reject a token exchange whose browser Origin/Referer is a site OTHER than Discord's.
// The legitimate caller is the in-frame fetch from discord(says).com; a malicious page
// trying to replay a victim's one-time code would carry its own origin and be blocked.
// LENIENT by design: the Discord proxy may strip Origin/Referer, so an ABSENT header is
// allowed (we can't fingerprint a server-side replay anyway — the single-use, short-lived
// code + rate limit are the backstop there). Only a PRESENT, non-Discord origin is refused.
function discordOriginOk(req) {
    var src = req.headers.origin || req.headers.referer || '';
    if (!src) { return true; } // no header (proxy-stripped) — allow
    try {
        var host = new URL(src).hostname;
        return host === 'discord.com' ||
            host.slice(-12) === '.discord.com' ||
            host.slice(-16) === '.discordsays.com';
    } catch (e) {
        return false; // a present-but-unparseable origin is suspicious — refuse
    }
}
// Gate (config + origin + per-IP RATE LIMIT) as the FIRST middleware in the route
// chain — runs before express.json, so a 404/403/rate-limited request never even has
// its body parsed, and the rate limiter is visible at the route level.
// Strip control chars (incl. CR/LF) + cap length on any user-supplied value before it
// reaches a log line, so request data can't forge/split log entries.
function logSafe(v) {
    return String(v == null ? "" : v).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200);
}
function discordTokenGate(req, res, next) {
    if (!discordAuth.enabled) { return res.status(404).end(); }
    if (!discordOriginOk(req)) {
        console.log('[discord] /api/token refused: non-Discord origin ' + logSafe(req.headers.origin || req.headers.referer));
        return res.status(403).json({ error: 'bad_origin' });
    }
    var ip = botGuard.resolveClientIp(req.headers['x-forwarded-for'], req.ip) || 'unknown';
    if (discordTokenRateLimited(ip)) {
        return res.status(429).json({ error: 'rate_limited' });
    }
    next();
}
function handleDiscordToken(req, res) {
    var code = req.body && req.body.code;
    console.log('[discord] /api/token hit (path ' + logSafe(req.path) + ', code ' + (code ? 'present' : 'MISSING') + ')');
    discordAuth.authorize(code).then(function (out) {
        console.log('[discord] exchange OK -> name=' + logSafe(out.profile && out.profile.name) +
            ', handshake token ' + (out.token ? 'minted' : 'NULL (player will be guest)'));
        res.json(out);
    }).catch(function (e) {
        console.log('[discord] token exchange failed:', logSafe(e && e.message));
        res.status(400).json({ error: 'exchange_failed' });
    });
}
app.post('/api/token', discordTokenGate, express.json({ limit: '8kb' }), handleDiscordToken);
app.post('/.proxy/api/token', discordTokenGate, express.json({ limit: '8kb' }), handleDiscordToken);

// Dev-only render-perf harness sink (client/scripts/perfharness.js). Registered ONLY
// when PERF_HARNESS is set (c.perfHarness) so prod never exposes the route. The page
// POSTs one JSON row per completed/skipped sample plus a final summary; rows append as
// JSONL to PERF_HARNESS_LOG (default perf-harness-report.jsonl in the repo root) for
// the operator/agent to tail. Defense-in-depth even though the route only exists on a
// local dev server: same express.json body cap as /feedback, a per-IP rate limit, and
// the body is projected through a typed allowlist (numbers coerced, strings stripped
// to printable ASCII and length-capped) so request data never flows raw to disk.
if (c.perfHarness) {
    var perfHarnessLog = process.env.PERF_HARNESS_LOG || path.join(__dirname, 'perf-harness-report.jsonl');
    console.log('[perfHarness] report sink ON -> ' + perfHarnessLog);
    var perfReportLimited = makeRateLimiter(60 * 1000, 600); // ~1 row/2s per device + bursts
    var phNum = function (v) { var n = Number(v); return isFinite(n) ? n : null; };
    var phStr = function (v) {
        return (typeof v === 'string') ? v.replace(/[^\x20-\x7E]/g, '').slice(0, 300) : null;
    };
    // Allowlist projection of one report row. Nested summary `results` are dropped —
    // every row was already streamed (and logged) individually as it completed.
    function cleanPerfRow(b) {
        var row = {};
        ['kind', 'label', 'tier', 'tierLabel', 'reason', 'note', 'v'].forEach(function (k) {
            if (b[k] != null) { row[k] = phStr(b[k]); }
        });
        ['fps', 'worstMs', 'frames', 'durMs', 'state0', 'state1', 'alive', 'ice', 'gl',
            'attempt', 'idx', 'total', 't', 'queued', 'n'].forEach(function (k) {
                if (b[k] != null) { row[k] = phNum(b[k]); }
            });
        if (Array.isArray(b.filter)) { row.filter = b.filter.slice(0, 16).map(phStr); }
        if (b.device && typeof b.device === 'object') {
            var d = {};
            ['ua', 'platform', 'autoTier', 'storedPref'].forEach(function (k) {
                if (b.device[k] != null) { d[k] = phStr(b.device[k]); }
            });
            ['dpr', 'iw', 'ih', 'sw', 'sh', 'cores', 'mem'].forEach(function (k) {
                if (b.device[k] != null) { d[k] = phNum(b.device[k]); }
            });
            d.touch = !!b.device.touch;
            d.resumed = !!b.device.resumed;
            row.device = d;
        }
        return row;
    }
    app.post('/__perf/report', express.json({ limit: '256kb' }), function (req, res) {
        var ip = botGuard.resolveClientIp(req.headers['x-forwarded-for'], req.ip) || 'unknown';
        if (perfReportLimited(ip)) {
            return res.status(429).json({ status: false });
        }
        var row = cleanPerfRow(req.body || {});
        row.serverTime = Date.now();
        try {
            fs.appendFileSync(perfHarnessLog, JSON.stringify(row) + '\n');
        } catch (e) {
            console.log('[perfHarness] write failed: ' + e.message);
        }
        res.json({ status: true });
    });
}

//Base Server vars
var serverSleeping = true,
    pendingReboot = false,
    clientCount = 0,
    serverTickSpeed = c.serverTickSpeed,
    serverUpdates = null;

server.listen(c.port, () => {
  console.log('listening on *:' + c.port);
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

    // A client connecting mid-maintenance missed the broadcast — replay the
    // banner state so they see the countdown/drain notice too.
    var maint = maintenance.getState();
    if (maint != null) { client.emit('serverMaintenance', maint); }

    client.on('disconnect', () => {
      botGuard.unregister(client.id);
      // Park this identity's room seat so a reconnecting socket can re-adopt it
      // (Phase 0 of seamless-reconnect). MUST read identity BEFORE removeMailBox
      // clears it. A maintenance-window drop holds the seat longer (the whole room
      // is restarting); a normal drop parks briefly then self-evicts.
      var idn = messenger.getIdentity(client.id);
      if (idn) {
        reconnect.onDisconnect(reconnect.reconnectKey(idn.userId, idn.deviceId, 0), Date.now(), maintenance.isRaceBlocked());
        reconnect.sweep(Date.now());
      }
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

// Heroku sends SIGTERM at every restart/deploy and SIGKILLs the dyno 30s
// later. Use that fixed grace window: announce a restart countdown to every
// connected player (and block new races via the maintenance gate), keep
// ticking so in-flight races play on, then exit just inside the window. The
// new dyno boots in parallel, so clients reconnect to it right after the
// drop (client.js auto-reloads when a maintenance restart cuts the socket).
// With nobody connected there's no one to warn — exit immediately.
process.on('SIGTERM', function () {
    if (clientCount === 0) {
        console.log('Server shutting down (SIGTERM, idle)');
        process.exit(0);
    }
    console.log('Server shutting down (SIGTERM) — announcing 28s restart countdown to ' + clientCount + ' client(s)');
    maintenance.begin(28, 'restart');
    setTimeout(function () { process.exit(0); }, 28 * 1000);
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
