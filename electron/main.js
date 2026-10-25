"use strict";

const { app, BrowserWindow, WebContentsView, clipboard, dialog, ipcMain, session, shell } = require("electron");
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
const updates = require("./updates");
const verboseConsole = require("./verbose-console");
const { attachDebugger } = require("./network");
const { downloadToFile } = require("./downloads");
const { transportPackage, isValidVersion } = require("./transports");
const { buildFromSource } = require("./source-build");
const devServer = require("./dev-server");
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
let windowChrome = null;
let comboServers = []; // [{ server, port }]
const comboWindows = new Map(); // comboId -> BrowserWindow
const wantHeadless = process.argv.includes("--headless") || process.argv.includes("--mcp-startup");
const mcpStartupLaunch = process.argv.includes("--mcp-startup");
let headlessActive = false;

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
  ipcMain.handle("check-for-updates", (_event, payload) => checkForUpdates(payload));
  ipcMain.handle("verbose-console-start", (_event, payload) => {
    const kind = payload && payload.kind;
    if (!kind) return { ok: false, error: "Missing console kind." };
    return verboseConsole.startConsole(kind, {
      title: payload.title || kind,
      minimized: Boolean(payload.minimized),
    });
  });
  ipcMain.handle("verbose-console-stop", (_event, payload) => {
    const kind = payload && payload.kind;
    if (!kind) return { ok: false, error: "Missing console kind." };
    return verboseConsole.stopConsole(kind, { sigint: payload?.sigint !== false });
  });
  ipcMain.handle("verbose-console-stop-all", (_event, payload) => {
    verboseConsole.stopAll({ sigint: payload?.sigint !== false });
    return { ok: true };
  });
  ipcMain.handle("copy-text", (event, text) => {
    if (!isHostSender(event)) return { ok: false };
    clipboard.writeText(String(text ?? ""));
    return { ok: true };
  });

  ipcMain.handle("set-window-chrome", (_event, payload) => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
    windowChrome = payload && typeof payload === "object" ? payload : null;
    applyWindowTitle();
    return { ok: true, title: mainWindow.getTitle() };
  });
  ipcMain.handle("list-releases", () => settingsStore.listReleases());
  ipcMain.handle("check-port", async (_event, payload) => {
    const field = payload && payload.field;
    const devField = field === "python" || field === "node";
    const ours = (port) => {
      if (field === "wisp") return Boolean(lanWisp && lanWisp.address() && lanWisp.address().port === port);
      if (field === "mcp") return mcpServer.status().running && port === mcpServer.status().port;
      if (devField) return devServer.status().running && devServer.status().runtime === field && devServer.status().port === port;
      if (comboServers.some((entry) => entry.port === port)) return true;
      return port === listenPort || port === extraPort;
    };
    const result = await settingsStore.inspectPort(payload && payload.port, ours);
    if (devField && result.port && (result.port === listenPort || result.port === extraPort || comboServers.some((entry) => entry.port === result.port))) {
      return { ok: false, message: `Port ${result.port} is already in use by this app's local server.` };
    }
    if (field === "wisp" && result.ok && result.port && (result.port === listenPort || result.port === extraPort)) {
      return { ok: false, message: `Port ${result.port} is already in use by this app's local server.` };
    }
    return result;
  });
  ipcMain.handle("download-release", async (_event, payload) => {
    const kind = payload && payload.kind === "scramjet" ? "scramjet" : "ultraviolet";
    const result = await settingsStore.downloadRelease(kind, payload && (payload.id || payload.tag), downloadProgress);
    if (payload && payload.select && appSettings) {
      const key = kind === "ultraviolet" ? "uvVersion" : "scramjetVersion";
      const patch = { [key]: result.id || payload.id };
      if (kind === "scramjet" && payload.commitId) {
        patch.scramjetContinuousCommit = String(payload.commitId);
      }
      appSettings = await settingsStore.write({ ...appSettings, ...patch });
      await settingsStore.applyMounts(appSettings);
    }
    return { ...result, state: runtimeState() };
  });
  ipcMain.handle("download-transports", async (_event, payload) => {
    const ids = Array.isArray(payload && payload.ids) ? payload.ids.map(String) : [];
    const versions = (payload && payload.versions && typeof payload.versions === "object") ? payload.versions : {};
    const installed = [];
    const failed = [];
    for (const id of ids) {
      const version = isValidVersion(versions[id]) ? String(versions[id]) : "latest";
      try {
        installed.push(await settingsStore.downloadTransport(id, version, downloadProgress, { reuse: true }));
      } catch (error) {
        failed.push({ id, error: error.message || String(error) });
      }
    }
    if (installed.length && appSettings) {
      const transportVersions = { ...(appSettings.transportVersions || {}) };
      for (const entry of installed) transportVersions[entry.id] = entry.version;
      appSettings = await settingsStore.write({ ...appSettings, transportVersions });
      await settingsStore.applyMounts(appSettings);
    }
    return { ok: failed.length === 0, installed, failed, state: runtimeState() };
  });
  ipcMain.handle("download-app-update", async () => {
    const result = await updates.checkForUpdate(appSettings || {}, { force: false });
    if (!result || !result.ok) return { ok: false, error: (result && result.error) || "Could not check for updates." };
    if (!result.updateAvailable) return { ok: false, error: "You're already on the latest version." };
    if (result.compileFromSource) {
      const label = result.channel === "commit" ? `commit ${result.latestVersion}` : `v${result.latestVersion}`;
      try {
        const build = await buildFromSource({
          repo: updates.APP_REPO,
          ref: result.sourceRef,
          label,
          workRoot: path.join(app.getPath("userData"), "source-build"),
          headers: updates.githubHeaders(),
          report: downloadProgress(`Compiling Proxy Development Toolkit ${label}`),
        });
        await shell.openPath(build.outputDir);
        return { ok: true, compiled: true, outputDir: build.outputDir, label };
      } catch (error) {
        return { ok: false, error: error.message || String(error) };
      }
    }
    const asset = updates.pickAppAsset(result.assets);
    if (!asset) {
      await shell.openExternal(result.releaseUrl);
      return { ok: true, openedReleasePage: true };
    }
    const file = path.join(app.getPath("downloads"), path.basename(asset.name));
    try {
      await downloadToFile(asset.url, file, {
        headers: updates.githubHeaders(),
        onProgress: downloadProgress(`Proxy Development Toolkit v${result.latestVersion}`),
      });
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
    shell.showItemInFolder(file);
    return { ok: true, file, name: asset.name };
  });
  ipcMain.handle("list-transport-versions", (_event, payload) =>
    settingsStore.listTransportVersions(appSettings || {}, { force: Boolean(payload && payload.force) }));
  ipcMain.handle("select-transport-version", async (_event, payload) => {
    const id = String((payload && payload.id) || "");
    const version = String((payload && payload.version) || "bundled");
    if (!transportPackage(id)) return { ok: false, error: `Unknown transport "${id}".` };
    let resolved = "bundled";
    if (version !== "bundled") {
      try {
        resolved = (await settingsStore.downloadTransport(id, version, downloadProgress, { reuse: true })).version;
      } catch (error) {
        return { ok: false, error: error.message || String(error), state: runtimeState() };
      }
    }
    const transportVersions = { ...((appSettings && appSettings.transportVersions) || {}) };
    if (resolved === "bundled") delete transportVersions[id];
    else transportVersions[id] = resolved;
    appSettings = await settingsStore.write({ ...(appSettings || {}), transportVersions });
    await settingsStore.applyMounts(appSettings);
    return { ok: true, id, version: resolved, state: runtimeState() };
  });
  ipcMain.handle("start-dev-server", async (_event, payload) => {
    const send = (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("dev-server-event", data);
    };
    const runtime = payload && payload.runtime === "node" ? "node" : "python";
    const saved = runtime === "node" ? appSettings && appSettings.nodePort : appSettings && appSettings.pythonPort;
    try {
      return await devServer.start({
        runtime,
        folder: String((payload && payload.folder) || ""),
        port: Number(saved) || devServer.DEFAULT_PORTS[runtime],
        onStage: (stage) => send({ stage }),
        onLine: (line) => send({ line }),
      });
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  });
  ipcMain.handle("stop-dev-server", () => ({ ok: true, stopped: devServer.stop() }));
  ipcMain.handle("detect-dev-deps", async (_event, payload) => {
    try {
      return await devServer.detect(String((payload && payload.folder) || ""));
    } catch {
      return { python: null, node: null };
    }
  });
  ipcMain.handle("restart-app", () => {
    app.relaunch();
    app.quit();
    return { ok: true };
  });
  ipcMain.handle("reset-transports", async () => {
    if (appSettings) {
      appSettings = await settingsStore.write({ ...appSettings, transportVersions: {} });
      await settingsStore.applyMounts(appSettings);
    }
    return { ok: true, state: runtimeState() };
  });
  ipcMain.handle("save-settings", async (_event, patch) => {
    const next = settingsStore.normalize({ ...(appSettings || {}), ...(patch || {}) });
    const fields = [
      ["uvPort", (port) => port === listenPort || port === extraPort],
      ["scramjetPort", (port) => port === listenPort || port === extraPort],
      ["wispPort", (port) => Boolean(lanWisp && lanWisp.address() && lanWisp.address().port === port)],
      ["mcpPort", (port) => mcpServer.status().running && port === mcpServer.status().port],
      ["pythonPort", (port) => port === Number((appSettings || {}).pythonPort) || (devServer.status().running && devServer.status().port === port)],
      ["nodePort", (port) => port === Number((appSettings || {}).nodePort) || (devServer.status().running && devServer.status().port === port)],
    ];
    for (const [field, ours] of fields) {
      const check = await settingsStore.inspectPort(next[field], ours);
      if (!check.ok) return { ok: false, error: check.message, state: runtimeState() };
      if (field === "wispPort" && check.port && (check.port === listenPort || check.port === extraPort)) {
        return { ok: false, error: `Port ${check.port} is already in use by this app's local server.`, state: runtimeState() };
      }
    }
    if (next.hostWispLocally && !String(next.wispPort || "").trim()) {
      next.wispPort = "6001";
    }
    if (next.uvVersion && !(await settingsStore.isVersionInstalled("ultraviolet", next.uvVersion))) {
      return { ok: false, error: "Download that Ultraviolet version before selecting it.", state: runtimeState() };
    }
    if (next.scramjetVersion && !(await settingsStore.isVersionInstalled("scramjet", next.scramjetVersion))) {
      return { ok: false, error: "Download that Scramjet version before selecting it.", state: runtimeState() };
    }
    const previous = appSettings;
    if (next.mcpLaunchOnStartup) next.mcpEnabled = true;
    appSettings = await settingsStore.write(next);
    applyRuntimePolicies(appSettings);
    syncMcpStartupLaunch(appSettings);
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

  function askRenderer(command, args = {}, timeoutMs = 30000) {
    return new Promise((resolve) => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        resolve({ ok: false, error: "Window is not open." });
        return;
      }
      const id = newId();
      const timer = setTimeout(() => {
        mcpReplies.delete(id);
        resolve({ ok: false, error: `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the renderer to finish "${command}".` });
      }, timeoutMs);
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
        mcpLaunchOnStartup: Boolean(appSettings?.mcpLaunchOnStartup),
      },
      mcp: { ...mcpServer.status(), headless: headlessActive },
      origin,
    }),
    startSession: async (args) => askRenderer("start_session", args, 120000),
    endSession: async () => askRenderer("end_session"),
    navigate: async (args) => askRenderer("navigate", args),
    focusCombo: async (args) => askRenderer("focus_combo", args),
    getTweaks: async () => withVerboseLogFiles(await askRenderer("get_tweaks")),
    setTweaks: async (args) => withVerboseLogFiles(await askRenderer("set_tweaks", args, 60000)),
    screenshot: async (args) => {
      const pane = String((args && args.pane) || "single");
      const popped = comboWindows.get(pane);
      if (popped && !popped.isDestroyed()) return captureWindow(popped, pane);
      if (pane !== "single") {
        const focused = await askRenderer("focus_combo", { comboId: pane });
        if (focused && focused.ok === false) return focused;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      return capturePane(pane);
    },
    getLogs: async ({ kind, limit }) => ({
      ok: true,
      kind,
      text: logs.text(kind, limit),
    }),
    openInspect: async () => {
      if (!devtoolsEnabled) return { ok: false, error: "DevTools are disabled. Enable them in Settings → Developer." };
      openInspect();
      return { ok: true };
    },
    closeInspect: async () => {
      closeInspect();
      return { ok: true };
    },
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

  ipcMain.handle("ensure-combo-hosts", async (_event, payload) => ensureComboHosts(payload && payload.count));

  ipcMain.handle("open-combo-window", async (_event, payload) => openComboWindow(payload || {}));
  ipcMain.handle("close-combo-window", async (_event, payload) => {
    closeComboWindow(payload && payload.comboId);
    return { ok: true };
  });
  ipcMain.handle("focus-combo-window", async (_event, payload) => {
    const win = comboWindows.get(payload && payload.comboId);
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
      return { ok: true };
    }
    return { ok: false };
  });
  ipcMain.handle("post-combo-window", async (_event, payload) => {
    const comboId = payload && payload.comboId;
    const message = payload && payload.message;
    const win = comboWindows.get(comboId);
    if (!win || win.isDestroyed() || !message) return { ok: false };
    await win.webContents.executeJavaScript(
      `window.postMessage(${JSON.stringify(message)}, "*"); true;`
    );
    return { ok: true };
  });

  ipcMain.handle("set-session", (_event, next) => {
    if (next && next.mode === "multi" && Array.isArray(next.combos)) {
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
    closeAllComboWindows();
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
    return { id, base: publicBase(payload.kind, id), source: url, path: dest, ...detected };
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
  const enabled = Boolean(appSettings.mcpEnabled)
    || (mcpStartupLaunch && Boolean(appSettings.mcpLaunchOnStartup));
  mcpServer.configure({
    token: appSettings.mcpToken,
    control: appSettings.mcpAllowControl !== false,
  });
  try {
    if (!enabled) return await mcpServer.stop();
    const current = mcpServer.status();
    if (current.running && current.port === (Number(appSettings.mcpPort) || 7432)) return current;
    return await mcpServer.start({
      port: appSettings.mcpPort || 7432,
      token: appSettings.mcpToken,
      control: appSettings.mcpAllowControl !== false,
    });
  } finally {
    applyWindowTitle();
  }
}

function syncMcpStartupLaunch(settings = appSettings) {
  const enabled = Boolean(settings && settings.mcpLaunchOnStartup);
  try {
    const args = [];
    if (!app.isPackaged) args.push(path.join(__dirname, ".."));
    args.push("--headless", "--mcp-startup");
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: true,
      path: process.execPath,
      args: enabled ? args : [],
      name: "Proxy Development Toolkit MCP",
    });
  } catch (error) {
    console.error("Could not update MCP startup launch setting:", error);
  }
}

function applyHeadlessPolicy() {
  headlessActive = Boolean(wantHeadless);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.setSkipTaskbar(headlessActive);
  } catch { /* ignore */ }
  if (headlessActive) {
    if (mainWindow.isVisible()) mainWindow.hide();
  } else if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
}

function revealMainWindow() {
  headlessActive = false;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.setSkipTaskbar(false);
  } catch { /* ignore */ }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// capturePage() can throw transient compositor errors (e.g. UnknownVizError) when no fresh frame is ready.
async function captureContents(contents, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await contents.capturePage();
    } catch (error) {
      if (attempt >= attempts || contents.isDestroyed()) throw error;
      try { contents.invalidate(); } catch { /* not paintable */ }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

async function captureWindow(win, pane) {
  if (!win || win.isDestroyed()) return { ok: false, error: "Window is not open." };
  let image;
  try {
    image = await captureContents(win.webContents);
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
  const size = image.getSize();
  return {
    ok: true,
    pane,
    width: size.width,
    height: size.height,
    pngBase64: image.toPNG().toString("base64"),
  };
}

async function capturePane(pane) {
  const result = await captureWindow(mainWindow, pane || "single");
  if (!result.ok || !inspectOpen || !inspectHosted || !inspectView) return result;
  // capturePage() only covers the renderer; the DevTools dock is a separate child view.
  try {
    const dock = await captureContents(inspectView.webContents, 5);
    const size = dock.getSize();
    if (size.width && size.height) {
      result.inspect = { width: size.width, height: size.height, pngBase64: dock.toPNG().toString("base64") };
    }
  } catch { /* dock not ready */ }
  return result;
}

let downloadCounter = 0;

function downloadProgress(label) {
  const id = `dl-${Date.now().toString(36)}-${++downloadCounter}`;
  return (data) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("download-progress", { id, label, ...data });
  };
}

function checkForUpdates(payload) {
  const force = Boolean(payload && payload.force);
  const kind = payload && payload.kind;
  if (kind === "scramjet") return updates.checkScramjetUpdate(appSettings || {}, { force });
  if (kind === "transports") return updates.checkTransportUpdates(appSettings || {}, { force });
  if (kind === "all") return updates.checkAllUpdates(appSettings || {}, { force });
  return updates.checkForUpdate(appSettings || {}, { force });
}

function isHostSender(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false;
  const frame = event.senderFrame;
  if (!frame || frame !== mainWindow.webContents.mainFrame) return false;
  try {
    return new URL(frame.url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

function withVerboseLogFiles(result) {
  if (!result || typeof result !== "object") return result;
  return {
    ...result,
    logFiles: {
      wisp: verboseConsole.logPath("wisp"),
      proxy: verboseConsole.logPath("proxy"),
      transport: verboseConsole.logPath("transport"),
    },
  };
}

const APP_TITLE = "Proxy Development Toolkit";

function plural(count, word, many = `${word}s`) {
  return `${count} ${count === 1 ? word : many}`;
}

function composeWindowTitle(chrome) {
  const mcp = mcpServer.status().running;
  if (chrome && chrome.cloakTitle) return String(chrome.cloakTitle);
  if (!chrome || !chrome.session) return mcp ? `${APP_TITLE} | MCP` : APP_TITLE;
  const parts = [chrome.siteTitle || "New Tab", APP_TITLE];
  if (chrome.proxy) parts.push(chrome.proxy);
  if (chrome.transport) parts.push(chrome.transport);
  if (mcp) parts.push("MCP");
  parts.push([
    plural(Number(chrome.tabs) || 0, "Tab"),
    plural(Number(chrome.proxies) || 0, "proxy", "proxies"),
    plural(Number(chrome.transports) || 0, "transport"),
    `Wisp ${chrome.wisp ? "active" : "inactive"}`,
  ].join(", "));
  return parts.join(" | ");
}

function applyWindowTitle() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.setTitle(composeWindowTitle(windowChrome)); } catch { /* ignore */ }
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
    mcp: { ...mcpServer.status(), headless: headlessActive, startupLaunch: Boolean(appSettings?.mcpLaunchOnStartup) },
    about: buildInfo.collect(),  };
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
    routeWispUpgrade(wispServer, req, socket, head);
  });
}

async function ensureComboHosts(count = 1) {
  const need = Math.max(0, Number(count) || 0);
  async function startPaneServer() {
    const server = createStaticServer(importsRoot);
    attachWispUpgrade(server);
    await listenOn(server, 0, "127.0.0.1");
    return { server, port: server.address().port };
  }

  while (comboServers.length < need) {
    if (comboServers.length === 0 && extraServer && extraPort && extraPort !== listenPort) {
      comboServers.push({ server: extraServer, port: extraPort });
      continue;
    }
    comboServers.push(await startPaneServer());
  }

  return {
    hosts: comboServers.slice(0, need).map((entry) => ({
      port: entry.port,
      origin: `http://127.0.0.1:${entry.port}`,
    })),
  };
}

async function openComboWindow(payload) {
  const comboId = String(payload.comboId || "").trim();
  const originUrl = String(payload.origin || "").trim();
  const session = payload.session;
  if (!comboId || !originUrl || !session) {
    return { ok: false, error: "Missing combo window payload." };
  }
  closeComboWindow(comboId);
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: "#161616",
    title: payload.title || `PDTK · ${comboId}`,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  comboWindows.set(comboId, win);
  win.on("closed", () => {
    comboWindows.delete(comboId);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("combo-window-closed", { comboId });
    }
  });
  await win.loadURL(`${originUrl.replace(/\/$/, "")}/harness/pane.html`);
  const boot = {
    type: "pdtk-boot",
    session,
  };
  await win.webContents.executeJavaScript(
    `window.__pdtkBootPane && window.__pdtkBootPane(${JSON.stringify(session)}); true;`
  ).catch(async () => {
    await win.webContents.executeJavaScript(
      `window.postMessage(${JSON.stringify(boot)}, "*"); true;`
    );
  });
  return { ok: true, comboId };
}

function closeComboWindow(comboId) {
  const id = String(comboId || "").trim();
  const win = comboWindows.get(id);
  if (!win) return;
  comboWindows.delete(id);
  if (!win.isDestroyed()) win.destroy();
}

function closeAllComboWindows() {
  for (const id of [...comboWindows.keys()]) closeComboWindow(id);
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

const INSPECT_FILL_CSS = `
:root, html, body {
  --devtools-window-left: 0px !important;
  --devtools-window-top: 0px !important;
  --devtools-window-right: 0px !important;
  --devtools-window-bottom: 0px !important;
}
html, body, .root-view, .root-view > .split-widget {
  width: 100% !important;
  height: 100% !important;
  max-width: none !important;
  max-height: none !important;
  margin: 0 !important;
  left: 0 !important;
  top: 0 !important;
}
.inspected-page-placeholder {
  display: none !important;
}
.root-view > .split-widget:has(.inspected-page-placeholder) > [slot="main"] {
  display: none !important;
  width: 0 !important;
  min-width: 0 !important;
  flex: 0 0 0px !important;
}
.root-view > .split-widget:has(.inspected-page-placeholder) > [slot="sidebar"] {
  position: absolute !important;
  inset: 0 !important;
  width: 100% !important;
  height: 100% !important;
  max-width: none !important;
  left: 0 !important;
  margin: 0 !important;
}
.root-view > .split-widget:has(.inspected-page-placeholder) > .split-widget-resizer {
  display: none !important;
}
`;

const INSPECT_FILL_JS = `(() => {
  const apply = () => {
    const placeholder = document.querySelector(".inspected-page-placeholder");
    if (!placeholder) return;
    const main = placeholder.closest("[slot='main']");
    if (main) {
      main.style.setProperty("display", "none", "important");
      main.style.setProperty("width", "0px", "important");
      main.style.setProperty("min-width", "0px", "important");
    }
    const split = placeholder.closest(".split-widget");
    const sidebar = split && split.querySelector(':scope > [slot="sidebar"]');
    if (sidebar) {
      sidebar.style.setProperty("position", "absolute", "important");
      sidebar.style.setProperty("inset", "0px", "important");
      sidebar.style.setProperty("width", "100%", "important");
      sidebar.style.setProperty("height", "100%", "important");
      sidebar.style.setProperty("max-width", "none", "important");
      sidebar.style.setProperty("left", "0px", "important");
      sidebar.style.removeProperty("transform");
    }
    const resizer = split && split.querySelector(":scope > .split-widget-resizer");
    if (resizer) resizer.style.setProperty("display", "none", "important");
  };
  apply();
  if (!window.__pdtkFillInspect) {
    window.__pdtkFillInspect = true;
    window.addEventListener("resize", apply);
  }
})()`;

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
  const url = String(contents.getURL() || "");
  if (url && !url.startsWith("devtools:")) return;

  try {
    if (!fitInspectCssKey) fitInspectCssKey = await contents.insertCSS(INSPECT_FILL_CSS);
  } catch {
    fitInspectCssKey = null;
  }

  try {
    await contents.executeJavaScript(INSPECT_FILL_JS, true);
  } catch {
    /* DevTools frontend may not be ready yet. */
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
    mainWindow.webContents.openDevTools({ mode: "detach", activate: true });
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
  if (mcpStartupLaunch && appSettings.mcpLaunchOnStartup && !appSettings.mcpEnabled) {
    appSettings = await settingsStore.write({ ...appSettings, mcpEnabled: true });
  }
  devtoolsEnabled = appSettings.devtools !== false;
  applyRuntimePolicies(appSettings);
  syncMcpStartupLaunch(appSettings);
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
    routeWispUpgrade(wisp, req, socket, head);
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

  headlessActive = Boolean(wantHeadless);
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: !headlessActive,
    skipTaskbar: headlessActive,
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
  mainWindow.on("page-title-updated", (event) => {
    event.preventDefault();
    applyWindowTitle();
  });
  if (!headlessActive) {
    mainWindow.once("ready-to-show", () => {
      if (!mainWindow || mainWindow.isDestroyed() || headlessActive) return;
      mainWindow.show();
    });
  }

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
    inspectView.webContents.on("did-finish-load", () => {
      fitInspectCssKey = null;
      fitInspectContents();
      setTimeout(() => fitInspectContents(), 200);
      setTimeout(() => fitInspectContents(), 800);
    });
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
    closeAllComboWindows();
    void mcpServer.stop();    httpServer.close();
    if (extraServer) extraServer.close();
    for (const entry of comboServers) {
      if (entry.server && entry.server !== extraServer && entry.server !== httpServer) {
        try { entry.server.close(); } catch { /* ignore */ }
      }
    }
    comboServers = [];
    if (lanWisp) lanWisp.close();
  });
}

app.setName("Proxy Development Toolkit");
if (process.platform === "win32") {
  app.setAppUserModelId("com.proxydevelopmenttoolkit.app");
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const requestVisible = !argv.includes("--headless") && !argv.includes("--mcp-startup");
    if (requestVisible) revealMainWindow();
    else if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
  });

  app.whenReady().then(async () => {
    registerIpc();
    await createWindow();
    applyHeadlessPolicy();
  });
}

app.on("window-all-closed", () => {
  try { verboseConsole.stopAll({ sigint: true }); } catch { /* ignore */ }
  app.quit();
});

app.on("before-quit", () => {
  try { verboseConsole.stopAll({ sigint: true }); } catch { /* ignore */ }
  try { devServer.stop(); } catch { /* ignore */ }
});
