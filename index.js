const express = require('express');
const compression = require('compression');
const fs = require('fs');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const path = require('path');
const htmlPath = path.join(__dirname, 'client');

app.use(compression());

// Inject the running server's version into index.html so the landing
// page always reflects what's actually deployed. Runs in both dev and
// prod; read once at startup so we don't fs.readFile on every request.
const APP_VERSION = require('./package.json').version;
app.use(function (req, res, next) {
    var url = req.path === '/' ? '/index.html' : req.path;
    if (url !== '/index.html') return next();
    fs.readFile(path.join(htmlPath, url), 'utf8', function (err, html) {
        if (err) return next();
        var modified = html.replace(/<!-- VERSION -->/g, 'v' + APP_VERSION);
        res.set('Content-Type', 'text/html');
        res.send(modified);
    });
});

const bundleMap = {
    '/play.html': 'scripts/dist/play.bundle.min.js',
    '/create.html': 'scripts/dist/create.bundle.min.js',
    '/join.html': 'scripts/dist/join.bundle.min.js'
};
app.use(function (req, res, next) {
    if (process.env.NODE_ENV !== 'production') return next();
    var url = req.path === '/' ? '/index.html' : req.path;
    if (!(url in bundleMap)) return next();
    fs.readFile(path.join(htmlPath, url), 'utf8', function (err, html) {
        if (err) return next();
        var bundleTag = '<script src="' + bundleMap[url] + '"></script>';
        var modified = html.replace(/<!-- BUILD: bundle-start -->[\s\S]*?<!-- BUILD: bundle-end -->/g, bundleTag);
        res.set('Content-Type', 'text/html');
        res.send(modified);
    });
});

app.use(express.static(htmlPath));

var utils = require('./server/utils.js');
var messenger = require('./server/messenger.js');
var hostess = require('./server/hostess.js');
var c = utils.loadConfig();

//Base Server vars
var serverSleeping = true,
    pendingReboot = false,
    clientCount = 0,
    serverTickSpeed = c.serverTickSpeed,
    serverUpdates = null;

server.listen(c.port, () => {
  console.log('listening on *:3000');
  messenger.build(io);
});

io.on('connection', (client) => {
    checkForWake();
    clientCount++;
    messenger.addMailBox(client.id,client);

    client.on('disconnect', () => {
      hostess.kickFromRoom(client.id);
      messenger.removeMailBox(client.id);
      clientCount--;
      checkForSleep();
    });
  });
  
process.on( 'SIGINT', function() {
    console.log( "\nServer shutting down from (Ctrl-C)" );
    //io.sockets.emit("serverShutdown","Server terminated");
    process.exit();
});



/*
app.get("/create",function(request,response){
  response.render('pages/create');
});
*/


//Server updates
function update(){
  if(serverSleeping){
      return;
  }

  var dt = utils.getDT();
  hostess.updateRooms(dt);
  if(pendingReboot == false){
      //25000000
      /*
      var heapUsed = process.memoryUsage().heapUsed;
      if(heapUsed > 40000000){
          console.log("Performing Emergency reboot Memory Critical " + heapUsed);
          reboot();
      } else if(heapUsed > 32500000){
          console.log("Pending reboot.. Memory currently at " + heapUsed);
          pendingReboot = true;
      }
      */
  }
}

function checkForWake(){
	if(serverSleeping){
      console.log("Server wake");
      utils.getDT();
      serverSleeping = false;
      serverUpdates = setInterval(update,serverTickSpeed);
	}
}

function reboot(){
  console.log("Server rebooting.....");
  process.exit(1);
}

function checkForSleep(){
	if(clientCount == 0){
    if(pendingReboot){
        reboot();
    }
    console.log("Server sleep ZZZ..");
		serverSleeping = true;
		clearInterval(serverUpdates);
	}
}
