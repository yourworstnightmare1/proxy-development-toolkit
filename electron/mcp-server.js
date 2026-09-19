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
    version: "1.0.0",
  }, {
    instructions: "Control and observe the Proxy Development Toolkit: Scramjet/Ultraviolet sessions, screenshots, console and network logs.",
  });

  mcp.registerTool("get_status", {
    description: "Get the current session, proxy, split, and toolkit status.",
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
    description: "Capture a PNG screenshot of a proxy pane (single, left, or right).",
    inputSchema: {
      pane: z.enum(["single", "left", "right"]).optional(),
    },
  }, async ({ pane }) => {
    const result = await handlers.screenshot({ pane: pane || "single" });
    if (!result.ok) return textResult(result);
    return {
      content: [
        { type: "text", text: JSON.stringify({ ok: true, pane: result.pane, width: result.width, height: result.height }) },
        { type: "image", data: result.pngBase64, mimeType: "image/png" },
      ],
    };
  });

  mcp.registerTool("start_session", {
    description: "Start a proxy session. Requires control tools.",
    inputSchema: {
      url: z.string().min(1),
      proxy: z.enum(["scramjet", "ultraviolet"]).optional(),
      leftProxy: z.enum(["scramjet", "ultraviolet"]).optional(),
      rightProxy: z.enum(["scramjet", "ultraviolet"]).optional(),
      transport: z.string().optional(),
      split: z.boolean().optional(),
      orientation: z.enum(["horizontal", "vertical"]).optional(),
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
    description: "Navigate the current session to a URL. Requires control tools.",
    inputSchema: { url: z.string().min(1) },
  }, async ({ url }) => {
    if (!allowControl) return controlDenied();
    return textResult(await handlers.navigate({ url }));
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

  mcp.registerTool("set_split_orientation", {
    description: "Set split view orientation to horizontal (left/right) or vertical (top/bottom). Requires control tools.",
    inputSchema: { orientation: z.enum(["horizontal", "vertical"]) },
  }, async ({ orientation }) => {
    if (!allowControl) return controlDenied();
    return textResult(await handlers.setSplitOrientation({ orientation }));
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
  await new Promise((resolve) => server.close(() => resolve()));
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
