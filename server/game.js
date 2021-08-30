'use strict';
var utils = require('./utils.js');
var c = utils.loadConfig();
var messenger = require('./messenger.js');
var hostess = require('./hostess.js');
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
		this.projectileList = {};
        this.clientCount = 0;
        this.alive = true;
		this.engine = _engine.getEngine(this.playerList,this.projectileList);
        this.world = new World(0,0,c.worldWidth,c.worldHeight,this.engine,this.playerList,this.sig);
        this.game = new Game(this.clientList,this.playerList,this.projectileList,this.world,this.engine,this.sig);
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
		var projData = compressor.sendProjUpdates(this.projectileList);
		var gameStateData = compressor.gameState(this.game);
		messenger.messageRoomBySig(this.sig,"gameUpdates",{
			playerList:playerData,
			projList:projData,
			state:gameStateData,
			totalPlayers:messenger.getTotalPlayers()
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
				messenger.messageClientBySig(id,"serverKick",null);
				hostess.kickFromRoom(id);
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
    constructor(clientList,playerList,projectileList,world,engine,roomSig){
        this.clientList = clientList;
        this.playerList = playerList;
		this.projectileList = projectileList;
        this.roomSig = roomSig 
        this.world = world;
		this.engine = engine;
        this.gameEnded = false;
        this.locked = false;

		//Game stats
		this.playerCount = 0;
		this.alivePlayerCount = 0;
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
		this.gameBoard = new GameBoard(world,playerList,projectileList,engine,roomSig);
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
		this.alivePlayerCount = playersConcluded;
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
		this.currentState = this.stateMap.gated;
		this.gameBoard.setupMap(this.currentState);
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
		this.gameBoard.resetGame(this.currentState);
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
	constructor(world,playerList,projectileList,engine,roomSig){
		this.world = world;
		this.playerList = playerList;
		this.projectileList = projectileList;
		this.abilityList = {};
		this.punchList = {};
		this.engine = engine;
		this.roomSig = roomSig;
		this.stateMap = c.stateMap;
		this.lobbyStartButton;
		this.startingGate = null;
		this.maps = utils.loadMaps();
		this.mapsPlayed = [];
		this.currentMap = {};

		this.allAbilityIDs = this.indexAbilities();
		this.collapseLoc = {};
		this.collapseLine = this.world.height;
	}
	update(currentState,dt){
		this.engine.update(dt);
		this.collapseMap(currentState);
		this.checkCollisions(currentState);
		this.updatePlayers(currentState,dt);
		this.updateProjectiles(currentState);
		this.checkAbilities(currentState);
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
			for(var projID in this.projectileList){
				_engine.preventEscape(this.projectileList[projID],this.world);
				objectArray.push(this.projectileList[projID]);
			}
			for(var punchId in this.punchList){
				objectArray.push(this.punchList[punchId]);
			}
		}
		
		this.engine.broadBase(objectArray);
	}
	checkAbilities(currentState){
		for(var id in this.abilityList){
			if(this.abilityList[id].swap){
				this.swapOwnerWithRandomPlayer(this.abilityList[id].ownerId);
				this.abilityList[id].swap = false;
			}
			if(this.abilityList[id].spawnBomb){
				this.abilityList[id].spawnBomb = false;
				this.spawnBomb(this.abilityList[id].ownerId);
				setTimeout(this.acquireBombTrigger,100,{id:this.abilityList[id].ownerId,abilityList:this.abilityList,playerList:this.playerList,roomSig:this.roomSig});
				//delete this.abilityList[id];
				//continue;
			}
			if(this.abilityList[id].explodeBomb){
				this.abilityList[id].explodeBomb = false;
				this.projectileList[this.abilityList[id].ownerId].explodeBomb();
			}
			if(this.abilityList[id].alive == false){
				this.playerList[this.abilityList[id].ownerId].ability = null;
				delete this.abilityList[id];
			}
		}
	}
	updatePlayers(currentState,dt){
		for(var playerID in this.playerList){
			var player = this.playerList[playerID];
			if(player.acquiredAbility != null){
				this.abilityList[playerID] = player.ability;
				this.changeTile(player.acquiredAbility,c.tileMap.normal.id);
				player.acquiredAbility = null;
			}
			player.update(currentState,dt);
			if(player.punch != null){
				this.punchList[player.id] = player.punch;
				setTimeout(this.terminatePunch,100,{id:player.id,punchList:this.punchList,roomSig:this.roomSig});
				player.punch = null;
			}
		}
	}
	updateProjectiles(currentState){
		for(var id in this.projectileList){

			if(this.projectileList[id].explode == true){
				this.explodeBomb(id);
			}

			if(this.projectileList[id].alive == false){
				messenger.messageRoomBySig(this.roomSig,"terminateBomb",id);
				delete this.projectileList[id];
				continue;
			}
			this.projectileList[id].update();
		}
	}
	terminatePunch(packet){
		messenger.messageRoomBySig(packet.roomSig,"terminatePunch",packet.id);
		delete packet.punchList[packet.id];
		
	}
	acquireBombTrigger(packet){
		var player = packet.playerList[packet.id];
		player.ability = new BombTrigger(packet.id,packet.id.roomSig);
		packet.abilityList[player.id] = player.ability;
		//TODO make the bomb trigger have a HUD
		//messenger.messageRoomBySig(this.roomSig,"abilityAcquired",{owner:player.id,ability:object.id,voronoiId:object.voronoiId});
	}
	swapOwnerWithRandomPlayer(owner){
		if(Object.keys(this.playerList).length == 1){
			//TODO play fizzle sound to client
			return;
		}
		if(this.alivePlayerCount == 1){
			//TODO play fizzle sound to client
			return;
		}
		var randomPlayer = utils.getRandomProperty(this.playerList);
		if(randomPlayer.id == owner || randomPlayer.alive == false){
			return this.swapOwnerWithRandomPlayer(owner);
		}
		var ownerPlayer = this.playerList[owner];
		var tempVars = {x:randomPlayer.x,y:randomPlayer.y,newX:randomPlayer.newX,newY: randomPlayer.newY,velX: randomPlayer.velX,velY:randomPlayer.velY,dragCoeff:randomPlayer.dragCoeff,brakeCoeff:randomPlayer.brakeCoeff,acel:randomPlayer.acel};
		for(var prop in tempVars){
			randomPlayer[prop] = ownerPlayer[prop];
			ownerPlayer[prop] = tempVars[prop];
		}
	}
	spawnBomb(owner){
		var player = this.playerList[owner];
		var bomb = new BombProj(player.x,player.y,10,"black",owner,this.roomSig,(180/Math.PI)*Math.atan2(player.mouseY-player.y,player.mouseX-player.x)-90);
		this.projectileList[owner] = bomb;
		messenger.messageRoomBySig(this.roomSig,"spawnBomb",owner);
	}
	explodeBomb(owner){
		var explodedCells = [];
		var explodeLoc = {x:this.projectileList[owner].x,y:this.projectileList[owner].y};
		var cells = this.currentMap.cells;
		for(var i=0;i<cells.length;i++){
			if(cells[i].id == c.tileMap.goal.id || cells[i].id == c.tileMap.lava.id){
				continue;
			}
			var distance = utils.getMag(explodeLoc.x - cells[i].site.x, explodeLoc.y - cells[i].site.y);
			if(c.tileMap.abilities.bomb.explosionRadius > distance){
				cells[i].id = c.tileMap.slow.id;
				explodedCells.push(cells[i].site.voronoiId);	
			}
		}
		messenger.messageRoomBySig(this.roomSig,'explodedCells',explodedCells);
	}
	startLobby(){
		this.lobbyStartButton = new LobbyStartButton(this.world.center.x,this.world.center.y,0,"red");
		messenger.messageRoomBySig(this.roomSig,"startLobby",compressor.sendLobbyStart(this.lobbyStartButton));
	}
	setupMap(currentState){
		this.clean();
		this.resetPlayers(currentState);
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
			if(cells[i].id == c.tileMap.goal.id || cells[i].id == c.tileMap.lava.id){
				continue;
			}
			var distance = utils.getMag(this.collapseLoc.x - cells[i].site.x, this.collapseLoc.y - cells[i].site.y);
			if(this.collapseLine < distance){
				cells[i].id = c.tileMap.lava.id;
				collapsedCells.push(cells[i].site.voronoiId);	
			}
		}
		messenger.messageRoomBySig(this.roomSig,'collapsedCells',collapsedCells);
	}
	changeTile(voronoiId,newId){
		for(var i=0;i<this.currentMap.cells.length;i++){
			if(this.currentMap.cells[i].site.voronoiId == voronoiId){
				this.currentMap.cells[i].id = newId;
				return;
			}
		}
	}
	resetGame(currentState){
		this.mapsPlayed = [];
		this.resetPlayers(currentState);
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
	resetPlayers(currentState){
		messenger.messageRoomBySig(this.roomSig,"resetPlayers",null);
		for(var playerID in this.playerList){
			var player = this.playerList[playerID];
			player.reset(currentState);
		}
	}
	clean(){
		this.lobbyStartButton = null;
		this.collapseLoc = {};
		this.collapseLine = this.world.height + 400;
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
		
		messenger.messageRoomBySig(this.roomSig,"newMap",{id:this.currentMap.id,abilities:this.generateAbilities()});
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
	generateAbilities(){
		var abilityTilesAvaliable = [];
		var abilities = [];
		var indexMap = {};
		for(var i=0;i<this.currentMap.cells.length;i++){
			if(this.currentMap.cells[i].id == c.tileMap.ability.id){
				abilityTilesAvaliable.push(i);
			}
		}
		if(abilityTilesAvaliable.length == 0){
			return indexMap;
		}
		var numAbilitiesToSpawn = utils.getRandomInt(0,abilityTilesAvaliable.length-1);
		for(var j=0;j<numAbilitiesToSpawn;j++){
			abilities.push(this.spawnNewAbility());
		}
		for(var p=0;p<abilityTilesAvaliable.length;p++){
			if(p >= numAbilitiesToSpawn){
				indexMap[this.currentMap.cells[abilityTilesAvaliable[p]].site.voronoiId] = c.tileMap.normal.id;
				this.currentMap.cells[abilityTilesAvaliable[p]].id = c.tileMap.normal.id;
				continue;
			}
			indexMap[this.currentMap.cells[abilityTilesAvaliable[p]].site.voronoiId] = abilities[p];
			this.currentMap.cells[abilityTilesAvaliable[p]].id = abilities[p];
		}
		return indexMap;
	}
	spawnNewAbility(){
		return this.allAbilityIDs[utils.getRandomInt(0,this.allAbilityIDs.length-1)];
	}
	indexAbilities(){
		var abilities = [];
		for(var ability in c.tileMap.abilities){
			abilities.push(c.tileMap.abilities[ability].id);
		}
		return abilities;
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

		this.chatCoolDownWaitTime = 10;
		this.chatCoolDownTimer = null;
		this.chatCoolDownTimeLeft = this.chatCoolDownWaitTime;

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
		this.mouseX = 0;
		this.mouseY = 0;
		

		//Attack
		this.acquiredAbility = null;
		this.ability = null;
		this.punch = null;

		this.punchWaitTime = c.playerPunchCooldown;
		this.punchedTimer = null;
		this.punchTimeLeft = this.punchWaitTime;

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
	update(currentState,dt){
		this.checkForSleep();
		if(!this.alive){
			return;
		}
		this.dt = dt;
		this.move();
		this.checkAttack(currentState);
		this.checkChatCoolDownTimer();
	}
	move(){
		this.x = this.newX;
		this.y = this.newY;
	}
	checkAttack(currentState){
		if(this.attack){
			if((currentState == c.stateMap.racing || currentState == c.stateMap.collapsing) && this.ability != null){
				this.punchedTimer = Date.now();
				this.ability.use();
				return;
			}
			if(this.checkPunchCoolDown()){
				return;
			}
			this.punchedTimer = Date.now();
			this.punch = new Punch(this.x,this.y,c.punchRadius,this.color,this.id,this.roomSig);
			messenger.messageRoomBySig(this.roomSig,"punch",compressor.sendPunch(this.punch));
		}
	}
	checkPunchCoolDown(){
		if(this.punchedTimer != null){
			this.punchTimeLeft = (this.punchWaitTime - (Date.now() - this.punchedTimer));
			if(this.punchTimeLeft > 0){
				return true;
			}
			return false;
		}
	}
	checkChatCoolDownTimer(){
		if(this.chatCoolDownTimer != null){
			this.chatCoolDownTimeLeft = ((this.chatCoolDownWaitTime*1000 - (Date.now() - this.chatCoolDownTimer))/(1000)).toFixed(1);
			if(this.chatCoolDownTimeLeft > 0){
				return;
			}
			this.chatCoolDownTimer = null;
		}
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
			if(object.id == c.tileMap.normal.id){
				this.acel = object.acel;
				this.brakeCoeff = object.brakeCoeff;
				this.dragCoeff = object.dragCoeff;
				return;
			}
			if(object.id == c.tileMap.slow.id){
				this.acel = object.acel;
				this.dragCoeff = object.dragCoeff;
				this.brakeCoeff = object.brakeCoeff;
				return;
			}	
			if(object.id == c.tileMap.fast.id){
				this.acel = object.acel;
				this.dragCoeff = object.dragCoeff;
				this.brakeCoeff = object.brakeCoeff;
				return;
			}
			if(object.id == c.tileMap.lava.id){
				this.killPlayer();
				return;
			}
			if(object.id == c.tileMap.ice.id){
				this.acel = object.acel;
				this.brakeCoeff = object.brakeCoeff;
				this.dragCoeff = object.dragCoeff;
				return;
			}
			if(object.id == c.tileMap.goal.id){
				this.alive = false;
				this.reachedGoal = true;
				this.timeReached = Date.now();
				messenger.messageRoomBySig(this.roomSig,"playerConcluded",this.id);
				return;
			}
			if(object.id == c.tileMap.bumper.id){
				_engine.bumpPlayer(this,object);
				return;
			}
			if(object.id == c.tileMap.abilities.blindfold.id){
				if(this.ability != null){
					return;
				}
				this.ability = new Blindfold(this.id,this.roomSig);
				this.acquiredAbility = object.voronoiId;
				messenger.messageRoomBySig(this.roomSig,"abilityAcquired",{owner:this.id,ability:object.id,voronoiId:object.voronoiId});
				return;
			}
			if(object.id == c.tileMap.abilities.swap.id){
				if(this.ability != null){
					return;
				}
				this.ability = new Swap(this.id,this.roomSig);
				this.acquiredAbility = object.voronoiId;
				messenger.messageRoomBySig(this.roomSig,"abilityAcquired",{owner:this.id,ability:object.id,voronoiId:object.voronoiId});
				return;
			}
			if(object.id == c.tileMap.abilities.bomb.id){
				if(this.ability != null){
					return;
				}
				this.ability = new Bomb(this.id,this.roomSig);
				this.acquiredAbility = object.voronoiId;
				messenger.messageRoomBySig(this.roomSig,"abilityAcquired",{owner:this.id,ability:object.id,voronoiId:object.voronoiId});
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
		this.ability = null;
		if(this.notches > 0){
			this.notches -= 1;
		}
		messenger.messageRoomBySig(this.roomSig,"playerDied",this.id);
	}
	reset(currentState){
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
		this.acquiredAbility = null;
		this.mouseX = 0;
		this.mouseY = 0;
		if(currentState == c.stateMap.gameOver){
			this.ability = null;
		}
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
class BombProj extends Circle{
	constructor(x,y,radius,color,ownerId,roomSig,angle){
		super(x,y,radius,color);
		this.alive = true;
		this.ownerId = ownerId;
		this.roomSig = roomSig;
		this.lifeTime = c.tileMap.abilities.bomb.lifetime;
		this.explosionRadius = c.tileMap.abilities.bomb.explosionRadius;
		this.speed = c.tileMap.abilities.bomb.speed;
		this.angle = angle;
		this.velX = 0;
		this.velY = 0;
		this.newX = this.x;
		this.newY = this.y;
		this.explode = false;

		this.explodeWaitTime = c.tileMap.abilities.bomb.lifetime;
		this.explodeTimer = null;
		this.explodeTimeLeft = this.explodeWaitTime;
	}
	update(){
		this.checkExplodeTimer();
		this.move();
	}
	checkExplodeTimer(){
		if(this.explodeTimer != null){
			this.explodeTimeLeft = ((this.explodeWaitTime*1000 - (Date.now() - this.explodeTimer))/(1000)).toFixed(1);
			if(this.explodeTimeLeft > 0){
				return;
			}
			this.explodeBomb();
			return;
		}
		this.explodeTimer = Date.now();
	}
	explodeBomb(){
		this.explode = true;
		this.alive = false;
	}
	move(){
		this.x = this.newX;
		this.y = this.newY;
	}
	handleHit(object){
		
	}
}
class Ability {
	constructor(owner,roomSig){
		this.roomSig = roomSig;
		this.ownerId = owner;
		this.alive = true;
	}
	update(){

	}
	use(){
		console.log("unimplemented");
	}
}
class Blindfold extends Ability{
	constructor(owner,roomSig){
		super(owner,roomSig);
	}
	use(){
		if(this.alive == false){
			return;
		}
		this.alive = false;
		messenger.messageRoomBySig(this.roomSig,"blindfoldUsed",this.ownerId);
	}
}
class Swap extends Ability{
	constructor(owner,roomSig){
		super(owner,roomSig);
		this.swap = false;
	}
	use(){
		if(this.alive == false){
			return;
		}
		this.swap = true;
		this.alive = false;
		messenger.messageRoomBySig(this.roomSig,"swapUsed",this.ownerId);
	}
}
class Bomb extends Ability{
	constructor(owner,roomSig){
		super(owner,roomSig);
		this.spawnBomb = false;
	}
	use(){
		if(this.alive == false){
			return;
		}
		this.spawnBomb = true;
		this.alive = false;
		messenger.messageRoomBySig(this.roomSig,"bombUsed",this.ownerId);
	}
}
class BombTrigger extends Ability{
	constructor(owner,roomSig){
		super(owner,roomSig);
		this.explodeBomb = false;
	}
	use(){
		if(this.alive == false){
			return;
		}
		this.explodeBomb = true;
		this.alive = false;
		messenger.messageRoomBySig(this.roomSig,"bombTriggered",this.ownerId);
	}
}



