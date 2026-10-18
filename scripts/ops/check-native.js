#!/usr/bin/env node
// package.json から native 依存と engines を検査
const fs = require("fs");
const pkgPath = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const d = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
const native = ["sharp", "better-sqlite3", "sqlite3", "canvas", "bcrypt", "bcryptjs",
  "node-sass", "utf-8-validate", "bufferutil", "serialport", "deasync", "microtime",
  "libxmljs", "leveldown", "node-gyp-build", "@tensorflow/tfjs-node", "onnxruntime-node",
  "re2", "heapdump", "@swc/core", "grpc", "fsevents"].filter((k) => d[k]);
console.log("  engines:", JSON.stringify(pkg.engines || {}));
console.log("  native deps:", native.length ? native.join(", ") : "(none)");
console.log("  node version installed via: " + (pkg._nodeVersion || "n/a"));