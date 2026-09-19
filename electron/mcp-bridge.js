"use strict";

/**
 * Bridge between MCP tools and the running Electron app.
 * Handlers are registered from main.js once windows/sessions exist.
 */

const handlers = {
  getStatus: async () => ({ ok: false, error: "App not ready." }),
  startSession: async () => ({ ok: false, error: "App not ready." }),
  endSession: async () => ({ ok: false, error: "App not ready." }),
  navigate: async () => ({ ok: false, error: "App not ready." }),
  screenshot: async () => ({ ok: false, error: "App not ready." }),
  getLogs: async () => ({ ok: false, error: "App not ready." }),
  openInspect: async () => ({ ok: false, error: "App not ready." }),
  closeInspect: async () => ({ ok: false, error: "App not ready." }),
  setSplitOrientation: async () => ({ ok: false, error: "App not ready." }),
};

function register(partial) {
  Object.assign(handlers, partial);
}

module.exports = { handlers, register };
