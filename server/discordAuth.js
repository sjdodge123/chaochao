// Discord Activity in-frame auth bridge (Phase 4). Server-side OAuth code exchange +
// identity validation. The CLIENT SECRET lives ONLY here (env), never in any bundle.
//
// Flow: the Activity (client/scripts/discordActivity.js) runs the Embedded SDK
// authorize() inside the iframe and POSTs the resulting one-time `code` to /api/token.
// This module exchanges it for a Discord access token using the secret, RE-VALIDATES
// the identity via the Discord API (we never trust the SDK-supplied user object),
// bridges it to a real Supabase user (server/auth.js), and mints a Supabase-compatible
// token for the socket handshake. The client also gets the raw Discord access token to
// hand to sdk.commands.authenticate() (needed for the participant/voice phases).
//
// Env (server-only):
//   DISCORD_CLIENT_ID      — public app id (also injected into discord.html).
//   DISCORD_CLIENT_SECRET  — OAuth2 client secret. SERVER ONLY. Never bundled.
//
// Uses Node's global fetch (Node 18+); no new dependency. Degrades to disabled (the
// /api/token route 404s) when the secret is absent, so the normal web build is
// unaffected and the endpoint can't be probed.

var auth = require('./auth.js');

var CLIENT_ID = process.env.DISCORD_CLIENT_ID || null;
var CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || null;
var enabled = !!(CLIENT_ID && CLIENT_SECRET);

if (CLIENT_ID && !CLIENT_SECRET) {
    console.log('[discord] DISCORD_CLIENT_ID set but DISCORD_CLIENT_SECRET missing — in-frame auth DISABLED (Activity players stay guests).');
} else if (enabled) {
    console.log('[discord] in-frame auth ENABLED (token exchange + Supabase bridge).');
}

// A usable avatar URL on Discord's CDN (already avatar-allowlisted in messenger.js),
// or a default avatar when the user has none. Animated avatars use an a_ hash -> .gif.
function avatarUrlFor(user) {
    if (!user || !user.id) { return null; }
    if (user.avatar) {
        var animated = String(user.avatar).indexOf('a_') === 0;
        return 'https://cdn.discordapp.com/avatars/' + user.id + '/' + user.avatar +
            (animated ? '.gif' : '.png') + '?size=128';
    }
    // New-username default avatar index is (id >> 22) % 6; legacy used discriminator % 5.
    var idx = 0;
    try { idx = Number((BigInt(user.id) >> 22n) % 6n); } catch (e) { idx = 0; }
    return 'https://cdn.discordapp.com/embed/avatars/' + idx + '.png';
}

function displayNameFor(user) {
    if (!user) { return null; }
    return user.global_name || user.username || null;
}

async function exchangeCode(code) {
    var body = new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: code
    });
    var res = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body
    });
    if (!res.ok) {
        var txt = await res.text().catch(function () { return ''; });
        throw new Error('token exchange ' + res.status + ' ' + String(txt).slice(0, 200));
    }
    return res.json();
}

async function fetchDiscordUser(accessToken) {
    var res = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: 'Bearer ' + accessToken }
    });
    if (!res.ok) {
        throw new Error('users/@me ' + res.status);
    }
    return res.json();
}

// Full bridge: a one-time OAuth code -> { accessToken, token, profile }, or throws.
//   accessToken — the Discord token; the client passes it to sdk.commands.authenticate().
//   token       — the minted Supabase-compatible JWT for the socket handshake (may be
//                 null when Supabase auth/the JWT secret isn't configured, in which case
//                 the player still authenticates the SDK but joins the game as a guest).
//   profile     — the SERVER-VALIDATED display name + avatar URL.
async function authorize(code) {
    if (!enabled) {
        throw new Error('discord auth not configured');
    }
    if (typeof code !== 'string' || !code || code.length > 1024) {
        throw new Error('bad code');
    }
    var tokenRes = await exchangeCode(code);
    var accessToken = tokenRes && tokenRes.access_token;
    if (!accessToken) {
        throw new Error('no access_token in exchange response');
    }
    // Re-validate the identity server-side; never trust SDK-supplied user data.
    var user = await fetchDiscordUser(accessToken);
    if (!user || !user.id) {
        throw new Error('no user from /users/@me');
    }
    var profile = { name: displayNameFor(user), avatarUrl: avatarUrlFor(user) };
    var resolved = await auth.findOrCreateDiscordUser({
        id: user.id, name: profile.name, avatarUrl: profile.avatarUrl
    });
    var token = (resolved && resolved.userId)
        ? auth.mintAccessToken(resolved.userId, { name: profile.name, avatarUrl: profile.avatarUrl })
        : null;
    return { accessToken: accessToken, token: token, profile: profile };
}

exports.enabled = enabled;
exports.authorize = authorize;
