var utils = require('./utils.js');
var c = utils.loadConfig();
var messenger = require('./messenger.js');
var game = require('./game.js');

var roomList = {},
	maxPlayersInRoom = c.maxPlayersInRoom;

exports.findARoom = function(clientID){
    if(getRoomCount() == 0){
        console.log("No rooms exist; Starting a new room");
        return generateNewRoom();
    }
    for(var sig2 in roomList){
        if(roomList[sig2].hasSpace()){
            return sig2;
        }
    }
    return generateNewRoom();
}
exports.joinARoom = function(sig,clientID){
	roomList[sig].join(clientID);
	return roomList[sig];
}

function getRoomCount(){
	var count = 0;
	for(var sig in roomList){
		count++;
	}
	return count;
}

function generateRoomSig(){
	var sig = utils.getRandomInt(0,99);
	if(roomList[sig] == null || roomList[sig] == undefined){
		return sig;
	}
	sig = generateRoomSig();
}

function generateNewRoom(){
	var sig = generateRoomSig();
	roomList[sig] = game.getRoom(sig,maxPlayersInRoom);
	return sig;
}
    