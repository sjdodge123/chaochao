var lastFrame = new Date();
var fs = require('fs');
const { map } = require('jquery');
var maps = [];
var mapListing = [];
var soundListing = [];
var imgListing = [];

var c = require('./config.json');
c.port = process.env.PORT || c.port;

const { Octokit } = require("@octokit/core");
const octokit = new Octokit({
    auth: process.env.GITHUB_AUTH
});
loadMaps();
loadSounds();
loadImages();

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
exports.submitPullRequest = async function (map) {
    var returnToClient = { status: false, message: "" };
    if (process.env.GITHUB_AUTH == null) {
        console.log("github auth env variable not set");
        returnToClient.status = false;
        return returnToClient;
    }


    const owner = 'sjdodge123';
    const repo = 'chaochao';
    var author = String(map.author).replace(/ /g, '');
    var mapName = String(map.name).replace(/ /g, '');
    var email = String(map.email).replace(/ /g, '');
    if (author == '' || email == '' || mapName == '') {
        console.log("Can't submit to github; required info missing:" + author + ":" + email + ":" + mapName);
        returnToClient.status = false;
        return returnToClient;
    }
    var branchName = "mapchange-" + mapName.toLowerCase() + "-" + getRandomBranchCode();
    try {
        var result = await octokit.request('GET /repos/{owner}/{repo}/git/refs/heads', {
            owner,
            repo
        })
        var head = null;
        for (var i = 0; i < result.data.length; i++) {
            if (result.data[i].ref != 'refs/heads/main') {
                continue;
            }
            head = result.data[i];
        }
        if (head == null) {
            returnToClient.status = false;
            return returnToClient;
        }

        var path = 'client/maps/' + mapName + '.json';
        var shaOfFileAnswer = null;
        var insertion = false;
        try {
            var shaOfFileAnswer = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
                owner,
                repo,
                path
            });
        } catch (e) {
            if (e.message == 'Not Found') {
                insertion = true;
            }
        }

        var shaToUse = head.object.sha;
        if (shaOfFileAnswer != null && insertion == false) {
            shaToUse = shaOfFileAnswer.data.sha
        }
        var response = await octokit.request('POST /repos/{owner}/{repo}/git/refs', {
            owner,
            repo,
            ref: "refs/heads/" + branchName,
            sha: head.object.sha,
        })

        var bufferObj = Buffer.from(JSON.stringify(map, null, 2), 'utf8');
        var base64String = bufferObj.toString("base64");
        var title = 'INSERT - ' + map.name + "/" + map.author + " from " + email;
        if (insertion == false) {
            title = 'UPDATE - ' + map.name + "/" + map.author + " from " + email;
        }
        var answer = await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
            owner,
            repo,
            path,
            message: title,
            committer: {
                name: map.author,
                email: email,
            },
            branch: branchName,
            sha: shaToUse,
            content: base64String,
        })
        var pr = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
            owner,
            repo,
            title,
            body: title,
            head: branchName,
            base: 'main'
        })
        if (pr.status == 201) {
            returnToClient.status = true;
            returnToClient.message = pr.data.html_url;
            return returnToClient;
        }
        returnToClient.status = false;
        return returnToClient;
    } catch (e) {
        console.log(e);
        returnToClient.status = false;
        returnToClient.message = e.response.data.message;
        return returnToClient;
    }

}

function getRandomBranchCode() {
    const codeLength = 6;
    var code = [];
    for (var i = 0; i < codeLength; i++) {
        code.push(getRandomInt(0, 9));
    }
    return code.join('');
}

function getRandomInt(min, max) {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min + 1)) + min;
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
    return { x, y };
}

function cyrb53(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed,
        h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
        ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
};

exports.generateHash = function (baseID, seed) {
    return cyrb53(baseID, seed);
}

exports.angle = function (originX, originY, targetX, targetY) {
    return angle(originX, originY, targetX, targetY);
}
exports.pos = function (point, length, angle) {
    return pos(point, length, angle);
}

exports.getRandomInt = function (min, max) {
    return getRandomInt(min, max);
};

exports.getColor = function () {
    return Colors.random();
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
exports.normalizedVectorFromAngle = function (angle) {
    // Calculate x and y components of vector
    const x = Math.cos(angle);
    const y = Math.sin(angle);

    // Calculate magnitude of vector
    const magnitude = Math.sqrt(x * x + y * y);

    // Normalize vector by dividing each component by magnitude
    return {
        x: x / magnitude,
        y: y / magnitude
    };
}
exports.normalizedVectorFromPoint = function (point) {
    /// Calculate magnitude of vector
    const magnitude = Math.sqrt(point.x * point.x + point.y * point.y);
    // Normalize vector by dividing each component by magnitude
    return {
        x: point.x / magnitude,
        y: point.y / magnitude
    };
}

exports.distanceBetweenPoints = function (point1, point2) {
    const dx = point2.x - point1.x;
    const dy = point2.y - point1.y;
    return Math.sqrt(dx * dx + dy * dy);
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
exports.getContentCount = function () {
    return mapListing.length + soundListing.length + imgListing.length;
}
exports.getMapListings = function () {
    return mapListing;
}
exports.getSoundListings = function () {
    return soundListing;
}
exports.getImageListings = function () {
    return imgListing;
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
        if (file != ".DS_Store") {
            mapListing.push(file);
            maps.push(require("../client/maps/" + file));
        }
    });
}
function loadSounds() {
    var normalizedPath = require("path").join(__dirname, "../client/assets/sounds");
    fs.readdirSync(normalizedPath).forEach(function (file) {
        if (file != ".DS_Store") {
            soundListing.push(file);
        }
    });
}
function loadImages() {
    var normalizedPath = require("path").join(__dirname, "../client/assets/img");
    fs.readdirSync(normalizedPath).forEach(function (file) {
        if (file != ".DS_Store") {
            imgListing.push(file);
        }
    });
}

