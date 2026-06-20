// discordVoice.js — Discord Activity voice-activity visual (Phase 5b).
//
// Two surfaces, both gated on the Discord context (web/portal builds never run this):
//   (a) an on-kart SPEAKING RING — a soft green pulse beneath a kart whose Discord
//       user is talking (drawSpeakingIndicator, called from the kart draw paths next
//       to drawTeamUnderglow); and
//   (b) a VOICE TRAY — a vertical column of participant avatars down the left edge that
//       glow while their owner speaks (a lightweight DOM overlay, so remote
//       cdn.discordapp.com avatars don't taint the game canvas).
//
// Data sources (all from the in-frame SDK via window.discordPresence, Phase 5):
//   - getParticipants() / onParticipants() — who's in the voice channel (id, name, avatar).
//   - isSpeaking() / onSpeaking()          — who's talking right now (by Discord user_id).
//   - per-kart mapping: player.discordUserId, relayed by the server (compressor field
//     [18] + the playerVoiceId broadcast) so a SPEAKING event maps to the right kart.
//
// This file is part of the normal play bundle (concat-globals) — it does NOT import the
// SDK; it only reads window.discordPresence, which the separate discord-presence bundle
// populates. Everything no-ops cleanly when presence is absent (web build).

// ---- (a) on-kart speaking ring -------------------------------------------------------
// Mirror drawTeamUnderglow: cheap arc + stroke only (no shadow/filter surfaces — the GPU
// killers). Called with the same camera-offset screen coords the kart body is drawn at.
function drawSpeakingIndicator(player, sx, sy) {
    if (typeof window === "undefined" || !window.discordPresence) { return; }
    if (player == null || !player.discordUserId) { return; }
    if (!window.discordPresence.isSpeaking(player.discordUserId)) { return; }
    if (typeof gameContext === "undefined" || gameContext == null) { return; }
    var painter = (typeof cartSkinPainter === "function") ? cartSkinPainter(player.cart) : null;
    var scale = (painter != null && typeof CART_SKIN_VISUAL_SCALE !== "undefined") ? CART_SKIN_VISUAL_SCALE : 1;
    var baseR = player.radius * scale + 7;
    // Pulse ~1.4Hz so it reads as "live mic" without strobing.
    var t = (Date.now() % 720) / 720;
    var pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2);
    gameContext.save();
    gameContext.beginPath();
    gameContext.arc(sx, sy, baseR + pulse * 4, 0, 2 * Math.PI);
    gameContext.globalAlpha = 0.30 + 0.35 * pulse;
    gameContext.lineWidth = 3;
    gameContext.strokeStyle = "#43b581"; // Discord "speaking" green
    gameContext.stroke();
    gameContext.restore();
}

// ---- (b) voice tray (DOM overlay) ----------------------------------------------------
(function () {
    var tray = null;          // the container element
    var rowsById = {};        // Discord user_id -> { el, ring } for cheap speaking toggles
    var built = false;

    function ensureStyle() {
        if (document.getElementById('discordVoiceTrayStyle')) { return; }
        var css = document.createElement('style');
        css.id = 'discordVoiceTrayStyle';
        css.textContent =
            '#discordVoiceTray{position:fixed;left:10px;top:50%;transform:translateY(-50%);' +
            'display:flex;flex-direction:column;gap:8px;z-index:40;pointer-events:none;' +
            'padding:8px 6px;border-radius:16px;background:rgba(11,12,20,0.45);' +
            'backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);}' +
            '#discordVoiceTray.empty{display:none;}' +
            '.dvt-row{position:relative;width:40px;height:40px;}' +
            '.dvt-av{width:40px;height:40px;border-radius:50%;display:block;object-fit:cover;' +
            'border:2px solid rgba(255,255,255,0.18);background:#2a3350;}' +
            '.dvt-ring{position:absolute;inset:-3px;border-radius:50%;border:3px solid #43b581;' +
            'opacity:0;transition:opacity .12s ease;box-shadow:0 0 8px #43b581;}' +
            '.dvt-row.speaking .dvt-ring{opacity:1;}' +
            '.dvt-row.speaking .dvt-av{border-color:#43b581;}';
        document.head.appendChild(css);
    }

    function ensureTray() {
        if (tray) { return tray; }
        ensureStyle();
        tray = document.createElement('div');
        tray.id = 'discordVoiceTray';
        tray.className = 'empty';
        document.body.appendChild(tray);
        return tray;
    }

    // Rebuild the avatar column from the participant list. Cheap (a handful of voice
    // members); speaking-state changes don't rebuild — they just toggle a class.
    function renderParticipants(list) {
        var t = ensureTray();
        rowsById = {};
        t.innerHTML = '';
        var people = (list || []).filter(function (p) { return !p.bot; });
        if (!people.length) { t.className = 'empty'; return; }
        t.className = '';
        for (var i = 0; i < people.length; i++) {
            var p = people[i];
            var row = document.createElement('div');
            row.className = 'dvt-row';
            row.title = p.name || '';
            var img = document.createElement('img');
            img.className = 'dvt-av';
            img.alt = p.name || '';
            if (p.avatarUrl) { img.src = p.avatarUrl; }
            var ring = document.createElement('div');
            ring.className = 'dvt-ring';
            row.appendChild(img);
            row.appendChild(ring);
            t.appendChild(row);
            rowsById[p.id] = row;
        }
        // Re-apply current speaking state to the freshly built rows.
        if (window.discordPresence) { applySpeaking(window.discordPresence.getSpeaking()); }
    }

    function applySpeaking(speakingIds) {
        var on = {};
        for (var i = 0; i < (speakingIds || []).length; i++) { on[speakingIds[i]] = true; }
        for (var id in rowsById) {
            if (on[id]) { rowsById[id].classList.add('speaking'); }
            else { rowsById[id].classList.remove('speaking'); }
        }
    }

    function init() {
        if (built) { return; }
        // Discord context only. isDiscordActivity() lives in client.js (same bundle/global
        // scope); guard with typeof so a stray load order can't throw.
        if (typeof isDiscordActivity !== "function" || !isDiscordActivity()) { return; }
        if (!window.discordPresence) { return; }
        built = true;
        window.discordPresence.onParticipants(renderParticipants);
        window.discordPresence.onSpeaking(applySpeaking);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
