// discordPresence.js — Discord Activity presence (Phase 5): a LIVE SDK instance in
// the GAME frame, instance→room routing, and a participant map.
//
// THE PROBLEM THIS SOLVES. Auth (Phase 4) runs in discord.html, where the SDK lives,
// then redirects to play.html?discord=1 — and that navigation DROPS the SDK instance.
// But room-grouping by voice channel needs `sdk.instanceId`, and the speaking-kart
// visual (Phase 5b) needs the connected-participant list, both of which require a
// live SDK *where the game runs*. So we re-init the SDK here, in the game frame
// (approach (a) from the spike doc — lighter than hosting the whole game in the
// Activity frame, and the access token is already stashed for exactly this).
//
// Like discordActivity.js, this is the one exception to the concat-globals bundle
// model: it IMPORTS the Embedded App SDK from node_modules, so it's bundled
// separately via esbuild `build()` into discord-presence.bundle.min.js (an IIFE)
// and only loaded into play.html for the Discord build (index.js discordEmbedRewrite).
//
// It exposes `window.discordPresence`:
//   .ready              Promise<{ instanceId }> — resolves once the SDK handshake is
//                       done and instanceId is known (room routing waits on this).
//                       NEVER rejects: a failed init resolves with instanceId:null so
//                       the game still launches (falls back to normal matchmaking).
//   .instanceId         string|null — the Discord activity instance id (room key).
//   .channelId          string|null — voice channel id (Phase 5b voice subscribe).
//   .localUserId        string|null — the authenticated Discord user's snowflake.
//   .getParticipants()  -> [{ id, name, avatarUrl, isLocal, bot, raw }] — the live
//                       connected-participant list, keyed for Phase 5b's speaking
//                       indicator (Discord user_id -> kart). Empty until authed.
//   .onParticipants(cb) subscribe to participant-list changes (cb gets the array).
//   .sdk                the live DiscordSDK instance (Phase 5b voice commands).
//
// SECURITY NOTE: participant data here is client-supplied (SDK RPC) and is used ONLY
// for cosmetic room-grouping + the voice visual — never for anything trust-sensitive.
// The player's account identity is still resolved server-side from the Phase-4 token.

import { DiscordSDK } from '@discord/embedded-app-sdk';

var DISCORD_AUTH_KEY = 'chaochao.discordAuth';
var PARTICIPANTS_UPDATE = 'ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE';

function log(msg) { try { console.log('[discord-presence] ' + msg); } catch (e) {} }
function warn(msg) { try { console.warn('[discord-presence] ' + msg); } catch (e) {} }

// Build a cdn.discordapp.com avatar URL the same way the server does (avatarUrlFor in
// server/discordAuth.js) so the Phase 5b voice tray matches the kart avatar skins.
function avatarUrlFor(p) {
    if (!p || !p.id) { return null; }
    if (p.avatar) {
        var animated = String(p.avatar).indexOf('a_') === 0;
        return 'https://cdn.discordapp.com/avatars/' + p.id + '/' + p.avatar +
            (animated ? '.gif' : '.png') + '?size=128';
    }
    // Default avatar: new-username scheme is (id >> 22) % 6 (BigInt — snowflakes
    // exceed 2^53), legacy used discriminator % 5.
    var idx = 0;
    try {
        if (p.discriminator && p.discriminator !== '0') {
            idx = parseInt(p.discriminator, 10) % 5;
        } else if (typeof BigInt === 'function') {
            idx = Number((BigInt(p.id) >> BigInt(22)) % BigInt(6));
        }
    } catch (e) { idx = 0; }
    return 'https://cdn.discordapp.com/embed/avatars/' + idx + '.png';
}

function nameFor(p) {
    if (!p) { return null; }
    return p.nickname || p.global_name || p.username || null;
}

function normalizeParticipant(p, localUserId) {
    return {
        id: p.id,
        name: nameFor(p),
        avatarUrl: avatarUrlFor(p),
        isLocal: localUserId != null && p.id === localUserId,
        bot: !!p.bot,
        raw: p
    };
}

(function () {
    // Resolve the SDK only when there's a stash with the clientId + access token
    // (i.e. Phase-4 auth ran in discord.html). Without it we can't (re)construct the
    // SDK, so presence is a no-op and the game matchmakes normally.
    var stash = null;
    try {
        var raw = window.sessionStorage.getItem(DISCORD_AUTH_KEY);
        if (raw) { stash = JSON.parse(raw); }
    } catch (e) { stash = null; }

    // Live presence state. Surfaced synchronously (so client.js can read .ready
    // immediately even though it resolves later); fields fill in as init proceeds.
    var participants = [];
    var listeners = [];
    var api = {
        instanceId: null,
        channelId: null,
        localUserId: null,
        sdk: null,
        getParticipants: function () { return participants.slice(); },
        onParticipants: function (cb) {
            if (typeof cb === 'function') {
                listeners.push(cb);
                // Emit current state immediately so a late subscriber isn't blind
                // until the next update.
                try { cb(participants.slice()); } catch (e) {}
            }
        },
        ready: null // set below
    };
    window.discordPresence = api;

    function emitParticipants() {
        var snapshot = participants.slice();
        for (var i = 0; i < listeners.length; i++) {
            try { listeners[i](snapshot); } catch (e) {}
        }
    }

    function setParticipants(list, localUserId) {
        if (!list) { return; }
        participants = list.map(function (p) { return normalizeParticipant(p, localUserId); });
        log('participants: ' + participants.length + ' (' +
            participants.map(function (p) { return p.name; }).join(', ') + ')');
        emitParticipants();
    }

    if (!stash || !stash.clientId) {
        log('no Discord auth stash — presence disabled (normal matchmaking).');
        api.ready = Promise.resolve({ instanceId: null });
        return;
    }

    // Resolve .ready as soon as we know the instanceId (after sdk.ready()), which is
    // all room routing needs and does NOT require authenticate(). Participants come
    // later, best-effort. We capture the resolver so the SDK init can settle it.
    var resolveReady;
    api.ready = new Promise(function (res) { resolveReady = res; });
    var readySettled = false;
    function settleReady() {
        if (!readySettled) { readySettled = true; resolveReady({ instanceId: api.instanceId }); }
    }
    // Hard backstop: never let a hung SDK handshake block the game's room join.
    setTimeout(function () {
        if (!readySettled) { warn('SDK init timed out — falling back to normal matchmaking.'); settleReady(); }
    }, 8000);

    (async function initPresence() {
        var sdk = new DiscordSDK(stash.clientId);
        api.sdk = sdk;
        try {
            await sdk.ready();
        } catch (e) {
            warn('SDK handshake failed: ' + (e && e.message));
            settleReady();
            return;
        }
        // instanceId is available from the SDK launch params after ready(); no auth
        // needed. This is the room key — settle .ready now so routing can proceed
        // even if the participant calls below fail.
        api.instanceId = sdk.instanceId || null;
        api.channelId = sdk.channelId || null;
        log('live SDK in game frame — instanceId ' + api.instanceId + ', channelId ' + api.channelId);
        settleReady();

        // Re-authenticate with the stashed access token. The participant RPC commands
        // require an authenticated SDK. Best-effort: if it fails (token expired /
        // scope denied), room routing already works; only the 5b roster is lost.
        if (!stash.accessToken) {
            warn('no stashed access token — participant list unavailable (room routing still works).');
            return;
        }
        var authUser = null;
        try {
            var authRes = await sdk.commands.authenticate({ access_token: stash.accessToken });
            authUser = authRes && authRes.user;
            api.localUserId = (authUser && authUser.id) || null;
            log('SDK re-authenticated as ' + (authUser && (authUser.global_name || authUser.username)) + ' (' + api.localUserId + ').');
        } catch (e) {
            warn('authenticate failed: ' + (e && e.message) + ' — participant list unavailable.');
            return;
        }

        // Seed the participant list, then subscribe to keep it live as players join/
        // leave the instance. Discord delivers both as { participants: [...] }.
        try {
            var seed = await sdk.commands.getInstanceConnectedParticipants();
            setParticipants(seed && seed.participants, api.localUserId);
        } catch (e) {
            warn('getInstanceConnectedParticipants failed: ' + (e && e.message));
        }
        try {
            await sdk.subscribe(PARTICIPANTS_UPDATE, function (payload) {
                setParticipants(payload && payload.participants, api.localUserId);
            });
            log('subscribed ' + PARTICIPANTS_UPDATE + '.');
        } catch (e) {
            warn('subscribe ' + PARTICIPANTS_UPDATE + ' failed: ' + (e && e.message));
        }
    })().catch(function (e) {
        warn('presence init error: ' + (e && e.message));
        settleReady();
    });
})();
