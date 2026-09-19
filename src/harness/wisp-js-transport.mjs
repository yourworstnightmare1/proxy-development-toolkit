import { client as wisp } from "/vendor/wisp/wisp-client.mjs";
import initEpoxy, {
  EpoxyClient,
  EpoxyClientOptions,
  EpoxyHandlers,
} from "/vendor/epoxy-tls/epoxy-bundled.js";

function report(detail) {
  dispatchEvent(new CustomEvent("pdtk-transport", { detail }));
}

function ensureSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function tuples(headers) {
  if (!headers) return [];
  if (Array.isArray(headers)) {
    return headers
      .filter((row) => Array.isArray(row) && row.length >= 2)
      .map((row) => [String(row[0]), String(row[1])]);
  }
  if (typeof headers.forEach === "function") {
    const rows = [];
    headers.forEach((value, key) => rows.push([String(key), String(value)]));
    return rows;
  }
  return Object.entries(headers).flatMap(([key, value]) =>
    Array.isArray(value) ? value.map((item) => [key, String(item)]) : [[key, String(value)]]
  );
}

function headerMap(headers) {
  const map = new Map();
  for (const [key, value] of tuples(headers)) map.set(key.toLowerCase(), value);
  return map;
}

function waitOpen(connection) {
  if (connection.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Wisp connection timed out")), 12000);
    connection.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    connection.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Wisp connection failed"));
    };
  });
}

function readStream(stream, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const finish = () => resolve(concat(chunks));
    stream.onmessage = (data) => {
      chunks.push(data instanceof Uint8Array ? data : new Uint8Array(data));
    };
    stream.onclose = finish;
    signal?.addEventListener("abort", () => {
      try { stream.close(); } catch { /* ignore */ }
      reject(signal.reason || new Error("aborted"));
    }, { once: true });
  });
}

function concat(chunks) {
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function parseHttp(bytes) {
  const text = new TextDecoder().decode(bytes);
  const split = text.indexOf("\r\n\r\n");
  if (split < 0) throw new Error("Incomplete HTTP response");
  const head = text.slice(0, split).split("\r\n");
  const statusLine = head.shift() || "";
  const match = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)\s*(.*)$/);
  if (!match) throw new Error(`Bad status line: ${statusLine}`);
  const headers = head
    .filter(Boolean)
    .map((line) => {
      const index = line.indexOf(":");
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    });
  let bodyText = text.slice(split + 4);
  const map = new Map(headers.map(([key, value]) => [key.toLowerCase(), value]));
  if (map.get("transfer-encoding")?.toLowerCase().includes("chunked")) {
    bodyText = decodeChunked(bodyText);
  }
  return {
    status: Number(match[1]),
    statusText: match[2] || "",
    headers,
    body: new TextEncoder().encode(bodyText),
  };
}

function decodeChunked(input) {
  let rest = input;
  const parts = [];
  while (rest.length) {
    const lineEnd = rest.indexOf("\r\n");
    if (lineEnd < 0) break;
    const size = parseInt(rest.slice(0, lineEnd), 16);
    if (!size) break;
    const start = lineEnd + 2;
    parts.push(rest.slice(start, start + size));
    rest = rest.slice(start + size + 2);
  }
  return parts.join("");
}

function websocketTransport(url) {
  return () =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      socket.onopen = () => {
        const read = new ReadableStream({
          start(controller) {
            socket.onmessage = (event) => controller.enqueue(event.data);
            socket.onerror = () => controller.error(new Error("Wisp socket failed"));
            socket.onclose = () => controller.close();
          },
          cancel() {
            socket.close();
          },
        });
        const write = new WritableStream({
          write(chunk) {
            socket.send(chunk);
          },
          close() {
            socket.close();
          },
        });
        resolve({ read, write });
      };
      socket.onerror = () => reject(new Error("Wisp socket failed"));
    });
}

export default class WispJsTransport {
  constructor(options = {}) {
    this.wisp = ensureSlash(options.wisp || options.websocket || "");
    this.connection = null;
    this.tls = null;
    this.ready = false;
  }

  async init() {
    if (!this.wisp) throw new Error("Wisp URL is required");
    await initEpoxy();
    const options = new EpoxyClientOptions();
    options.user_agent = navigator.userAgent;
    options.wisp_v2 = true;
    try {
      this.tls = new EpoxyClient(websocketTransport(this.wisp), options);
    } catch {
      this.tls = new EpoxyClient(this.wisp, options);
    }
    this.connection = new wisp.ClientConnection(this.wisp);
    await waitOpen(this.connection);
    this.ready = true;
  }

  meta() {
    return { protocol: "wisp-js", version: "0" };
  }

  async request(remote, method, body, headers, signal) {
    const started = performance.now();
    try {
      const result = remote.protocol === "http:"
        ? await this.requestHttp(remote, method, body, headers, signal)
        : await this.requestTls(remote, method, body, headers, signal);
      report({
        phase: "done",
        method,
        url: remote.href,
        status: result.status,
        bytes: result.body?.byteLength || result.body?.size || 0,
        ms: Math.round(performance.now() - started),
        transport: "wisp-js",
      });
      return result;
    } catch (error) {
      report({
        phase: "error",
        method,
        url: remote.href,
        error: error.message || String(error),
        transport: "wisp-js",
      });
      throw error;
    }
  }

  async requestTls(remote, method, body, headers, signal) {
    if (body instanceof Blob) body = await body.arrayBuffer();
    const response = await this.tls.fetch(remote.href, {
      method,
      body,
      headers,
      redirect: "manual",
      signal,
    });
    return {
      body: response.body,
      status: response.status,
      statusText: response.statusText,
      headers: tuples(response.rawHeaders || response.headers),
    };
  }

  async requestHttp(remote, method, body, headers, signal) {
    if (!this.connection?.connected) {
      this.connection = new wisp.ClientConnection(this.wisp);
      await waitOpen(this.connection);
    }
    const stream = this.connection.create_stream(remote.hostname, Number(remote.port || 80));
    const incoming = readStream(stream, signal);
    const rows = tuples(headers).filter(([key]) => key.toLowerCase() !== "host");
    if (body instanceof Blob) body = new Uint8Array(await body.arrayBuffer());
    else if (body instanceof ArrayBuffer) body = new Uint8Array(body);
    else if (typeof body === "string") body = new TextEncoder().encode(body);
    else body = null;
    const lines = [
      `${method} ${remote.pathname}${remote.search} HTTP/1.1`,
      `Host: ${remote.host}`,
      "Connection: close",
    ];
    for (const [key, value] of rows) lines.push(`${key}: ${value}`);
    if (body) lines.push(`Content-Length: ${body.byteLength}`);
    const head = new TextEncoder().encode(`${lines.join("\r\n")}\r\n\r\n`);
    stream.send(body ? concat([head, body]) : head);
    const raw = await incoming;
    const parsed = parseHttp(raw);
    return {
      body: parsed.body,
      status: parsed.status,
      statusText: parsed.statusText,
      headers: parsed.headers,
    };
  }

  connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) {
    const handlers = new EpoxyHandlers(onopen, onclose, onerror, (data) => {
      onmessage(data instanceof Uint8Array ? data.buffer : data);
    });
    const socket = this.tls.connect_websocket(
      handlers,
      url.href,
      protocols || [],
      Object.fromEntries(tuples(requestHeaders))
    );
    return [
      async (data) => {
        if (data instanceof Blob) data = await data.arrayBuffer();
        (await socket).send(data);
      },
      async (code, reason) => {
        (await socket).close(code || 1000, reason || "");
      },
    ];
  }
}

export { headerMap, tuples };
