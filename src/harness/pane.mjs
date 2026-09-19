const BARE_TRANSPORTS = new Set(["bare-transport", "bare-mux"]);
const frame = document.getElementById("view");

const paneState = {
  session: null,
  controller: null,
  frameHandle: null,
  connection: null,
  parentOrigin: "*",
};

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

function postParent(message) {
  parent.postMessage(message, paneState.parentOrigin === "*" ? "*" : paneState.parentOrigin);
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
        postParent({
          type: "pdtk-stat",
          detail: {
            phase: "done",
            method,
            url: remote.href,
            status: response.status,
            bytes: response.body?.byteLength || 0,
            ms: Math.round(performance.now() - started),
            transport: paneState.session?.transport,
            pane: paneState.session?.pane,
          },
        });
        return {
          body: response.body,
          status: response.status,
          statusText: response.statusText,
          headers: asTuples(response.rawHeaders || response.headers),
        };
      } catch (error) {
        postParent({
          type: "pdtk-stat",
          detail: {
            phase: "error",
            method,
            url: remote.href,
            error: error.message || String(error),
            transport: paneState.session?.transport,
            pane: paneState.session?.pane,
          },
        });
        throw error;
      }
    },
  };
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
  paneState.controller = controller;
  paneState.frameHandle = null;
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
  paneState.connection = new BareMux.BareMuxConnection("/baremux/worker.js");
  if (session.transport === "bare-mux") {
    const client = await createRawTransport(session);
    await paneState.connection.setRemoteTransport(wrapTransport(client), "bare-mux-legacy");
  } else if (session.transport === "bare-transport") {
    await paneState.connection.setTransport("/bare/index.mjs", [session.bareUrl]);
  } else if (session.transport === "wisp-js") {
    await paneState.connection.setTransport("/harness/wisp-js-transport.mjs", [{ wisp: session.wispUrl }]);
  } else if (session.transport === "libcurl-transport") {
    await paneState.connection.setTransport("/libcurl/index.mjs", [{ wisp: session.wispUrl }]);
  } else {
    await paneState.connection.setTransport("/epoxy/index.mjs", [{ wisp: session.wispUrl }]);
  }
}

function proxiedHref(url) {
  return new URL(__uv$config.prefix + __uv$config.encodeUrl(url), location.origin).href;
}

function navigate(url) {
  paneState.session.destination = url;
  if (paneState.session.proxy.kind === "scramjet") {
    if (!paneState.frameHandle) paneState.frameHandle = paneState.controller.createFrame(frame);
    paneState.frameHandle.go(url);
    return;
  }
  if (paneState.session.proxy.kind === "ultraviolet") {
    frame.src = proxiedHref(url);
    return;
  }
  const entry = paneState.session.proxy.index
    ? joinBase(paneState.session.proxy.base, paneState.session.proxy.index)
    : `/${paneState.session.proxy.base}/`;
  const glue = entry.includes("?") ? "&" : "?";
  frame.src = `${entry}${glue}url=${encodeURIComponent(url)}`;
}

function applyScreenSpoof(metrics) {
  if (!metrics) return;
  const width = Math.max(1, Number(metrics.width) || 1920);
  const height = Math.max(1, Number(metrics.height) || 1080);
  try {
    Object.defineProperty(window.screen, "width", { configurable: true, get: () => width });
    Object.defineProperty(window.screen, "height", { configurable: true, get: () => height });
    Object.defineProperty(window.screen, "availWidth", { configurable: true, get: () => width });
    Object.defineProperty(window.screen, "availHeight", { configurable: true, get: () => height });
  } catch { /* ignore */ }
}

async function boot(session) {
  paneState.session = session;
  paneState.controller = null;
  paneState.frameHandle = null;
  paneState.connection = null;
  frame.src = "about:blank";
  if (session.screen) applyScreenSpoof(session.screen);
  if (session.proxy.kind === "scramjet") await bootScramjet(session);
  else if (session.proxy.kind === "ultraviolet") await bootUltraviolet(session);
  if (session.destination) navigate(session.destination);
  postParent({ type: "pdtk-ready", pane: session.pane });
}

function applyTransport(session) {
  paneState.session = { ...paneState.session, ...session, proxy: paneState.session.proxy };
  return (async () => {
    if (paneState.session.proxy.kind === "scramjet" && paneState.controller) {
      const transport = wrapTransport(await createRawTransport(paneState.session));
      if (paneState.controller.setTransport) paneState.controller.setTransport(transport);
      else paneState.controller.transport = transport;
      navigate(paneState.session.destination);
      return;
    }
    if (paneState.session.proxy.kind === "ultraviolet") {
      await bootUltraviolet(paneState.session);
      navigate(paneState.session.destination);
    }
  })();
}

window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "pdtk-boot") {
    paneState.parentOrigin = event.origin || "*";
    boot(data.session).catch((error) => {
      postParent({ type: "pdtk-error", pane: data.session?.pane, error: error.message || String(error) });
    });
    return;
  }
  if (data.type === "pdtk-screen") {
    applyScreenSpoof(data.screen);
    return;
  }
  if (data.type === "pdtk-navigate" && paneState.session) {
    navigate(data.url);
    return;
  }
  if (data.type === "pdtk-reload" && paneState.session) {
    if (paneState.frameHandle?.reload) paneState.frameHandle.reload();
    else navigate(paneState.session.destination);
    return;
  }
  if (data.type === "pdtk-back") {
    if (paneState.frameHandle?.back) paneState.frameHandle.back();
    else frame.contentWindow?.history.back();
    return;
  }
  if (data.type === "pdtk-forward") {
    if (paneState.frameHandle?.forward) paneState.frameHandle.forward();
    else frame.contentWindow?.history.forward();
    return;
  }
  if (data.type === "pdtk-apply" && paneState.session) {
    applyTransport(data.session).catch((error) => {
      postParent({ type: "pdtk-error", pane: paneState.session?.pane, error: error.message || String(error) });
    });
  }
});

postParent({ type: "pdtk-pane-hello" });
