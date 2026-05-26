var server = null,
    config = null,
    myID,
    refreshInterval = null,
    firstResponseReceived = false;

var REFRESH_MS = 5000;

$(function () {
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

function renderRooms(rooms) {
    var container = document.getElementById('gameSelection');
    var empty = document.getElementById('emptyState');
    var loading = document.getElementById('loadingState');
    if (container == null) return;

    container.replaceChildren();
    if (loading != null) loading.hidden = true;

    var ids = Object.keys(rooms);
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

    // A full or already-started room is surfaced (so it doesn't silently
    // vanish) but can't be joined: grey the card and disable its button.
    var joinable = room.joinable !== false;
    var joinBtn = document.createElement('a');
    if (joinable) {
        joinBtn.href = './play.html?gameid=' + encodeURIComponent(room.gameID);
        joinBtn.className = 'btn btn-outline-info join-btn';
        joinBtn.textContent = 'Join';
    } else {
        // Not joinable: a started match reads "In progress"; a room that's merely
        // full (still in the lobby, not locked) reads "Full" — a slot may open up.
        card.classList.add('gameCard-locked');
        joinBtn.className = 'btn btn-outline-secondary join-btn disabled';
        joinBtn.setAttribute('aria-disabled', 'true');
        joinBtn.setAttribute('tabindex', '-1');
        joinBtn.textContent = room.locked ? 'In progress' : 'Full';
    }

    card.appendChild(info);
    card.appendChild(joinBtn);
    return card;
}

// The "AI" card stat, or null to omit it. Live bots win (a real race in progress);
// otherwise the lobby setting that applies next race: "Off" / "N next" / Auto(omit).
function aiStatLabel(room) {
    if (room.aiCount > 0) {
        return room.aiCount + (room.aiCount === 1 ? ' bot' : ' bots');
    }
    if (room.aiPlanned != null) {
        return room.aiPlanned <= 0 ? 'Off' : (room.aiPlanned + ' next');
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
