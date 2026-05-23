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

    return server;
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

    info.appendChild(buildStat('Round', room.round));
    info.appendChild(buildStat('Map', room.currentMap || 'Lobby'));
    info.appendChild(buildStat('Players', room.players + '/' + maxPlayers));

    var joinBtn = document.createElement('a');
    joinBtn.href = './play.html?gameid=' + encodeURIComponent(room.gameID);
    joinBtn.className = 'btn btn-outline-info join-btn';
    joinBtn.textContent = 'Join';

    card.appendChild(info);
    card.appendChild(joinBtn);
    return card;
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
