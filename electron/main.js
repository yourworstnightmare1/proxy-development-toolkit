"use strict";

const { app, BrowserWindow, WebContentsView, dialog, ipcMain, session, shell } = require("electron");
const fs = require("fs/promises");
const http = require("http");
const path = require("path");
const { createStaticServer, setSession, getSession } = require("./server");
const settingsStore = require("./settings");
const logs = require("./logs");
const mcpServer = require("./mcp-server");
const mcpBridge = require("./mcp-bridge");
const { buildUserAgent } = require("./user-agent");
const buildInfo = require("./build-info");
const attributions = require("./attributions");
const { attachDebugger } = require("./network");
const { installSaveAsPrompt, popupPageContextMenu } = require("./context-menu");
const {
  newId,
  isGitUrl,
  gitAvailable,
  cloneGit,
  copyFolder,
  downloadUrl,
  detectProxy,
} = require("./imports");

app.commandLine.appendSwitch("remote-debugging-port", "9333");
logs.hookConsole();

let mainWindow = null;
let appSettings = null;
let listenPort = 0;
let extraPort = 0;
let extraServer = null;
let lanWisp = null;
let portNotice = "";
let devtoolsEnabled = true;
let wispServer = null;
let wispLogging = null;
let applyLanHost = async () => settingsStore.wispDisplay(false, 0);
let inspectView = null;
let inspectHosted = false;
let inspectOpen = false;
let inspectSlot = "right";
let rendererOwnsInspect = false;
let lastInspectBounds = null;
let origin = "";
let importsRoot = "";
let paneLeftServer = null;
let paneLeftPort = 0;
let paneRightServer = null;
let paneRightPort = 0;

function sendNetwork(event) {
  logs.pushNetwork(event);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("network-event", event);
  }
}

async function importRootFor(kind) {
  const root = kind === "site"
    ? path.join(importsRoot, "sites")
    : path.join(importsRoot, "imports", "proxies");
  await fs.mkdir(root, { recursive: true });
  return root;
}

function publicBase(kind, id) {
  return kind === "site" ? `sites/${id}` : `imports/proxies/${id}`;
}

async function finishImport(kind, dir) {
  if (kind === "proxy") {
    const detected = await detectProxy(dir);
    return detected;
  }
  return { kind: "site" };
}

function registerIpc() {
  ipcMain.handle("boot", () => ({
    origin,
    ...runtimeState(),
  }));
  ipcMain.handle("get-settings", () => runtimeState());
  ipcMain.handle("get-attributions", () => attributions.list());
  ipcMain.handle("get-attribution-license", (_event, id) => attributions.licenseText(id));
  ipcMain.handle("open-external", async (_event, url) => {
    const target = String(url || "").trim();
    if (!/^https?:\/\//i.test(target)) throw new Error("Only http(s) links can be opened.");
    await shell.openExternal(target);
    return true;
  });
  ipcMain.handle("list-releases", () => settingsStore.listReleases());
  ipcMain.handle("check-port", async (_event, payload) => {
    const field = payload && payload.field;
    const ours = (port) => {
      if (field === "wisp") return Boolean(lanWisp && lanWisp.address() && lanWisp.address().port === port);
      if (field === "mcp") return mcpServer.status().running && port === mcpServer.status().port;
      return port === listenPort || port === extraPort || port === paneLeftPort || port === paneRightPort;
    };
    const result = await settingsStore.inspectPort(payload && payload.port, ours);
    if (field === "wisp" && result.ok && result.port && (result.port === listenPort || result.port === extraPort)) {
      return { ok: false, message: `Port ${result.port} is already in use by this app's local server.` };
    }
    return result;
  });
  ipcMain.handle("download-release", async (_event, payload) => {
    const kind = payload && payload.kind === "scramjet" ? "scramjet" : "ultraviolet";
    const result = await settingsStore.downloadRelease(kind, payload && (payload.id || payload.tag));
    if (payload && payload.select && appSettings) {
      const key = kind === "ultraviolet" ? "uvVersion" : "scramjetVersion";
      appSettings = await settingsStore.write({ ...appSettings, [key]: result.id || payload.id });
      await settingsStore.applyMounts(appSettings);
    }
    return { ...result, state: runtimeState() };
  });
  ipcMain.handle("save-settings", async (_event, patch) => {
    const next = settingsStore.normalize({ ...(appSettings || {}), ...(patch || {}) });
    const fields = [
      ["uvPort", (port) => port === listenPort || port === extraPort],
      ["scramjetPort", (port) => port === listenPort || port === extraPort],
      ["wispPort", (port) => Boolean(lanWisp && lanWisp.address() && lanWisp.address().port === port)],
      ["mcpPort", (port) => mcpServer.status().running && port === mcpServer.status().port],
    ];
    for (const [field, ours] of fields) {
      const check = await settingsStore.inspectPort(next[field], ours);
      if (!check.ok) return { ok: false, error: check.message, state: runtimeState() };
      if (field === "wispPort" && check.port && (check.port === listenPort || check.port === extraPort)) {
        return { ok: false, error: `Port ${check.port} is already in use by this app's local server.`, state: runtimeState() };
      }
    }
    if (next.hostWispLocally && !next.wispPort) {
      return { ok: false, error: "Choose a Wisp port before enabling local hosting.", state: runtimeState() };
    }
    if (next.uvVersion && !(await settingsStore.isVersionInstalled("ultraviolet", next.uvVersion))) {
      return { ok: false, error: "Download that Ultraviolet version before selecting it.", state: runtimeState() };
    }
    if (next.scramjetVersion && !(await settingsStore.isVersionInstalled("scramjet", next.scramjetVersion))) {
      return { ok: false, error: "Download that Scramjet version before selecting it.", state: runtimeState() };
    }
    const previous = appSettings;
    appSettings = await settingsStore.write(next);
    applyRuntimePolicies(appSettings);
    devtoolsEnabled = appSettings.devtools !== false;
    if (!devtoolsEnabled) closeInspect();
    if (wispLogging) {
      wispLogging.set_level(appSettings.logWispTraffic ? wispLogging.DEBUG : wispLogging.WARN);
    }
    await settingsStore.applyMounts(appSettings);
    try {
      await applyLanHost();
    } catch (error) {
      appSettings = await settingsStore.write({ ...appSettings, hostWispLocally: false });
      return { ok: false, error: error.message || String(error), state: runtimeState() };
    }
    try {
      await syncMcpServer();
    } catch (error) {
      return { ok: false, error: error.message || String(error), state: runtimeState() };
    }
    const versionChanged = previous
      && (previous.uvVersion !== appSettings.uvVersion || previous.scramjetVersion !== appSettings.scramjetVersion);
    return {
      ok: true,
      versionChanged,
      restartRequired: portsNeedRestart(),
      state: runtimeState(),
    };
  });

  ipcMain.handle("regenerate-mcp-token", async () => {
    const token = settingsStore.newMcpToken();
    appSettings = await settingsStore.write({ ...(appSettings || {}), mcpToken: token });
    mcpServer.configure({ token });
    await syncMcpServer();
    return token;
  });

  ipcMain.handle("capture-pane", async (_event, payload) => capturePane(payload && payload.pane));

  const mcpReplies = new Map();
  ipcMain.on("mcp-command-result", (_event, payload) => {
    const pending = mcpReplies.get(payload && payload.id);
    if (!pending) return;
    mcpReplies.delete(payload.id);
    pending(payload);
  });

  function askRenderer(command, args = {}) {
    return new Promise((resolve) => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        resolve({ ok: false, error: "Window is not open." });
        return;
      }
      const id = newId();
      const timer = setTimeout(() => {
        mcpReplies.delete(id);
        resolve({ ok: false, error: "Timed out waiting for the renderer." });
      }, 30000);
      mcpReplies.set(id, (payload) => {
        clearTimeout(timer);
        resolve(payload.result || payload);
      });
      mainWindow.webContents.send("mcp-command", { id, command, args });
    });
  }

  mcpBridge.register({
    getStatus: async () => ({
      ok: true,
      session: getSession(),
      settings: {
        devtools: appSettings?.devtools !== false,
        mcpEnabled: Boolean(appSettings?.mcpEnabled),
        mcpAllowControl: appSettings?.mcpAllowControl !== false,
      },
      mcp: mcpServer.status(),
      origin,
    }),
    startSession: async (args) => askRenderer("start_session", args),
    endSession: async () => askRenderer("end_session"),
    navigate: async (args) => askRenderer("navigate", args),
    screenshot: async (args) => capturePane(args && args.pane),
    getLogs: async ({ kind, limit }) => ({
      ok: true,
      kind,
      text: logs.text(kind, limit),
    }),
    openInspect: async () => {
      openInspect();
      return { ok: true };
    },
    closeInspect: async () => {
      closeInspect();
      return { ok: true };
    },
    setSplitOrientation: async (args) => askRenderer("set_split_orientation", args),
  });
  ipcMain.handle("export-log", async (_event, payload) => {
    const kind = String(payload && payload.kind || "");
    const titles = {
      browser: "Export Browser Logs",
      network: "Export Network Logs",
      proxy: "Export Proxy Logs",
      wisp: "Export Wisp Logs",
    };
    if (!titles[kind]) throw new Error("Unknown log export.");
    let body = "";
    if (kind === "network") body = String(payload.text || "");
    else if (kind === "wisp") {
      const location = String(payload.location || "").trim() || "not selected";
      const host = settingsStore.wispDisplay(Boolean(lanWisp), lanWisp && lanWisp.address() ? lanWisp.address().port : 0);
      body = [
        `Selected Wisp location: ${location}`,
        host.hosting ? `Local host: ${host.url}` : "Local hosting is off.",
        host.hosting ? "" : "A remote Wisp server does not share its console with this app. Lines below are from the local Wisp host, if it has logged anything.",
        logs.text("wisp") || "(no Wisp log lines)",
      ].join("\n");
    } else body = logs.text(kind);
    if (!String(body).trim()) body = "(no log lines)\n";
    if (!body.endsWith("\n")) body += "\n";
    const result = await dialog.showSaveDialog(mainWindow, {
      title: titles[kind],
      defaultPath: `${kind}-logs.log`,
      filters: [{ name: "Log", extensions: ["log"] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const filePath = result.filePath.toLowerCase().endsWith(".log") ? result.filePath : `${result.filePath}.log`;
    await fs.writeFile(filePath, body);
    return { ok: true, path: filePath };
  });

  ipcMain.handle("get-session", () => getSession());

  ipcMain.handle("ensure-split-hosts", async () => ensureExtraServer());

  ipcMain.handle("set-session", (_event, next) => {
    if (next && next.mode === "split" && Array.isArray(next.panes)) {
      setSession(next);
      return next;
    }
    if (next) {
      const withPort = { ...next, port: listenPort, mode: next.mode || "single" };
      setSession(withPort);
      return withPort;
    }
    setSession(null);
    return null;
  });

  ipcMain.handle("clear-session", () => {
    setSession(null);
    return null;
  });

  ipcMain.handle("pick-folder", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Choose a folder",
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("import-folder", async (_event, payload) => {
    const source = payload.path;
    if (!source) throw new Error("No folder selected.");
    const root = await importRootFor(payload.kind);
    const id = newId();
    const dest = path.join(root, id);
    await copyFolder(source, dest);
    const detected = await finishImport(payload.kind, dest);
    return { id, base: publicBase(payload.kind, id), ...detected };
  });

  ipcMain.handle("import-git", async (_event, payload) => {
    const url = String(payload.url || "").trim();
    if (!url) throw new Error("Enter a git URL.");
    if (!(await gitAvailable())) {
      throw new Error("Git is not installed or not on PATH.");
    }
    const root = await importRootFor(payload.kind);
    const id = newId();
    const dest = path.join(root, id);
    await cloneGit(url, dest, payload.branch);
    const detected = await finishImport(payload.kind, dest);
    return { id, base: publicBase(payload.kind, id), source: url, ...detected };
  });

  ipcMain.on("inspect-bounds", (_event, bounds) => {
    if (bounds && bounds.slot) inspectSlot = bounds.slot;
    const rect = bounds && bounds.bounds ? bounds.bounds : bounds;
    const scaled = scaleToContent(rect, bounds && bounds.viewport);
    if (scaled && Number.isFinite(scaled.width) && Number.isFinite(scaled.height)) {
      rendererOwnsInspect = true;
      lastInspectBounds = scaled;
    }
    applyInspectBounds(scaled);
  });

  ipcMain.handle("import-url", async (_event, payload) => {
    const url = String(payload.url || "").trim();
    if (!url) throw new Error("Enter a URL.");
    const root = await importRootFor("proxy");
    const id = newId();
    const dest = path.join(root, id);
    if (isGitUrl(url)) {
      if (!(await gitAvailable())) throw new Error("Git is not installed or not on PATH.");
      await cloneGit(url, dest, payload.branch);
    } else {
      await downloadUrl(url, dest);
    }
    const detected = await detectProxy(dest);
    return { id, base: publicBase("proxy", id), source: url, ...detected };
  });
}

let policiesBound = false;

function screenMetrics(settings) {
  let width = Math.max(1, Number(settings.screenWidth) || 1920);
  let height = Math.max(1, Number(settings.screenHeight) || 1080);
  if (settings.screenOrientation === "portrait" && width > height) {
    const swap = width;
    width = height;
    height = swap;
  } else if (settings.screenOrientation !== "portrait" && height > width) {
    const swap = width;
    width = height;
    height = swap;
  }
  return { width, height, mobile: width <= 900 };
}

async function applyDeviceMetrics(_settings) {
  // Never override the shell window metrics — that breaks the toolkit UI when the
  // window is smaller than the reported resolution. Proxy panes spoof screen size in-page.
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const contents = mainWindow.webContents;
  try {
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
    await contents.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
  } catch { /* ignore */ }
}

function applyRuntimePolicies(settings) {
  if (!settings) return;
  logs.setFlags(settings);
  logs.setLogLocation(settings.logLocation || "");
  const ses = session.defaultSession;
  const ua = buildUserAgent(settings);
  try {
    ses.setUserAgent(ua);
  } catch { /* ignore */ }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.setUserAgent(ua);
    } catch { /* ignore */ }
  }
  void applyDeviceMetrics(settings);

  if (!policiesBound) {
    policiesBound = true;
    ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
      const current = appSettings || settings;
      const origin = (() => {
        try {
          return new URL(details.requestingUrl || details.securityOrigin || "https://unknown").origin;
        } catch {
          return "https://unknown";
        }
      })();
      const rule = current.sitePermissions?.[origin]?.[permission];
      if (rule === "allow") return callback(true);
      if (rule === "deny") return callback(false);
      callback(false);
    });

    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
      const current = appSettings || settings;
      try {
        const origin = new URL(requestingOrigin || "https://unknown").origin;
        const rule = current.sitePermissions?.[origin]?.[permission];
        if (rule === "allow") return true;
        if (rule === "deny") return false;
      } catch { /* ignore */ }
      return false;
    });

    try {
      ses.webRequest.onBeforeRequest({ urls: ["http://*/*"] }, (details, callback) => {
        const current = appSettings || settings;
        if (!current || current.forceHttps === false) return callback({});
        try {
          const url = new URL(details.url);
          if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return callback({});
          url.protocol = "https:";
          return callback({ redirectURL: url.href });
        } catch {
          return callback({});
        }
      });
    } catch { /* ignore */ }

    ses.on("will-download", (_event, item) => {
      const current = appSettings || settings;
      if (current && current.allowDownloading === false) {
        item.cancel();
        return;
      }
      const folder = (current && current.downloadLocation) || settingsStore.defaultDownloadsPath();
      try {
        item.setSavePath(path.join(folder, item.getFilename()));
      } catch {
        try {
          item.setSaveDialogOptions({ defaultPath: path.join(folder, item.getFilename()) });
        } catch { /* ignore */ }
      }
    });
  }

  if (settings.allowIndexedDb === false) {
    ses.clearStorageData({ storages: ["indexdb", "localstorage", "cachestorage"] }).catch(() => {});
  }
}

async function syncMcpServer() {
  if (!appSettings) return mcpServer.status();
  mcpServer.configure({
    token: appSettings.mcpToken,
    control: appSettings.mcpAllowControl !== false,
  });
  if (!appSettings.mcpEnabled) return mcpServer.stop();
  return mcpServer.start({
    port: appSettings.mcpPort || 7432,
    token: appSettings.mcpToken,
    control: appSettings.mcpAllowControl !== false,
  });
}

async function capturePane(pane) {
  const target = pane === "left" || pane === "right" || pane === "single" ? pane : "single";
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: "Window is not open." };
  const image = await mainWindow.webContents.capturePage();
  const size = image.getSize();
  return {
    ok: true,
    pane: target,
    width: size.width,
    height: size.height,
    pngBase64: image.toPNG().toString("base64"),
    note: "Full window capture. Pane-specific cropping can be refined later.",
  };
}

function runtimeState() {
  const hosting = Boolean(lanWisp && lanWisp.address());
  const port = hosting ? lanWisp.address().port : 0;
  return {
    settings: appSettings || settingsStore.normalize({}),
    listenPort,
    extraPort,
    restartRequired: portsNeedRestart(),
    portNotice,
    wisp: settingsStore.wispDisplay(hosting, port),
    devtools: devtoolsEnabled,
    mcp: mcpServer.status(),
    about: buildInfo.collect(),
  };
}

function portsNeedRestart() {
  if (!appSettings) return false;
  const plan = settingsStore.listenPlan(appSettings);
  if (plan.primary && plan.primary !== listenPort) return true;
  if ((plan.extra || 0) !== (extraPort || 0)) return true;
  return false;
}

function listenOn(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server.address());
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function attachWispUpgrade(server) {
  if (!server || !wispServer) return;
  server.on("upgrade", (req, socket, head) => {
    const target = req.url || "";
    if (target === "/wisp/" || target.startsWith("/wisp/?")) {
      wispServer.routeRequest(req, socket, head);
      return;
    }
    socket.destroy();
  });
}

async function ensureExtraServer() {
  async function startPaneServer() {
    const server = createStaticServer(importsRoot);
    attachWispUpgrade(server);
    await listenOn(server, 0, "127.0.0.1");
    return { server, port: server.address().port };
  }

  if (!paneLeftServer || !paneLeftPort) {
    if (extraServer && extraPort && extraPort !== listenPort) {
      paneLeftServer = extraServer;
      paneLeftPort = extraPort;
    } else {
      const started = await startPaneServer();
      paneLeftServer = started.server;
      paneLeftPort = started.port;
    }
  }
  if (!paneRightServer || !paneRightPort || paneRightPort === paneLeftPort) {
    const started = await startPaneServer();
    paneRightServer = started.server;
    paneRightPort = started.port;
  }
  return {
    leftPort: paneLeftPort,
    rightPort: paneRightPort,
    leftOrigin: `http://127.0.0.1:${paneLeftPort}`,
    rightOrigin: `http://127.0.0.1:${paneRightPort}`,
  };
}

function contentSize() {
  const [width, height] = mainWindow.getContentSize();
  return {
    width: Math.max(1, width),
    height: Math.max(1, height),
  };
}

function scaleToContent(rect, viewport) {
  if (!rect || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return rect;
  const size = contentSize();
  const viewWidth = viewport && Number.isFinite(viewport.width) ? viewport.width : 0;
  const viewHeight = viewport && Number.isFinite(viewport.height) ? viewport.height : 0;
  if (!viewWidth || !viewHeight || !size.width || !size.height) return rect;
  const sx = size.width / viewWidth;
  const sy = size.height / viewHeight;
  if (Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return rect;
  return {
    x: Math.round(rect.x * sx),
    y: Math.round(rect.y * sy),
    width: Math.round(rect.width * sx),
    height: Math.round(rect.height * sy),
  };
}

function slotRect(slot, size) {
  const { width, height } = size;
  const side = Math.min(720, Math.max(480, Math.round(width * 0.46)));
  const fitted = Math.min(side, Math.max(280, width - 240));
  const band = Math.min(360, Math.max(220, Math.round(height * 0.38)));
  const cornerW = Math.min(fitted, Math.max(280, Math.round(width * 0.46)));
  const cornerH = Math.min(band, Math.max(200, Math.round(height * 0.5)));
  switch (slot) {
    case "left": return { x: 0, y: 0, width: Math.min(fitted, width), height };
    case "top": return { x: 0, y: 0, width, height: Math.min(band, height) };
    case "bottom": return { x: 0, y: Math.max(0, height - band), width, height: Math.min(band, height) };
    case "nw": return { x: 0, y: 0, width: cornerW, height: cornerH };
    case "ne": return { x: Math.max(0, width - cornerW), y: 0, width: Math.min(cornerW, width), height: cornerH };
    case "sw": return { x: 0, y: Math.max(0, height - cornerH), width: cornerW, height: Math.min(cornerH, height) };
    case "se": return { x: Math.max(0, width - cornerW), y: Math.max(0, height - cornerH), width: Math.min(cornerW, width), height: Math.min(cornerH, height) };
    default: return { x: Math.max(0, width - fitted), y: 0, width: Math.min(fitted, width), height };
  }
}

function clampBounds(bounds) {
  const { width, height } = contentSize();
  const nextWidth = Math.max(40, Math.min(width, Math.round(bounds.width)));
  const nextHeight = Math.max(40, Math.min(height, Math.round(bounds.height)));
  const x = Math.max(0, Math.min(width - nextWidth, Math.round(bounds.x)));
  const y = Math.max(0, Math.min(height - nextHeight, Math.round(bounds.y)));
  return { x, y, width: nextWidth, height: nextHeight };
}

function sendInspectState(open) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("inspect-state", { open });
}

function applyInspectBounds(bounds) {
  if (!inspectView || !mainWindow || mainWindow.isDestroyed() || !bounds) return;
  if (!inspectOpen) {
    inspectView.setVisible(false);
    return;
  }
  const next = clampBounds(bounds);
  inspectView.setBounds(next);
  inspectView.setVisible(true);
  fitInspectContents();
}

let fitInspectTimer = null;
let fitInspectCssKey = null;

async function fitInspectContents() {
  const contents = inspectView && inspectView.webContents;
  if (!contents || contents.isDestroyed()) return;
  if (fitInspectTimer) clearTimeout(fitInspectTimer);
  fitInspectTimer = setTimeout(() => {
    void paintInspectContents();
  }, 16);
}

async function paintInspectContents() {
  const contents = inspectView && inspectView.webContents;
  if (!contents || contents.isDestroyed() || !inspectView) return;
  const bounds = inspectView.getBounds();
  const width = Math.max(40, Math.round(bounds.width));
  const height = Math.max(40, Math.round(bounds.height));
  inspectView.setBounds({ x: bounds.x, y: bounds.y, width: Math.max(40, width - 1), height: Math.max(40, height - 1) });
  inspectView.setBounds({ x: bounds.x, y: bounds.y, width, height });

  try {
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
    await contents.debugger.sendCommand("Emulation.clearDeviceMetricsOverride");
    await contents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
      scale: 1,
    });
  } catch {
    /* DevTools frontend may reject emulation; CSS fallback below still runs. */
  }

  const css = `
html, body {
  width: ${width}px !important;
  height: ${height}px !important;
  min-width: ${width}px !important;
  min-height: ${height}px !important;
  margin: 0 !important;
  overflow: hidden !important;
  position: relative !important;
}
body > .root-view,
body > .vbox,
.root-view {
  position: absolute !important;
  left: 0 !important;
  top: 0 !important;
  right: 0 !important;
  bottom: 0 !important;
  width: ${width}px !important;
  height: ${height}px !important;
  max-width: none !important;
  max-height: none !important;
}
`;
  try {
    if (fitInspectCssKey) {
      await contents.removeInsertedCSS(fitInspectCssKey);
      fitInspectCssKey = null;
    }
    fitInspectCssKey = await contents.insertCSS(css);
  } catch {
    /* ignore */
  }

  try {
    await contents.executeJavaScript(`(() => {
      const w = ${width};
      const h = ${height};
      for (const el of [document.documentElement, document.body, ...document.querySelectorAll(".root-view")]) {
        if (!el) continue;
        el.style.setProperty("width", w + "px", "important");
        el.style.setProperty("height", h + "px", "important");
      }
      window.dispatchEvent(new Event("resize"));
    })()`, true);
  } catch {
    /* ignore */
  }
}

function layoutInspect() {
  if (!inspectView || !mainWindow || mainWindow.isDestroyed()) return;
  if (!inspectOpen) {
    inspectView.setVisible(false);
    sendInspectState(false);
    return;
  }
  if (rendererOwnsInspect && lastInspectBounds) {
    applyInspectBounds(lastInspectBounds);
    sendInspectState(true);
    return;
  }
  const rect = slotRect(inspectSlot, contentSize());
  applyInspectBounds({ x: rect.x, y: rect.y + 32, width: rect.width, height: Math.max(40, rect.height - 32) });
  sendInspectState(true);
}

function openInspect() {
  if (!devtoolsEnabled) return;
  inspectOpen = true;
  layoutInspect();
  if (inspectHosted && mainWindow && !mainWindow.webContents.isDevToolsOpened()) {
    mainWindow.webContents.openDevTools({ activate: true });
  } else if (!inspectHosted && mainWindow) {
    mainWindow.webContents.openDevTools({ mode: "right", activate: true });
  }
}

function closeInspect() {
  inspectOpen = false;
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.isDevToolsOpened()) {
    mainWindow.webContents.closeDevTools();
  }
  layoutInspect();
}

function toggleInspect() {
  if (inspectOpen) closeInspect();
  else openInspect();
}

function isInspectShortcut(input) {
  if (input.type !== "keyDown" || input.isAutoRepeat || input.alt) return false;
  const key = String(input.key || "").toLowerCase();
  return (input.control || input.meta) && input.shift && key === "i";
}

function wantsDevtools(input) {
  if (!input || input.type !== "keyDown" || input.isAutoRepeat || input.alt) return false;
  const key = String(input.key || "").toLowerCase();
  if (key === "f12") return true;
  if (key === "j" && (input.control || input.meta) && input.shift) return true;
  return isInspectShortcut(input);
}

function attachInspectControls(contents) {
  contents.on("before-input-event", (event, input) => {
    if (!wantsDevtools(input) && !isInspectShortcut(input)) return;
    if (!devtoolsEnabled) {
      if (wantsDevtools(input) || isInspectShortcut(input)) event.preventDefault();
      return;
    }
    if (!isInspectShortcut(input)) return;
    event.preventDefault();
    toggleInspect();
  });
  contents.on("context-menu", (event, params) => {
    if (inspectView && contents === inspectView.webContents) return;
    event.preventDefault();
    popupPageContextMenu(contents, params, {
      openInspect,
      devtoolsEnabled,
    });
  });
}

function attachWindow() {
  installSaveAsPrompt();
  const ses = session.defaultSession;
  ses.webRequest.onCompleted((details) => {
    sendNetwork({
      source: "webRequest",
      id: String(details.id),
      phase: "done",
      method: details.method,
      url: details.url,
      status: details.statusCode,
      type: details.resourceType,
      timestamp: Date.now() / 1000,
    });
  });
  ses.webRequest.onErrorOccurred((details) => {
    sendNetwork({
      source: "webRequest",
      id: String(details.id),
      phase: "error",
      method: details.method,
      url: details.url,
      error: details.error,
      type: details.resourceType,
      timestamp: Date.now() / 1000,
    });
  });
}

function routeWispUpgrade(wisp, req, socket, head) {
  const target = req.url || "";
  if (
    target === "/"
    || target.startsWith("/?")
    || target === "/wisp"
    || target === "/wisp/"
    || target.startsWith("/wisp/?")
  ) {
    wisp.routeRequest(req, socket, head);
    return;
  }
  socket.destroy();
}

async function createWindow() {
  importsRoot = app.getPath("userData");
  await fs.mkdir(path.join(importsRoot, "sites"), { recursive: true });
  await fs.mkdir(path.join(importsRoot, "imports", "proxies"), { recursive: true });
  appSettings = await settingsStore.init(importsRoot);
  devtoolsEnabled = appSettings.devtools !== false;
  applyRuntimePolicies(appSettings);
  await settingsStore.applyMounts(appSettings);
  const plan = settingsStore.listenPlan(appSettings);

  const httpServer = createStaticServer(importsRoot);
  const { server: wisp, logging } = require("@mercuryworkshop/wisp-js/server");
  wispServer = wisp;
  wispLogging = logging;
  try {
    logs.hookWisp(logging, () => !appSettings || appSettings.logWispTraffic !== false);
    logging.set_level(appSettings.logWispTraffic === false ? logging.WARN : logging.DEBUG);
  } catch (error) {
    console.error("Wisp log hook skipped:", error);
  }
  Object.assign(wisp.options, {
    allow_loopback_ips: true,
    allow_private_ips: true,
    allow_udp_streams: true,
    hostname_blacklist: [],
  });

  httpServer.on("upgrade", (req, socket, head) => {
    const target = req.url || "";
    if (target === "/wisp/" || target.startsWith("/wisp/?")) {
      wisp.routeRequest(req, socket, head);
      return;
    }
    socket.destroy();
  });

  try {
    await listenOn(httpServer, plan.primary || 0, "127.0.0.1");
  } catch (error) {
    if (!plan.primary || error.code !== "EADDRINUSE") throw error;
    portNotice = `Port ${plan.primary} is already in use. Started on an ephemeral port instead.`;
    await listenOn(httpServer, 0, "127.0.0.1");
  }
  listenPort = httpServer.address().port;
  if (plan.extra && plan.extra !== listenPort) {
    const extra = createStaticServer(importsRoot);
    attachWispUpgrade(extra);
    try {
      await listenOn(extra, plan.extra, "127.0.0.1");
      extraServer = extra;
      extraPort = plan.extra;
    } catch (error) {
      extra.close();
      const note = `Port ${plan.extra} is already in use, so that extra proxy host was not started.`;
      portNotice = portNotice ? `${portNotice} ${note}` : note;
    }
  }
  origin = `http://127.0.0.1:${listenPort}`;
  console.log(`Proxy Development Toolkit ${origin}`);

  applyLanHost = async () => {
    if (lanWisp) {
      await new Promise((resolve) => lanWisp.close(() => resolve()));
      lanWisp = null;
    }
    if (!appSettings || !appSettings.hostWispLocally) return settingsStore.wispDisplay(false, 0);
    const parsed = settingsStore.parsePort(appSettings.wispPort);
    if (!parsed.ok || parsed.empty) throw new Error(parsed.message || "Choose a Wisp port before enabling local hosting.");
    if (parsed.port === listenPort || parsed.port === extraPort) {
      throw new Error(`Port ${parsed.port} is already in use by this app's local server.`);
    }
    const taken = await settingsStore.checkPortInUse(parsed.port);
    if (taken.inUse) throw new Error(`Port ${parsed.port} is already in use by another process.`);
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end("Wisp");
    });
    server.on("upgrade", (req, socket, head) => routeWispUpgrade(wisp, req, socket, head));
    await listenOn(server, parsed.port, "0.0.0.0");
    lanWisp = server;
    return settingsStore.wispDisplay(true, parsed.port);
  };
  if (appSettings.hostWispLocally) {
    try {
      await applyLanHost();
    } catch (error) {
      portNotice = portNotice
        ? `${portNotice} Wisp hosting did not start: ${error.message || error}`
        : `Wisp hosting did not start: ${error.message || error}`;
      appSettings = await settingsStore.write({ ...appSettings, hostWispLocally: false });
    }
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#161616",
    title: "Proxy Development Toolkit",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "..", "build", process.platform === "win32" ? "icon.ico" : "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: true,
    },
  });

  inspectView = new WebContentsView({
    webPreferences: {
      devTools: false,
      sandbox: true,
    },
  });
  inspectView.setBackgroundColor("#161616");
  inspectView.setVisible(false);
  mainWindow.contentView.addChildView(inspectView);
  try {
    mainWindow.webContents.setDevToolsWebContents(inspectView.webContents);
    inspectHosted = true;
  } catch (error) {
    console.error(error);
    mainWindow.contentView.removeChildView(inspectView);
    inspectView = null;
    inspectHosted = false;
  }

  mainWindow.setMenuBarVisibility(false);
  attachWindow();
  attachInspectControls(mainWindow.webContents);
  if (inspectView) attachInspectControls(inspectView.webContents);
  mainWindow.on("resize", () => {
    if (rendererOwnsInspect && lastInspectBounds) {
      fitInspectContents();
      return;
    }
    layoutInspect();
  });
  mainWindow.webContents.on("devtools-opened", () => {
    if (!devtoolsEnabled) {
      closeInspect();
      return;
    }
    inspectOpen = true;
    layoutInspect();
    setTimeout(() => fitInspectContents(), 100);
    setTimeout(() => fitInspectContents(), 500);
    setTimeout(() => fitInspectContents(), 1200);
  });
  mainWindow.webContents.on("devtools-closed", () => {
    inspectOpen = false;
    layoutInspect();
  });
  mainWindow.webContents.on("did-finish-load", () => {
    const attached = attachDebugger(mainWindow, sendNetwork);
    if (!attached.ok) {
      sendNetwork({
        source: "debugger",
        phase: "status",
        error: attached.reason,
      });
    }
  });
  mainWindow.webContents.once("did-finish-load", () => {
    sendInspectState(false);
  });

  logs.captureContents(mainWindow.webContents);
  if (inspectView) {
    inspectView.webContents.on("did-finish-load", () => fitInspectContents());
    logs.captureContents(inspectView.webContents);
  }
  mainWindow.webContents.setWindowOpenHandler(() => {
    if (appSettings && appSettings.allowSiteRedirects === false) return { action: "deny" };
    return { action: "allow" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!appSettings || appSettings.allowSiteRedirects !== false) return;
    try {
      const next = new URL(url);
      const local = new URL(origin);
      if (next.origin === local.origin) return;
      event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  await mainWindow.loadURL(origin + "/");
  applyRuntimePolicies(appSettings);
  try {
    await syncMcpServer();
  } catch (error) {
    console.error("MCP server did not start:", error);
  }
  mainWindow.on("closed", () => {
    mainWindow = null;
    void mcpServer.stop();
    httpServer.close();
    if (extraServer) extraServer.close();
    if (paneLeftServer && paneLeftServer !== extraServer) paneLeftServer.close();
    if (paneRightServer && paneRightServer !== extraServer && paneRightServer !== paneLeftServer) {
      paneRightServer.close();
    }
    paneLeftServer = null;
    paneRightServer = null;
    paneLeftPort = 0;
    paneRightPort = 0;
    if (lanWisp) lanWisp.close();
  });
}

app.setName("Proxy Development Toolkit");
if (process.platform === "win32") {
  app.setAppUserModelId("com.proxydevelopmenttoolkit.app");
}

app.whenReady().then(async () => {
  registerIpc();
  await createWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});
