#!/usr/bin/env node
"use strict";
const { spawn } = require("node:child_process");
const path = require("node:path");
const child = spawn("/usr/bin/ssh", process.argv.slice(2), {
  stdio: "inherit",
  env: {
    ...process.env,
    SSH_ASKPASS: `${process.execPath} ${path.join(__dirname, "askpass.js")}`,
    SSH_ASKPASS_REQUIRE: "force",
    DISPLAY: process.env.DISPLAY || ":0"
  }
});
child.on("error", () => process.exit(127));
child.on("close", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
