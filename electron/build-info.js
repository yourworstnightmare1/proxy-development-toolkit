"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function packageJson() {
  return require(path.join(__dirname, "..", "package.json"));
}

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function readCached() {
  const file = path.join(__dirname, "..", "build", "build-info.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeCached(info) {
  const dir = path.join(__dirname, "..", "build");
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "build-info.json"), JSON.stringify(info, null, 2));
  } catch { /* ignore */ }
}

function collect() {
  const pkg = packageJson();
  const cached = readCached();
  const commit = git(["rev-parse", "HEAD"]) || cached?.commit || "";
  const short = git(["rev-parse", "--short", "HEAD"]) || (commit ? commit.slice(0, 7) : "") || cached?.commitShort || "uncommitted";
  const commitDate = git(["log", "-1", "--format=%cI"]) || cached?.commitDate || "";
  const buildDate = cached?.buildDate || new Date().toISOString();
  const info = {
    name: pkg.productName || pkg.name || "Proxy Development Toolkit",
    version: pkg.version || "0.0.0",
    commit: commit || short,
    commitShort: short,
    commitDate,
    buildDate,
  };
  if (!cached || cached.commitShort !== info.commitShort || cached.version !== info.version) {
    writeCached(info);
  }
  return info;
}

module.exports = { collect, readCached };
