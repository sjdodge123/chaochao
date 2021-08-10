var c = require('./config.json');
c.port =  process.env.PORT || c.port;

exports.getRandomInt = function(min,max){
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min + 1)) + min;
};

exports.loadConfig = function(){
    return c;
}
