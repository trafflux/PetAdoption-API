#!/usr/bin/env node

var server = require('../index.js');

server.startHTTP();
server.startHTTPS();