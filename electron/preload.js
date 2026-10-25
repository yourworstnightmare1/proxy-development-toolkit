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
  checkForUpdates: (payload) => ipcRenderer.invoke("check-for-updates", payload || {}),
  startVerboseConsole: (payload) => ipcRenderer.invoke("verbose-console-start", payload || {}),
  stopVerboseConsole: (payload) => ipcRenderer.invoke("verbose-console-stop", payload || {}),
  stopAllVerboseConsoles: (payload) => ipcRenderer.invoke("verbose-console-stop-all", payload || {}),
  setWindowChrome: (payload) => ipcRenderer.invoke("set-window-chrome", payload || {}),
  copyText: (text) => ipcRenderer.invoke("copy-text", text),
  saveSettings: (settings) => ipcRenderer.invoke("save-settings", settings),
  listReleases: () => ipcRenderer.invoke("list-releases"),
  downloadRelease: (payload) => ipcRenderer.invoke("download-release", payload),
  downloadTransports: (payload) => ipcRenderer.invoke("download-transports", payload || {}),
  resetTransports: () => ipcRenderer.invoke("reset-transports"),
  downloadAppUpdate: () => ipcRenderer.invoke("download-app-update"),
  restartApp: () => ipcRenderer.invoke("restart-app"),
  startDevServer: (payload) => ipcRenderer.invoke("start-dev-server", payload || {}),
  stopDevServer: () => ipcRenderer.invoke("stop-dev-server"),
  detectDevDeps: (payload) => ipcRenderer.invoke("detect-dev-deps", payload || {}),
  onDevServerEvent: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("dev-server-event", listener);
    return () => ipcRenderer.removeListener("dev-server-event", listener);
  },
  listTransportVersions: (payload) => ipcRenderer.invoke("list-transport-versions", payload || {}),
  selectTransportVersion: (payload) => ipcRenderer.invoke("select-transport-version", payload || {}),
  onDownloadProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("download-progress", listener);
    return () => ipcRenderer.removeListener("download-progress", listener);
  },
  checkPort: (payload) => ipcRenderer.invoke("check-port", payload),
  exportLog: (payload) => ipcRenderer.invoke("export-log", payload),
  ensureComboHosts: (payload) => ipcRenderer.invoke("ensure-combo-hosts", payload || {}),
  openComboWindow: (payload) => ipcRenderer.invoke("open-combo-window", payload || {}),
  closeComboWindow: (payload) => ipcRenderer.invoke("close-combo-window", payload || {}),
  focusComboWindow: (payload) => ipcRenderer.invoke("focus-combo-window", payload || {}),
  postComboWindow: (payload) => ipcRenderer.invoke("post-combo-window", payload || {}),
  onComboWindowClosed: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("combo-window-closed", listener);
    return () => ipcRenderer.removeListener("combo-window-closed", listener);
  },
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
