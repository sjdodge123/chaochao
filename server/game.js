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
        this.world = new World(0,0,c.worldWidth,c.worldHeight,this.engine,this.sig);
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
        var client = messenger.getClient(clientID);
		client.leave(String(this.sig));
        messenger.removeRoomMailBox(clientID);
		delete this.clientList[clientID];
		delete this.playerList[clientID];
		this.clientCount--;
    }
    update(dt){
		this.game.update(dt);
		//this.checkForDeaths();
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

		//Timers
		this.lobbyWaitTime = c.lobbyWaitTime;
		this.lobbyTimer = null;
		this.lobbyTimeLeft = this.lobbyWaitTime;

		this.gatedWaitTime = c.gatedWaitTime;
		this.gatedTimer = null;
		this.gatedTimeLeft = this.gatedWaitTime;

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
		//In Racing State
		if(this.currentState == this.stateMap.racing){
			//console.log("go go speed racer");
		}
		//In Overview State
		if(this.currentState == this.stateMap.overview){
			console.log("In overview");
			//this.checkOverviewTimer();
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
	startWaiting(){
		console.log("Start Waiting");
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
		this.gameBoard.setupMap();
		this.currentState = this.stateMap.gated;
	}
	startRace(){
		console.log("Start race");
		this.currentState = this.stateMap.racing;
	}
	startOverview(){
		console.log("Start Overview");
		this.currentState = this.stateMap.overview;
		messenger.messageRoomBySig(this.roomSig,'startOverview',null);
		this.world.resize();
		//this.gameBoard.populateWorld();
		
		//this.checkForAISpawn();
		//this.randomLocShips();
	}
	resetLobbyTimer(){
		this.lobbyTimer = null;
	}
	resetGatedTimer(){
		this.gatedTimer = null;
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
}

class GameBoard {
	constructor(world,playerList,engine,roomSig){
		this.world = world;
		this.playerList = playerList;
		this.engine = engine;
		this.roomSig = roomSig;
		this.stateMap = c.stateMap;
		this.lobbyStartButton;
		this.startingGate = null;
		this.maps = utils.loadMaps();
		this.currentMap = null;
	}
	update(currentState,dt){
		this.engine.update(dt);
		this.checkCollisions(currentState);
		this.updatePlayers(currentState,dt);
	}
	checkCollisions(currentState){
		var objectArray = [];
		if(currentState == this.stateMap.waiting){
			for(var player in this.playerList){
				_engine.preventEscape(this.playerList[player],this.world);
			}
		}
		if(currentState == this.stateMap.lobby){
			for(var player in this.playerList){
				_engine.preventEscape(this.playerList[player],this.world);
				objectArray.push(this.playerList[player]);
			}
			objectArray.push(this.lobbyStartButton);
		}
		if(currentState == this.stateMap.gated){
			for(var player in this.playerList){
				_engine.preventEscape(this.playerList[player],this.world);
				_engine.preventEscape(this.playerList[player],this.startingGate);
				objectArray.push(this.playerList[player]);
			}
		}
		if(currentState == this.stateMap.racing){
			for(var player in this.playerList){
				_engine.preventEscape(this.playerList[player],this.world);
				objectArray.push(this.playerList[player]);
			}
		}
		this.engine.broadBase(objectArray);
	}
	updatePlayers(active,dt){
		for(var playerID in this.playerList){
			var player = this.playerList[playerID];
			/*
			if(active){
				this.world.checkForMapDamage(player);
			}*/
			player.update(dt);
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
	gatePlayers(){
		for(var playerID in this.playerList){
			var player = this.playerList[playerID];
			var loc = this.startingGate.findFreeLoc(player);
			player.x = loc.x;
			player.y = loc.y;
		}
	}
	resetPlayers(){
		for(var playerID in this.playerList){
			var player = this.playerList[playerID];
			player.reset();
		}
	}
	clean(){
		this.lobbyStartButton = null;
	}
	loadNextMap(){
		//Specify a particular map for testing
		this.currentMap = this.maps[0];
		
		//Cycle in order of file order
		/*
		for(var i=0;i<this.maps.length;i++){
			if(this.currentMap != this.maps[i]){
				this.currentMap = this.maps[i];
			}
		}
		*/
		messenger.messageRoomBySig(this.roomSig,"newMap",this.currentMap.id);
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
		var a = {x:-this.width/2, y: -this.height/2},
	        b = {x:this.width/2, y: -this.height/2},
	        c = {x:this.width/2, y: this.height/2},
	        d = {x:-this.width/2, y: this.height/2};
		vertices.push(a, b, c, d);

		var cos = Math.cos(this.angle * Math.PI/180);
	    var sin = Math.sin(this.angle * Math.PI/180);

		var tempX, tempY;
	    for (var i = 0; i < vertices.length; i++){
	        var vert = vertices[i];
	        tempX = vert.x * cos - vert.y * sin;
	        tempY = vert.x * sin + vert.y * cos;
	        vert.x = this.x + tempX;
	        vert.y = this.y + tempY;
	    }
		return vertices;
	}
	pointInRect(x, y){
	    var ap = {x:x-this.vertices[0].x, y:y-this.vertices[0].y};
	    var ab = {x:this.vertices[1].x - this.vertices[0].x, y:this.vertices[1].y - this.vertices[0].y};
	    var ad = {x:this.vertices[3].x - this.vertices[0].x, y:this.vertices[3].y - this.vertices[0].y};

		var dotW = utils.dotProduct(ap, ab);
		var dotH = utils.dotProduct(ap, ad);
		if ((0 <= dotW) && (dotW <= utils.dotProduct(ab, ab)) && (0 <= dotH) && (dotH <= utils.dotProduct(ad, ad))){
			return true;
		}
	    return false;
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
        /*
		if(this.engine.checkCollideAll(loc)){
			return this.findFreeLoc(obj);
		}
        */
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
	}
}

class World extends Rect{
    constructor(x,y,width,height,engine,roomSig){
        super(x,y,width,height, 0, "white");
		this.engine = engine;
        this.roomSig = roomSig;
		this.center = {x:width/2,y:height/2};
    }
    update(dt){
		
	}
    spawnNewPlayer(id){
        var player = new Player(0,0, 90, utils.getColor(), id,this.roomSig);
		var loc = this.findFreeLoc(player);
		player.x = loc.x;
		player.y = loc.y;
		return player;
    }
	checkForMapDamage(object){

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

		//Game Variables
		this.hittingLobbyButton = false;

		//Movement
		this.moveForward = false;
		this.moveBackward = false;
		this.turnLeft = false;
		this.turnRight = false;

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
		if(!this.alive){
			return;
		}
		this.dt = dt;
		this.move();
	}
	move(){
		this.x = this.newX;
		this.y = this.newY;
	}
	getSpeedBonus(){
		return this.currentSpeedBonus;
	}
	handleHit(object){
		if(object.isWall){
			messenger.messageUser(this.id,"collideWithObject");
			_engine.preventMovement(this,object,this.dt);
		}
		if(object.isLobbyStart){
			this.hittingLobbyButton = true;
			return;
		}
	}
	reset(){
		this.alive = true;
		this.enabled = true;
		this.x = 0;
		this.y = 0;
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
	}
}


