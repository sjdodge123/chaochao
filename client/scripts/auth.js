// Auth foundation (client). Wraps Supabase sign-in (Google + Discord) and
// exposes the bits the Socket.IO bootstrap needs:
//
//   window.chaochaoAuth.getHandshake()  -> { token, deviceId } for io({ auth })
//   window.chaochaoAuth.signIn(provider) / .signOut()
//   window.chaochaoAuth.ready            -> Promise resolved after the first
//                                           getSession() so callers can await it
//
// Guests still work: if window.__SUPABASE__ wasn't injected (auth disabled) or
// the supabase-js CDN didn't load, getHandshake() returns { token: null, deviceId }
// and sign-in is a no-op. The deviceId is always generated/persisted so the
// server can record it on the account row when the player later signs in.
(function () {
    var DEVICE_KEY = 'chaochao.deviceId';

    function uuid() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
            return window.crypto.randomUUID();
        }
        // Fallback for older browsers without crypto.randomUUID.
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (ch) {
            var r = (Math.random() * 16) | 0;
            var v = ch === 'x' ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        });
    }

    function getDeviceId() {
        var id = null;
        try {
            id = window.localStorage.getItem(DEVICE_KEY);
            if (!id) {
                id = uuid();
                window.localStorage.setItem(DEVICE_KEY, id);
            }
        } catch (e) {
            // localStorage may be unavailable (private mode); fall back to an
            // in-memory id for this session.
            id = id || uuid();
        }
        return id;
    }

    var deviceId = getDeviceId();
    var accessToken = null;
    var currentUser = null;
    var sb = null;

    // Build the Supabase client only when both the injected public config and the
    // CDN UMD global are present. Otherwise we stay in guest-only mode.
    var publicConfig = window.__SUPABASE__ || null;
    if (publicConfig && publicConfig.url && publicConfig.anonKey &&
        window.supabase && typeof window.supabase.createClient === 'function') {
        try {
            sb = window.supabase.createClient(publicConfig.url, publicConfig.anonKey);
        } catch (e) {
            console.log('[auth] failed to init supabase client:', e.message);
            sb = null;
        }
    }

    function applySession(session) {
        accessToken = (session && session.access_token) || null;
        currentUser = (session && session.user) || null;
        renderAuthUI();
    }

    // Resolve the initial session once on load. `ready` lets callers await this,
    // though the socket handshake uses the callback form below and so reads the
    // token at connection time (after this microtask has settled).
    var ready;
    if (sb) {
        ready = sb.auth.getSession().then(function (res) {
            applySession(res && res.data ? res.data.session : null);
        }).catch(function (e) {
            console.log('[auth] getSession failed:', e.message);
        });
        // Keep the cached token fresh across sign-in/out/refresh events.
        sb.auth.onAuthStateChange(function (_event, session) {
            applySession(session);
        });
    } else {
        ready = Promise.resolve();
    }

    function signIn(provider) {
        if (!sb) {
            console.log('[auth] sign-in unavailable (auth disabled).');
            return;
        }
        // Redirect back to the current page; supabase-js completes the session
        // from the URL on return, then a fresh socket handshake carries the token.
        sb.auth.signInWithOAuth({
            provider: provider,
            options: { redirectTo: window.location.href.split('#')[0] }
        });
    }

    function signOut() {
        if (!sb) {
            return;
        }
        sb.auth.signOut().then(function () {
            // Reload so the socket reconnects as a guest.
            window.location.reload();
        });
    }

    // What the Socket.IO handshake sends. token is null for guests.
    function getHandshake() {
        return { token: accessToken, deviceId: deviceId };
    }

    // Minimal sign-in UI wiring. All elements are optional — pages without the
    // auth controls (or with auth disabled) simply skip this.
    function renderAuthUI() {
        var signedOut = document.getElementById('authSignedOut');
        var signedIn = document.getElementById('authSignedIn');
        if (!signedOut || !signedIn) {
            return;
        }
        if (currentUser) {
            signedOut.style.display = 'none';
            signedIn.style.display = '';
            var meta = currentUser.user_metadata || {};
            var name = meta.full_name || meta.name || meta.user_name || currentUser.email || 'Player';
            var nameEl = document.getElementById('authName');
            if (nameEl) nameEl.textContent = name;
            var avatarEl = document.getElementById('authAvatar');
            if (avatarEl) {
                if (meta.avatar_url) {
                    avatarEl.src = meta.avatar_url;
                    avatarEl.style.display = '';
                } else {
                    avatarEl.style.display = 'none';
                }
            }
        } else {
            signedIn.style.display = 'none';
            // Only advertise sign-in when auth is actually available.
            signedOut.style.display = sb ? '' : 'none';
        }
    }

    function wireButtons() {
        var g = document.getElementById('signInGoogle');
        if (g) g.addEventListener('click', function () { signIn('google'); });
        var d = document.getElementById('signInDiscord');
        if (d) d.addEventListener('click', function () { signIn('discord'); });
        var o = document.getElementById('signOut');
        if (o) o.addEventListener('click', function () { signOut(); });
        renderAuthUI();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', wireButtons);
    } else {
        wireButtons();
    }

    window.chaochaoAuth = {
        ready: ready,
        deviceId: deviceId,
        getHandshake: getHandshake,
        signIn: signIn,
        signOut: signOut,
        isSignedIn: function () { return !!currentUser; }
    };
})();
