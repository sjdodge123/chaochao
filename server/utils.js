var lastFrame = new Date();
var fs = require('fs');
const { map } = require('jquery');
var maps = [];
var mapListing = [];
var c = require('./config.json');
c.port =  process.env.PORT || c.port;

Colors = {};
Colors.names = {
    aqua: "#00ffff",
    azure: "#f0ffff",
    beige: "#f5f5dc",
    blue: "#0000ff",
    brown: "#a52a2a",
    cyan: "#00ffff",
    darkblue: "#00008b",
    darkcyan: "#008b8b",
    darkgrey: "#a9a9a9",
    darkgreen: "#006400",
    darkkhaki: "#bdb76b",
    darkmagenta: "#8b008b",
    darkolivegreen: "#556b2f",
    darkorange: "#ff8c00",
    darkorchid: "#9932cc",
    darkred: "#8b0000",
    darksalmon: "#e9967a",
    darkviolet: "#9400d3",
    fuchsia: "#ff00ff",
    gold: "#ffd700",
    green: "#008000",
    indigo: "#4b0082",
    khaki: "#f0e68c",
    lightblue: "#add8e6",
    lightcyan: "#e0ffff",
    lightgreen: "#90ee90",
    lightgrey: "#d3d3d3",
    lightpink: "#ffb6c1",
    lightyellow: "#ffffe0",
    lime: "#00ff00",
    magenta: "#ff00ff",
    maroon: "#800000",
    navy: "#000080",
    olive: "#808000",
    orange: "#ffa500",
    pink: "#ffc0cb",
    purple: "#800080",
    violet: "#800080",
    red: "#ff0000",
    silver: "#c0c0c0",
    white: "#ffffff",
    yellow: "#ffff00"
};
Colors.random = function() {
    var result;
    var count = 0;
    for (var prop in this.names){
        if (Math.random() < 1/++count){
            result = this.names[prop];
        }
    }
    return result;
};
exports.getRandomInt = function(min,max){
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min + 1)) + min;
};

exports.getColor = function(){
    return Colors.random();
    /*
    return 'hsl(' + Math.floor(Math.random() * 360) + ', 100%, 50%)';
    */
};

exports.getDT = function(){
	var currentFrame = new Date();
	var dt = currentFrame - lastFrame;
	lastFrame = currentFrame;
	return dt/1000;
}
exports.getMagSq = function(x1, y1, x2, y2){
	return Math.pow(x2-x1,2) + Math.pow(y2-y1, 2);
}

exports.getMag = function(x,y){
	return Math.sqrt(Math.pow(x, 2) + Math.pow(y, 2));
}

exports.dotProduct = function(a, b){
    return a.x * b.x + a.y * b.y;
}
exports.loadConfig = function(){
    return c;
}
exports.loadMaps = function(){
    maps = [];
    var normalizedPath = require("path").join(__dirname, "../client/maps");
    fs.readdirSync(normalizedPath).forEach(function(file){
        mapListing.push(file);
        maps.push(require("../client/maps/" + file));
    });
    return maps;
    
}
exports.getMapListings = function(){
    return mapListing;
}
