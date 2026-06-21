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

    // Discord Activity in-frame session (Phase 4). discordActivity.js validated the
    // player server-side and stashed a minted handshake token + profile here before
    // handing off to play.html?discord=1. In that mode we DON'T build a Supabase
    // client (its CDN is sandbox-blocked anyway): the handshake token and profile
    // come straight from the stash, and the existing socket path treats this exactly
    // like a signed-in web player (the server resolves the real user_id from the token).
    var discordSession = null;
    try {
        var rawDiscord = window.sessionStorage.getItem('chaochao.discordAuth');
        if (rawDiscord) { discordSession = JSON.parse(rawDiscord); }
    } catch (e) { discordSession = null; }

    // Discord Activity (approach b — no navigation): play.html IS the Activity entry, so
    // the in-frame bootstrap (discordPresence.js) runs the OAuth/token exchange and calls
    // chaochaoAuth.adoptDiscordSession(token, profile) when done — there's no pre-load
    // stash. Detect the context (Discord appends frame_id to the iframe URL; the legacy
    // redirect used ?discord=1) and, when in it, DON'T build a Supabase client (we use the
    // in-frame session) and make `ready` wait for adoptDiscordSession — capped in game.js —
    // so the socket handshake carries the token. A deferred fills that role.
    var isDiscordCtx = false;
    try {
        var dsearch = window.location.search || '';
        isDiscordCtx = /[?&]frame_id=/.test(dsearch) || /[?&]discord=1(?:&|$)/.test(dsearch) || !!(discordSession && discordSession.token);
    } catch (e) { isDiscordCtx = false; }
    var discordReadyResolve = null;
    var discordReady = new Promise(function (res) { discordReadyResolve = res; });

    // Build the Supabase client only when both the injected public config and the
    // CDN UMD global are present (and we're NOT in a Discord session). Otherwise we
    // stay in guest-only mode.
    var publicConfig = window.__SUPABASE__ || null;
    if (!isDiscordCtx &&
        publicConfig && publicConfig.url && publicConfig.anonKey &&
        window.supabase && typeof window.supabase.createClient === 'function') {
        try {
            sb = window.supabase.createClient(publicConfig.url, publicConfig.anonKey);
        } catch (e) {
            console.log('[auth] failed to init supabase client:', e.message);
            sb = null;
        }
    }

    // Adopt the Discord session synchronously so the very first socket handshake
    // carries the token. A synthetic `currentUser` drives getProfile()/isSignedIn()/
    // getAuthState() off the validated profile; the opaque id is never sent to the
    // server (identity is resolved from the token), it only marks "signed in" locally.
    // Adopt a Discord session into the local auth state (signed-in look + handshake token).
    // The opaque id 'discord' is never sent to the server (identity is resolved from the
    // token); it only marks "signed in" locally and drives getProfile()/getAuthState().
    // Used by BOTH the legacy stash path (below) and the in-frame bootstrap
    // (adoptDiscordSession, approach b). token null => stay guest. Always settles the
    // discordReady deferred so the connect-gate unblocks either way.
    function applyDiscordSession(token, profile) {
        if (token) {
            accessToken = token;
            var dp = profile || {};
            currentUser = {
                id: 'discord',
                app_metadata: { provider: 'discord' },
                user_metadata: { full_name: dp.name || null, avatar_url: dp.avatarUrl || null }
            };
            if (typeof renderAuthUI === 'function') { renderAuthUI(); }
            if (typeof window.updateGAUserProperties === 'function') { window.updateGAUserProperties(); }
            // If the socket already connected as a guest (token arrived after the connect-
            // gate's cap), let the game decide whether to reload so the handshake re-runs
            // with the token. No-op if the connect hasn't happened yet (it'll carry the token).
            if (typeof window.__onDiscordTokenAdopted === 'function') { window.__onDiscordTokenAdopted(); }
        }
        if (discordReadyResolve) { discordReadyResolve(); discordReadyResolve = null; }
    }

    // Legacy navigation path: a stash written by discord.html before the (now removed)
    // redirect. Adopt synchronously so the first handshake carries the token.
    if (discordSession && discordSession.token) {
        applyDiscordSession(discordSession.token, discordSession.profile);
    }

    // A stable key for what the navbar actually shows (identity + name + avatar), so
    // we re-render on sign-in/out AND on a profile change (USER_UPDATED), but NOT on a
    // bare TOKEN_REFRESHED (same key), which fires periodically and would otherwise
    // snap an open popover shut.
    function navKey(user) {
        if (!user) { return ''; }
        var m = user.user_metadata || {};
        return user.id + '|' + (m.full_name || m.name || m.user_name || user.email || '') + '|' + (m.avatar_url || '');
    }

    // GA login conversion. A fresh OAuth sign-in is a full-page redirect away and
    // back, so "was a sign-in just completed?" can't be told apart from a routine
    // session restore by auth events alone. Instead signIn() stamps the chosen
    // provider in localStorage before redirecting; seeing a signed-in session with
    // that stamp present = the player actually converted. The stamp is consumed on
    // first sight, and a stale one (player bailed at the OAuth screen and came
    // back later) is swept by a short timer below so it can't mis-fire days later.
    var SIGNIN_PENDING_KEY = 'chaochao.signInPending';
    // Set when the player launches sign-in from the scoreboard login nudge, so the
    // resulting `login` (which lands a full page-load later, post-OAuth) can be
    // attributed to the nudge vs the navbar popover. Self-expires so an abandoned
    // nudge can't mis-attribute a much later, unrelated navbar sign-in.
    var pendingSignInSource = null, pendingSignInSourceTimer = null;
    function markSignInSource(source) {
        pendingSignInSource = source;
        if (pendingSignInSourceTimer) { clearTimeout(pendingSignInSourceTimer); }
        pendingSignInSourceTimer = setTimeout(function () { pendingSignInSource = null; }, 30000);
    }
    function consumeSignInPending(user) {
        if (!user) { return; }
        var pending = null;
        try {
            pending = window.localStorage.getItem(SIGNIN_PENDING_KEY);
            if (pending) { window.localStorage.removeItem(SIGNIN_PENDING_KEY); }
        } catch (e) { /* storage unavailable */ }
        if (!pending) { return; }
        // Stamps written since the source split are JSON {provider, source}; older
        // ones were a bare provider string. Tolerate both.
        var provider = pending, source = 'navbar';
        if (pending.charAt(0) === '{') {
            try { var parsed = JSON.parse(pending); provider = parsed.provider || null; source = parsed.source || 'navbar'; }
            catch (e) { provider = null; }
        }
        if (provider && typeof trackEvent === 'function') {
            // GA4's recommended sign-in event name; `method` = google | discord,
            // `source` = nudge | navbar (which entry point actually converted).
            trackEvent('login', { method: provider, source: source });
        }
    }
    // Sweep a stale pending stamp: if no session showed up shortly after load,
    // the OAuth round-trip didn't complete (cancelled / abandoned).
    setTimeout(function () {
        if (currentUser) { return; }
        try { window.localStorage.removeItem(SIGNIN_PENDING_KEY); } catch (e) { /* ignore */ }
    }, 15000);

    function applySession(session) {
        accessToken = (session && session.access_token) || null;
        var newUser = (session && session.user) || null;
        var changed = navKey(currentUser) !== navKey(newUser);
        currentUser = newUser;
        consumeSignInPending(newUser);
        if (changed) {
            renderAuthUI();
            // Refresh the auth_state GA user property (defined by metrics.js in the
            // play bundle; absent on pages without it).
            if (typeof window.updateGAUserProperties === 'function') {
                window.updateGAUserProperties();
            }
        }
    }

    // Resolve the initial session once on load. `ready` lets callers await this,
    // though the socket handshake uses the callback form below and so reads the
    // token at connection time (after this microtask has settled).
    var ready;
    if (isDiscordCtx) {
        // No Supabase client in-frame. The connect-gate (game.js) awaits this; it resolves
        // when the in-frame bootstrap calls adoptDiscordSession (or already did, via the
        // legacy stash). game.js caps the wait so a failed/slow Discord auth still connects
        // (as guest) — see the longer Discord cap there.
        ready = discordReady;
    } else if (sb) {
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
        // Stamp the provider (and which entry point launched this) so the
        // post-redirect load can fire the GA `login` conversion with attribution
        // (see consumeSignInPending above). Default source = navbar popover.
        var source = pendingSignInSource || 'navbar';
        pendingSignInSource = null;
        if (pendingSignInSourceTimer) { clearTimeout(pendingSignInSourceTimer); pendingSignInSourceTimer = null; }
        try { window.localStorage.setItem(SIGNIN_PENDING_KEY, JSON.stringify({ provider: provider, source: source })); } catch (e) { /* ignore */ }
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
    // display name + avatar URL, or null when not signed in. Never falls back
    // to currentUser.email — `name` is broadcast to every racer in the room
    // via setAvatarSkin, and email/password users would otherwise have their
    // address shown above their kart and on the leaderboard.
    function getProfile() {
        if (!currentUser) {
            return null;
        }
        var meta = currentUser.user_metadata || {};
        return {
            name: meta.full_name || meta.name || meta.user_name || 'Player',
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
    // A dismissible toast reminding a NOT-signed-in player to log in to start
    // earning XP and skins. Fired from the game-over/scoreboard screen (client.js).
    // No-op when auth is unavailable or already signed in.
    //
    // Redesigned after launch data showed ~5% CTR (22 shown / 1 click): the old
    // toast auto-hid after 9s (often before the player read the busy scoreboard)
    // and re-fired on EVERY game over (banner blindness). Now it (1) persists until
    // the player acts or dismisses — client.js hides it on race start so it never
    // covers gameplay, (2) leads with a concrete value prop (how many skins are up
    // for grabs), and (3) snoozes for a few days once dismissed or acted on, so it
    // stops nagging.
    var NUDGE_SNOOZE_KEY = 'chaochao.nudgeSnoozeUntil';
    var NUDGE_SNOOZE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
    var toastEl = null, nudgeVisible = false, nudgeDismissed = false;
    function nudgeSnoozed() {
        try { return parseInt(window.localStorage.getItem(NUDGE_SNOOZE_KEY) || '0', 10) > Date.now(); }
        catch (e) { return false; }
    }
    function snoozeNudge() {
        nudgeDismissed = true; // also blocks re-show for the rest of this session
        try { window.localStorage.setItem(NUDGE_SNOOZE_KEY, String(Date.now() + NUDGE_SNOOZE_MS)); }
        catch (e) { /* private mode — session flag still suppresses */ }
    }
    function nudgeMessage(opts) {
        // `unlockCount` spans every cosmetic slot (carts / patterns / trails /
        // borders), so it's "cosmetics", not "skins". Guests start with none.
        var n = opts && opts.unlockCount;
        if (typeof n === 'number' && n > 0) {
            return 'Sign in to start earning XP and unlock ' + n + ' cosmetics.';
        }
        return 'Sign in to save your progress and earn cosmetics.';
    }
    function buildToast(message) {
        if (toastEl || !document.body) { return; }
        toastEl = document.createElement('div');
        toastEl.className = 'cc-toast';
        toastEl.setAttribute('role', 'status');
        toastEl.innerHTML =
            '<span class="cc-toast-msg"></span>' +
            '<button class="cc-toast-action" type="button">Log in</button>' +
            '<button class="cc-toast-close" type="button" aria-label="Dismiss">×</button>';
        toastEl.querySelector('.cc-toast-msg').textContent = message; // numeric count, but textContent keeps it XSS-safe
        document.body.appendChild(toastEl);
        toastEl.querySelector('.cc-toast-action').addEventListener('click', function () {
            // Nudge funnel numerator (denominator = login_nudge_shown); the
            // conversion itself lands as `login` (source=nudge) after the OAuth round-trip.
            if (typeof trackEvent === 'function') { trackEvent('login_nudge_clicked'); }
            // Attribute the upcoming signIn() to the nudge — the action button just
            // opens the navbar popover, whose provider buttons call signIn() directly.
            markSignInSource('nudge');
            snoozeNudge(); // acted on — don't re-nag while the OAuth round-trip plays out
            hideToast();
            var login = document.getElementById('authLogin');
            if (login) { login.click(); } // open the navbar sign-in popover
        });
        toastEl.querySelector('.cc-toast-close').addEventListener('click', function () {
            snoozeNudge(); // explicit dismissal — snooze across sessions
            hideToast();
        });
    }
    function hideToast() {
        if (toastEl) { toastEl.classList.remove('visible'); }
        nudgeVisible = false;
    }
    function showLoginNudge(opts) {
        if (!sb || currentUser) { return; }               // signed-out players only, auth on
        if (nudgeDismissed || nudgeSnoozed()) { return; }  // respect a recent dismiss/login
        if (nudgeVisible) { return; }                      // already up — don't double-count the show
        buildToast(nudgeMessage(opts));
        if (!toastEl) { return; }
        // First open caches the message; later openings still need their text refreshed
        // if the count changed (e.g. unlocks added mid-session).
        var msgEl = toastEl.querySelector('.cc-toast-msg');
        if (msgEl) { msgEl.textContent = nudgeMessage(opts); }
        toastEl.classList.add('visible');
        nudgeVisible = true;
        // Funnel denominator (clicked/shown = nudge CTR; login[source=nudge]/shown = the
        // guest -> registered conversion the nudge actually drives). Persistent now;
        // client.js hideLoginNudge() clears it at race start so it can't cover the game.
        if (typeof trackEvent === 'function') { trackEvent('login_nudge_shown'); }
    }

    window.chaochaoAuth = {
        ready: ready,
        available: !!sb,   // Supabase configured + CDN loaded (auth actually usable)
        showLoginNudge: showLoginNudge,
        hideLoginNudge: hideToast, // clear the nudge without dismissing it (e.g. on race start)
        deviceId: deviceId,
        getHandshake: getHandshake,
        getProfile: getProfile,
        // Discord Activity (approach b): the in-frame bootstrap (discordPresence.js) calls
        // this with the server-minted handshake token + validated profile (or null,null to
        // stay guest) once its OAuth/token exchange completes — adopting the session and
        // releasing the connect-gate so the socket handshake carries the token.
        adoptDiscordSession: applyDiscordSession,
        signIn: signIn,
        signOut: signOut,
        isSignedIn: function () { return !!currentUser; },
        // For the auth_state GA user property: 'guest' or the OAuth provider the
        // session was created with ('google' | 'discord').
        getAuthState: function () {
            if (!currentUser) { return 'guest'; }
            var appMeta = currentUser.app_metadata || {};
            return appMeta.provider || 'unknown';
        }
    };
})();
