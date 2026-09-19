"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { vendorMounts, srcDir, appRoot } = require("./paths");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

let logicalSession = null;
const sessionsByPort = new Map();

function setSession(session) {
  logicalSession = session;
  if (!session) {
    sessionsByPort.clear();
    return;
  }
  if (session.mode === "split" && Array.isArray(session.panes)) {
    sessionsByPort.clear();
    for (const pane of session.panes) {
      if (!pane || !Number.isFinite(pane.port)) continue;
      sessionsByPort.set(pane.port, {
        destination: session.destination,
        localSite: session.localSite,
        transport: session.transport,
        wispUrl: session.wispUrl,
        bareUrl: session.bareUrl,
        proxy: pane.proxy,
        pane: pane.id,
      });
    }
    return;
  }
  sessionsByPort.clear();
  if (Number.isFinite(session.port)) {
    sessionsByPort.set(session.port, session);
  }
}

function setPortSession(port, session) {
  if (!Number.isFinite(port)) return;
  if (!session) sessionsByPort.delete(port);
  else sessionsByPort.set(port, session);
}

function getSession() {
  return logicalSession;
}

function getPortSession(port) {
  if (Number.isFinite(port) && sessionsByPort.has(port)) return sessionsByPort.get(port);
  return logicalSession;
}

function safeFile(root, urlPath) {
  let decoded = urlPath;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const full = path.resolve(root, "." + path.posix.normalize("/" + decoded));
  const base = path.resolve(root);
  const relative = path.relative(base, full);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return full;
}

function sendFile(res, filePath, extraHeaders) {
  const stat = fs.statSync(filePath);
  const headers = {
    "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
    "Content-Length": stat.size,
    "Cache-Control": "no-cache",
    ...extraHeaders,
  };
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

function sendText(res, status, body, type) {
  const data = Buffer.from(body);
  res.writeHead(status, {
    "Content-Type": type || "text/plain; charset=utf-8",
    "Content-Length": data.length,
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function scramjetWorker(session) {
  const controller = session?.proxy?.controllerSw
    ? `/${session.proxy.base}/${session.proxy.controllerSw}`.replace(/\/{2,}/g, "/")
    : "/vendor/controller/controller.sw.js";
  return `importScripts(${JSON.stringify(controller)});
addEventListener("fetch", (event) => {
  if (self.$scramjetController && $scramjetController.shouldRoute(event)) {
    event.respondWith($scramjetController.route(event));
  }
});
`;
}

function ultravioletWorker(session) {
  const base = session?.proxy?.base ? `/${session.proxy.base}` : "/uv";
  const bundle = session?.proxy?.bundle ? `${base}/${session.proxy.bundle}` : "/uv/uv.bundle.js";
  const handler = session?.proxy?.handler ? `${base}/${session.proxy.handler}` : "/uv/uv.handler.js";
  const client = session?.proxy?.client ? `${base}/${session.proxy.client}` : "/uv/uv.client.js";
  const sw = session?.proxy?.sw ? `${base}/${session.proxy.sw}` : "/uv/uv.sw.js";
  return `importScripts(${JSON.stringify(bundle)});
self.__uv$config = {
  prefix: "/uv/service/",
  encodeUrl: Ultraviolet.codec.xor.encode,
  decodeUrl: Ultraviolet.codec.xor.decode,
  handler: ${JSON.stringify(handler)},
  client: ${JSON.stringify(client)},
  bundle: ${JSON.stringify(bundle)},
  config: "/uv/uv.config.js",
  sw: ${JSON.stringify(sw)},
};
importScripts(${JSON.stringify(sw)});
const uv = new UVServiceWorker();
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  event.respondWith((async () => {
    if (uv.route(event)) return await uv.fetch(event);
    return fetch(event.request);
  })());
});
`;
}

function workerSource(port) {
  const activeSession = getPortSession(port);
  if (!activeSession) {
    return `self.addEventListener("fetch", () => {});\n`;
  }
  if (activeSession.proxy.kind === "ultraviolet") return ultravioletWorker(activeSession);
  if (activeSession.proxy.kind === "scramjet") return scramjetWorker(activeSession);
  return `self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
`;
}

function licenseIndex() {
  const packages = [
    ["@mercuryworkshop/scramjet", ["@mercuryworkshop", "scramjet", "LICENSE"]],
    ["@mercuryworkshop/libcurl-transport", ["@mercuryworkshop", "libcurl-transport", "LICENSE"]],
    ["@mercuryworkshop/epoxy-transport", ["@mercuryworkshop", "epoxy-transport", "LICENSE"]],
    ["@mercuryworkshop/epoxy-tls", ["@mercuryworkshop", "epoxy-tls", "LICENSE"]],
    ["@mercuryworkshop/bare-transport", ["@mercuryworkshop", "bare-transport", "LICENSE"]],
    ["@mercuryworkshop/bare-mux", ["@mercuryworkshop", "bare-mux", "LICENSE"]],
    ["@mercuryworkshop/wisp-js", ["@mercuryworkshop", "wisp-js", "LICENSE"]],
    ["@titaniumnetwork-dev/ultraviolet", ["@titaniumnetwork-dev", "ultraviolet", "LICENSE"]],
    ["proxy-development-toolkit", null],
  ];
  const { modulePath } = require("./paths");
  const lines = ["Proxy Development Toolkit is licensed under the GNU AGPL v3.", ""];
  for (const [name, parts] of packages) {
    if (!parts) {
      lines.push(`${name}: AGPL-3.0-only — /LICENSE`);
      continue;
    }
    try {
      modulePath(...parts);
      lines.push(`${name}: /licenses/${encodeURIComponent(name)}`);
    } catch {
      lines.push(`${name}: license file not shipped with this package`);
    }
  }
  return lines.join("\n");
}

function createStaticServer(importsRoot) {
  let boundPort = 0;
  const server = http.createServer((req, res) => {
    try {
      const port = boundPort || (server.address() && server.address().port) || 0;
      handle(req, res, vendorMounts(), importsRoot, port);
    } catch (error) {
      sendText(res, 500, error.stack || String(error));
    }
  });
  server.on("listening", () => {
    const addr = server.address();
    boundPort = addr && addr.port ? addr.port : 0;
  });
  return server;
}

function handle(req, res, mounts, importsRoot, port) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const pathname = url.pathname;

  if (pathname === "/sw.js") {
    sendText(res, 200, workerSource(port), "text/javascript; charset=utf-8");
    return;
  }
  if (pathname === "/uv/uv.config.js") {
    const session = getPortSession(port);
    const base = session?.proxy?.base ? `/${session.proxy.base}` : "/uv";
    const bundle = session?.proxy?.bundle ? `${base}/${session.proxy.bundle}` : "/uv/uv.bundle.js";
    const handler = session?.proxy?.handler ? `${base}/${session.proxy.handler}` : "/uv/uv.handler.js";
    const client = session?.proxy?.client ? `${base}/${session.proxy.client}` : "/uv/uv.client.js";
    const sw = session?.proxy?.sw ? `${base}/${session.proxy.sw}` : "/uv/uv.sw.js";
    sendText(
      res,
      200,
      `self.__uv$config = {
  prefix: "/uv/service/",
  encodeUrl: Ultraviolet.codec.xor.encode,
  decodeUrl: Ultraviolet.codec.xor.decode,
  handler: ${JSON.stringify(handler)},
  client: ${JSON.stringify(client)},
  bundle: ${JSON.stringify(bundle)},
  config: "/uv/uv.config.js",
  sw: ${JSON.stringify(sw)},
};
`,
      "text/javascript; charset=utf-8"
    );
    return;
  }
  if (pathname === "/LICENSE") {
    sendFile(res, path.join(appRoot(), "LICENSE"));
    return;
  }
  if (pathname === "/licenses") {
    sendText(res, 200, licenseIndex());
    return;
  }
  if (pathname.startsWith("/licenses/")) {
    const name = decodeURIComponent(pathname.slice("/licenses/".length));
    const { modulePath } = require("./paths");
    const file = modulePath(...name.split("/"), "LICENSE");
    sendFile(res, file);
    return;
  }

  if (pathname === "/" || pathname === "/index.html") {
    sendFile(res, path.join(srcDir, "index.html"));
    return;
  }
  if (pathname === "/styles.css") {
    sendFile(res, path.join(srcDir, "styles.css"));
    return;
  }
  if (pathname.startsWith("/harness/")) {
    const file = safeFile(path.join(srcDir, "harness"), pathname.slice("/harness".length));
    if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
      sendFile(res, file);
      return;
    }
  }
  if (pathname.startsWith("/icons/")) {
    const file = safeFile(path.join(srcDir, "icons"), pathname.slice("/icons".length));
    if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
      sendFile(res, file);
      return;
    }
  }
  if (pathname.startsWith("/app/")) {
    const file = safeFile(srcDir, pathname.slice("/app".length));
    if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
      sendFile(res, file);
      return;
    }
  }

  for (const [prefix, root] of Object.entries(mounts)) {
    if (!pathname.startsWith(prefix)) continue;
    const file = safeFile(root, pathname.slice(prefix.length - 1));
    if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const headers = pathname.endsWith(".js") || pathname.endsWith("sw.js")
        ? { "Service-Worker-Allowed": "/" }
        : undefined;
      sendFile(res, file, headers);
      return;
    }
  }

  if (pathname.startsWith("/imports/") || pathname.startsWith("/sites/")) {
    const file = safeFile(importsRoot, pathname);
    if (!file || !fs.existsSync(file)) {
      sendText(res, 404, "Not found");
      return;
    }
    const stat = fs.statSync(file);
    if (stat.isDirectory()) {
      const index = path.join(file, "index.html");
      if (fs.existsSync(index)) sendFile(res, index);
      else sendText(res, 404, "No index.html");
      return;
    }
    sendFile(res, file);
    return;
  }

  sendText(res, 404, "Not found");
}

module.exports = {
  createStaticServer,
  setSession,
  getSession,
  setPortSession,
  getPortSession,
};
