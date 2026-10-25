const DEFAULT_TWEAKS = {
  tabCloaking: false,
  tabIconMode: "url",
  tabIconUrl: "",
  tabIconDataUrl: "",
  tabName: "",
  siteCloaking: false,
  siteCloakMode: "about:blank",
  loadInIframe: false,
  wispVerbose: false,
  wispVerboseMinimized: false,
  wispVerboseSigint: true,
  proxyVerbose: false,
  proxyVerboseMinimized: false,
  proxyVerboseSigint: true,
  transportVerbose: false,
  transportVerboseMinimized: false,
  transportVerboseSigint: true,
};

export const tweaks = { ...DEFAULT_TWEAKS };

let menuBound = false;
let blobCloakUrl = "";

export function loadTweaksFromSettings(settings = {}) {
  Object.assign(tweaks, {
    tabCloaking: Boolean(settings.tweakTabCloaking),
    tabIconMode: settings.tweakTabIconMode === "file" ? "file" : "url",
    tabIconUrl: settings.tweakTabIconUrl || "",
    tabIconDataUrl: settings.tweakTabIconDataUrl || "",
    tabName: settings.tweakTabName || "",
    siteCloaking: Boolean(settings.tweakSiteCloaking),
    siteCloakMode: settings.tweakSiteCloakMode === "blob:https" ? "blob:https" : "about:blank",
    loadInIframe: Boolean(settings.tweakLoadInIframe),
    wispVerbose: Boolean(settings.tweakWispVerbose),
    wispVerboseMinimized: Boolean(settings.tweakWispVerboseMinimized),
    wispVerboseSigint: settings.tweakWispVerboseSigint !== false,
    proxyVerbose: Boolean(settings.tweakProxyVerbose),
    proxyVerboseMinimized: Boolean(settings.tweakProxyVerboseMinimized),
    proxyVerboseSigint: settings.tweakProxyVerboseSigint !== false,
    transportVerbose: Boolean(settings.tweakTransportVerbose),
    transportVerboseMinimized: Boolean(settings.tweakTransportVerboseMinimized),
    transportVerboseSigint: settings.tweakTransportVerboseSigint !== false,
  });
  syncTweaksMenu();
}

export function tweaksSettingsPatch() {
  return {
    tweakTabCloaking: tweaks.tabCloaking,
    tweakTabIconMode: tweaks.tabIconMode,
    tweakTabIconUrl: tweaks.tabIconUrl,
    tweakTabIconDataUrl: tweaks.tabIconDataUrl,
    tweakTabName: tweaks.tabName,
    tweakSiteCloaking: tweaks.siteCloaking,
    tweakSiteCloakMode: tweaks.siteCloakMode,
    tweakLoadInIframe: tweaks.loadInIframe,
    tweakWispVerbose: tweaks.wispVerbose,
    tweakWispVerboseMinimized: tweaks.wispVerboseMinimized,
    tweakWispVerboseSigint: tweaks.wispVerboseSigint,
    tweakProxyVerbose: tweaks.proxyVerbose,
    tweakProxyVerboseMinimized: tweaks.proxyVerboseMinimized,
    tweakProxyVerboseSigint: tweaks.proxyVerboseSigint,
    tweakTransportVerbose: tweaks.transportVerbose,
    tweakTransportVerboseMinimized: tweaks.transportVerboseMinimized,
    tweakTransportVerboseSigint: tweaks.transportVerboseSigint,
  };
}

async function persistTweaks() {
  try {
    const state = await window.pdtk.getSettings();
    await window.pdtk.saveSettings({ ...(state?.settings || {}), ...tweaksSettingsPatch() });
  } catch { /* ignore */ }
}

const BOOLEAN_TWEAKS = Object.keys(DEFAULT_TWEAKS).filter((key) => typeof DEFAULT_TWEAKS[key] === "boolean");

export function tweakSnapshot() {
  const { tabIconDataUrl, ...rest } = tweaks;
  return { ...rest, hasTabIconFile: Boolean(tabIconDataUrl) };
}

export async function applyTweaksPatch(patch = {}, { fromMcp = false } = {}) {
  const changed = [];
  for (const key of BOOLEAN_TWEAKS) {
    if (typeof patch[key] !== "boolean" || tweaks[key] === patch[key]) continue;
    tweaks[key] = patch[key];
    changed.push(key);
  }
  for (const key of ["tabName", "tabIconUrl"]) {
    if (typeof patch[key] !== "string") continue;
    const value = patch[key].trim();
    if (tweaks[key] === value) continue;
    tweaks[key] = value;
    changed.push(key);
  }
  if (typeof patch.tabIconUrl === "string" && patch.tabIconUrl.trim() && tweaks.tabIconMode !== "url") {
    tweaks.tabIconMode = "url";
    changed.push("tabIconMode");
  }
  if (patch.siteCloakMode === "about:blank" || patch.siteCloakMode === "blob:https") {
    if (tweaks.siteCloakMode !== patch.siteCloakMode) {
      tweaks.siteCloakMode = patch.siteCloakMode;
      changed.push("siteCloakMode");
    }
  }
  syncTweaksMenu();
  if (changed.length) {
    await persistTweaks();
    window.dispatchEvent(new CustomEvent("pdtk-tweaks-changed", { detail: { keys: changed, fromMcp } }));
  }
  return changed;
}

function syncTweaksMenu() {
  const map = {
    "tweak-tab-cloaking": "tabCloaking",
    "tweak-site-cloaking": "siteCloaking",
    "tweak-load-iframe": "loadInIframe",
    "tweak-wisp-verbose": "wispVerbose",
    "tweak-proxy-verbose": "proxyVerbose",
    "tweak-transport-verbose": "transportVerbose",
  };
  for (const [id, key] of Object.entries(map)) {
    const input = document.getElementById(id);
    if (input) input.checked = Boolean(tweaks[key]);
  }
}

function setFavicon(href) {
  let link = document.querySelector("link[data-pdtk-favicon]");
  if (!href) {
    link?.remove();
    return;
  }
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    link.dataset.pdtkFavicon = "1";
    document.head.appendChild(link);
  }
  link.href = href;
}

export function applyTabCloaking(tab) {
  if (!tweaks.tabCloaking) {
    setFavicon("");
    return;
  }
  const name = tweaks.tabName.trim();
  if (name) {
    document.title = name;
    if (tab) tab.title = name;
  }
  const icon = tweaks.tabIconMode === "file"
    ? tweaks.tabIconDataUrl
    : tweaks.tabIconUrl;
  if (icon) setFavicon(icon);
  else setFavicon("");
}

export function cloakedAddress(realUrl) {
  if (!tweaks.siteCloaking) return realUrl;
  if (tweaks.siteCloakMode === "blob:https") {
    try {
      const host = new URL(realUrl).hostname || "example.com";
      return `blob:https://${host}/${Math.random().toString(36).slice(2, 10)}`;
    } catch {
      return "blob:https://cloaked/";
    }
  }
  return "about:blank";
}

export function ensureIframeWrapper(enabled) {
  const wrap = document.getElementById("frame-wrap");
  if (!wrap) return;
  let outer = document.getElementById("iframe-cloak-frame");
  if (!enabled) {
    if (outer) {
      outer.remove();
      wrap.classList.remove("iframe-cloaked");
    }
    return;
  }
  if (!outer) {
    outer = document.createElement("iframe");
    outer.id = "iframe-cloak-frame";
    outer.title = "Embedded site";
    outer.className = "iframe-cloak-frame";
    wrap.appendChild(outer);
  }
  wrap.classList.add("iframe-cloaked");
}

export async function startVerboseConsoles() {
  const results = [];
  if (tweaks.wispVerbose) {
    results.push(await window.pdtk.startVerboseConsole({
      kind: "wisp",
      title: "PDTK Wisp Verbose",
      minimized: tweaks.wispVerboseMinimized,
    }));
  }
  if (tweaks.proxyVerbose) {
    results.push(await window.pdtk.startVerboseConsole({
      kind: "proxy",
      title: "PDTK Proxy Verbose",
      minimized: tweaks.proxyVerboseMinimized,
    }));
  }
  if (tweaks.transportVerbose) {
    results.push(await window.pdtk.startVerboseConsole({
      kind: "transport",
      title: "PDTK Transport Verbose",
      minimized: tweaks.transportVerboseMinimized,
    }));
  }
  const failed = results.find((result) => result && result.ok === false);
  if (failed) throw new Error(failed.error || "Failed to open verbose terminal.");
  return results;
}

export async function stopVerboseConsoles() {
  await window.pdtk.stopVerboseConsole({ kind: "wisp", sigint: tweaks.wispVerboseSigint });
  await window.pdtk.stopVerboseConsole({ kind: "proxy", sigint: tweaks.proxyVerboseSigint });
  await window.pdtk.stopVerboseConsole({ kind: "transport", sigint: tweaks.transportVerboseSigint });
}

function openTweaksMenu(anchor) {
  const menu = document.getElementById("tweaks-menu");
  if (!menu) return;
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(rect.left, window.innerWidth - 360)}px`;
  menu.style.top = `${rect.bottom + 6}px`;
  menu.classList.remove("hidden");
  syncTweaksMenu();
}

function closeTweaksMenu() {
  document.getElementById("tweaks-menu")?.classList.add("hidden");
}

function openConfig(kind) {
  const dialog = document.getElementById("tweaks-config-dialog");
  const title = document.getElementById("tweaks-config-title");
  const body = document.getElementById("tweaks-config-body");
  if (!dialog || !title || !body) return;
  dialog.dataset.configKind = kind;
  body.innerHTML = "";
  if (kind === "tab") {
    title.textContent = "Tab Cloaking";
    body.innerHTML = `
      <label>Tab Icon
        <span class="hint">Set a custom tab icon.</span>
      </label>
      <div class="choices">
        <label class="choice"><input type="radio" name="tweak-tab-icon-mode" value="url" ${tweaks.tabIconMode !== "file" ? "checked" : ""} /> URL</label>
        <label class="choice"><input type="radio" name="tweak-tab-icon-mode" value="file" ${tweaks.tabIconMode === "file" ? "checked" : ""} /><img class="btn-icon" src="/icons/folder.png" alt="" /> Import File...</label>
      </div>
      <label id="tweak-tab-icon-url-wrap">Icon URL
        <input id="tweak-tab-icon-url" type="url" spellcheck="false" value="${tweaks.tabIconUrl.replace(/"/g, "&quot;")}" placeholder="https://example.com/favicon.ico" />
      </label>
      <div id="tweak-tab-icon-file-wrap" class="${tweaks.tabIconMode === "file" ? "" : "hidden"}">
        <input id="tweak-tab-icon-file" type="file" accept="image/*,.ico" />
        <p class="hint">${tweaks.tabIconDataUrl ? "A custom icon file is loaded." : "Choose an image or .ico file."}</p>
      </div>
      <label>Tab Name
        <span class="hint">Set a custom tab name.</span>
        <input id="tweak-tab-name" type="text" value="${tweaks.tabName.replace(/"/g, "&quot;")}" placeholder="Custom tab title" />
      </label>
    `;
  } else if (kind === "site") {
    title.textContent = "Site Cloaking";
    body.innerHTML = `
      <fieldset>
        <legend>Cloaking Mode</legend>
        <p class="hint">Choose how you want the site to spoof the URL.</p>
        <div class="choices">
          <label class="choice"><input type="radio" name="tweak-site-mode" value="about:blank" ${tweaks.siteCloakMode !== "blob:https" ? "checked" : ""} /> about:blank</label>
          <label class="choice"><input type="radio" name="tweak-site-mode" value="blob:https" ${tweaks.siteCloakMode === "blob:https" ? "checked" : ""} /> blob:https</label>
        </div>
      </fieldset>
    `;
  } else {
    const labels = { wisp: "Wisp Verbose", proxy: "Proxy Verbose", transport: "Transport Verbose" };
    const prefix = kind;
    title.textContent = labels[kind] || "Verbose";
    const minimized = tweaks[`${prefix}VerboseMinimized`];
    const sigint = tweaks[`${prefix}VerboseSigint`] !== false;
    body.innerHTML = `
      <fieldset>
        <legend>Start Minimized</legend>
        <p class="hint">Opens the window minimized by default.</p>
        <div class="choices">
          <label class="choice"><input type="radio" name="tweak-${prefix}-min" value="enabled" ${minimized ? "checked" : ""} /> Enabled</label>
          <label class="choice"><input type="radio" name="tweak-${prefix}-min" value="disabled" ${!minimized ? "checked" : ""} /> Disabled</label>
        </div>
      </fieldset>
      <fieldset>
        <legend>Send SIGINT on Session End</legend>
        <p class="hint">Will end the terminal window's session and close it automatically. This will not kill your other terminal processes/windows, only the one for this verbose stream.</p>
        <div class="choices">
          <label class="choice"><input type="radio" name="tweak-${prefix}-sigint" value="enabled" ${sigint ? "checked" : ""} /> Enabled</label>
          <label class="choice"><input type="radio" name="tweak-${prefix}-sigint" value="disabled" ${!sigint ? "checked" : ""} /> Disabled</label>
        </div>
      </fieldset>
    `;
  }
  dialog.classList.remove("hidden");
  if (kind === "tab") {
    const syncIconMode = () => {
      const mode = body.querySelector('input[name="tweak-tab-icon-mode"]:checked')?.value || "url";
      body.querySelector("#tweak-tab-icon-url-wrap")?.classList.toggle("hidden", mode === "file");
      body.querySelector("#tweak-tab-icon-file-wrap")?.classList.toggle("hidden", mode !== "file");
    };
    body.querySelectorAll('input[name="tweak-tab-icon-mode"]').forEach((input) => {
      input.addEventListener("change", syncIconMode);
    });
    syncIconMode();
  }
}

function saveConfig() {
  const dialog = document.getElementById("tweaks-config-dialog");
  const kind = dialog?.dataset.configKind;
  const body = document.getElementById("tweaks-config-body");
  if (!kind || !body) return;
  if (kind === "tab") {
    tweaks.tabIconMode = body.querySelector('input[name="tweak-tab-icon-mode"]:checked')?.value === "file" ? "file" : "url";
    tweaks.tabIconUrl = body.querySelector("#tweak-tab-icon-url")?.value.trim() || "";
    tweaks.tabName = body.querySelector("#tweak-tab-name")?.value.trim() || "";
    const fileInput = body.querySelector("#tweak-tab-icon-file");
    const file = fileInput?.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        tweaks.tabIconDataUrl = String(reader.result || "");
        void persistTweaks();
      };
      reader.readAsDataURL(file);
    }
  } else if (kind === "site") {
    tweaks.siteCloakMode = body.querySelector('input[name="tweak-site-mode"]:checked')?.value === "blob:https"
      ? "blob:https"
      : "about:blank";
  } else {
    tweaks[`${kind}VerboseMinimized`] = body.querySelector(`input[name="tweak-${kind}-min"]:checked`)?.value === "enabled";
    tweaks[`${kind}VerboseSigint`] = body.querySelector(`input[name="tweak-${kind}-sigint"]:checked`)?.value !== "disabled";
  }
  dialog.classList.add("hidden");
  void persistTweaks();
  if (kind === "tab" || kind === "site") {
    const keys = kind === "tab" ? ["tabName", "tabIconUrl"] : ["siteCloakMode"];
    window.dispatchEvent(new CustomEvent("pdtk-tweaks-changed", { detail: { key: kind, keys } }));
  }
}

export function initTweaks() {
  if (menuBound) return;
  menuBound = true;

  document.querySelectorAll(".apply-tweaks-btn").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const menu = document.getElementById("tweaks-menu");
      if (menu && !menu.classList.contains("hidden") && menu.dataset.anchor === button.id) {
        closeTweaksMenu();
        return;
      }
      if (menu) menu.dataset.anchor = button.id || "";
      openTweaksMenu(button);
    });
  });

  document.getElementById("tweaks-menu")?.addEventListener("click", (event) => event.stopPropagation());
  document.addEventListener("click", () => closeTweaksMenu());

  const bindCheck = (id, key) => {
    document.getElementById(id)?.addEventListener("change", (event) => {
      tweaks[key] = Boolean(event.target.checked);
      void persistTweaks();
      window.dispatchEvent(new CustomEvent("pdtk-tweaks-changed", { detail: { key, keys: [key] } }));
    });
  };
  bindCheck("tweak-tab-cloaking", "tabCloaking");
  bindCheck("tweak-site-cloaking", "siteCloaking");
  bindCheck("tweak-load-iframe", "loadInIframe");
  bindCheck("tweak-wisp-verbose", "wispVerbose");
  bindCheck("tweak-proxy-verbose", "proxyVerbose");
  bindCheck("tweak-transport-verbose", "transportVerbose");

  document.querySelectorAll("[data-tweak-config]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openConfig(button.dataset.tweakConfig);
    });
  });

  document.getElementById("tweaks-config-cancel")?.addEventListener("click", () => {
    document.getElementById("tweaks-config-dialog")?.classList.add("hidden");
  });
  document.getElementById("tweaks-config-save")?.addEventListener("click", () => saveConfig());
  document.getElementById("tweaks-config-dialog")?.addEventListener("click", (event) => {
    if (event.target?.id === "tweaks-config-dialog") {
      document.getElementById("tweaks-config-dialog")?.classList.add("hidden");
    }
  });
}

export function revokeBlobCloak() {
  if (blobCloakUrl) {
    try { URL.revokeObjectURL(blobCloakUrl); } catch { /* ignore */ }
    blobCloakUrl = "";
  }
}
