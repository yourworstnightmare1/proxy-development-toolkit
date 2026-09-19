"use strict";

const fs = require("fs/promises");
const net = require("net");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const AdmZip = require("adm-zip");
const { modulePath, setVendorOverride } = require("./paths");

const FILE = "pdtk-settings.json";
const UV_REPO = "titaniumnetwork-dev/Ultraviolet";
const SJ_REPO = "MercuryWorkshop/scramjet";
const BUNDLED_UV = "v3.2.10";
const BUNDLED_SJ = "v2.0.67-alpha.2";
const MAX_DOWNLOAD = 40 * 1024 * 1024;

function defaultDownloadsPath() {
  return path.join(os.homedir(), "Downloads");
}

function newMcpToken() {
  return crypto.randomBytes(24).toString("hex");
}

const DEFAULTS = {
  uvVersion: "bundled",
  uvPort: "8080",
  scramjetVersion: "bundled",
  scramjetPort: "3000",
  hostWispLocally: false,
  wispPort: "",
  logWispTraffic: true,
  devtools: true,
  // Browser
  uaOs: "Windows",
  uaBrowser: "Chrome",
  uaCustomOs: "",
  uaCustomBrowser: "",
  screenOrientation: "landscape",
  screenWidth: 1920,
  screenHeight: 1080,
  allowMultipleTabs: false,
  allowUrlModification: true,
  allowSiteRedirects: true,
  // Security
  sitePermissions: {},
  forceHttps: true,
  allowIndexedDb: true,
  allowDownloading: true,
  downloadLocation: "",
  // Developer logging
  logAll: true,
  logNetwork: true,
  logConsole: true,
  logPerformance: false,
  logSystem: false,
  logApplication: true,
  logLocation: "",
  // MCP
  mcpEnabled: false,
  mcpPort: "7432",
  mcpToken: "",
  mcpAllowControl: true,
};

let rootDir = "";
let cache = { at: 0, ultraviolet: null, scramjet: null };

function userFile() {
  return path.join(rootDir, FILE);
}

function vendorDir(kind) {
  return path.join(rootDir, "vendors", kind);
}

async function init(userData) {
  rootDir = userData;
  await fs.mkdir(vendorDir("ultraviolet"), { recursive: true });
  await fs.mkdir(vendorDir("scramjet"), { recursive: true });
  return load();
}

async function load() {
  try {
    const raw = await fs.readFile(userFile(), "utf8");
    return normalize({ ...DEFAULTS, ...JSON.parse(raw) });
  } catch {
    return { ...DEFAULTS };
  }
}

async function write(settings) {
  const next = normalize(settings);
  await fs.mkdir(rootDir, { recursive: true });
  await fs.writeFile(userFile(), JSON.stringify(next, null, 2));
  return next;
}

function normalize(input) {
  const source = input || {};
  const width = Math.max(1, Number(source.screenWidth) || DEFAULTS.screenWidth);
  const height = Math.max(1, Number(source.screenHeight) || DEFAULTS.screenHeight);
  const permissions = source.sitePermissions && typeof source.sitePermissions === "object"
    ? source.sitePermissions
    : {};
  let mcpToken = String(source.mcpToken || "").trim();
  if (!mcpToken) mcpToken = newMcpToken();
  return {
    uvVersion: String(source.uvVersion || DEFAULTS.uvVersion),
    uvPort: portText(source.uvPort) || DEFAULTS.uvPort,
    scramjetVersion: String(source.scramjetVersion || DEFAULTS.scramjetVersion),
    scramjetPort: portText(source.scramjetPort) || DEFAULTS.scramjetPort,
    hostWispLocally: Boolean(source.hostWispLocally),
    wispPort: portText(source.wispPort),
    logWispTraffic: source.logWispTraffic !== false,
    devtools: source.devtools !== false,
    uaOs: String(source.uaOs || DEFAULTS.uaOs),
    uaBrowser: String(source.uaBrowser || DEFAULTS.uaBrowser),
    uaCustomOs: String(source.uaCustomOs || ""),
    uaCustomBrowser: String(source.uaCustomBrowser || ""),
    screenOrientation: source.screenOrientation === "portrait" ? "portrait" : "landscape",
    screenWidth: width,
    screenHeight: height,
    allowMultipleTabs: Boolean(source.allowMultipleTabs),
    allowUrlModification: source.allowUrlModification !== false,
    allowSiteRedirects: source.allowSiteRedirects !== false,
    sitePermissions: permissions,
    forceHttps: source.forceHttps !== false,
    allowIndexedDb: source.allowIndexedDb !== false,
    allowDownloading: source.allowDownloading !== false,
    downloadLocation: String(source.downloadLocation || "").trim() || defaultDownloadsPath(),
    logAll: source.logAll !== false,
    logNetwork: source.logNetwork !== false,
    logConsole: source.logConsole !== false,
    logPerformance: Boolean(source.logPerformance),
    logSystem: Boolean(source.logSystem),
    logApplication: source.logApplication !== false,
    logLocation: String(source.logLocation || "").trim(),
    mcpEnabled: Boolean(source.mcpEnabled),
    mcpPort: portText(source.mcpPort) || DEFAULTS.mcpPort,
    mcpToken,
    mcpAllowControl: source.mcpAllowControl !== false,
  };
}

function portText(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return raw;
}

function parsePort(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return { ok: true, empty: true, port: null };
  if (!/^\d+$/.test(raw)) {
    return { ok: false, message: "Enter a port number between 1 and 65535." };
  }
  const port = Number(raw);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    return { ok: false, message: "Enter a port number between 1 and 65535." };
  }
  return { ok: true, empty: false, port };
}

/**
 * Same integrity check Bavarium uses: something accepts TCP on 127.0.0.1:port
 * when a connect succeeds. ECONNREFUSED means the port is free.
 */
function checkPortInUse(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (result) => {
      try {
        socket.destroy();
      } catch { /* ignore */ }
      resolve(result);
    };
    socket.setTimeout(500);
    socket.once("connect", () => done({ inUse: true }));
    socket.once("timeout", () => done({ inUse: false }));
    socket.once("error", (err) => {
      if (err.code === "ECONNREFUSED") {
        done({ inUse: false });
        return;
      }
      done({ inUse: false, bindError: err.message });
    });
    socket.connect(port, "127.0.0.1");
  });
}

async function inspectPort(value, ours) {
  const parsed = parsePort(value);
  if (!parsed.ok || parsed.empty) return parsed;
  if (ours && ours(parsed.port)) {
    return { ok: true, port: parsed.port, inUse: false, isOurs: true };
  }
  const result = await checkPortInUse(parsed.port);
  if (result.bindError) {
    return { ok: false, port: parsed.port, message: `Could not check port: ${result.bindError}` };
  }
  if (result.inUse) {
    return {
      ok: false,
      port: parsed.port,
      inUse: true,
      message: `Port ${parsed.port} is already in use by another process.`,
    };
  }
  return { ok: true, port: parsed.port, inUse: false };
}

function safeTag(tag) {
  const clean = String(tag || "").trim().replace(/[^A-Za-z0-9._-]/g, "");
  if (!clean || clean.length > 80) throw new Error("Invalid version.");
  return clean;
}

function bundledMatch(kind, id) {
  if (!id || id === "bundled") return true;
  if (kind === "ultraviolet") return id === BUNDLED_UV || id === "3.2.10";
  return id === "continuous" || id === "latest" || id === BUNDLED_SJ || id === "2.0.67-alpha.2";
}

async function readMeta(kind, tag) {
  try {
    const raw = await fs.readFile(path.join(vendorDir(kind), safeTag(tag), "meta.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function downloadedRoot(kind, tag) {
  const meta = await readMeta(kind, tag);
  if (!meta || !meta.serveRoot) return null;
  const full = path.resolve(vendorDir(kind), safeTag(tag), meta.serveRoot);
  try {
    const stat = await fs.stat(full);
    if (stat.isDirectory()) return { root: full, folder: path.join(vendorDir(kind), safeTag(tag)), controller: meta.controllerRoot || "" };
  } catch { /* missing */ }
  return null;
}

async function listDownloaded(kind) {
  try {
    return await fs.readdir(vendorDir(kind));
  } catch {
    return [];
  }
}

function githubHeaders() {
  return {
    "User-Agent": "proxy-development-toolkit",
    Accept: "application/vnd.github+json",
  };
}

async function fetchReleases(repo) {
  const all = [];
  for (let page = 1; page <= 5; page += 1) {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`,
      { headers: githubHeaders(), signal: AbortSignal.timeout(8000) }
    );
    if (!response.ok) throw new Error(`GitHub returned ${response.status} for ${repo}`);
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error(`GitHub did not return a release list for ${repo}`);
    all.push(...batch.filter((item) => item && !item.draft));
    if (batch.length < 100) break;
  }
  return all;
}

async function remoteReleases(kind) {
  const now = Date.now();
  if (cache[kind] && now - cache.at < 5 * 60 * 1000) return cache[kind];
  const repo = kind === "ultraviolet" ? UV_REPO : SJ_REPO;
  const releases = await fetchReleases(repo);
  cache[kind] = releases;
  cache.at = now;
  return releases;
}

function assetUrl(release, matcher) {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const match = assets.find((asset) => matcher(String(asset.name || "")));
  return match ? match.browser_download_url : "";
}

async function versionsFor(kind) {
  const downloaded = new Set(await listDownloaded(kind));
  const versions = [];
  const seen = new Set();
  const push = (item) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    versions.push(item);
  };
  if (kind === "ultraviolet") {
    push({
      id: "bundled",
      tag: BUNDLED_UV,
      label: `${BUNDLED_UV} (installed)`,
      installed: true,
      recommended: false,
      local: "bundled",
    });
  } else {
    push({
      id: "continuous",
      tag: "latest",
      label: "Continuous Build (installed)",
      installed: true,
      recommended: false,
      local: "bundled",
    });
    push({
      id: "bundled",
      tag: BUNDLED_SJ,
      label: `${BUNDLED_SJ} (installed)`,
      installed: true,
      recommended: false,
      local: "bundled",
    });
  }
  let remoteError = "";
  let releases = [];
  try {
    releases = await remoteReleases(kind);
  } catch (error) {
    remoteError = error.message || String(error);
  }
  for (const release of releases) {
    const tag = String(release.tag_name || "");
    if (!tag) continue;
    const continuous = kind === "scramjet" && (tag === "latest" || /continuous/i.test(release.name || "") || /continuous/i.test(tag));
    const id = continuous ? "continuous" : tag;
    const tagKey = String(tag).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 80);
    const idKey = String(id).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 80);
    const installed = (tagKey && downloaded.has(tagKey)) || (idKey && downloaded.has(idKey)) || bundledMatch(kind, id) || bundledMatch(kind, tag);
    const name = release.name && release.name !== tag ? `${tag} — ${release.name}` : tag;
    push({
      id,
      tag,
      label: installed ? `${name} (installed)` : name,
      installed,
      recommended: false,
      local: installed && !(tagKey && downloaded.has(tagKey)) ? "bundled" : installed ? "download" : "",
    });
  }
  for (const tag of downloaded) {
    if (seen.has(tag)) continue;
    push({
      id: tag,
      tag,
      label: `${tag} (installed)`,
      installed: true,
      recommended: false,
      local: "download",
    });
  }
  const latestRelease = releases.find((release) => {
    const tag = String(release.tag_name || "");
    if (!tag) return false;
    return !(kind === "scramjet" && (tag === "latest" || /continuous/i.test(release.name || "") || /continuous/i.test(tag)));
  });
  if (latestRelease) {
    const tag = String(latestRelease.tag_name);
    const match = versions.find((item) => item.id === tag || item.tag === tag);
    if (match) match.recommended = true;
  }
  return { versions, error: remoteError };
}

async function listReleases() {
  const [ultraviolet, scramjet] = await Promise.all([
    versionsFor("ultraviolet").catch((error) => ({ versions: [], error: error.message || String(error) })),
    versionsFor("scramjet").catch((error) => ({ versions: [], error: error.message || String(error) })),
  ]);
  return { ultraviolet, scramjet };
}

function findServeDir(dir, marker) {
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = require("fs").readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === marker)) return current;
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== "node_modules") stack.push(path.join(current, entry.name));
    }
  }
  return "";
}

function extractTar(buffer, dest) {
  const fsSync = require("fs");
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0/g, "").trim() || "0", 8) || 0;
    const type = String.fromCharCode(header[156]);
    offset += 512;
    const data = buffer.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if (!fullName || fullName.includes("..")) continue;
    const out = path.join(dest, fullName);
    if (type === "5" || fullName.endsWith("/")) {
      fsSync.mkdirSync(out, { recursive: true });
    } else if (type === "0" || type === "\0") {
      fsSync.mkdirSync(path.dirname(out), { recursive: true });
      fsSync.writeFileSync(out, data);
    }
  }
}

async function downloadBuffer(url) {
  const response = await fetch(url, { headers: githubHeaders(), redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > MAX_DOWNLOAD) throw new Error("Download is larger than 40 MB.");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_DOWNLOAD) throw new Error("Download is larger than 40 MB.");
  return buffer;
}

async function extractArchive(buffer, dest) {
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(dest, { recursive: true });
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    const tar = zlib.gunzipSync(buffer);
    extractTar(tar, dest);
    return;
  }
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
    const zip = new AdmZip(buffer);
    zip.extractAllTo(dest, true);
    return;
  }
  throw new Error("Release file is not a zip or gzip archive.");
}

function pickAsset(release, kind) {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const core = assets.find((asset) => {
    const name = String(asset.name || "").toLowerCase();
    if (!/\.(tgz|tar\.gz|zip)$/.test(name) && !name.endsWith(".tgz")) return false;
    if (name.includes("controller")) return false;
    if (kind === "ultraviolet") return name.includes("ultraviolet") || name.endsWith(".tgz") || name.endsWith(".zip");
    return name.includes("scramjet");
  });
  if (core) return core.browser_download_url;
  if (release.zipball_url) return release.zipball_url;
  return "";
}

async function downloadRelease(kind, id) {
  const selection = String(id || "");
  if (bundledMatch(kind, selection) && selection !== "latest") {
    return { ok: true, installed: true, usedBundled: true };
  }
  const releases = await remoteReleases(kind);
  const release = releases.find((item) => {
    const tag = item.tag_name;
    if (kind === "scramjet" && (selection === "continuous" || selection === "latest")) {
      return tag === "latest" || /continuous/i.test(item.name || "");
    }
    return tag === selection || item.tag_name === selection;
  });
  if (!release) throw new Error("That release is not in the GitHub list.");
  const url = pickAsset(release, kind);
  if (!url) throw new Error("That release has no downloadable archive.");
  const tag = safeTag(release.tag_name);
  const dest = path.join(vendorDir(kind), tag);
  const buffer = await downloadBuffer(url);
  await extractArchive(buffer, dest);
  const marker = kind === "ultraviolet" ? "uv.bundle.js" : "scramjet.js";
  const serve = findServeDir(dest, marker) || findServeDir(dest, kind === "scramjet" ? "scramjet.mjs" : "uv.handler.js");
  if (!serve) {
    await fs.rm(dest, { recursive: true, force: true });
    throw new Error("Downloaded release did not include built files.");
  }
  let controllerRoot = "";
  if (kind === "scramjet") {
    const controllerUrl = assetUrl(release, (name) => /controller.+\.tgz$/i.test(name) || /scramjet-controller/i.test(name));
    if (controllerUrl) {
      const controllerDest = path.join(dest, "controller");
      const controllerBuffer = await downloadBuffer(controllerUrl);
      await extractArchive(controllerBuffer, controllerDest);
      const controllerServe = findServeDir(controllerDest, "controller.sw.js") || findServeDir(controllerDest, "scramjet-controller.js");
      if (controllerServe) controllerRoot = path.relative(dest, controllerServe);
    }
  }
  await fs.writeFile(path.join(dest, "meta.json"), JSON.stringify({
    tag: release.tag_name,
    serveRoot: path.relative(dest, serve),
    controllerRoot,
  }, null, 2));
  cache.at = 0;
  return { ok: true, installed: true, id: release.tag_name === "latest" ? "continuous" : release.tag_name };
}

async function isVersionInstalled(kind, id) {
  if (bundledMatch(kind, id)) return true;
  const tag = kind === "scramjet" && (id === "continuous" || id === "latest") ? "latest" : id;
  try {
    return Boolean(await downloadedRoot(kind, tag));
  } catch {
    return false;
  }
}

async function resolveServe(kind, selection) {
  const id = String(selection || "bundled");
  if (id === "bundled") return null;
  const tag = kind === "scramjet" && (id === "continuous" || id === "latest") ? "latest" : id;
  const downloaded = await downloadedRoot(kind, tag);
  if (downloaded) return downloaded;
  if (bundledMatch(kind, id)) return null;
  return null;
}

async function applyMounts(settings) {
  const uv = await resolveServe("ultraviolet", settings.uvVersion);
  const sj = await resolveServe("scramjet", settings.scramjetVersion);
  setVendorOverride("/uv/", uv && uv.root);
  setVendorOverride("/vendor/scramjet/", sj && sj.root);
  if (sj && sj.controller && sj.folder) {
    setVendorOverride("/vendor/controller/", path.resolve(sj.folder, sj.controller));
  } else {
    setVendorOverride("/vendor/controller/", null);
  }
}

function bundledRoots() {
  return {
    ultraviolet: modulePath("@titaniumnetwork-dev", "ultraviolet", "dist"),
    scramjet: modulePath("@mercuryworkshop", "scramjet", "dist"),
  };
}

function lanAddresses() {
  const found = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      const family = entry.family === 4 || entry.family === "IPv4";
      if (!family || entry.internal) continue;
      found.push(entry.address);
    }
  }
  return found;
}

function wispDisplay(hosting, port) {
  if (!hosting) return { hosting: false, url: "", text: "Hosting is off." };
  const addresses = lanAddresses();
  const address = addresses[0] || "0.0.0.0";
  const url = `ws://${address}:${port}/`;
  const extra = addresses.length > 1 ? ` Other LAN addresses: ${addresses.slice(1).join(", ")}.` : "";
  return { hosting: true, url, text: `${url}${extra}` };
}

function listenPlan(settings) {
  const uv = parsePort(settings.uvPort);
  const sj = parsePort(settings.scramjetPort);
  const uvPort = uv.ok && !uv.empty ? uv.port : 0;
  const sjPort = sj.ok && !sj.empty ? sj.port : 0;
  const primary = uvPort || sjPort || 0;
  const extra = uvPort && sjPort && uvPort !== sjPort ? (primary === uvPort ? sjPort : uvPort) : 0;
  return { primary, extra, uvPort, sjPort };
}

module.exports = {
  DEFAULTS,
  init,
  load,
  write,
  normalize,
  parsePort,
  checkPortInUse,
  inspectPort,
  listReleases,
  downloadRelease,
  applyMounts,
  bundledRoots,
  wispDisplay,
  listenPlan,
  bundledMatch,
  isVersionInstalled,
  defaultDownloadsPath,
  newMcpToken,
};
