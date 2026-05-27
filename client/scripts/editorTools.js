// Editor tooling shared by create.js: a generic undo/redo command stack, the
// keyboard-shortcut bindings, and the map-list search filter. Kept out of
// create.js (already large) per the ~300-line/file convention. These run in the
// same global scope as create.js (the bundle concatenates files, no modules), so
// they call create.js helpers directly (setTool/editorSelectTile/…); create.js's
// init() drives the install* entry points below.

// --- generic undo/redo command stack -----------------------------------------
// A command is { undo: fn, redo: fn }. create.js builds the domain-specific
// closures (paint-stroke diffs, hazard add/remove/rotate) and hands them here;
// this module only owns the two stacks and the button state. Destructive
// regenerates (wipe / start-edge reshape) call clearHistory() — those aren't
// undoable by design (matching the "full snapshots are expensive" backlog note).
var edUndoStack = [];
var edRedoStack = [];
var ED_UNDO_LIMIT = 200;

function pushCommand(cmd) {
    if (cmd == null || typeof cmd.undo !== "function" || typeof cmd.redo !== "function") {
        return;
    }
    edUndoStack.push(cmd);
    if (edUndoStack.length > ED_UNDO_LIMIT) {
        edUndoStack.shift();
    }
    edRedoStack = []; // a fresh action invalidates the redo branch
    updateUndoRedoButtons();
}

function editorUndo() {
    if (edUndoStack.length === 0) {
        return;
    }
    var cmd = edUndoStack.pop();
    cmd.undo();
    edRedoStack.push(cmd);
    afterHistoryChange();
}

function editorRedo() {
    if (edRedoStack.length === 0) {
        return;
    }
    var cmd = edRedoStack.pop();
    cmd.redo();
    edUndoStack.push(cmd);
    afterHistoryChange();
}

function clearHistory() {
    edUndoStack = [];
    edRedoStack = [];
    updateUndoRedoButtons();
}

// After undo/redo a hazard may have vanished (or moved); drop any stale selection
// and force a redraw. create.js owns setSelectedObject/dirty.
function afterHistoryChange() {
    if (typeof setSelectedObject === "function") {
        setSelectedObject(null);
    }
    if (typeof dirty !== "undefined") {
        dirty = true;
    }
    updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
    var u = document.getElementById("undoButton");
    var r = document.getElementById("redoButton");
    if (u != null) { u.disabled = edUndoStack.length === 0; }
    if (r != null) { r.disabled = edRedoStack.length === 0; }
}

// --- keyboard shortcuts -------------------------------------------------------
// Bound once from create.js init(). Only fire while the editor surface is open
// (not the map-list) and never while typing in a text field or driving the
// on-screen keyboard, so the editor stays usable with mouse + keyboard the way an
// experienced user expects without stealing input from the Details fields.

function installEditorShortcuts() {
    document.addEventListener("keydown", handleEditorShortcut, false);
}

function editorTypingTarget(el) {
    if (el == null) { return false; }
    var tag = (el.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || el.isContentEditable === true;
}

function handleEditorShortcut(e) {
    // Don't hijack keys while the on-screen keyboard is up or a field has focus.
    if (typeof oskIsOpen === "function" && oskIsOpen()) { return; }
    if (editorTypingTarget(document.activeElement)) { return; }
    // Shortcuts only make sense on the editing surface, not the map list.
    if (!document.body.classList.contains("editor-open")) { return; }
    if (typeof config === "undefined" || config == null) { return; }

    var ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && (e.key === "z" || e.key === "Z")) {
        if (e.shiftKey) { editorRedo(); } else { editorUndo(); }
        e.preventDefault();
        return;
    }
    if (ctrl && (e.key === "y" || e.key === "Y")) {
        editorRedo();
        e.preventDefault();
        return;
    }
    if (ctrl) { return; } // leave other ctrl/cmd combos to the browser

    switch (e.key) {
        case "v": case "V": case "s": case "S":
            editorSelectTool("select"); e.preventDefault(); return;
        case "e": case "E":
            editorSelectTool("eraser"); e.preventDefault(); return;
        case "b": case "B":
            editorSelectHazard("bumper"); e.preventDefault(); return;
        case "m": case "M":
            editorSelectHazard("movingBumper"); e.preventDefault(); return;
        case "r": case "R":
            editorRotateSelected(e.shiftKey ? -15 : 15); e.preventDefault(); return;
        case "Delete": case "Backspace":
            editorDeleteSelected(); e.preventDefault(); return;
        case "Escape":
            editorDeselect(); return; // modal Escape is handled separately in create.js
    }

    // Number row 1..8 → tile brushes, in the palette's visual order.
    var tileOrder = ["slow", "normal", "fast", "lava", "ice", "ability", "random", "goal"];
    var n = parseInt(e.key, 10);
    if (!isNaN(n) && n >= 1 && n <= tileOrder.length) {
        editorSelectTile(tileOrder[n - 1]);
        e.preventDefault();
    }
}

// --- map-list search ----------------------------------------------------------
// Filters the saved-map tiles in #loadWindow by name/author substring. The pinned
// "Create a new map / Continue editing" tile (#createNew's wrapper) is tagged
// data-keep so it always stays visible — the filter only ever hides library maps.
function installMapSearch() {
    var input = document.getElementById("mapSearch");
    if (input == null) { return; }
    input.addEventListener("input", applyMapSearch, false);
    var clear = document.getElementById("mapSearchClear");
    if (clear != null) {
        clear.addEventListener("click", function () {
            input.value = "";
            applyMapSearch();
            input.focus();
            return false;
        }, false);
    }
}

function applyMapSearch() {
    var input = document.getElementById("mapSearch");
    if (input == null) { return; }
    var q = (input.value || "").trim().toLowerCase();
    var tiles = document.querySelectorAll("#loadWindow .map-image");
    for (var i = 0; i < tiles.length; i++) {
        var tile = tiles[i];
        if (tile.getAttribute("data-keep") === "1") {
            continue; // never hide the New / Continue tile
        }
        var hay = (tile.getAttribute("data-search") || "").toLowerCase();
        tile.style.display = (q === "" || hay.indexOf(q) !== -1) ? "" : "none";
    }
}
