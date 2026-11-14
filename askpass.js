#!/usr/bin/env node
"use strict";
// Recebe a senha por um socket local temporário, sem expô-la em argumentos ou variáveis de ambiente.
const net = require("node:net");
const socketPath = process.env.SSHFS_PANEL_ASKPASS_SOCKET;
if (!socketPath) process.exit(1);
const socket = net.connect(socketPath);
let result = "";
socket.setTimeout(5000);
socket.on("data", chunk => { result += chunk; if (result.length > 4096) socket.destroy(); });
socket.on("end", () => { process.stdout.write(result); });
socket.on("timeout", () => socket.destroy());
socket.on("error", () => { process.exitCode = 1; });
