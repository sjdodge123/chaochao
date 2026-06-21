// draw_skins.js — cart-skin subsystem, extracted verbatim from draw.js
// (phase 1 of docs/spikes/client-refactor.md). Pure file split: no logic,
// naming, or order changes. Loaded immediately before draw.js in the play
// bundle; every cross-file reference is a runtime call, so the concatenation
// is functionally identical to the pre-split draw.js.
// Contents: cartSkin* colour/shade helpers, cartSkinPainter dispatch,
// drawCartSkin + pattern/border overlay helpers, and all 47 drawXxxSkin
// painters (firetruck … mouse).

// ---- Cart skins (procedural overlay, drawn on top of the colored cart) ----
// drawCartSkin builds a local coordinate space centered on the cart, rotated to
// the player's heading and scaled so the cart radius == 1.0; "forward" (travel
// direction) is +X. Each painter draws in that normalized space. Callers pass the
// already-camera-adjusted screen center, so the camera offset is never double-applied.
// Resolve any CSS colour (palette name/hex/colour-blind remap) to {r,g,b}.
// Pure-JS parse first (tfxParseColorFast, trailEffects.js) — the old paint-one-
// pixel-and-read-it-back trick forced a synchronous GPU flush per NEW colour,
// which made every 🎲 randomize hitch. Readback only remains as the fallback for
// exotic colour strings, on one persistent canvas. Cached per colour as before.
var _cartSkinRGB = {};
var _cartSkinParseCv = null;
function cartSkinRGB(color) {
    if (_cartSkinRGB[color] != null) {
        return _cartSkinRGB[color];
    }
    var rgb = (typeof tfxParseColorFast === "function") ? tfxParseColorFast(color) : null;
    if (rgb == null) {
        if (_cartSkinParseCv == null) {
            _cartSkinParseCv = document.createElement("canvas");
            _cartSkinParseCv.width = _cartSkinParseCv.height = 1;
        }
        var cx = _cartSkinParseCv.getContext("2d", { willReadFrequently: true });
        cx.fillStyle = "#000";   // fallback if `color` is invalid
        cx.fillStyle = color;
        cx.fillRect(0, 0, 1, 1);
        var d = cx.getImageData(0, 0, 1, 1).data;
        rgb = { r: d[0], g: d[1], b: d[2] };
    }
    _cartSkinRGB[color] = rgb;
    return rgb;
}
// Lighten (amt>0, toward white) / darken (amt<0, toward black) a colour by a 0..1
// fraction, so one picked colour fans out into body/outline/leg shades.
function cartSkinShade(color, amt) {
    var c = cartSkinRGB(color);
    var t = amt < 0 ? 0 : 255;
    var f = amt < 0 ? -amt : amt;
    return "rgb(" +
        Math.round(c.r + (t - c.r) * f) + "," +
        Math.round(c.g + (t - c.g) * f) + "," +
        Math.round(c.b + (t - c.b) * f) + ")";
}

// HSL <-> RGB + complementary-hue accent. cartComp(color, amt) rotates the hue 180° for a
// vivid CONTRAST against the primary colour, then mixes toward white(amt>0)/black(amt<0) like
// cartSkinShade. For desaturated primaries (white/gray/black) a complementary hue is useless,
// so it falls back to a luminance flip — guaranteeing the pattern mark always stands out.
function _rgbToHsl(r, g, b) {
    r/=255; g/=255; b/=255; var mx=Math.max(r,g,b), mn=Math.min(r,g,b), h, sat, l=(mx+mn)/2;
    if (mx===mn) { h=0; sat=0; } else { var d=mx-mn; sat=l>0.5?d/(2-mx-mn):d/(mx+mn);
        if (mx===r) h=(g-b)/d+(g<b?6:0); else if (mx===g) h=(b-r)/d+2; else h=(r-g)/d+4; h/=6; }
    return [h, sat, l];
}
function _hslToRgb(h, sat, l) {
    if (sat===0) { var v=Math.round(l*255); return [v,v,v]; }
    function h2(p,q,t){ if(t<0)t+=1; if(t>1)t-=1; if(t<1/6)return p+(q-p)*6*t; if(t<1/2)return q; if(t<2/3)return p+(q-p)*(2/3-t)*6; return p; }
    var q=l<0.5?l*(1+sat):l+sat-l*sat, pp=2*l-q;
    return [Math.round(h2(pp,q,h+1/3)*255), Math.round(h2(pp,q,h)*255), Math.round(h2(pp,q,h-1/3)*255)];
}
function cartCompRGB(color) {
    var c=cartSkinRGB(color), hsl=_rgbToHsl(c.r,c.g,c.b);
    if (hsl[1] < 0.12) { var v=hsl[2]>0.5?38:222; return {r:v,g:v,b:v}; } // gray/white/black -> luminance flip
    var rgb=_hslToRgb((hsl[0]+0.5)%1, Math.max(0.55,hsl[1]), Math.min(0.62,Math.max(0.42,hsl[2])));
    return {r:rgb[0], g:rgb[1], b:rgb[2]};
}
function cartComp(color, amt) {
    var c=cartCompRGB(color); amt=amt||0; var t=amt<0?0:255, f=amt<0?-amt:amt;
    return "rgb("+Math.round(c.r+(t-c.r)*f)+","+Math.round(c.g+(t-c.g)*f)+","+Math.round(c.b+(t-c.b)*f)+")";
}
function cartCompA(color, amt, alpha) {
    var c=cartCompRGB(color); amt=amt||0; var t=amt<0?0:255, f=amt<0?-amt:amt;
    return "rgba("+Math.round(c.r+(t-c.r)*f)+","+Math.round(c.g+(t-c.g)*f)+","+Math.round(c.b+(t-c.b)*f)+","+alpha+")";
}
function getCartHeading(player) {
    var vx = player.velX || 0;
    var vy = player.velY || 0;
    if (vx * vx + vy * vy > 0.01) {
        return Math.atan2(vy, vx);
    }
    if (typeof player.angle === "number") {
        // player.angle is in DEGREES on the client (cf. drawFire / aimers), but the
        // velocity branch above returns radians — convert so an idle skinned kart
        // faces its heading. 0° (due east) is a valid heading, not "missing".
        return player.angle * Math.PI / 180;
    }
    return -Math.PI / 2; // default: face up
}

function getCartSpeed(player) {
    var vx = player.velX || 0;
    var vy = player.velY || 0;
    return Math.sqrt(vx * vx + vy * vy);
}

// Single source of truth for cart-skin dispatch. A skin name maps to its
// procedural painter; null means "no skin" (plain colour disc). Add future
// skins HERE and they automatically work everywhere this is consulted: the live
// kart, the scoreboard notch icon, and the ice reflection.
function cartSkinPainter(name) {
    // Delegate to the cosmetics registry (resolves all ported cart bodies). Fallback to the
    // built-ins if the registry isn't loaded yet (bundled after draw.js, but this runs at
    // render time so the registry is normally present).
    if (typeof getSkinPainter === "function" && name) { return getSkinPainter(name); }
    if (name === "firetruck") { return drawFiretruckSkin; }
    if (name === "dino") { return drawDinoSkin; }
    return null;
}
// Draw a kart's core appearance (skin or plain colour disc) centred at screen
// (sx,sy). No highlights/avatar/FX — just the body — so callers like the ice
// reflection get a faithful, skin-aware image for any current or future skin.
// Team underglow (teams modes only): a Crimson/Jade ring + faint disc BENEATH the
// kart, so team identity reads without touching colours/cosmetics. Called from BOTH
// kart body paths — the live drawPlayer (which inlines its own border/sprite/skin
// sequence and does NOT go through drawKartAppearance) and the drawKartAppearance
// chokepoint (overview scoreboard, ice reflection, lava-burn, recap). Cheap painters
// only — one arc fill + stroke, no shadow/filter surfaces (the GPU killers; see
// cosmetic-perf notes).
function drawTeamUnderglow(player, sx, sy) {
    // Zombies play for the horde, not a team (server/game.js denies them team
    // points and bypasses the friendly-fire gate) — so an infected kart sheds its
    // Crimson/Jade underglow too. Also avoids stacking a jade ring under the
    // lime infection tag ring (two concentric greens read as mud). Returns with
    // the rest of the kart visuals when the round reset clears the flag.
    if (player.infected == true) { return; }
    if (player.teamId == null || typeof teamInfo === "undefined" || teamInfo == null) { return; }
    var tdef = (typeof teamDefFor === "function") ? teamDefFor(player.teamId) : null;
    if (tdef == null) { return; }
    var tr = player.radius * (cartSkinPainter(player.cart) != null ? CART_SKIN_VISUAL_SCALE : 1) + 5;
    gameContext.save();
    gameContext.beginPath();
    gameContext.arc(sx, sy, tr, 0, 2 * Math.PI);
    gameContext.globalAlpha = 0.16;
    gameContext.fillStyle = tdef.color;
    gameContext.fill();
    gameContext.globalAlpha = 0.9;
    gameContext.strokeStyle = tdef.color;
    gameContext.lineWidth = 2.5;
    gameContext.stroke();
    gameContext.restore();
}

function drawKartAppearance(player, sx, sy, headingOverride) {
    // Infected racers swap their kart body for the infection zombie (defined near
    // drawPlayer), so every mirrored body path (e.g. the ice reflection) shows the
    // same silhouette as the live kart. Infection is mid-race transient, so the
    // static paths (overview/recap) never see this flag.
    if (player.infected == true) {
        drawZombieBody(player, sx, sy, headingOverride);
        return;
    }
    // Two INDEPENDENT body cosmetics: the BORDER (player.border) rings ANY cart from behind,
    // and the PATTERN (player.pattern) textures the plain sphere only. Both can be equipped at
    // once. Border FIRST — it rings from BEHIND so the cart body always sits on top (only the
    // rim past the body shows).
    var painter = cartSkinPainter(player.cart);
    drawTeamUnderglow(player, sx, sy);
    var bid = player.border;
    var bskin = (typeof getSkin === "function" && bid) ? getSkin(bid) : null;
    if (bskin && bskin.slot === 'border') {
        var bp = (typeof getSkinPainter === "function") ? getSkinPainter(bid) : null;
        // Shaped carts render CART_SKIN_VISUAL_SCALE larger than the physics radius,
        // so the border ring scales with them or its inner edge would be swallowed.
        var br = player.radius * (painter != null ? CART_SKIN_VISUAL_SCALE : 1);
        if (bp != null) { drawBorderOverlay(player, sx, sy, br, bp); }
    }
    if (painter != null) {
        drawCartSkin(player, sx, sy, player.radius, painter, headingOverride);
    } else {
        var sprite = getPlayerSprite(player.color, player.radius, null);
        if (sprite != null) {
            gameContext.drawImage(sprite, sx - sprite.halfSize, sy - sprite.halfSize);
        }
        // Pattern overlay on the plain sphere cart (patterns are scoped to the sphere). Drawn
        // here in the shared chokepoint, so it shows in every kart path (live, overview, recap).
        var pid = player.pattern;
        var pskin = (typeof getSkin === "function" && pid) ? getSkin(pid) : null;
        if (pskin && pskin.slot === 'pattern') {
            var patPainter = (typeof getSkinPainter === "function") ? getSkinPainter(pid) : null;
            if (patPainter != null) {
                drawPatternOverlay(player, sx, sy, player.radius, patPainter);
            }
        }
    }
    // Discord voice (Phase 5b): speaking ring framing the kart edge, drawn LAST in this
    // shared chokepoint (overview scoreboard, ice reflection, recap) so it sits on top of
    // the body. No-op off Discord / for web players.
    if (typeof drawSpeakingIndicator === "function") {
        drawSpeakingIndicator(player, sx, sy);
    }
}

// Shaped cart bodies render 20% larger than the physics radius so they read
// slightly bigger than the base sphere cart. Pure presentation: the server's
// collision radius is untouched (the client never feeds this back). Applied at
// the drawCartSkin chokepoint so every path (live racing, overview scoreboard,
// lava-burn, recap, ice reflection) agrees on the size.
var CART_SKIN_VISUAL_SCALE = 1.2;

function drawCartSkin(player, centerX, centerY, radius, painter, headingOverride) {
    var ctx = gameContext;
    // headingOverride pins the skin to a fixed angle (used by the overview scoreboard, a
    // static display — otherwise it'd freeze at whatever heading the kart had when the
    // race ended). A pinned heading also implies an idle pose (no movement-driven anim).
    var pinned = (typeof headingOverride === "number");
    var heading = pinned ? headingOverride : getCartHeading(player);
    var speed = pinned ? 0 : getCartSpeed(player);
    // STATUE carts (clocks, 8-ball, lucky cat, …) are drawn UPRIGHT — they skip the heading
    // rotation; their heading-tracking features read `heading` (4th painter arg) instead.
    var skin = (typeof getSkin === "function" && player && player.cart) ? getSkin(player.cart) : null;
    var statue = !!(skin && skin.statue);
    // Frozen painters animate off real elapsed seconds, but keep the existing speed-driven
    // wheel-spin feel for the original carts; both are fine, so retain the speed scaling.
    var anim = cartSkinAnimTime * (0.6 + Math.min(speed, 6) * 0.5);
    // Punch animation: a quick forward lunge + scale "pop" when this kart throws a
    // melee punch (seeded by the server "punch" event -> player.punchAnimAt). Sharp
    // attack (peak at 30% of the window) and gentler settle, so it reads as an impact
    // rather than a pulse; applies to every skin since it lives here in drawCartSkin.
    var punchK = 0;
    if (player && player.punchAnimAt != null) {
        var pe = (Date.now() - player.punchAnimAt) / 220;
        if (pe >= 0 && pe < 1) {
            punchK = (pe < 0.3) ? (pe / 0.3) : (1 - (pe - 0.3) / 0.7);
        }
    }
    ctx.save();
    ctx.translate(centerX, centerY);
    if (!statue) { ctx.rotate(heading); }
    ctx.scale(radius * CART_SKIN_VISUAL_SCALE, radius * CART_SKIN_VISUAL_SCALE);
    if (punchK > 0) {
        ctx.translate(punchK * 0.12, 0);                    // lunge forward (heading is local +X)
        ctx.scale(1 + punchK * 0.14, 1 + punchK * 0.14);    // impact pop
    }
    var paint = (player && player.color) ? player.color : null;
    // While burning, tint the skin toward glowing hot-orange (NOT black) so it reads as
    // the skin itself on fire while staying recognizable — charring toward black just
    // turned the small kart into an unreadable dark blob ("looks like a regular cart").
    if (paint && player.onFire > 0) {
        var hc = cartSkinRGB(paint), hf = 0.6;
        paint = "rgb(" + Math.round(hc.r + (255 - hc.r) * hf) + "," +
            Math.round(hc.g + (90 - hc.g) * hf) + "," +
            Math.round(hc.b + (10 - hc.b) * hf) + ")";
    }
    // Contract: painter(ctx, anim, paint, heading, hot). The frozen carts read `heading`
    // (4th); the original firetruck/dino read `hot` (5th) for their burn glow. The hot-orange
    // paint tint above already applies to every cart.
    painter(ctx, anim, paint, heading, !!(player && player.onFire > 0));
    ctx.restore();
}

// Pattern overlay: paints the equipped pattern's texture (tinted to player colour) on the
// kart, clipped to a disc so it stays on the body. Patterns are scoped to the plain sphere
// cart (callers only invoke this when no cart shape is equipped). Reads a per-pattern
// `opacity` from the registry (Phase P) so opaque full-repaint patterns let the body show.
function drawPatternOverlay(player, centerX, centerY, radius, painter) {
    var ctx = gameContext;
    var anim = cartSkinAnimTime;
    var pskin = (typeof getSkin === "function" && player && player.pattern) ? getSkin(player.pattern) : null;
    var op = (pskin && typeof pskin.opacity === "number") ? pskin.opacity : 1;
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.scale(radius, radius);
    ctx.beginPath();
    ctx.arc(0, 0, 0.95, 0, Math.PI * 2);
    ctx.clip();
    if (op !== 1) { ctx.globalAlpha = op; }
    painter(ctx, anim, (player && player.color) ? player.color : null);
    ctx.restore();
}

// Border overlay: paints the equipped border cosmetic AROUND the kart rim (r ~1.0..1.4),
// tinted to the player colour. Unlike patterns, borders draw OUTSIDE the rim (no disc clip)
// and compose over ANY cart (shaped body or the plain sphere), so there's NO heading rotate
// (borders are radial) and NO clip. Borders share the 2nd cosmetic slot with patterns and
// are disambiguated at the call sites via getSkin(id).slot === 'border'.
function drawBorderOverlay(player, centerX, centerY, radius, painter) {
    var ctx = gameContext;
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.scale(radius, radius);                 // NO clip (border draws outside the rim),
    painter(ctx, cartSkinAnimTime, (player && player.color) ? player.color : null); // NO heading rotate
    ctx.restore();
}

// Rounded-rect path helper (CanvasRenderingContext2D.roundRect isn't available on
// every target we support).
function cartRoundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
}

function drawFiretruckSkin(ctx, anim, paint, heading, hot) {
    // Normalized space (radius == 1), forward == +X. Five-Alarm monster truck,
    // painted in the player's chosen cart colour (tinted body + darker outline),
    // white "5" badge, ladder, big wheels with spinning spokes.
    paint = paint || "#d11f1f";
    var wheelR = 0.42;
    var wheels = [
        [0.5, 0.72],
        [0.5, -0.72],
        [-0.5, 0.72],
        [-0.5, -0.72],
    ];
    for (var i = 0; i < wheels.length; i++) {
        ctx.save();
        ctx.translate(wheels[i][0], wheels[i][1]);
        ctx.beginPath();
        ctx.arc(0, 0, wheelR, 0, Math.PI * 2);
        ctx.fillStyle = "#1a1a1a";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(0, 0, wheelR * 0.45, 0, Math.PI * 2);
        ctx.fillStyle = "#cfcfcf";
        ctx.fill();
        ctx.rotate(anim * 3); // spinning spokes
        ctx.strokeStyle = "#555";
        ctx.lineWidth = 0.06;
        for (var s = 0; s < 4; s++) {
            var a = (s * Math.PI) / 2;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(Math.cos(a) * wheelR * 0.85, Math.sin(a) * wheelR * 0.85);
            ctx.stroke();
        }
        ctx.restore();
    }

    // Body (player colour) with a darker outline of the same hue — or a bright glowing
    // outline while burning, so the hot-orange truck reads as molten-hot.
    ctx.fillStyle = cartSkinShade(paint, -0.05);
    ctx.strokeStyle = hot ? "#ffe27a" : cartSkinShade(paint, -0.45);
    ctx.lineWidth = 0.07;
    cartRoundRectPath(ctx, -0.78, -0.52, 1.56, 1.04, 0.18);
    ctx.fill();
    ctx.stroke();

    // Cab window (front, toward +X).
    ctx.fillStyle = "#bfe6ff";
    cartRoundRectPath(ctx, 0.28, -0.34, 0.4, 0.68, 0.08);
    ctx.fill();

    // Ladder rails + rungs.
    ctx.strokeStyle = "#e8e8e8";
    ctx.lineWidth = 0.05;
    ctx.beginPath();
    ctx.moveTo(-0.55, -0.18);
    ctx.lineTo(0.15, -0.18);
    ctx.moveTo(-0.55, 0.18);
    ctx.lineTo(0.15, 0.18);
    ctx.stroke();
    for (var r = 0; r < 4; r++) {
        var lx = -0.5 + r * 0.18;
        ctx.beginPath();
        ctx.moveTo(lx, -0.18);
        ctx.lineTo(lx, 0.18);
        ctx.stroke();
    }

    // White "5" badge.
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(-0.32, 0, 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = cartSkinShade(paint, -0.05);
    ctx.save();
    ctx.font = "0.3px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.translate(-0.32, 0);
    ctx.fillText("5", 0, 0.02);
    ctx.restore();
}

function drawDinoSkin(ctx, anim, paint, heading, hot) {
    // Top-down dino painted in the player's chosen cart colour (tinted body/limbs,
    // darker legs + spine of the same hue). Head toward +X, tail toward -X.
    paint = paint || "#43b047";
    var legSwing = Math.sin(anim * 4) * 0.22;
    // Scale the whole dino up so its body fills more of the cart's circle (it read
    // small next to the plain disc). The tail tip and head front are pulled in below
    // so that even after this scale the silhouette stays inside radius 1.0 (the cart
    // boundary) — nothing extends past where the regular cart would.
    ctx.save();
    ctx.scale(1.12, 1.12);
    // Contrasting dark outline traced around every part (not just the body/head, and
    // not the old low-contrast darkened-hue line) so the dino's silhouette reads
    // clearly against any terrain or kart colour — same idea as the regular cart's
    // black rim. Round joins/caps keep the outline clean at the leg/tail/spine points.
    // When burning, glow the outline bright and barely darken the limbs/spine, so the
    // hot-orange dino reads as molten-hot instead of a dark silhouette in the flames.
    var outline = hot ? "#ffe27a" : "#141414";
    var outlineW = 0.11;
    var shadeDeep = hot ? -0.1 : -0.35;
    var shadeTail = hot ? -0.04 : -0.12;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = outline;
    ctx.lineWidth = outlineW;

    // Legs (under body).
    ctx.fillStyle = cartSkinShade(paint, shadeDeep);
    var legs = [
        [0.28, 0.55, legSwing],
        [-0.3, 0.55, -legSwing],
        [0.28, -0.55, -legSwing],
        [-0.3, -0.55, legSwing],
    ];
    for (var i = 0; i < legs.length; i++) {
        ctx.beginPath();
        ctx.ellipse(legs[i][0] + legs[i][2], legs[i][1], 0.16, 0.1, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    }

    // Tail.
    ctx.fillStyle = cartSkinShade(paint, shadeTail);
    ctx.beginPath();
    ctx.moveTo(-0.55, -0.18);
    ctx.lineTo(-0.88, 0); // tail tip pulled in: -0.88 * 1.12 ≈ -0.99, inside the boundary
    ctx.lineTo(-0.55, 0.18);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Body.
    ctx.fillStyle = paint;
    ctx.beginPath();
    ctx.ellipse(-0.05, 0, 0.6, 0.45, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Spine plates.
    ctx.fillStyle = cartSkinShade(paint, shadeDeep);
    for (var p = 0; p < 3; p++) {
        var px = -0.3 + p * 0.28;
        ctx.beginPath();
        ctx.moveTo(px - 0.1, 0);
        ctx.lineTo(px, -0.22);
        ctx.lineTo(px + 0.1, 0);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
    }

    // Head.
    ctx.fillStyle = paint;
    ctx.beginPath();
    ctx.ellipse(0.58, 0, 0.3, 0.26, 0, 0, Math.PI * 2); // head pulled in: front 0.88 * 1.12 ≈ 0.99
    ctx.fill();
    ctx.stroke();

    // Eye.
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(0.68, -0.12, 0.07, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#111";
    ctx.beginPath();
    ctx.arc(0.70, -0.12, 0.035, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}
// rgba twin of cartSkinShade (glows/auras) — used by the ported frozen cart painters.
function cartSkinShadeA(color, amt, a) {
    var c = cartSkinRGB(color);
    var t = amt < 0 ? 0 : 255;
    var f = amt < 0 ? -amt : amt;
    return "rgba(" + Math.round(c.r + (t - c.r) * f) + "," + Math.round(c.g + (t - c.g) * f) + "," + Math.round(c.b + (t - c.b) * f) + "," + a + ")";
}

// === Cart bodies — FROZEN approved painters ported from the carts asset-design session
// (docs/asset-prototypes/carts.painters.js, 2026-05-30). Contract:
// drawXxxSkin(ctx, anim, paint, heading, hot) — anim=seconds, paint=player colour (already
// hot-tinted by drawCartSkin while on fire), heading=travel radians (only heading-tracking
// carts read it), hot unused by these. drawCartSkin handles statue (upright) carts via the
// registry flags. PARAMS defaults inlined. cartPolyPath ships with this block.
// --- 1. Hoverbike (Lv24, epic, cosmic) --------------------------------------
// Sleek single-rider hover-bike: low elongated teardrop hull, narrow waist, a
// tinted canopy bubble over the rider, twin rear thrusters with a pulsing glow,
// and a soft hover underglow shadow. No wheels (it floats).
function drawHoverbikeSkin(ctx, anim, paint) {
  paint = paint || "#5ad0ff";
  var len = (0.86);   // nose reach (+X)
  var glow = (0.62);
  var pulse = 0.5 + 0.5 * Math.sin(anim * 5);

  // Hover underglow (soft elliptical shadow/cushion under the hull).
  ctx.save();
  var ug = ctx.createRadialGradient(0, 0.06, 0.1, 0, 0.06, len * 0.95);
  ug.addColorStop(0, cartSkinShadeA(paint, 0.2, 0.30));
  ug.addColorStop(1, cartSkinShadeA(paint, 0.2, 0));
  ctx.fillStyle = ug;
  ctx.beginPath(); ctx.ellipse(-0.05, 0.06, len * 0.95, 0.46, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // Twin thruster glow plume (behind the hull, -X).
  ctx.save();
  for (var t = -1; t <= 1; t += 2) {
    var gy = t * 0.16;
    var pl = ctx.createRadialGradient(-len * 0.78, gy, 0.01, -len * 0.78 - 0.42, gy, 0.42);
    pl.addColorStop(0, cartSkinShadeA(paint, 0.55, 0.55 * glow + 0.25 * glow * pulse));
    pl.addColorStop(0.5, cartSkinShadeA(paint, 0.35, 0.28 * glow));
    pl.addColorStop(1, cartSkinShadeA(paint, 0.35, 0));
    ctx.fillStyle = pl;
    ctx.beginPath();
    ctx.ellipse(-len * 0.9 - 0.18, gy, 0.4 + 0.12 * pulse, 0.14, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // Main hull — elongated teardrop: pointed nose (+X), pinched tail (-X).
  ctx.beginPath();
  ctx.moveTo(len, 0);                                  // nose tip
  ctx.bezierCurveTo(len * 0.55, -0.34, 0.1, -0.36, -0.4, -0.26);
  ctx.bezierCurveTo(-len * 0.72, -0.18, -len * 0.82, -0.1, -len * 0.82, 0);
  ctx.bezierCurveTo(-len * 0.82, 0.1, -len * 0.72, 0.18, -0.4, 0.26);
  ctx.bezierCurveTo(0.1, 0.36, len * 0.55, 0.34, len, 0);
  ctx.closePath();
  var hull = ctx.createLinearGradient(0, -0.36, 0, 0.36);
  hull.addColorStop(0, cartSkinShade(paint, 0.32));    // top sheen
  hull.addColorStop(0.5, paint);
  hull.addColorStop(1, cartSkinShade(paint, -0.34));   // shaded belly
  ctx.fillStyle = hull;
  ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.5); ctx.lineWidth = 0.05; ctx.stroke();

  // Forward fairing fins (small swept side blades near the nose).
  ctx.fillStyle = cartSkinShade(paint, -0.18);
  for (var f = -1; f <= 1; f += 2) {
    ctx.beginPath();
    ctx.moveTo(0.34, f * 0.24);
    ctx.lineTo(0.66, f * 0.5);
    ctx.lineTo(0.52, f * 0.22);
    ctx.closePath(); ctx.fill();
  }

  // Dorsal spine line.
  ctx.strokeStyle = cartSkinShade(paint, 0.4); ctx.lineWidth = 0.03;
  ctx.beginPath(); ctx.moveTo(-len * 0.6, 0); ctx.lineTo(len * 0.5, 0); ctx.stroke();

  // Canopy bubble over rider (tinted glass, toward front-centre).
  ctx.beginPath(); ctx.ellipse(0.16, 0, 0.3, 0.17, 0, 0, Math.PI * 2);
  var glass = ctx.createLinearGradient(0, -0.17, 0, 0.17);
  glass.addColorStop(0, "rgba(220,245,255,0.95)");
  glass.addColorStop(1, cartSkinShadeA(paint, -0.2, 0.7));
  ctx.fillStyle = glass; ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.45); ctx.lineWidth = 0.03; ctx.stroke();

  // Thruster nozzles (dark rings at the tail).
  for (var n = -1; n <= 1; n += 2) {
    ctx.beginPath(); ctx.arc(-len * 0.8, n * 0.16, 0.1, 0, Math.PI * 2);
    ctx.fillStyle = "#15171c"; ctx.fill();
    ctx.beginPath(); ctx.arc(-len * 0.8, n * 0.16, 0.05, 0, Math.PI * 2);
    ctx.fillStyle = cartSkinShadeA(paint, 0.6, 0.5 + 0.5 * pulse); ctx.fill();
  }
}

// --- 2. Starfighter (Lv30, legendary, cosmic capstone) ----------------------
// Swept-wing space fighter: long dagger fuselage with a sharp nose (+X), big
// swept-back delta wings, a glowing cockpit canopy, twin engine bells at the
// tail with an animated flaming glow, and blinking wingtip nav lights.
function drawStarfighterSkin(ctx, anim, paint) {
  paint = paint || "#b08bff";
  var sweep = (0.58); // 0=straight,1=hard swept
  var glow = (0.70);
  var flick = 0.7 + 0.3 * Math.sin(anim * 14) * Math.sin(anim * 5.3);
  var wingBackX = -0.2 - 0.45 * sweep;   // how far the wing trailing edge sweeps back

  // Engine exhaust plumes (behind, -X), animated.
  ctx.save();
  for (var e = -1; e <= 1; e += 2) {
    var ey = e * 0.17;
    var fl = ctx.createLinearGradient(-0.82, ey, -1.05 - 0.25 * flick, ey);
    fl.addColorStop(0, cartSkinShadeA(paint, 0.7, 0.9 * glow));
    fl.addColorStop(0.4, cartSkinShadeA(paint, 0.5, 0.55 * glow * flick));
    fl.addColorStop(1, cartSkinShadeA(paint, 0.5, 0));
    ctx.fillStyle = fl;
    ctx.beginPath();
    ctx.moveTo(-0.82, ey - 0.1);
    ctx.lineTo(-1.06 - 0.28 * flick, ey);
    ctx.lineTo(-0.82, ey + 0.1);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();

  // Swept delta wings (drawn under the fuselage).
  ctx.beginPath();
  ctx.moveTo(0.18, 0.12);                 // wing root front
  ctx.lineTo(0.46, 0.16);                 // leading edge out
  ctx.lineTo(wingBackX, 0.92);            // swept wingtip
  ctx.lineTo(wingBackX - 0.16, 0.9);
  ctx.lineTo(-0.34, 0.16);                // trailing root
  ctx.closePath();
  ctx.moveTo(0.18, -0.12);
  ctx.lineTo(0.46, -0.16);
  ctx.lineTo(wingBackX, -0.92);
  ctx.lineTo(wingBackX - 0.16, -0.9);
  ctx.lineTo(-0.34, -0.16);
  ctx.closePath();
  var wingGrad = ctx.createLinearGradient(0.4, 0, wingBackX, 0.9);
  wingGrad.addColorStop(0, cartSkinShade(paint, -0.05));
  wingGrad.addColorStop(1, cartSkinShade(paint, -0.4));
  ctx.fillStyle = wingGrad;
  ctx.fill("evenodd");
  ctx.strokeStyle = cartSkinShade(paint, -0.55); ctx.lineWidth = 0.04; ctx.stroke();

  // Wing leading-edge accent stripes (bright hue).
  ctx.strokeStyle = cartSkinShade(paint, 0.45); ctx.lineWidth = 0.035;
  for (var w = -1; w <= 1; w += 2) {
    ctx.beginPath(); ctx.moveTo(0.44, w * 0.16); ctx.lineTo(wingBackX + 0.02, w * 0.88); ctx.stroke();
  }

  // Fuselage — long dagger with sharp nose.
  ctx.beginPath();
  ctx.moveTo(1.0, 0);                      // nose tip
  ctx.lineTo(0.5, -0.15);
  ctx.lineTo(-0.7, -0.2);
  ctx.lineTo(-0.86, -0.13);
  ctx.lineTo(-0.86, 0.13);
  ctx.lineTo(-0.7, 0.2);
  ctx.lineTo(0.5, 0.15);
  ctx.closePath();
  var fus = ctx.createLinearGradient(0, -0.2, 0, 0.2);
  fus.addColorStop(0, cartSkinShade(paint, 0.35));
  fus.addColorStop(0.5, paint);
  fus.addColorStop(1, cartSkinShade(paint, -0.32));
  ctx.fillStyle = fus; ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.55); ctx.lineWidth = 0.045; ctx.stroke();

  // Nose accent + centre spine.
  ctx.fillStyle = cartSkinShade(paint, -0.4);
  ctx.beginPath(); ctx.moveTo(1.0, 0); ctx.lineTo(0.62, -0.06); ctx.lineTo(0.62, 0.06); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, 0.4); ctx.lineWidth = 0.025;
  ctx.beginPath(); ctx.moveTo(-0.6, 0); ctx.lineTo(0.55, 0); ctx.stroke();

  // Cockpit canopy (glowing).
  ctx.beginPath(); ctx.ellipse(0.28, 0, 0.22, 0.12, 0, 0, Math.PI * 2);
  var can = ctx.createLinearGradient(0.28, -0.12, 0.28, 0.12);
  can.addColorStop(0, "rgba(225,245,255,0.97)");
  can.addColorStop(1, cartSkinShadeA(paint, 0.1, 0.85));
  ctx.fillStyle = can; ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.5); ctx.lineWidth = 0.025; ctx.stroke();

  // Twin engine bells at the tail.
  for (var b = -1; b <= 1; b += 2) {
    ctx.beginPath(); ctx.arc(-0.84, b * 0.17, 0.11, 0, Math.PI * 2);
    ctx.fillStyle = "#16181e"; ctx.fill();
    ctx.beginPath(); ctx.arc(-0.84, b * 0.17, 0.06, 0, Math.PI * 2);
    ctx.fillStyle = cartSkinShadeA(paint, 0.7, 0.6 + 0.4 * flick); ctx.fill();
  }

  // Blinking wingtip nav lights.
  var blink = (Math.sin(anim * 6) > 0) ? 1 : 0.15;
  for (var L = -1; L <= 1; L += 2) {
    ctx.beginPath(); ctx.arc(wingBackX - 0.06, L * 0.9, 0.05, 0, Math.PI * 2);
    ctx.fillStyle = cartSkinShadeA(paint, 0.75, blink); ctx.fill();
  }
}

// --- 3. Golden Champion (achievement) ---------------------------------------
// A golden LUCKY-CAT STATUE (maneki-neko), seen top-down and facing "up" (-Y).
// It is cast in polished gold (champion prestige), with the player's colour as
// the bib/collar + koban accent so each player's statue is still tellable apart.
// TWO things make this cart special vs. the others:
//   1. It is a STATUE: it does NOT spin to face travel. It always stands upright.
//   2. Its eyes (and the raised beckoning paw) TRACK the player's movement —
//      the pupils slide toward the heading direction, so the cat "looks where
//      you're going".
// Because of that it needs the heading: signature is (ctx, anim, paint, heading)
// where `heading` is the travel angle in RADIANS (0 = +X / east). PORT NOTE for
// the main session: drawCartSkin must, for this skin only, SKIP the heading
// rotation and pass `heading` through as the 4th arg (the other painters ignore
// a 4th arg, so this is backward-compatible). See STATUE_CARTS in carts.painters.js.
var GOLD = "#ffd84d", GOLD_HI = "#fff3b0", GOLD_DK = "#9c7414";
// Vertical polished-gold fill (top-lit), with a slow travelling specular streak.
function goldStatueFill(ctx, anim, y0, y1, sheen) {
  var g = ctx.createLinearGradient(0, y0, 0, y1);
  var streak = 0.5 + 0.42 * Math.sin(anim * 0.8);   // 0.08..0.92 drifting hotspot
  g.addColorStop(0, GOLD_HI);
  g.addColorStop(Math.max(0.02, streak - 0.12), GOLD);
  g.addColorStop(streak, "rgba(255,252,222," + (0.85 + 0.15 * sheen) + ")");
  g.addColorStop(Math.min(0.98, streak + 0.12), GOLD);
  g.addColorStop(1, GOLD_DK);
  return g;
}
function drawGoldenChampionSkin(ctx, anim, paint, heading) {
  paint = paint || "#c0182b";
  if (typeof heading !== "number") heading = 0;
  var pawWave = (0.60);   // beckon speed/throw
  var sheen = (0.55);
  // Where the cat is "looking" — the heading direction in the statue's local space.
  var lookX = Math.cos(heading), lookY = Math.sin(heading);

  // Soft gold floor-glow under the statue (sells "object sitting on the track").
  var floor = ctx.createRadialGradient(0, 0.12, 0.1, 0, 0.12, 0.95);
  floor.addColorStop(0, "rgba(255,216,77,0.22)");
  floor.addColorStop(1, "rgba(255,216,77,0)");
  ctx.fillStyle = floor;
  ctx.beginPath(); ctx.ellipse(0, 0.12, 0.92, 0.78, 0, 0, Math.PI * 2); ctx.fill();

  // Curled tail (gold), resting around the right side of the body.
  ctx.save();
  ctx.strokeStyle = GOLD_DK; ctx.lineWidth = 0.15; ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(0.42, 0.34);
  ctx.quadraticCurveTo(0.78, 0.3, 0.74, -0.04);
  ctx.stroke();
  ctx.strokeStyle = GOLD; ctx.lineWidth = 0.09;
  ctx.beginPath();
  ctx.moveTo(0.42, 0.34);
  ctx.quadraticCurveTo(0.78, 0.3, 0.74, -0.04);
  ctx.stroke();
  ctx.restore();

  // Resting left paw at the base.
  ctx.fillStyle = GOLD; ctx.strokeStyle = GOLD_DK; ctx.lineWidth = 0.02;
  ctx.beginPath(); ctx.ellipse(-0.26, 0.46, 0.14, 0.1, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

  // ---- Body (sitting, pear shape, gold) ----
  ctx.beginPath(); ctx.ellipse(0, 0.16, 0.5, 0.46, 0, 0, Math.PI * 2);
  ctx.fillStyle = goldStatueFill(ctx, anim, -0.3, 0.62, sheen); ctx.fill();
  ctx.strokeStyle = GOLD_DK; ctx.lineWidth = 0.04; ctx.stroke();

  // Player-colour bib/chest oval (the tint that identifies the owner).
  ctx.save();
  ctx.beginPath(); ctx.ellipse(0, 0.2, 0.3, 0.3, 0, 0, Math.PI * 2); ctx.clip();
  var bib = ctx.createLinearGradient(0, -0.1, 0, 0.5);
  bib.addColorStop(0, cartSkinShade(paint, 0.25));
  bib.addColorStop(1, cartSkinShade(paint, -0.25));
  ctx.fillStyle = bib; ctx.fillRect(-0.4, -0.2, 0.8, 0.8);
  ctx.restore();
  ctx.strokeStyle = GOLD_DK; ctx.lineWidth = 0.02;
  ctx.beginPath(); ctx.ellipse(0, 0.2, 0.3, 0.3, 0, 0, Math.PI * 2); ctx.stroke();

  // Koban (oval gold coin) held on the belly, with a player-colour glyph.
  ctx.save();
  ctx.translate(0, 0.26);
  ctx.beginPath(); ctx.ellipse(0, 0, 0.2, 0.13, 0, 0, Math.PI * 2);
  var koban = ctx.createLinearGradient(0, -0.13, 0, 0.13);
  koban.addColorStop(0, GOLD_HI); koban.addColorStop(1, GOLD);
  ctx.fillStyle = koban; ctx.fill();
  ctx.strokeStyle = GOLD_DK; ctx.lineWidth = 0.022; ctx.stroke();
  ctx.strokeStyle = cartSkinShade(paint, -0.2); ctx.lineWidth = 0.02;
  ctx.beginPath(); ctx.moveTo(-0.07, -0.04); ctx.lineTo(0.07, -0.04);
  ctx.moveTo(-0.05, 0.02); ctx.lineTo(0.05, 0.02); ctx.stroke();
  ctx.restore();

  // ---- Raised beckoning paw (right arm up by the head), waves, leans toward heading ----
  var beckon = (0.5 + 0.5 * Math.sin(anim * (1.5 + pawWave * 3))) * (0.06 + 0.08 * pawWave);
  ctx.save();
  ctx.translate(0.34, -0.34 - beckon);
  ctx.rotate(lookX * 0.18);                       // subtle lean toward travel direction
  ctx.strokeStyle = GOLD_DK; ctx.lineWidth = 0.12; ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(-0.06, 0.34); ctx.lineTo(0, 0); ctx.stroke();
  ctx.fillStyle = goldStatueFill(ctx, anim, -0.16, 0.1, sheen);
  ctx.beginPath(); ctx.ellipse(0, -0.04, 0.13, 0.15, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = GOLD_DK; ctx.lineWidth = 0.025; ctx.stroke();
  // toe lines
  ctx.lineWidth = 0.015;
  ctx.beginPath(); ctx.moveTo(-0.05, -0.12); ctx.lineTo(-0.05, -0.02);
  ctx.moveTo(0.05, -0.12); ctx.lineTo(0.05, -0.02); ctx.stroke();
  ctx.restore();

  // ---- Head (gold disc up top) ----
  var hy = -0.42;

  // Player-colour collar at the neck with a little gold bell (secondary colour).
  ctx.save();
  var collarY = -0.06;
  ctx.strokeStyle = cartSkinShade(paint, 0.05); ctx.lineWidth = 0.12; ctx.lineCap = "round";
  ctx.beginPath(); ctx.arc(0, collarY, 0.36, -2.5, -0.64); ctx.stroke();
  ctx.strokeStyle = cartSkinShade(paint, -0.3); ctx.lineWidth = 0.02;
  ctx.beginPath(); ctx.arc(0, collarY, 0.36, -2.5, -0.64); ctx.stroke();
  // bell hanging at the front of the collar
  var bellY = collarY + 0.34;
  var bellG = ctx.createRadialGradient(-0.02, bellY - 0.03, 0.01, 0, bellY, 0.1);
  bellG.addColorStop(0, GOLD_HI); bellG.addColorStop(1, GOLD);
  ctx.fillStyle = bellG; ctx.beginPath(); ctx.arc(0, bellY, 0.085, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = GOLD_DK; ctx.lineWidth = 0.018; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-0.055, bellY); ctx.lineTo(0.055, bellY); ctx.stroke();
  ctx.fillStyle = GOLD_DK; ctx.beginPath(); ctx.arc(0, bellY + 0.05, 0.02, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // Ears with player-colour inners (the secondary colour).
  for (var e = -1; e <= 1; e += 2) {
    ctx.fillStyle = GOLD; ctx.strokeStyle = GOLD_DK; ctx.lineWidth = 0.025;
    ctx.beginPath();
    ctx.moveTo(e * 0.12, hy - 0.24);
    ctx.lineTo(e * 0.34, hy - 0.5);
    ctx.lineTo(e * 0.4, hy - 0.18);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = cartSkinShade(paint, 0.12);   // bright player colour inner
    ctx.beginPath();
    ctx.moveTo(e * 0.17, hy - 0.27);
    ctx.lineTo(e * 0.3, hy - 0.42);
    ctx.lineTo(e * 0.32, hy - 0.24);
    ctx.closePath(); ctx.fill();
  }
  // Head disc.
  ctx.beginPath(); ctx.arc(0, hy, 0.36, 0, Math.PI * 2);
  ctx.fillStyle = goldStatueFill(ctx, anim, hy - 0.36, hy + 0.36, sheen); ctx.fill();
  ctx.strokeStyle = GOLD_DK; ctx.lineWidth = 0.035; ctx.stroke();

  // Eyes — whites with dark pupils that SLIDE toward the heading direction.
  for (var i2 = -1; i2 <= 1; i2 += 2) {
    var ex = i2 * 0.14, ey = hy - 0.04;
    ctx.fillStyle = "#fffdf2";
    ctx.beginPath(); ctx.ellipse(ex, ey, 0.075, 0.09, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = GOLD_DK; ctx.lineWidth = 0.014; ctx.stroke();
    // pupil tracks travel direction
    ctx.fillStyle = "#16100a";
    ctx.beginPath();
    ctx.arc(ex + lookX * 0.035, ey + lookY * 0.05, 0.04, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = GOLD_HI; // glint
    ctx.beginPath();
    ctx.arc(ex + lookX * 0.035 + 0.015, ey + lookY * 0.05 - 0.02, 0.012, 0, Math.PI * 2); ctx.fill();
  }
  // Nose + mouth.
  ctx.fillStyle = cartSkinShade(paint, -0.1);
  ctx.beginPath(); ctx.moveTo(-0.03, hy + 0.12); ctx.lineTo(0.03, hy + 0.12); ctx.lineTo(0, hy + 0.16); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = GOLD_DK; ctx.lineWidth = 0.016;
  ctx.beginPath();
  ctx.moveTo(0, hy + 0.16); ctx.quadraticCurveTo(-0.06, hy + 0.21, -0.1, hy + 0.17);
  ctx.moveTo(0, hy + 0.16); ctx.quadraticCurveTo(0.06, hy + 0.21, 0.1, hy + 0.17);
  ctx.stroke();
  // Whiskers.
  ctx.strokeStyle = "rgba(156,116,20,0.8)"; ctx.lineWidth = 0.014;
  for (var ws = -1; ws <= 1; ws += 2) {
    ctx.beginPath(); ctx.moveTo(ws * 0.08, hy + 0.12); ctx.lineTo(ws * 0.42, hy + 0.06); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ws * 0.08, hy + 0.16); ctx.lineTo(ws * 0.42, hy + 0.18); ctx.stroke();
  }

  // Tiny gold crown coronet between the ears (champion mark).
  ctx.save();
  ctx.translate(0, hy - 0.34);
  ctx.fillStyle = GOLD; ctx.strokeStyle = GOLD_DK; ctx.lineWidth = 0.018;
  ctx.beginPath();
  ctx.moveTo(-0.13, 0.06); ctx.lineTo(-0.13, -0.02); ctx.lineTo(-0.06, 0.03);
  ctx.lineTo(0, -0.06); ctx.lineTo(0.06, 0.03); ctx.lineTo(0.13, -0.02);
  ctx.lineTo(0.13, 0.06); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = cartSkinShade(paint, 0.0);
  ctx.beginPath(); ctx.arc(0, 0.02, 0.022, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// --- 4. Warlord (achievement) -----------------------------------------------
// A heavy armoured war machine: wide angular chassis, riveted bolt-on plates,
// a toothed ram/spikes on the nose (+X), battle-scar gouges, and twin smoke
// exhaust stacks. Tints to paint with dark gunmetal plating of the same hue.
function drawWarlordSkin(ctx, anim, paint) {
  paint = paint || "#8a3b2b";
  var spike = (0.55);
  var plate = (0.60);
  var rumble = Math.sin(anim * 9) * 0.012;     // engine shudder

  ctx.save();
  ctx.translate(0, rumble);

  // Heavy treads (dark slabs along each side instead of round wheels).
  ctx.fillStyle = "#141414";
  cartRoundRectPath(ctx, -0.7, 0.46, 1.32, 0.3, 0.08); ctx.fill();
  cartRoundRectPath(ctx, -0.7, -0.76, 1.32, 0.3, 0.08); ctx.fill();
  // Tread lugs (scrolling).
  ctx.fillStyle = "#2c2c2c";
  for (var side = -1; side <= 1; side += 2) {
    var ty = side > 0 ? 0.46 : -0.76;
    var off = ((anim * 0.4) % 0.22);
    for (var lx = -0.68 + off; lx < 0.62; lx += 0.22) {
      ctx.fillRect(lx, ty + 0.02, 0.08, 0.26);
    }
  }

  // Nose ram with teeth (spikes), toward +X.
  var sp = 0.18 + 0.4 * spike;
  ctx.fillStyle = cartSkinShade(paint, -0.55);
  ctx.beginPath();
  ctx.moveTo(0.62, -0.46);
  ctx.lineTo(0.62 + sp * 0.4, -0.46);
  for (var tth = -3; tth <= 3; tth++) {
    var ty2 = tth * 0.15;
    ctx.lineTo(0.62 + sp, ty2 - 0.06);
    ctx.lineTo(0.62 + sp * 0.45, ty2);
    ctx.lineTo(0.62 + sp, ty2 + 0.06);
  }
  ctx.lineTo(0.62 + sp * 0.4, 0.46);
  ctx.lineTo(0.62, 0.46);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#0d0d0d"; ctx.lineWidth = 0.03; ctx.stroke();

  // Main hull — wide angular slab.
  ctx.beginPath();
  ctx.moveTo(0.66, -0.4);
  ctx.lineTo(0.74, 0);
  ctx.lineTo(0.66, 0.4);
  ctx.lineTo(-0.66, 0.5);
  ctx.lineTo(-0.78, 0.2);
  ctx.lineTo(-0.78, -0.2);
  ctx.lineTo(-0.66, -0.5);
  ctx.closePath();
  var hull = ctx.createLinearGradient(0, -0.5, 0, 0.5);
  hull.addColorStop(0, cartSkinShade(paint, 0.18));
  hull.addColorStop(0.5, cartSkinShade(paint, -0.08));
  hull.addColorStop(1, cartSkinShade(paint, -0.4));
  ctx.fillStyle = hull; ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.6); ctx.lineWidth = 0.06; ctx.stroke();

  // Bolt-on armour plates (darker gunmetal of the same hue), with rivets.
  var plateCol = cartSkinShade(paint, -0.3 - 0.25 * plate);
  var rivet = cartSkinShade(paint, 0.25);
  function platePanel(x, y, w, h) {
    ctx.fillStyle = plateCol;
    cartRoundRectPath(ctx, x, y, w, h, 0.04); ctx.fill();
    ctx.strokeStyle = "#0e0e0e"; ctx.lineWidth = 0.022; ctx.stroke();
    ctx.fillStyle = rivet;
    var rs = 0.022;
    ctx.beginPath(); ctx.arc(x + 0.05, y + 0.05, rs, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(x + w - 0.05, y + 0.05, rs, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(x + 0.05, y + h - 0.05, rs, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(x + w - 0.05, y + h - 0.05, rs, 0, Math.PI*2); ctx.fill();
  }
  platePanel(-0.6, -0.42, 0.46, 0.34);
  platePanel(-0.6, 0.08, 0.46, 0.34);
  platePanel(-0.05, -0.4, 0.5, 0.3);
  platePanel(-0.05, 0.1, 0.5, 0.3);

  // Central armoured cockpit hatch (angular, slit window).
  ctx.fillStyle = cartSkinShade(paint, -0.15);
  ctx.beginPath();
  ctx.moveTo(0.34, -0.2); ctx.lineTo(0.16, -0.26); ctx.lineTo(-0.02, -0.2);
  ctx.lineTo(-0.02, 0.2); ctx.lineTo(0.16, 0.26); ctx.lineTo(0.34, 0.2);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = "#0e0e0e"; ctx.lineWidth = 0.03; ctx.stroke();
  ctx.fillStyle = "rgba(120,160,190,0.5)";
  cartRoundRectPath(ctx, 0.04, -0.07, 0.24, 0.14, 0.03); ctx.fill();

  // Battle-scar gouges (light scratches across the plating).
  ctx.strokeStyle = cartSkinShadeA(paint, 0.5, 0.5); ctx.lineWidth = 0.018;
  ctx.beginPath(); ctx.moveTo(-0.4, -0.3); ctx.lineTo(-0.18, -0.12); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-0.5, 0.22); ctx.lineTo(-0.28, 0.3); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0.1, -0.32); ctx.lineTo(0.26, -0.2); ctx.stroke();

  // Twin exhaust stacks at the rear with smoke puffs.
  for (var ex = -1; ex <= 1; ex += 2) {
    ctx.fillStyle = "#101010";
    ctx.beginPath(); ctx.arc(-0.74, ex * 0.28, 0.07, 0, Math.PI * 2); ctx.fill();
    var puff = 0.5 + 0.5 * Math.sin(anim * 6 + ex);
    ctx.fillStyle = "rgba(60,60,60," + (0.3 + 0.25 * puff) + ")";
    ctx.beginPath(); ctx.arc(-0.86 - 0.06 * puff, ex * 0.28, 0.05 + 0.03 * puff, 0, Math.PI * 2); ctx.fill();
  }

  ctx.restore();
}

// ============================================================================
// FUN / NOVELTY carts (operator request). Like the lucky cat, each keeps its
// iconic colours and uses the player colour as an accent so owners are still
// tellable apart. Smiley / Earth / 8-Ball are STATUES (drawn upright so the
// face/number stays readable); Pizza is a normal rolling cart.
// ============================================================================

// Pizza pie — a rolling pizza with a missing slice, pepperoni, melty cheese.
// The plate/pan underneath is the player-colour accent.
function drawPizzaSkin(ctx, anim, paint) {
  paint = paint || "#e07b39";
  // Player-colour pan/plate under the pie.
  ctx.beginPath(); ctx.arc(0, 0, 0.98, 0, Math.PI * 2);
  ctx.fillStyle = cartSkinShade(paint, -0.1); ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.45); ctx.lineWidth = 0.05; ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, 0.9, 0, Math.PI * 2);
  ctx.fillStyle = cartSkinShade(paint, 0.15); ctx.fill();
  // Crust ring.
  ctx.beginPath(); ctx.arc(0, 0, 0.84, 0, Math.PI * 2);
  var crust = ctx.createRadialGradient(0, 0, 0.45, 0, 0, 0.84);
  crust.addColorStop(0, "#f0c074"); crust.addColorStop(0.8, "#d99a3c"); crust.addColorStop(1, "#b3741f");
  ctx.fillStyle = crust; ctx.fill();
  // Cheese.
  ctx.beginPath(); ctx.arc(0, 0, 0.68, 0, Math.PI * 2);
  var cheese = ctx.createRadialGradient(-0.15, -0.15, 0.1, 0, 0, 0.7);
  cheese.addColorStop(0, "#ffd967"); cheese.addColorStop(1, "#eab843");
  ctx.fillStyle = cheese; ctx.fill();
  // Missing slice — wedge cut showing the plate underneath.
  var cutA = 0.55, cutW = 0.62;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 0.86, cutA, cutA + cutW); ctx.closePath();
  ctx.fillStyle = cartSkinShade(paint, 0.15); ctx.fill();
  ctx.strokeStyle = "#c8862f"; ctx.lineWidth = 0.03; ctx.stroke();
  // Pepperoni — all sit on the cheese (radius <= 0.55) and clear of the cut wedge.
  ctx.fillStyle = "#b0322a";
  var pepR = 0.1;
  var peps = [[0.3, 0.1], [-0.24, 0.28], [-0.34, -0.2], [0.16, -0.32], [-0.02, -0.02], [0.34, -0.2], [-0.46, 0.04]];
  for (var i = 0; i < peps.length; i++) {
    var pxr = peps[i][0], pyr = peps[i][1];
    // skip anything that would fall inside the missing-slice wedge
    var pang = Math.atan2(pyr, pxr); if (pang < 0) pang += Math.PI * 2;
    if (pang >= cutA && pang <= cutA + cutW) continue;
    if (pxr * pxr + pyr * pyr > 0.55 * 0.55) continue;   // keep on the cheese
    ctx.fillStyle = "#b0322a";
    ctx.beginPath(); ctx.arc(pxr, pyr, pepR, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#92271f";
    ctx.beginPath(); ctx.arc(pxr + 0.02, pyr + 0.02, 0.05, 0, Math.PI * 2); ctx.fill();
  }
  // A couple of basil leaves + cheese-bubble highlights for life.
  ctx.fillStyle = "#3f8f3a";
  ctx.beginPath(); ctx.ellipse(-0.42, -0.4, 0.06, 0.035, -0.4, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(0.42, 0.18, 0.06, 0.035, 0.3, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.beginPath(); ctx.arc(0.05, -0.18, 0.05, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(-0.18, 0.12, 0.04, 0, Math.PI * 2); ctx.fill();
}

// Planet Earth — ocean globe with drifting continents + clouds, a tinted
// atmosphere halo, and a little player-colour satellite in orbit (the accent).
function drawEarthSkin(ctx, anim, paint, heading) {
  paint = paint || "#4a78e0";
  // Atmosphere halo, tinted to the player colour.
  var halo = ctx.createRadialGradient(0, 0, 0.78, 0, 0, 1.0);
  halo.addColorStop(0, cartSkinShadeA(paint, 0.4, 0));
  halo.addColorStop(0.82, cartSkinShadeA(paint, 0.5, 0.45));
  halo.addColorStop(1, cartSkinShadeA(paint, 0.5, 0));
  ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(0, 0, 1.0, 0, Math.PI * 2); ctx.fill();

  // Orbiting satellite. The orbit is tilted; on the far half (top) it passes
  // BEHIND the globe, so we draw it before the globe there and after on the near half.
  var oa = anim * 1.4;
  var sxo = Math.cos(oa) * 0.98, syo = Math.sin(oa) * 0.34;
  var behind = Math.sin(oa) < 0;       // top half of the orbit = behind the planet
  function drawMoon() {
    ctx.fillStyle = cartSkinShade(paint, 0.1);
    ctx.beginPath(); ctx.arc(sxo, syo, 0.07, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = cartSkinShade(paint, -0.4); ctx.lineWidth = 0.02; ctx.stroke();
  }
  if (behind) drawMoon();

  ctx.save();
  ctx.beginPath(); ctx.arc(0, 0, 0.82, 0, Math.PI * 2); ctx.clip();
  // Ocean.
  var ocean = ctx.createRadialGradient(-0.28, -0.28, 0.1, 0, 0, 1.0);
  ocean.addColorStop(0, "#41a6e6"); ocean.addColorStop(1, "#0b3a78");
  ctx.fillStyle = ocean; ctx.fillRect(-1, -1, 2, 2);
  // Continents (a blob group scrolled horizontally for a rolling-globe feel).
  var scroll = ((anim * 0.18) % 1.64) - 0.82;
  function land(ox) {
    ctx.save(); ctx.translate(ox, 0);
    ctx.fillStyle = "#3f9b46";
    var blobs = [[-0.2, -0.3, 0.26, 0.18], [0.05, -0.1, 0.2, 0.26], [-0.35, 0.25, 0.22, 0.16],
                 [0.3, 0.3, 0.18, 0.22], [0.45, -0.35, 0.14, 0.12]];
    for (var b = 0; b < blobs.length; b++) {
      ctx.beginPath(); ctx.ellipse(blobs[b][0], blobs[b][1], blobs[b][2], blobs[b][3], 0.4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = "#327d3a";
    ctx.beginPath(); ctx.ellipse(0.0, -0.12, 0.1, 0.13, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  land(scroll); land(scroll + 1.64); land(scroll - 1.64);
  // Drifting clouds.
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  var cl = ((anim * 0.26) % 1.8) - 0.9;
  for (var c = 0; c < 3; c++) {
    var cx2 = ((cl + c * 0.7 + 0.9) % 1.8) - 0.9;
    var cy2 = -0.35 + c * 0.32;
    ctx.beginPath(); ctx.ellipse(cx2, cy2, 0.22, 0.08, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx2 + 0.14, cy2 + 0.03, 0.12, 0.06, 0, 0, Math.PI * 2); ctx.fill();
  }
  // Sphere shading (terminator) for 3D.
  var term = ctx.createRadialGradient(-0.3, -0.3, 0.2, 0, 0, 1.05);
  term.addColorStop(0, "rgba(255,255,255,0.18)");
  term.addColorStop(0.6, "rgba(0,0,0,0)");
  term.addColorStop(1, "rgba(0,0,20,0.5)");
  ctx.fillStyle = term; ctx.fillRect(-1, -1, 2, 2);
  ctx.restore();

  if (!behind) drawMoon();   // near half of the orbit: in front of the planet
}

// Smiley emoji — a classic grin that FULLY tints to the player colour, with a
// blink and a slight squash bounce.
function drawSmileySkin(ctx, anim, paint, heading) {
  paint = paint || "#f5d142";
  var bounce = 1 + Math.sin(anim * 4) * 0.03;
  ctx.save(); ctx.scale(1 / bounce, bounce);
  // Face.
  ctx.beginPath(); ctx.arc(0, 0, 0.9, 0, Math.PI * 2);
  var f = ctx.createRadialGradient(-0.3, -0.3, 0.1, 0, 0, 1.0);
  f.addColorStop(0, cartSkinShade(paint, 0.4));
  f.addColorStop(1, paint);
  ctx.fillStyle = f; ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.45); ctx.lineWidth = 0.05; ctx.stroke();
  // Eyes (blink every few seconds).
  var phase = anim % 3.2;
  var blink = (phase > 3.0) ? 0.12 : 1;
  ctx.fillStyle = "#2a1c08";
  for (var e = -1; e <= 1; e += 2) {
    ctx.beginPath(); ctx.ellipse(e * 0.32, -0.2, 0.12, 0.17 * blink, 0, 0, Math.PI * 2); ctx.fill();
  }
  if (blink === 1) {
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    for (var e2 = -1; e2 <= 1; e2 += 2) {
      ctx.beginPath(); ctx.arc(e2 * 0.32 + 0.04, -0.26, 0.035, 0, Math.PI * 2); ctx.fill();
    }
  }
  // Grin (just the line — no tongue/lips).
  ctx.strokeStyle = "#2a1c08"; ctx.lineWidth = 0.11; ctx.lineCap = "round";
  ctx.beginPath(); ctx.arc(0, 0.05, 0.5, 0.18 * Math.PI, 0.82 * Math.PI); ctx.stroke();
  // Rosy cheeks.
  ctx.fillStyle = cartSkinShadeA(paint, -0.25, 0.4);
  ctx.beginPath(); ctx.arc(-0.5, 0.12, 0.1, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(0.5, 0.12, 0.1, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// Magic 8-Ball — glossy black sphere. It randomly SHAKES (jitters) and then a
// classic answer surfaces in a blue triangle window before settling back to the
// "8". Player colour rings the answer window (the accent).
var EIGHTBALL_ANSWERS = ["YES", "NO", "MAYBE", "ASK\nAGAIN", "FOR\nSURE", "NOPE",
  "IT IS\nCERTAIN", "DON'T\nCOUNT\nON IT", "MOST\nLIKELY", "OUTLOOK\nGOOD",
  "VERY\nDOUBTFUL", "TRY\nLATER"];
var eightBall = { init: false, phase: "rest", until: 0, answer: "YES" };
function eightBallTick(anim) {
  if (!eightBall.init) {
    eightBall.init = true; eightBall.until = anim + 1.5 + Math.random() * 2;
    eightBall.answer = EIGHTBALL_ANSWERS[(Math.random() * EIGHTBALL_ANSWERS.length) | 0];
  }
  if (anim >= eightBall.until) {
    if (eightBall.phase === "rest") { eightBall.phase = "shake"; eightBall.until = anim + 0.75; }
    else if (eightBall.phase === "shake") {
      eightBall.phase = "reveal"; eightBall.until = anim + 2.8;
      eightBall.answer = EIGHTBALL_ANSWERS[(Math.random() * EIGHTBALL_ANSWERS.length) | 0];
    } else { eightBall.phase = "rest"; eightBall.until = anim + 2 + Math.random() * 3; }
  }
}
function drawEightBallSkin(ctx, anim, paint, heading) {
  paint = paint || "#3f6fe0";
  eightBallTick(anim);
  ctx.save();
  if (eightBall.phase === "shake") {                 // physical jitter while shaking
    ctx.translate((Math.random() - 0.5) * 0.09, (Math.random() - 0.5) * 0.09);
    ctx.rotate((Math.random() - 0.5) * 0.07);
  }
  // Black sphere.
  ctx.beginPath(); ctx.arc(0, 0, 0.9, 0, Math.PI * 2);
  var ball = ctx.createRadialGradient(-0.3, -0.32, 0.1, 0, 0, 1.05);
  ball.addColorStop(0, "#3a3a3a"); ball.addColorStop(0.5, "#161616"); ball.addColorStop(1, "#000");
  ctx.fillStyle = ball; ctx.fill();

  if (eightBall.phase === "reveal") {
    // Blue answer window (triangle die seen through the glass), player-colour rim.
    ctx.beginPath(); ctx.arc(0, 0.04, 0.46, 0, Math.PI * 2);
    ctx.fillStyle = cartSkinShade(paint, -0.05); ctx.fill();
    ctx.beginPath(); ctx.arc(0, 0.04, 0.4, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(10,20,60,0.85)"; ctx.fill();
    // upward triangle
    ctx.beginPath(); ctx.moveTo(0, -0.32); ctx.lineTo(0.34, 0.26); ctx.lineTo(-0.34, 0.26); ctx.closePath();
    var tri = ctx.createLinearGradient(0, -0.32, 0, 0.26);
    tri.addColorStop(0, "#23409a"); tri.addColorStop(1, "#0e1f5c");
    ctx.fillStyle = tri; ctx.fill();
    ctx.strokeStyle = cartSkinShade(paint, 0.2); ctx.lineWidth = 0.02; ctx.stroke();
    // answer text (supports up to 3 short lines)
    var lines = eightBall.answer.split("\n");
    var fs = lines.length >= 3 ? 0.1 : (lines.length === 2 ? 0.12 : 0.16);
    ctx.fillStyle = "#eaf0ff";
    ctx.font = "bold " + fs + "px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    var lh = fs * 1.15, y0 = 0.06 - (lines.length - 1) * lh / 2;
    for (var li = 0; li < lines.length; li++) ctx.fillText(lines[li], 0, y0 + li * lh);
  } else if (eightBall.phase === "shake") {
    // murky swirl while the answer is still settling.
    ctx.beginPath(); ctx.arc(0, 0.04, 0.4, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(12,24,66,0.9)"; ctx.fill();
    ctx.fillStyle = "rgba(120,150,220,0.5)";
    for (var b = 0; b < 4; b++) {
      var ba = anim * 6 + b * 1.7;
      ctx.beginPath(); ctx.arc(Math.cos(ba) * 0.18, 0.04 + Math.sin(ba) * 0.16, 0.05, 0, Math.PI * 2); ctx.fill();
    }
  } else {
    // Resting: the classic white "8" disc.
    ctx.beginPath(); ctx.arc(0.04, 0.06, 0.42, 0, Math.PI * 2);
    ctx.fillStyle = cartSkinShade(paint, -0.05); ctx.fill();
    ctx.beginPath(); ctx.arc(0.04, 0.06, 0.36, 0, Math.PI * 2);
    ctx.fillStyle = "#f4f4f4"; ctx.fill();
    ctx.fillStyle = "#111";
    ctx.save(); ctx.translate(0.04, 0.06);
    ctx.font = "bold 0.5px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("8", 0, 0.02);
    ctx.restore();
  }

  // Travelling specular highlight (glossy).
  var ga = anim * 0.6;
  var gx = -0.34 + Math.sin(ga) * 0.06, gy = -0.36 + Math.cos(ga) * 0.05;
  var glint = ctx.createRadialGradient(gx, gy, 0.01, gx, gy, 0.32);
  glint.addColorStop(0, "rgba(255,255,255,0.7)");
  glint.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glint;
  ctx.beginPath(); ctx.ellipse(gx, gy, 0.3, 0.18, -0.6, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// Saw Blade — a menacing steel circular-saw disc that spins fast; the centre hub
// is the player-colour accent. (Other circular ideas live below it.)
function drawSawBladeSkin(ctx, anim, paint) {
  paint = paint || "#9aa3ad";
  ctx.save();
  ctx.rotate(anim * 6);   // fast, threatening spin (on top of any heading rotation)
  var steel = ctx.createRadialGradient(-0.25, -0.25, 0.1, 0, 0, 1.0);
  steel.addColorStop(0, "#eef2f6"); steel.addColorStop(0.55, "#aeb6c0"); steel.addColorStop(1, "#79828c");
  // Toothed rim.
  var teeth = 14, rOut = 0.98, rIn = 0.8, step = (Math.PI * 2) / teeth;
  ctx.beginPath();
  for (var t = 0; t < teeth; t++) {
    var a0 = t * step, aTip = a0 + step * 0.32, a1 = a0 + step * 0.5;
    if (t === 0) ctx.moveTo(Math.cos(a0) * rIn, Math.sin(a0) * rIn);
    else ctx.lineTo(Math.cos(a0) * rIn, Math.sin(a0) * rIn);
    ctx.lineTo(Math.cos(aTip) * rOut, Math.sin(aTip) * rOut);
    ctx.lineTo(Math.cos(a1) * rIn, Math.sin(a1) * rIn);
  }
  ctx.closePath();
  ctx.fillStyle = steel; ctx.fill();
  ctx.strokeStyle = "#5b636d"; ctx.lineWidth = 0.03; ctx.stroke();
  // Body plate.
  ctx.beginPath(); ctx.arc(0, 0, 0.74, 0, Math.PI * 2); ctx.fillStyle = steel; ctx.fill();
  ctx.strokeStyle = "#69727c"; ctx.lineWidth = 0.02;
  ctx.beginPath(); ctx.arc(0, 0, 0.62, 0, Math.PI * 2); ctx.stroke();
  // Slots (relief cuts) for that real-saw look.
  ctx.strokeStyle = "rgba(40,46,54,0.7)"; ctx.lineWidth = 0.05;
  for (var s = 0; s < 5; s++) {
    var sa = s * (Math.PI * 2) / 5;
    ctx.beginPath();
    ctx.moveTo(Math.cos(sa) * 0.5, Math.sin(sa) * 0.5);
    ctx.lineTo(Math.cos(sa + 0.12) * 0.66, Math.sin(sa + 0.12) * 0.66);
    ctx.stroke();
  }
  // Bolt holes.
  ctx.fillStyle = "#3c434c";
  for (var h = 0; h < 4; h++) {
    var ha = h * Math.PI / 2 + 0.4;
    ctx.beginPath(); ctx.arc(Math.cos(ha) * 0.46, Math.sin(ha) * 0.46, 0.05, 0, Math.PI * 2); ctx.fill();
  }
  // Player-colour hub.
  ctx.beginPath(); ctx.arc(0, 0, 0.28, 0, Math.PI * 2);
  var hub = ctx.createRadialGradient(-0.06, -0.06, 0.02, 0, 0, 0.28);
  hub.addColorStop(0, cartSkinShade(paint, 0.3)); hub.addColorStop(1, cartSkinShade(paint, -0.2));
  ctx.fillStyle = hub; ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.45); ctx.lineWidth = 0.025; ctx.stroke();
  ctx.fillStyle = "#2b3038"; ctx.beginPath(); ctx.arc(0, 0, 0.07, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// Donut — frosting tints to the player colour, with sprinkles, dough, and a hole.
function drawDonutSkin(ctx, anim, paint) {
  paint = paint || "#f06ea9";
  // Dough ring.
  ctx.beginPath(); ctx.arc(0, 0, 0.92, 0, Math.PI * 2);
  var dough = ctx.createRadialGradient(0, 0, 0.4, 0, 0, 0.92);
  dough.addColorStop(0, "#d39a5c"); dough.addColorStop(1, "#a96a2e");
  ctx.fillStyle = dough; ctx.fill();
  // Frosting (player colour) with a wavy drip edge.
  ctx.beginPath();
  for (var a = 0; a <= Math.PI * 2 + 0.01; a += 0.2) {
    var rr = 0.78 + Math.sin(a * 7) * 0.04;
    var x = Math.cos(a) * rr, y = Math.sin(a) * rr;
    if (a === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  var fr = ctx.createRadialGradient(-0.2, -0.2, 0.2, 0, 0, 0.82);
  fr.addColorStop(0, cartSkinShade(paint, 0.3)); fr.addColorStop(1, paint);
  ctx.fillStyle = fr; ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.35); ctx.lineWidth = 0.02; ctx.stroke();
  // Sprinkles (deterministic positions on the frosting band).
  var SPRINK = ["#ffffff", "#ffd84d", "#5ec85e", "#4a78e0", "#ef6fb0", "#ff7043"];
  for (var i = 0; i < 14; i++) {
    var sa = i * 2.39963, sr = 0.45 + (i % 3) * 0.1;   // golden-angle scatter
    ctx.save();
    ctx.translate(Math.cos(sa) * sr, Math.sin(sa) * sr);
    ctx.rotate(sa * 1.7);
    ctx.fillStyle = SPRINK[i % SPRINK.length];
    ctx.fillRect(-0.045, -0.014, 0.09, 0.028);
    ctx.restore();
  }
  // Hole.
  ctx.beginPath(); ctx.arc(0, 0, 0.34, 0, Math.PI * 2);
  ctx.fillStyle = "#b07a3e"; ctx.fill();
  ctx.beginPath(); ctx.arc(0, 0, 0.27, 0, Math.PI * 2);
  ctx.fillStyle = "#3a2a1c"; ctx.fill();
}

// Vinyl Record — a spinning black record with grooves and a player-colour label.
function drawVinylSkin(ctx, anim, paint, heading) {
  paint = paint || "#d23b6a";
  ctx.save();
  ctx.rotate(anim * 3);
  ctx.beginPath(); ctx.arc(0, 0, 0.95, 0, Math.PI * 2);
  var disc = ctx.createRadialGradient(-0.2, -0.2, 0.2, 0, 0, 1.0);
  disc.addColorStop(0, "#2a2a2e"); disc.addColorStop(1, "#0a0a0c");
  ctx.fillStyle = disc; ctx.fill();
  // Grooves.
  ctx.strokeStyle = "rgba(255,255,255,0.06)"; ctx.lineWidth = 0.012;
  for (var r = 0.42; r < 0.92; r += 0.06) {
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
  }
  // Label (player colour).
  ctx.beginPath(); ctx.arc(0, 0, 0.36, 0, Math.PI * 2);
  var lab = ctx.createRadialGradient(-0.08, -0.08, 0.04, 0, 0, 0.36);
  lab.addColorStop(0, cartSkinShade(paint, 0.3)); lab.addColorStop(1, paint);
  ctx.fillStyle = lab; ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.4); ctx.lineWidth = 0.02; ctx.stroke();
  ctx.strokeStyle = cartSkinShade(paint, -0.2); ctx.lineWidth = 0.012;
  ctx.beginPath(); ctx.arc(0, 0, 0.24, 0, Math.PI * 2); ctx.stroke();
  // Spindle hole.
  ctx.fillStyle = "#0a0a0c"; ctx.beginPath(); ctx.arc(0, 0, 0.045, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  // Static sheen streak (light reflecting off the vinyl — stays put while it spins).
  var sheen = ctx.createLinearGradient(-0.7, -0.7, 0.2, 0.2);
  sheen.addColorStop(0, "rgba(255,255,255,0)");
  sheen.addColorStop(0.5, "rgba(255,255,255,0.12)");
  sheen.addColorStop(1, "rgba(255,255,255,0)");
  ctx.save(); ctx.beginPath(); ctx.arc(0, 0, 0.95, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = sheen; ctx.fillRect(-1, -1, 2, 2); ctx.restore();
}

// --- Compass — brass case, dial, and a needle that POINTS toward travel. The
// pointing half of the needle is the player colour. (statue + heading) ---------
function drawCompassSkin(ctx, anim, paint, heading) {
  if (typeof heading !== "number") heading = 0;
  paint = paint || "#c0392b";
  // Brass case.
  ctx.beginPath(); ctx.arc(0, 0, 0.95, 0, Math.PI * 2);
  var brass = ctx.createRadialGradient(-0.3, -0.3, 0.1, 0, 0, 1.0);
  brass.addColorStop(0, "#eccf78"); brass.addColorStop(1, "#9c7414");
  ctx.fillStyle = brass; ctx.fill();
  ctx.strokeStyle = "#6e500d"; ctx.lineWidth = 0.05; ctx.stroke();
  // Dial face.
  ctx.beginPath(); ctx.arc(0, 0, 0.78, 0, Math.PI * 2);
  ctx.fillStyle = "#f3ead2"; ctx.fill();
  // Tick marks + cardinal letters.
  ctx.fillStyle = "#3a2f1c";
  for (var t = 0; t < 16; t++) {
    var a = t * Math.PI / 8, big = (t % 4 === 0);
    ctx.save(); ctx.rotate(a);
    ctx.fillRect(0.6, -0.02, big ? 0.14 : 0.07, big ? 0.05 : 0.03);
    ctx.restore();
  }
  ctx.font = "0.18px bold sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("N", 0, -0.62); ctx.fillText("S", 0, 0.62);
  ctx.fillText("E", 0.62, 0); ctx.fillText("W", -0.62, 0);
  // Needle — points toward heading; pointing half is the player colour.
  ctx.save(); ctx.rotate(heading);
  ctx.fillStyle = cartSkinShade(paint, 0.05); ctx.strokeStyle = cartSkinShade(paint, -0.4); ctx.lineWidth = 0.015;
  ctx.beginPath(); ctx.moveTo(0.66, 0); ctx.lineTo(0, -0.1); ctx.lineTo(0, 0.1); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = "#e9e9e9";
  ctx.beginPath(); ctx.moveTo(-0.66, 0); ctx.lineTo(0, -0.1); ctx.lineTo(0, 0.1); ctx.closePath(); ctx.fill();
  ctx.restore();
  // Center pin + glass glare.
  ctx.fillStyle = "#6e500d"; ctx.beginPath(); ctx.arc(0, 0, 0.06, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.16)";
  ctx.beginPath(); ctx.ellipse(-0.28, -0.3, 0.34, 0.2, -0.6, 0, Math.PI * 2); ctx.fill();
}

// --- Wheel of Fortune — spins fast then slows and clicks to rest on a slot, then
// kicks off again. Wedges are player-colour shades. (statue + internal state) ---
var wheel = { init: false, angle: 0, vel: 0, last: 0, restUntil: 0 };
function wheelTick(anim) {
  if (!wheel.init) { wheel.init = true; wheel.last = anim; wheel.vel = 9; }
  var dt = Math.min(0.05, Math.max(0, anim - wheel.last)); wheel.last = anim;
  wheel.angle += wheel.vel * dt;
  wheel.vel *= Math.pow(0.45, dt);
  if (wheel.vel < 0.25) {
    if (wheel.restUntil === 0) wheel.restUntil = anim + 1.4;
    else if (anim > wheel.restUntil) { wheel.vel = 7 + Math.random() * 7; wheel.restUntil = 0; }
  }
}
function drawWheelSkin(ctx, anim, paint) {
  paint = paint || "#c0392b";
  wheelTick(anim);
  var segs = 10, step = (Math.PI * 2) / segs;
  ctx.save(); ctx.rotate(wheel.angle);
  for (var i = 0; i < segs; i++) {
    ctx.beginPath(); ctx.moveTo(0, 0);
    ctx.arc(0, 0, 0.92, i * step, (i + 1) * step); ctx.closePath();
    ctx.fillStyle = (i % 2) ? cartSkinShade(paint, 0.28) : cartSkinShade(paint, -0.22);
    if (i % 5 === 0) ctx.fillStyle = "#f5d142";   // a couple of "jackpot" gold slots
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.3)"; ctx.lineWidth = 0.015; ctx.stroke();
  }
  // Rim + studs.
  ctx.strokeStyle = "#e7c24a"; ctx.lineWidth = 0.06;
  ctx.beginPath(); ctx.arc(0, 0, 0.92, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = "#fff4c0";
  for (var s = 0; s < segs; s++) {
    ctx.beginPath(); ctx.arc(Math.cos(s * step) * 0.92, Math.sin(s * step) * 0.92, 0.03, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  // Fixed pointer at top, dipping into the wheel.
  ctx.fillStyle = "#d33"; ctx.strokeStyle = "#7a1c1c"; ctx.lineWidth = 0.02;
  ctx.beginPath(); ctx.moveTo(0, -0.78); ctx.lineTo(-0.1, -1.02); ctx.lineTo(0.1, -1.02); ctx.closePath();
  ctx.fill(); ctx.stroke();
  // Gold hub.
  ctx.beginPath(); ctx.arc(0, 0, 0.16, 0, Math.PI * 2);
  ctx.fillStyle = "#f5d142"; ctx.fill(); ctx.strokeStyle = "#9c7414"; ctx.lineWidth = 0.02; ctx.stroke();
}

// --- Clock — player-colour case, white face, sweeping hands. (statue) ---------
function drawClockSkin(ctx, anim, paint) {
  paint = paint || "#3f6fe0";
  ctx.beginPath(); ctx.arc(0, 0, 0.95, 0, Math.PI * 2);
  var rim = ctx.createRadialGradient(-0.2, -0.2, 0.3, 0, 0, 1.0);
  rim.addColorStop(0, cartSkinShade(paint, 0.2)); rim.addColorStop(1, cartSkinShade(paint, -0.3));
  ctx.fillStyle = rim; ctx.fill();
  ctx.beginPath(); ctx.arc(0, 0, 0.8, 0, Math.PI * 2);
  ctx.fillStyle = "#f8f6ee"; ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.4); ctx.lineWidth = 0.02; ctx.stroke();
  // Hour ticks.
  ctx.fillStyle = "#2a2a2a";
  for (var h = 0; h < 12; h++) {
    ctx.save(); ctx.rotate(h * Math.PI / 6);
    ctx.fillRect(0.64, -0.025, h % 3 === 0 ? 0.13 : 0.07, 0.05);
    ctx.restore();
  }
  // Hands (sped up for the demo).
  var sec = anim * (Math.PI * 2 / 8);
  var min = anim * (Math.PI * 2 / 48);
  var hr = anim * (Math.PI * 2 / 576);
  ctx.strokeStyle = "#1c1c1c"; ctx.lineCap = "round";
  ctx.lineWidth = 0.07; ctx.save(); ctx.rotate(hr); ctx.beginPath(); ctx.moveTo(0, 0.08); ctx.lineTo(0, -0.36); ctx.stroke(); ctx.restore();
  ctx.lineWidth = 0.05; ctx.save(); ctx.rotate(min); ctx.beginPath(); ctx.moveTo(0, 0.1); ctx.lineTo(0, -0.58); ctx.stroke(); ctx.restore();
  ctx.strokeStyle = "#d33"; ctx.lineWidth = 0.025;
  ctx.save(); ctx.rotate(sec); ctx.beginPath(); ctx.moveTo(0, 0.16); ctx.lineTo(0, -0.66); ctx.stroke(); ctx.restore();
  ctx.fillStyle = "#d33"; ctx.beginPath(); ctx.arc(0, 0, 0.05, 0, Math.PI * 2); ctx.fill();
}

// (Cartoon Bomb removed per operator — too easily confused with the in-game
//  explosive ability/hazard.)

// --- Googly Eyeball — sclera + veins, iris (player colour) and pupil that TRACK
// the travel direction. (statue + heading) ------------------------------------
function drawEyeballSkin(ctx, anim, paint, heading) {
  if (typeof heading !== "number") heading = 0;
  paint = paint || "#4a78e0";
  var lookX = Math.cos(heading), lookY = Math.sin(heading);
  // Sclera.
  ctx.beginPath(); ctx.arc(0, 0, 0.92, 0, Math.PI * 2);
  var s = ctx.createRadialGradient(-0.2, -0.2, 0.2, 0, 0, 1.0);
  s.addColorStop(0, "#ffffff"); s.addColorStop(1, "#d9def0");
  ctx.fillStyle = s; ctx.fill();
  ctx.strokeStyle = "rgba(120,130,150,0.4)"; ctx.lineWidth = 0.02; ctx.stroke();
  // Red veins.
  ctx.strokeStyle = "rgba(210,70,60,0.5)"; ctx.lineWidth = 0.018;
  for (var v = 0; v < 5; v++) {
    var va = v * 1.4;
    ctx.beginPath(); ctx.moveTo(Math.cos(va) * 0.88, Math.sin(va) * 0.88);
    ctx.quadraticCurveTo(Math.cos(va) * 0.4, Math.sin(va) * 0.4, Math.cos(va + 0.3) * 0.55, Math.sin(va + 0.3) * 0.55);
    ctx.stroke();
  }
  // Iris (player colour) tracks heading.
  var ix = lookX * 0.34, iy = lookY * 0.34;
  ctx.beginPath(); ctx.arc(ix, iy, 0.4, 0, Math.PI * 2);
  var ir = ctx.createRadialGradient(ix, iy, 0.05, ix, iy, 0.4);
  ir.addColorStop(0, cartSkinShade(paint, 0.35)); ir.addColorStop(0.7, paint); ir.addColorStop(1, cartSkinShade(paint, -0.4));
  ctx.fillStyle = ir; ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.5); ctx.lineWidth = 0.02; ctx.stroke();
  // Pupil + glint.
  ctx.fillStyle = "#101014"; ctx.beginPath(); ctx.arc(ix, iy, 0.18, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.beginPath(); ctx.arc(ix - 0.07, iy - 0.08, 0.06, 0, Math.PI * 2); ctx.fill();
}

// --- Disco Ball — a true mirror-ball: facets laid out in latitude bands (so it
// reads as a sphere, not a flat grid), each glinting on its own; some tinted to
// the player colour. Faint light beams sweep off it and a few facets twinkle
// bright white. (statue + internal spin) --------------------------------------
function drawDiscoSkin(ctx, anim, paint) {
  paint = paint || "#b06ff0";
  var R = 0.88;
  // Faint rotating light beams behind the ball (disco lights).
  ctx.save();
  ctx.rotate(anim * 0.35);
  for (var bm = 0; bm < 8; bm++) {
    var ba = bm * Math.PI / 4;
    var bf = 0.3 + 0.35 * Math.sin(anim * 2.2 + bm * 1.3);
    var beam = ctx.createLinearGradient(0, 0, Math.cos(ba) * 1.5, Math.sin(ba) * 1.5);
    beam.addColorStop(0, cartSkinShadeA(paint, 0.5, 0.0));
    beam.addColorStop(0.35, cartSkinShadeA(paint, 0.55, 0.05 + 0.06 * bf));
    beam.addColorStop(1, cartSkinShadeA(paint, 0.55, 0));
    ctx.fillStyle = beam;
    ctx.beginPath(); ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(ba - 0.09) * 1.5, Math.sin(ba - 0.09) * 1.5);
    ctx.lineTo(Math.cos(ba + 0.09) * 1.5, Math.sin(ba + 0.09) * 1.5);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();

  // Dark base sphere.
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2);
  var base = ctx.createRadialGradient(-0.28, -0.3, 0.1, 0, 0, R);
  base.addColorStop(0, "#aab3c0"); base.addColorStop(1, "#3b424d");
  ctx.fillStyle = base; ctx.fill();

  // Mirror facets in latitude bands.
  ctx.save();
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.clip();
  ctx.rotate(anim * 0.5);
  var rows = 9, bandH = (2 * R) / rows;
  for (var r = 0; r < rows; r++) {
    var fy = -R + (r + 0.5) * bandH;
    var lat = fy / R;                              // -1..1
    var halfW = Math.sqrt(Math.max(0, 1 - lat * lat)) * R;
    if (halfW < 0.05) continue;
    var cols = Math.max(1, Math.round((halfW * 2) / bandH));
    var tw = (halfW * 2) / cols;
    for (var c = 0; c < cols; c++) {
      var fx = -halfW + (c + 0.5) * tw;
      // Per-facet glint: light from upper-left + time flicker.
      var lightDot = (-fx * 0.55 - fy * 0.55) / R;
      var fl = 0.5 + 0.32 * lightDot + 0.28 * Math.sin(anim * 2.4 + r * 1.1 + c * 0.8);
      fl = fl < 0 ? 0 : (fl > 1 ? 1 : fl);
      var tint = ((r * 3 + c) % 5 === 0);
      if (tint) {
        ctx.fillStyle = cartSkinShadeA(paint, 0.05 + 0.45 * fl, 0.95);
      } else {
        var lv = (140 + 110 * fl) | 0;
        ctx.fillStyle = "rgba(" + lv + "," + ((lv + 8) | 0) + "," + ((lv + 20) | 0) + ",0.96)";
      }
      ctx.fillRect(fx - tw * 0.42, fy - bandH * 0.42, tw * 0.84, bandH * 0.84);
    }
  }
  ctx.restore();

  // Spherical shading overlay (depth) + rim.
  var sh = ctx.createRadialGradient(-0.3, -0.32, 0.2, 0, 0, R * 1.05);
  sh.addColorStop(0, "rgba(255,255,255,0.22)");
  sh.addColorStop(0.55, "rgba(0,0,0,0)");
  sh.addColorStop(1, "rgba(5,8,25,0.55)");
  ctx.fillStyle = sh; ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.3)"; ctx.lineWidth = 0.03;
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();

  // A few facets twinkle bright white (star glints), clipped to the ball.
  ctx.save();
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.clip();
  for (var sp = 0; sp < 4; sp++) {
    var pa = anim * 1.1 + sp * 1.9;
    var px = Math.cos(pa) * 0.55, py = Math.sin(pa * 0.7 + sp) * 0.5;
    var twk = Math.max(0, Math.sin(anim * 5 + sp * 2));
    if (twk < 0.2) continue;
    ctx.fillStyle = "rgba(255,255,255," + twk + ")";
    ctx.save(); ctx.translate(px, py);
    var r1 = 0.05 + 0.07 * twk;
    ctx.beginPath();
    for (var q = 0; q < 8; q++) {
      var rr = (q % 2 ? 0.018 : r1), aa = q * Math.PI / 4;
      var X = Math.cos(aa) * rr, Y = Math.sin(aa) * rr;
      if (q === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
    }
    ctx.closePath(); ctx.fill(); ctx.restore();
  }
  ctx.restore();
}

// --- Hypno-Spiral — a dizzying two-tone swirl that always spins. (statue + spin) -
function drawHypnoSkin(ctx, anim, paint) {
  paint = paint || "#d0342c";
  ctx.save();
  ctx.beginPath(); ctx.arc(0, 0, 0.92, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = cartSkinShade(paint, -0.35); ctx.fillRect(-1, -1, 2, 2);
  ctx.rotate(anim * 1.1);
  function arm(phase, color) {
    ctx.strokeStyle = color; ctx.lineWidth = 0.16; ctx.lineCap = "round";
    ctx.beginPath();
    for (var th = 0; th < Math.PI * 6; th += 0.18) {
      var r = 0.03 + (th / (Math.PI * 6)) * 0.95;
      var x = Math.cos(th + phase) * r, y = Math.sin(th + phase) * r;
      if (th === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  arm(0, cartSkinShade(paint, 0.45));
  arm(Math.PI, cartSkinShade(paint, 0.05));
  ctx.restore();
  ctx.strokeStyle = cartSkinShade(paint, -0.5); ctx.lineWidth = 0.04;
  ctx.beginPath(); ctx.arc(0, 0, 0.92, 0, Math.PI * 2); ctx.stroke();
}

// --- Cookie — golden choc-chip cookie with a bite taken out; the plate behind it
// is the player-colour accent. (rolls like a normal cart) ----------------------
function drawCookieSkin(ctx, anim, paint) {
  paint = paint || "#e8a13c";
  // Player-colour plate.
  ctx.beginPath(); ctx.arc(0, 0, 0.98, 0, Math.PI * 2);
  ctx.fillStyle = cartSkinShade(paint, -0.05); ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.4); ctx.lineWidth = 0.03; ctx.stroke();
  // Cookie dough with a bite (a circular notch cut on the +X edge).
  ctx.save();
  ctx.beginPath(); ctx.arc(0, 0, 0.82, 0, Math.PI * 2);
  ctx.arc(0.86, 0, 0.34, 0, Math.PI * 2, true);     // subtract a bite
  ctx.clip();
  var dough = ctx.createRadialGradient(-0.2, -0.2, 0.2, 0, 0, 0.9);
  dough.addColorStop(0, "#e3ad5e"); dough.addColorStop(1, "#bd7f37");
  ctx.fillStyle = dough; ctx.fillRect(-1, -1, 2, 2);
  // Chocolate chips.
  ctx.fillStyle = "#46271a";
  var chips = [[-0.3, -0.2], [0.1, 0.28], [-0.1, -0.4], [0.32, -0.1], [-0.42, 0.22], [0.08, -0.08], [-0.05, 0.5], [0.4, 0.34]];
  for (var c = 0; c < chips.length; c++) {
    ctx.beginPath(); ctx.arc(chips[c][0], chips[c][1], 0.085, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.fillStyle = "#2c1810";
    ctx.beginPath(); ctx.arc(chips[c][0] + 0.02, chips[c][1] + 0.02, 0.04, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  ctx.restore();
  // Bite-edge crumbs.
  ctx.fillStyle = "#cf9445";
  for (var b = 0; b < 5; b++) {
    var ba = -0.6 + b * 0.3;
    ctx.beginPath(); ctx.arc(0.56 + Math.cos(ba) * 0.06, Math.sin(ba) * 0.34, 0.03, 0, Math.PI * 2); ctx.fill();
  }
}

// --- Beach Ball — glossy ball with alternating player-colour and white panels.
// (rolls like a normal cart) ---------------------------------------------------
function drawBeachballSkin(ctx, anim, paint) {
  paint = paint || "#e8453c";
  ctx.beginPath(); ctx.arc(0, 0, 0.92, 0, Math.PI * 2);
  ctx.fillStyle = "#fafafa"; ctx.fill();
  var panels = 6, step = (Math.PI * 2) / panels;
  for (var i = 0; i < panels; i += 2) {
    ctx.beginPath(); ctx.moveTo(0, 0);
    ctx.arc(0, 0, 0.92, i * step, (i + 1) * step); ctx.closePath();
    ctx.fillStyle = (i % 4 === 0) ? paint : cartSkinShade(paint, 0.35);
    ctx.fill();
  }
  // White cap hub.
  ctx.beginPath(); ctx.arc(0, 0, 0.18, 0, Math.PI * 2); ctx.fillStyle = "#fafafa"; ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.15)"; ctx.lineWidth = 0.015; ctx.stroke();
  // Outline + gloss.
  ctx.strokeStyle = "rgba(0,0,0,0.2)"; ctx.lineWidth = 0.03;
  ctx.beginPath(); ctx.arc(0, 0, 0.92, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.beginPath(); ctx.ellipse(-0.32, -0.34, 0.22, 0.12, -0.6, 0, Math.PI * 2); ctx.fill();
}

// --- Sun — player-colour body with rotating rays and a cheery face. (statue) ---
function drawSunSkin(ctx, anim, paint) {
  paint = paint || "#f5b50a";
  ctx.save();
  ctx.rotate(anim * 0.5);
  ctx.fillStyle = cartSkinShade(paint, 0.05);
  for (var r = 0; r < 12; r++) {
    ctx.save(); ctx.rotate(r * Math.PI / 6);
    var wob = 0.05 * Math.sin(anim * 3 + r);
    ctx.beginPath();
    ctx.moveTo(0.66, -0.1); ctx.lineTo(1.0 + wob, 0); ctx.lineTo(0.66, 0.1); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  ctx.restore();
  // Core.
  ctx.beginPath(); ctx.arc(0, 0, 0.7, 0, Math.PI * 2);
  var core = ctx.createRadialGradient(-0.2, -0.2, 0.1, 0, 0, 0.7);
  core.addColorStop(0, cartSkinShade(paint, 0.4)); core.addColorStop(1, paint);
  ctx.fillStyle = core; ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.35); ctx.lineWidth = 0.03; ctx.stroke();
  // Face (upright).
  ctx.fillStyle = cartSkinShade(paint, -0.6);
  ctx.beginPath(); ctx.arc(-0.24, -0.12, 0.08, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(0.24, -0.12, 0.08, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.6); ctx.lineWidth = 0.06; ctx.lineCap = "round";
  ctx.beginPath(); ctx.arc(0, 0.04, 0.32, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
  ctx.fillStyle = cartSkinShadeA(paint, -0.2, 0.4);
  ctx.beginPath(); ctx.arc(-0.4, 0.12, 0.08, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(0.4, 0.12, 0.08, 0, Math.PI * 2); ctx.fill();
}

// --- Shuriken — steel ninja star that spins fast; player-colour centre hub.
// (spins like a normal cart, plus its own fast spin) ---------------------------
function drawShurikenSkin(ctx, anim, paint) {
  paint = paint || "#9aa3ad";
  ctx.save();
  ctx.rotate(anim * 5);
  var steel = ctx.createRadialGradient(-0.2, -0.2, 0.1, 0, 0, 1.0);
  steel.addColorStop(0, "#eef2f6"); steel.addColorStop(1, "#8b939d");
  ctx.fillStyle = steel; ctx.strokeStyle = "#5b636d"; ctx.lineWidth = 0.025;
  for (var p = 0; p < 4; p++) {
    ctx.save(); ctx.rotate(p * Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(0, -0.18);
    ctx.quadraticCurveTo(0.5, -0.28, 0.98, 0);
    ctx.quadraticCurveTo(0.5, 0.28, 0, 0.18);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  // Center hub (player colour) + hole.
  ctx.beginPath(); ctx.arc(0, 0, 0.26, 0, Math.PI * 2);
  ctx.fillStyle = cartSkinShade(paint, 0.1); ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.45); ctx.lineWidth = 0.025; ctx.stroke();
  ctx.fillStyle = "#2b3038"; ctx.beginPath(); ctx.arc(0, 0, 0.08, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// --- Dartboard — alternating wedges with player-colour scoring rings + bullseye,
// and a dart stuck near the centre. (statue) -----------------------------------
function drawDartboardSkin(ctx, anim, paint) {
  paint = paint || "#3fb6c8";
  var segs = 20, step = (Math.PI * 2) / segs;
  for (var i = 0; i < segs; i++) {
    ctx.beginPath(); ctx.moveTo(0, 0);
    ctx.arc(0, 0, 0.92, i * step, (i + 1) * step); ctx.closePath();
    ctx.fillStyle = (i % 2) ? "#f2e6c8" : "#1c1c1c"; ctx.fill();
  }
  // Scoring rings (player colour) — double ring + triple ring.
  function ring(rOuter, rInner, col) {
    ctx.beginPath(); ctx.arc(0, 0, rOuter, 0, Math.PI * 2); ctx.arc(0, 0, rInner, 0, Math.PI * 2, true);
    ctx.fillStyle = col; ctx.fill("evenodd");
  }
  ring(0.92, 0.82, cartSkinShade(paint, -0.1));
  ring(0.6, 0.5, cartSkinShade(paint, 0.1));
  // Spokes.
  ctx.strokeStyle = "rgba(120,120,120,0.5)"; ctx.lineWidth = 0.012;
  for (var w = 0; w < segs; w++) {
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(w * step) * 0.92, Math.sin(w * step) * 0.92); ctx.stroke();
  }
  // Bullseye.
  ctx.beginPath(); ctx.arc(0, 0, 0.18, 0, Math.PI * 2); ctx.fillStyle = cartSkinShade(paint, -0.15); ctx.fill();
  ctx.beginPath(); ctx.arc(0, 0, 0.08, 0, Math.PI * 2); ctx.fillStyle = "#d33"; ctx.fill();
  // A dart stuck just off-centre.
  var dx = 0.16, dy = -0.12;
  ctx.strokeStyle = "#c9ced4"; ctx.lineWidth = 0.04; ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(dx, dy); ctx.lineTo(dx + 0.34, dy - 0.26); ctx.stroke();
  ctx.fillStyle = "#d33";
  ctx.beginPath(); ctx.moveTo(dx + 0.3, dy - 0.18); ctx.lineTo(dx + 0.46, dy - 0.34); ctx.lineTo(dx + 0.38, dy - 0.14); ctx.closePath(); ctx.fill();
}

// ============================================================================
// BATCH 2 of fun carts (20 more). Shared polygon helper:
// ============================================================================
function cartPolyPath(ctx, cx, cy, r, sides, rot) {
  ctx.beginPath();
  for (var k = 0; k < sides; k++) {
    var a = rot + k * Math.PI * 2 / sides;
    var x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

// 1. Soccer Ball — white ball with player-colour panels. (rolls)
function drawSoccerSkin(ctx, anim, paint) {
  paint = paint || "#222";
  ctx.beginPath(); ctx.arc(0, 0, 0.9, 0, Math.PI * 2);
  var w = ctx.createRadialGradient(-0.25, -0.25, 0.1, 0, 0, 0.95);
  w.addColorStop(0, "#ffffff"); w.addColorStop(1, "#d7dce4"); ctx.fillStyle = w; ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.25)"; ctx.lineWidth = 0.03; ctx.stroke();
  var pan = cartSkinShade(paint, -0.12);
  ctx.fillStyle = pan;
  cartPolyPath(ctx, 0, 0, 0.3, 5, -Math.PI / 2); ctx.fill();          // centre pentagon
  for (var i = 0; i < 5; i++) {                                       // outer pentagons
    var a = -Math.PI / 2 + i * Math.PI * 2 / 5;
    cartPolyPath(ctx, Math.cos(a) * 0.66, Math.sin(a) * 0.66, 0.2, 5, a + Math.PI / 5);
    ctx.fill();
  }
  ctx.strokeStyle = "rgba(0,0,0,0.35)"; ctx.lineWidth = 0.025;
  for (var s = 0; s < 5; s++) {
    var aa = -Math.PI / 2 + s * Math.PI * 2 / 5;
    ctx.beginPath(); ctx.moveTo(Math.cos(aa) * 0.3, Math.sin(aa) * 0.3);
    ctx.lineTo(Math.cos(aa) * 0.66, Math.sin(aa) * 0.66); ctx.stroke();
  }
}

// 2. Basketball — the ball tints to the player colour; black seams. (rolls)
function drawBasketballSkin(ctx, anim, paint) {
  paint = paint || "#e2802b";
  ctx.beginPath(); ctx.arc(0, 0, 0.9, 0, Math.PI * 2);
  var g = ctx.createRadialGradient(-0.25, -0.25, 0.1, 0, 0, 0.95);
  g.addColorStop(0, cartSkinShade(paint, 0.28)); g.addColorStop(1, cartSkinShade(paint, -0.22));
  ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = "#15100a"; ctx.lineWidth = 0.04; ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(0, -0.9); ctx.lineTo(0, 0.9); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-0.9, 0); ctx.lineTo(0.9, 0); ctx.stroke();
  ctx.beginPath(); ctx.arc(-1.25, 0, 0.95, -0.7, 0.7); ctx.stroke();
  ctx.beginPath(); ctx.arc(1.25, 0, 0.95, Math.PI - 0.7, Math.PI + 0.7); ctx.stroke();
}

// 3. Yin-Yang — player colour vs. its light tint, slowly turning. (statue+spin)
function drawYinYangSkin(ctx, anim, paint) {
  paint = paint || "#222";
  var dark = cartSkinShade(paint, -0.15), light = cartSkinShade(paint, 0.6);
  ctx.save(); ctx.rotate(anim * 0.8);
  var R = 0.9;
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fillStyle = dark; ctx.fill();
  ctx.fillStyle = light;
  ctx.beginPath(); ctx.arc(0, 0, R, -Math.PI / 2, Math.PI / 2); ctx.fill();      // right half light
  ctx.beginPath(); ctx.arc(0, -R / 2, R / 2, 0, Math.PI * 2); ctx.fill();        // top lobe light
  ctx.fillStyle = dark;
  ctx.beginPath(); ctx.arc(0, R / 2, R / 2, 0, Math.PI * 2); ctx.fill();         // bottom lobe dark
  ctx.fillStyle = dark; ctx.beginPath(); ctx.arc(0, -R / 2, 0.12, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = light; ctx.beginPath(); ctx.arc(0, R / 2, 0.12, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  ctx.strokeStyle = cartSkinShade(paint, -0.4); ctx.lineWidth = 0.03;
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();
}

// 4. Ferris Wheel — turning wheel with player-colour gondolas. (statue+spin)
function drawFerrisSkin(ctx, anim, paint) {
  paint = paint || "#d33";
  ctx.save(); ctx.rotate(anim * 0.5);
  var spokes = 8, R = 0.86;
  ctx.strokeStyle = "#dfe5ee"; ctx.lineWidth = 0.045;
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, R - 0.08, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 0.022; ctx.strokeStyle = "#b9c2cf";
  for (var i = 0; i < spokes; i++) {
    var a = i * Math.PI * 2 / spokes;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * R, Math.sin(a) * R); ctx.stroke();
  }
  for (var c = 0; c < spokes; c++) {
    var ca = c * Math.PI * 2 / spokes;
    var gx = Math.cos(ca) * R, gy = Math.sin(ca) * R;
    ctx.fillStyle = (c % 2) ? paint : cartSkinShade(paint, 0.35);
    cartRoundRectPath(ctx, gx - 0.1, gy - 0.05, 0.2, 0.16, 0.04); ctx.fill();
    ctx.strokeStyle = cartSkinShade(paint, -0.4); ctx.lineWidth = 0.015; ctx.stroke();
  }
  ctx.restore();
  ctx.fillStyle = "#9aa3ad"; ctx.beginPath(); ctx.arc(0, 0, 0.1, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#5b636d"; ctx.beginPath(); ctx.arc(0, 0, 0.05, 0, Math.PI * 2); ctx.fill();
}

// 5. Pinwheel — player-colour curved blades spinning. (rolls + fast spin)
function drawPinwheelSkin(ctx, anim, paint) {
  paint = paint || "#3fb6c8";
  ctx.save(); ctx.rotate(anim * 2.2);
  var blades = 6;
  for (var i = 0; i < blades; i++) {
    ctx.save(); ctx.rotate(i * Math.PI * 2 / blades);
    ctx.fillStyle = (i % 2) ? cartSkinShade(paint, 0.3) : cartSkinShade(paint, -0.05);
    ctx.beginPath(); ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(0.5, -0.18, 0.95, 0.04);
    ctx.lineTo(0.18, 0.12); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = cartSkinShade(paint, -0.4); ctx.lineWidth = 0.012; ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
  ctx.fillStyle = "#fff4c0"; ctx.beginPath(); ctx.arc(0, 0, 0.1, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "#9c7414"; ctx.lineWidth = 0.02; ctx.stroke();
}

// 6. Watermelon — green rind, player-colour flesh, seeds. (rolls)
function drawWatermelonSkin(ctx, anim, paint) {
  paint = paint || "#e8453c";
  ctx.beginPath(); ctx.arc(0, 0, 0.92, 0, Math.PI * 2); ctx.fillStyle = "#2f7d32"; ctx.fill();
  ctx.beginPath(); ctx.arc(0, 0, 0.86, 0, Math.PI * 2); ctx.fillStyle = "#54a957"; ctx.fill();
  ctx.beginPath(); ctx.arc(0, 0, 0.8, 0, Math.PI * 2); ctx.fillStyle = "#eaf7e0"; ctx.fill();
  ctx.beginPath(); ctx.arc(0, 0, 0.72, 0, Math.PI * 2);
  var f = ctx.createRadialGradient(-0.15, -0.15, 0.1, 0, 0, 0.72);
  f.addColorStop(0, cartSkinShade(paint, 0.2)); f.addColorStop(1, paint);
  ctx.fillStyle = f; ctx.fill();
  ctx.fillStyle = "#241a12";
  for (var i = 0; i < 10; i++) {
    var a = i * 2.39963, r = 0.28 + (i % 3) * 0.16;
    ctx.save(); ctx.translate(Math.cos(a) * r, Math.sin(a) * r); ctx.rotate(a);
    ctx.beginPath(); ctx.ellipse(0, 0, 0.04, 0.025, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
}

// (Capsule Ball removed per operator — too close to the trademarked Poké Ball.)

// 8. Tire — rubber tire with a player-colour hubcap. (rolls + spin)
function drawTireSkin(ctx, anim, paint) {
  paint = paint || "#c0392b";
  ctx.save(); ctx.rotate(anim * 3);
  ctx.beginPath(); ctx.arc(0, 0, 0.95, 0, Math.PI * 2); ctx.fillStyle = "#1a1a1a"; ctx.fill();
  ctx.fillStyle = "#2c2c2c";
  for (var t = 0; t < 18; t++) {
    var a = t * Math.PI * 2 / 18;
    ctx.save(); ctx.rotate(a); ctx.fillRect(0.78, -0.05, 0.16, 0.1); ctx.restore();
  }
  ctx.beginPath(); ctx.arc(0, 0, 0.66, 0, Math.PI * 2); ctx.fillStyle = "#242424"; ctx.fill();
  ctx.beginPath(); ctx.arc(0, 0, 0.48, 0, Math.PI * 2);
  var hub = ctx.createRadialGradient(-0.1, -0.1, 0.05, 0, 0, 0.48);
  hub.addColorStop(0, cartSkinShade(paint, 0.35)); hub.addColorStop(1, cartSkinShade(paint, -0.2));
  ctx.fillStyle = hub; ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.45); ctx.lineWidth = 0.02; ctx.stroke();
  ctx.fillStyle = "#3a3a3a";
  for (var l = 0; l < 5; l++) {
    var la = l * Math.PI * 2 / 5 - Math.PI / 2;
    ctx.beginPath(); ctx.arc(Math.cos(la) * 0.28, Math.sin(la) * 0.28, 0.05, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = cartSkinShade(paint, 0.1); ctx.beginPath(); ctx.arc(0, 0, 0.1, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// 9. Gear — a player-colour cog with trapezoid teeth. (rolls + spin)
function drawGearSkin(ctx, anim, paint) {
  paint = paint || "#9aa3ad";
  ctx.save(); ctx.rotate(anim * 1.4);
  var teeth = 10, rO = 0.96, rI = 0.78, step = Math.PI * 2 / teeth;
  ctx.beginPath();
  for (var t = 0; t < teeth; t++) {
    var a = t * step;
    ctx.lineTo(Math.cos(a) * rI, Math.sin(a) * rI);
    ctx.lineTo(Math.cos(a + step * 0.16) * rO, Math.sin(a + step * 0.16) * rO);
    ctx.lineTo(Math.cos(a + step * 0.34) * rO, Math.sin(a + step * 0.34) * rO);
    ctx.lineTo(Math.cos(a + step * 0.5) * rI, Math.sin(a + step * 0.5) * rI);
  }
  ctx.closePath();
  var g = ctx.createRadialGradient(-0.2, -0.2, 0.1, 0, 0, 1.0);
  g.addColorStop(0, cartSkinShade(paint, 0.3)); g.addColorStop(1, cartSkinShade(paint, -0.25));
  ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.5); ctx.lineWidth = 0.025; ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, 0.5, 0, Math.PI * 2); ctx.strokeStyle = cartSkinShade(paint, -0.4); ctx.lineWidth = 0.03; ctx.stroke();
  ctx.fillStyle = "#2b3038"; ctx.beginPath(); ctx.arc(0, 0, 0.22, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = cartSkinShade(paint, -0.1); ctx.beginPath(); ctx.arc(0, 0, 0.14, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// ============================================================================
// COSMETIC RENDER CACHES (perf) — see docs/spikes/skin-render-perf.md
// ----------------------------------------------------------------------------
// Several equipped cosmetics re-ran expensive procedural drawing (hundreds of
// per-frame gradients, repeated trig, many small paths) EVERY frame, scaling
// linearly with how many karts wear them. The fix mirrors getPlayerSprite's
// offscreen-canvas caching: render the STATIC layer of a skin once per
// (id, colour) and blit it, leaving only the genuinely-animated bits to draw
// live on top.
//
// getCachedSkinLayer(key, build): renders build(c2d) once into a fixed-size
// offscreen canvas whose context is set up in the SAME normalized [-1,1] space
// the painters use. Callers blit it with `ctx.drawImage(cv, -1, -1, 2, 2)` into
// the already-translated+scaled kart ctx, so heading rotation, the punch-pop
// scale, and any per-frame rotation/sheen still compose on top for free. The
// cache key is (id|colour) only — never the live transform — so punch/zoom/DPR
// never thrash it. 256px comfortably exceeds a kart's on-screen device size at
// any zoom/DPR, so the blit only ever downscales (stays crisp).
var SKIN_LAYER_CACHE_PX = 256;
var _skinLayerCache = {};
function getCachedSkinLayer(key, build) {
  var cv = _skinLayerCache[key];
  if (cv != null) return cv;
  var px = SKIN_LAYER_CACHE_PX;
  cv = document.createElement("canvas");
  cv.width = px; cv.height = px;
  var c = cv.getContext("2d");
  c.translate(px / 2, px / 2);
  c.scale(px / 2, px / 2);          // normalized [-1,1] fills the canvas
  build(c);
  _skinLayerCache[key] = cv;
  return cv;
}

// getCachedGlyphSprite(key, span, build): like the above but for a SMALL repeated
// glyph (e.g. a polka dot) drawn once in a normalized [-span,span] box and blitted
// many times per frame. `cv._span` records the box so callers can size the blit.
var _glyphSpriteCache = {};
function getCachedGlyphSprite(key, span, build) {
  var cv = _glyphSpriteCache[key];
  if (cv != null) return cv;
  var px = 64;
  cv = document.createElement("canvas");
  cv.width = px; cv.height = px;
  var c = cv.getContext("2d");
  c.translate(px / 2, px / 2);
  c.scale(px / (2 * span), px / (2 * span));   // normalized [-span,span] fills the canvas
  build(c);
  cv._span = span;
  _glyphSpriteCache[key] = cv;
  return cv;
}

// 10. Spiral Galaxy — glowing arms in the player-colour hue, slowly rotating. (statue+spin)
function drawGalaxySkin(ctx, anim, paint) {
  paint = paint || "#7a4fff";
  // The space-disc and core are radially symmetric and the spiral arms only ROTATE,
  // so the whole galaxy is a static sprite that we rotate-blit — instead of stamping
  // ~100 arm dots + 3 radial gradients every frame. (Rotating the symmetric disc/core
  // with the blit is visually identical.)
  var cv = getCachedSkinLayer("galaxy|" + paint, function (c) {
    c.beginPath(); c.arc(0, 0, 0.95, 0, Math.PI * 2);
    var space = c.createRadialGradient(0, 0, 0.1, 0, 0, 0.95);
    space.addColorStop(0, cartSkinShade(paint, -0.55)); space.addColorStop(1, "#06060f");
    c.fillStyle = space; c.fill();
    c.save();
    c.beginPath(); c.arc(0, 0, 0.93, 0, Math.PI * 2); c.clip();
    for (var arm = 0; arm < 2; arm++) {
      for (var s = 0; s < 26; s++) {
        var th = s * 0.34 + arm * Math.PI;
        var r = 0.08 + s * 0.034;
        var x = Math.cos(th) * r, y = Math.sin(th) * r;
        var br = 1 - r;
        c.fillStyle = cartSkinShadeA(paint, 0.2 + 0.4 * br, 0.85);
        c.beginPath(); c.arc(x, y, 0.09 * br + 0.02, 0, Math.PI * 2); c.fill();
        c.fillStyle = "rgba(255,255,255," + (0.5 * br) + ")";
        c.beginPath(); c.arc(x, y, 0.03 * br + 0.008, 0, Math.PI * 2); c.fill();
      }
    }
    c.restore();
    var core = c.createRadialGradient(0, 0, 0.02, 0, 0, 0.28);
    core.addColorStop(0, "#fffaf0"); core.addColorStop(0.5, cartSkinShade(paint, 0.4)); core.addColorStop(1, cartSkinShadeA(paint, 0.2, 0));
    c.fillStyle = core; c.beginPath(); c.arc(0, 0, 0.28, 0, Math.PI * 2); c.fill();
  });
  ctx.save();
  ctx.rotate(anim * 0.45);
  ctx.drawImage(cv, -1, -1, 2, 2);
  ctx.restore();
}

// 11. Snowflake — an icy player-colour crystal, slowly turning. (statue+spin)
function drawSnowflakeSkin(ctx, anim, paint) {
  paint = paint || "#5ad0ff";
  var ice = cartSkinShade(paint, 0.45), ice2 = cartSkinShade(paint, 0.1);
  ctx.beginPath(); ctx.arc(0, 0, 0.95, 0, Math.PI * 2); ctx.fillStyle = cartSkinShadeA(paint, -0.3, 0.25); ctx.fill();
  ctx.save(); ctx.rotate(anim * 0.3);
  ctx.strokeStyle = ice; ctx.lineWidth = 0.07; ctx.lineCap = "round";
  for (var i = 0; i < 6; i++) {
    ctx.save(); ctx.rotate(i * Math.PI / 3);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -0.88); ctx.stroke();
    for (var b = 1; b <= 2; b++) {
      var by = -0.3 - b * 0.24;
      ctx.beginPath(); ctx.moveTo(0, by); ctx.lineTo(0.18, by - 0.18); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, by); ctx.lineTo(-0.18, by - 0.18); ctx.stroke();
    }
    ctx.restore();
  }
  ctx.fillStyle = ice2; cartPolyPath(ctx, 0, 0, 0.14, 6, 0); ctx.fill();
  ctx.restore();
}

// 12. Flower — player-colour petals around a golden centre, gently breathing. (statue)
function drawFlowerSkin(ctx, anim, paint) {
  paint = paint || "#ef6fb0";
  var breathe = 1 + Math.sin(anim * 1.6) * 0.04;
  var petals = 8;
  ctx.save(); ctx.scale(breathe, breathe);
  for (var i = 0; i < petals; i++) {
    ctx.save(); ctx.rotate(i * Math.PI * 2 / petals);
    var pg = ctx.createLinearGradient(0, -0.3, 0, -0.92);
    pg.addColorStop(0, cartSkinShade(paint, 0.35)); pg.addColorStop(1, paint);
    ctx.fillStyle = pg;
    ctx.beginPath(); ctx.ellipse(0, -0.6, 0.2, 0.34, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = cartSkinShade(paint, -0.3); ctx.lineWidth = 0.012; ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
  var c = ctx.createRadialGradient(-0.06, -0.06, 0.03, 0, 0, 0.32);
  c.addColorStop(0, "#ffe27a"); c.addColorStop(1, "#e0a21a");
  ctx.fillStyle = c; ctx.beginPath(); ctx.arc(0, 0, 0.3, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#b9831a";
  for (var d = 0; d < 12; d++) {
    var a = d * 2.39963, r = (d % 3) * 0.07;
    ctx.beginPath(); ctx.arc(Math.cos(a) * r, Math.sin(a) * r, 0.03, 0, Math.PI * 2); ctx.fill();
  }
}

// 13. Gold Coin — a steady minted coin: reeded edge, star emblem, player-colour
// gem, and a slow sheen sweep. (statue, no flip)
function drawCoinSkin(ctx, anim, paint) {
  paint = paint || "#3fb6c8";
  // Reeded (ridged) edge.
  ctx.fillStyle = "#b3860f";
  for (var e = 0; e < 48; e++) {
    var ea = e * Math.PI * 2 / 48;
    ctx.save(); ctx.rotate(ea); ctx.fillRect(0.82, -0.035, 0.1, 0.07); ctx.restore();
  }
  // Coin face.
  ctx.beginPath(); ctx.arc(0, 0, 0.86, 0, Math.PI * 2);
  var g = ctx.createRadialGradient(-0.25, -0.25, 0.1, 0, 0, 0.92);
  g.addColorStop(0, "#fff3b0"); g.addColorStop(0.7, "#ffd84d"); g.addColorStop(1, "#c4960f");
  ctx.fillStyle = g; ctx.fill();
  // Inner rim ring.
  ctx.strokeStyle = "#9c7414"; ctx.lineWidth = 0.05;
  ctx.beginPath(); ctx.arc(0, 0, 0.74, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = "#fff3b0"; ctx.lineWidth = 0.015;
  ctx.beginPath(); ctx.arc(0, 0, 0.7, 0, Math.PI * 2); ctx.stroke();
  // Star emblem with a player-colour gem.
  ctx.fillStyle = "#caa11a";
  ctx.beginPath();
  for (var p = 0; p < 10; p++) {
    var rr = (p % 2 ? 0.22 : 0.5), aa = -Math.PI / 2 + p * Math.PI / 5;
    var X = Math.cos(aa) * rr, Y = Math.sin(aa) * rr;
    if (p === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
  }
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = "#9c7414"; ctx.lineWidth = 0.015; ctx.stroke();
  var gem = ctx.createRadialGradient(-0.04, -0.04, 0.02, 0, 0, 0.18);
  gem.addColorStop(0, cartSkinShade(paint, 0.4)); gem.addColorStop(1, cartSkinShade(paint, -0.15));
  ctx.fillStyle = gem; ctx.beginPath(); ctx.arc(0, 0, 0.17, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.7)"; ctx.beginPath(); ctx.arc(-0.05, -0.06, 0.04, 0, Math.PI * 2); ctx.fill();
  // Slow sheen sweep across the face.
  ctx.save();
  ctx.beginPath(); ctx.arc(0, 0, 0.86, 0, Math.PI * 2); ctx.clip();
  var sx = ((anim * 0.4) % 2.4) - 1.2;
  var sg = ctx.createLinearGradient(sx - 0.3, -0.6, sx + 0.3, 0.6);
  sg.addColorStop(0, "rgba(255,255,255,0)");
  sg.addColorStop(0.5, "rgba(255,255,255,0.3)");
  sg.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = sg; ctx.fillRect(-1, -1, 2, 2);
  ctx.restore();
}

// (Radar removed per operator.)

// 15. Ship's Helm — wooden wheel with handles + player-colour hub. (rolls + spin)
function drawHelmSkin(ctx, anim, paint) {
  paint = paint || "#caa11a";
  ctx.save(); ctx.rotate(anim * 0.9);
  var spokes = 6;
  // Handles (knobs) beyond the rim.
  ctx.fillStyle = "#7a4a1e"; ctx.strokeStyle = "#4e2f12"; ctx.lineWidth = 0.02;
  for (var i = 0; i < spokes; i++) {
    var a = i * Math.PI * 2 / spokes;
    ctx.save(); ctx.rotate(a);
    cartRoundRectPath(ctx, 0.86, -0.05, 0.12, 0.1, 0.03); ctx.fill();
    ctx.beginPath(); ctx.arc(0.98, 0, 0.06, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  // Wood ring.
  ctx.strokeStyle = "#8a5a26"; ctx.lineWidth = 0.16;
  ctx.beginPath(); ctx.arc(0, 0, 0.74, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = "#6b421b"; ctx.lineWidth = 0.04;
  ctx.beginPath(); ctx.arc(0, 0, 0.74, 0, Math.PI * 2); ctx.stroke();
  // Spokes.
  ctx.strokeStyle = "#8a5a26"; ctx.lineWidth = 0.07;
  for (var s = 0; s < spokes; s++) {
    var sa = s * Math.PI * 2 / spokes;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(sa) * 0.82, Math.sin(sa) * 0.82); ctx.stroke();
  }
  ctx.restore();
  // Hub (player colour).
  ctx.beginPath(); ctx.arc(0, 0, 0.22, 0, Math.PI * 2);
  var hub = ctx.createRadialGradient(-0.06, -0.06, 0.02, 0, 0, 0.22);
  hub.addColorStop(0, cartSkinShade(paint, 0.3)); hub.addColorStop(1, cartSkinShade(paint, -0.2));
  ctx.fillStyle = hub; ctx.fill();
  ctx.strokeStyle = cartSkinShade(paint, -0.45); ctx.lineWidth = 0.02; ctx.stroke();
}

// 16. Camera Aperture — player-colour iris blades opening + closing. (statue)
function drawApertureSkin(ctx, anim, paint) {
  paint = paint || "#3f6fe0";
  var open = 0.26 + 0.22 * (0.5 + 0.5 * Math.sin(anim * 1.4));
  ctx.beginPath(); ctx.arc(0, 0, 0.95, 0, Math.PI * 2);
  ctx.fillStyle = cartSkinShade(paint, -0.45); ctx.fill();
  ctx.beginPath(); ctx.arc(0, 0, 0.86, 0, Math.PI * 2); ctx.fillStyle = "#0a0a0c"; ctx.fill();
  var blades = 7;
  for (var i = 0; i < blades; i++) {
    var a = i * Math.PI * 2 / blades;
    var a2 = (i + 1) * Math.PI * 2 / blades;
    var ix = Math.cos(a) * open, iy = Math.sin(a) * open;
    var i2x = Math.cos(a2) * open, i2y = Math.sin(a2) * open;
    ctx.beginPath();
    ctx.moveTo(ix, iy);
    ctx.lineTo(Math.cos(a) * 0.86, Math.sin(a) * 0.86);
    ctx.lineTo(Math.cos(a2) * 0.86, Math.sin(a2) * 0.86);
    ctx.lineTo(i2x, i2y);
    ctx.closePath();
    ctx.fillStyle = (i % 2) ? cartSkinShade(paint, 0.1) : cartSkinShade(paint, -0.12);
    ctx.fill();
    ctx.strokeStyle = cartSkinShade(paint, -0.45); ctx.lineWidth = 0.012; ctx.stroke();
  }
  // Lens glint in the hole.
  ctx.fillStyle = "rgba(140,180,255,0.25)";
  ctx.beginPath(); ctx.arc(0, 0, open * 0.9, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.4)";
  ctx.beginPath(); ctx.arc(-open * 0.3, -open * 0.3, open * 0.25, 0, Math.PI * 2); ctx.fill();
}

// 17. Cheese Wheel — holey cheese with a player-colour wax rind + cut wedge. (rolls)
function drawCheeseSkin(ctx, anim, paint) {
  paint = paint || "#e8a13c";
  ctx.beginPath(); ctx.arc(0, 0, 0.95, 0, Math.PI * 2);
  ctx.fillStyle = cartSkinShade(paint, -0.1); ctx.fill();      // wax rind (player colour)
  ctx.beginPath(); ctx.arc(0, 0, 0.84, 0, Math.PI * 2);
  var ch = ctx.createRadialGradient(-0.2, -0.2, 0.2, 0, 0, 0.9);
  ch.addColorStop(0, "#ffe08a"); ch.addColorStop(1, "#f0c14e");
  ctx.fillStyle = ch; ctx.fill();
  // Cut wedge.
  var cutA = 0.5, cutW = 0.6;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 0.86, cutA, cutA + cutW); ctx.closePath();
  ctx.fillStyle = cartSkinShade(paint, 0.1); ctx.fill();
  ctx.strokeStyle = "#d9a93c"; ctx.lineWidth = 0.02; ctx.stroke();
  // Holes.
  ctx.fillStyle = "#e0a838";
  var holes = [[0.2, -0.1], [-0.3, 0.2], [-0.1, -0.4], [0.35, 0.28], [-0.42, -0.18], [0.05, 0.15]];
  for (var i = 0; i < holes.length; i++) {
    var hx = holes[i][0], hy = holes[i][1];
    var ha = Math.atan2(hy, hx); if (ha < 0) ha += Math.PI * 2;
    if (ha >= cutA && ha <= cutA + cutW) continue;
    ctx.beginPath(); ctx.arc(hx, hy, 0.07 + (i % 3) * 0.02, 0, Math.PI * 2); ctx.fill();
  }
}

// 18. Citrus Slice — player-colour rind/flesh with segments + seeds. (rolls)
function drawCitrusSkin(ctx, anim, paint) {
  paint = paint || "#f2a72e";
  ctx.beginPath(); ctx.arc(0, 0, 0.92, 0, Math.PI * 2);
  ctx.fillStyle = cartSkinShade(paint, -0.15); ctx.fill();      // rind
  ctx.beginPath(); ctx.arc(0, 0, 0.84, 0, Math.PI * 2); ctx.fillStyle = "#fff6e6"; ctx.fill();   // pith
  ctx.beginPath(); ctx.arc(0, 0, 0.8, 0, Math.PI * 2);
  ctx.fillStyle = cartSkinShade(paint, 0.42); ctx.fill();       // flesh
  // Segments.
  var segs = 10;
  ctx.strokeStyle = "#fff6e6"; ctx.lineWidth = 0.04;
  ctx.fillStyle = cartSkinShade(paint, 0.55);
  for (var i = 0; i < segs; i++) {
    var a0 = i * Math.PI * 2 / segs + 0.04, a1 = (i + 1) * Math.PI * 2 / segs - 0.04;
    ctx.beginPath(); ctx.moveTo(0, 0);
    ctx.arc(0, 0, 0.78, a0, a1); ctx.closePath();
    ctx.fill(); ctx.stroke();
  }
  ctx.fillStyle = "#fff6e6"; ctx.beginPath(); ctx.arc(0, 0, 0.1, 0, Math.PI * 2); ctx.fill();
  // A couple of seeds.
  ctx.fillStyle = "#e8d6a0";
  ctx.beginPath(); ctx.ellipse(0.3, 0.1, 0.04, 0.06, 0.5, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(-0.2, -0.3, 0.04, 0.06, -0.4, 0, Math.PI * 2); ctx.fill();
}

// 19. Turtle Shell — player-colour domed shell with scute pattern. (rolls)
function drawTurtleSkin(ctx, anim, paint) {
  paint = paint || "#3f8f3a";
  ctx.beginPath(); ctx.arc(0, 0, 0.92, 0, Math.PI * 2);
  ctx.fillStyle = cartSkinShade(paint, -0.3); ctx.fill();       // dark rim
  ctx.beginPath(); ctx.arc(0, 0, 0.82, 0, Math.PI * 2);
  var sh = ctx.createRadialGradient(-0.2, -0.2, 0.1, 0, 0, 0.9);
  sh.addColorStop(0, cartSkinShade(paint, 0.3)); sh.addColorStop(1, cartSkinShade(paint, -0.1));
  ctx.fillStyle = sh; ctx.fill();
  // Central scute + ring of scutes.
  ctx.strokeStyle = cartSkinShade(paint, -0.45); ctx.lineWidth = 0.03; ctx.fillStyle = cartSkinShade(paint, 0.12);
  cartPolyPath(ctx, 0, 0, 0.28, 6, Math.PI / 6); ctx.fill(); ctx.stroke();
  for (var i = 0; i < 6; i++) {
    var a = i * Math.PI / 3;
    ctx.save(); ctx.translate(Math.cos(a) * 0.52, Math.sin(a) * 0.52); ctx.rotate(a);
    cartPolyPath(ctx, 0, 0, 0.2, 5, a); ctx.fill(); ctx.stroke();
    ctx.restore();
  }
  // Rim segments.
  ctx.strokeStyle = cartSkinShade(paint, -0.4); ctx.lineWidth = 0.02;
  for (var s = 0; s < 12; s++) {
    var sa = s * Math.PI / 6;
    ctx.beginPath(); ctx.moveTo(Math.cos(sa) * 0.72, Math.sin(sa) * 0.72);
    ctx.lineTo(Math.cos(sa) * 0.92, Math.sin(sa) * 0.92); ctx.stroke();
  }
}

// 20. Jack-o'-Lantern — a ridged player-colour pumpkin (built from overlapping
// lobes) with a candle-lit carved face that flickers. (statue)
function drawPumpkinSkin(ctx, anim, paint) {
  paint = paint || "#e8731c";
  var flick = 0.72 + 0.28 * (0.55 * Math.sin(anim * 9) + 0.45 * Math.sin(anim * 3.3 + 1));
  flick = flick < 0.45 ? 0.45 : (flick > 1 ? 1 : flick);
  var seam = cartSkinShade(paint, -0.4);

  // Stem (behind body, peeking over the top).
  ctx.fillStyle = "#5d7d34"; ctx.strokeStyle = "#3c5520"; ctx.lineWidth = 0.02;
  ctx.beginPath();
  ctx.moveTo(-0.08, -0.74); ctx.lineTo(-0.05, -1.0);
  ctx.quadraticCurveTo(0.12, -1.04, 0.14, -0.92);
  ctx.lineTo(0.08, -0.72); ctx.closePath(); ctx.fill(); ctx.stroke();

  // Ridged body: overlapping vertical lobes, drawn outermost-first so the
  // centre lobe sits in front (the lobe edges read as pumpkin ribs).
  var lobes = [
    { x: -0.66, rx: 0.3 }, { x: 0.66, rx: 0.3 },
    { x: -0.37, rx: 0.43 }, { x: 0.37, rx: 0.43 },
    { x: 0, rx: 0.52 }
  ];
  for (var i = 0; i < lobes.length; i++) {
    var L = lobes[i];
    ctx.beginPath(); ctx.ellipse(L.x, 0.06, L.rx, 0.82, 0, 0, Math.PI * 2);
    var pg = ctx.createRadialGradient(L.x - 0.06, -0.15, 0.05, L.x, 0.06, L.rx + 0.5);
    pg.addColorStop(0, cartSkinShade(paint, 0.32));
    pg.addColorStop(0.7, paint);
    pg.addColorStop(1, cartSkinShade(paint, -0.28));
    ctx.fillStyle = pg; ctx.fill();
    ctx.strokeStyle = seam; ctx.lineWidth = 0.02; ctx.stroke();
  }

  // Candle glow behind the face.
  var glow = ctx.createRadialGradient(0, 0.12, 0.05, 0, 0.12, 0.6);
  glow.addColorStop(0, "rgba(255,200,90," + (0.5 * flick) + ")");
  glow.addColorStop(1, "rgba(255,160,40,0)");
  ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(0, 0.12, 0.6, 0, Math.PI * 2); ctx.fill();

  // Carved, lit features.
  var lit = "rgba(255," + (170 + 60 * flick | 0) + "," + (40 + 30 * flick | 0) + "," + flick + ")";
  ctx.fillStyle = lit; ctx.strokeStyle = "#5a2a08"; ctx.lineWidth = 0.018; ctx.lineJoin = "round";
  // Angled triangle eyes.
  ctx.beginPath(); ctx.moveTo(-0.44, -0.2); ctx.lineTo(-0.14, -0.08); ctx.lineTo(-0.16, 0.06); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0.44, -0.2); ctx.lineTo(0.14, -0.08); ctx.lineTo(0.16, 0.06); ctx.closePath(); ctx.fill(); ctx.stroke();
  // Triangle nose.
  ctx.beginPath(); ctx.moveTo(0, 0.02); ctx.lineTo(0.11, 0.2); ctx.lineTo(-0.11, 0.2); ctx.closePath(); ctx.fill(); ctx.stroke();
  // Toothy grin (zig-zag band with two square teeth).
  ctx.beginPath();
  ctx.moveTo(-0.5, 0.32);
  ctx.lineTo(-0.34, 0.36); ctx.lineTo(-0.28, 0.5); ctx.lineTo(-0.12, 0.4);
  ctx.lineTo(0.12, 0.4); ctx.lineTo(0.28, 0.5); ctx.lineTo(0.34, 0.36); ctx.lineTo(0.5, 0.32);
  ctx.lineTo(0.4, 0.56); ctx.lineTo(0.16, 0.62);
  ctx.lineTo(0.1, 0.5); ctx.lineTo(-0.1, 0.5);
  ctx.lineTo(-0.16, 0.62); ctx.lineTo(-0.4, 0.56);
  ctx.closePath(); ctx.fill(); ctx.stroke();
}

// ============================================================================
// BATCH 3 (operator request): Moon, OK-hand emoji, generic Mouse.
// ============================================================================

// Moon — a pale tinted moon with craters, a phase shadow, soft glow and a
// sleepy "man in the moon" face. (statue)
function drawMoonSkin(ctx, anim, paint) {
  paint = paint || "#cfd2dc";
  var pulse = 0.6 + 0.4 * Math.sin(anim * 1.4);
  // Soft glow.
  var halo = ctx.createRadialGradient(0, 0, 0.72, 0, 0, 1.06);
  halo.addColorStop(0, cartSkinShadeA(paint, 0.6, 0));
  halo.addColorStop(0.82, cartSkinShadeA(paint, 0.65, 0.28 * pulse));
  halo.addColorStop(1, cartSkinShadeA(paint, 0.65, 0));
  ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(0, 0, 1.06, 0, Math.PI * 2); ctx.fill();
  // Moon disc.
  ctx.beginPath(); ctx.arc(0, 0, 0.9, 0, Math.PI * 2);
  var g = ctx.createRadialGradient(-0.25, -0.28, 0.1, 0, 0, 1.0);
  g.addColorStop(0, cartSkinShade(paint, 0.55)); g.addColorStop(1, cartSkinShade(paint, 0.05));
  ctx.fillStyle = g; ctx.fill();
  // Craters.
  var craters = [[0.34, -0.32, 0.13], [0.42, 0.28, 0.1], [-0.46, 0.22, 0.12], [0.18, 0.46, 0.08], [0.5, -0.02, 0.07]];
  for (var i = 0; i < craters.length; i++) {
    ctx.fillStyle = cartSkinShadeA(paint, -0.2, 0.45);
    ctx.beginPath(); ctx.arc(craters[i][0], craters[i][1], craters[i][2], 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = cartSkinShadeA(paint, 0.5, 0.4); ctx.lineWidth = 0.015;
    ctx.beginPath(); ctx.arc(craters[i][0], craters[i][1], craters[i][2], -2.3, 0.6); ctx.stroke();
  }
  // Phase shadow (right side).
  ctx.save();
  ctx.beginPath(); ctx.arc(0, 0, 0.9, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = "rgba(10,14,34,0.34)";
  ctx.beginPath(); ctx.arc(0.62, 0, 0.92, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  // Sleepy face on the lit (left) side.
  ctx.strokeStyle = cartSkinShade(paint, -0.5); ctx.lineWidth = 0.04; ctx.lineCap = "round";
  ctx.beginPath(); ctx.arc(-0.36, -0.04, 0.1, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
  ctx.beginPath(); ctx.arc(-0.04, -0.1, 0.1, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
  ctx.fillStyle = cartSkinShadeA(paint, -0.25, 0.5);
  ctx.beginPath(); ctx.arc(-0.42, 0.16, 0.06, 0, Math.PI * 2); ctx.fill();   // cheek
  ctx.beginPath(); ctx.arc(0.0, 0.12, 0.05, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(-0.2, 0.28, 0.11, 0.1 * Math.PI, 0.9 * Math.PI); ctx.stroke();  // smile
}

// OK-hand emoji (👌) — the actual system emoji glyph, enlarged to fill the cart.
// NOTE: a colour emoji renders in its own palette and does NOT tint to the player
// colour. (statue)
function drawOkSkin(ctx, anim, paint) {
  ctx.save();
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.font = "1.85px sans-serif";   // ~fills the unit circle
  ctx.fillText("👌", 0, 0.06);
  ctx.restore();
}

// Mouse — TOP-DOWN (like the Dino): head toward +X, long curly tail toward -X,
// round ears, little feet. A generic mouse (NOT Mickey); tints to player colour.
function drawMouseSkin(ctx, anim, paint) {
  paint = paint || "#9aa3ad";
  var dk = cartSkinShade(paint, -0.45);
  var legSwing = Math.sin(anim * 4) * 0.16;
  var tailWag = Math.sin(anim * 2.2) * 0.16;

  // Long thin curly tail (-X).
  ctx.strokeStyle = cartSkinShade(paint, 0.15); ctx.lineWidth = 0.055; ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-0.55, 0.02);
  ctx.quadraticCurveTo(-0.92, 0.12 + tailWag, -0.98, -0.2 + tailWag);
  ctx.quadraticCurveTo(-1.0, -0.42 + tailWag, -0.82, -0.46 + tailWag);
  ctx.stroke();

  // Feet (under body), with a little shuffle.
  ctx.fillStyle = cartSkinShade(paint, -0.3);
  var feet = [[0.18, 0.46, legSwing], [-0.28, 0.5, -legSwing], [0.18, -0.46, -legSwing], [-0.28, -0.5, legSwing]];
  for (var i = 0; i < feet.length; i++) {
    ctx.beginPath(); ctx.ellipse(feet[i][0] + feet[i][2], feet[i][1], 0.12, 0.08, 0, 0, Math.PI * 2); ctx.fill();
  }

  // Body.
  ctx.beginPath(); ctx.ellipse(-0.08, 0, 0.55, 0.4, 0, 0, Math.PI * 2);
  var bg = ctx.createRadialGradient(-0.2, -0.15, 0.1, -0.08, 0, 0.7);
  bg.addColorStop(0, cartSkinShade(paint, 0.28)); bg.addColorStop(1, paint);
  ctx.fillStyle = bg; ctx.fill();
  ctx.strokeStyle = dk; ctx.lineWidth = 0.035; ctx.stroke();

  // Ears — two rounded circles atop the head, lighter inner.
  for (var s = -1; s <= 1; s += 2) {
    ctx.beginPath(); ctx.arc(0.46, s * 0.34, 0.22, 0, Math.PI * 2);
    ctx.fillStyle = cartSkinShade(paint, 0.05); ctx.fill();
    ctx.strokeStyle = dk; ctx.lineWidth = 0.025; ctx.stroke();
    ctx.beginPath(); ctx.arc(0.5, s * 0.34, 0.12, 0, Math.PI * 2);
    ctx.fillStyle = "#e7a6b8"; ctx.fill();
  }

  // Head (teardrop toward +X with a snout).
  ctx.beginPath(); ctx.ellipse(0.6, 0, 0.34, 0.3, 0, 0, Math.PI * 2);
  ctx.fillStyle = cartSkinShade(paint, 0.12); ctx.fill();
  ctx.strokeStyle = dk; ctx.lineWidth = 0.03; ctx.stroke();
  // Snout tip + pink nose.
  ctx.fillStyle = cartSkinShade(paint, 0.2);
  ctx.beginPath(); ctx.moveTo(0.86, -0.12); ctx.quadraticCurveTo(1.02, 0, 0.86, 0.12); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#e26d8a";
  ctx.beginPath(); ctx.arc(0.96, 0, 0.06, 0, Math.PI * 2); ctx.fill();

  // Eyes (small, top-down).
  ctx.fillStyle = "#1c1208";
  ctx.beginPath(); ctx.arc(0.66, -0.13, 0.06, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(0.66, 0.13, 0.06, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.beginPath(); ctx.arc(0.68, -0.15, 0.02, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(0.68, 0.11, 0.02, 0, Math.PI * 2); ctx.fill();

  // Whiskers from the snout.
  ctx.strokeStyle = "rgba(255,255,255,0.6)"; ctx.lineWidth = 0.014;
  for (var w = -1; w <= 1; w += 2) {
    ctx.beginPath(); ctx.moveTo(0.86, w * 0.06); ctx.lineTo(1.12, w * 0.02); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0.86, w * 0.08); ctx.lineTo(1.1, w * 0.16); ctx.stroke();
  }
}
