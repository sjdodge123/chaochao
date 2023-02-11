var lastFrame = new Date();
var fs = require('fs');
const { map } = require('jquery');
var maps = [];
var mapListing = [];
var c = require('./config.json');
c.port = process.env.PORT || c.port;


const { Octokit } = require("@octokit/core");
const octokit = new Octokit({
    auth: 'EMPTY'
});
loadMaps();

Colors = {};
Colors.names = {
    Red: '#e6194B',
    Green: '#3cb44b',
    Yellow: '#ffe119',
    Blue: '#4363d8',
    Orange: '#f58231',
    Purple: '#911eb4',
    Cyan: '#42d4f4',
    Magenta: '#f032e6',
    Lime: '#bfef45',
    Pink: '#fabed4',
    Teal: '#469990',
    Lavender: '#dcbeff',
    Brown: '#9A6324',
    Beige: '#fffac8',
    Maroon: '#800000',
    Mint: '#aaffc3',
    Olive: '#808000',
    Apricot: '#ffd8b1',
    Navy: '#000075',
    Grey: '#8A8A8A',
    White: '#ffffff',
    DarkGrey: '#454545'
};
Colors.random = function () {
    var result;
    var count = 0;
    for (var prop in this.names) {
        if (Math.random() < 1 / ++count) {
            result = this.names[prop];
        }
    }
    return result;
};
async function submitPR() {
    var owner = 'sjdodge123',
        repo = 'chaochao',
        title = 'test pr',
        body = 'testing new change',
        head = 'mapeditor:new-map',
        base = 'master';


    const response = await octokit.request(
        'POST /repos/{owner}/{repo}/pulls', { owner, repo, title, body, head, base }
    );
}
async function getPRs() {
    var owner = 'sjdodge123',
        repo = 'chaochao';

    var response = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
        owner,
        repo
    })
    console.log(response);
}

async function getBranch() {
    var result = await octokit.request('GET /repos/{owner}/{repo}/branches/{branch}', {
        owner: 'sjdodge123',
        repo: 'chaochao',
        branch: 'map-submission'
    })
    console.log(result);
}

getBranch();

exports.submitPullRequest = async function (map) {



    /*
    for (var map in mapListing) {
        console.log(mapListing[map]);
    }
    */
    //if (map.title)

    /*
    const owner = 'sjdodge123';
    const repo = 'chaochao';

    await octokit.request('GET /repos/{owner}/{repo}/pulls', {
        owner: 'sjdodge123',
        repo: 'chaochao',
        titlle: '',
    });
    */

}

exports.getRandomInt = function (min, max) {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min + 1)) + min;
};

exports.getColor = function () {
    return Colors.random();
    /*
    return 'hsl(' + Math.floor(Math.random() * 360) + ', 100%, 50%)';
    */
};

exports.getDT = function () {
    var currentFrame = new Date();
    var dt = currentFrame - lastFrame;
    lastFrame = currentFrame;
    return dt / 1000;
}
exports.getMagSq = function (x1, y1, x2, y2) {
    return Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2);
}

exports.getMag = function (x, y) {
    return Math.sqrt(Math.pow(x, 2) + Math.pow(y, 2));
}

exports.dotProduct = function (a, b) {
    return a.x * b.x + a.y * b.y;
}
exports.loadConfig = function () {
    return c;
}
exports.loadMaps = function () {
    return maps;
}
exports.getMapListings = function () {
    return mapListing;
}
exports.getRandomProperty = function (obj) {
    var keys = Object.keys(obj);
    return obj[keys[keys.length * Math.random() << 0]];
}

exports.shuffleArray = function (array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const temp = array[i];
        array[i] = array[j];
        array[j] = temp;
    }
    return array;
}

function loadMaps() {
    var normalizedPath = require("path").join(__dirname, "../client/maps");
    fs.readdirSync(normalizedPath).forEach(function (file) {
        mapListing.push(file);
        maps.push(require("../client/maps/" + file));
    });
}
