const page = document.getElementById("settings-page");
const toggle = document.getElementById("settings-toggle");
const banner = document.getElementById("settings-banner");

const catalogs = {
  ultraviolet: [],
  scramjet: [],
};

let runtime = null;
let saving = false;
let sitePermissions = {};

function note(id, message, isError) {
  const node = document.getElementById(id);
  if (!node) return;
  node.textContent = message || "";
  node.classList.toggle("error", Boolean(isError));
}

function radio(name, enabled) {
  const value = enabled ? "enabled" : "disabled";
  const input = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (input) input.checked = true;
}

function radioYesNo(name, yes) {
  const value = yes ? "yes" : "no";
  const input = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (input) input.checked = true;
}

function radioEnabled(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value === "enabled";
}

function radioIsYes(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value === "yes";
}

function optionLabel(item) {
  const recommended = item.recommended ? " · recommended" : "";
  return `${item.label}${recommended}`;
}

function fillVersions(select, items, selected) {
  select.innerHTML = "";
  for (const item of items) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = optionLabel(item);
    option.selected = item.id === selected;
    select.appendChild(option);
  }
  if (selected && !items.some((item) => item.id === selected)) {
    const option = document.createElement("option");
    option.value = selected;
    option.textContent = selected;
    option.selected = true;
    select.appendChild(option);
  }
}

function selectedVersion(kind) {
  const id = document.getElementById(kind === "ultraviolet" ? "uv-version" : "sj-version").value;
  return (catalogs[kind] || []).find((item) => item.id === id) || null;
}

function syncDownload(kind) {
  const button = document.getElementById(kind === "ultraviolet" ? "uv-download" : "sj-download");
  const item = selectedVersion(kind);
  button.classList.toggle("hidden", !item || item.installed);
}

function showSection(id) {
  const target = id === "attributions" ? "attributions" : id;
  document.querySelectorAll(".settings-section").forEach((section) => {
    section.classList.toggle("active", section.id === `section-${target}`);
  });
  document.querySelectorAll(".settings-nav .nav-item").forEach((item) => {
    const active = item.dataset.section === (target === "attributions" ? "about" : target);
    item.classList.toggle("active", active);
  });
  if (target === "attributions") {
    document.getElementById("attribution-license-panel")?.classList.add("hidden");
    document.getElementById("attributions-list")?.classList.remove("hidden");
    void renderAttributions();
  }
}

const SECTION_TITLES = {
  proxy: "Proxy & Web",
  browser: "Browser",
  security: "Security",
  developer: "Developer",
  mcp: "MCP/Server",
  about: "About",
  attributions: "Attributions",
};

function collectSearchIndex() {
  const entries = [];
  for (const [id, title] of Object.entries(SECTION_TITLES)) {
    const section = document.getElementById(`section-${id}`);
    if (!section) continue;
    const desc = section.querySelector(".section-desc")?.textContent?.trim() || "";
    entries.push({
      section: id,
      label: title,
      haystack: `${title} ${desc}`.toLowerCase(),
      kind: "section",
      target: section,
    });
    section.querySelectorAll("h3, legend, label").forEach((node, index) => {
      const text = Array.from(node.childNodes)
        .filter((child) => child.nodeType === Node.TEXT_NODE)
        .map((child) => child.textContent.trim())
        .filter(Boolean)
        .join(" ")
        || node.textContent.trim().split("\n")[0].trim();
      if (!text || text.length < 2) return;
      const hint = node.querySelector?.(".hint")?.textContent?.trim() || "";
      entries.push({
        section: id,
        label: text,
        haystack: `${text} ${hint} ${title}`.toLowerCase(),
        kind: "option",
        target: node,
        key: `${id}-${index}-${text}`,
      });
    });
  }
  return entries;
}

let searchIndex = [];
let highlightTimer = null;

function clearSearchHighlight() {
  document.querySelectorAll(".settings-block-highlight").forEach((node) => {
    node.classList.remove("settings-block-highlight");
  });
}

function jumpToSearchHit(entry) {
  showSection(entry.section);
  clearSearchHighlight();
  const target = entry.target;
  if (!target) return;
  target.classList.add("settings-block-highlight");
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  if (highlightTimer) clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => target.classList.remove("settings-block-highlight"), 1800);
}

function runSettingsSearch(query) {
  const q = String(query || "").trim().toLowerCase();
  const results = document.getElementById("settings-search-results");
  const navItems = document.querySelectorAll(".settings-nav .nav-item");
  if (!q) {
    results.classList.add("hidden");
    results.innerHTML = "";
    navItems.forEach((item) => item.classList.remove("nav-filtered-out"));
    clearSearchHighlight();
    return;
  }
  if (!searchIndex.length) searchIndex = collectSearchIndex();
  const matches = searchIndex.filter((entry) => entry.haystack.includes(q));
  const sectionHits = new Set(matches.map((entry) => (entry.section === "attributions" ? "about" : entry.section)));
  navItems.forEach((item) => {
    item.classList.toggle("nav-filtered-out", !sectionHits.has(item.dataset.section));
  });
  results.classList.remove("hidden");
  if (!matches.length) {
    results.innerHTML = `<p class="settings-search-empty">No settings match “${query.trim()}”.</p>`;
    return;
  }
  const optionMatches = matches.filter((entry) => entry.kind === "option");
  const sectionOnly = matches.filter((entry) => entry.kind === "section" && !optionMatches.some((m) => m.section === entry.section));
  const shown = [...optionMatches, ...sectionOnly].slice(0, 40);
  results.innerHTML = "";
  for (const entry of shown) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "settings-search-hit";
    button.setAttribute("role", "option");
    button.innerHTML = `<span class="hit-label"></span><span class="hit-section"></span>`;
    button.querySelector(".hit-label").textContent = entry.label;
    button.querySelector(".hit-section").textContent = SECTION_TITLES[entry.section] || entry.section;
    button.addEventListener("click", () => jumpToSearchHit(entry));
    results.appendChild(button);
  }
}

function syncUaCustom() {
  document.getElementById("ua-custom-os-wrap").classList.toggle("hidden", document.getElementById("ua-os").value !== "Custom");
  document.getElementById("ua-custom-browser-wrap").classList.toggle("hidden", document.getElementById("ua-browser").value !== "Custom");
}

function uaPreview() {
  const os = document.getElementById("ua-os").value;
  const browser = document.getElementById("ua-browser").value;
  const customOs = document.getElementById("ua-custom-os").value.trim();
  const customBrowser = document.getElementById("ua-custom-browser").value.trim();
  if (browser === "Custom" && customBrowser) return customBrowser;
  return `${os === "Custom" ? (customOs || "Custom") : os} / ${browser === "Custom" ? (customBrowser || "Custom") : browser}`;
}

function renderPermissions() {
  const body = document.querySelector("#permissions-table tbody");
  body.innerHTML = "";
  const rows = Object.entries(sitePermissions).flatMap(([origin, perms]) =>
    Object.entries(perms || {}).map(([kind, action]) => ({ origin, kind, action }))
  );
  if (!rows.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="4" style="color:var(--muted)">No site permission rules yet.</td>`;
    body.appendChild(tr);
    return;
  }
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${row.origin}</td><td>${row.kind}</td><td>${row.action}</td><td></td>`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Remove";
    btn.addEventListener("click", () => {
      if (sitePermissions[row.origin]) delete sitePermissions[row.origin][row.kind];
      if (sitePermissions[row.origin] && !Object.keys(sitePermissions[row.origin]).length) {
        delete sitePermissions[row.origin];
      }
      renderPermissions();
      persist("settings-banner");
    });
    tr.lastElementChild.appendChild(btn);
    body.appendChild(tr);
  }
}

function mcpSnippet(settings, status) {
  const url = status?.url || `http://127.0.0.1:${settings.mcpPort || 7432}/mcp`;
  const token = settings.mcpToken || "";
  return JSON.stringify({
    mcpServers: {
      "proxy-development-toolkit": {
        url,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    },
  }, null, 2);
}

function mcpClaudeSnippet(settings, status) {
  const url = status?.url || `http://127.0.0.1:${settings.mcpPort || 7432}/mcp`;
  const token = settings.mcpToken || "";
  return JSON.stringify({
    mcpServers: {
      "proxy-development-toolkit": {
        type: "http",
        url,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    },
  }, null, 2);
}

function mcpCodexSnippet(settings, status) {
  const url = status?.url || `http://127.0.0.1:${settings.mcpPort || 7432}/mcp`;
  const token = settings.mcpToken || "";
  return JSON.stringify({
    mcpServers: {
      "proxy-development-toolkit": {
        url,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    },
  }, null, 2);
}

function mcpHttpSnippet(settings, status) {
  const url = status?.url || `http://127.0.0.1:${settings.mcpPort || 7432}/mcp`;
  const token = settings.mcpToken || "";
  return [
    `URL: ${url}`,
    `Authorization: Bearer ${token}`,
    "Transport: Streamable HTTP (loopback only)",
  ].join("\n");
}

function mcpCustomSnippet(settings, status, name) {
  const url = status?.url || `http://127.0.0.1:${settings.mcpPort || 7432}/mcp`;
  const token = settings.mcpToken || "";
  const key = String(name || "custom-agent").trim().replace(/\s+/g, "-").toLowerCase() || "custom-agent";
  return [
    `# ${name || "Custom AI model"} — Streamable HTTP MCP`,
    `URL: ${url}`,
    `Authorization: Bearer ${token}`,
    "",
    "Example config entry:",
    JSON.stringify({
      mcpServers: {
        [key]: {
          url,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    }, null, 2),
  ].join("\n");
}

function paintAbout(about) {
  const info = about || {};
  document.getElementById("about-app-name").textContent = info.name || "Proxy Development Toolkit";
  document.getElementById("about-version").textContent = info.version || "—";
  const commit = document.getElementById("about-commit");
  commit.textContent = info.commitShort || info.commit || "uncommitted";
  commit.title = info.commit || "";
  const buildDate = info.buildDate || info.commitDate || "";
  document.getElementById("about-build-date").textContent = buildDate
    ? new Date(buildDate).toLocaleString()
    : "—";
}

async function renderAttributions() {
  const list = document.getElementById("attributions-list");
  if (!list) return;
  list.innerHTML = "<p class=\"status\">Loading…</p>";
  try {
    const items = await window.pdtk.getAttributions();
    list.innerHTML = "";
    for (const item of items) {
      const card = document.createElement("article");
      card.className = "attribution-card";
      card.innerHTML = `
        <h3></h3>
        <p class="attribution-by">by <a class="attribution-author" href="#"></a></p>
        <p class="attribution-source"><a class="attribution-source-link" href="#"></a></p>
        <p class="attribution-license-label"></p>
        <button type="button" class="attribution-view-license">View license</button>
      `;
      card.querySelector("h3").textContent = item.title;
      const author = card.querySelector(".attribution-author");
      author.textContent = item.author;
      author.addEventListener("click", (event) => {
        event.preventDefault();
        window.pdtk.openExternal(item.authorUrl);
      });
      const source = card.querySelector(".attribution-source-link");
      source.textContent = item.sourceUrl;
      source.addEventListener("click", (event) => {
        event.preventDefault();
        window.pdtk.openExternal(item.sourceUrl);
      });
      card.querySelector(".attribution-license-label").textContent = item.licenseLabel;
      card.querySelector(".attribution-view-license").addEventListener("click", () => openAttributionLicense(item.id));
      list.appendChild(card);
    }
  } catch (error) {
    list.innerHTML = "";
    const p = document.createElement("p");
    p.className = "status error";
    p.textContent = error.message || String(error);
    list.appendChild(p);
  }
}

async function openAttributionLicense(id) {
  const panel = document.getElementById("attribution-license-panel");
  const list = document.getElementById("attributions-list");
  const title = document.getElementById("attribution-license-title");
  const text = document.getElementById("attribution-license-text");
  list.classList.add("hidden");
  panel.classList.remove("hidden");
  title.textContent = "License";
  text.textContent = "Loading…";
  try {
    const detail = await window.pdtk.getAttributionLicense(id);
    if (!detail) {
      text.textContent = "License not found.";
      return;
    }
    title.textContent = `${detail.title} — ${detail.licenseLabel}`;
    text.textContent = detail.text || "";
  } catch (error) {
    text.textContent = error.message || String(error);
  }
}

let activeMcpClient = "cursor";

function refreshActiveSnippet() {
  if (!runtime) return;
  const settings = runtime.settings || {};
  const mcp = runtime.mcp || {};
  const cursor = mcpSnippet(settings, mcp);
  const claude = mcpClaudeSnippet(settings, mcp);
  const codex = mcpCodexSnippet(settings, mcp);
  const http = mcpHttpSnippet(settings, mcp);
  document.getElementById("mcp-snippet-cursor").value = cursor;
  document.getElementById("mcp-snippet-claude").value = claude;
  document.getElementById("mcp-snippet-http").value = http;
  const title = document.getElementById("mcp-snippet-title");
  const active = document.getElementById("mcp-snippet-active");
  const customWrap = document.getElementById("mcp-custom-fields");
  customWrap.classList.toggle("hidden", activeMcpClient !== "custom");
  if (activeMcpClient === "claude") {
    title.textContent = "Claude Desktop config snippet";
    active.value = claude;
  } else if (activeMcpClient === "codex") {
    title.textContent = "Codex / OpenAI config snippet";
    active.value = codex;
  } else if (activeMcpClient === "custom") {
    title.textContent = "Custom AI model snippet";
    active.value = mcpCustomSnippet(settings, mcp, document.getElementById("mcp-custom-name").value);
  } else {
    title.textContent = "Cursor mcp.json snippet";
    active.value = cursor;
  }
}

function selectMcpClient(client) {
  activeMcpClient = client || "cursor";
  document.querySelectorAll(".mcp-client-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mcpClient === activeMcpClient);
  });
  refreshActiveSnippet();
}

function paint(state) {
  runtime = state || runtime;
  if (!runtime) return;
  const settings = runtime.settings || {};
  fillVersions(document.getElementById("uv-version"), catalogs.ultraviolet, settings.uvVersion || "bundled");
  fillVersions(document.getElementById("sj-version"), catalogs.scramjet, settings.scramjetVersion || "bundled");
  document.getElementById("uv-port").value = settings.uvPort || "8080";
  document.getElementById("sj-port").value = settings.scramjetPort || "3000";
  document.getElementById("wisp-port").value = settings.wispPort || "";
  radio("wisp-host", settings.hostWispLocally);
  radio("wisp-log", settings.logWispTraffic !== false);
  radio("devtools", settings.devtools !== false);

  document.getElementById("ua-os").value = settings.uaOs || "Windows";
  document.getElementById("ua-browser").value = settings.uaBrowser || "Chrome";
  document.getElementById("ua-custom-os").value = settings.uaCustomOs || "";
  document.getElementById("ua-custom-browser").value = settings.uaCustomBrowser || "";
  syncUaCustom();
  note("ua-preview", `Preview: ${uaPreview()}`);
  const orient = document.querySelector(`input[name="screen-orientation"][value="${settings.screenOrientation === "portrait" ? "portrait" : "landscape"}"]`);
  if (orient) orient.checked = true;
  document.getElementById("screen-width").value = settings.screenWidth || 1920;
  document.getElementById("screen-height").value = settings.screenHeight || 1080;
  radio("multi-tabs", settings.allowMultipleTabs);
  radioYesNo("url-mod", settings.allowUrlModification !== false);
  radioYesNo("site-redirects", settings.allowSiteRedirects !== false);

  sitePermissions = settings.sitePermissions && typeof settings.sitePermissions === "object"
    ? structuredClone(settings.sitePermissions)
    : {};
  renderPermissions();
  radioYesNo("force-https", settings.forceHttps !== false);
  radioYesNo("indexeddb", settings.allowIndexedDb !== false);
  radioYesNo("allow-download", settings.allowDownloading !== false);
  document.getElementById("download-location").value = settings.downloadLocation || "";

  document.getElementById("log-all").checked = settings.logAll !== false;
  document.getElementById("log-network").checked = settings.logNetwork !== false;
  document.getElementById("log-console").checked = settings.logConsole !== false;
  document.getElementById("log-performance").checked = Boolean(settings.logPerformance);
  document.getElementById("log-system").checked = Boolean(settings.logSystem);
  document.getElementById("log-application").checked = settings.logApplication !== false;
  document.getElementById("log-location").value = settings.logLocation || "";

  radio("mcp-enabled", settings.mcpEnabled);
  document.getElementById("mcp-port").value = settings.mcpPort || "7432";
  document.getElementById("mcp-token").value = settings.mcpToken || "";
  radio("mcp-control", settings.mcpAllowControl !== false);
  const mcp = runtime.mcp || {};
  document.getElementById("mcp-status").value = mcp.running
    ? `Running at ${mcp.url}`
    : (settings.mcpEnabled ? "Enabled in settings, but not running yet." : "Stopped");
  refreshActiveSnippet();
  paintAbout(runtime.about);

  const wisp = runtime.wisp || {};
  document.getElementById("wisp-address").value = wisp.hosting ? (wisp.url || wisp.text) : "Hosting is off.";
  syncDownload("ultraviolet");
  syncDownload("scramjet");
  const listening = runtime.listenPort ? `This session is listening on port ${runtime.listenPort}.` : "";
  const extra = runtime.extraPort ? ` Also hosting on port ${runtime.extraPort}.` : "";
  const restart = runtime.restartRequired
    ? " Saved Ultraviolet or Scramjet ports apply the next time the app starts."
    : "";
  const notice = runtime.portNotice ? ` ${runtime.portNotice}` : "";
  note("settings-banner", `${listening}${extra}${restart}${notice}`.trim(), Boolean(runtime.portNotice));
}

function snapshot() {
  return {
    uvVersion: document.getElementById("uv-version").value,
    uvPort: document.getElementById("uv-port").value.trim(),
    scramjetVersion: document.getElementById("sj-version").value,
    scramjetPort: document.getElementById("sj-port").value.trim(),
    hostWispLocally: radioEnabled("wisp-host"),
    wispPort: document.getElementById("wisp-port").value.trim(),
    logWispTraffic: radioEnabled("wisp-log"),
    devtools: radioEnabled("devtools"),
    uaOs: document.getElementById("ua-os").value,
    uaBrowser: document.getElementById("ua-browser").value,
    uaCustomOs: document.getElementById("ua-custom-os").value.trim(),
    uaCustomBrowser: document.getElementById("ua-custom-browser").value.trim(),
    screenOrientation: document.querySelector('input[name="screen-orientation"]:checked')?.value || "landscape",
    screenWidth: Number(document.getElementById("screen-width").value) || 1920,
    screenHeight: Number(document.getElementById("screen-height").value) || 1080,
    allowMultipleTabs: radioEnabled("multi-tabs"),
    allowUrlModification: radioIsYes("url-mod"),
    allowSiteRedirects: radioIsYes("site-redirects"),
    sitePermissions,
    forceHttps: radioIsYes("force-https"),
    allowIndexedDb: radioIsYes("indexeddb"),
    allowDownloading: radioIsYes("allow-download"),
    downloadLocation: document.getElementById("download-location").value.trim(),
    logAll: document.getElementById("log-all").checked,
    logNetwork: document.getElementById("log-network").checked,
    logConsole: document.getElementById("log-console").checked,
    logPerformance: document.getElementById("log-performance").checked,
    logSystem: document.getElementById("log-system").checked,
    logApplication: document.getElementById("log-application").checked,
    logLocation: document.getElementById("log-location").value.trim(),
    mcpEnabled: radioEnabled("mcp-enabled"),
    mcpPort: document.getElementById("mcp-port").value.trim(),
    mcpToken: document.getElementById("mcp-token").value.trim(),
    mcpAllowControl: radioEnabled("mcp-control"),
  };
}

function savableSnapshot() {
  const next = snapshot();
  const saved = runtime && runtime.settings ? runtime.settings : {};
  const uv = selectedVersion("ultraviolet");
  const sj = selectedVersion("scramjet");
  if (!uv || !uv.installed) next.uvVersion = saved.uvVersion || "bundled";
  if (!sj || !sj.installed) next.scramjetVersion = saved.scramjetVersion || "bundled";
  return next;
}

async function persist(sourceNote) {
  if (saving) return;
  saving = true;
  try {
    const result = await window.pdtk.saveSettings(savableSnapshot());
    if (result.state) paint(result.state);
    if (!result.ok) {
      note(sourceNote || "settings-banner", result.error || "Could not save settings.", true);
      return;
    }
    if (sourceNote && sourceNote !== "settings-banner") note(sourceNote, "");
    const follow = [];
    if (result.versionChanged) {
      const session = await window.pdtk.getSession();
      if (session) follow.push("End the session and start it again to use the selected proxy build.");
    }
    if (result.restartRequired) follow.push("Restart the app before the local server uses a saved Ultraviolet or Scramjet port.");
    if (follow.length) note("settings-banner", follow.join(" "), false);
    window.dispatchEvent(new CustomEvent("pdtk-settings-changed", { detail: result.state }));
  } catch (error) {
    note(sourceNote || "settings-banner", error.message || String(error), true);
  } finally {
    saving = false;
  }
}

async function checkField(inputId, noteId, field) {
  const value = document.getElementById(inputId).value.trim();
  if (!value) {
    note(noteId, field === "wisp"
      ? "Choose a port if you want to host Wisp locally. This does nothing while hosting is disabled."
      : field === "mcp"
        ? "Default MCP port is 7432."
        : field === "uv"
          ? "Empty falls back to the default Ultraviolet port 8080."
          : field === "sj"
            ? "Empty falls back to the default Scramjet port 3000."
            : "Empty keeps the ephemeral port. A saved port applies on the next launch.");
    return true;
  }
  const result = await window.pdtk.checkPort({ field, port: value });
  if (!result.ok) {
    note(noteId, result.message || "That port cannot be used.", true);
    return false;
  }
  note(noteId, `Port ${result.port} is available.`);
  return true;
}

async function download(kind) {
  const item = selectedVersion(kind);
  const noteId = kind === "ultraviolet" ? "uv-version-note" : "sj-version-note";
  if (!item || item.installed) return;
  const button = document.getElementById(kind === "ultraviolet" ? "uv-download" : "sj-download");
  button.disabled = true;
  note(noteId, "Downloading…");
  try {
    const result = await window.pdtk.downloadRelease({ kind, id: item.id, select: true });
    const listed = await window.pdtk.listReleases();
    catalogs.ultraviolet = listed.ultraviolet.versions || catalogs.ultraviolet;
    catalogs.scramjet = listed.scramjet.versions || catalogs.scramjet;
    if (result.state) paint(result.state);
    note(noteId, "Installed. A running session needs to be started again to use it.");
  } catch (error) {
    note(noteId, error.message || String(error), true);
  } finally {
    button.disabled = false;
    syncDownload(kind);
  }
}

async function exportKind(kind, extra) {
  try {
    const result = await window.pdtk.exportLog({ kind, ...extra });
    if (result && result.canceled) return;
    note("settings-banner", result && result.path ? `Saved ${result.path}` : "Exported.");
  } catch (error) {
    note("settings-banner", error.message || String(error), true);
  }
}

function openSettings(open, section) {
  page.classList.toggle("hidden", !open);
  toggle.classList.toggle("active", open);
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  if (open && section) showSection(section);
  if (open) {
    searchIndex = collectSearchIndex();
    const searchInput = document.getElementById("settings-search");
    if (searchInput?.value) runSettingsSearch(searchInput.value);
  }
}

export function openMcpSettings() {
  openSettings(true, "mcp");
}

export function initSettings({ getNetworkLog, getWispLocation }) {
  toggle.addEventListener("click", () => openSettings(page.classList.contains("hidden")));
  document.getElementById("settings-close").addEventListener("click", () => openSettings(false));

  document.querySelectorAll(".settings-nav .nav-item").forEach((item) => {
    item.addEventListener("click", () => showSection(item.dataset.section));
  });

  searchIndex = collectSearchIndex();
  const searchInput = document.getElementById("settings-search");
  searchInput.addEventListener("input", () => runSettingsSearch(searchInput.value));
  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      searchInput.value = "";
      runSettingsSearch("");
      searchInput.blur();
    }
  });

  document.querySelectorAll(".mcp-client-btn").forEach((btn) => {
    btn.addEventListener("click", () => selectMcpClient(btn.dataset.mcpClient));
  });
  document.getElementById("mcp-custom-name").addEventListener("input", () => {
    if (activeMcpClient === "custom") refreshActiveSnippet();
  });
  document.getElementById("mcp-snippet-copy-active").addEventListener("click", async () => {
    await navigator.clipboard.writeText(document.getElementById("mcp-snippet-active").value);
    note("settings-banner", "MCP snippet copied.");
  });

  document.getElementById("about-attributions").addEventListener("click", () => showSection("attributions"));
  document.getElementById("attributions-back").addEventListener("click", () => showSection("about"));
  document.getElementById("attribution-license-back").addEventListener("click", () => {
    document.getElementById("attribution-license-panel").classList.add("hidden");
    document.getElementById("attributions-list").classList.remove("hidden");
  });

  document.getElementById("uv-version").addEventListener("change", () => {
    syncDownload("ultraviolet");
    const item = selectedVersion("ultraviolet");
    if (item && item.installed) persist("uv-version-note");
    else note("uv-version-note", "This version is not installed yet.", true);
  });
  document.getElementById("sj-version").addEventListener("change", () => {
    syncDownload("scramjet");
    const item = selectedVersion("scramjet");
    if (item && item.installed) persist("sj-version-note");
    else note("sj-version-note", "This version is not installed yet.", true);
  });
  document.getElementById("uv-download").addEventListener("click", () => download("ultraviolet"));
  document.getElementById("sj-download").addEventListener("click", () => download("scramjet"));

  for (const [inputId, noteId, field] of [
    ["uv-port", "uv-port-note", "uv"],
    ["sj-port", "sj-port-note", "sj"],
    ["wisp-port", "wisp-port-note", "wisp"],
    ["mcp-port", "mcp-port-note", "mcp"],
  ]) {
    const input = document.getElementById(inputId);
    input.addEventListener("change", async () => {
      const ok = await checkField(inputId, noteId, field);
      if (ok) persist(noteId);
    });
  }

  for (const name of [
    "wisp-host", "wisp-log", "devtools", "multi-tabs", "url-mod", "site-redirects",
    "force-https", "indexeddb", "allow-download", "mcp-enabled", "mcp-control", "screen-orientation",
  ]) {
    document.querySelectorAll(`input[name="${name}"]`).forEach((input) => {
      input.addEventListener("change", () => persist("settings-banner"));
    });
  }

  for (const id of ["ua-os", "ua-browser", "ua-custom-os", "ua-custom-browser", "screen-width", "screen-height"]) {
    document.getElementById(id).addEventListener("change", () => {
      syncUaCustom();
      note("ua-preview", `Preview: ${uaPreview()}`);
      persist("settings-banner");
    });
  }

  for (const id of ["log-all", "log-network", "log-console", "log-performance", "log-system", "log-application"]) {
    document.getElementById(id).addEventListener("change", () => {
      if (id === "log-all" && document.getElementById("log-all").checked) {
        document.getElementById("log-network").checked = true;
        document.getElementById("log-console").checked = true;
        document.getElementById("log-application").checked = true;
      }
      persist("settings-banner");
    });
  }

  document.getElementById("perm-add").addEventListener("click", () => {
    let origin = document.getElementById("perm-origin").value.trim();
    if (!origin) return;
    try {
      origin = new URL(origin.includes("://") ? origin : `https://${origin}`).origin;
    } catch {
      note("settings-banner", "Enter a valid site URL or origin.", true);
      return;
    }
    const kind = document.getElementById("perm-kind").value;
    const action = document.getElementById("perm-action").value;
    if (!sitePermissions[origin]) sitePermissions[origin] = {};
    sitePermissions[origin][kind] = action;
    renderPermissions();
    persist("settings-banner");
  });

  document.getElementById("download-location-pick").addEventListener("click", async () => {
    const folder = await window.pdtk.pickFolder();
    if (!folder) return;
    document.getElementById("download-location").value = folder;
    persist("settings-banner");
  });
  document.getElementById("log-location-pick").addEventListener("click", async () => {
    const folder = await window.pdtk.pickFolder();
    if (!folder) return;
    document.getElementById("log-location").value = folder;
    persist("settings-banner");
  });
  document.getElementById("log-location-clear").addEventListener("click", () => {
    document.getElementById("log-location").value = "";
    persist("settings-banner");
  });

  document.getElementById("mcp-token-copy").addEventListener("click", async () => {
    await navigator.clipboard.writeText(document.getElementById("mcp-token").value);
    note("settings-banner", "MCP token copied.");
  });
  document.getElementById("mcp-token-regen").addEventListener("click", async () => {
    const token = await window.pdtk.regenerateMcpToken();
    document.getElementById("mcp-token").value = token;
    await persist("settings-banner");
  });

  document.getElementById("export-browser").addEventListener("click", () => exportKind("browser"));
  document.getElementById("export-network").addEventListener("click", () => exportKind("network", { text: getNetworkLog() }));
  document.getElementById("export-proxy").addEventListener("click", () => exportKind("proxy"));
  document.getElementById("export-wisp").addEventListener("click", () => exportKind("wisp", { location: getWispLocation() }));

  return Promise.all([
    window.pdtk.getSettings().catch(() => null),
    window.pdtk.listReleases().catch((error) => ({
      ultraviolet: { versions: [], error: error.message || String(error) },
      scramjet: { versions: [], error: error.message || String(error) },
    })),
  ]).then(([state, listed]) => {
    catalogs.ultraviolet = listed.ultraviolet?.versions || [];
    catalogs.scramjet = listed.scramjet?.versions || [];
    if (state) paint(state);
    selectMcpClient("cursor");
    if (listed.ultraviolet?.error) {
      note("uv-version-note", `Could not load remote Ultraviolet releases. ${listed.ultraviolet.error}`, true);
    }
    if (listed.scramjet?.error) {
      note("sj-version-note", `Could not load remote Scramjet releases. ${listed.scramjet.error}`, true);
    }
  });
}
