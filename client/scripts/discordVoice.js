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
// A high-contrast ring HUGGING the kart/avatar edge (not a faint halo outside the cart)
// while this player's Discord user is talking. Drawn AFTER the body (see the call sites in
// draw.js / draw_skins.js) so it frames the avatar photo. Cheap painters only — a dark
// backing arc + a bright pulsing green arc, no shadow/filter surfaces (the GPU killers).
// Called with the same camera-offset screen coords the kart body is drawn at.
function drawSpeakingIndicator(player, sx, sy) {
    if (typeof window === "undefined" || !window.discordPresence) { return; }
    if (player == null || !player.discordUserId) { return; }
    if (!window.discordPresence.isSpeaking(player.discordUserId)) { return; }
    if (typeof gameContext === "undefined" || gameContext == null) { return; }
    if (!(player.radius > 0)) { return; }
    // Match the body's visible radius: shaped cart skins render CART_SKIN_VISUAL_SCALE
    // larger; the avatar photo + plain sphere fill exactly player.radius. Sit the ring
    // right ON that edge (+1.5, like the avatar's own outline) so it frames the picture.
    var painter = (typeof cartSkinPainter === "function") ? cartSkinPainter(player.cart) : null;
    var scale = (painter != null && typeof CART_SKIN_VISUAL_SCALE !== "undefined") ? CART_SKIN_VISUAL_SCALE : 1;
    var ringR = player.radius * scale + 1.5;
    // Pulse ~1.4Hz so it reads as "live mic" without strobing.
    var t = (Date.now() % 720) / 720;
    var pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2);
    gameContext.save();
    // Dark backing ring first — gives the green contrast over light avatars / busy terrain.
    gameContext.beginPath();
    gameContext.arc(sx, sy, ringR, 0, 2 * Math.PI);
    gameContext.lineWidth = 5;
    gameContext.strokeStyle = "rgba(0,0,0,0.55)";
    gameContext.stroke();
    // Bright green ring on top, near-opaque, width/brightness pulsing for the "live" feel.
    gameContext.beginPath();
    gameContext.arc(sx, sy, ringR, 0, 2 * Math.PI);
    gameContext.lineWidth = 2.5 + pulse * 1.5;
    gameContext.globalAlpha = 0.85 + 0.15 * pulse;
    gameContext.strokeStyle = "#57F287"; // Discord's bright "speaking" green
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
            // Desktop default: a vertical column down the left edge. left/max-height
            // honour the device safe-area (notch / home indicator) and keep a long
            // roster from clipping off the top/bottom (the --safe-* vars also pick up
            // Discord's injected insets — see styles.css :root).
            '#discordVoiceTray{position:fixed;left:calc(10px + var(--safe-left, 0px));top:50%;transform:translateY(-50%);' +
            'display:flex;flex-direction:column;gap:8px;z-index:40;pointer-events:none;' +
            'max-height:calc(100dvh - var(--safe-top, 0px) - var(--safe-bottom, 0px) - 24px);overflow:hidden;' +
            'padding:8px 6px;border-radius:16px;background:rgba(11,12,20,0.45);' +
            'backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);}' +
            '#discordVoiceTray.empty{display:none;}' +
            '.dvt-row{position:relative;width:40px;height:40px;flex:0 0 auto;}' +
            '.dvt-av{width:40px;height:40px;border-radius:50%;display:block;object-fit:cover;' +
            'border:2px solid rgba(255,255,255,0.18);background:#2a3350;}' +
            '.dvt-ring{position:absolute;inset:-3px;border-radius:50%;border:3px solid #43b581;' +
            'opacity:0;transition:opacity .12s ease;box-shadow:0 0 8px #43b581;}' +
            '.dvt-row.speaking .dvt-ring{opacity:1;}' +
            '.dvt-row.speaking .dvt-av{border-color:#43b581;}' +
            // Narrow / touch screens (a phone-width Discord frame): a left-edge column
            // would sit right under the floating joystick (left tap region) or the
            // attack button (right). Re-flow to a horizontal row pinned to the top
            // CENTRE — the one strip a landscape player's thumbs never cover — below
            // the navbar + top notch, smaller avatars, and overflow-clipped so a big
            // voice group can't run off either edge.
            '@media (pointer:coarse),(max-width:900px){' +
            '#discordVoiceTray{left:50%;right:auto;top:calc(var(--navbar-height, 0px) + var(--safe-top, 0px) + 6px);' +
            'transform:translateX(-50%);flex-direction:row;flex-wrap:nowrap;' +
            'max-height:none;max-width:min(72vw,440px);gap:6px;padding:5px 7px;}' +
            '#discordVoiceTray .dvt-row,#discordVoiceTray .dvt-av{width:32px;height:32px;}' +
            '}';
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
        // DOM voice tray intentionally DISABLED. Discord renders its OWN participant /
        // voice shelf inside the Activity frame (the avatar tile + "›" on mobile), so our
        // tray was a visible duplicate ("2 voice trays", operator-reported on device). The
        // on-kart SPEAKING RING (drawSpeakingIndicator, above) is the unique game-native
        // surface and stays — it's fed by window.discordPresence.isSpeaking, independent of
        // this tray. To bring the custom tray back on a surface Discord doesn't cover,
        // restore the build() path: ensureTray() + the two onParticipants/onSpeaking hooks.
        return;
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
