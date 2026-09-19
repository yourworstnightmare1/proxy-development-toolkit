"use strict";

const fs = require("fs");
const path = require("path");

function appRoot() {
  return path.join(__dirname, "..");
}

function nodeModuleRoots() {
  const roots = [path.join(appRoot(), "node_modules")];
  if (process.resourcesPath) {
    roots.unshift(path.join(process.resourcesPath, "app.asar.unpacked", "node_modules"));
  }
  return roots;
}

function modulePath(...parts) {
  for (const root of nodeModuleRoots()) {
    const candidate = path.join(root, ...parts);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Missing package files: ${parts.join("/")}`);
}

const vendorOverrides = new Map();

function setVendorOverride(prefix, root) {
  if (!prefix) return;
  if (!root) vendorOverrides.delete(prefix);
  else vendorOverrides.set(prefix, root);
}

function vendorMounts() {
  const mounts = {
    "/vendor/scramjet/": modulePath("@mercuryworkshop", "scramjet", "dist"),
    "/vendor/controller/": modulePath("@mercuryworkshop", "scramjet-controller", "dist"),
    "/uv/": modulePath("@titaniumnetwork-dev", "ultraviolet", "dist"),
    "/epoxy/": modulePath("@mercuryworkshop", "epoxy-transport", "dist"),
    "/libcurl/": modulePath("@mercuryworkshop", "libcurl-transport", "dist"),
    "/bare/": modulePath("@mercuryworkshop", "bare-transport", "dist"),
    "/baremux/": modulePath("@mercuryworkshop", "bare-mux", "dist"),
    "/baremux-legacy/": modulePath("bare-mux-legacy", "dist"),
    "/vendor/epoxy-tls/": modulePath("@mercuryworkshop", "epoxy-tls", "full"),
    "/vendor/wisp/": modulePath("@mercuryworkshop", "wisp-js", "dist"),
  };
  for (const [prefix, root] of vendorOverrides) mounts[prefix] = root;
  return mounts;
}

module.exports = {
  appRoot,
  modulePath,
  vendorMounts,
  setVendorOverride,
  srcDir: path.join(appRoot(), "src"),
};
