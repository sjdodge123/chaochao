var lastFrame = new Date();
var fs = require('fs');
const { map } = require('jquery');
var maps = [];
var mapListing = [];
var c = require('./config.json');
c.port = process.env.PORT || c.port;

const { Octokit } = require("@octokit/core");
const octokit = new Octokit({
    auth: process.env.GITHUB_AUTH
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

exports.angle = function (originX, originY, targetX, targetY) {
    return angle(originX, originY, targetX, targetY);
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
