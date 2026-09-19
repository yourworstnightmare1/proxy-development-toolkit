"use strict";

const { BrowserWindow, Menu, clipboard, dialog, session } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

let saveAsPending = false;

function isHttp(url) {
  return typeof url === "string" && /^https?:/i.test(url);
}

function isRemoteHttp(url) {
  if (!isHttp(url)) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host !== "localhost" && host !== "127.0.0.1" && host !== "::1";
  } catch {
    return false;
  }
}

function xorDecode(value) {
  if (!value) return "";
  const [input, ...search] = String(value).split("?");
  let decoded = input;
  try {
    decoded = decodeURIComponent(input);
  } catch { /* keep raw */ }
  let out = "";
  for (let i = 0; i < decoded.length; i += 1) {
    const code = decoded.charCodeAt(i);
    out += i % 2 ? String.fromCharCode(code ^ 2) : decoded[i];
  }
  return out + (search.length ? `?${search.join("?")}` : "");
}

function decodePlainUrl(url) {
  if (!url || typeof url !== "string") return "";
  try {
    const parsed = new URL(url);
    const query = parsed.searchParams.get("url");
    if (query && /^https?:/i.test(query)) return query;
    const hash = parsed.hash.replace(/^#/, "");
    if (hash.startsWith("url=")) {
      let inner = hash.slice(4);
      try { inner = decodeURIComponent(inner); } catch { /* keep */ }
      if (/^https?:/i.test(inner)) return inner;
    }
    const marker = "/uv/service/";
    const index = parsed.pathname.indexOf(marker);
    if (index >= 0) {
      const decoded = xorDecode(parsed.pathname.slice(index + marker.length));
      if (/^https?:/i.test(decoded)) return decoded;
    }
  } catch { /* ignore */ }
  return isRemoteHttp(url) ? url : "";
}

function frameUrl(contents, params) {
  try {
    if (params.frame && typeof params.frame.url === "string" && params.frame.url) return params.frame.url;
  } catch { /* ignore */ }
  try {
    return contents.getURL() || "";
  } catch {
    return "";
  }
}

async function pageDestination(contents) {
  try {
    const value = await contents.executeJavaScript(
      "document.getElementById('address')?.value || ''",
      true
    );
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

function writeText(text) {
  if (!text) return;
  try { clipboard.writeText(text); } catch { /* ignore */ }
}

function downloadWithDialog(contents, url) {
  if (!contents || contents.isDestroyed() || !isHttp(url)) return;
  saveAsPending = true;
  try {
    contents.downloadURL(url);
  } catch (error) {
    saveAsPending = false;
    console.warn("downloadURL:", error);
  }
}

function installSaveAsPrompt() {
  session.defaultSession.on("will-download", (event, item, webContents) => {
    if (!saveAsPending) return;
    saveAsPending = false;
    const owner = BrowserWindow.fromWebContents(webContents) || BrowserWindow.getFocusedWindow();
    const chosen = dialog.showSaveDialogSync(owner || undefined, {
      defaultPath: item.getFilename() || "download",
    });
    if (!chosen) {
      item.cancel();
      return;
    }
    item.setSavePath(chosen);
  });
}

async function frameHtml(contents, params) {
  if (params.frame && contents.mainFrame && params.frame !== contents.mainFrame && typeof params.frame.executeJavaScript === "function") {
    return params.frame.executeJavaScript("document.documentElement.outerHTML", true);
  }
  return contents.executeJavaScript("document.documentElement.outerHTML", true);
}

async function savePage(contents, params) {
  if (!contents || contents.isDestroyed()) return;
  const owner = BrowserWindow.fromWebContents(contents) || BrowserWindow.getFocusedWindow();
  const inFrame = params.frame && contents.mainFrame && params.frame !== contents.mainFrame;
  const chosen = await dialog.showSaveDialog(owner || undefined, {
    defaultPath: "page.html",
    filters: [{ name: "Web page", extensions: ["html"] }],
  });
  if (chosen.canceled || !chosen.filePath) return;
  try {
    if (!inFrame) {
      await contents.savePage(chosen.filePath, "HTMLComplete");
      return;
    }
    const html = await frameHtml(contents, params);
    fs.writeFileSync(chosen.filePath, `<!DOCTYPE html>\n${html || ""}`);
  } catch (error) {
    console.warn("savePage:", error);
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function viewPageSource(contents, params) {
  let html = "";
  try {
    if (params.frame && typeof params.frame.executeJavaScript === "function") {
      html = await params.frame.executeJavaScript("document.documentElement.outerHTML", true);
    } else {
      html = await contents.executeJavaScript("document.documentElement.outerHTML", true);
    }
  } catch (error) {
    console.warn("view source:", error);
    return;
  }
  if (!html) return;
  const file = path.join(os.tmpdir(), `pdtk-source-${Date.now()}.html`);
  const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Page Source</title>
<style>body{margin:0;background:#161616;color:#f3f3f3;font:13px Consolas,monospace}pre{margin:0;padding:16px;white-space:pre-wrap;word-break:break-word}</style>
</head><body><pre>${escapeHtml(html)}</pre></body></html>`;
  fs.writeFileSync(file, page);
  const viewer = new BrowserWindow({
    width: 920,
    height: 700,
    title: "Page Source",
    backgroundColor: "#161616",
    autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  viewer.setMenuBarVisibility(false);
  await viewer.loadFile(file);
}

function popupPageContextMenu(contents, params, hooks) {
  if (!contents || contents.isDestroyed()) return;
  const edit = params.editFlags || {};
  const linkURL = typeof params.linkURL === "string" ? params.linkURL : "";
  const hasLink = !!(params.linkURL && !linkURL.startsWith("javascript:"));
  const mediaType = params.mediaType || "none";
  const hasImage = mediaType === "image" || !!(params.hasImageContents && params.srcURL);
  const imageRaw = hasImage && typeof params.srcURL === "string" ? params.srcURL : "";
  const rawUrl = frameUrl(contents, params);
  const plainPage = decodePlainUrl(rawUrl);
  const plainLink = hasLink ? (decodePlainUrl(linkURL) || (isRemoteHttp(linkURL) ? linkURL : "")) : "";
  const plainImage = decodePlainUrl(imageRaw) || (isRemoteHttp(imageRaw) ? imageRaw : imageRaw);
  const owner = BrowserWindow.fromWebContents(contents) || BrowserWindow.getFocusedWindow();
  const template = [];

  if (hasLink) {
    const saveTarget = isHttp(linkURL) ? linkURL : (isHttp(plainLink) ? plainLink : "");
    template.push(
      {
        label: "Save link as…",
        enabled: !!saveTarget,
        click: () => downloadWithDialog(contents, saveTarget),
      },
      {
        label: "Copy link address",
        click: () => writeText(plainLink || linkURL),
      },
      { type: "separator" }
    );
  }

  if (hasImage) {
    const saveTarget = isHttp(imageRaw) ? imageRaw : (isHttp(plainImage) ? plainImage : "");
    template.push(
      {
        label: "Save image as…",
        enabled: !!saveTarget,
        click: () => downloadWithDialog(contents, saveTarget),
      },
      {
        label: "Copy image",
        enabled: !!params.hasImageContents,
        click: () => {
          setTimeout(() => {
            if (contents.isDestroyed()) return;
            try { contents.copyImageAt(params.x, params.y); } catch (error) { console.warn("copyImageAt:", error); }
          }, 0);
        },
      },
      {
        label: "Copy image address",
        enabled: !!(plainImage || imageRaw),
        click: () => writeText(plainImage || imageRaw),
      },
      { type: "separator" }
    );
  }

  template.push(
    {
      label: "Copy",
      accelerator: "CommandOrControl+C",
      registerAccelerator: false,
      enabled: !!edit.canCopy,
      click: () => { try { contents.copy(); } catch { /* ignore */ } },
    },
    {
      label: "Paste",
      accelerator: "CommandOrControl+V",
      registerAccelerator: false,
      enabled: !!edit.canPaste,
      click: () => { try { contents.paste(); } catch { /* ignore */ } },
    },
    { type: "separator" },
    {
      label: hasLink ? "Copy link URL" : "Copy URL",
      enabled: !!(plainLink || plainPage || rawUrl || linkURL),
      click: async () => {
        if (hasLink) {
          writeText(plainLink || linkURL);
          return;
        }
        const address = await pageDestination(contents);
        writeText(plainPage || address || rawUrl);
      },
    },
    {
      label: hasLink ? "Copy proxied link URL" : "Copy proxied URL",
      enabled: !!(linkURL || rawUrl),
      click: () => writeText(hasLink ? linkURL : rawUrl),
    },
    { type: "separator" },
    {
      label: "Save As…",
      accelerator: "CommandOrControl+S",
      registerAccelerator: false,
      click: () => { void savePage(contents, params); },
    },
    {
      label: "View Page Source",
      click: () => { void viewPageSource(contents, params); },
    },
  );
  if (!hooks || hooks.devtoolsEnabled !== false) {
    template.push({
      label: "Inspect Element",
      accelerator: "CommandOrControl+Shift+I",
      registerAccelerator: false,
      click: () => {
        if (hooks && hooks.openInspect) hooks.openInspect();
        try { contents.inspectElement(params.x, params.y); } catch { /* ignore */ }
      },
    });
  }

  Menu.buildFromTemplate(template).popup({
    window: owner || undefined,
    x: params.x,
    y: params.y,
  });
}

module.exports = {
  installSaveAsPrompt,
  popupPageContextMenu,
};
