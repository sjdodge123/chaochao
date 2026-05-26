"use strict";

// Cross-page controller identity (chaochao).
//
// The browser Gamepad API hands out `index` values per page load and gives no
// stable handle across navigations, so each page historically grabbed "the
// lowest-index connected pad". That meant the host's controller could silently
// flip to a DIFFERENT physical pad after leaving a game or opening the editor —
// the cursor would jump to whichever pad the browser happened to enumerate first.
//
// This module persists the in-game player ORDER (P1, P2, …) as a small list of
// { id, index } entries in localStorage, and lets any page prefer the pad that
// matches a remembered slot before falling back to lowest-index. The play page
// WRITES the order (that's where the host's P1 is established by joining); the
// menu pages and the editor READ it so their single cursor stays on the host's
// controller across navigations.
//
// Honest caveats (browser limitations, not bugs):
//   - Two identical controllers report the SAME `id` string, so for two-of-a-kind
//     pads the match is best-effort (id, then index, then fallback).
//   - Stored entries are always validated against the live pad list, so stale data
//     (a controller from a previous session that's no longer plugged in) is simply
//     ignored and the caller falls back to its normal behaviour.
//
// Loaded standalone (like theme.js) on play/create/join/index BEFORE the per-page
// controller scripts, so its globals exist when those run.

var CONTROLLER_ORDER_KEY = "chaochaoControllerOrder";

// Persist the controller order. `entries` is an array, in player-slot order, of
// gamepad objects or { id, index } records; falsy holes are skipped. Best-effort:
// any storage failure (private mode, quota) is swallowed — identity is a
// nice-to-have, never load-bearing.
function saveControllerOrder(entries) {
    if (!entries) {
        return;
    }
    try {
        var out = [];
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            if (!e) {
                continue;
            }
            out.push({
                id: e.id || "",
                index: (typeof e.index === "number") ? e.index : null
            });
        }
        localStorage.setItem(CONTROLLER_ORDER_KEY, JSON.stringify(out));
    } catch (err) { /* storage unavailable — non-fatal */ }
}

// Read the persisted order, or [] when there's nothing valid stored.
function loadControllerOrder() {
    try {
        var raw = localStorage.getItem(CONTROLLER_ORDER_KEY);
        if (!raw) {
            return [];
        }
        var arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch (err) {
        return [];
    }
}

// Convenience for the single-cursor surfaces (menus, editor): record `pad` as the
// primary (slot 0) controller while preserving any already-stored P2+ order. This
// is what makes "whichever pad you actually drive becomes the host" carry forward
// to the next page.
function rememberPrimaryController(pad) {
    if (!pad) {
        return;
    }
    var order = loadControllerOrder();
    order[0] = {
        id: pad.id || "",
        index: (typeof pad.index === "number") ? pad.index : null
    };
    saveControllerOrder(order);
}

// Given the live `navigator.getGamepads()` array and a desired player slot, return
// the index of the connected pad that best matches the remembered identity for that
// slot — or null when there's no remembered entry or no live match (the caller then
// falls back to its existing lowest-index behaviour). Match priority:
//   1. exact: same id AND same index (the common, stable case)
//   2. same id on any connected slot (handles an index reshuffle across pages, and
//      transparently covers identical controllers — they share an id, so we pick the
//      first connected one)
//   3. only when NO id was ever recorded: the remembered index, if still connected
// Crucially, when we DO know the id and no connected pad matches it, the remembered
// controller is genuinely gone — we return null so the caller falls back to its own
// lowest-index default rather than binding whatever happens to sit at that index.
function preferredPadIndexForSlot(pads, slot) {
    if (!pads) {
        return null;
    }
    var order = loadControllerOrder();
    var want = order[slot || 0];
    if (!want) {
        return null;
    }
    var i;
    if (want.index != null && pads[want.index] && pads[want.index].id === want.id) {
        return want.index;
    }
    if (want.id) {
        for (i = 0; i < pads.length; i++) {
            if (pads[i] && pads[i].id === want.id) {
                return i;
            }
        }
        return null; // known controller, not currently connected
    }
    if (want.index != null && pads[want.index]) {
        return want.index;
    }
    return null;
}
