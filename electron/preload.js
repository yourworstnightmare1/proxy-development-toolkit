"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pdtk", {
  boot: () => ipcRenderer.invoke("boot"),
  getSession: () => ipcRenderer.invoke("get-session"),
  setSession: (session) => ipcRenderer.invoke("set-session", session),
  clearSession: () => ipcRenderer.invoke("clear-session"),
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  importGit: (payload) => ipcRenderer.invoke("import-git", payload),
  importFolder: (payload) => ipcRenderer.invoke("import-folder", payload),
  importUrl: (payload) => ipcRenderer.invoke("import-url", payload),
  setInspectBounds: (bounds) => ipcRenderer.send("inspect-bounds", bounds),
  getSettings: () => ipcRenderer.invoke("get-settings"),
  getAttributions: () => ipcRenderer.invoke("get-attributions"),
  getAttributionLicense: (id) => ipcRenderer.invoke("get-attribution-license", id),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  saveSettings: (settings) => ipcRenderer.invoke("save-settings", settings),
  listReleases: () => ipcRenderer.invoke("list-releases"),
  downloadRelease: (payload) => ipcRenderer.invoke("download-release", payload),
  checkPort: (payload) => ipcRenderer.invoke("check-port", payload),
  exportLog: (payload) => ipcRenderer.invoke("export-log", payload),
  ensureSplitHosts: () => ipcRenderer.invoke("ensure-split-hosts"),
  regenerateMcpToken: () => ipcRenderer.invoke("regenerate-mcp-token"),
  capturePane: (payload) => ipcRenderer.invoke("capture-pane", payload),
  onInspectState: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("inspect-state", listener);
    return () => ipcRenderer.removeListener("inspect-state", listener);
  },
  onNetwork: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("network-event", listener);
    return () => ipcRenderer.removeListener("network-event", listener);
  },
  onMcpCommand: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("mcp-command", listener);
    return () => ipcRenderer.removeListener("mcp-command", listener);
  },
  replyMcpCommand: (payload) => ipcRenderer.send("mcp-command-result", payload),
});
