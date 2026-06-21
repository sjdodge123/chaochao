// discordPresence.js — Discord Activity in-frame bootstrap (approach (b): no navigation).
//
// WHY THIS EXISTS / what changed. The original design loaded discord.html, ran the SDK
// + auth there, then REDIRECTED to play.html?discord=1. That navigation broke everything
// SDK-related: the Embedded App SDK can only complete its RPC handshake ONCE per Activity
// frame (proven live — a re-init in the navigated frame never gets READY, even forcing
// targetOrigin '*'), and it reads its launch params + handshake target from the URL/
// document.referrer that the navigation changed. So we DON'T navigate: Discord loads
// play.html directly as the Activity entry (index.js serves it at the mapped root when
// frame_id is present), and THIS module — bundled separately because it imports the SDK —
// runs the whole Discord lifecycle in the game frame off a single, live SDK:
//   1. new DiscordSDK(clientId) + ready()              (the one handshake; works here)
//   2. authorize() -> POST /api/token -> authenticate()  (Phase-4 auth, now in-frame)
//   3. hand the minted session to auth.js (adoptDiscordSession) so the game's socket
//      connects authenticated WITHOUT a redirect — game.js waits on chaochaoAuth.ready.
//   4. instanceId/channelId + participants + SPEAKING events (Phase 5 / 5b).
//
// clientId comes from window.__DISCORD__ (injected into play.html for the Activity build).
// No secret is ever exposed; the token exchange is server-side (POST /api/token).
//
// window.discordPresence API (consumed by client.js + discordVoice.js):
//   .ready              Promise<{instanceId}> — resolves immediately from the URL launch
//                       param (routing never blocks on auth/SDK). Never rejects.
//   .instanceId/.channelId/.localUserId
//   .getParticipants()/.onParticipants(cb)   — voice-channel roster (Phase 5b tray)
//   .isSpeaking(id)/.getSpeaking()/.onSpeaking(cb) — live speaking set (Phase 5b)
//   .localUser          Promise<string|null>  — local Discord snowflake (for setVoiceId)
//   .getDiag()          debug snapshot (shipped to the server log under DISCORD_DEBUG=1)
//   .sdk                the live DiscordSDK instance

import { DiscordSDK } from '@discord/embedded-app-sdk';

var PARTICIPANTS_UPDATE = 'ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE';
var AUTH_SCOPES = ['identify', 'rpc.activities.write', 'guilds', 'rpc.voice.read'];

var logBuffer = [];
function record(level, msg) { logBuffer.push(level + ': ' + msg); if (logBuffer.length > 60) { logBuffer.shift(); } }
function log(msg) { record('log', msg); try { console.log('[discord-presence] ' + msg); } catch (e) {} }
function warn(msg) { record('warn', msg); try { console.warn('[discord-presence] ' + msg); } catch (e) {} }

// Build a cdn.discordapp.com avatar URL the same way the server does (avatarUrlFor in
// server/discordAuth.js) so the voice tray matches the kart avatar skins.
function avatarUrlFor(p) {
    if (!p || !p.id) { return null; }
    if (p.avatar) {
        var animated = String(p.avatar).indexOf('a_') === 0;
        return 'https://cdn.discordapp.com/avatars/' + p.id + '/' + p.avatar +
            (animated ? '.gif' : '.png') + '?size=128';
    }
    var idx = 0;
    try {
        if (p.discriminator && p.discriminator !== '0') { idx = parseInt(p.discriminator, 10) % 5; }
        else if (typeof BigInt === 'function') { idx = Number((BigInt(p.id) >> BigInt(22)) % BigInt(6)); }
    } catch (e) { idx = 0; }
    return 'https://cdn.discordapp.com/embed/avatars/' + idx + '.png';
}
function nameFor(p) { return p ? (p.nickname || p.global_name || p.username || null) : null; }
function normalizeParticipant(p, localUserId) {
    return { id: p.id, name: nameFor(p), avatarUrl: avatarUrlFor(p), isLocal: localUserId != null && p.id === localUserId, bot: !!p.bot, raw: p };
}

// POST the OAuth code to the token endpoint. The Discord sandbox forces traffic through
// /.proxy, but the Activity's root URL Mapping already proxies same-origin paths, so a
// plain relative fetch works; we still try the explicit /.proxy path as a fallback. Only a
// THROWN fetch (network/CSP — request never reached the server) advances to the next
// candidate; any HTTP response is returned as-is (a retry would double-spend the code).
async function postCode(code) {
    var paths = ['/api/token', '/.proxy/api/token'];
    var errs = [];
    for (var i = 0; i < paths.length; i++) {
        try {
            return await fetch(paths[i], { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code }) });
        } catch (e) { errs.push(paths[i] + ' → ' + ((e && e.message) || 'fetch failed')); }
    }
    throw new Error(errs.join(' ; '));
}

// Authorize for our scopes, returning { code }. Try prompt:'none' FIRST so a player who
// already granted these scopes is authorized SILENTLY (no consent dialog every launch);
// fall back to a normal authorize() that shows consent the once.
async function authorizeForScopes(sdk, clientId) {
    var base = { client_id: clientId, response_type: 'code', state: '', scope: AUTH_SCOPES };
    try { return await sdk.commands.authorize(Object.assign({ prompt: 'none' }, base)); }
    catch (e) { warn('silent authorize failed (' + (e && e.message) + ') — prompting consent'); return await sdk.commands.authorize(base); }
}

(function () {
    var cfg = (window.__DISCORD__ && window.__DISCORD__.clientId) ? window.__DISCORD__ : null;
    var clientId = cfg ? cfg.clientId : null;

    var participants = [];
    var listeners = [];
    var speaking = {};
    var speakingListeners = [];
    var resolveLocalUser;
    var gotToken = false;
    var api = {
        instanceId: null,
        channelId: null,
        localUserId: null,
        sdk: null,
        getParticipants: function () { return participants.slice(); },
        onParticipants: function (cb) { if (typeof cb === 'function') { listeners.push(cb); try { cb(participants.slice()); } catch (e) {} } },
        localUser: new Promise(function (res) { resolveLocalUser = res; }),
        isSpeaking: function (userId) { return userId != null && speaking[userId] === true; },
        getSpeaking: function () { return Object.keys(speaking); },
        onSpeaking: function (cb) { if (typeof cb === 'function') { speakingListeners.push(cb); try { cb(Object.keys(speaking)); } catch (e) {} } },
        getDiag: function () {
            return {
                hasClientId: !!clientId, hasToken: gotToken,
                instanceId: api.instanceId, channelId: api.channelId, localUserId: api.localUserId,
                participantCount: participants.length, participantNames: participants.map(function (p) { return p.name; }),
                speakingCount: Object.keys(speaking).length, log: logBuffer.slice()
            };
        },
        ready: null
    };
    window.discordPresence = api;

    function emitParticipants() { var s = participants.slice(); for (var i = 0; i < listeners.length; i++) { try { listeners[i](s); } catch (e) {} } }
    function emitSpeaking() { var s = Object.keys(speaking); for (var i = 0; i < speakingListeners.length; i++) { try { speakingListeners[i](s); } catch (e) {} } }
    function setParticipants(list, localUserId) {
        if (!list) { return; }
        participants = list.map(function (p) { return normalizeParticipant(p, localUserId); });
        log('participants: ' + participants.length + ' (' + participants.map(function (p) { return p.name; }).join(', ') + ')');
        emitParticipants();
    }
    function setSpeaking(userId, on) {
        if (!userId) { return; }
        if (on) { if (speaking[userId]) { return; } speaking[userId] = true; }
        else { if (!speaking[userId]) { return; } delete speaking[userId]; }
        emitSpeaking();
    }

    // ROOM ROUTING (Phase 5): instanceId from the launch param. Resolve .ready immediately
    // so enterGame never waits on auth/SDK. (The SDK below ALSO sets instanceId, but this
    // guarantees routing even if the SDK/auth path hiccups.)
    try {
        var urlp = new URLSearchParams(window.location.search);
        api.instanceId = urlp.get('instance_id') || null;
        api.channelId = urlp.get('channel_id') || null;
    } catch (e) { /* leave null */ }
    api.ready = Promise.resolve({ instanceId: api.instanceId });
    log('routing instanceId from launch param: ' + api.instanceId);

    // Hand a (possibly guest) session to auth.js so the game's connect-gate (which awaits
    // chaochaoAuth.ready) always unblocks — even if Discord auth fails, we connect as guest.
    function adoptSession(token, profile) {
        if (window.chaochaoAuth && typeof window.chaochaoAuth.adoptDiscordSession === 'function') {
            window.chaochaoAuth.adoptDiscordSession(token || null, profile || null);
        }
    }

    if (!clientId) {
        warn('no DISCORD_CLIENT_ID injected — presence/auth disabled (guest).');
        resolveLocalUser(null);
        adoptSession(null, null);
        return;
    }

    (async function init() {
        var sdk = new DiscordSDK(clientId);
        api.sdk = sdk;
        try {
            await sdk.ready();
        } catch (e) {
            warn('SDK handshake failed: ' + (e && e.message) + ' — guest.');
            resolveLocalUser(null);
            adoptSession(null, null);
            return;
        }
        api.instanceId = sdk.instanceId || api.instanceId;
        api.channelId = sdk.channelId || api.channelId;
        log('live SDK in game frame — instanceId ' + api.instanceId + ', channelId ' + api.channelId);

        // chaochao is a fixed 16:9 LANDSCAPE arena (portrait shows only a rotate
        // prompt). On Discord MOBILE, lock the frame to landscape so the player
        // never lands on that prompt; desktop ignores it (no-op). lock_state 3 =
        // LANDSCAPE (Common.OrientationLockStateTypeObject). Best-effort — an older
        // client / unsupported platform just rejects and we carry on.
        try {
            await sdk.commands.setOrientationLockState({ lock_state: 3 });
            log('orientation locked to landscape.');
        } catch (e) { warn('setOrientationLockState failed (ignored): ' + (e && e.message)); }

        // ---- Auth (Phase 4, now in-frame) ----
        var data = null;
        var authUser = null;   // captured from authenticate() — carries our Discord snowflake
        try {
            var authResult = await authorizeForScopes(sdk, clientId);
            var code = authResult && authResult.code;
            if (!code) { throw new Error('no auth code from Discord'); }
            var resp = await postCode(code);
            if (!resp.ok) { throw new Error('/api/token HTTP ' + resp.status); }
            data = await resp.json();
            if (data && data.accessToken) {
                try {
                    // authenticate() returns our { user } (incl. the snowflake) — capture it
                    // HERE. Calling authenticate() a SECOND time later throws "Already
                    // authenticated", which previously left localUserId null (no kart ring).
                    var authRes = await sdk.commands.authenticate({ access_token: data.accessToken });
                    authUser = authRes && authRes.user;
                    api.localUserId = (authUser && authUser.id) || null;
                } catch (e) { warn('authenticate failed: ' + (e && e.message)); }
            }
            gotToken = !!(data && data.token);
            log('auth OK — ' + (data && data.profile && data.profile.name ? data.profile.name : 'unknown') + ' (localUserId ' + api.localUserId + ')' + (gotToken ? ' (handshake token minted)' : ' (guest token)'));
        } catch (e) {
            warn('auth failed: ' + (e && e.message) + ' — guest.');
        }
        // Drive the socket handshake: hand the minted session (or guest) to auth.js.
        adoptSession(data && data.token, data && data.profile);

        // ---- Presence / voice (Phase 5 / 5b) ----
        // localUserId was captured from the single authenticate() above (the snowflake the
        // client reports via setVoiceId so its own kart gets the speaking ring).
        if (!data || !data.accessToken) {
            warn('no access token — participants/voice unavailable (routing still works).');
            resolveLocalUser(null);
            return;
        }
        resolveLocalUser(api.localUserId);

        try {
            var seed = await sdk.commands.getInstanceConnectedParticipants();
            setParticipants(seed && seed.participants, api.localUserId);
        } catch (e) { warn('getInstanceConnectedParticipants failed: ' + (e && e.message)); }
        try {
            await sdk.subscribe(PARTICIPANTS_UPDATE, function (payload) { setParticipants(payload && payload.participants, api.localUserId); });
            log('subscribed ' + PARTICIPANTS_UPDATE + '.');
        } catch (e) { warn('subscribe ' + PARTICIPANTS_UPDATE + ' failed: ' + (e && e.message)); }

        if (!api.channelId) { log('no voice channel — speaking indicator inactive.'); return; }
        try {
            await sdk.subscribe('SPEAKING_START', function (e) { setSpeaking(e && e.user_id, true); }, { channel_id: api.channelId });
            await sdk.subscribe('SPEAKING_STOP', function (e) { setSpeaking(e && e.user_id, false); }, { channel_id: api.channelId });
            log('subscribed SPEAKING_START/STOP for channel ' + api.channelId + '.');
        } catch (e) { warn('subscribe SPEAKING_* failed (scope denied?): ' + (e && e.message)); }
    })().catch(function (e) {
        warn('init error: ' + (e && e.message) + ' — guest.');
        resolveLocalUser(null);
        adoptSession(null, null);
    });
})();
