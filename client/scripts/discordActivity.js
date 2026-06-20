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
    setStatus('Connected (instanceId ' + sdk.instanceId + '). Launching game…');

    // Phase 0–2 handoff: navigate to the real game. Same-origin, so it stays
    // inside the mapped sandbox. Auth + presence wiring replaces this in later
    // phases (the game would be hosted in this frame rather than redirected to).
    setTimeout(function () { window.location.href = 'play.html'; }, 600);
}

boot().catch(function (e) {
    setStatus('Bootstrap error: ' + (e && e.message ? e.message : e), true);
});
