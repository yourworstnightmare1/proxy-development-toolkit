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
import { initSettings, openMcpSettings } from "./settings-page.mjs";

const MERCURY_WISP = "wss://wisp.mercurywork.shop/";
const BARE_TRANSPORTS = new Set(["bare-transport", "bare-mux"]);

const launchForm = document.getElementById("launch-form");
const launchStatus = document.getElementById("launch-status");
const launcher = document.getElementById("launcher");
const frameWrap = document.getElementById("frame-wrap");
const frame = document.getElementById("proxy-frame");
const splitFrames = document.getElementById("split-frames");
const frameLeft = document.getElementById("proxy-frame-left");
const frameRight = document.getElementById("proxy-frame-right");
const address = document.getElementById("address");
const sidebar = document.getElementById("sidebar");
const liveStatus = document.getElementById("live-status");
const sessionInfo = document.getElementById("session-info");
const statsList = document.getElementById("stats-list");
const statsSummary = document.getElementById("stats-summary");
const openSessionBtn = document.getElementById("open-session");
const enableSplit = document.getElementById("enable-split");
const enableSplitBare = document.getElementById("enable-split-bare");

const state = {
  origin: "",
  session: null,
  controller: null,
  frameHandle: null,
  connection: null,
  loading: false,
  paused: false,
  stats: [],
  splitReady: { left: false, right: false },
};

const prefs = {
  allowMultipleTabs: false,
  allowUrlModification: true,
  allowSiteRedirects: true,
  screenWidth: 1920,
  screenHeight: 1080,
  screenOrientation: "landscape",
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
    address.value = tab.destination;
  }
}

function addTab(destination = "") {
  tabs.seq += 1;
  const id = `tab-${tabs.seq}`;
  tabs.items.push({ id, title: tabTitle(destination) || `Tab ${tabs.seq}`, destination });
  tabs.activeId = id;
  renderTabs();
  if (state.session && destination) navigate(destination, { fromTab: true });
  else if (state.session) {
    address.value = "";
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
  tab.title = tabTitle(url);
  if (prefs.allowMultipleTabs) renderTabs();
}

function applyBrowserPrefs(settings) {
  if (!settings) return;
  prefs.allowMultipleTabs = Boolean(settings.allowMultipleTabs);
  prefs.allowUrlModification = settings.allowUrlModification !== false;
  prefs.allowSiteRedirects = settings.allowSiteRedirects !== false;
  prefs.screenWidth = Number(settings.screenWidth) || 1920;
  prefs.screenHeight = Number(settings.screenHeight) || 1080;
  prefs.screenOrientation = settings.screenOrientation === "portrait" ? "portrait" : "landscape";
  address.readOnly = !prefs.allowUrlModification;
  address.classList.toggle("locked", !prefs.allowUrlModification);
  syncTabStrip();
  if (state.session?.mode === "split") {
    postToPanes({ type: "pdtk-screen", screen: screenPrefs() });
  } else {
    applyScreenSpoofTo(frame?.contentWindow);
  }
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
  return `ws://${location.host}/wisp/`;
}

const proxyPaneState = {
  single: { importMode: null, git: null },
  left: { importMode: null, git: null },
  right: { importMode: null, git: null },
};
let siteMode = "url";
let siteGit = null;

function splitEnabled() {
  return Boolean(enableSplit?.checked || enableSplitBare?.checked);
}

function syncSplitCheckboxes(checked) {
  if (enableSplit) enableSplit.checked = checked;
  if (enableSplitBare) enableSplitBare.checked = checked;
}

function splitOrientation() {
  const bare = BARE_TRANSPORTS.has(document.getElementById("transport").value);
  const group = bare ? "split-orientation-bare" : "split-orientation";
  const selected = document.querySelector(`input[name="${group}"]:checked`);
  return selected?.value === "vertical" ? "vertical" : "horizontal";
}

function syncSplitOrientation(value) {
  const next = value === "vertical" ? "vertical" : "horizontal";
  for (const name of ["split-orientation", "split-orientation-bare"]) {
    const input = document.querySelector(`input[name="${name}"][value="${next}"]`);
    if (input) input.checked = true;
  }
}

function applySplitOrientation(orientation) {
  const vertical = orientation === "vertical";
  splitFrames.classList.toggle("vertical", vertical);
  document.getElementById("proxy-split")?.classList.toggle("vertical-labels", vertical);
  const first = vertical ? "Top" : "Left";
  const second = vertical ? "Bottom" : "Right";
  const leftLabel = document.getElementById("proxy-label-left");
  const rightLabel = document.getElementById("proxy-label-right");
  if (leftLabel) leftLabel.textContent = `${first} proxy`;
  if (rightLabel) rightLabel.textContent = `${second} proxy`;
  if (state.session?.mode === "split") {
    const leftName = proxyLabel(state.session.panes?.[0]?.proxy);
    const rightName = proxyLabel(state.session.panes?.[1]?.proxy);
    document.getElementById("split-label-left").textContent = `${first}: ${leftName}`;
    document.getElementById("split-label-right").textContent = `${second}: ${rightName}`;
  }
}

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
  const on = splitEnabled();
  document.getElementById("proxy-split").classList.toggle("hidden", !on);
  document.getElementById("proxy-transport-row").classList.toggle("split-mode", on);
  document.getElementById("split-orientation-field")?.classList.toggle("hidden", !on);
  document.getElementById("split-orientation-field-bare")?.classList.toggle("hidden", !on);
  openSessionBtn.textContent = on ? "Start Split View" : "Start Session";
  applySplitOrientation(splitOrientation());
  syncProxyFields("single");
  syncProxyFields("left");
  syncProxyFields("right");
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
        const response = transport.client?.fetch
          ? await transport.client.fetch(remote.href, { method, body, headers, redirect: "manual", signal })
          : await transport.request(remote, method, body, asTuples(headers), signal);
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
    const mod = await withoutProcess(() => import("/libcurl/index.mjs"));
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

async function registerWorker() {
  if (!navigator.serviceWorker) throw new Error("Service workers are not available.");
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((registration) => registration.unregister()));
  const registration = await navigator.serviceWorker.register("/sw.js", {
    scope: "/",
    updateViaCache: "none",
  });
  await registration.update().catch(() => {});
  await navigator.serviceWorker.ready;
  if (navigator.serviceWorker.controller) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for the service worker")), 8000);
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
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
    await state.connection.setTransport("/libcurl/index.mjs", [{ wisp: session.wispUrl }]);
  } else {
    await state.connection.setTransport("/epoxy/index.mjs", [{ wisp: session.wispUrl }]);
  }
}

function proxiedHref(url) {
  return new URL(__uv$config.prefix + __uv$config.encodeUrl(url), location.origin).href;
}

function navigate(url, options = {}) {
  if (!state.session) return;
  const next = normalizeHttp(url);
  if (!prefs.allowSiteRedirects && !options.fromUser && !options.fromTab && !options.fromMcp) {
    if (state.session.destination && next !== state.session.destination) {
      address.value = state.session.destination;
      return;
    }
  }
  state.session.destination = next;
  address.value = next;
  rememberTabDestination(next);
  state.loading = true;
  if (state.session.mode === "split") {
    postToPanes({ type: "pdtk-navigate", url: next });
    return;
  }
  if (state.session.proxy.kind === "scramjet") {
    if (!state.frameHandle) state.frameHandle = state.controller.createFrame(frame);
    state.frameHandle.go(next);
    return;
  }
  if (state.session.proxy.kind === "ultraviolet") {
    frame.src = proxiedHref(next);
    return;
  }
  const entry = state.session.proxy.index
    ? joinBase(state.session.proxy.base, state.session.proxy.index)
    : `/${state.session.proxy.base}/`;
  const glue = entry.includes("?") ? "&" : "?";
  frame.src = `${entry}${glue}url=${encodeURIComponent(next)}`;
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
    ["Mode", session.mode === "split"
      ? `Split view (${session.orientation === "vertical" ? "top / bottom" : "left / right"})`
      : "Single"],
  ];
  if (session.mode === "split") {
    const first = session.orientation === "vertical" ? "Top" : "Left";
    const second = session.orientation === "vertical" ? "Bottom" : "Right";
    rows.push(
      [first, proxyLabel(session.panes?.[0]?.proxy)],
      [second, proxyLabel(session.panes?.[1]?.proxy)]
    );
  } else {
    rows.push(["Proxy", proxyLabel(session.proxy)]);
  }
  rows.push(
    ["Transport", session.transport],
    ["Wisp", session.wispUrl || "—"],
    ["Bare", session.bareUrl || "—"]
  );
  sessionInfo.innerHTML = rows.map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join("");
}

function fillLiveProxy() {
  const select = document.getElementById("live-proxy");
  const splitNote = document.getElementById("live-proxy-split");
  const label = select.closest("label");
  if (state.session?.mode === "split") {
    select.classList.add("hidden");
    if (label) label.classList.add("hidden");
    splitNote.classList.remove("hidden");
    const first = state.session.orientation === "vertical" ? "Top" : "Left";
    const second = state.session.orientation === "vertical" ? "Bottom" : "Right";
    splitNote.textContent = `${first}: ${proxyLabel(state.session.panes?.[0]?.proxy)} · ${second}: ${proxyLabel(state.session.panes?.[1]?.proxy)}`;
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
  const split = state.session?.mode === "split";
  frameWrap.classList.toggle("split", split);
  splitFrames.classList.toggle("hidden", !split);
  frame.classList.toggle("hidden", split);
  if (split) applySplitOrientation(state.session.orientation || "horizontal");
  syncSessionChrome(true);
  applyDock();
  fillLiveProxy();
  document.getElementById("live-transport").value = state.session.transport;
  document.getElementById("live-wisp").value = state.session.wispUrl || "";
  document.getElementById("live-bare").value = state.session.bareUrl || "";
  syncTransportFields();
  renderSession();
  syncTabStrip();
}

function postToPanes(message) {
  for (const node of [frameLeft, frameRight]) {
    try {
      node.contentWindow?.postMessage(message, "*");
    } catch { /* ignore */ }
  }
}

function waitForPaneReady(pane, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    if (state.splitReady[pane]) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error(`Timed out starting the ${pane} pane.`));
    }, timeoutMs);
    function onMessage(event) {
      const data = event.data;
      if (!data || data.type !== "pdtk-ready" || data.pane !== pane) return;
      state.splitReady[pane] = true;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve();
    }
    window.addEventListener("message", onMessage);
  });
}

async function bootPane(iframe, paneSession, origin) {
  state.splitReady[paneSession.pane] = false;
  const readyPromise = waitForPaneReady(paneSession.pane);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out loading ${paneSession.pane} pane.`)), 15000);
    iframe.onload = () => {
      clearTimeout(timer);
      resolve();
    };
    iframe.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`Failed to load ${paneSession.pane} pane.`));
    };
    iframe.src = `${origin}/harness/pane.html`;
  });
  iframe.contentWindow.postMessage({
    type: "pdtk-boot",
    session: { ...paneSession, screen: screenPrefs() },
  }, origin);
  await readyPromise;
}

async function startSplitSession(session) {
  state.session = session;
  state.controller = null;
  state.frameHandle = null;
  state.splitReady = { left: false, right: false };
  applySplitOrientation(session.orientation || "horizontal");
  showSession();
  setStatus(liveStatus, "Starting split view…");
  await Promise.all([
    bootPane(frameLeft, {
      ...session,
      proxy: session.panes[0].proxy,
      pane: "left",
      destination: session.destination,
    }, session.panes[0].origin),
    bootPane(frameRight, {
      ...session,
      proxy: session.panes[1].proxy,
      pane: "right",
      destination: session.destination,
    }, session.panes[1].origin),
  ]);
  address.value = session.destination;
  rememberTabDestination(session.destination);
  state.loading = false;
  const notes = ["Split view ready."];
  if (session.localSite && session.wispUrl) {
    notes.push(`Local files are reached through ${session.wispUrl}.`);
  }
  setStatus(liveStatus, notes.join(" "));
  await window.pdtk.setSession(session);
}

async function startSession(session) {
  if (session.mode === "split") {
    await startSplitSession(session);
    return;
  }
  state.session = session;
  state.controller = null;
  state.frameHandle = null;
  showSession();
  setStatus(liveStatus, "Starting proxy…");
  if (session.proxy.kind === "scramjet") await bootScramjet(session);
  else if (session.proxy.kind === "ultraviolet") await bootUltraviolet(session);
  else setStatus(liveStatus, "Opaque imported proxy. Live transport injection may not apply.");
  navigate(session.destination, { fromUser: true });
  rememberTabDestination(session.destination);
  applyScreenSpoofTo(frame?.contentWindow);
  const notes = ["Session ready."];
  if (session.proxy.kind === "opaque") {
    notes.push("This import is not Scramjet or Ultraviolet, so live transport injection may not apply.");
  }
  if (session.localSite && session.wispUrl) {
    notes.push(`Local files are reached through ${session.wispUrl}.`);
  }
  if (!liveStatus.textContent.startsWith("Legacy")) setStatus(liveStatus, notes.join(" "));
  await window.pdtk.setSession(session);
}

async function prepareSite() {
  const mode = siteMode;
  const sub = document.getElementById("site-subdir").value.trim().replace(/^\/+|\/+$/g, "");
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
  const fallback = localSite ? localWisp() : MERCURY_WISP;
  return { transport, wispUrl: normalizeWisp(wispInput, fallback), bareUrl: "" };
}

launchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  openSessionBtn.disabled = true;
  setSessionServerState("starting");
  setStatus(launchStatus, splitEnabled() ? "Preparing split view…" : "Preparing session…");
  try {
    const site = await prepareSite();
    const endpoints = readEndpoints(
      site.local,
      document.getElementById("transport").value,
      document.getElementById("wisp-url").value,
      document.getElementById("bare-url").value
    );
    if (site.local && !BARE_TRANSPORTS.has(endpoints.transport)) {
      endpoints.wispUrl = localWisp();
    }
    if (splitEnabled()) {
      const hosts = await window.pdtk.ensureSplitHosts();
      const leftProxy = await prepareProxy("left");
      const rightProxy = await prepareProxy("right");
      const session = {
        mode: "split",
        orientation: splitOrientation(),
        destination: site.destination,
        localSite: site.local,
        ...endpoints,
        panes: [
          { id: "left", proxy: leftProxy, port: hosts.leftPort, origin: hosts.leftOrigin },
          { id: "right", proxy: rightProxy, port: hosts.rightPort, origin: hosts.rightOrigin },
        ],
      };
      await window.pdtk.setSession(session);
      await startSession(session);
    } else {
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
    setStatus(launchStatus, error.message || String(error), true);
    setSessionServerState("error", error.message || String(error));
    setStatus(liveStatus, error.message || String(error), true);
    launcher.classList.remove("hidden");
    frameWrap.classList.add("hidden");
    frameWrap.classList.remove("split");
    splitFrames.classList.add("hidden");
    syncSessionChrome(false);
  } finally {
    openSessionBtn.disabled = false;
  }
});

document.getElementById("omnibox").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!state.session) return;
  if (!prefs.allowUrlModification) return;
  const url = normalizeHttp(address.value);
  navigate(url, { fromUser: true });
});

document.getElementById("back").addEventListener("click", () => {
  if (state.session?.mode === "split") {
    postToPanes({ type: "pdtk-back" });
    return;
  }
  if (state.frameHandle?.back) state.frameHandle.back();
  else frame.contentWindow?.history.back();
});
document.getElementById("forward").addEventListener("click", () => {
  if (state.session?.mode === "split") {
    postToPanes({ type: "pdtk-forward" });
    return;
  }
  if (state.frameHandle?.forward) state.frameHandle.forward();
  else frame.contentWindow?.history.forward();
});
document.getElementById("reload").addEventListener("click", () => {
  if (state.loading) {
    if (state.session?.mode === "split") {
      frameLeft.contentWindow?.stop?.();
      frameRight.contentWindow?.stop?.();
    } else {
      frame.contentWindow?.stop();
    }
    state.loading = false;
    return;
  }
  if (state.session?.mode === "split") {
    postToPanes({ type: "pdtk-reload" });
    return;
  }
  if (state.frameHandle?.reload) state.frameHandle.reload();
  else if (state.session) navigate(state.session.destination);
});

frame.addEventListener("load", () => {
  state.loading = false;
  try {
    const href = frame.contentWindow?.location?.href;
    if (state.session?.proxy.kind === "ultraviolet" && href && globalThis.__uv$config) {
      const path = new URL(href).pathname;
      if (path.startsWith(__uv$config.prefix)) {
        const decoded = __uv$config.decodeUrl(path.slice(__uv$config.prefix.length));
        if (!prefs.allowSiteRedirects && state.session.destination && decoded !== state.session.destination) {
          navigate(state.session.destination, { fromUser: true });
          return;
        }
        address.value = decoded;
        state.session.destination = decoded;
        rememberTabDestination(decoded);
      }
    }
  } catch { /* proxied document may hide location */ }
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
    if (state.session.mode === "split") {
      Object.assign(state.session, endpoints);
      await window.pdtk.setSession(state.session);
      postToPanes({ type: "pdtk-apply", session: { ...endpoints } });
      renderSession();
      setStatus(liveStatus, "Applied to both panes.");
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
  await window.pdtk.clearSession();
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((registration) => registration.unregister()));
  frame.src = "about:blank";
  frameLeft.src = "about:blank";
  frameRight.src = "about:blank";
  state.session = null;
  state.controller = null;
  state.frameHandle = null;
  state.splitReady = { left: false, right: false };
  launcher.classList.remove("hidden");
  frameWrap.classList.add("hidden");
  frameWrap.classList.remove("split");
  splitFrames.classList.add("hidden");
  frame.classList.remove("hidden");
  sidebar.classList.add("collapsed");
  syncSessionChrome(false);
  applyDock();
  setStatus(liveStatus, "");
  syncTabStrip();
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

function onSplitToggle(event) {
  syncSplitCheckboxes(event.target.checked);
  syncSplitUi();
}
enableSplit?.addEventListener("change", onSplitToggle);
enableSplitBare?.addEventListener("change", onSplitToggle);

document.querySelectorAll('input[name="split-orientation"], input[name="split-orientation-bare"]').forEach((input) => {
  input.addEventListener("change", () => {
    syncSplitOrientation(input.value);
    applySplitOrientation(input.value);
    if (state.session?.mode === "split") {
      state.session.orientation = input.value === "vertical" ? "vertical" : "horizontal";
      window.pdtk.setSession(state.session);
      renderSession();
    }
  });
});

window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "pdtk-ready" && data.pane) {
    state.splitReady[data.pane] = true;
    return;
  }
  if (data.type === "pdtk-error") {
    setStatus(liveStatus, data.error || "Pane error", true);
    return;
  }
  if (data.type === "pdtk-stat" && data.detail) {
    reportTransport(data.detail);
  }
});

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
  if (boot.settings) applyBrowserPrefs(boot.settings);
  document.getElementById("local-wisp").dataset.wisp = localWisp();
  syncSiteFields();
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
  const split = Boolean(args.split);
  const transport = args.transport || document.getElementById("transport").value || "epoxy";
  // Loopback destinations must use the toolkit's local Wisp — remote Mercury Wisp
  // cannot reach the developer's 127.0.0.1 (MCP previously hard-coded localSite:false).
  const localSite = destinationIsLocal(destination);
  const endpoints = readEndpoints(
    localSite,
    transport,
    args.wispUrl || document.getElementById("wisp-url").value,
    args.bareUrl || document.getElementById("bare-url").value
  );
  if (localSite && !BARE_TRANSPORTS.has(endpoints.transport) && !String(args.wispUrl || "").trim()) {
    endpoints.wispUrl = localWisp();
  }
  // Close settings so MCP screenshots/inspect see the proxy panes, not the settings sheet.
  document.getElementById("settings-close")?.click();
  syncSplitCheckboxes(split);
  if (args.orientation) syncSplitOrientation(args.orientation);
  if (split) {
    const hosts = await window.pdtk.ensureSplitHosts();
    const leftKind = args.leftProxy || args.proxy || "scramjet";
    const rightKind = args.rightProxy || (leftKind === "scramjet" ? "ultraviolet" : "scramjet");
    const session = {
      mode: "split",
      orientation: args.orientation === "vertical" ? "vertical" : splitOrientation(),
      destination,
      localSite,
      ...endpoints,
      panes: [
        {
          id: "left",
          proxy: { kind: leftKind, label: leftKind === "ultraviolet" ? "Ultraviolet" : "Scramjet" },
          port: hosts.leftPort,
          origin: hosts.leftOrigin,
        },
        {
          id: "right",
          proxy: { kind: rightKind, label: rightKind === "ultraviolet" ? "Ultraviolet" : "Scramjet" },
          port: hosts.rightPort,
          origin: hosts.rightOrigin,
        },
      ],
    };
    await window.pdtk.setSession(session);
    await startSession(session);
  } else {
    const kind = args.proxy || "scramjet";
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
  return { ok: true, session: state.session };
}

async function handleMcpCommand(payload) {
  const { id, command, args } = payload || {};
  let result = { ok: false, error: "Unknown command." };
  try {
    if (command === "start_session") result = await mcpStartSession(args || {});
    else if (command === "end_session") result = await endSession();
    else if (command === "navigate") {
      if (!state.session) result = { ok: false, error: "No active session." };
      else {
        navigate(args?.url || args?.destination, { fromMcp: true });
        result = { ok: true, destination: state.session.destination };
      }
    } else if (command === "set_split_orientation") {
      const orientation = args?.orientation === "vertical" ? "vertical" : "horizontal";
      syncSplitOrientation(orientation);
      applySplitOrientation(orientation);
      if (state.session) {
        state.session.orientation = orientation;
        await window.pdtk.setSession(state.session);
      }
      result = { ok: true, orientation };
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
resume().catch((error) => setStatus(launchStatus, error.message || String(error), true));
