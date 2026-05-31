// In-browser feedback / bug-report widget. Injects a small fixed "Feedback"
// button into every page that loads this script; clicking it opens a modal that
// POSTs to the server's /feedback endpoint, which files a GitHub issue on the
// repo (server/utils.js submitIssue). Self-contained: it injects its own styles
// (themed via the shared CSS variables in css/styles.css) and DOM so it can be
// dropped onto any page with a single <script> tag, independent of the bundles.
(function () {
    "use strict";

    // Don't show the widget when the game is embedded in a portal iframe
    // (CrazyGames / Poki / itch.io) — those hosts have their own reporting and a
    // floating button would clutter their frame. isEmbedded is set by the page's
    // embed detection; fall back to a plain top-vs-self check if it's absent.
    function isEmbedded() {
        if (typeof window.isEmbedded === "boolean") { return window.isEmbedded; }
        try { return window.self !== window.top; } catch (e) { return true; }
    }

    function injectStyles() {
        if (document.getElementById("feedbackWidgetStyles")) { return; }
        var css =
            "#feedbackFab{position:fixed;right:14px;bottom:14px;z-index:2147483000;" +
            "min-height:44px;padding:10px 18px;border:none;border-radius:999px;cursor:pointer;" +
            "font:600 14px/1 inherit;background:#4363d8;color:#fff;" +
            "box-shadow:0 2px 10px var(--card-shadow,rgba(0,0,0,.3));" +
            "display:flex;align-items:center;justify-content:center;gap:6px;}" +
            "#feedbackFab:hover{filter:brightness(1.08);}" +
            "#feedbackFab:focus-visible{outline:3px solid #ffe119;outline-offset:2px;}" +
            "#feedbackOverlay{position:fixed;inset:0;z-index:2147483001;display:none;" +
            "align-items:center;justify-content:center;background:rgba(0,0,0,.5);padding:16px;}" +
            "#feedbackOverlay.open{display:flex;}" +
            "#feedbackModal .fb-types{display:flex;gap:8px;}" +
            "#feedbackModal .fb-type{flex:1;min-height:44px;text-align:center;padding:9px 6px;border-radius:8px;" +
            "border:1px solid var(--border,#ccc);background:var(--surface-2,#f6f6f6);" +
            "color:var(--text,#212529);cursor:pointer;font:600 13px inherit;}" +
            "#feedbackModal .fb-type[aria-pressed=true]{background:#4363d8;color:#fff;border-color:#4363d8;}" +
            "#feedbackModal{width:100%;max-width:420px;max-height:90vh;overflow:auto;" +
            "background:var(--surface,#fff);color:var(--text,#212529);" +
            "border:1px solid var(--border,#e6e6e6);border-radius:12px;padding:18px 18px 16px;" +
            "box-shadow:0 8px 40px var(--card-shadow,rgba(0,0,0,.4));font:14px/1.4 inherit;}" +
            "#feedbackModal h2{margin:0 0 4px;font-size:18px;}" +
            "#feedbackModal p.fb-sub{margin:0 0 14px;color:var(--text-muted,#6c757d);font-size:13px;}" +
            "#feedbackModal label{display:block;font-weight:600;margin:12px 0 4px;font-size:13px;}" +
            "#feedbackModal select,#feedbackModal textarea,#feedbackModal input[type=email]{" +
            "width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;" +
            "border:1px solid var(--border,#ccc);background:var(--surface-2,#f6f6f6);" +
            "color:var(--text,#212529);font:14px inherit;}" +
            "#feedbackModal textarea{resize:vertical;min-height:90px;}" +
            "#fbHoneypot{position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;}" +
            "#feedbackModal .fb-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px;}" +
            "#feedbackModal .fb-actions button{min-height:44px;padding:10px 18px;border-radius:8px;cursor:pointer;font:600 14px inherit;border:1px solid var(--border,#ccc);}" +
            "#fbCancel{background:transparent;color:var(--text,#212529);}" +
            "#fbSubmit{background:#3cb44b;color:#fff;border-color:#3cb44b;}" +
            "#fbSubmit:disabled{opacity:.6;cursor:default;}" +
            "#feedbackModal .fb-status{margin-top:12px;font-size:13px;min-height:1em;}" +
            "#feedbackModal .fb-status.err{color:#e6194B;}" +
            "#feedbackModal .fb-status.ok{color:#3cb44b;}" +
            "#feedbackModal .fb-status a{color:inherit;}";
        var style = document.createElement("style");
        style.id = "feedbackWidgetStyles";
        style.textContent = css;
        document.head.appendChild(style);
    }

    var overlay, statusEl, submitBtn, msgEl, emailEl, honeypotEl;
    var selectedType = "bug";

    function buildModal() {
        overlay = document.createElement("div");
        overlay.id = "feedbackOverlay";
        // data-gp-modal: while this overlay has .open, menuGamepad.js scopes
        // controller navigation to the controls inside it (not the page behind).
        overlay.setAttribute("data-gp-modal", "");
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-label", "Send feedback");
        overlay.innerHTML =
            '<div id="feedbackModal">' +
            '<h2>Send feedback</h2>' +
            '<p class="fb-sub">Found a bug or have an idea? Your description opens a <strong>public</strong> issue on GitHub, so don\'t include anything private.</p>' +
            '<label>Type</label>' +
            // Type picker as buttons (not a <select>) so it works the same by tap and
            // by controller — each is a data-gp-nav target the pad can land on.
            '<div class="fb-types" role="group" aria-label="Feedback type">' +
            '<button type="button" class="fb-type" data-gp-nav data-type="bug" aria-pressed="true">Bug</button>' +
            '<button type="button" class="fb-type" data-gp-nav data-type="idea" aria-pressed="false">Idea</button>' +
            '<button type="button" class="fb-type" data-gp-nav data-type="other" aria-pressed="false">Other</button>' +
            '</div>' +
            '<label for="fbMessage">Description</label>' +
            '<textarea id="fbMessage" data-gp-nav maxlength="5000" placeholder="What happened, or what would you like to see?"></textarea>' +
            '<label for="fbEmail">Email <span style="font-weight:400;color:var(--text-muted,#6c757d)">(optional, kept private — not shown on the issue)</span></label>' +
            '<input id="fbEmail" type="email" data-gp-nav maxlength="254" placeholder="you@example.com">' +
            // Honeypot: hidden from humans, no data-gp-nav, autocomplete off. A bot
            // that fills every field trips it; the server drops anything with it set.
            '<input id="fbHoneypot" type="text" tabindex="-1" autocomplete="off" aria-hidden="true" name="website">' +
            '<div class="fb-status" id="fbStatus" aria-live="polite"></div>' +
            '<div class="fb-actions">' +
            '<button id="fbCancel" type="button" data-gp-nav data-gp-modal-close>Cancel</button>' +
            '<button id="fbSubmit" type="button" data-gp-nav>Send</button>' +
            '</div>' +
            '</div>';
        document.body.appendChild(overlay);

        statusEl = overlay.querySelector("#fbStatus");
        submitBtn = overlay.querySelector("#fbSubmit");
        msgEl = overlay.querySelector("#fbMessage");
        emailEl = overlay.querySelector("#fbEmail");
        honeypotEl = overlay.querySelector("#fbHoneypot");

        // Type buttons act as a single-select radio group.
        var typeBtns = overlay.querySelectorAll(".fb-type");
        Array.prototype.forEach.call(typeBtns, function (btn) {
            btn.addEventListener("click", function () {
                selectedType = btn.getAttribute("data-type");
                Array.prototype.forEach.call(typeBtns, function (b) {
                    b.setAttribute("aria-pressed", b === btn ? "true" : "false");
                });
            });
        });

        overlay.querySelector("#fbCancel").addEventListener("click", close);
        submitBtn.addEventListener("click", submit);
        // Click on the dimmed backdrop (but not the modal itself) closes it.
        overlay.addEventListener("click", function (e) {
            if (e.target === overlay) { close(); }
        });
        document.addEventListener("keydown", function (e) {
            if (e.key === "Escape" && overlay.classList.contains("open")) { close(); }
        });
        // Focus trap: keep Tab / Shift+Tab cycling within the modal so a keyboard
        // user can't tab onto the navbar / page controls hidden behind the backdrop.
        // (aria-modal alone doesn't enforce this.)
        overlay.addEventListener("keydown", function (e) {
            if (e.key !== "Tab" || !overlay.classList.contains("open")) { return; }
            var list = focusables();
            if (list.length === 0) { return; }
            var first = list[0];
            var last = list[list.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        });
    }

    // Visible, tabbable controls inside the modal, in DOM order (honeypot excluded).
    function focusables() {
        var sel = 'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])';
        return Array.prototype.filter.call(overlay.querySelectorAll(sel), function (el) {
            return el.id !== "fbHoneypot" && el.offsetParent !== null && !el.disabled;
        });
    }

    function open() {
        if (!overlay) { buildModal(); }
        setStatus("", "");
        overlay.classList.add("open");
        msgEl.focus();
    }

    function close() {
        if (overlay) { overlay.classList.remove("open"); }
    }

    function setStatus(text, kind) {
        statusEl.className = "fb-status" + (kind ? " " + kind : "");
        if (kind === "ok" && text && text.indexOf("http") === 0) {
            statusEl.innerHTML = 'Thanks! <a href="' + text + '" target="_blank" rel="noopener">Track it on GitHub</a>.';
        } else {
            statusEl.textContent = text || "";
        }
    }

    function submit() {
        var message = (msgEl.value || "").trim();
        if (message.length < 5) {
            setStatus("Please add a few more words so it's actionable.", "err");
            msgEl.focus();
            return;
        }
        submitBtn.disabled = true;
        setStatus("Sending…", "");
        var payload = {
            type: selectedType,
            message: message,
            email: (emailEl.value || "").trim(),
            page: location.pathname + location.search,
            context: (navigator.userAgent || "").slice(0, 300),
            website: honeypotEl.value // honeypot — empty for real users
        };
        fetch("/feedback", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        }).then(function (res) {
            return res.json().catch(function () { return { status: false, message: "" }; });
        }).then(function (result) {
            submitBtn.disabled = false;
            if (result && result.status) {
                setStatus(result.message || "Thanks for the feedback!", "ok");
                msgEl.value = "";
                emailEl.value = "";
                // Auto-close shortly after a successful send.
                setTimeout(close, 2500);
            } else {
                setStatus((result && result.message) || "Couldn't send your feedback. Please try again.", "err");
            }
        }).catch(function () {
            submitBtn.disabled = false;
            setStatus("Couldn't reach the server. Please try again in a moment.", "err");
        });
    }

    function init() {
        if (isEmbedded()) { return; }
        if (document.getElementById("feedbackFab")) { return; }
        injectStyles();
        var fab = document.createElement("button");
        fab.id = "feedbackFab";
        fab.type = "button";
        fab.setAttribute("data-gp-nav", "");
        fab.setAttribute("aria-label", "Send feedback");
        fab.title = "Send feedback or report a bug";
        fab.innerHTML = '<span aria-hidden="true">💬</span><span>Feedback</span>';
        fab.addEventListener("click", open);
        document.body.appendChild(fab);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
