'use strict';
var utils = require('./utils.js');
var c = utils.loadConfig();
var messenger = require('./messenger.js');
var _engine = require('./engine.js');
var compressor = require('./compressor.js');

exports.getRoom = function(sig,size){
	return new Room(sig,size);
}

class Room {
    constructor(sig,size){
        this.sig = sig;
        this.size = size;
        this.clientList = {};
        this.playerList = {};
        this.clientCount = 0;
        this.alive = true;
		this.engine = _engine.getEngine(this.playerList);
        this.world = new World(0,0,c.worldWidth,c.worldHeight,this.engine,this.playerList,this.sig);
        this.game = new Game(this.clientList,this.playerList,this.world,this.engine,this.sig);
    }
    join(clientID){
        var client = messenger.getClient(clientID);
        messenger.addRoomToMailBox(clientID,this.sig);
        client.join(String(this.sig));
        this.clientCount++;
    }
    leave(clientID){
        messenger.messageRoomBySig(this.sig,'playerLeft',clientID);
        messenger.removeRoomMailBox(clientID);
		var client = messenger.getClient(clientID);
		client.leave(String(this.sig));
		delete this.clientList[clientID];
		delete this.playerList[clientID];
		this.clientCount--;
    }
    update(dt){
		this.checkAFK();
		this.game.update(dt);
		this.sendUpdates();
	}
    sendUpdates(){
		var playerData = compressor.sendPlayerUpdates(this.playerList);
		var gameStateData = compressor.gameState(this.game);
		messenger.messageRoomBySig(this.sig,"gameUpdates",{
			playerList:playerData,
			state:gameStateData,
			totalPlayers:messenger.getTotalPlayers()
			//shrinkTimeLeft:this.game.timeLeftUntilShrink
		});
	}
    checkRoom(clientID){
		for(var id in this.clientList){
			if(id == clientID){
				return true;
			}
		}
		return false;
	}
	checkAFK(){
		for(var id in this.playerList){
			if(this.playerList[id].kick){
				console.log("Kicking " + id);
				messenger.messageClientBySig(id,"serverKick",null);
				this.leave(id);
			}
		}
	}
    hasSpace(){
		if(this.clientCount < this.size){
			if(!this.game.locked){
				return true;
			}
		}
		return false;
	}
}

class Game {
    constructor(clientList,playerList,world,engine,roomSig){
        this.clientList = clientList;
        this.playerList = playerList;
        this.roomSig = roomSig 
        this.world = world;
		this.engine = engine;
        this.gameEnded = false;
        this.locked = false;

		//Game stats
		this.playerCount = 0;
		this.lobbyButtonPressedCount = 0;
		this.firstPlaceSig = null;
		this.secondPlaceSig = null;

		//Timers
		this.lobbyWaitTime = c.lobbyWaitTime;
		this.lobbyTimer = null;
		this.lobbyTimeLeft = this.lobbyWaitTime;

		this.gatedWaitTime = c.gatedWaitTime;
		this.gatedTimer = null;
		this.gatedTimeLeft = this.gatedWaitTime;

		this.newRaceWaitTime = c.newRaceWaitTime;
		this.newRaceTimer = null;
		this.newRaceTimeLeft = this.newRaceWaitTime;

		this.gameOverWaitTime = c.gameOverTime;
		this.gameOverTimer = null;
		this.gameOverTimeLeft = this.gameOverWaitTime;

		//State mgmt
		this.stateMap = c.stateMap;
		this.currentState = this.stateMap.waiting;
		this.gameBoard = new GameBoard(world,playerList,engine,roomSig);
    }

	update(dt){
		this.getPlayerCount();
		//In Waiting State
		if(this.currentState == this.stateMap.waiting){
			this.checkLobbyStart();
		}
		//In Lobby State
		if(this.currentState == this.stateMap.lobby){
			this.checkGatedStart();
		}
		//In Gated State
		if(this.currentState == this.stateMap.gated){
			this.checkRacingStart();
		}
		//In Racing State or Collapse State
		if(this.currentState == this.stateMap.racing || this.currentState == this.stateMap.collapsing){
			this.checkForWinners();
		}		
		//In Overview State
		if(this.currentState == this.stateMap.overview){
			this.checkNewRaceTimer();
		}
		
		//In Gameover state
		if(this.currentState == this.stateMap.gameOver){
			this.checkGameOverTimer();
		}
		this.gameBoard.update(this.currentState,dt);
		this.world.update(dt);
	}
	checkLobbyStart(){
		if(this.playerCount >= c.minPlayersToStart){
			this.startLobby();
		}
	}
	checkGatedStart(){
		//Reset back to waiting if someone leaves
		if(this.playerCount < c.minPlayersToStart){
			this.startWaiting();
		}
		//If majority of players stand on the gamestart button start the timer
		var percentPlayers = (this.lobbyButtonPressedCount/this.playerCount) * 100;
		if(percentPlayers > 50){
			this.startLobbyTimer();
			return;
		}
		this.resetLobbyTimer();
	}
	checkRacingStart(){
		if(this.gatedTimer != null){
			this.gatedTimeLeft = ((this.gatedWaitTime*1000 - (Date.now() - this.gatedTimer))/(1000)).toFixed(1);
			if(this.gatedTimeLeft > 0){
				return;
			}
			this.resetGatedTimer();
			this.startRace();
			return;
		}
		this.gatedTimer = Date.now();
	}
	checkNewRaceTimer(){
		if(this.newRaceTimer != null){
			this.newRaceTimeLeft = ((this.newRaceWaitTime*1000 - (Date.now() - this.newRaceTimer))/(1000)).toFixed(1);
			if(this.newRaceTimeLeft > 0){
				return;
			}
			this.newRaceTimer = null;
			this.startGated();
			return;
		}
		this.newRaceTimer = Date.now();
	}
	checkGameOverTimer(){
		if(this.gameOverTimer != null){
			this.gameOverTimeLeft = ((this.gameOverWaitTime*1000 - (Date.now() - this.gameOverTimer))/(1000)).toFixed(1);
			if(this.gameOverTimeLeft > 0){
				return;
			}
			this.gameOverTimer = null;
			this.resetGame();
			this.startWaiting();
			return;
		}
		this.gameOverTimer = Date.now();
	}
	startLobbyTimer(){
		if(this.lobbyTimer != null){
			this.lobbyTimeLeft = ((this.lobbyWaitTime*1000 - (Date.now() - this.lobbyTimer))/(1000)).toFixed(1);
			if(this.lobbyTimeLeft > 0){
				return;
			}
			this.resetLobbyTimer();
			this.startGated();
			return;
		}
		this.lobbyTimer = Date.now();
	}
	checkForWinners(){
		var playersConcluded = 0;

		for(var player in this.playerList){
			if(!this.playerList[player].alive && !this.playerList[player].reachedGoal){
				playersConcluded++;
				continue;
			}
			if(this.playerList[player].reachedGoal == true){
				playersConcluded++;
				if(this.firstPlaceSig == null){
					if(this.playerList[player].notches == c.playerNotchesToWin){
						//Game over player wins
						this.gameOver(player);
						return;
					}
					this.firstPlaceSig = player;
					this.playerList[player].addNotch();
					this.playerList[player].addNotch();
					this.startCollapse(this.playerList[player].x,this.playerList[player].y);
					messenger.messageRoomBySig(this.roomSig,"firstPlaceWinner",player);
					continue;
				}
				if(this.secondPlaceSig == null && player != this.firstPlaceSig){
					this.secondPlaceSig = player;
					messenger.messageRoomBySig(this.roomSig,"secondPlaceWinner",player);
					this.playerList[player].addNotch();
					continue;
				}
			}
		}
		if(playersConcluded == this.playerCount){
			this.startOverview();
		}
	}
	startWaiting(){
		console.log("Start Waiting");
		messenger.messageRoomBySig(this.roomSig,"startWaiting",null);
		this.currentState = this.stateMap.waiting;
	}
	startLobby(){
		console.log("Start Lobby")
		this.currentState = this.stateMap.lobby;
		this.world.resize();
		this.gameBoard.startLobby();
	}
	startGated(){
		console.log("Start Gated");
		this.locked = true;
		this.resetForRace();
		this.gameBoard.setupMap();
		this.currentState = this.stateMap.gated;
		messenger.messageRoomBySig(this.roomSig,"startGated",null);
	}
	startRace(){
		console.log("Start Race");
		this.currentState = this.stateMap.racing;
		messenger.messageRoomBySig(this.roomSig,"startRace",null);
	}
	startOverview(){
		console.log("Start Overview");
		this.currentState = this.stateMap.overview;
		messenger.messageRoomBySig(this.roomSig,'startOverview',compressor.sendNotchUpdates(this.playerList));
	}
	startCollapse(xloc,yloc){
		console.log("Start Collapse");
		this.currentState = this.stateMap.collapsing;
		this.gameBoard.startCollapse({x:xloc,y:yloc});
		messenger.messageRoomBySig(this.roomSig,"startCollapse",null);
	}
	resetLobbyTimer(){
		this.lobbyTimer = null;
	}
	resetGatedTimer(){
		this.gatedTimer = null;
	}
	resetForRace(){
		this.firstPlaceSig = null;
		this.secondPlaceSig = null;
	}
	resetGame(){
		this.locked = false;
		this.gameBoard.resetGame();
		messenger.messageRoomBySig(this.roomSig,"resetGame",null);
	}
	getPlayerCount(){
		var playerCount = 0;
		var lobbyButtonPressedCount = 0;
		for(var playerID in this.playerList){
			if(this.playerList[playerID].hittingLobbyButton){
				this.playerList[playerID].hittingLobbyButton = false;
				lobbyButtonPressedCount++;
			}
			playerCount++;
		}
		this.lobbyButtonPressedCount = lobbyButtonPressedCount;
		this.playerCount = playerCount;
		return playerCount;
	}
	gameOver(player){
		console.log("Game Over");
		this.currentState = this.stateMap.gameOver;
		messenger.messageRoomBySig(this.roomSig,'startGameover',player);
	}
}

class GameBoard {
	constructor(world,playerList,engine,roomSig){
		this.world = world;
		this.playerList = playerList;
		this.punchList = {};
		this.engine = engine;
		this.roomSig = roomSig;
		this.stateMap = c.stateMap;
		this.lobbyStartButton;
		this.startingGate = null;
		this.maps = utils.loadMaps();
		this.mapsPlayed = [];
		this.currentMap = {};
		this.collapseLoc = {};
		this.collapseLine = this.world.height;
	}
	update(currentState,dt){
		this.engine.update(dt);
		this.collapseMap(currentState);
		this.checkCollisions(currentState);
		this.updatePlayers(currentState,dt);
	}
	checkCollisions(currentState){
		var objectArray = [];
		if(currentState == this.stateMap.waiting){
			for(var player in this.playerList){
				_engine.preventEscape(this.playerList[player],this.world);
			}
			return;
		}
		if(currentState == this.stateMap.lobby){
			for(var player in this.playerList){
				if(!this.playerList[player].alive){
					continue;
				}
				_engine.preventEscape(this.playerList[player],this.world);
				objectArray.push(this.playerList[player]);
			}
			for(var punchId in this.punchList){
				objectArray.push(this.punchList[punchId]);
			}
			objectArray.push(this.lobbyStartButton);
		}
		if(currentState == this.stateMap.gated){
			for(var player in this.playerList){
				if(!this.playerList[player].alive){
					continue;
				}
				_engine.preventEscape(this.playerList[player],this.world);
				_engine.preventEscape(this.playerList[player],this.startingGate);
				objectArray.push(this.playerList[player]);
			}
			for(var punchId in this.punchList){
				objectArray.push(this.punchList[punchId]);
			}
		}
		if(currentState == this.stateMap.racing || currentState == this.stateMap.collapsing){
			for(var player in this.playerList){
				if(!this.playerList[player].alive){
					continue;
				}
				if(currentState == this.stateMap.collapsing){
					objectArray.push(this.startingGate);
				}
				_engine.preventEscape(this.playerList[player],this.world);
				_engine.checkCollideCells(this.playerList[player],this.currentMap);
				objectArray.push(this.playerList[player]);
			}
			for(var punchId in this.punchList){
				objectArray.push(this.punchList[punchId]);
			}
		}
		
		this.engine.broadBase(objectArray);
	}
	updatePlayers(active,dt){
		for(var playerID in this.playerList){
			var player = this.playerList[playerID];
			player.update(dt);
			if(player.punch != null){
				this.punchList[player.id] = player.punch;
				setTimeout(this.terminatePunch,100,{id:player.id,punchList:this.punchList,roomSig:this.roomSig});
				player.punch = null;
			}
		}
	}
	terminatePunch(packet){
		if(packet.punchList[packet.id] != undefined){
			messenger.messageRoomBySig(packet.roomSig,"terminatePunch",packet.id);
			delete packet.punchList[packet.id];
		}
		
	}
	startLobby(){
		this.lobbyStartButton = new LobbyStartButton(this.world.center.x,this.world.center.y,0,"red");
		messenger.messageRoomBySig(this.roomSig,"startLobby",compressor.sendLobbyStart(this.lobbyStartButton));
	}
	setupMap(){
		this.clean();
		this.resetPlayers();
		this.loadNextMap();
		this.startingGate = new Gate(0,0,75,this.world.height);
		this.gatePlayers();
	}
	startCollapse(loc){
		this.collapseLoc = loc;
	}
	collapseMap(currentState){
		if(currentState != c.stateMap.collapsing){
			return;
		}
		this.collapseLine -= c.worldCollapseSpeed;
		var collapsedCells = [];
		var cells = this.currentMap.cells;
		for(var i=0;i<cells.length;i++){
			if(cells[i].id == 6 || cells[i].id == 3){
				continue;
			}
			var distance = utils.getMag(this.collapseLoc.x - cells[i].site.x, this.collapseLoc.y - cells[i].site.y);
			if(this.collapseLine < distance){
				cells[i].id = 3;
				collapsedCells.push(cells[i].site.voronoiId);	
			}
		}
		messenger.messageRoomBySig(this.roomSig,'collapsedCells',collapsedCells);
	}
	resetGame(){
		this.mapsPlayed = [];
		this.resetPlayers();
		for(var playerID in this.playerList){
			var player = this.playerList[playerID];
			player.notches = 0;
		}
	}
	gatePlayers(){
		for(var playerID in this.playerList){
			var player = this.playerList[playerID];
			var loc = this.startingGate.findFreeLoc(player);
			player.x = loc.x;
			player.y = loc.y;
		}
	}
	resetPlayers(){
		messenger.messageRoomBySig(this.roomSig,"resetPlayers",null);
		for(var playerID in this.playerList){
			var player = this.playerList[playerID];
			player.reset();
		}
	}
	clean(){
		this.lobbyStartButton = null;
		this.collapseLoc = {};
		this.collapseLine = this.world.height;
	}
	loadNextMap(){
		this.currentMap = {};

		//Specify a particular map for testing
		//this.currentMap = JSON.parse(JSON.stringify(this.maps[0]));
		
		//Cycle in order of file order
		/*
		for(var i=0;i<this.maps.length;i++){
			if(this.currentMap != this.maps[i]){
				this.currentMap = JSON.parse(JSON.stringify(this.maps[i]));
			}
		}
		*/
		
		if(this.maps.length == this.mapsPlayed.length){
			this.mapsPlayed = [];
		}
		var nextMapId = this.getRandomMapR();
		this.currentMap = JSON.parse(JSON.stringify(this.maps[nextMapId]));
		this.mapsPlayed.push(this.currentMap.id);

		messenger.messageRoomBySig(this.roomSig,"newMap",this.currentMap.id);
		
	}
	getRandomMapR(){
		var randomIndex = utils.getRandomInt(0,this.maps.length-1);
		var nextMap = this.maps[randomIndex];
		for(var i=0;i<this.mapsPlayed.length;i++){
			if(nextMap.id == this.mapsPlayed[i]){
				return this.getRandomMapR();
			}
		}
		return randomIndex;
	}
}

class Shape {
	constructor(x,y,color){
		this.x = x;
		this.y = y;
		this.color = color;
	}
	inBounds(shape){
		if(shape.radius){
			return this.testCircle(shape);
		}
		if(shape.width){
			return this.testRect(shape);
		}
		return false;
	}
}

class Rect extends Shape{
	constructor(x,y,width,height, angle, color){
		super(x,y,color);
		this.width = width;
		this.height = height;
		this.angle = angle;
		this.vertices = this.getVertices();
	}
	getVertices(){
		var vertices = [];
		var a = {x:this.x, y: this.y},
	        b = {x:this.width, y: this.y},
	        c = {x:this.width, y: this.height},
	        d = {x:this.x, y: this.height};
			
		vertices.push(a, b, c, d);
		return vertices;
	}
	pointInRect(objX, objY){
	    var a = this.areaTriangle(this.vertices[0].x,this.vertices[0].y,this.vertices[1].x,this.vertices[1].y,this.vertices[2].x,this.vertices[2].y) +
				this.areaTriangle(this.vertices[0].x,this.vertices[0].y,this.vertices[3].x,this.vertices[3].y,this.vertices[2].x,this.vertices[2].y);			
		var a1 = this.areaTriangle(objX,objY,this.vertices[0].x,this.vertices[0].y,this.vertices[1].x,this.vertices[1].y);
		var a2 = this.areaTriangle(objX,objY,this.vertices[1].x,this.vertices[1].y,this.vertices[2].x,this.vertices[2].y);
		var a3 = this.areaTriangle(objX,objY,this.vertices[2].x,this.vertices[2].y,this.vertices[3].x,this.vertices[3].y);
		var a4 = this.areaTriangle(objX,objY,this.vertices[0].x,this.vertices[0].y,this.vertices[3].x,this.vertices[3].y);
		return (a == a1+a2+a3+a4);
	}

	areaTriangle(x1,y1,x2,y2,x3,y3){
		return Math.abs((x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2)) / 2.0);
	}

	getExtents(){
		var minX = this.vertices[0].x,
		maxX = minX,
		minY = this.vertices[0].y,
		maxY = minY;
		for (var i = 0; i < this.vertices.length-1; i++){
			var vert = this.vertices[i];
			minX = (vert.x < minX) ? vert.x : minX;
			maxX = (vert.x > maxX) ? vert.x : maxX;
			minY = (vert.y < minY) ? vert.y : minY;
			maxY = (vert.y > maxY) ? vert.y : maxY;
		}
		return {minX, maxX, minY, maxY};
	}
	testRect(rect){
		for (var i = 0; i < this.vertices.length; i++){
	        if(rect.pointInRect(this.vertices[i].x,this.vertices[i].y)){
	            return true;
	        }
	    }
	    for (var i = 0; i < rect.vertices.length; i++){
	        if(this.pointInRect(rect.vertices[i].x,rect.vertices[i].y)){
	            return true;
	        }
	    }
        return false;
	}
	testCircle(circle){
		return circle.testRect(this);
	}
	getRandomLoc(){
		return {x:Math.floor(Math.random()*(this.width - this.x)) + this.x, y:Math.floor(Math.random()*(this.height - this.y)) + this.y};
	}
	findFreeLoc(obj){
		var loc = this.getSafeLoc(obj.width || obj.radius);
		return loc;
	}
    getSafeLoc(size){
		var objW = size + 5 + c.playerBaseRadius * 2;
		var objH = size + 5 + c.playerBaseRadius * 2;
		return {x:Math.floor(Math.random()*(this.width - 2*objW - this.x)) + this.x + objW, y:Math.floor(Math.random()*(this.height - 2*objH - this.y)) + this.y + objH, width: objW};
	}
}

class Gate extends Rect {
	constructor (x,y,width,height) {
		super(x,y,width,height,0,"grey");
		this.isGate = true;
	}
	handleHit(){

	}
}

class World extends Rect{
    constructor(x,y,width,height,engine,playerList,roomSig){
        super(x,y,width,height, 0, "white");
		this.engine = engine;
		this.playerList = playerList;
        this.roomSig = roomSig;
		this.center = {x:width/2,y:height/2};
    }
    update(dt){
		
	}
    spawnNewPlayer(id){
		var color = this.getUniqueColorR();
        var player = new Player(0,0, 90, color, id,this.roomSig);
		var loc = this.findFreeLoc(player);
		player.initialLoc = loc;
		player.x = loc.x;
		player.y = loc.y;
		return player;
    }
	getUniqueColorR(){
		var color = utils.getColor();
		for(var player in this.playerList){
			if(this.playerList[player].color ==  color){
				return this.getUniqueColorR();
			}
		}
		return color;
	}
	resize(){
		this.width = c.worldWidth;
		this.height = c.worldHeight;
		this.baseBoundRadius = this.width;
		this.center = {x:this.width/2,y:this.height/2};
		this.engine.setWorldBounds(this.width,this.height);
		var data = compressor.worldResize(this);
		messenger.messageRoomBySig(this.roomSig,'worldResize',data);
	}
}

class Circle extends Shape{
	constructor(x,y,radius,color){
		super(x,y,color);
		this.radius = radius;
	}
	getExtents(){
		return {minX: this.x - this.radius, maxX: this.x + this.radius, minY: this.y - this.radius, maxY: this.y + this.radius};
	}

	testCircle(circle){
		var objX1,objY1,objX2,objY2,distance;
		objX1 = this.newX || this.x;
		objY1 = this.newY || this.y;
		objX2 = circle.newX || circle.x;
		objY2 = circle.newY || circle.y;
		distance = utils.getMag(objX2 - objX1,objY2 - objY1);
	  	distance -= this.radius;
		distance -= circle.radius;
		if(distance <= 0){
			return true;
		}
		return false;
	}

	testRect(rect){
		if(this.lineIntersectCircle({x:rect.x, y:rect.y}, {x:rect.newX, y:rect.newY})){
			return true;
		}
		if(rect.pointInRect(this.x, this.y)){
			return true;
		}

		if(this.lineIntersectCircle(rect.vertices[0], rect.vertices[1]) ||
	       this.lineIntersectCircle(rect.vertices[1], rect.vertices[2]) ||
	       this.lineIntersectCircle(rect.vertices[2], rect.vertices[3]) ||
	       this.lineIntersectCircle(rect.vertices[3], rect.vertices[0])){
	        return true;
	    }

		for (var i = 0; i < rect.vertices.length; i++){
	        var distsq = utils.getMagSq(this.x, this.y, rect.vertices[i].x, rect.vertices[i].y);
	        if (distsq < Math.pow(this.radius, 2)){
	            return true;
	        }
	    }
		return false;
	}
	lineIntersectCircle(a, b){
	    var ap, ab, dirAB, magAB, projMag, perp, perpMag;
	    ap = {x: this.x - a.x, y: this.y - a.y};
	    ab = {x: b.x - a.x, y: b.y - a.y};
	    magAB = Math.sqrt(utils.dotProduct(ab,ab));
	    dirAB = {x: ab.x/magAB, y: ab.y/magAB};

	    projMag = utils.dotProduct(ap, dirAB);

	    perp = {x: ap.x - projMag*dirAB.x, y: ap.y - projMag*dirAB.y};
	    perpMag = Math.sqrt(utils.dotProduct(perp, perp));
	    if ((0 < perpMag) && (perpMag < this.radius) && (0 <  projMag) && (projMag < magAB)){
	        return true;
	    }
	    return false;
	}


	getRandomCircleLoc(minR,maxR){
		var r = Math.floor(Math.random()*(maxR - minR));
		var angle = Math.floor(Math.random()*(Math.PI*2 - 0));
		return {x:r*Math.cos(angle)+this.x,y:r*Math.sin(angle)+this.y};
	}
}

class LobbyStartButton extends Circle{
	constructor(x,y,angle,color){
		super(x,y,75,color);
		this.isLobbyStart = true;
	}
	handleHit(object){
		
	}
}

class Player extends Circle {
    constructor(x,y,angle,color,id,roomSig){
        super(x,y,c.playerBaseRadius,color);
		this.enabled = true;
		this.alive = true;
        this.color = color;
        this.id = id;
        this.roomSig = roomSig;

		//Sleep Variables
		this.awake = true;
		this.kick = false;
		this.sleepWaitTime = c.playerStartSleepTime;
		this.sleepTimer = null;
		this.sleepTimeLeft = this.sleepWaitTime;

		this.kickWaitTime = c.playerAFKKickTime;
		this.kickTimer = null;
		this.kickTimeLeft = this.kickWaitTime;

		//Game Variables
		this.hittingLobbyButton = false;
		this.reachedGoal = false;
		this.timeReached = null;
		this.notches = 0;

		//Movement
		this.moveForward = false;
		this.moveBackward = false;
		this.turnLeft = false;
		this.turnRight = false;
		this.attack = false;
		this.punch = null;

		//Engine Variables
		this.newX = this.x;
		this.newY = this.y;
		this.velX = 0;
		this.velY = 0;
		this.dragCoeff = c.playerDragCoeff;
		this.brakeCoeff = c.playerBrakeCoeff;
		this.maxVelocity = c.playerMaxSpeed;
		this.acel = c.playerBaseAcel;
		
		this.currentSpeedBonus = 0;
    }
	update(dt){
		this.checkForSleep();
		if(!this.alive){
			return;
		}
		this.dt = dt;
		this.move();
		if(this.attack){
			this.punch = new Punch(this.x,this.y,c.punchRadius,this.color,this.id,this.roomSig);
			messenger.messageRoomBySig(this.roomSig,"punch",compressor.sendPunch(this.punch));
		}
	}
	move(){
		this.x = this.newX;
		this.y = this.newY;
	}
	getSpeedBonus(){
		return this.currentSpeedBonus;
	}
	wakeUp(){
		this.sleepTimer = null;
		this.kickTimer = null;
		if(this.awake == false){
			this.awake = true;
			messenger.messageRoomBySig(this.roomSig,"playerAwake",this.id);
		}
	}
	checkForSleep(){
		if(this.sleepTimer != null){
			this.sleepTimeLeft = ((this.sleepWaitTime*1000 - (Date.now() - this.sleepTimer))/(1000)).toFixed(1);
			if(this.sleepTimeLeft > 0){
				return;
			}
			this.checkAFK();
			return;
		}
		this.sleepTimer = Date.now();
	}
	checkAFK(){
		if(this.awake == true){
			this.awake = false;
			messenger.messageRoomBySig(this.roomSig,"playerSleeping",this.id);
		}
		if(this.kickTimer != null){
			this.kickTimeLeft = ((this.kickWaitTime*1000 - (Date.now() - this.kickTimer))/(1000)).toFixed(1);
			if(this.kickTimeLeft > 0){
				return;
			}
			this.kick = true;
			return;
		}
		this.kickTimer = Date.now();
		
	}
	handleHit(object){
		/*
		if(object.isWall){
			messenger.messageUser(this.id,"collideWithObject");
			_engine.preventMovement(this,object,this.dt);
		}
		*/
		if(object.isLobbyStart){
			this.hittingLobbyButton = true;
			return;
		}
		if(object.isPunch && object.ownerId != this.id){
			_engine.punchPlayer(this,object);
			return;
		}
		if(object.isGate){
			this.killPlayer();
			return;
		}
		if(object.isMapCell){
			//Slow
			if(object.id == 0){
				this.acel = object.acel;
				this.dragCoeff = object.dragCoeff;
				this.brakeCoeff = object.brakeCoeff;
			}
			//Normal
			if(object.id == 1){
				this.acel = object.acel;
				this.brakeCoeff = object.brakeCoeff;
				this.dragCoeff = object.dragCoeff;
			}
			//Fast
			if(object.id == 2){
				this.acel = object.acel;
				this.dragCoeff = object.dragCoeff;
				this.brakeCoeff = object.brakeCoeff;
			}
			//Lava
			if(object.id == 3){
				this.killPlayer();
				return;
			}
			//Ice
			if(object.id == 4){
				this.acel = object.acel;
				this.brakeCoeff = object.brakeCoeff;
				this.dragCoeff = object.dragCoeff;
			}

			//Goal
			if(object.id == 6){
				this.alive = false;
				this.reachedGoal = true;
				this.timeReached = Date.now();
				messenger.messageRoomBySig(this.roomSig,"playerConcluded",this.id);
				return;
			}
			
		}
	}
	addNotch(){
		if(this.notches+1 >= c.playerNotchesToWin){
			this.notches = c.playerNotchesToWin;
			return;
		}
		this.notches += 1;
	}
	killPlayer(){
		this.alive = false;
		if(this.notches > 0){
			this.notches -= 1;
		}
		messenger.messageRoomBySig(this.roomSig,"playerDied",this.id);
	}
	reset(){
		this.alive = true;
		this.enabled = true;
		this.x = this.initialLoc.x;
		this.y = this.initialLoc.y;
		this.newX = this.x;
		this.newY = this.y;
		this.velX = 0;
		this.velY = 0;
		this.dragCoeff = c.playerDragCoeff;
		this.brakeCoeff = c.playerBrakeCoeff;
		this.maxVelocity = c.playerMaxSpeed;
		this.acel = c.playerBaseAcel;
		this.moveForward = false;
		this.moveBackward = false;
		this.turnLeft = false;
		this.turnRight = false;
		this.attack = false;
		this.reachedGoal = false;
		this.timeReached = null;
		this.punch = null;
	}
}

class Punch extends Circle{
	constructor(x,y,radius,color,ownerId,roomSig){
		super(x,y,radius,color);
		this.ownerId = ownerId;
		this.roomSig = roomSig;
		this.isPunch = true;
	}
	handleHit(object){

	}
}


