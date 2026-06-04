// celebrations.js — the progression reward sequence shown on lobby arrival.
//
// Replaces the old one-line text toasts with a three-tier celebration, sized to the
// moment so a +80 XP drip and a 25-win Galaxy cart no longer get the same treatment:
//   1. XP        — compact top-center card: count-up + an ANIMATED level-bar fill that
//                  rolls over on level-up, ending in a "next unlock" teaser.
//   2. Level up  — center burst: LEVEL N pop + ring shockwave (absorbed into the XP
//                  card's rollover when the two arrive together).
//   3. Unlock    — full-screen reveal: vignette + rotating rays + the ACTUAL cosmetic
//                  painted live on a canvas in the player's color + confetti + cheer.
//
// Driven by the same server event batch as before (progressionToasts). client.js calls
// celebrationsEnqueue(events) which consumes what it understands and RETURNS the rest
// (error toasts, unknown ids, old-format queue entries) for the legacy text path. The
// legacy queue (incl. the 2× XP reward offer) defers while celebrationsActive() and is
// resumed by this file when the sequence drains, so the offer still lands last.
//
// Celebrations only ever show in the lobby: the batch is delivered on lobby arrival and
// clearProgressionToasts() (startGated) calls celebrationsClear() before a race begins.
// All cross-file references (skin registry painters, audio descriptors, playerList) are
// typeof-guarded so this file is safe in any bundle order and in headless contexts.

var celebrationQueue = [];           // mapped celebration items, one shown at a time
var celebrationShowing = false;
var celebrationRoot = null;          // the overlay element for the CURRENT item
var celebrationRafId = null;         // canvas/bar animation loop for the current item
var celebrationTimers = [];          // every pending timeout for the current item

var CELEBRATION_UNLOCK_MS = 4500;    // unlock reveal auto-advance (click skips sooner)
var CELEBRATION_LEVEL_MS = 2600;     // standalone level burst
var CELEBRATION_XP_HOLD_MS = 1900;   // XP card hold after the bar finishes filling

// Rarity accent colors (card border / kicker glow on the unlock reveal).
var CELEBRATION_RARITY_COLORS = {
	common: "#b8c0c8", uncommon: "#5fd97a", rare: "#4aa8ff",
	epic: "#c77dff", legendary: "#ffa940", seasonal: "#ffd34d"
};

// ---------------------------------------------------------------------------
// Queue plumbing
// ---------------------------------------------------------------------------

function celebrationsActive() {
	return celebrationShowing || celebrationQueue.length > 0;
}

// Map a server toast batch into celebration items. Consumes what this system can
// present and returns the LEFTOVER events for the legacy text-toast path. A 'level'
// event directly after an 'xp' event whose bar already rolls past it is absorbed into
// that card (the rollover IS the level-up moment); standalone 'level' events (e.g. the
// rewarded-bonus path, which suppresses its xp event) still get their own burst.
function celebrationsEnqueue(events) {
	if (!events || !events.length || !document.body) { return events || []; }
	var leftover = [];
	var mapped = [];
	for (var i = 0; i < events.length; i++) {
		var ev = events[i];
		if (!ev || !ev.type) { continue; }
		if (ev.type === "xp" || ev.type === "xp_bonus") {
			if (!(ev.amount > 0) && ev.type === "xp") { continue; }
			mapped.push({ kind: "xp", amount: ev.amount || 0, from: ev.from || null, to: ev.to || null, bonus: ev.type === "xp_bonus" });
		} else if (ev.type === "level") {
			var prev = mapped[mapped.length - 1];
			if (prev && prev.kind === "xp" && prev.to && prev.to.level >= ev.level) {
				prev.levelBurst = ev.level; // rollover handles it
			} else {
				mapped.push({ kind: "level", level: ev.level });
			}
		} else if (ev.type === "skin" || ev.type === "achievement" || ev.type === "seasonal") {
			// Only take ids the local registry can actually paint; anything unknown
			// (older client vs newer server) falls back to the text toast.
			var sk = (typeof getSkin === "function") ? getSkin(ev.id) : null;
			if (sk) {
				mapped.push({ kind: "unlock", id: ev.id, unlockType: ev.type });
			} else {
				leftover.push(ev);
			}
		} else {
			leftover.push(ev); // xp_bonus_error / xp_bonus_failed / future types
		}
	}
	if (mapped.length) {
		celebrationQueue = celebrationQueue.concat(mapped);
		if (!celebrationShowing) { celebrationShowNext(); }
	}
	return leftover;
}

// Tear down the live celebration + queue. Called from clearProgressionToasts() when
// the lobby ends so nothing can linger over (or block input to) a live race.
function celebrationsClear() {
	celebrationQueue.length = 0;
	celebrationShowing = false;
	celebrationStopAnims();
	if (celebrationRoot && celebrationRoot.parentNode) { celebrationRoot.parentNode.removeChild(celebrationRoot); }
	celebrationRoot = null;
}

function celebrationStopAnims() {
	if (celebrationRafId != null) { cancelAnimationFrame(celebrationRafId); celebrationRafId = null; }
	for (var i = 0; i < celebrationTimers.length; i++) { clearTimeout(celebrationTimers[i]); }
	celebrationTimers.length = 0;
}

function celebrationTimer(fn, ms) {
	var id = setTimeout(fn, ms);
	celebrationTimers.push(id);
	return id;
}

function celebrationShowNext() {
	celebrationStopAnims();
	if (celebrationRoot && celebrationRoot.parentNode) { celebrationRoot.parentNode.removeChild(celebrationRoot); }
	celebrationRoot = null;
	if (!celebrationQueue.length || !document.body) {
		celebrationShowing = false;
		// Sequence done — release the legacy toast queue (the 2× XP offer waits there).
		if (typeof showNextProgressionToast === "function" && typeof progressionToastShowing !== "undefined" && !progressionToastShowing) {
			showNextProgressionToast();
		}
		return;
	}
	celebrationShowing = true;
	var item = celebrationQueue.shift();
	if (item.kind === "xp") { celebrationShowXp(item); }
	else if (item.kind === "level") { celebrationShowLevel(item); }
	else { celebrationShowUnlock(item); }
}

function celebrationAdvance() {
	celebrationShowNext();
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function celebrationPlayerColor() {
	var p = (typeof myID !== "undefined" && typeof playerList !== "undefined" && playerList) ? playerList[myID] : null;
	return (p && p.color) || "#ffd34d";
}

function celebrationPlay(sound) {
	if (typeof playSound === "function" && typeof sound !== "undefined" && sound) { playSound(sound); }
}

function celebrationEl(tag, className, parent, text) {
	var el = document.createElement(tag);
	if (className) { el.className = className; }
	if (text != null) { el.textContent = text; } // textContent: never inject
	if (parent) { parent.appendChild(el); }
	return el;
}

// Spawn n confetti pieces inside `parent` (CSS does the falling/tumbling). Colors mix
// the player color with the celebration palette so it reads as "yours".
function celebrationConfetti(parent, n, accent) {
	var colors = [celebrationPlayerColor(), accent || "#ffd34d", "#ff6b6b", "#4aa8ff", "#5fd97a", "#ffffff"];
	for (var i = 0; i < n; i++) {
		var piece = celebrationEl("div", "cc-confetti", parent);
		piece.style.left = (Math.random() * 100) + "%";
		piece.style.background = colors[i % colors.length];
		piece.style.setProperty("--dx", ((Math.random() * 2 - 1) * 120).toFixed(0) + "px");
		piece.style.setProperty("--rot", ((Math.random() * 2 - 1) * 720).toFixed(0) + "deg");
		piece.style.animationDuration = (1.6 + Math.random() * 1.8).toFixed(2) + "s";
		piece.style.animationDelay = (Math.random() * 0.7).toFixed(2) + "s";
		if (Math.random() < 0.4) { piece.style.borderRadius = "50%"; }
	}
}

// Paint one cosmetic onto an arbitrary canvas ctx, centered, in `color`. A port of the
// lobby locker's drawCosmeticPreview (lobbyHub.js) generalized off gameContext, with a
// LIVE anim time so animated carts spin and trail particles flow on the reveal card.
function celebrationPaintCosmetic(ctx, w, h, id, color, animMs) {
	var slot = (typeof getSkinSlot === "function") ? getSkinSlot(id) : null;
	var skin = (typeof getSkin === "function") ? getSkin(id) : null;
	var cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.30;
	ctx.clearRect(0, 0, w, h);
	ctx.save();
	if (slot === "trail") {
		// Trails are motion effects: render the real effect on a synthetic arc with the
		// newest vertex at the kart head, like the locker preview — but with a live clock
		// so the particles actually flow while the card is up.
		var nowMs = Date.now();
		var fadeMs = (typeof TRAIL_FADE_MS !== "undefined") ? TRAIL_FADE_MS : 1700;
		var verts = [], STEPS = 26;
		for (var ti = 0; ti <= STEPS; ti++) {
			var u = ti / STEPS;
			verts.push({
				x: (u * 2 - 1) * 40,
				y: Math.sin(u * Math.PI) * -14 + 6,
				t: nowMs - fadeMs * (1 - u)
			});
		}
		if (typeof paintTrailFx === "function") {
			ctx.translate(cx, cy);
			ctx.scale(r / 34, r / 34);
			var drew = paintTrailFx(ctx, id, verts, color, { fadeMs: fadeMs, anim: animMs / 1000 });
			if (drew) {
				var head = verts[verts.length - 1];
				ctx.fillStyle = color;
				ctx.beginPath(); ctx.arc(head.x, head.y, 9, 0, Math.PI * 2); ctx.fill();
				ctx.restore();
				return;
			}
		}
		ctx.restore();
		// Fallback: plain stroke.
		ctx.save();
		ctx.strokeStyle = color; ctx.lineCap = "round"; ctx.lineWidth = 3;
		ctx.beginPath(); ctx.moveTo(cx - r, cy + r * 0.3); ctx.quadraticCurveTo(cx, cy - r * 0.6, cx + r, cy + r * 0.3); ctx.stroke();
		ctx.restore();
		return;
	}
	var painter = (typeof getSkinPainter === "function") ? getSkinPainter(id) : null;
	if (!painter) {
		ctx.fillStyle = color;
		ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
		ctx.restore();
		return;
	}
	ctx.translate(cx, cy);
	// Match in-game orientation: statue carts draw upright natively; everything else
	// faces +X, so rotate −90° to read as "up" (same rule as the locker preview).
	var statue = !!(slot === "cart" && skin && skin.statue);
	if (!statue) { ctx.rotate(-Math.PI / 2); }
	var anim = animMs / 1000;
	if (slot === "border") {
		// Borders ring the rim (~1.0..1.4 normalized) over any cart: tinted disc stand-in,
		// then the border painter unclipped, scaled tighter so the rim stays on-canvas.
		ctx.scale(r, r);
		ctx.fillStyle = color;
		ctx.beginPath(); ctx.arc(0, 0, 0.7, 0, Math.PI * 2); ctx.fill();
		painter(ctx, anim, color);
	} else if (slot === "pattern") {
		ctx.scale(r * 1.45, r * 1.45);
		ctx.fillStyle = color;
		ctx.beginPath(); ctx.arc(0, 0, 0.95, 0, Math.PI * 2); ctx.fill();
		ctx.save();
		ctx.beginPath(); ctx.arc(0, 0, 0.95, 0, Math.PI * 2); ctx.clip();
		painter(ctx, anim, color);
		ctx.restore();
	} else {
		ctx.scale(r * 1.45, r * 1.45);
		painter(ctx, anim, color);
	}
	ctx.restore();
}

// "how you earned it" line for an unlock card.
function celebrationUnlockSubtitle(item, skin) {
	if (item.unlockType === "achievement") {
		var defs = (typeof config !== "undefined" && config && config.achievementDefs) ? config.achievementDefs : null;
		if (defs) {
			for (var i = 0; i < defs.length; i++) {
				if (defs[i].id === item.id) { return defs[i].desc; }
			}
		}
		return "Achievement unlocked";
	}
	if (item.unlockType === "seasonal") {
		var label = (skin && skin.unlock && skin.unlock.label) ? skin.unlock.label : "Limited";
		return label + " — yours forever";
	}
	if (skin && skin.unlock && skin.unlock.kind === "level") { return "Reached Level " + skin.unlock.level; }
	return "Unlocked";
}

function celebrationSlotWord(slot) {
	return slot === "cart" ? "cart" : slot === "pattern" ? "pattern" : slot === "trail" ? "trail" : slot === "border" ? "border" : "cosmetic";
}

// ---------------------------------------------------------------------------
// Tier 1 — XP card (count-up + animated level bar + next-unlock teaser)
// ---------------------------------------------------------------------------

function celebrationShowXp(item) {
	var overlay = celebrationEl("div", "cc-celebrate cc-celebrate-xp", document.body);
	celebrationRoot = overlay;
	var card = celebrationEl("div", "cc-xp-card", overlay);
	var amountEl = celebrationEl("div", "cc-xp-amount", card, (item.bonus ? "⭐ +0 bonus XP" : "+0 XP"));
	var hasBar = !!(item.from && item.to && item.to.xpForNextLevel);
	var levelEl = null, fillEl = null, fracEl = null;
	if (hasBar) {
		var row = celebrationEl("div", "cc-xp-row", card);
		levelEl = celebrationEl("span", "cc-xp-level", row, "Lv " + item.from.level);
		var bar = celebrationEl("div", "cc-xp-bar", row);
		fillEl = celebrationEl("div", "cc-xp-fill", bar);
		fracEl = celebrationEl("span", "cc-xp-frac", row, "");
		fillEl.style.width = (100 * Math.min(1, (item.from.xpThisLevel || 0) / (item.from.xpForNextLevel || 1))).toFixed(1) + "%";
	} else if (item.bonus) {
		celebrationEl("div", "cc-xp-sub", card, "Match XP doubled!");
	}
	requestAnimationFrame(function () { overlay.classList.add("visible"); });
	celebrationPlay(typeof celebrationXpTick !== "undefined" ? celebrationXpTick : null);

	var levelsCrossed = hasBar ? Math.max(0, item.to.level - item.from.level) : 0;
	var fillDur = 1300 + Math.min(3, levelsCrossed) * 320;
	var start = null;
	function ease(u) { return 1 - Math.pow(1 - u, 3); } // easeOutCubic
	// The bar's journey, in "level segments": fromFrac→1 for each crossed level (visual
	// sweep — intermediate level costs live server-side only), then 0→toFrac.
	var fromFrac = hasBar ? Math.min(1, (item.from.xpThisLevel || 0) / (item.from.xpForNextLevel || 1)) : 0;
	var toFrac = hasBar ? Math.min(1, (item.to.xpThisLevel || 0) / (item.to.xpForNextLevel || 1)) : 0;
	var totalSpan = levelsCrossed > 0 ? (1 - fromFrac) + (levelsCrossed - 1) + toFrac : (toFrac - fromFrac);
	var dingedLevels = 0;

	function step(ts) {
		if (start == null) { start = ts; }
		var u = Math.min(1, (ts - start) / fillDur);
		var e = ease(u);
		amountEl.textContent = (item.bonus ? "⭐ +" : "+") + Math.round(e * item.amount) + (item.bonus ? " bonus XP" : " XP");
		if (hasBar) {
			var traveled = fromFrac + e * totalSpan; // continuous position incl. rollovers
			var wholeLevels = Math.floor(traveled);
			var frac = traveled - wholeLevels;
			if (wholeLevels > levelsCrossed) { wholeLevels = levelsCrossed; frac = toFrac; }
			if (wholeLevels === levelsCrossed && frac > toFrac && levelsCrossed > 0) { frac = toFrac; }
			while (dingedLevels < wholeLevels) {
				dingedLevels++;
				levelEl.textContent = "Lv " + (item.from.level + dingedLevels);
				levelEl.classList.remove("cc-xp-level-pop");
				void levelEl.offsetWidth; // restart the pop animation
				levelEl.classList.add("cc-xp-level-pop");
				celebrationPlay(typeof celebrationLevelUp !== "undefined" ? celebrationLevelUp : null);
			}
			fillEl.style.width = (100 * Math.min(1, frac)).toFixed(1) + "%";
			if (dingedLevels === levelsCrossed) {
				fracEl.textContent = item.to.xpThisLevel + " / " + item.to.xpForNextLevel;
			}
		}
		if (u < 1) {
			celebrationRafId = requestAnimationFrame(step);
		} else {
			celebrationRafId = null;
			celebrationXpFinish(item, overlay, card);
		}
	}
	celebrationRafId = requestAnimationFrame(step);
}

// Bar's done filling: optionally pop the absorbed LEVEL N burst, then the next-unlock
// teaser, then hold + dismiss.
function celebrationXpFinish(item, overlay, card) {
	var hold = CELEBRATION_XP_HOLD_MS;
	if (item.levelBurst) {
		var burst = celebrationEl("div", "cc-level-pop", card);
		celebrationEl("div", "cc-level-pop-kicker", burst, "LEVEL UP");
		celebrationEl("div", "cc-level-pop-num", burst, "" + item.levelBurst);
		celebrationConfetti(overlay, 26, "#ffd34d");
		hold += 900;
	}
	// Teaser: what's next on the ladder (server-computed on the freshest progression).
	var prog = (typeof myProgression !== "undefined") ? myProgression : null;
	if (prog && prog.nextUnlock && prog.nextUnlock.id && typeof getSkin === "function" && getSkin(prog.nextUnlock.id)) {
		var teaser = celebrationEl("div", "cc-xp-teaser", card);
		var tCanvas = celebrationEl("canvas", "cc-xp-teaser-canvas", teaser);
		tCanvas.width = 44; tCanvas.height = 44;
		var nm = (typeof skinDisplayName === "function") ? skinDisplayName(prog.nextUnlock.id) : prog.nextUnlock.id;
		// ~matches-to-go from the typical per-match XP (participation + a couple notches).
		var perMatch = 90;
		if (typeof config !== "undefined" && config && config.xpParticipate) {
			perMatch = config.xpParticipate + 2 * (config.xpPerNotch || 0);
		}
		var matches = Math.max(1, Math.ceil((prog.nextUnlock.xpToGo || 0) / perMatch));
		celebrationEl("div", "cc-xp-teaser-text", teaser,
			"Next: " + nm + " · Lv " + prog.nextUnlock.level + " · ~" + matches + (matches === 1 ? " match away" : " matches away"));
		try {
			celebrationPaintCosmetic(tCanvas.getContext("2d"), 44, 44, prog.nextUnlock.id, celebrationPlayerColor(), 0);
		} catch (e) { /* teaser thumb is decoration — never let it break the sequence */ }
		requestAnimationFrame(function () { teaser.classList.add("visible"); });
		hold += 600;
	}
	celebrationTimer(function () {
		overlay.classList.remove("visible");
		celebrationTimer(celebrationAdvance, 380);
	}, hold);
}

// ---------------------------------------------------------------------------
// Tier 2 — standalone level burst (xp-suppressed paths, old-format queues)
// ---------------------------------------------------------------------------

function celebrationShowLevel(item) {
	var overlay = celebrationEl("div", "cc-celebrate cc-celebrate-level", document.body);
	celebrationRoot = overlay;
	var wrap = celebrationEl("div", "cc-level-burst", overlay);
	celebrationEl("div", "cc-level-ring", wrap);
	celebrationEl("div", "cc-level-pop-kicker", wrap, "LEVEL UP");
	celebrationEl("div", "cc-level-pop-num", wrap, "" + item.level);
	celebrationConfetti(overlay, 26, "#ffd34d");
	requestAnimationFrame(function () { overlay.classList.add("visible"); });
	celebrationPlay(typeof celebrationLevelUp !== "undefined" ? celebrationLevelUp : null);
	celebrationTimer(function () {
		overlay.classList.remove("visible");
		celebrationTimer(celebrationAdvance, 380);
	}, CELEBRATION_LEVEL_MS);
}

// ---------------------------------------------------------------------------
// Tier 3 — full-screen unlock reveal
// ---------------------------------------------------------------------------

function celebrationShowUnlock(item) {
	var skin = (typeof getSkin === "function") ? getSkin(item.id) : null;
	var slot = (typeof getSkinSlot === "function") ? getSkinSlot(item.id) : null;
	var accent = CELEBRATION_RARITY_COLORS[(skin && skin.rarity) || "common"] || CELEBRATION_RARITY_COLORS.common;

	var overlay = celebrationEl("div", "cc-celebrate cc-celebrate-unlock", document.body);
	celebrationRoot = overlay;
	overlay.style.setProperty("--cc-accent", accent);
	celebrationEl("div", "cc-unlock-rays", overlay);
	celebrationConfetti(overlay, 44, accent);

	var card = celebrationEl("div", "cc-unlock-card", overlay);
	var kicker = item.unlockType === "achievement" ? "ACHIEVEMENT UNLOCKED"
		: item.unlockType === "seasonal" ? "LIMITED EDITION CLAIMED"
		: ("NEW " + celebrationSlotWord(slot).toUpperCase() + " UNLOCKED");
	celebrationEl("div", "cc-unlock-kicker", card, kicker);
	var canvas = celebrationEl("canvas", "cc-unlock-canvas", card);
	canvas.width = 220; canvas.height = 220;
	var nm = (typeof skinDisplayName === "function") ? skinDisplayName(item.id) : item.id;
	celebrationEl("div", "cc-unlock-name", card, nm);
	celebrationEl("div", "cc-unlock-sub", card, celebrationUnlockSubtitle(item, skin));
	if (skin && skin.rarity && skin.rarity !== "common") {
		celebrationEl("div", "cc-unlock-rarity", card, skin.rarity);
	}
	celebrationEl("div", "cc-unlock-hint", card, "tap to continue");

	requestAnimationFrame(function () { overlay.classList.add("visible"); });
	celebrationPlay(typeof celebrationCheer !== "undefined" ? celebrationCheer : null);

	// Live preview loop — animated carts spin, trails flow, in the player's color.
	var ctx = canvas.getContext("2d");
	var color = celebrationPlayerColor();
	var t0 = null;
	function paintLoop(ts) {
		if (t0 == null) { t0 = ts; }
		try {
			celebrationPaintCosmetic(ctx, canvas.width, canvas.height, item.id, color, ts - t0);
		} catch (e) { /* a painter throw must never strand the overlay */ }
		celebrationRafId = requestAnimationFrame(paintLoop);
	}
	celebrationRafId = requestAnimationFrame(paintLoop);

	var done = false;
	function finish() {
		if (done) { return; }
		done = true;
		overlay.classList.remove("visible");
		celebrationTimer(celebrationAdvance, 380);
	}
	overlay.addEventListener("pointerdown", finish);
	celebrationTimer(finish, CELEBRATION_UNLOCK_MS);
}

// ---------------------------------------------------------------------------
// Dev/tuning hook: window.__celebratePreview() replays a sample sequence (or pass your
// own events array). Client-side only — renders fake toasts, grants nothing.
// ---------------------------------------------------------------------------
if (typeof window !== "undefined") {
	window.__celebratePreview = function (events) {
		celebrationsEnqueue(events || [
			{ type: "xp", amount: 195, from: { level: 3, xpThisLevel: 100, xpForNextLevel: 138 }, to: { level: 4, xpThisLevel: 157, xpForNextLevel: 160 } },
			{ type: "level", level: 4 },
			{ type: "skin", id: "pizza" },
			{ type: "achievement", id: "comet" },
			{ type: "achievement", id: "galaxy" }
		]);
	};
}
