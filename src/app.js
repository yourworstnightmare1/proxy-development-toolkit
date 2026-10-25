import {
  clampInfoSpan,
  facingEdge,
  fitInfoSize,
  fitInspectSize,
  INFO_MIN_HEIGHT,
  INFO_MIN_WIDTH,
  INSPECT_MIN_HEIGHT,
  INSPECT_MIN_WIDTH,
  layoutPanels,
  slotFromPoint,
} from "./dock-layout.mjs";
import { initSettings, openMcpSettings, runStartupUpdateCheck } from "./settings-page.mjs";
import {
  initTweaks,
  loadTweaksFromSettings,
  tweaks,
  applyTabCloaking,
  cloakedAddress,
  ensureIframeWrapper,
  startVerboseConsoles,
  stopVerboseConsoles,
  applyTweaksPatch,
  tweakSnapshot,
} from "./tweaks.mjs";
import {
  initCombos,
  loadCombosFromSettings,
  enabledTestCombos,
  formatComboChip,
} from "./combos.mjs";
import { createMultiController } from "./multi-session.mjs";
import { syncEruda } from "./harness/eruda.mjs";

const MERCURY_WISP = "wss://wisp.mercurywork.shop/";
const BARE_TRANSPORTS = new Set(["bare-transport", "bare-mux"]);
const TRANSPORT_IDS = ["epoxy-tls", "wisp-js", "libcurl-transport", "bare-transport", "bare-mux"];
const TRANSPORT_ALIASES = {
  epoxy: "epoxy-tls",
  "epoxy-transport": "epoxy-tls",
  libcurl: "libcurl-transport",
  wisp: "wisp-js",
  wispjs: "wisp-js",
  bare: "bare-transport",
  baremux: "bare-mux",
  "bare-mux-legacy": "bare-mux",
};
const VERBOSE_TWEAKS = new Set([
  "wispVerbose", "wispVerboseMinimized",
  "proxyVerbose", "proxyVerboseMinimized",
  "transportVerbose", "transportVerboseMinimized",
]);
const RELOAD_TWEAKS = new Set(["siteCloaking", "siteCloakMode", "loadInIframe"]);

function normalizeTransportId(value, fallback = "epoxy-tls") {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return fallback;
  const id = TRANSPORT_ALIASES[raw] || raw;
  if (!TRANSPORT_IDS.includes(id)) {
    throw new Error(`Unknown transport "${value}". Use one of: ${TRANSPORT_IDS.join(", ")}.`);
  }
  return id;
}

function normalizeProxyKind(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw === "scramjet" || raw === "sj") return "scramjet";
  if (raw === "ultraviolet" || raw === "uv") return "ultraviolet";
  throw new Error(`Unknown proxy "${value}". Use scramjet or ultraviolet.`);
}

const launchForm = document.getElementById("launch-form");
const launchStatus = document.getElementById("launch-status");
const launcher = document.getElementById("launcher");
const frameWrap = document.getElementById("frame-wrap");
const frame = document.getElementById("proxy-frame");
const comboFrames = document.getElementById("combo-frames");
const address = document.getElementById("address");
const sidebar = document.getElementById("sidebar");
const liveStatus = document.getElementById("live-status");
const sessionInfo = document.getElementById("session-info");
const statsList = document.getElementById("stats-list");
const statsSummary = document.getElementById("stats-summary");
const openSessionBtn = document.getElementById("open-session");

const state = {
  origin: "",
  session: null,
  controller: null,
  frameHandle: null,
  frameTarget: null,
  connection: null,
  loading: false,
  paused: false,
  stats: [],
  multi: null,
  pageTitle: "",
};

const prefs = {
  allowMultipleTabs: false,
  allowUrlModification: true,
  allowSiteRedirects: true,
  screenWidth: 1920,
  screenHeight: 1080,
  screenOrientation: "landscape",
  eruda: false,
};

const tabStrip = document.getElementById("tab-strip");
const tabList = document.getElementById("tab-list");
const tabs = {
  items: [{ id: "tab-1", title: "Tab 1", destination: "" }],
  activeId: "tab-1",
  seq: 1,
};

function tabTitle(url) {
  try {
    const host = new URL(url).hostname;
    return host || url || "New tab";
  } catch {
    return url || "New tab";
  }
}

function activeTab() {
  return tabs.items.find((tab) => tab.id === tabs.activeId) || tabs.items[0];
}

let lastWindowChrome = "";

function currentWindowChrome() {
  const session = state.session;
  const cloakTitle = tweaks.tabCloaking && tweaks.tabName.trim() ? tweaks.tabName.trim() : "";
  if (!session) return { session: false, cloakTitle };
  if (session.mode === "multi") {
    const combos = state.multi?.runtime.combos?.length ? state.multi.runtime.combos : session.combos || [];
    const running = combos.filter((combo) => !combo.error);
    const active = state.multi?.activeCombo();
    return {
      session: true,
      cloakTitle,
      siteTitle: active?.pageTitle || tabTitle(active?.bootSession?.destination || session.destination),
      proxy: proxyLabel(active?.proxy),
      transport: active?.transport || "",
      tabs: combos.length,
      proxies: new Set(running.map((combo) => combo.proxy?.kind)).size,
      transports: new Set(running.map((combo) => combo.transport)).size,
      wisp: Boolean(session.wispUrl) && running.some((combo) => !BARE_TRANSPORTS.has(combo.transport)),
    };
  }
  return {
    session: true,
    cloakTitle,
    siteTitle: state.pageTitle || tabTitle(session.destination),
    proxy: proxyLabel(session.proxy),
    transport: session.transport,
    tabs: prefs.allowMultipleTabs ? tabs.items.length : 1,
    proxies: 1,
    transports: 1,
    wisp: Boolean(session.wispUrl) && !BARE_TRANSPORTS.has(session.transport),
  };
}

function updateWindowTitle() {
  const chrome = currentWindowChrome();
  const key = JSON.stringify(chrome);
  if (key === lastWindowChrome) return;
  lastWindowChrome = key;
  void window.pdtk.setWindowChrome?.(chrome);
}

function readSinglePageTitle() {
  if (!state.session || state.session.mode === "multi") return;
  const target = document.getElementById("iframe-cloak-frame") || frame;
  let title = "";
  try { title = target?.contentDocument?.title || ""; } catch { /* cross-origin document */ }
  state.pageTitle = title.trim();
}

setInterval(() => {
  readSinglePageTitle();
  updateWindowTitle();
}, 1000);

function renderTabs() {
  if (!tabList) return;
  tabList.innerHTML = "";
  for (const tab of tabs.items) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `tab-chip${tab.id === tabs.activeId ? " active" : ""}`;
    button.dataset.tabId = tab.id;
    button.title = tab.destination || "New tab";
    const label = document.createElement("span");
    label.textContent = tab.title || "New tab";
    button.appendChild(label);
    if (tabs.items.length > 1) {
      const close = document.createElement("span");
      close.className = "tab-close";
      close.textContent = "×";
      close.title = "Close tab";
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        closeTab(tab.id);
      });
      button.appendChild(close);
    }
    button.addEventListener("click", () => selectTab(tab.id));
    tabList.appendChild(button);
  }
}

function syncTabStrip() {
  document.getElementById("tab-new")?.classList.toggle("hidden", state.session?.mode === "multi");
  if (state.session?.mode === "multi") {
    state.multi?.renderComboTabs();
    return;
  }
  const show = prefs.allowMultipleTabs && Boolean(state.session);
  tabStrip?.classList.toggle("hidden", !show);
  if (show) renderTabs();
}

function selectTab(id) {
  const tab = tabs.items.find((item) => item.id === id);
  if (!tab) return;
  tabs.activeId = tab.id;
  renderTabs();
  if (!state.session) {
    if (tab.destination) document.getElementById("site-url").value = tab.destination;
    return;
  }
  if (tab.destination && tab.destination !== state.session.destination) {
    navigate(tab.destination, { fromTab: true });
  } else if (tab.destination) {
    setAddressDisplay(tab.destination);
  }
  applyTabCloaking(tab);
}

function addTab(destination = "") {
  tabs.seq += 1;
  const id = `tab-${tabs.seq}`;
  tabs.items.push({ id, title: tabTitle(destination) || `Tab ${tabs.seq}`, destination });
  tabs.activeId = id;
  renderTabs();
  if (state.session && destination) navigate(destination, { fromTab: true });
  else if (state.session) {
    setAddressDisplay("");
  }
}

function closeTab(id) {
  if (tabs.items.length <= 1) return;
  const index = tabs.items.findIndex((tab) => tab.id === id);
  if (index < 0) return;
  tabs.items.splice(index, 1);
  if (tabs.activeId === id) {
    const next = tabs.items[Math.max(0, index - 1)];
    tabs.activeId = next.id;
    selectTab(next.id);
  } else {
    renderTabs();
  }
}

function rememberTabDestination(url) {
  const tab = activeTab();
  if (!tab) return;
  tab.destination = url;
  if (tweaks.tabCloaking && tweaks.tabName.trim()) tab.title = tweaks.tabName.trim();
  else tab.title = tabTitle(url);
  if (prefs.allowMultipleTabs) renderTabs();
  applyTabCloaking(tab);
}

function setAddressDisplay(realUrl) {
  if (!address) return;
  address.dataset.realUrl = realUrl || "";
  address.value = cloakedAddress(realUrl || "");
  if (tweaks.siteCloaking) {
    address.readOnly = true;
    address.classList.add("locked");
  } else {
    address.readOnly = !prefs.allowUrlModification;
    address.classList.toggle("locked", !prefs.allowUrlModification);
  }
}

function applyBrowserPrefs(settings) {
  if (!settings) return;
  prefs.allowMultipleTabs = Boolean(settings.allowMultipleTabs);
  prefs.allowUrlModification = settings.allowUrlModification !== false;
  prefs.allowSiteRedirects = settings.allowSiteRedirects !== false;
  prefs.screenWidth = Number(settings.screenWidth) || 1920;
  prefs.screenHeight = Number(settings.screenHeight) || 1080;
  prefs.screenOrientation = settings.screenOrientation === "portrait" ? "portrait" : "landscape";
  prefs.eruda = Boolean(settings.eruda);
  if (state.session?.destination) setAddressDisplay(state.session.destination);
  else {
    address.readOnly = !prefs.allowUrlModification;
    address.classList.toggle("locked", !prefs.allowUrlModification);
  }
  syncTabStrip();
  if (state.session?.mode === "multi") {
    state.multi?.postToAll({ type: "pdtk-screen", screen: screenPrefs() });
    state.multi?.postToAll({ type: "pdtk-eruda", enabled: prefs.eruda });
  } else {
    applyScreenSpoofTo(activeProxyFrame()?.contentWindow);
    if (state.session) syncEruda(activeProxyFrame()?.contentWindow, prefs.eruda);
  }
}

function activeProxyFrame() {
  if (tweaks.loadInIframe && state.session?.mode !== "multi") {
    ensureIframeWrapper(true);
    return document.getElementById("iframe-cloak-frame") || frame;
  }
  ensureIframeWrapper(false);
  return frame;
}

function screenPrefs() {
  let width = Math.max(1, prefs.screenWidth || 1920);
  let height = Math.max(1, prefs.screenHeight || 1080);
  if (prefs.screenOrientation === "portrait" && width > height) {
    [width, height] = [height, width];
  } else if (prefs.screenOrientation !== "portrait" && height > width) {
    [width, height] = [height, width];
  }
  return { width, height };
}

function applyScreenSpoofTo(win) {
  if (!win) return;
  const { width, height } = screenPrefs();
  try {
    win.eval(`(() => {
      const w = ${width}, h = ${height};
      try {
        Object.defineProperty(window.screen, "width", { configurable: true, get: () => w });
        Object.defineProperty(window.screen, "height", { configurable: true, get: () => h });
        Object.defineProperty(window.screen, "availWidth", { configurable: true, get: () => w });
        Object.defineProperty(window.screen, "availHeight", { configurable: true, get: () => h });
      } catch (e) {}
    })()`);
  } catch { /* cross-origin */ }
}

function localWisp() {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/wisp/`;
}

function defaultWisp() {
  // Prefer the in-app Wisp endpoint. The public Mercury demo host is often unreachable.
  return localWisp();
}

const proxyPaneState = {
  single: { importMode: null, git: null },
  left: { importMode: null, git: null },
  right: { importMode: null, git: null },
};
let siteMode = "url";
let devServerUrl = "";
let siteGit = null;

function proxyCombo(pane) {
  return document.querySelector(`.combo[data-proxy-pane="${pane}"]`);
}

function setSessionServerState(kind, title) {
  const icon = document.getElementById("session-server-icon");
  if (!icon) return;
  const map = {
    ready: { src: "/icons/server-ready.svg?v=2", title: title || "Ready to start" },
    error: { src: "/icons/server-error.svg?v=2", title: title || "Conflict — cannot start" },
    starting: { src: "/icons/server-starting.svg?v=2", title: title || "Starting…" },
  };
  const next = map[kind] || map.ready;
  icon.src = next.src;
  icon.dataset.state = kind;
  icon.title = next.title;
  icon.alt = next.title;
}

function setStatus(node, message, isError) {
  node.textContent = message || "";
  node.classList.toggle("error", Boolean(isError));
  if (node === launchStatus) {
    if (isError && message) setSessionServerState("error", message);
    else if (!message) setSessionServerState("ready");
  }
}

function normalizeHttp(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Enter a URL.");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function normalizeWisp(value, fallback) {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  const withScheme = /^(wss?:|ws:)\//i.test(raw) || /^wss?:/i.test(raw)
    ? raw
    : `wss://${raw.replace(/^\/+/, "")}`;
  const url = new URL(withScheme);
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new Error("Wisp URL must use wss:// or ws://.");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

function normalizeBare(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Bare server URL is required for this transport.");
  const url = new URL(normalizeHttp(raw));
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

function syncTransportFields() {
  const bare = BARE_TRANSPORTS.has(document.getElementById("transport").value);
  document.getElementById("wisp-field").classList.toggle("hidden", bare);
  document.getElementById("bare-field").classList.toggle("hidden", !bare);
  const liveBare = BARE_TRANSPORTS.has(document.getElementById("live-transport").value);
  document.getElementById("live-wisp-label").classList.toggle("hidden", liveBare);
  document.getElementById("live-bare-label").classList.toggle("hidden", !liveBare);
}

function syncSiteFields() {
  const url = document.getElementById("site-url");
  url.placeholder = siteMode === "git" ? "https://github.com/owner/site" : "https://example.com";
  document.getElementById("site-subdir").classList.toggle("hidden", siteMode === "url");
  document.getElementById("dev-server-row")?.classList.toggle("hidden", siteMode === "url");
  document.getElementById("dev-server-deps")?.classList.toggle("hidden", siteMode === "url");
  void paintDevDeps();
}

function syncProxyFields(pane = "single") {
  const combo = proxyCombo(pane);
  if (!combo) return;
  const mode = proxyPaneState[pane]?.importMode || null;
  combo.querySelector(".proxy-kind")?.classList.toggle("hidden", Boolean(mode));
  combo.querySelector(".proxy-folder")?.classList.toggle("hidden", mode !== "folder");
  combo.querySelector(".proxy-url")?.classList.toggle("hidden", mode !== "git");
  combo.querySelector(".proxy-custom-clear")?.classList.toggle("hidden", !mode);
}

function syncSplitUi() {
  const n = enabledTestCombos().length;
  openSessionBtn.textContent = n ? `Start ${n} Combo${n === 1 ? "" : "s"}` : "Start Session";
  syncProxyFields("single");
}

function joinBase(base, file) {
  return `/${String(base).replace(/^\/+|\/+$/g, "")}/${String(file).replace(/^\/+/, "")}`;
}

function loadScript(src) {
  const existing = document.querySelector(`script[data-pdtk="${CSS.escape(src)}"]`);
  if (existing) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.dataset.pdtk = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

async function withoutProcess(loader) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, "process");
  const original = globalThis.process;
  try {
    globalThis.process = undefined;
  } catch { /* ignore */ }
  try {
    return await loader();
  } finally {
    try {
      if (had) globalThis.process = original;
      else delete globalThis.process;
    } catch { /* ignore */ }
  }
}

function asTuples(headers) {
  if (!headers) return [];
  if (Array.isArray(headers)) {
    return headers.filter((row) => Array.isArray(row) && row.length >= 2).map((row) => [String(row[0]), String(row[1])]);
  }
  if (typeof headers.forEach === "function") {
    const rows = [];
    headers.forEach((value, key) => rows.push([String(key), String(value)]));
    return rows;
  }
  return Object.entries(headers).flatMap(([key, value]) =>
    Array.isArray(value) ? value.map((item) => [String(key), String(item)]) : [[String(key), String(value)]]
  );
}

function wrapTransport(transport) {
  return {
    get ready() { return transport.ready; },
    init: () => transport.init?.(),
    meta: () => transport.meta?.() || {},
    connect: (...args) => transport.connect(...args),
    async request(remote, method, body, headers, signal) {
      if (body instanceof Blob) body = await body.arrayBuffer();
      const started = performance.now();
      try {
        const headerList = asTuples(headers);
        const response = transport.client?.fetch
          ? await transport.client.fetch(remote.href, { method, body, headers: headerList, redirect: "manual", signal })
          : await transport.request(remote, method, body, headerList, signal);
        reportTransport({
          phase: "done",
          method,
          url: remote.href,
          status: response.status,
          bytes: response.body?.byteLength || 0,
          ms: Math.round(performance.now() - started),
          transport: state.session?.transport,
        });
        return {
          body: response.body,
          status: response.status,
          statusText: response.statusText,
          headers: asTuples(response.rawHeaders || response.headers),
        };
      } catch (error) {
        reportTransport({
          phase: "error",
          method,
          url: remote.href,
          error: error.message || String(error),
          transport: state.session?.transport,
        });
        throw error;
      }
    },
  };
}

function reportTransport(detail) {
  addStat({ source: "transport", id: `${detail.url}-${Date.now()}`, ...detail });
}

async function installLegacyMux(bareUrl) {
  if (!globalThis.uuid) globalThis.uuid = { v4: () => crypto.randomUUID() };
  await loadScript("/bare/index.js");
  await loadScript("/baremux-legacy/bare.cjs");
  if (globalThis.BareMux?.SetTransport) {
    globalThis.BareMux.SetTransport("BareMod.BareClient", bareUrl);
  }
}

async function createRawTransport(session) {
  if (session.transport === "epoxy-tls") {
    const mod = await import("/epoxy/index.mjs");
    const client = new mod.default({ wisp: session.wispUrl });
    await client.init();
    return client;
  }
  if (session.transport === "libcurl-transport") {
    const mod = await withoutProcess(() => import("/harness/libcurl-transport.mjs"));
    const client = new mod.default({ wisp: session.wispUrl });
    await client.init();
    return client;
  }
  if (session.transport === "wisp-js") {
    const mod = await import("/harness/wisp-js-transport.mjs");
    const client = new mod.default({ wisp: session.wispUrl });
    await client.init();
    return client;
  }
  if (session.transport === "bare-mux") await installLegacyMux(session.bareUrl);
  const mod = await import("/bare/index.mjs");
  const Ctor = mod.BareClient || mod.default;
  const client = new Ctor(session.bareUrl);
  await client.init?.();
  client.ready = true;
  return client;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function waitForActivation(worker) {
  if (!worker || worker.state === "activated" || worker.state === "redundant") return Promise.resolve();
  return new Promise((resolve) => {
    const onChange = () => {
      if (worker.state !== "activated" && worker.state !== "redundant") return;
      worker.removeEventListener("statechange", onChange);
      resolve();
    };
    worker.addEventListener("statechange", onChange);
  });
}

// A retired worker from the previous session can still be `controller`; only the
// registration's current active worker has this session's transport attached.
async function workerControlsPage(registration, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pending = registration.installing || registration.waiting;
    if (pending) {
      await Promise.race([waitForActivation(pending), sleep(deadline - Date.now())]);
      continue;
    }
    if (registration.active && navigator.serviceWorker.controller === registration.active) return true;
    await Promise.race([
      new Promise((resolve) => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true })),
      sleep(Math.min(250, deadline - Date.now())),
    ]);
  }
  return false;
}

async function registerWorker() {
  if (!navigator.serviceWorker) throw new Error("Service workers are not available.");
  const options = { scope: "/", updateViaCache: "none" };
  let registration = await navigator.serviceWorker.register("/sw.js", options);
  await registration.update().catch(() => {});
  if (await workerControlsPage(registration, 4000)) return;
  await registration.unregister().catch(() => {});
  registration = await navigator.serviceWorker.register("/sw.js", options);
  if (await workerControlsPage(registration, 8000)) return;
  throw new Error("Timed out waiting for the service worker");
}

async function bootScramjet(session) {
  const script = session.proxy.scramjetJs
    ? joinBase(session.proxy.base, session.proxy.scramjetJs)
    : "/vendor/scramjet/scramjet.js";
  const wasm = session.proxy.wasm
    ? joinBase(session.proxy.base, session.proxy.wasm)
    : "/vendor/scramjet/scramjet.wasm";
  const api = session.proxy.controllerApi
    ? joinBase(session.proxy.base, session.proxy.controllerApi)
    : "/vendor/controller/controller.api.js";
  await loadScript(script);
  await loadScript(api);
  await registerWorker();
  const transport = wrapTransport(await createRawTransport(session));
  const controller = new $scramjetController.Controller({
    serviceworker: navigator.serviceWorker.controller,
    transport,
    config: {
      scramjetPath: script,
      wasmPath: wasm,
      injectPath: session.proxy.controllerInject
        ? joinBase(session.proxy.base, session.proxy.controllerInject)
        : "/vendor/controller/controller.inject.js",
    },
  });
  await controller.wait();
  state.controller = controller;
  state.frameHandle = null;
}

function uvConfig(session) {
  const base = session.proxy.base ? `/${session.proxy.base}` : "/uv";
  return {
    prefix: "/uv/service/",
    bundle: session.proxy.bundle ? `${base}/${session.proxy.bundle}` : "/uv/uv.bundle.js",
    handler: session.proxy.handler ? `${base}/${session.proxy.handler}` : "/uv/uv.handler.js",
    client: session.proxy.client ? `${base}/${session.proxy.client}` : "/uv/uv.client.js",
    sw: session.proxy.sw ? `${base}/${session.proxy.sw}` : "/uv/uv.sw.js",
  };
}

async function bootUltraviolet(session) {
  const config = uvConfig(session);
  await loadScript(config.bundle);
  await loadScript("/baremux/index.js");
  await registerWorker();
  globalThis.__uv$config = {
    prefix: config.prefix,
    encodeUrl: Ultraviolet.codec.xor.encode,
    decodeUrl: Ultraviolet.codec.xor.decode,
    handler: config.handler,
    client: config.client,
    bundle: config.bundle,
    config: "/uv/uv.config.js",
    sw: config.sw,
  };
  state.connection = new BareMux.BareMuxConnection("/baremux/worker.js");
  if (session.transport === "bare-mux") {
    const client = await createRawTransport(session);
    await state.connection.setRemoteTransport(wrapTransport(client), "bare-mux-legacy");
    setStatus(liveStatus, "Legacy bare-mux SetTransport is active. Ultraviolet still needs a worker bridge, so the Bare client is attached without loading a v2 transport module.");
  } else if (session.transport === "bare-transport") {
    await state.connection.setTransport("/bare/index.mjs", [session.bareUrl]);
  } else if (session.transport === "wisp-js") {
    await state.connection.setTransport("/harness/wisp-js-transport.mjs", [{ wisp: session.wispUrl }]);
  } else if (session.transport === "libcurl-transport") {
    await state.connection.setTransport("/harness/libcurl-transport.mjs", [{ wisp: session.wispUrl }]);
  } else {
    await state.connection.setTransport("/epoxy/index.mjs", [{ wisp: session.wispUrl }]);
  }
}

function proxiedHref(url) {
  return new URL(__uv$config.prefix + __uv$config.encodeUrl(url), location.origin).href;
}

function syncMainSession() {
  if (!state.session) return;
  window.pdtk.setSession(state.session).catch(() => {});
}

function navigate(url, options = {}) {
  if (!state.session) return;
  const next = normalizeHttp(url);
  if (!prefs.allowSiteRedirects && !options.fromUser && !options.fromTab && !options.fromMcp) {
    if (state.session.destination && next !== state.session.destination) {
      setAddressDisplay(state.session.destination);
      return;
    }
  }
  state.session.destination = next;
  setAddressDisplay(next);
  rememberTabDestination(next);
  syncMainSession();
  state.loading = true;
  if (state.session.mode === "multi") {
    const active = state.multi?.activeCombo();
    if (active) {
      active.bootSession = { ...active.bootSession, destination: next };
      state.multi.postToActive({ type: "pdtk-navigate", url: next });
    }
    return;
  }
  const target = activeProxyFrame();
  if (state.session.proxy.kind === "scramjet") {
    if (!state.frameHandle || state.frameTarget !== target) {
      state.frameHandle = state.controller.createFrame(target);
      state.frameTarget = target;
    }
    state.frameHandle.go(next);
    return;
  }
  if (state.session.proxy.kind === "ultraviolet") {
    target.src = proxiedHref(next);
    return;
  }
  const entry = state.session.proxy.index
    ? joinBase(state.session.proxy.base, state.session.proxy.index)
    : `/${state.session.proxy.base}/`;
  const glue = entry.includes("?") ? "&" : "?";
  target.src = `${entry}${glue}url=${encodeURIComponent(next)}`;
  setStatus(liveStatus, "Imported proxy has no Scramjet or Ultraviolet entry. Live transport injection may not apply.");
}

function proxyLabel(proxy) {
  return proxy?.label || proxy?.kind || "—";
}

function renderSession() {
  const session = state.session;
  if (!session) {
    sessionInfo.innerHTML = "";
    return;
  }
  const rows = [
    ["Site", session.destination],
    ["Mode", session.mode === "multi" ? `Test combos (${session.combos?.length || 0})` : "Single"],
  ];
  if (session.mode === "multi") {
    for (const combo of session.combos || []) {
      rows.push([combo.label || combo.id, `${proxyLabel(combo.proxy)} · ${combo.transport}`]);
    }
  } else {
    rows.push(["Proxy", proxyLabel(session.proxy)]);
    rows.push(["Transport", session.transport]);
  }
  rows.push(
    ["Wisp", session.wispUrl || "—"],
    ["Bare", session.bareUrl || "—"]
  );
  sessionInfo.innerHTML = rows.map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join("");
}

function fillLiveProxy() {
  const select = document.getElementById("live-proxy");
  const splitNote = document.getElementById("live-proxy-split");
  const label = select.closest("label");
  if (state.session?.mode === "multi") {
    const active = state.multi?.activeCombo();
    select.classList.add("hidden");
    if (label) label.classList.add("hidden");
    splitNote.classList.remove("hidden");
    splitNote.textContent = active
      ? `${active.label}: ${proxyLabel(active.proxy)} · ${active.transport}`
      : "No active combo";
    state.multi?.syncLiveComboSelect();
    return;
  }
  select.classList.remove("hidden");
  if (label) label.classList.remove("hidden");
  splitNote.classList.add("hidden");
  const imported = state.session.proxy.base
    ? `<option value="keep">${state.session.proxy.label || "Imported proxy"}</option>`
    : "";
  select.innerHTML = `${imported}<option value="scramjet">Scramjet</option><option value="ultraviolet">Ultraviolet</option>`;
  select.value = state.session.proxy.base ? "keep" : state.session.proxy.kind;
}

function syncSessionChrome(active) {
  const chrome = document.getElementById("chrome");
  chrome?.classList.toggle("menu-mode", !active);
  if (!active) {
    sidebar.classList.add("collapsed");
    applyDock();
  }
}

function showSession() {
  launcher.classList.add("hidden");
  frameWrap.classList.remove("hidden");
  const multi = state.session?.mode === "multi";
  frameWrap.classList.toggle("split", false);
  comboFrames?.classList.toggle("hidden", !multi);
  frame.classList.toggle("hidden", multi);
  syncSessionChrome(true);
  applyDock();
  fillLiveProxy();
  if (!multi) {
    document.getElementById("live-transport").value = state.session.transport;
  } else {
    const active = state.multi?.activeCombo();
    if (active) document.getElementById("live-transport").value = active.transport;
  }
  document.getElementById("live-wisp").value = state.session.wispUrl || "";
  document.getElementById("live-bare").value = state.session.bareUrl || "";
  syncTransportFields();
  renderSession();
  syncTabStrip();
}

async function startMultiSession(session) {
  state.session = session;
  state.controller = null;
  state.frameHandle = null;
  if (!state.multi) {
    state.multi = createMultiController({
      frameWrap,
      proxyFrame: frame,
      comboFramesEl: comboFrames,
      tabStrip,
      tabList,
      setStatus,
      liveStatus,
      screenPrefs,
      erudaEnabled: () => prefs.eruda,
      onActiveChanged: (combo) => {
        if (!combo) {
          if (state.session?.mode === "multi") {
            endSession().catch((error) => setStatus(liveStatus, error.message || String(error), true));
          }
          return;
        }
        if (!state.session) return;
        document.getElementById("live-transport").value = combo.transport;
        fillLiveProxy();
        renderSession();
        updateWindowTitle();
      },
    });
  }
  showSession();
  const outcome = await state.multi.start(session);
  setAddressDisplay(session.destination);
  rememberTabDestination(session.destination);
  state.loading = false;
  await window.pdtk.setSession(session);
  updateWindowTitle();
  return outcome;
}

async function startSession(session) {
  if (session.mode === "multi") {
    const outcome = await startMultiSession(session);
    await startVerboseConsoles().catch((error) => {
      setStatus(liveStatus, error.message || String(error), true);
    });
    applyTabCloaking(activeTab());
    ensureIframeWrapper(false);
    setAddressDisplay(session.destination);
    updateWindowTitle();
    return outcome;
  }
  state.session = session;
  state.controller = null;
  state.frameHandle = null;
  state.frameTarget = null;
  showSession();
  setStatus(liveStatus, "Starting proxy…");
  if (session.proxy.kind === "scramjet") await bootScramjet(session);
  else if (session.proxy.kind === "ultraviolet") await bootUltraviolet(session);
  else setStatus(liveStatus, "Opaque imported proxy. Live transport injection may not apply.");
  navigate(session.destination, { fromUser: true });
  rememberTabDestination(session.destination);
  applyScreenSpoofTo(activeProxyFrame()?.contentWindow);
  applyTabCloaking(activeTab());
  await startVerboseConsoles().catch((error) => {
    setStatus(liveStatus, error.message || String(error), true);
  });
  const notes = ["Session ready."];
  if (session.proxy.kind === "opaque") {
    notes.push("This import is not Scramjet or Ultraviolet, so live transport injection may not apply.");
  }
  if (session.localSite && session.wispUrl) {
    notes.push(`Local files are reached through ${session.wispUrl}.`);
  }
  if (!liveStatus.textContent.startsWith("Legacy")) setStatus(liveStatus, notes.join(" "));
  await window.pdtk.setSession(session);
  updateWindowTitle();
  return null;
}

async function prepareSite() {
  const mode = siteMode;
  const sub = document.getElementById("site-subdir").value.trim().replace(/^\/+|\/+$/g, "");
  if (devServerUrl) return { destination: sub ? `${devServerUrl}${sub}/` : devServerUrl, local: true };
  if (mode === "url") return { destination: normalizeHttp(document.getElementById("site-url").value), local: false };
  let imported;
  if (mode === "folder") {
    const folder = document.getElementById("site-folder").value;
    if (!folder) throw new Error("Choose a site folder.");
    imported = await window.pdtk.importFolder({ kind: "site", path: folder });
  } else if (siteGit) {
    imported = siteGit;
  } else {
    imported = await window.pdtk.importGit({ kind: "site", url: document.getElementById("site-url").value.trim() });
  }
  const path = [imported.base, sub].filter(Boolean).join("/");
  return { destination: `${state.origin}/${path}/`, local: true };
}

async function prepareProxy(pane = "single") {
  const combo = proxyCombo(pane);
  if (!combo) throw new Error("Proxy controls are missing.");
  const paneState = proxyPaneState[pane] || { importMode: null, git: null };
  if (!paneState.importMode) {
    const kind = combo.querySelector(".proxy-kind").value;
    return { kind, label: kind === "ultraviolet" ? "Ultraviolet" : "Scramjet" };
  }
  const mode = paneState.importMode;
  let imported;
  if (mode === "folder") {
    const folder = combo.querySelector(".proxy-folder").value;
    if (!folder) throw new Error(`Choose a ${pane === "single" ? "" : `${pane} `}proxy folder.`.replace("  ", " "));
    imported = await window.pdtk.importFolder({ kind: "proxy", path: folder });
  } else if (mode === "git") {
    imported = paneState.git || await window.pdtk.importGit({
      kind: "proxy",
      url: combo.querySelector(".proxy-url").value.trim(),
    });
  } else {
    imported = await window.pdtk.importUrl({ url: combo.querySelector(".proxy-url").value.trim() });
  }
  return {
    label: `Imported ${imported.kind}`,
    ...imported,
  };
}

function readEndpoints(localSite, transportId, wispInput, bareInput) {
  const transport = transportId;
  if (BARE_TRANSPORTS.has(transport)) {
    return { transport, wispUrl: "", bareUrl: normalizeBare(bareInput) };
  }
  const fallback = defaultWisp();
  return { transport, wispUrl: normalizeWisp(wispInput, fallback), bareUrl: "" };
}

launchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  openSessionBtn.disabled = true;
  setSessionServerState("starting");
  const enabledCombos = enabledTestCombos();
  setStatus(launchStatus, enabledCombos.length ? "Preparing test combos…" : "Preparing session…");
  try {
    const site = await prepareSite();
    if (enabledCombos.length) {
      const needsBare = enabledCombos.some((c) => BARE_TRANSPORTS.has(c.transport));
      const needsWisp = enabledCombos.some((c) => !BARE_TRANSPORTS.has(c.transport));
      let wispUrl = "";
      let bareUrl = "";
      if (needsWisp) {
        wispUrl = normalizeWisp(document.getElementById("wisp-url").value, defaultWisp());
        if (site.local) wispUrl = localWisp();
      }
      if (needsBare) bareUrl = normalizeBare(document.getElementById("bare-url").value);
      const hosts = await window.pdtk.ensureComboHosts({ count: enabledCombos.length });
      const session = {
        mode: "multi",
        destination: site.destination,
        localSite: site.local,
        wispUrl,
        bareUrl,
        transport: enabledCombos[0].transport,
        combos: enabledCombos.map((combo, index) => ({
          id: combo.id,
          label: formatComboChip(combo),
          proxy: { kind: combo.proxyKind, label: combo.proxyKind === "ultraviolet" ? "Ultraviolet" : "Scramjet" },
          transport: combo.transport,
          port: hosts.hosts[index].port,
          origin: hosts.hosts[index].origin,
        })),
      };
      await window.pdtk.setSession(session);
      await startSession(session);
    } else {
      const endpoints = readEndpoints(
        site.local,
        document.getElementById("transport").value,
        document.getElementById("wisp-url").value,
        document.getElementById("bare-url").value
      );
      if (site.local && !BARE_TRANSPORTS.has(endpoints.transport)) {
        endpoints.wispUrl = localWisp();
      }
      const proxy = await prepareProxy("single");
      const session = {
        mode: "single",
        destination: site.destination,
        localSite: site.local,
        proxy,
        ...endpoints,
      };
      await window.pdtk.setSession(session);
      await startSession(session);
    }
    setStatus(launchStatus, "");
    setSessionServerState("ready");
  } catch (error) {
    if (devServerUrl) await window.pdtk.stopDevServer?.().catch(() => {});
    setStatus(launchStatus, error.message || String(error), true);
    setSessionServerState("error", error.message || String(error));
    setStatus(liveStatus, error.message || String(error), true);
    launcher.classList.remove("hidden");
    frameWrap.classList.add("hidden");
    comboFrames?.classList.add("hidden");
    syncSessionChrome(false);
  } finally {
    openSessionBtn.disabled = false;
    devServerUrl = "";
  }
});

async function devServerFolder() {
  if (siteMode === "folder") return document.getElementById("site-folder").value;
  if (siteMode !== "git") return "";
  if (!siteGit?.path) {
    setStatus(launchStatus, "Cloning repository…");
    siteGit = await window.pdtk.importGit({ kind: "site", url: document.getElementById("site-url").value.trim() });
    void paintDevDeps();
  }
  return siteGit.path || "";
}

const DEV_DEP_LABELS = { npm: "npm", pnpm: "pnpm", yarn: "Yarn", bun: "Bun" };
let devDepsToken = 0;

async function paintDevDeps() {
  const hint = document.getElementById("dev-server-deps");
  if (!hint) return;
  const token = ++devDepsToken;
  const folder = siteMode === "folder" ? document.getElementById("site-folder").value : siteMode === "git" ? siteGit?.path : "";
  if (!folder || !window.pdtk.detectDevDeps) {
    hint.textContent = siteMode === "git" ? "Dependencies are detected after the repository is cloned." : "";
    return;
  }
  const found = await window.pdtk.detectDevDeps({ folder }).catch(() => null);
  if (token !== devDepsToken) return;
  const parts = [];
  if (found?.python?.files?.length) parts.push(`Python: ${found.python.files.join(", ")}${found.python.venv ? ` (uses ${found.python.venv})` : ""}`);
  if (found?.node?.hasDeps) parts.push(`Node: ${DEV_DEP_LABELS[found.node.manager] || found.node.manager}${found.node.lockfile ? ` (${found.node.lockfile})` : ""}`);
  hint.textContent = parts.length
    ? `Detected dependencies, installed automatically before the server starts. ${parts.join(" · ")}`
    : "No Python or Node dependencies detected.";
}

async function startWithDevServer(runtime) {
  const buttons = [...document.querySelectorAll("#dev-server-row button")];
  const name = runtime === "node" ? "node.js" : "Python";
  buttons.forEach((button) => { button.disabled = true; });
  openSessionBtn.disabled = true;
  setSessionServerState("starting", `Starting ${name} server…`);
  setStatus(launchStatus, `Starting ${name} server…`);
  try {
    const folder = await devServerFolder();
    if (!folder) throw new Error("Choose a site folder or clone a repository first.");
    const result = await window.pdtk.startDevServer({ runtime, folder });
    if (!result?.ok) throw new Error(result?.error || `Could not start the ${name} server.`);
    setStatus(launchStatus, `${result.command} is serving on ${result.url}`);
    devServerUrl = result.url;
    launchForm.requestSubmit();
  } catch (error) {
    setStatus(launchStatus, error.message || String(error), true);
    setSessionServerState("error", error.message || String(error));
    openSessionBtn.disabled = false;
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

document.getElementById("start-python")?.addEventListener("click", () => void startWithDevServer("python"));
document.getElementById("start-node")?.addEventListener("click", () => void startWithDevServer("node"));
window.pdtk.onDevServerEvent?.((event) => {
  if (event?.stage && !state.session) setStatus(launchStatus, event.stage);
});

document.getElementById("omnibox").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!state.session) return;
  if (!prefs.allowUrlModification || tweaks.siteCloaking) return;
  const url = normalizeHttp(address.value);
  navigate(url, { fromUser: true });
});

document.getElementById("back").addEventListener("click", () => {
  if (state.session?.mode === "multi") {
    state.multi?.postToActive({ type: "pdtk-back" });
    return;
  }
  if (state.frameHandle?.back) state.frameHandle.back();
  else activeProxyFrame()?.contentWindow?.history.back();
});
document.getElementById("forward").addEventListener("click", () => {
  if (state.session?.mode === "multi") {
    state.multi?.postToActive({ type: "pdtk-forward" });
    return;
  }
  if (state.frameHandle?.forward) state.frameHandle.forward();
  else activeProxyFrame()?.contentWindow?.history.forward();
});
document.getElementById("reload").addEventListener("click", () => {
  if (state.loading) {
    if (state.session?.mode === "multi") {
      const active = state.multi?.activeCombo();
      if (active && !active.poppedOut) {
        document.querySelector(`iframe[data-combo-id="${CSS.escape(active.id)}"]`)?.contentWindow?.stop?.();
      }
    } else {
      activeProxyFrame()?.contentWindow?.stop();
    }
    state.loading = false;
    return;
  }
  if (state.session?.mode === "multi") {
    state.multi?.postToActive({ type: "pdtk-reload" });
    return;
  }
  if (state.frameHandle?.reload) state.frameHandle.reload();
  else if (state.session) navigate(state.session.destination);
});

frameWrap.addEventListener("load", (event) => {
  if (event.target?.tagName !== "IFRAME") return;
  if (state.session?.mode === "multi") {
    state.loading = false;
    return;
  }
  const target = activeProxyFrame();
  if (event.target !== target && event.target !== frame) return;
  state.loading = false;
  if (prefs.eruda) syncEruda(event.target.contentWindow, true);
  try {
    const href = target?.contentWindow?.location?.href;
    if (state.session?.proxy.kind === "ultraviolet" && href && globalThis.__uv$config) {
      const path = new URL(href).pathname;
      if (path.startsWith(__uv$config.prefix)) {
        const decoded = __uv$config.decodeUrl(path.slice(__uv$config.prefix.length));
        if (!prefs.allowSiteRedirects && state.session.destination && decoded !== state.session.destination) {
          navigate(state.session.destination, { fromUser: true });
          return;
        }
        state.session.destination = decoded;
        setAddressDisplay(decoded);
        rememberTabDestination(decoded);
      }
    }
  } catch { /* proxied document may hide location */ }
}, true);

async function applyTweakChanges(keys = []) {
  const changed = new Set(keys);
  updateWindowTitle();
  if (!state.session) return { reloaded: false, verboseRestarted: false };
  setAddressDisplay(state.session.destination || "");
  applyTabCloaking(activeTab());
  let reloaded = false;
  const needsReload = !changed.size || [...changed].some((key) => RELOAD_TWEAKS.has(key));
  if (needsReload && state.session.mode !== "multi" && state.session.destination) {
    navigate(state.session.destination, { fromUser: true });
    reloaded = true;
  }
  let verboseRestarted = false;
  if ([...changed].some((key) => VERBOSE_TWEAKS.has(key))) {
    await stopVerboseConsoles().catch(() => {});
    await startVerboseConsoles();
    verboseRestarted = true;
  }
  updateWindowTitle();
  return { reloaded, verboseRestarted };
}

window.addEventListener("pdtk-tweaks-changed", (event) => {
  if (event.detail?.fromMcp) return;
  applyTweakChanges(event.detail?.keys || []).catch((error) => {
    setStatus(liveStatus, error.message || String(error), true);
  });
});

document.getElementById("sidebar-toggle").addEventListener("click", () => {
  sidebar.classList.toggle("collapsed");
  applyDock();
});
document.getElementById("collapse-sidebar").addEventListener("click", () => {
  sidebar.classList.add("collapsed");
  applyDock();
});

document.getElementById("apply-live").addEventListener("click", async () => {
  if (!state.session) return;
  setStatus(liveStatus, "Applying…");
  try {
    const endpoints = readEndpoints(
      state.session.localSite,
      document.getElementById("live-transport").value,
      document.getElementById("live-wisp").value,
      document.getElementById("live-bare").value
    );
    if (state.session.localSite && !BARE_TRANSPORTS.has(endpoints.transport)) {
      endpoints.wispUrl = localWisp();
      document.getElementById("live-wisp").value = endpoints.wispUrl;
    }
    if (state.session.mode === "multi") {
      const active = state.multi?.activeCombo();
      Object.assign(state.session, {
        wispUrl: endpoints.wispUrl,
        bareUrl: endpoints.bareUrl,
      });
      if (active) {
        active.transport = endpoints.transport;
        active.bootSession = {
          ...active.bootSession,
          transport: endpoints.transport,
          wispUrl: endpoints.wispUrl,
          bareUrl: endpoints.bareUrl,
        };
        state.session.combos = state.session.combos.map((item) => (
          item.id === active.id ? { ...item, transport: endpoints.transport } : item
        ));
        state.multi.postToActive({
          type: "pdtk-apply",
          session: {
            transport: endpoints.transport,
            wispUrl: endpoints.wispUrl,
            bareUrl: endpoints.bareUrl,
          },
        });
      }
      await window.pdtk.setSession(state.session);
      fillLiveProxy();
      renderSession();
      setStatus(liveStatus, active ? `Applied to ${active.label}.` : "Applied.");
      return;
    }
    const nextKind = document.getElementById("live-proxy").value;
    const proxyChanged = nextKind !== "keep" && nextKind !== state.session.proxy.kind;
    if (proxyChanged) {
      state.session.proxy = {
        kind: nextKind,
        label: nextKind === "ultraviolet" ? "Ultraviolet" : "Scramjet",
      };
    }
    Object.assign(state.session, endpoints);
    await window.pdtk.setSession(state.session);
    if (proxyChanged || state.session.proxy.kind === "ultraviolet") {
      location.reload();
      return;
    }
    if (state.session.proxy.kind === "scramjet" && state.controller) {
      const transport = wrapTransport(await createRawTransport(state.session));
      if (state.controller.setTransport) state.controller.setTransport(transport);
      else state.controller.transport = transport;
      navigate(state.session.destination);
    } else if (state.session.proxy.kind === "ultraviolet") {
      await bootUltraviolet(state.session);
      navigate(state.session.destination);
    }
    renderSession();
    setStatus(liveStatus, "Applied.");
  } catch (error) {
    setStatus(liveStatus, error.message || String(error), true);
  }
});

async function endSession() {
  await stopVerboseConsoles().catch(() => {});
  await window.pdtk.stopDevServer?.().catch(() => {});
  ensureIframeWrapper(false);
  if (state.multi) await state.multi.end().catch(() => {});
  await window.pdtk.clearSession();
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((registration) => registration.unregister()));
  frame.src = "about:blank";
  state.session = null;
  state.controller = null;
  state.frameHandle = null;
  state.frameTarget = null;
  launcher.classList.remove("hidden");
  frameWrap.classList.add("hidden");
  frameWrap.classList.remove("split");
  comboFrames?.classList.add("hidden");
  frame.classList.remove("hidden");
  sidebar.classList.add("collapsed");
  syncSessionChrome(false);
  applyDock();
  setStatus(liveStatus, "");
  syncTabStrip();
  document.title = "Proxy Development Toolkit";
  state.pageTitle = "";
  updateWindowTitle();
  return { ok: true };
}

document.getElementById("end-session").addEventListener("click", () => {
  endSession().catch((error) => setStatus(liveStatus, error.message || String(error), true));
});

document.getElementById("local-wisp").addEventListener("click", () => {
  document.getElementById("wisp-url").value = localWisp();
});
document.querySelectorAll("[data-wisp]").forEach((button) => {
  button.addEventListener("click", () => {
    document.getElementById("wisp-url").value = button.dataset.wisp;
  });
});

function closeMenus() {
  document.querySelectorAll(".combo .menu").forEach((menu) => {
    menu.classList.add("hidden");
    menu.parentElement.querySelector(".arrow")?.setAttribute("aria-expanded", "false");
  });
}

document.querySelectorAll(".combo").forEach((combo) => {
  const arrow = combo.querySelector(".arrow");
  const menu = combo.querySelector(".menu");
  arrow.addEventListener("click", (event) => {
    event.stopPropagation();
    const willOpen = menu.classList.contains("hidden");
    closeMenus();
    menu.classList.toggle("hidden", !willOpen);
    arrow.setAttribute("aria-expanded", willOpen ? "true" : "false");
  });
});

document.getElementById("site-menu").addEventListener("click", async (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (!action) return;
  closeMenus();
  if (action === "file") {
    const folder = await window.pdtk.pickFolder();
    if (!folder) return;
    siteMode = "folder";
    siteGit = null;
    document.getElementById("site-folder").value = folder;
    document.getElementById("site-url").value = folder;
    syncSiteFields();
    return;
  }
  const pulled = await pullRepository("site");
  if (!pulled) return;
  siteMode = "git";
  siteGit = pulled.imported;
  document.getElementById("site-folder").value = "";
  document.getElementById("site-url").value = pulled.url;
  syncSiteFields();
});

document.getElementById("site-url").addEventListener("input", () => {
  const url = document.getElementById("site-url");
  if (siteMode === "folder" && url.value.trim() !== document.getElementById("site-folder").value) {
    siteMode = "url";
    siteGit = null;
    syncSiteFields();
  } else if (siteMode === "git" && siteGit && url.value.trim() !== siteGit.source) {
    siteGit = null;
  }
});

document.querySelectorAll(".proxy-menu").forEach((menu) => {
  menu.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) return;
    const combo = event.target.closest(".combo");
    const pane = combo?.dataset.proxyPane;
    if (!pane || !proxyPaneState[pane]) return;
    closeMenus();
    if (action === "file") {
      const folder = await window.pdtk.pickFolder();
      if (!folder) return;
      proxyPaneState[pane].importMode = "folder";
      proxyPaneState[pane].git = null;
      combo.querySelector(".proxy-folder").value = folder;
    } else {
      const pulled = await pullRepository("proxy");
      if (!pulled) return;
      proxyPaneState[pane].importMode = "git";
      proxyPaneState[pane].git = pulled.imported;
      combo.querySelector(".proxy-url").value = pulled.url;
    }
    syncProxyFields(pane);
  });
});

document.querySelectorAll(".proxy-custom-clear").forEach((button) => {
  button.addEventListener("click", () => {
    const combo = button.closest(".combo");
    const pane = combo?.dataset.proxyPane;
    if (!pane || !proxyPaneState[pane]) return;
    proxyPaneState[pane].importMode = null;
    proxyPaneState[pane].git = null;
    closeMenus();
    syncProxyFields(pane);
  });
});

window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "pdtk-ready" && (data.pane || data.comboId)) {
    state.multi?.markReady(data.comboId || data.pane);
    return;
  }
  if (data.type === "pdtk-error") {
    setStatus(liveStatus, data.error || "Pane error", true);
    return;
  }
  if (data.type === "pdtk-stat" && data.detail) {
    reportTransport(data.detail);
    return;
  }
  if (data.type === "pdtk-title" && state.session?.mode === "multi") {
    if (state.multi?.setPageTitle(data.comboId || data.pane, data.title)) updateWindowTitle();
  }
});

document.getElementById("live-combo")?.addEventListener("change", (event) => {
  state.multi?.focusCombo(event.target.value);
});
document.getElementById("combo-popout")?.addEventListener("click", () => {
  const active = state.multi?.activeCombo();
  if (active) void state.multi.togglePopout(active.id);
});
window.pdtk.onComboWindowClosed?.((payload) => {
  const id = payload?.comboId;
  if (!id || state.session?.mode !== "multi") return;
  void state.multi?.dockBack(id);
});
window.addEventListener("pdtk-combos-changed", () => syncSplitUi());

document.addEventListener("click", (event) => {
  if (!event.target.closest(".combo")) closeMenus();
});

let repoPulling = false;

function pullRepository(kind) {
  const dialog = document.getElementById("repo-dialog");
  const form = document.getElementById("repo-form");
  const status = document.getElementById("repo-status");
  const pull = document.getElementById("repo-pull");
  const cancel = document.getElementById("repo-cancel");
  document.getElementById("repo-url").value = "";
  document.getElementById("repo-branch").value = "main";
  setStatus(status, "");
  pull.disabled = false;
  cancel.disabled = false;
  dialog.classList.remove("hidden");
  document.getElementById("repo-url").focus();
  return new Promise((resolve) => {
    const finish = (result) => {
      form.removeEventListener("submit", onSubmit);
      cancel.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKey);
      dialog.classList.add("hidden");
      repoPulling = false;
      resolve(result);
    };
    const onCancel = () => {
      if (!repoPulling) finish(null);
    };
    const onKey = (event) => {
      if (event.key === "Escape") onCancel();
    };
    const onSubmit = async (event) => {
      event.preventDefault();
      if (repoPulling) return;
      const branch = document.getElementById("repo-branch").value.trim();
      let url = "";
      try {
        url = normalizeHttp(document.getElementById("repo-url").value);
      } catch (error) {
        setStatus(status, error.message || "Enter a GitHub URL.", true);
        return;
      }
      if (!branch) {
        setStatus(status, "Enter a branch.", true);
        return;
      }
      repoPulling = true;
      pull.disabled = true;
      cancel.disabled = true;
      setStatus(status, `Pulling ${branch}…`);
      try {
        const imported = await window.pdtk.importGit({ kind, url, branch });
        finish({ url, branch, imported });
      } catch (error) {
        repoPulling = false;
        pull.disabled = false;
        cancel.disabled = false;
        setStatus(status, error.message || String(error), true);
      }
    };
    form.addEventListener("submit", onSubmit);
    cancel.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey);
  });
}

launchForm.addEventListener("change", () => {
  syncSiteFields();
  syncSplitUi();
  syncTransportFields();
});
document.getElementById("live-transport").addEventListener("change", syncTransportFields);

const stats = [];
function addStat(event) {
  if (state.paused) return;
  if (event.phase === "status") {
    setStatus(liveStatus, event.error || "Chromium DevTools is using the debugger. Browser request stats still come from the session, and proxied requests are recorded by the transport.");
    return;
  }
  stats.push({
    method: event.method || "",
    url: event.url || "",
    status: event.status || "",
    error: event.error || "",
    bytes: event.bytes || 0,
    source: event.source || "",
  });
  if (stats.length > 200) stats.shift();
  const errors = stats.filter((row) => row.error).length;
  const bytes = stats.reduce((sum, row) => sum + (Number(row.bytes) || 0), 0);
  statsSummary.textContent = `${stats.length} events, ${errors} errors, ${bytes} bytes`;
  statsList.innerHTML = stats.slice(-80).map((row) => {
    const flag = row.error ? "bad" : "";
    return `<li class="${flag}"><strong>${row.method || row.source}</strong> ${row.status || row.error || ""} ${row.url}</li>`;
  }).join("");
  statsList.scrollTop = statsList.scrollHeight;
}

document.getElementById("stats-pause").addEventListener("click", (event) => {
  state.paused = !state.paused;
  event.currentTarget.textContent = state.paused ? "Resume" : "Pause";
});
document.getElementById("stats-clear").addEventListener("click", () => {
  stats.length = 0;
  statsList.innerHTML = "";
  statsSummary.textContent = "No traffic yet.";
});

window.addEventListener("pdtk-transport", (event) => addStat({ source: "transport", ...event.detail }));

const docks = { info: "left", inspect: "right", prefer: "inspect", inspectOpen: false };
const inspectGrip = document.getElementById("inspect-grip");
const snapPreview = document.getElementById("snap-preview");
const sidebarResize = document.getElementById("sidebar-resize");
const inspectResize = document.getElementById("inspect-resize");
const RESIZE_CURSORS = { ew: "ew-resize", ns: "ns-resize", nwse: "nwse-resize", nesw: "nesw-resize" };
let lastInspectView = "";
let infoSize = null;
let infoSizeSlot = docks.info;
let inspectSize = null;
let inspectSizeSlot = docks.inspect;
let inspectPanel = null;

function place(node, rect) {
  node.style.left = `${rect.x}px`;
  node.style.top = `${rect.y}px`;
  node.style.width = `${rect.width}px`;
  node.style.height = `${rect.height}px`;
}

function placeResizeHandle(handle, slot, rect) {
  if (!handle) return;
  if (!rect) {
    handle.className = "hidden";
    return;
  }
  const edge = facingEdge(slot);
  const hit = 6;
  let cursor = "ew";
  let box;
  if (edge === "left" || edge === "right") {
    box = edge === "right"
      ? { x: rect.x + rect.width, y: rect.y, width: hit, height: rect.height }
      : { x: rect.x - hit, y: rect.y, width: hit, height: rect.height };
  } else if (edge === "top" || edge === "bottom") {
    cursor = "ns";
    box = edge === "bottom"
      ? { x: rect.x, y: rect.y + rect.height, width: rect.width, height: hit }
      : { x: rect.x, y: rect.y - hit, width: rect.width, height: hit };
  } else {
    const corner = 12;
    cursor = edge === "ne" || edge === "sw" ? "nesw" : "nwse";
    box = {
      x: edge === "sw" || edge === "nw" ? rect.x - corner : rect.x + rect.width,
      y: edge === "ne" || edge === "nw" ? rect.y - corner : rect.y + rect.height,
      width: corner,
      height: corner,
    };
  }
  handle.className = cursor;
  handle.dataset.edge = edge;
  place(handle, box);
}

function applyDock(previewSlot) {
  const size = {
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
  };
  if (docks.info !== infoSizeSlot) {
    infoSize = fitInfoSize(docks.info, size, infoSize);
    infoSizeSlot = docks.info;
  }
  if (docks.inspect !== inspectSizeSlot) {
    inspectSize = fitInspectSize(docks.inspect, size, inspectSize);
    inspectSizeSlot = docks.inspect;
  }
  const layout = layoutPanels({
    infoSlot: docks.info,
    inspectSlot: docks.inspect,
    size,
    infoCollapsed: sidebar.classList.contains("collapsed"),
    inspectOpen: docks.inspectOpen,
    prefer: docks.prefer,
    infoSize,
    inspectSize,
  });
  document.documentElement.style.setProperty("--inset-left", `${layout.insets.left}px`);
  document.documentElement.style.setProperty("--inset-right", `${layout.insets.right}px`);
  document.documentElement.style.setProperty("--inset-top", `${layout.insets.top}px`);
  document.documentElement.style.setProperty("--inset-bottom", `${layout.insets.bottom}px`);
  if (layout.info) place(sidebar, layout.info);
  placeResizeHandle(sidebarResize, docks.info, layout.info);
  inspectPanel = layout.inspect;
  inspectGrip.classList.toggle("hidden", !docks.inspectOpen || !layout.inspectParts);
  placeResizeHandle(inspectResize, docks.inspect, docks.inspectOpen ? layout.inspect : null);
  if (layout.inspectParts) {
    place(inspectGrip, layout.inspectParts.grip);
    const view = layout.inspectParts.view;
    const key = `${docks.inspect}:${view.x},${view.y},${view.width},${view.height}`;
    if (docks.inspectOpen && key !== lastInspectView) {
      lastInspectView = key;
      window.pdtk.setInspectBounds({
        slot: docks.inspect,
        bounds: view,
        viewport: size,
      });
    }
  }
  if (previewSlot) {
    const preview = layoutPanels({
      infoSlot: previewSlot.panel === "info" ? previewSlot.slot : docks.info,
      inspectSlot: previewSlot.panel === "inspect" ? previewSlot.slot : docks.inspect,
      size,
      infoCollapsed: previewSlot.panel === "info" ? false : sidebar.classList.contains("collapsed"),
      prefer: previewSlot.panel,
      infoSize,
      inspectSize,
    });
    const rect = previewSlot.panel === "info" ? preview.info : preview.inspect;
    if (rect) {
      place(snapPreview, rect);
      snapPreview.classList.remove("hidden");
    }
  } else {
    snapPreview.classList.add("hidden");
  }
}

function bindDrag(handle, panel) {
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("button") && event.target !== handle) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const move = (next) => {
      const size = {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      };
      const slot = slotFromPoint(next.clientX, next.clientY, size.width, size.height);
      docks[panel] = slot;
      docks.prefer = panel;
      applyDock({ panel, slot });
    };
    const end = (next) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      move(next);
      applyDock();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  });
}

function bindResize(handle, panel) {
  if (!handle) return;
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const slot = docks[panel];
    const remembered = panel === "inspect" ? inspectSize : infoSize;
    const startRect = panel === "inspect" && inspectPanel
      ? inspectPanel
      : sidebar.getBoundingClientRect();
    const startW = startRect.width;
    const startH = startRect.height;
    const minWidth = panel === "inspect" ? INSPECT_MIN_WIDTH : INFO_MIN_WIDTH;
    const minHeight = panel === "inspect" ? INSPECT_MIN_HEIGHT : INFO_MIN_HEIGHT;
    const previousCursor = document.documentElement.style.cursor;
    document.documentElement.style.cursor = RESIZE_CURSORS[handle.className] || "ew-resize";
    if (frame) frame.style.pointerEvents = "none";
    const move = (next) => {
      const dx = next.clientX - startX;
      const dy = next.clientY - startY;
      const viewport = {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      };
      const nextSize = {
        width: remembered?.width ?? startW,
        height: remembered?.height ?? startH,
      };
      if (slot === "left" || slot === "nw" || slot === "sw") {
        nextSize.width = clampInfoSpan(startW + dx, minWidth, viewport.width);
      } else if (slot === "right" || slot === "ne" || slot === "se") {
        nextSize.width = clampInfoSpan(startW - dx, minWidth, viewport.width);
      }
      if (slot === "top" || slot === "nw" || slot === "ne") {
        nextSize.height = clampInfoSpan(startH + dy, minHeight, viewport.height);
      } else if (slot === "bottom" || slot === "sw" || slot === "se") {
        nextSize.height = clampInfoSpan(startH - dy, minHeight, viewport.height);
      }
      if (panel === "inspect") {
        inspectSize = nextSize;
        inspectSizeSlot = slot;
        docks.prefer = "inspect";
      } else {
        infoSize = nextSize;
        infoSizeSlot = slot;
        docks.prefer = "info";
      }
      applyDock();
    };
    const end = (next) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      document.documentElement.style.cursor = previousCursor;
      if (frame) frame.style.pointerEvents = "";
      move(next);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  });
}

bindDrag(document.getElementById("sidebar-drag"), "info");
bindDrag(inspectGrip, "inspect");
bindResize(sidebarResize, "info");
bindResize(inspectResize, "inspect");
window.addEventListener("resize", () => applyDock());
window.pdtk.onInspectState((next) => {
  docks.inspectOpen = Boolean(next && next.open);
  lastInspectView = "";
  applyDock();
  if (docks.inspectOpen) {
    // Force a second layout pass after the native DevTools view is shown.
    requestAnimationFrame(() => {
      lastInspectView = "";
      applyDock();
    });
  }
});

async function resume() {
  const boot = await window.pdtk.boot();
  state.origin = boot.origin;
  if (boot.settings) {
    applyBrowserPrefs(boot.settings);
    loadTweaksFromSettings(boot.settings);
  }
  initTweaks();
  document.getElementById("local-wisp").dataset.wisp = localWisp();
  const wispInput = document.getElementById("wisp-url");
  if (wispInput && !String(wispInput.value || "").trim()) {
    wispInput.value = localWisp();
  }
  syncSiteFields();
  initCombos();
  if (boot.settings) loadCombosFromSettings(boot.settings);
  syncSplitUi();
  syncTransportFields();
  applyDock();
  const session = await window.pdtk.getSession();
  if (!session) {
    syncSessionChrome(false);
    return;
  }
  try {
    await startSession(session);
  } catch (error) {
    setStatus(launchStatus, error.message || String(error), true);
    launcher.classList.remove("hidden");
    frameWrap.classList.add("hidden");
    syncSessionChrome(false);
  }
}

function destinationIsLocal(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

async function mcpStartSession(args = {}) {
  const destination = normalizeHttp(args.url || args.destination || "");
  const localSite = destinationIsLocal(destination);
  document.getElementById("settings-close")?.click();

  const comboArgs = (Array.isArray(args.combos) ? args.combos.filter(Boolean) : []).map((combo) => ({
    ...combo,
    proxy: normalizeProxyKind(combo.proxy || combo.proxyKind),
    transport: normalizeTransportId(combo.transport),
  }));
  let outcome = null;
  if (state.session) await endSession().catch(() => {});
  if (comboArgs.length) {
    const needsBare = comboArgs.some((c) => BARE_TRANSPORTS.has(c.transport));
    const needsWisp = comboArgs.some((c) => !BARE_TRANSPORTS.has(c.transport));
    let wispUrl = "";
    let bareUrl = "";
    if (needsWisp) {
      wispUrl = normalizeWisp(args.wispUrl || document.getElementById("wisp-url").value, defaultWisp());
      if (localSite && !String(args.wispUrl || "").trim()) wispUrl = localWisp();
    }
    if (needsBare) bareUrl = normalizeBare(args.bareUrl || document.getElementById("bare-url").value);
    const hosts = await window.pdtk.ensureComboHosts({ count: comboArgs.length });
    const session = {
      mode: "multi",
      destination,
      localSite,
      wispUrl,
      bareUrl,
      transport: comboArgs[0].transport,
      combos: comboArgs.map((combo, index) => {
        const proxyKind = combo.proxy;
        const transport = combo.transport;
        return {
          id: combo.id || `combo-mcp-${index + 1}`,
          label: combo.label || formatComboChip({ proxyKind, transport, label: "" }),
          proxy: { kind: proxyKind, label: proxyKind === "ultraviolet" ? "Ultraviolet" : "Scramjet" },
          transport,
          port: hosts.hosts[index].port,
          origin: hosts.hosts[index].origin,
        };
      }),
    };
    await window.pdtk.setSession(session);
    outcome = await startSession(session);
  } else {
    const transport = normalizeTransportId(args.transport, document.getElementById("transport").value || "epoxy-tls");
    const endpoints = readEndpoints(
      localSite,
      transport,
      args.wispUrl || document.getElementById("wisp-url").value,
      args.bareUrl || document.getElementById("bare-url").value
    );
    if (localSite && !BARE_TRANSPORTS.has(endpoints.transport) && !String(args.wispUrl || "").trim()) {
      endpoints.wispUrl = localWisp();
    }
    const kind = normalizeProxyKind(args.proxy);
    const session = {
      mode: "single",
      destination,
      localSite,
      proxy: { kind, label: kind === "ultraviolet" ? "Ultraviolet" : "Scramjet" },
      ...endpoints,
    };
    await window.pdtk.setSession(session);
    await startSession(session);
  }
  rememberTabDestination(destination);
  const result = { ok: true, session: state.session };
  if (state.session?.mode === "multi") {
    result.combos = comboSummary();
    if (outcome?.failed?.length) result.failed = outcome.failed;
  }
  return result;
}

function comboSummary() {
  const active = state.multi?.activeCombo();
  return (state.multi?.runtime.combos || []).map((combo) => ({
    id: combo.id,
    label: combo.label,
    proxy: combo.proxy?.kind,
    transport: combo.transport,
    active: combo.id === active?.id,
    poppedOut: Boolean(combo.poppedOut),
    error: combo.error || undefined,
  }));
}

function mcpNavigate(args) {
  if (!state.session) return { ok: false, error: "No active session." };
  const url = normalizeHttp(args.url || args.destination);
  if (state.session.mode !== "multi") {
    navigate(url, { fromMcp: true });
    return { ok: true, destination: state.session.destination };
  }
  if (args.comboId && !state.multi.focusCombo(String(args.comboId))) {
    return { ok: false, error: `Unknown combo "${args.comboId}".`, combos: comboSummary() };
  }
  if (args.allCombos) {
    state.session.destination = url;
    setAddressDisplay(url);
    rememberTabDestination(url);
    syncMainSession();
    for (const combo of state.multi.runtime.combos) {
      combo.bootSession = { ...combo.bootSession, destination: url };
      state.multi.postToCombo(combo.id, { type: "pdtk-navigate", url });
    }
  } else {
    navigate(url, { fromMcp: true });
  }
  return { ok: true, destination: url, combos: comboSummary() };
}

async function handleMcpCommand(payload) {
  const { id, command, args } = payload || {};
  let result = { ok: false, error: "Unknown command." };
  try {
    if (command === "start_session") result = await mcpStartSession(args || {});
    else if (command === "end_session") result = await endSession();
    else if (command === "navigate") {
      result = mcpNavigate(args || {});
    } else if (command === "focus_combo") {
      if (state.session?.mode !== "multi") result = { ok: false, error: "No combos session is running." };
      else if (!state.multi?.focusCombo(String(args?.comboId || ""))) {
        result = { ok: false, error: `Unknown combo "${args?.comboId}".`, combos: comboSummary() };
      } else {
        result = { ok: true, active: args.comboId, combos: comboSummary() };
      }
    } else if (command === "get_tweaks") {
      result = { ok: true, tweaks: tweakSnapshot(), sessionActive: Boolean(state.session) };
    } else if (command === "set_tweaks") {
      const changed = await applyTweaksPatch(args || {}, { fromMcp: true });
      const applied = changed.length ? await applyTweakChanges(changed) : { reloaded: false, verboseRestarted: false };
      const notes = [];
      if (state.session?.mode === "multi" && changed.some((key) => RELOAD_TWEAKS.has(key))) {
        notes.push("Site cloaking and Load in iframe only affect single sessions; combo tabs keep running unchanged.");
      }
      if (!state.session && changed.length) notes.push("Saved. They apply when the next session starts.");
      result = { ok: true, changed, ...applied, tweaks: tweakSnapshot(), notes };
    } else {
      result = { ok: false, error: `Unsupported command: ${command}` };
    }
  } catch (error) {
    result = { ok: false, error: error.message || String(error) };
  }
  window.pdtk.replyMcpCommand({ id, result });
}

document.getElementById("setup-mcp")?.addEventListener("click", () => openMcpSettings());
window.pdtk.onNetwork(addStat);
window.pdtk.onMcpCommand(handleMcpCommand);
window.addEventListener("pdtk-settings-changed", (event) => {
  const next = event.detail?.settings || event.detail;
  if (next) applyBrowserPrefs(next);
});
document.getElementById("tab-new")?.addEventListener("click", () => {
  if (!prefs.allowMultipleTabs) return;
  addTab("");
});

initSettings({
  getNetworkLog: () => stats.map((row) => [
    row.method || row.source || "",
    row.status || "",
    row.error || "",
    row.url || "",
    row.bytes ? `${row.bytes} bytes` : "",
  ].filter(Boolean).join(" ")).join("\n"),
  getWispLocation: () => document.getElementById("live-wisp").value || document.getElementById("wisp-url").value || localWisp(),
}).catch((error) => setStatus(launchStatus, error.message || String(error), true));
resume()
  .then(() => runStartupUpdateCheck())
  .catch((error) => setStatus(launchStatus, error.message || String(error), true));
