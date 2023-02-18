var server = null,
    config = null,
    myID;

$(function () {
    server = clientConnect();
})

function clientConnect() {
    var server = io();
    server.emit("getConfig");


    server.on('welcome', function (id) {
        myID = id;
    });

    server.on("config", function (c) {
        config = c;
        server.emit('getRooms');
    });

    server.on("roomListing", function (packet) {
        var rooms = JSON.parse(packet);
        console.log(rooms);
        for (var id in rooms) {
            var room = rooms[id];
            var state = room.state;
            for (var prop in config.stateMap) {
                if (room.state == config.stateMap[prop]) {
                    state = capitalizeFirstLetter(prop);
                }
            }
            var currentMap = room.currentMap;
            if (currentMap == undefined) {
                currentMap = "Lobby"
            }
            $("#gameSelection").append('<div class="gameCard justify-content-center align-self-center mx-auto"><form><div class="game-content"><div class="gameState"><span>' + state +
                '</span></div><table class="mapData"><tr><th>Round</th><th>Current Map</th><th>Game ID</th><th>Players</th></tr><tr>' +
                '<td>' + room.round + "</td>" +
                '<td>' + currentMap + "</td>" +
                '<td>' + room.gameID + "</td>" +
                '<td>' + room.players + "</td>" + '</tr></table></div>' +
                '<button type="submit" formaction="./play.html?gameid=' + room.gameID + '" class="btn btn-outline-info w-25 join-btn">Join</button>'
            );
        }
    });


    return server;

}
function capitalizeFirstLetter(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}