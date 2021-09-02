function getRandomInt(min, max) {
    min = Math.ceil(min);
   max = Math.floor(max);
   return Math.floor(Math.random() * (max - min + 1)) + min;
}

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
Colors.decode = function(input){
    var result;
    for(var prop in this.names){
        if(input == this.names[prop]){
            return prop;
        }
    }
}

function getColor(){
    return 'hsl(' + Math.floor(Math.random() * 360) + ', 100%, 50%)';
};

function getMagSq(x1, y1, x2, y2){
	return Math.pow(x2-x1,2) + Math.pow(y2-y1, 2);
}
function getMagSquared(x,y){
	return Math.pow(x, 2) + Math.pow(y, 2);
}

function angle(originX, originY, targetX, targetY) {
    var dx = originX - targetX;
    var dy = originY - targetY;
    var theta = Math.atan2(-dy, -dx);
    theta *= 180 / Math.PI;           
    if (theta < 0) theta += 360;      
    return theta;
}
function pos(point, length, angle) {
    var a = angle * Math.PI / 180;
    var x = point.x + length * Math.cos(a);
    var y = point.y + length * Math.sin(a);
    return {x, y};
}