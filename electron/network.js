"use strict";

function attachDebugger(win, onEvent) {
  const dbg = win.webContents.debugger;
  try {
    if (!dbg.isAttached()) dbg.attach("1.3");
  } catch (error) {
    return { ok: false, reason: error.message || String(error) };
  }
  dbg.on("message", (_event, method, params) => {
    if (method === "Network.requestWillBeSent") {
      onEvent({
        source: "debugger",
        id: params.requestId,
        phase: "start",
        method: params.request.method,
        url: params.request.url,
        type: params.type,
        timestamp: params.timestamp,
      });
    } else if (method === "Network.responseReceived") {
      onEvent({
        source: "debugger",
        id: params.requestId,
        phase: "response",
        url: params.response.url,
        status: params.response.status,
        mime: params.response.mimeType,
        timestamp: params.timestamp,
      });
    } else if (method === "Network.loadingFinished") {
      onEvent({
        source: "debugger",
        id: params.requestId,
        phase: "done",
        bytes: params.encodedDataLength,
        timestamp: params.timestamp,
      });
    } else if (method === "Network.loadingFailed") {
      onEvent({
        source: "debugger",
        id: params.requestId,
        phase: "error",
        error: params.errorText,
        timestamp: params.timestamp,
      });
    }
  });
  dbg.sendCommand("Network.enable").catch(() => {});
  return { ok: true };
}

module.exports = { attachDebugger };
