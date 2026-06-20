// discordActivity.js — Discord Activity bootstrap (Phase 0–2 spike scaffold).
//
// This is the ESM entry for the Discord build. Unlike the rest of client/scripts
// (concatenated global-sharing files via esbuild `transform`), this file imports
// the Embedded App SDK from node_modules and is bundled with esbuild `build()`
// into client/scripts/dist/discord.bundle.min.js (an IIFE). See build.js.
//
// What it does:
//   1. Runs the SDK init handshake (new DiscordSDK(clientId) -> ready()).
//   2. Phase 4 in-frame auth: authorize() -> POST /api/token (server-side code
//      exchange + Supabase bridge) -> authenticate() -> stash the minted handshake
//      token + profile in sessionStorage for play.html's socket connection.
//   3. Surfaces status on the page, then hands off to the game (play.html?discord=1).
//
// NOTE: we deliberately do NOT call patchUrlMappings(). The Activity's root URL Mapping
// already proxies every same-origin path, so plain relative requests (the /api/token
// POST, Socket.IO) work as-is; patchUrlMappings with a root prefix + empty target
// actually MANGLED the fetch (see the boot() comment + the Phase 4 spike notes).
//
// NOT yet implemented (later phases, see docs/spikes/discord-activity.md):
//   - Participants/instance presence -> hostess rooms (Phase 5).
//   - Voice-activity visual (Phase 5b; rpc.voice.read is already requested).
//
// The client id is injected server-side via the <!-- DISCORD_CONFIG --> tag
// (index.js, from the DISCORD_CLIENT_ID env var). No secret is ever exposed.

import { DiscordSDK } from '@discord/embedded-app-sdk';

function setStatus(msg, isError) {
    var el = document.getElementById('discordStatus');
    if (el) {
        el.textContent = msg;
        el.style.color = isError ? '#ff6b6b' : '#cfe3ff';
    }
    // Also log so it shows in the Activity frame's devtools console.
    (isError ? console.error : console.log)('[discord-activity] ' + msg);
}

async function boot() {
    var cfg = (window.__DISCORD__ && window.__DISCORD__.clientId) ? window.__DISCORD__ : null;
    if (!cfg || !cfg.clientId) {
        setStatus(
            'No DISCORD_CLIENT_ID configured on the server — set it in env and reload. ' +
            'See docs/spikes/discord-activity.md.',
            true
        );
        return;
    }

    // NOTE: we deliberately do NOT call patchUrlMappings here. The Activity's root
    // URL Mapping ('/' -> our host) already proxies EVERY same-origin path through the
    // sandbox (that's why the game's Socket.IO on play.html — which never patches —
    // connects fine). patchUrlMappings is for mapping EXTERNAL hosts; calling it with
    // a root prefix '/' and an empty target monkey-patches fetch/XHR to rewrite every
    // same-origin URL into a broken request, which silently killed the /api/token POST
    // here (the page where the patch was active). Same-origin requests just use plain
    // relative paths and ride the root mapping. (Phase 4 live-debug finding.)

    setStatus('Connecting to Discord…');
    var sdk = new DiscordSDK(cfg.clientId);
    try {
        await sdk.ready();
    } catch (e) {
        setStatus('SDK handshake failed: ' + (e && e.message ? e.message : e), true);
        return;
    }

    // Expose for the game/auth phases and mark the runtime as a Discord Activity.
    window.__DISCORD_SDK__ = sdk;
    window.isDiscord = function () { return true; };
    setStatus('Connected (instanceId ' + sdk.instanceId + ').');

    // Phase 4: in-frame auth. Identify the Discord user WITHOUT a full-page OAuth
    // redirect (the iframe blocks those). This MUST happen here, where the SDK
    // instance lives — the handoff below drops it. authorize() yields a one-time
    // code; the server (POST /api/token) exchanges it with the client secret,
    // re-validates the identity, and bridges it to a Supabase user, returning the
    // Discord access token + a minted handshake token + the validated profile. We
    // authenticate() the SDK with the Discord token (needed for the participant /
    // voice phases) and stash the handshake token + profile in sessionStorage for
    // play.html's socket connection. Every step degrades to guest on failure so the
    // game still launches. rpc.voice.read is requested now so Phase 5b can light up
    // the speaking indicator without re-consenting.
    await establishDiscordAuth(sdk, cfg.clientId);

    // Phase 0–2 handoff: navigate to the real game. Same-origin, so it stays
    // inside the mapped sandbox. The `?discord=1` flag tells the server to serve a
    // sandbox-safe play.html — vendored jQuery/Bootstrap instead of CDN tags the
    // proxy would CSP-block (jQuery is a hard boot dep). The stashed token (above)
    // is what makes the game recognize this player rather than a fresh guest.
    setTimeout(function () { window.location.href = 'play.html?discord=1'; }, 600);
}

var AUTH_SCOPES = ['identify', 'rpc.activities.write', 'guilds', 'rpc.voice.read'];
var DISCORD_AUTH_KEY = 'chaochao.discordAuth';

// POST the OAuth code to the token endpoint, trying the proxy-correct path first.
// Only a thrown fetch (network/CSP — request never reached the server) advances to
// the next candidate; any HTTP response (even an error) is returned as-is, because
// it means the server got the code and a retry would double-spend it. The server
// registers BOTH paths, so whichever the sandbox delivers is handled.
async function postCode(code) {
    var paths = ['/api/token', '/.proxy/api/token'];
    var errs = [];
    for (var i = 0; i < paths.length; i++) {
        try {
            return await fetch(paths[i], {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: code })
            });
        } catch (e) {
            var msg = (e && e.message) ? e.message : 'fetch failed';
            errs.push(paths[i] + ' → ' + msg);
            console.warn('[discord-activity] POST ' + paths[i] + ' failed: ' + msg);
        }
    }
    throw new Error(errs.join(' ; '));
}

// authorize -> /api/token -> authenticate -> stash. Resolves whether or not auth
// succeeds — a denied/cancelled authorize, a server without DISCORD_CLIENT_SECRET,
// or an absent Supabase config all just mean "play as guest", never a dead frame.
async function establishDiscordAuth(sdk, clientId) {
    try {
        setStatus('Authorizing with Discord…');
        // No `prompt: 'none'`: that asks Discord to skip the consent UI, which only works
        // if the user has ALREADY granted these exact scopes — a first-time player (or one
        // hit after we add a scope, e.g. rpc.voice.read) would get a consent_required error
        // and be silently demoted to guest instead of seeing the consent dialog. Omitting
        // it shows consent when needed and is silent on repeat launches.
        var authResult = await sdk.commands.authorize({
            client_id: clientId,
            response_type: 'code',
            state: '',
            scope: AUTH_SCOPES
        });
        var code = authResult && authResult.code;
        if (!code) {
            setStatus('No auth code returned by Discord — guest. Launching game…', true);
            return;
        }
        setStatus('Exchanging code…');
        // The Discord sandbox forces traffic through /.proxy; a bare relative
        // fetch('/api/token') is NOT rewritten and gets CSP-blocked, so POST to the
        // explicit /.proxy path first. Fall back to /api/token ONLY on a network/CSP
        // failure (the request never reached the server, so the single-use code is
        // unspent) — never after an HTTP response, which would double-spend the code.
        var resp = await postCode(code);
        if (!resp.ok) {
            console.warn('[discord-activity] /api/token HTTP ' + resp.status);
            setStatus('Token endpoint error ' + resp.status + ' — guest. Launching game…', true);
            return;
        }
        var data = await resp.json();
        // Authenticate the SDK with the Discord access token (unlocks the participant
        // + voice RPC commands the later phases use). Non-fatal if it fails.
        if (data && data.access_token) {
            try {
                await sdk.commands.authenticate({ access_token: data.access_token });
            } catch (e) {
                console.warn('[discord-activity] authenticate failed:', e && e.message);
            }
        }
        // Stash the minted handshake token + validated profile for play.html. Same
        // origin, so sessionStorage survives the navigation; not the URL, so the
        // token never lands in history.
        if (data && data.token) {
            try {
                window.sessionStorage.setItem(DISCORD_AUTH_KEY, JSON.stringify({
                    token: data.token,
                    profile: data.profile || null,
                    // Kept for Phase 5: the redirect to play.html drops this SDK
                    // instance, so presence/voice will re-init the SDK there and
                    // re-authenticate with this token (the `code` is single-use).
                    accessToken: data.access_token || null
                }));
            } catch (e) {
                console.warn('[discord-activity] could not stash auth (guest):', e && e.message);
            }
            var who = (data.profile && data.profile.name) ? data.profile.name : 'Discord player';
            setStatus('Signed in as ' + who + '. Launching game…');
        } else {
            // Identity validated but no handshake token (Supabase/JWT not configured
            // server-side) — the SDK is authenticated, but the game joins as a guest.
            setStatus('Connected (guest — server auth not configured). Launching game…');
        }
    } catch (e) {
        // authorize() rejects on user denial/cancel; postCode throws when every path
        // is network/CSP-blocked. Surface the real reason so the frame is diagnostic.
        console.warn('[discord-activity] auth skipped:', e && e.message);
        setStatus('Auth failed (' + (e && e.message ? e.message : 'unknown') + ') — guest. Launching game…', true);
    }
}

boot().catch(function (e) {
    setStatus('Bootstrap error: ' + (e && e.message ? e.message : e), true);
});
