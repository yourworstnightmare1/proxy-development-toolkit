"use strict";

const http = require("http");
const { randomUUID } = require("crypto");
const { z } = require("zod");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { handlers } = require("./mcp-bridge");

let httpServer = null;
let boundPort = 0;
let currentToken = "";
let allowControl = true;
const sessions = new Map();

const TRANSPORT_HINT = "Transport ids: epoxy-tls, wisp-js, libcurl-transport, bare-transport, bare-mux (aliases epoxy, libcurl, wisp, bare are accepted).";

function textResult(payload) {
  return {
    content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }],
  };
}

function controlDenied() {
  return textResult({ ok: false, error: "Control tools are disabled. Enable them in Settings → MCP/Server." });
}

function createMcp() {
  const mcp = new McpServer({
    name: "proxy-development-toolkit",
    version: require("../package.json").version,
  }, {
    instructions: "Control and observe the Proxy Development Toolkit: Scramjet/Ultraviolet sessions, screenshots, console and network logs.",
  });

  mcp.registerTool("get_status", {
    description: "Get the current session, proxy/transport combos, and toolkit status.",
    inputSchema: {},
  }, async () => textResult(await handlers.getStatus()));

  mcp.registerTool("get_console_logs", {
    description: "Read captured DevTools/browser console log lines.",
    inputSchema: { limit: z.number().int().positive().max(2000).optional() },
  }, async ({ limit }) => textResult(await handlers.getLogs({ kind: "browser", limit })));

  mcp.registerTool("get_network_logs", {
    description: "Read captured network activity lines from the toolkit.",
    inputSchema: { limit: z.number().int().positive().max(2000).optional() },
  }, async ({ limit }) => textResult(await handlers.getLogs({ kind: "network", limit })));

  mcp.registerTool("get_proxy_logs", {
    description: "Read proxy-related log lines.",
    inputSchema: { limit: z.number().int().positive().max(2000).optional() },
  }, async ({ limit }) => textResult(await handlers.getLogs({ kind: "proxy", limit })));

  mcp.registerTool("get_wisp_logs", {
    description: "Read local Wisp host log lines.",
    inputSchema: { limit: z.number().int().positive().max(2000).optional() },
  }, async ({ limit }) => textResult(await handlers.getLogs({ kind: "wisp", limit })));

  mcp.registerTool("screenshot", {
    description: "Capture a PNG screenshot of the toolkit window. In a combos session, pass a combo id (see get_status → session.combos) to focus that combo first, or capture its popped-out window. When the Inspect dock is open, its DevTools panel is returned as a second image.",
    inputSchema: {
      pane: z.string().optional().describe("\"single\" (default) or a combo id."),
    },
  }, async ({ pane }) => {
    const result = await handlers.screenshot({ pane: pane || "single" });
    if (!result.ok) return textResult(result);
    const content = [
      {
        type: "text",
        text: JSON.stringify({
          ok: true,
          pane: result.pane,
          width: result.width,
          height: result.height,
          inspect: result.inspect ? { width: result.inspect.width, height: result.inspect.height } : undefined,        }),
      },
      { type: "image", data: result.pngBase64, mimeType: "image/png" },
    ];
    if (result.inspect) content.push({ type: "image", data: result.inspect.pngBase64, mimeType: "image/png" });
    return { content };
  });

  mcp.registerTool("start_session", {
    description: `Start a proxy session. Pass combos[] for multi proxy/transport tabs, or proxy+transport for a single session. ${TRANSPORT_HINT} Returns once every combo has started or failed; failed combos are listed in the result. Requires control tools.`,
    inputSchema: {
      url: z.string().min(1),
      proxy: z.enum(["scramjet", "ultraviolet"]).optional(),
      transport: z.string().optional().describe(TRANSPORT_HINT),
      combos: z.array(z.object({
        id: z.string().optional(),
        label: z.string().optional(),
        proxy: z.enum(["scramjet", "ultraviolet"]).optional(),
        proxyKind: z.enum(["scramjet", "ultraviolet"]).optional(),
        transport: z.string().optional().describe(TRANSPORT_HINT),
      })).optional(),
      wispUrl: z.string().optional(),
      bareUrl: z.string().optional(),
    },
  }, async (args) => {
    if (!allowControl) return controlDenied();
    return textResult(await handlers.startSession(args));
  });

  mcp.registerTool("end_session", {
    description: "End the current session. Requires control tools.",
    inputSchema: {},
  }, async () => {
    if (!allowControl) return controlDenied();
    return textResult(await handlers.endSession());
  });

  mcp.registerTool("navigate", {
    description: "Navigate the current session to a URL. In a combos session this targets the active combo unless comboId or allCombos is given. Requires control tools.",
    inputSchema: {
      url: z.string().min(1),
      comboId: z.string().optional(),
      allCombos: z.boolean().optional(),
    },
  }, async (args) => {
    if (!allowControl) return controlDenied();
    return textResult(await handlers.navigate(args));
  });

  mcp.registerTool("focus_combo", {
    description: "Switch the visible tab to a combo in a combos session (ids are in get_status → session.combos). Requires control tools.",
    inputSchema: { comboId: z.string().min(1) },
  }, async ({ comboId }) => {
    if (!allowControl) return controlDenied();
    return textResult(await handlers.focusCombo({ comboId }));
  });

  mcp.registerTool("get_tweaks", {
    description: "Read the current launch tweaks (tab/site cloaking, load in iframe, Wisp/Proxy/Transport verbose) and verbose log file paths.",
    inputSchema: {},
  }, async () => textResult(await handlers.getTweaks()));

  mcp.registerTool("set_tweaks", {
    description: "Change launch tweaks, the same switches as the Apply Tweaks menu. Only the fields you pass change. They are saved and applied to the running session: cloaking is re-applied, and verbose streams are started or stopped. Verbose output goes to the log files returned in logFiles. Requires control tools.",
    inputSchema: {
      tabCloaking: z.boolean().optional(),
      tabName: z.string().optional(),
      tabIconUrl: z.string().optional(),
      siteCloaking: z.boolean().optional(),
      siteCloakMode: z.enum(["about:blank", "blob:https"]).optional(),
      loadInIframe: z.boolean().optional(),
      wispVerbose: z.boolean().optional(),
      wispVerboseMinimized: z.boolean().optional(),
      wispVerboseSigint: z.boolean().optional(),
      proxyVerbose: z.boolean().optional(),
      proxyVerboseMinimized: z.boolean().optional(),
      proxyVerboseSigint: z.boolean().optional(),
      transportVerbose: z.boolean().optional(),
      transportVerboseMinimized: z.boolean().optional(),
      transportVerboseSigint: z.boolean().optional(),
    },
  }, async (args) => {
    if (!allowControl) return controlDenied();
    return textResult(await handlers.setTweaks(args));
  });

  mcp.registerTool("open_inspect", {
    description: "Open the Inspect / DevTools dock. Requires control tools.",
    inputSchema: {},
  }, async () => {
    if (!allowControl) return controlDenied();
    return textResult(await handlers.openInspect());
  });

  mcp.registerTool("close_inspect", {
    description: "Close the Inspect / DevTools dock. Requires control tools.",
    inputSchema: {},
  }, async () => {
    if (!allowControl) return controlDenied();
    return textResult(await handlers.closeInspect());
  });

  return mcp;
}

function authorized(req) {
  const header = String(req.headers.authorization || "");
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const token = match ? match[1].trim() : "";
  return Boolean(currentToken) && token === currentToken;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function handleMcp(req, res) {
  if (!authorized(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }
  const sessionId = req.headers["mcp-session-id"];
  let transport = sessionId ? sessions.get(String(sessionId)) : null;
  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
    const mcp = createMcp();
    await mcp.connect(transport);
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) sessions.delete(id);
    };
    if (transport.sessionId) sessions.set(transport.sessionId, transport);
  }
  const body = await readBody(req);
  await transport.handleRequest(req, res, body);
  if (transport.sessionId) sessions.set(transport.sessionId, transport);
}

function status() {
  return {
    running: Boolean(httpServer),
    port: boundPort,
    url: boundPort ? `http://127.0.0.1:${boundPort}/mcp` : "",
    allowControl,
  };
}

async function start({ port, token, control }) {
  await stop();
  currentToken = String(token || "").trim();
  allowControl = control !== false;
  if (!currentToken) throw new Error("MCP token is required.");
  const listenPort = Number(port) || 7432;
  httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (url.pathname !== "/mcp") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        });
        res.end();
        return;
      }
      await handleMcp(req, res);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error.message || String(error) }));
      }
    }
  });
  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(listenPort, "127.0.0.1", () => resolve());
  });
  boundPort = httpServer.address().port;
  return status();
}

async function stop() {
  for (const transport of sessions.values()) {
    try {
      await transport.close();
    } catch { /* ignore */ }
  }
  sessions.clear();
  if (!httpServer) {
    boundPort = 0;
    return status();
  }
  const server = httpServer;
  httpServer = null;
  boundPort = 0;
  const closed = new Promise((resolve) => server.close(() => resolve()));
  // close() otherwise waits on open SSE streams and in-flight requests forever.
  server.closeAllConnections?.();
  await closed;
  return status();
}

function configure({ token, control }) {
  if (token) currentToken = String(token);
  if (control !== undefined) allowControl = Boolean(control);
}

module.exports = {
  start,
  stop,
  status,
  configure,
};
