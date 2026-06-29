#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const binPath = path.join(__dirname, "..", "dist", "index.js");
if (!fs.existsSync(binPath)) {
  console.error("[ensure-bin-mode] dist/index.js not found; run tsc first.");
  process.exit(1);
}

fs.chmodSync(binPath, 0o755);
console.log("[ensure-bin-mode] dist/index.js is executable.");
