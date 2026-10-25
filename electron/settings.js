"use strict";

const fs = require("fs/promises");
const net = require("net");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const AdmZip = require("adm-zip");
const { modulePath, setVendorOverride } = require("./paths");
const { TRANSPORT_PACKAGES, transportPackage, bundledVersion, isValidVersion } = require("./transports");
const { compareVersions } = require("./updates");
const { downloadToBuffer } = require("./downloads");

const FILE = "pdtk-settings.json";
const UV_REPO = "titaniumnetwork-dev/Ultraviolet";
const SJ_REPO = "MercuryWorkshop/scramjet";
const BUNDLED_UV = "v3.2.10-headers";
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
  pythonPort: "8000",
  nodePort: "3001",
  scramjetPreferContinuous: false,
  scramjetContinuousCommit: "",
  appPreferPrerelease: false,
  transportPreferPrerelease: false,
  appCompileFromSource: false,
  // Transport id -> npm version downloaded over the bundled copy.
  transportVersions: {},
  hostWispLocally: false,
  wispPort: "",
  logWispTraffic: true,
  devtools: true,
  eruda: false,
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
  mcpLaunchOnStartup: false,
  // Test combos (proxy + transport matrix)
  testCombos: [
    {
      id: "combo-default",
      label: "",
      enabled: true,
      proxyKind: "scramjet",
      transport: "epoxy-tls",
    },
  ],
  // Launch tweaks
  tweakTabCloaking: false,
  tweakTabIconMode: "url",
  tweakTabIconUrl: "",
  tweakTabIconDataUrl: "",
  tweakTabName: "",
  tweakSiteCloaking: false,
  tweakSiteCloakMode: "about:blank",
  tweakLoadInIframe: false,
  tweakWispVerbose: false,
  tweakWispVerboseMinimized: false,
  tweakWispVerboseSigint: true,
  tweakProxyVerbose: false,
  tweakProxyVerboseMinimized: false,
  tweakProxyVerboseSigint: true,
  tweakTransportVerbose: false,
  tweakTransportVerboseMinimized: false,
  tweakTransportVerboseSigint: true,
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
  await fs.mkdir(vendorDir("transports"), { recursive: true });
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
    pythonPort: portText(source.pythonPort) || DEFAULTS.pythonPort,
    nodePort: portText(source.nodePort) || DEFAULTS.nodePort,
    scramjetPreferContinuous: Boolean(source.scramjetPreferContinuous),
    scramjetContinuousCommit: String(source.scramjetContinuousCommit || "").trim(),
    appPreferPrerelease: Boolean(source.appPreferPrerelease),
    transportPreferPrerelease: Boolean(source.transportPreferPrerelease),
    appCompileFromSource: Boolean(source.appCompileFromSource),
    transportVersions: normalizeTransportVersions(source.transportVersions),
    hostWispLocally: Boolean(source.hostWispLocally),
    wispPort: portText(source.wispPort),
    logWispTraffic: source.logWispTraffic !== false,
    devtools: source.devtools !== false,
    eruda: Boolean(source.eruda),
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
    mcpLaunchOnStartup: Boolean(source.mcpLaunchOnStartup),
    testCombos: normalizeTestCombos(
      Object.prototype.hasOwnProperty.call(source, "testCombos") ? source.testCombos : DEFAULTS.testCombos
    ),
    tweakTabCloaking: Boolean(source.tweakTabCloaking),
    tweakTabIconMode: source.tweakTabIconMode === "file" ? "file" : "url",
    tweakTabIconUrl: String(source.tweakTabIconUrl || "").trim(),
    tweakTabIconDataUrl: String(source.tweakTabIconDataUrl || "").trim(),
    tweakTabName: String(source.tweakTabName || "").trim(),
    tweakSiteCloaking: Boolean(source.tweakSiteCloaking),
    tweakSiteCloakMode: source.tweakSiteCloakMode === "blob:https" ? "blob:https" : "about:blank",
    tweakLoadInIframe: Boolean(source.tweakLoadInIframe),
    tweakWispVerbose: Boolean(source.tweakWispVerbose),
    tweakWispVerboseMinimized: Boolean(source.tweakWispVerboseMinimized),
    tweakWispVerboseSigint: source.tweakWispVerboseSigint !== false,
    tweakProxyVerbose: Boolean(source.tweakProxyVerbose),
    tweakProxyVerboseMinimized: Boolean(source.tweakProxyVerboseMinimized),
    tweakProxyVerboseSigint: source.tweakProxyVerboseSigint !== false,
    tweakTransportVerbose: Boolean(source.tweakTransportVerbose),
    tweakTransportVerboseMinimized: Boolean(source.tweakTransportVerboseMinimized),
    tweakTransportVerboseSigint: source.tweakTransportVerboseSigint !== false,
  };
}

function normalizeTransportVersions(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, version] of Object.entries(raw)) {
    if (transportPackage(id) && isValidVersion(version)) out[id] = String(version);
  }
  return out;
}

const TRANSPORT_IDS = new Set([
  "epoxy-tls",
  "wisp-js",
  "libcurl-transport",
  "bare-transport",
  "bare-mux",
]);

function normalizeTestCombos(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const id = String(item.id || "").trim() || `combo-${out.length + 1}`;
    const proxyKind = item.proxyKind === "ultraviolet" ? "ultraviolet" : "scramjet";
    const transport = TRANSPORT_IDS.has(item.transport) ? item.transport : "epoxy-tls";
    out.push({
      id,
      label: String(item.label || "").trim(),
      enabled: Boolean(item.enabled),
      proxyKind,
      transport,
    });
  }
  return out;
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
  if (kind === "ultraviolet") {
    return (
      id === BUNDLED_UV
      || id === "v3.2.10-headers"
      || id === "3.2.10-headers"
      || id === "v3.2.10"
      || id === "3.2.10"
    );
  }
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

function downloadBuffer(url, onProgress) {
  return downloadToBuffer(url, {
    headers: githubHeaders(),
    onProgress,
    max: MAX_DOWNLOAD,
    tooLarge: "Download is larger than 40 MB.",
  });
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

// `progress(label)` optionally returns a per-file progress callback.
async function downloadRelease(kind, id, progress) {
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
  const kindLabel = kind === "ultraviolet" ? "Ultraviolet" : "Scramjet";
  const releaseLabel = release.tag_name === "latest" ? "continuous build" : release.tag_name;
  const buffer = await downloadBuffer(url, progress && progress(`${kindLabel} ${releaseLabel}`));
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
      const controllerBuffer = await downloadBuffer(controllerUrl, progress && progress(`Scramjet controller ${releaseLabel}`));
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

function transportServeDir(item, version) {
  return path.join(vendorDir("transports"), item.id, version, "package", item.sub);
}

async function downloadTransport(id, version, progress, { reuse = false } = {}) {
  const item = transportPackage(id);
  if (!item) throw new Error(`Unknown transport "${id}".`);
  if (reuse && isValidVersion(version) && await isTransportInstalled(item, version)) {
    return { ok: true, id: item.id, version, reused: true };
  }
  const response = await fetch(`https://registry.npmjs.org/${item.pkg}/${encodeURIComponent(version || "latest")}`, {
    headers: { Accept: "application/json", "User-Agent": "proxy-development-toolkit" },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`npm returned ${response.status} for ${item.pkg}.`);
  const meta = await response.json();
  const resolved = String(meta.version || "");
  const tarball = meta.dist && meta.dist.tarball;
  if (!isValidVersion(resolved) || !tarball) throw new Error(`npm has no downloadable build of ${item.pkg}.`);
  const dest = path.join(vendorDir("transports"), item.id, resolved);
  const buffer = await downloadBuffer(tarball, progress && progress(`${item.label} ${resolved}`));
  if (meta.dist.integrity && /^sha512-/.test(meta.dist.integrity)) {
    const digest = `sha512-${crypto.createHash("sha512").update(buffer).digest("base64")}`;
    if (digest !== meta.dist.integrity) throw new Error(`${item.pkg} ${resolved} failed its integrity check.`);
  }
  await extractArchive(buffer, dest);
  try {
    await fs.access(transportServeDir(item, resolved));
  } catch {
    await fs.rm(dest, { recursive: true, force: true });
    throw new Error(`${item.pkg} ${resolved} does not include a ${item.sub}/ folder.`);
  }
  return { ok: true, id: item.id, version: resolved };
}

const TRANSPORT_LIST_MS = 10 * 60 * 1000;
const TRANSPORT_LIST_LIMIT = 40;
let transportListCache = { at: 0, remote: null };

async function isTransportInstalled(item, version) {
  try {
    await fs.access(transportServeDir(item, version));
    return true;
  } catch {
    return false;
  }
}

async function fetchTransportVersions(item) {
  const response = await fetch(`https://registry.npmjs.org/${item.pkg}`, {
    headers: { Accept: "application/vnd.npm.install-v1+json", "User-Agent": "proxy-development-toolkit" },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`npm returned ${response.status} for ${item.pkg}`);
  const doc = await response.json();
  const latest = doc["dist-tags"] && doc["dist-tags"].latest;
  const versions = Object.entries(doc.versions || {})
    .filter(([version, meta]) => isValidVersion(version) && !(meta && meta.deprecated))
    .map(([version]) => version)
    .sort(newestFirst);
  return { latest, versions };
}

function newestFirst(a, b) {
  const core = compareVersions(b.split("-")[0], a.split("-")[0]);
  if (core) return core;
  const preA = a.includes("-");
  const preB = b.includes("-");
  if (preA !== preB) return preA ? 1 : -1;
  return compareVersions(b, a);
}

// Per transport: "bundled" plus recent npm versions, flagged when already downloaded.
async function listTransportVersions(settings = {}, { force = false } = {}) {
  const now = Date.now();
  if (force || !transportListCache.remote || now - transportListCache.at > TRANSPORT_LIST_MS) {
    const remote = {};
    await Promise.all(TRANSPORT_PACKAGES.map(async (item) => {
      try {
        remote[item.id] = await fetchTransportVersions(item);
      } catch (error) {
        remote[item.id] = { error: error.message || String(error), versions: [] };
      }
    }));
    transportListCache = { at: now, remote };
  }
  const selected = settings.transportVersions || {};
  return Promise.all(TRANSPORT_PACKAGES.map(async (item) => {
    const bundled = bundledVersion(item);
    const remote = transportListCache.remote[item.id] || { versions: [] };
    const ids = remote.versions.filter((version) => version !== bundled).slice(0, TRANSPORT_LIST_LIMIT);
    const current = selected[item.id];
    if (current && current !== bundled && !ids.includes(current)) ids.push(current);
    const bundledTag = bundled && bundled === remote.latest ? " · latest" : "";
    const versions = [{ id: "bundled", label: `Bundled (${bundled || "unknown"})${bundledTag}`, installed: true }];
    for (const version of ids) {
      const tags = [];
      if (version === remote.latest) tags.push("latest");
      if (/-[0-9]*[a-z]/i.test(version)) tags.push("pre-release");
      versions.push({
        id: version,
        label: tags.length ? `${version} · ${tags.join(" · ")}` : version,
        installed: await isTransportInstalled(item, version),
      });
    }
    return {
      id: item.id,
      label: item.label,
      pkg: item.pkg,
      bundledVersion: bundled,
      selected: current || "bundled",
      versions,
      error: remote.error || "",
    };
  }));
}

async function transportOverrides(settings) {
  const overrides = [];
  for (const item of TRANSPORT_PACKAGES) {
    const version = settings.transportVersions && settings.transportVersions[item.id];
    let root = null;
    if (version) {
      const dir = transportServeDir(item, version);
      try {
        await fs.access(dir);
        root = dir;
      } catch { /* missing download; fall back to bundled */ }
    }
    overrides.push([item.prefix, root]);
  }
  return overrides;
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
  for (const [prefix, root] of await transportOverrides(settings)) setVendorOverride(prefix, root);
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
  downloadTransport,
  listTransportVersions,
  applyMounts,
  bundledRoots,
  wispDisplay,
  listenPlan,
  bundledMatch,
  isVersionInstalled,
  defaultDownloadsPath,
  newMcpToken,
};
