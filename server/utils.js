var lastFrame = new Date();
var c = require('./config.json');
c.port =  process.env.PORT || c.port;

exports.getRandomInt = function(min,max){
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min + 1)) + min;
};

exports.getColor = function(){
    return 'hsl(' + Math.floor(Math.random() * 360) + ', 100%, 50%)';
};

exports.getDT = function(){
	var currentFrame = new Date();
	var dt = currentFrame - lastFrame;
	lastFrame = currentFrame;
	return dt/1000;
}

exports.loadConfig = function(){
    return c;
}
