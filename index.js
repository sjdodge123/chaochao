const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const path = require('path');
const htmlPath = path.join(__dirname, 'client');
app.use(express.static(htmlPath));

var utils = require('./server/utils.js');
var messenger = require('./server/messenger.js');
var c = utils.loadConfig();

//Base Server vars
var clientCount = 0;

server.listen(c.port, () => {
  console.log('listening on *:3000');
  messenger.build(io);
});

io.on('connection', (client) => {
    clientCount++;
    messenger.addMailBox(client.id,client);
    //console.log('a user connected');
    client.on('disconnect', () => {
      //console.log('user disconnected');
      messenger.removeMailBox(client.id);
      clientCount--;
    });
  });
  
process.on( 'SIGINT', function() {
    console.log( "\nServer shutting down from (Ctrl-C)" );
    //io.sockets.emit("serverShutdown","Server terminated");
    process.exit();
});