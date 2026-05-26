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

    // The signed-in profile other client code can read (e.g. the skin station):
    // display name + avatar URL, or null when not signed in.
    function getProfile() {
        if (!currentUser) {
            return null;
        }
        var meta = currentUser.user_metadata || {};
        return {
            name: meta.full_name || meta.name || meta.user_name || currentUser.email || 'Player',
            avatarUrl: meta.avatar_url || null
        };
    }

    // --- Header auth control -------------------------------------------------
    // auth.js injects this into <nav> on every page (one definition → identical
    // everywhere), positioned immediately LEFT of the theme toggle and matching
    // the navbar-control styling. Signed out: a "Log in" pill that opens a
    // Google/Discord popover. Signed in: avatar + name that opens a Sign-out
    // popover. Everything carries data-gp-nav so the controller menu nav (the
    // project standard, NAV_SELECTOR="[data-gp-nav]") can reach it.
    var ctrl = null, menu = null;

    // Let the controller reach the popover's items only while it's open (and
    // skip hidden ones), so the focus ring never lands on an invisible button.
    function setMenuItemsNav(on) {
        if (!menu) { return; }
        var items = menu.querySelectorAll('.auth-menu-item');
        for (var i = 0; i < items.length; i++) {
            if (items[i].hidden) { continue; }
            if (on) { items[i].setAttribute('data-gp-nav', ''); }
            else { items[i].removeAttribute('data-gp-nav'); }
        }
    }
    function openMenu() { if (menu) { menu.hidden = false; setMenuItemsNav(true); } }
    function closeMenu() { if (menu) { menu.hidden = true; setMenuItemsNav(false); } }
    function toggleMenu() { if (menu.hidden) { openMenu(); } else { closeMenu(); } }

    function buildControl() {
        // Only inject when auth is actually available — guests on an
        // auth-disabled server see no login affordance at all.
        if (ctrl || !sb) { return; }
        var nav = document.querySelector('nav');
        if (!nav) { return; }

        ctrl = document.createElement('div');
        ctrl.className = 'auth-control';
        ctrl.innerHTML =
            '<button class="navbar-ctrl auth-trigger" id="authLogin" type="button" data-gp-nav aria-haspopup="true">Log in</button>' +
            '<button class="navbar-ctrl auth-trigger" id="authUser" type="button" data-gp-nav aria-haspopup="true" hidden>' +
                '<img class="auth-avatar" id="authAvatar" alt="" hidden />' +
                '<span id="authName"></span>' +
                '<span class="auth-caret" aria-hidden="true">▾</span>' +
            '</button>' +
            '<div class="auth-menu" id="authMenu" role="menu" hidden>' +
                '<button class="auth-menu-item" id="signInGoogle" type="button" role="menuitem">Continue with Google</button>' +
                '<button class="auth-menu-item" id="signInDiscord" type="button" role="menuitem">Continue with Discord</button>' +
                '<button class="auth-menu-item" id="signOut" type="button" role="menuitem" hidden>Sign out</button>' +
            '</div>';

        // Place it left of the theme toggle regardless of which script injected
        // first (theme.js always appends #themeToggle at the nav's end).
        var themeBtn = document.getElementById('themeToggle');
        if (themeBtn) { nav.insertBefore(ctrl, themeBtn); }
        else { nav.appendChild(ctrl); }

        menu = ctrl.querySelector('#authMenu');
        ctrl.querySelector('#authLogin').addEventListener('click', toggleMenu);
        ctrl.querySelector('#authUser').addEventListener('click', toggleMenu);
        ctrl.querySelector('#signInGoogle').addEventListener('click', function () { signIn('google'); });
        ctrl.querySelector('#signInDiscord').addEventListener('click', function () { signIn('discord'); });
        ctrl.querySelector('#signOut').addEventListener('click', function () { signOut(); });
        document.addEventListener('click', function (e) {
            if (ctrl && !ctrl.contains(e.target)) { closeMenu(); }
        });

        renderAuthUI();
    }

    function renderAuthUI() {
        if (!ctrl) { return; }
        var profile = getProfile();
        var loginBtn = ctrl.querySelector('#authLogin');
        var userBtn = ctrl.querySelector('#authUser');
        var google = ctrl.querySelector('#signInGoogle');
        var discord = ctrl.querySelector('#signInDiscord');
        var out = ctrl.querySelector('#signOut');
        if (profile) {
            loginBtn.hidden = true;
            userBtn.hidden = false;
            ctrl.querySelector('#authName').textContent = profile.name;
            var avatarEl = ctrl.querySelector('#authAvatar');
            if (profile.avatarUrl) { avatarEl.src = profile.avatarUrl; avatarEl.hidden = false; }
            else { avatarEl.hidden = true; }
            google.hidden = true; discord.hidden = true; out.hidden = false;
        } else {
            loginBtn.hidden = false;
            userBtn.hidden = true;
            google.hidden = false; discord.hidden = false; out.hidden = true;
        }
        closeMenu(); // collapse the popover on any auth-state change
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', buildControl);
    } else {
        buildControl();
    }

    // --- Scoreboard login nudge ---------------------------------------------
    // A transient, dismissible toast reminding a NOT-signed-in player to log in
    // to save progress and earn skins. Fired from the game-over/scoreboard
    // screen (client.js). No-op when auth is unavailable or already signed in.
    var toastEl = null, toastTimer = null;
    function buildToast() {
        if (toastEl || !document.body) { return; }
        toastEl = document.createElement('div');
        toastEl.className = 'cc-toast';
        toastEl.setAttribute('role', 'status');
        toastEl.innerHTML =
            '<span class="cc-toast-msg">Sign in to save your progress and earn skins.</span>' +
            '<button class="cc-toast-action" type="button">Log in</button>' +
            '<button class="cc-toast-close" type="button" aria-label="Dismiss">×</button>';
        document.body.appendChild(toastEl);
        toastEl.querySelector('.cc-toast-action').addEventListener('click', function () {
            hideToast();
            var login = document.getElementById('authLogin');
            if (login) { login.click(); } // open the navbar sign-in popover
        });
        toastEl.querySelector('.cc-toast-close').addEventListener('click', hideToast);
    }
    function hideToast() {
        if (toastEl) { toastEl.classList.remove('visible'); }
        if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    }
    function showLoginNudge() {
        if (!sb || currentUser) { return; } // only signed-out players, auth on
        buildToast();
        if (!toastEl) { return; }
        toastEl.classList.add('visible');
        if (toastTimer) { clearTimeout(toastTimer); }
        toastTimer = setTimeout(hideToast, 9000);
    }

    window.chaochaoAuth = {
        ready: ready,
        available: !!sb,   // Supabase configured + CDN loaded (auth actually usable)
        showLoginNudge: showLoginNudge,
        deviceId: deviceId,
        getHandshake: getHandshake,
        getProfile: getProfile,
        signIn: signIn,
        signOut: signOut,
        isSignedIn: function () { return !!currentUser; }
    };
})();
