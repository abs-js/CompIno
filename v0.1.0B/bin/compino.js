#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { compileFile } = require("../src/compino");

const VERSION = "0.1.0-beta.0";
const VERSION_FOLDER = "v0.1.0B";

function help() {
  return [
    "CompIno " + VERSION + " (" + VERSION_FOLDER + ")",
    "Transpile a .cno file into an Arduino .ino sketch.",
    "",
    "Usage:",
    "  CompIno [flags] <file.cno>",
    "  npx CompIno <file.cno>",
    "",
    "Flags:",
    "  -h, --help       Show this help",
    "  -v, --version    Show version",
    "  -d, --detailed   Print transpile steps (also accepts --detalhed)",
    "  -l, --learn      Open the CompIno lesson in a browser",
    "",
    "Output:",
    "  Writes <file>.ino next to the source file.",
    "  Load that sketch in the Arduino IDE and upload it to the board.",
  ].join("\n");
}

function openLearn() {
  const file = path.join(__dirname, "..", "learn", "index.html");
  if (!fs.existsSync(file)) {
    console.error("Learn page not found: " + file);
    process.exit(1);
  }
  const url = "file://" + file;
  const { spawn } = require("child_process");
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  const child = spawn(cmd, [url], { stdio: "ignore", detached: true, shell: platform === "win32" });
  child.unref();
  console.log("Opening lesson: " + file);
}

function main(argv) {
  const args = argv.slice(2);
  let detailed = false;
  let file = null;
  for (const arg of args) {
    if (arg === "-h" || arg === "--help") {
      console.log(help());
      return 0;
    }
    if (arg === "-v" || arg === "--version") {
      console.log(VERSION);
      return 0;
    }
    if (arg === "-d" || arg === "--detailed" || arg === "--detalhed") {
      detailed = true;
      continue;
    }
    if (arg === "-l" || arg === "--learn") {
      openLearn();
      return 0;
    }
    if (arg.startsWith("-")) {
      console.error("Unknown flag: " + arg);
      console.error(help());
      return 1;
    }
    if (file) {
      console.error("Only one source file is accepted.");
      return 1;
    }
    file = arg;
  }
  if (!file) {
    console.log(help());
    return 0;
  }
  if (!file.endsWith(".cno")) {
    console.error("Expected a .cno file, got: " + file);
    return 1;
  }
  const abs = path.resolve(process.cwd(), file);
  if (!fs.existsSync(abs)) {
    console.error("File not found: " + abs);
    return 1;
  }
  try {
    const result = compileFile(abs, { detailed });
    const out = abs.replace(/\.cno$/i, ".ino");
    fs.writeFileSync(out, result.code, "utf8");
    if (detailed) {
      for (const line of result.log) console.error(line);
    }
    console.log("Wrote " + out);
    return 0;
  } catch (err) {
    console.error("CompIno error: " + (err && err.message ? err.message : err));
    return 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { main, VERSION, VERSION_FOLDER };
