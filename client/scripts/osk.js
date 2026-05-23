// On-screen keyboard (wraps the simple-keyboard library) for controller text
// entry. Shared by the map editor and the join page.
//
// It has NO gamepad poll of its own: the active page poller (menuGamepad.js on
// join, editorGamepad.js in the editor) routes input here while oskIsOpen() is
// true — calling oskMoveFocus(dir) / oskActivateFocused() / oskClose(). This
// keeps a single pad reader per page. If the simple-keyboard CDN failed to
// load, oskOpen() falls back to just focusing the field (hardware keyboard).

var _osk = null;            // SimpleKeyboard instance (lazily created)
var _oskActiveInput = null; // the <input> currently being edited
var _oskFocusEl = null;     // the highlighted key (.hg-button)

function oskIsOpen() {
    var c = document.getElementById("oskContainer");
    return !!c && c.classList.contains("visible");
}

function _oskEnsure() {
    if (_osk) {
        return _osk;
    }
    var SK = window.SimpleKeyboard && (window.SimpleKeyboard.default || window.SimpleKeyboard);
    if (!SK) {
        return null; // library not loaded
    }
    var container = document.createElement("div");
    container.id = "oskContainer";
    container.className = "osk-container hidden";
    container.innerHTML = '<div class="osk-keyboard simple-keyboard"></div>';
    document.body.appendChild(container);

    _osk = new SK(".simple-keyboard", {
        onChange: function (input) {
            if (_oskActiveInput) {
                _oskActiveInput.value = input;
                _oskActiveInput.dispatchEvent(new Event("input", { bubbles: true }));
            }
        },
        onKeyPress: function (button) {
            if (button === "{shift}" || button === "{lock}") {
                var cur = _osk.options.layoutName;
                _osk.setOptions({ layoutName: cur === "default" ? "shift" : "default" });
            } else if (button === "{enter}") {
                oskClose();
            }
        }
    });
    return _osk;
}

function oskOpen(input) {
    var kb = _oskEnsure();
    if (!kb) {
        try { input.focus(); } catch (e) { /* ignore */ }
        return;
    }
    _oskActiveInput = input;
    kb.setInput(input.value || "");
    var c = document.getElementById("oskContainer");
    c.className = "osk-container visible";
    var btns = _oskButtons();
    _oskSetFocus(btns.length ? btns[0] : null);
}

function oskClose() {
    var c = document.getElementById("oskContainer");
    if (c) {
        c.className = "osk-container hidden";
    }
    if (_oskFocusEl) {
        _oskFocusEl.classList.remove("osk-focus");
        _oskFocusEl = null;
    }
    if (_oskActiveInput) {
        try { _oskActiveInput.blur(); } catch (e) { /* ignore */ }
    }
    _oskActiveInput = null;
}

function oskActivateFocused() {
    if (_oskFocusEl) {
        _oskFocusEl.click();
    }
}

function _oskButtons() {
    var c = document.getElementById("oskContainer");
    if (!c) {
        return [];
    }
    return Array.prototype.slice.call(c.querySelectorAll(".hg-button"));
}

function _oskSetFocus(el) {
    if (!el) {
        return;
    }
    if (_oskFocusEl) {
        _oskFocusEl.classList.remove("osk-focus");
    }
    _oskFocusEl = el;
    el.classList.add("osk-focus");
}

function _oskCenter(el) {
    var r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

// 2D spatial move: pick the nearest key in the requested direction, preferring
// alignment on the cross axis so a grid of keys feels natural.
function oskMoveFocus(dir) {
    var btns = _oskButtons();
    if (btns.length === 0) {
        return;
    }
    if (!_oskFocusEl) {
        _oskSetFocus(btns[0]);
        return;
    }
    var f = _oskCenter(_oskFocusEl);
    var best = null;
    var bestScore = Infinity;
    for (var i = 0; i < btns.length; i++) {
        if (btns[i] === _oskFocusEl) {
            continue;
        }
        var p = _oskCenter(btns[i]);
        var dx = p.x - f.x;
        var dy = p.y - f.y;
        var primary, secondary;
        if (dir === "right") { if (dx <= 2) { continue; } primary = dx; secondary = Math.abs(dy); }
        else if (dir === "left") { if (dx >= -2) { continue; } primary = -dx; secondary = Math.abs(dy); }
        else if (dir === "down") { if (dy <= 2) { continue; } primary = dy; secondary = Math.abs(dx); }
        else if (dir === "up") { if (dy >= -2) { continue; } primary = -dy; secondary = Math.abs(dx); }
        else { continue; }
        var score = primary + secondary * 2;
        if (score < bestScore) {
            bestScore = score;
            best = btns[i];
        }
    }
    if (best) {
        _oskSetFocus(best);
    }
}
