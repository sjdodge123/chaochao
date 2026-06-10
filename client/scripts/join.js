var server = null,
    config = null,
    myID,
    refreshInterval = null,
    firstResponseReceived = false,
    // Signature of the last rendered room list. The list auto-refreshes every 5s;
    // rebuilding the cards wholesale (replaceChildren) destroys the <a> a player is
    // mid-tap on, so on touch the tap lands on a freshly-swapped element and never
    // navigates. Skip the rebuild when nothing visible actually changed.
    lastRoomsSig = null;

var REFRESH_MS = 5000;

document.addEventListener('DOMContentLoaded', function () {
    server = clientConnect();
    var refreshButton = document.getElementById('refreshButton');
    if (refreshButton != null) {
        refreshButton.addEventListener('click', function () {
            if (server != null) server.emit('getRooms');
        });
    }
    var params = new URLSearchParams(window.location.search);
    if (params.has('notfound')) {
        var banner = document.getElementById('notFoundBanner');
        if (banner != null) banner.hidden = false;
    }

    var joinByIdInput = document.getElementById('joinByIdInput');
    var joinByIdButton = document.getElementById('joinByIdButton');
    if (joinByIdInput != null && joinByIdButton != null) {
        var goJoinById = function () {
            var value = joinByIdInput.value.trim();
            if (value === '') return;
            window.location.href = './play.html?gameid=' + encodeURIComponent(value);
        };
        joinByIdButton.addEventListener('click', goJoinById);
        joinByIdInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); goJoinById(); }
        });
    }
});

function clientConnect() {
    var server = io();
    server.emit("getConfig");

    server.on('welcome', function (id) {
        myID = id;
    });

    server.on("config", function (c) {
        config = c;
        server.emit('getRooms');
        if (refreshInterval == null) {
            refreshInterval = setInterval(function () {
                server.emit('getRooms');
            }, REFRESH_MS);
        }
    });

    server.on("roomListing", function (packet) {
        firstResponseReceived = true;
        renderRooms(JSON.parse(packet));
    });

    // Stop polling on socket disconnect or page navigation so we don't
    // leak the timer or fire getRooms into a dead/buffering socket.
    server.on("disconnect", stopRefreshing);
    window.addEventListener("pagehide", stopRefreshing);

    return server;
}

function stopRefreshing() {
    if (refreshInterval != null) {
        clearInterval(refreshInterval);
        refreshInterval = null;
    }
}

// Everything buildCard() renders for a room, so an unchanged list re-renders to
// the identical signature and we can leave the live DOM (and any in-flight tap)
// untouched.
function roomsSignature(rooms) {
    var ids = Object.keys(rooms);
    var parts = [];
    for (var i = 0; i < ids.length; i++) {
        var r = rooms[ids[i]];
        parts.push([r.gameID, r.state, r.mode, r.round, r.currentMap, r.players,
            r.joinable, r.locked, r.aiCount, r.aiAuto, r.aiPlanned].join('|'));
    }
    return parts.join('||');
}

function renderRooms(rooms) {
    var container = document.getElementById('gameSelection');
    var empty = document.getElementById('emptyState');
    var loading = document.getElementById('loadingState');
    if (container == null) return;

    if (loading != null) loading.hidden = true;

    var ids = Object.keys(rooms);

    // Identical to what's already on screen -> don't touch the DOM, so a tap that
    // started on a Join button completes against the same element.
    var sig = roomsSignature(rooms);
    if (sig === lastRoomsSig && container.childElementCount === ids.length) {
        if (empty != null) empty.hidden = ids.length !== 0;
        return;
    }
    lastRoomsSig = sig;

    container.replaceChildren();
    if (ids.length === 0) {
        if (empty != null) empty.hidden = false;
        return;
    }
    if (empty != null) empty.hidden = true;

    var maxPlayers = (config && config.maxPlayersInRoom) || 25;
    for (var i = 0; i < ids.length; i++) {
        container.appendChild(buildCard(rooms[ids[i]], maxPlayers));
    }
}

function buildCard(room, maxPlayers) {
    var card = document.createElement('div');
    card.className = 'gameCard';

    var info = document.createElement('div');
    info.className = 'card-info';

    var state = document.createElement('span');
    state.className = 'card-state';
    state.textContent = stateLabel(room.state);
    info.appendChild(state);

    // Game-mode badge: ALWAYS shown (including Standard FFA) so what kind of game
    // a room is playing is never implicit. Brutal modes get the warning tint.
    var mode = document.createElement('span');
    var modeDef = gameModeDef(room.mode);
    mode.className = 'card-mode' + ((modeDef && modeDef.brutal) ? ' card-mode-brutal' : '');
    mode.textContent = modeDef ? modeDef.name : 'Standard FFA';
    info.appendChild(mode);

    info.appendChild(buildStat('Game ID', room.gameID));
    info.appendChild(buildStat('Round', room.round));
    info.appendChild(buildStat('Map', room.currentMap || 'Lobby'));
    info.appendChild(buildStat('Players', room.players + '/' + maxPlayers));
    // AI hub: show the bots a room has. Prefer the live count (mid-race); otherwise
    // fall back to the lobby AI-station setting that applies next race. Hidden when
    // there are none and the setting is Auto/unset, to keep cards uncluttered.
    var aiLabel = aiStatLabel(room);
    if (aiLabel != null) {
        info.appendChild(buildStat('AI', aiLabel));
    }

    // A room with space is joinable even mid-match. The label reflects what the
    // join actually does: only a LIVE race (racing/collapsing) makes you a
    // spectator for the round, so that reads "Spectate"; every other joinable
    // state (lobby, the gated countdown, the between-rounds overview, the
    // game-over screen) drops you straight in, so it reads "Join". (Keying off the
    // coarse `locked` flag would mislabel gated/overview/gameOver as "Spectate".)
    // Only a FULL room can't be joined — surfaced greyed so it doesn't vanish.
    var joinable = room.joinable !== false;
    var joinBtn = document.createElement('a');
    if (joinable) {
        joinBtn.href = './play.html?gameid=' + encodeURIComponent(room.gameID);
        joinBtn.className = 'btn btn-outline-info join-btn';
        joinBtn.setAttribute('data-gp-nav', ''); // joinable rooms only; full cards stay unfocusable
        if (isLiveRace(room)) {
            joinBtn.textContent = 'Spectate';
            joinBtn.title = 'Race in progress — watch this round, race the next.';
        } else {
            joinBtn.textContent = 'Join';
        }
    } else {
        // Not joinable means full: a slot may open up, so it's shown greyed rather
        // than hidden.
        card.classList.add('gameCard-locked');
        joinBtn.className = 'btn btn-outline-secondary join-btn disabled';
        joinBtn.setAttribute('aria-disabled', 'true');
        joinBtn.setAttribute('tabindex', '-1');
        joinBtn.textContent = 'Full';
    }

    card.appendChild(info);
    card.appendChild(joinBtn);
    return card;
}

// The "AI" card stat. Live bots win (a real race in progress); otherwise the lobby
// setting that applies next race: "N (auto)" when auto-filling toward the target,
// "N next" for an explicit count, or "Off" when bots are explicitly turned off.
function aiStatLabel(room) {
    if (room.aiCount > 0) {
        return room.aiCount + (room.aiCount === 1 ? ' bot' : ' bots');
    }
    if (room.aiAuto) {
        // Auto mode: show the count it'll fill, or "Auto" when the lobby is already
        // at/over the target (0 bots now) — NOT "Off", since bots return automatically
        // as humans leave (distinct from an explicit Off override below).
        return (room.aiPlanned > 0) ? (room.aiPlanned + ' (auto)') : 'Auto';
    }
    if (room.aiPlanned != null) {
        return room.aiPlanned <= 0 ? 'Off' : (room.aiPlanned + ' next');
    }
    return null;
}

// The configured definition for a room's mode id (config.gameModes rides the
// `config` payload). Unknown/absent ids (older server, default rooms) read as
// Standard FFA via the caller's fallback.
function gameModeDef(id) {
    var defs = (config && Array.isArray(config.gameModes)) ? config.gameModes : [];
    for (var i = 0; i < defs.length; i++) {
        if (defs[i] && defs[i].id === id) { return defs[i]; }
    }
    return null;
}

function buildStat(label, value) {
    var span = document.createElement('span');
    span.className = 'card-stat';
    var labelEl = document.createElement('span');
    labelEl.className = 'card-stat-label';
    labelEl.textContent = label + ': ';
    var valueEl = document.createElement('span');
    valueEl.className = 'card-stat-value';
    valueEl.textContent = String(value);
    span.appendChild(labelEl);
    span.appendChild(valueEl);
    return span;
}

// True when joining the room right now would drop you into a LIVE race as a
// spectator-until-next-round (server determineGameState's racing/collapsing
// branch). Other locked states (gated/overview/gameOver) put you straight into
// play, so they aren't "spectating". Falls back to false until config arrives.
function isLiveRace(room) {
    if (config == null || config.stateMap == null) {
        return false;
    }
    return room.state === config.stateMap.racing ||
        room.state === config.stateMap.collapsing;
}

function stateLabel(state) {
    if (config != null && config.stateMap != null) {
        for (var prop in config.stateMap) {
            if (state === config.stateMap[prop]) {
                return capitalizeFirstLetter(prop);
            }
        }
    }
    return String(state);
}

function capitalizeFirstLetter(string) {
    var s = String(string);
    return s.charAt(0).toUpperCase() + s.slice(1);
}
