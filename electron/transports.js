"use strict";

const fs = require("fs");
const path = require("path");
const { modulePath } = require("./paths");

// Transport packages served from node_modules. `prefix` must match the mount in paths.js
// and `sub` is the folder inside the npm package that the mount points at.
const TRANSPORT_PACKAGES = [
  { id: "epoxy-transport", label: "epoxy-transport", pkg: "@mercuryworkshop/epoxy-transport", prefix: "/epoxy/", sub: "dist" },
  { id: "epoxy-tls", label: "epoxy-tls", pkg: "@mercuryworkshop/epoxy-tls", prefix: "/vendor/epoxy-tls/", sub: "full" },
  { id: "libcurl-transport", label: "libcurl-transport", pkg: "@mercuryworkshop/libcurl-transport", prefix: "/libcurl/", sub: "dist" },
  { id: "wisp-js", label: "wisp-js", pkg: "@mercuryworkshop/wisp-js", prefix: "/vendor/wisp/", sub: "dist" },
  { id: "bare-transport", label: "bare-transport", pkg: "@mercuryworkshop/bare-transport", prefix: "/bare/", sub: "dist" },
  { id: "bare-mux", label: "bare-mux", pkg: "@mercuryworkshop/bare-mux", prefix: "/baremux/", sub: "dist" },
];

const byId = new Map(TRANSPORT_PACKAGES.map((item) => [item.id, item]));

function transportPackage(id) {
  return byId.get(String(id || "")) || null;
}

function bundledVersion(item) {
  try {
    const file = path.join(modulePath(...item.pkg.split("/")), "package.json");
    return JSON.parse(fs.readFileSync(file, "utf8")).version || "";
  } catch {
    return "";
  }
}

function isValidVersion(value) {
  return /^\d+\.\d+\.\d+([.+-][0-9A-Za-z.-]+)?$/.test(String(value || ""));
}

module.exports = {
  TRANSPORT_PACKAGES,
  transportPackage,
  bundledVersion,
  isValidVersion,
};
