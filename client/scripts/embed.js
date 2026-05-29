// isEmbedded() — single source of truth for "are we running inside an <iframe>?".
//
// Portals (CrazyGames / Poki / itch.io) embed the game on their own domain. When
// embedded we trim chrome that points away from the portal or that won't work
// inside a third-party frame:
//   - the back-to-home brand link and the GitHub patch-notes banner / version
//     tag (navigation away from the portal),
//   - the sign-in CTA — OAuth redirects routinely break inside a third-party
//     iframe (blocked third-party cookies). The game already falls back to
//     anonymous play, so inside a frame we simply don't advertise sign-in. We
//     do NOT touch the auth flow itself: a session that DOES survive still
//     renders its user chip normally (that path uses #authUser, not #authLogin).
//
// The actual hiding is done in CSS (html.cc-embedded ... in styles.css); this
// file only detects the context, exposes window.isEmbedded(), and sets the class.
//
// Loaded as a standalone <script> in <head> on every page (index/play/join/
// create/learn) so it runs before first paint (no chrome flash) and so the
// isEmbedded() global is available to the page bundles, which share globals.
(function () {
    var embedded;
    try {
        embedded = window.self !== window.top;
    } catch (e) {
        // Reading window.top across origins can throw in some browsers; a throw
        // means a cross-origin parent is framing us, so treat it as embedded.
        embedded = true;
    }
    window.isEmbedded = function () { return embedded; };
    if (embedded && document.documentElement) {
        document.documentElement.classList.add('cc-embedded');
    }
})();
