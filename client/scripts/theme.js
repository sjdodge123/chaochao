// Light / dark / auto theme toggle, shared across every page.
//
// The *preference* ('light' | 'dark' | 'auto') is persisted in localStorage.
// The *resolved* theme ('light' | 'dark') is reflected as data-theme on <html>;
// a tiny inline script in each page's <head> sets it before first paint so the
// page never flashes the wrong theme. This file owns the navbar toggle button,
// persistence, reacting to OS theme changes while in auto mode, and publishing
// window.themePalette so the canvas renderer (draw.js) can read plain colour
// strings without touching getComputedStyle every frame.
(function () {
    var STORAGE_KEY = 'themePref';
    var ORDER = ['auto', 'light', 'dark'];
    // basic Unicode glyphs so this works regardless of which Font Awesome
    // version a given page happens to load.
    var GLYPH = { auto: '◐', light: '☀', dark: '☾' };
    var LABEL = { auto: 'Auto', light: 'Light', dark: 'Dark' };

    var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    var btn = null;
    // In-memory source of truth, seeded lazily from storage. This keeps the
    // toggle cycling correctly even where localStorage writes throw (private
    // mode / storage disabled) — the choice just won't persist across reloads.
    var currentPref = null;

    function readStoredPref() {
        try {
            var p = localStorage.getItem(STORAGE_KEY);
            return (p === 'light' || p === 'dark' || p === 'auto') ? p : 'auto';
        } catch (e) {
            return 'auto';
        }
    }
    function getPref() {
        if (currentPref === null) currentPref = readStoredPref();
        return currentPref;
    }
    function setPref(pref) {
        currentPref = pref;
        try { localStorage.setItem(STORAGE_KEY, pref); } catch (e) {}
    }
    function resolve(pref) {
        if (pref === 'dark') return 'dark';
        if (pref === 'light') return 'light';
        return (media && media.matches) ? 'dark' : 'light';
    }

    // Expose the in-memory preference so other in-page UI (e.g. the controller
    // settings panel) can label the current theme without re-reading localStorage —
    // which would be stale where storage writes are blocked (incognito), since the
    // live choice is held in `currentPref`, not necessarily persisted.
    window.getThemePref = getPref;

    // Pull the canvas colours out of the CSS custom properties so draw.js reads
    // them as a cheap object lookup. Refreshed whenever the theme changes.
    function refreshPalette() {
        var cs = getComputedStyle(document.documentElement);
        window.themePalette = {
            surface: (cs.getPropertyValue('--canvas-surface') || '').trim() || '#F0F0F0',
            ink: (cs.getPropertyValue('--canvas-ink') || '').trim() || '#000000',
            inkOutline: (cs.getPropertyValue('--canvas-ink-outline') || '').trim() || '#FFFFFF'
        };
    }

    function updateButton(pref) {
        if (!btn) return;
        btn.textContent = GLYPH[pref] || GLYPH.auto;
        btn.title = 'Theme: ' + (LABEL[pref] || 'Auto') + ' (click to change)';
        btn.setAttribute('aria-label', 'Theme: ' + (LABEL[pref] || 'Auto') + '. Click to change.');
    }

    function apply(pref) {
        document.documentElement.setAttribute('data-theme', resolve(pref));
        refreshPalette();
        updateButton(pref);
    }

    function cycle() {
        var next = ORDER[(ORDER.indexOf(getPref()) + 1) % ORDER.length];
        setPref(next);
        apply(next);
    }

    function injectButton() {
        var nav = document.querySelector('nav');
        if (!nav || document.getElementById('themeToggle')) return;
        btn = document.createElement('button');
        btn.id = 'themeToggle';
        btn.type = 'button';
        btn.className = 'theme-toggle';
        btn.addEventListener('click', cycle);
        nav.appendChild(btn);
        updateButton(getPref());
    }

    // React to OS theme changes, but only when the user is in auto mode.
    if (media) {
        var onChange = function () { if (getPref() === 'auto') apply('auto'); };
        if (media.addEventListener) media.addEventListener('change', onChange);
        else if (media.addListener) media.addListener(onChange);
    }

    // data-theme is already set by the inline <head> script, so the stylesheet
    // values are resolvable now — seed the palette before the canvas renders.
    refreshPalette();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectButton);
    } else {
        injectButton();
    }
})();
