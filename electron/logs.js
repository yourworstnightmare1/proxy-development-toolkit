"use strict";

const fs = require("fs");
const path = require("path");

const buckets = {
  browser: [],
  proxy: [],
  wisp: [],
  network: [],
  performance: [],
  system: [],
  application: [],
};

const LIMIT = 4000;
let fileDir = "";
let flags = {
  logAll: true,
  logNetwork: true,
  logConsole: true,
  logPerformance: false,
  logSystem: false,
  logApplication: true,
};

function stamp(line) {
  return `[${new Date().toISOString()}] ${line}`;
}

function setFlags(next) {
  flags = {
    logAll: next.logAll !== false,
    logNetwork: next.logNetwork !== false,
    logConsole: next.logConsole !== false,
    logPerformance: Boolean(next.logPerformance),
    logSystem: Boolean(next.logSystem),
    logApplication: next.logApplication !== false,
  };
}

function setLogLocation(dir) {
  fileDir = String(dir || "").trim();
  if (fileDir) {
    try {
      fs.mkdirSync(fileDir, { recursive: true });
    } catch { /* ignore */ }
  }
}

function allowed(kind) {
  if (flags.logAll) return true;
  if (kind === "network") return flags.logNetwork;
  if (kind === "browser" || kind === "proxy") return flags.logConsole;
  if (kind === "performance") return flags.logPerformance;
  if (kind === "system") return flags.logSystem;
  if (kind === "application" || kind === "wisp") return flags.logApplication;
  return true;
}

function appendFile(kind, line) {
  if (!fileDir) return;
  try {
    fs.appendFileSync(path.join(fileDir, `${kind}.log`), `${line}\n`, "utf8");
  } catch { /* ignore */ }
}

function push(kind, line) {
  if (!allowed(kind)) return;
  const list = buckets[kind];
  if (!list) return;
  const stamped = stamp(line);
  list.push(stamped);
  if (list.length > LIMIT) list.splice(0, list.length - LIMIT);
  appendFile(kind, stamped);
}

function text(kind, limit) {
  const list = buckets[kind] || [];
  if (!limit || list.length <= limit) return list.join("\n");
  return list.slice(-limit).join("\n");
}

function formatArg(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

let wispEnabled = () => false;

function setWispCapture(enabled) {
  wispEnabled = typeof enabled === "function" ? enabled : () => Boolean(enabled);
}

function isWispLine(textLine) {
  return /\[\d{4}\/\d{2}\/\d{2} - \d{2}:\d{2}:\d{2}\] (debug|info|log|warn|error):/.test(textLine);
}

function hookConsole() {
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      const body = args.map(formatArg).join(" ");
      push("application", `${level}: ${body}`);
      if (wispEnabled() && isWispLine(body)) push("wisp", body);
      original(...args);
    };
  }
}

function isProxySource(sourceId) {
  const value = String(sourceId || "");
  return /\/uv\/|\/vendor\/scramjet|\/vendor\/controller|\/sw\.js|service-worker|scramjet|ultraviolet/i.test(value);
}

function captureContents(contents) {
  if (!contents || contents.isDestroyed?.()) return;
  contents.on("console-message", (details) => {
    const source = details.sourceId || "";
    const body = details.message || "";
    const where = `${source}:${details.lineNumber || 0}`;
    const kind = isProxySource(source) || isProxySource(body) ? "proxy" : "browser";
    push(kind, `${body} (${where})`);
  });
}

function pushNetwork(event) {
  if (!event) return;
  const parts = [
    event.phase || "",
    event.method || event.source || "",
    event.status || "",
    event.url || "",
    event.error || "",
    event.bytes ? `${event.bytes}B` : "",
    event.pane || "",
  ].filter(Boolean);
  push("network", parts.join(" "));
}

function hookWisp(_logging, enabled) {
  setWispCapture(enabled);
}

module.exports = {
  push,
  text,
  hookConsole,
  captureContents,
  hookWisp,
  setWispCapture,
  setFlags,
  setLogLocation,
  pushNetwork,
  buckets,
};
