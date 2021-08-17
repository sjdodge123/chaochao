function getRandomInt(min, max) {
    min = Math.ceil(min);
   max = Math.floor(max);
   return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getColor(){
    return 'hsl(' + Math.floor(Math.random() * 360) + ', 100%, 50%)';
};