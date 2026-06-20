// discordActivity.js — Discord Activity bootstrap (Phase 0–2 spike scaffold).
//
// This is the ESM entry for the Discord build. Unlike the rest of client/scripts
// (concatenated global-sharing files via esbuild `transform`), this file imports
// the Embedded App SDK from node_modules and is bundled with esbuild `build()`
// into client/scripts/dist/discord.bundle.min.js (an IIFE). See build.js.
//
// What it does (spike scope):
//   1. patchUrlMappings() so fetch/WebSocket/XHR route through Discord's
//      /.proxy/ sandbox identically in dev (un-sandboxed) and prod (sandboxed).
//   2. Runs the SDK init handshake (new DiscordSDK(clientId) -> ready()).
//   3. Surfaces status on the page so the operator can SEE it work inside the
//      Discord frame, then hands off to the existing game (play.html).
//
// NOT yet implemented (later phases, see docs/spikes/discord-activity.md):
//   - Auth: authorize -> POST /.proxy/api/token (server) -> authenticate,
//     bridged to a Supabase session (Phase 4).
//   - Participants/instance presence -> hostess rooms (Phase 5).
//
// The client id is injected server-side via the <!-- DISCORD_CONFIG --> tag
// (index.js, from the DISCORD_CLIENT_ID env var). No secret is ever exposed.

import { DiscordSDK, patchUrlMappings } from '@discord/embedded-app-sdk';

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

    // Route ALL network traffic through the sandbox proxy. Doing this before the
    // SDK constructs anything keeps dev and prod behaviour identical and is what
    // lets the same-origin Socket.IO connection survive inside the iframe.
    try {
        patchUrlMappings([{ prefix: '/', target: cfg.mappingTarget || '' }]);
    } catch (e) {
        // patchUrlMappings is best-effort here; the authoritative routing is the
        // URL Mappings configured in the Developer Portal. Don't hard-fail.
        console.warn('[discord-activity] patchUrlMappings skipped:', e && e.message);
    }

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

// authorize -> /api/token -> authenticate -> stash. Resolves whether or not auth
// succeeds — a denied/cancelled authorize, a server without DISCORD_CLIENT_SECRET,
// or an absent Supabase config all just mean "play as guest", never a dead frame.
async function establishDiscordAuth(sdk, clientId) {
    try {
        setStatus('Authorizing with Discord…');
        var authResult = await sdk.commands.authorize({
            client_id: clientId,
            response_type: 'code',
            state: '',
            prompt: 'none',
            scope: AUTH_SCOPES
        });
        var code = authResult && authResult.code;
        if (!code) {
            setStatus('Continuing as guest. Launching game…');
            return;
        }
        // patchUrlMappings (run in boot()) already routes this through /.proxy.
        var resp = await fetch('/api/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: code })
        });
        if (!resp.ok) {
            console.warn('[discord-activity] /api/token HTTP ' + resp.status);
            setStatus('Continuing as guest. Launching game…');
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
        // authorize() rejects on user denial/cancel; play as guest.
        console.warn('[discord-activity] auth skipped:', e && e.message);
        setStatus('Continuing as guest. Launching game…');
    }
}

boot().catch(function (e) {
    setStatus('Bootstrap error: ' + (e && e.message ? e.message : e), true);
});
