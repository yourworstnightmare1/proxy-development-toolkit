import { initDownloadProgress } from "./download-progress.mjs";

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

// Clipboard writes go through the main process: the session's permission handler
// denies clipboard access to the app origin, which proxied sites share.
async function copyText(text) {
  try {
    const result = await window.pdtk.copyText(text);
    return Boolean(result?.ok);
  } catch {
    return false;
  }
}

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

let transportCatalog = [];

function transportSelects() {
  return [...document.querySelectorAll("select[data-transport]")];
}

function selectedTransportItem(id) {
  const select = document.getElementById(`tv-${id}`);
  const entry = transportCatalog.find((item) => item.id === id);
  if (!select || !entry) return null;
  return entry.versions.find((item) => item.id === select.value) || null;
}

function syncTransportDownload(id) {
  const button = document.getElementById(`tv-${id}-download`);
  const item = selectedTransportItem(id);
  button?.classList.toggle("hidden", !item || item.installed);
}

function paintTransportVersions(settings) {
  const chosen = settings.transportVersions || {};
  for (const select of transportSelects()) {
    const id = select.dataset.transport;
    const entry = transportCatalog.find((item) => item.id === id);
    const items = entry?.versions || [{ id: "bundled", label: "Bundled", installed: true }];
    fillVersions(select, items, chosen[id] || "bundled");
    syncTransportDownload(id);
  }
}

async function refreshTransportCatalog({ force = false } = {}) {
  if (!window.pdtk.listTransportVersions) return;
  try {
    transportCatalog = await window.pdtk.listTransportVersions({ force });
  } catch (error) {
    for (const select of transportSelects()) {
      note(`tv-${select.dataset.transport}-note`, `Could not load versions from npm. ${error.message || error}`, true);
    }
    return;
  }
  paintTransportVersions(runtime?.settings || {});
  for (const entry of transportCatalog) {
    if (entry.error) note(`tv-${entry.id}-note`, `Could not load versions from npm. ${entry.error}`, true);
  }
}

async function applyTransportVersion(id) {
  const select = document.getElementById(`tv-${id}`);
  const button = document.getElementById(`tv-${id}-download`);
  const noteId = `tv-${id}-note`;
  const item = selectedTransportItem(id);
  const version = select.value;
  if (button) button.disabled = true;
  select.disabled = true;
  if (item && !item.installed) note(noteId, "Downloading…");
  try {
    const result = await window.pdtk.selectTransportVersion({ id, version });
    if (!result?.ok) {
      note(noteId, result?.error || "Could not switch versions.", true);
      if (result?.state) paint(result.state);
      return;
    }
    if (result.state) paint(result.state);
    await refreshTransportCatalog();
    const label = result.version === "bundled" ? "the bundled version" : formatVersion(result.version);
    note(noteId, `Using ${label}. A running session needs to be started again to use it.`);
  } catch (error) {
    note(noteId, error.message || String(error), true);
  } finally {
    if (button) button.disabled = false;
    select.disabled = false;
    syncTransportDownload(id);
  }
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
  if (target === "about") {
    void refreshAboutUpdateStatuses();
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

function ownIcon(node) {
  return node?.querySelector(":scope > .label-icon")?.getAttribute("src") || "";
}

function collectSearchIndex() {
  const entries = [];
  for (const [id, title] of Object.entries(SECTION_TITLES)) {
    const section = document.getElementById(`section-${id}`);
    if (!section) continue;
    const navId = id === "attributions" ? "about" : id;
    const sectionIcon = document.querySelector(`.settings-nav .nav-item[data-section="${navId}"] .nav-icon`)?.getAttribute("src") || "";
    const desc = section.querySelector(".section-desc")?.textContent?.trim() || "";
    entries.push({
      section: id,
      label: title,
      haystack: `${title} ${desc}`.toLowerCase(),
      kind: "section",
      target: section,
      icon: sectionIcon,
    });
    let headingIcon = "";
    section.querySelectorAll("h3, legend, label").forEach((node, index) => {
      if (node.tagName === "H3") headingIcon = ownIcon(node);
      if (node.matches("label:has(> input[type=radio])")) return;
      const legendIcon = ownIcon(node.closest("fieldset")?.querySelector(":scope > legend"));
      const icon = ownIcon(node) || legendIcon || headingIcon || sectionIcon;
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
        icon,
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
    button.innerHTML = `<img class="hit-icon" alt="" /><span class="hit-label"></span><span class="hit-section"></span>`;
    const icon = button.querySelector(".hit-icon");
    if (entry.icon) {
      icon.src = entry.icon;
      icon.classList.toggle("icon-tint", /\.svg(\?|$)/.test(entry.icon));
    } else {
      icon.remove();
    }
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
  const settings = runtime?.settings || {};
  radio("sj-continuous", settings.scramjetPreferContinuous);
  radio("app-prerelease", settings.appPreferPrerelease);
  radio("transport-prerelease", settings.transportPreferPrerelease);
  radio("app-compile-source", settings.appCompileFromSource);
}

function formatVersion(value) {
  const text = String(value || "").trim().replace(/^v/i, "");
  if (!text) return "v?";
  if (text === "continuous" || text === "latest") return "continuous";
  if (/^[0-9a-f]{7,40}$/i.test(text)) return text.slice(0, 7);
  return `v${text}`;
}

let updatePrompt = null;
let remindLaterKeys = new Set();
let updateDialogBound = false;

function updateRemindKey(result) {
  if (!result) return "";
  if (result.kind === "scramjet" && result.channel === "continuous") {
    return `scramjet-continuous:${result.commitId || result.latestVersion}`;
  }
  if (result.kind === "scramjet") return `scramjet-stable:${result.latestVersion}`;
  if (result.kind === "transports") return `transports:${result.latestVersion}`;
  return `app:${result.latestVersion}`;
}

const ABOUT_STATUS_IDS = {
  app: "about-app-update-status",
  scramjet: "about-sj-update-status",
  transports: "about-transport-update-status",
};

function outdatedTransports(result) {
  return (result?.items || []).filter((item) => item.updateAvailable);
}

function transportSummary(result) {
  const outdated = outdatedTransports(result);
  if (outdated.length) {
    return `Transport updates available: ${outdated.map((item) => `${item.label} ${formatVersion(item.latestVersion)}`).join(", ")}`;
  }
  const failed = (result?.items || []).filter((item) => item.error);
  const base = "All transports are up to date.";
  return failed.length ? `${base} Could not check: ${failed.map((item) => item.label).join(", ")}.` : base;
}

function setAboutStatus(kind, text, isError = false) {
  const el = document.getElementById(ABOUT_STATUS_IDS[kind] || ABOUT_STATUS_IDS.app);
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("error", Boolean(isError && text));
}

const RESTART_REMIND_MS = 30 * 60 * 1000;
let restartPending = false;
let restartWaiting = false;
let restartRemindTimer = 0;

function isDialogOpen(id) {
  return document.getElementById(id)?.classList.contains("hidden") === false;
}

async function promptRestart() {
  restartPending = true;
  clearTimeout(restartRemindTimer);
  if (restartWaiting || isDialogOpen("restart-dialog")) return;
  restartWaiting = true;
  while (isDialogOpen("update-dialog")) await waitForDialogsClosed(["update-dialog"]);
  restartWaiting = false;
  if (!restartPending) return;
  const dialog = document.getElementById("restart-dialog");
  dialog?.classList.remove("hidden");
  document.getElementById("restart-now")?.focus();
}

function bindRestartDialog() {
  const dialog = document.getElementById("restart-dialog");
  if (!dialog) return;
  const later = () => {
    dialog.classList.add("hidden");
    clearTimeout(restartRemindTimer);
    restartRemindTimer = setTimeout(() => {
      if (restartPending) void promptRestart();
    }, RESTART_REMIND_MS);
  };
  document.getElementById("restart-later")?.addEventListener("click", later);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) later();
  });
  document.getElementById("restart-now")?.addEventListener("click", async () => {
    const button = document.getElementById("restart-now");
    button.disabled = true;
    try {
      await window.pdtk.restartApp();
    } catch {
      button.disabled = false;
    }
  });
}

function closeUpdateDialog() {
  document.getElementById("update-dialog")?.classList.add("hidden");
}

function showUpdateDialog(result) {
  updatePrompt = result;
  const dialog = document.getElementById("update-dialog");
  const title = document.getElementById("update-title");
  const message = document.getElementById("update-message");
  const copyBtn = document.getElementById("update-copy-commit");
  const actionBtn = document.getElementById("update-now");
  if (!dialog || !message) return;

  if (result.kind === "scramjet" && result.channel === "continuous") {
    title.textContent = "Scramjet pre-release available";
    message.textContent = [
      "There is a new pre-release build of Scramjet available.",
      `${formatVersion(result.currentVersion)} --> ${formatVersion(result.latestVersion)}`,
      `Commit ID: ${result.commitId || "unknown"}`,
    ].join("\n");
    copyBtn?.classList.remove("hidden");
    if (actionBtn) actionBtn.textContent = "Download";
  } else if (result.kind === "scramjet") {
    title.textContent = "Scramjet update available";
    message.textContent = [
      "There is a new version of Scramjet available. It is highly recommended you download this version so you can test your site with the newest infastructure.",
      `${formatVersion(result.currentVersion)} --> ${formatVersion(result.latestVersion)}`,
    ].join("\n");
    copyBtn?.classList.add("hidden");
    if (actionBtn) actionBtn.textContent = "Download";
  } else if (result.kind === "transports") {
    const outdated = outdatedTransports(result);
    title.textContent = outdated.length === 1 ? "Transport update available" : "Transport updates available";
    const lines = outdated.map((item) =>
      `${item.label}: ${formatVersion(item.currentVersion)} --> ${formatVersion(item.latestVersion)}${item.major ? " (major update, may change APIs)" : ""}`
    );
    message.textContent = [
      "New versions of the following transports are available. Downloading them lets you test your site against the newest transport code; you can switch back to the bundled versions from Settings → About.",
      ...lines,
    ].join("\n");
    copyBtn?.classList.add("hidden");
    if (actionBtn) actionBtn.textContent = "Download";
  } else if (result.channel === "commit") {
    title.textContent = "New commit available";
    message.textContent = [
      `There is a new commit on ${result.branch || "the main branch"}. It will be downloaded and compiled from source, which can take a while and uses a lot of CPU.`,
      `${result.currentVersion} --> ${result.latestVersion}${result.commitMessage ? ` (${result.commitMessage})` : ""}`,
    ].join("\n");
    copyBtn?.classList.remove("hidden");
    if (actionBtn) actionBtn.textContent = "Compile";
  } else {
    const prerelease = result.channel === "prerelease";
    title.textContent = prerelease ? "Pre-release update available" : "Update available";
    message.textContent = [
      result.compileFromSource
        ? "A new update is available! It will be downloaded and compiled from source, which can take a while and uses a lot of CPU."
        : "A new update is available! Download now?",
      `${formatVersion(result.currentVersion)} --> ${formatVersion(result.latestVersion)}${prerelease ? " (pre-release)" : ""}`,
    ].join("\n");
    copyBtn?.classList.add("hidden");
    if (actionBtn) actionBtn.textContent = result.compileFromSource ? "Compile" : "Update";
  }

  dialog.classList.remove("hidden");
  actionBtn?.focus();
}

async function applyUpdatePrompt(result) {
  if (!result) return;
  if (result.kind === "scramjet") {
    setAboutStatus("scramjet", "Downloading Scramjet update…");
    try {
      const download = await window.pdtk.downloadRelease({
        kind: "scramjet",
        id: result.releaseId || result.tagName || result.latestVersion,
        select: true,
        commitId: result.commitId || "",
      });
      const listed = await window.pdtk.listReleases();
      catalogs.ultraviolet = listed.ultraviolet?.versions || catalogs.ultraviolet;
      catalogs.scramjet = listed.scramjet?.versions || catalogs.scramjet;
      if (download.state) paint(download.state);
      setAboutStatus(
        "scramjet",
        `Installed ${formatVersion(result.latestVersion)}. Restart the app to apply it.`
      );
      void promptRestart();
    } catch (error) {
      setAboutStatus("scramjet", error.message || String(error), true);
    }
    return;
  }
  if (result.kind === "transports") {
    const ids = outdatedTransports(result).map((item) => item.id);
    if (!ids.length) return;
    setAboutStatus("transports", "Downloading transport updates…");
    try {
      const versions = Object.fromEntries(outdatedTransports(result).map((item) => [item.id, item.latestVersion]));
      const download = await window.pdtk.downloadTransports({ ids, versions });
      if (download.state) paint(download.state);
      void refreshTransportCatalog();
      const installed = (download.installed || []).map((entry) => `${entry.id} ${formatVersion(entry.version)}`);
      const failed = (download.failed || []).map((entry) => `${entry.id} (${entry.error})`);
      const parts = [];
      if (installed.length) parts.push(`Installed ${installed.join(", ")}. Restart the app to apply them.`);
      if (failed.length) parts.push(`Failed: ${failed.join("; ")}`);
      setAboutStatus("transports", parts.join(" "), failed.length > 0);
      if (installed.length) void promptRestart();
    } catch (error) {
      setAboutStatus("transports", error.message || String(error), true);
    }
    return;
  }
  if (window.pdtk.downloadAppUpdate) {
    setAboutStatus(
      "app",
      result.compileFromSource
        ? "Compiling from source… This can take several minutes."
        : `Downloading ${formatVersion(result.latestVersion)}…`
    );
    try {
      const download = await window.pdtk.downloadAppUpdate();
      if (!download?.ok) {
        setAboutStatus("app", download?.error || "The update could not be downloaded.", true);
      } else if (download.compiled) {
        setAboutStatus("app", `Compiled ${download.label} from source and opened the output folder. Run the installer there to update.`);
      } else if (download.openedReleasePage) {
        setAboutStatus("app", "No build for this system was attached to the release, so the release page was opened in your browser.");
      } else {
        setAboutStatus("app", `Downloaded ${download.name} to your Downloads folder. Extract it and run it to update.`);
      }
    } catch (error) {
      setAboutStatus("app", error.message || String(error), true);
    }
    return;
  }
  if (result.releaseUrl) {
    try {
      await window.pdtk.openExternal(result.releaseUrl);
      setAboutStatus("app", "Opened the release page in your browser.");
    } catch (error) {
      setAboutStatus("app", error.message || String(error), true);
    }
  }
}

function bindUpdateDialog() {
  if (updateDialogBound) return;
  updateDialogBound = true;
  document.getElementById("update-later")?.addEventListener("click", () => {
    const key = updateRemindKey(updatePrompt);
    if (key) remindLaterKeys.add(key);
    closeUpdateDialog();
  });
  document.getElementById("update-now")?.addEventListener("click", async () => {
    const result = updatePrompt;
    closeUpdateDialog();
    await applyUpdatePrompt(result);
  });
  document.getElementById("update-copy-commit")?.addEventListener("click", async () => {
    const commit = updatePrompt?.commitId || "";
    if (!commit) return;
    const copied = await copyText(commit);
    setAboutStatus(updatePrompt?.kind === "app" ? "app" : "scramjet", copied ? "Commit ID copied." : "Could not copy the commit ID.");
  });
  document.getElementById("update-dialog")?.addEventListener("click", (event) => {
    if (event.target?.id === "update-dialog") {
      const key = updateRemindKey(updatePrompt);
      if (key) remindLaterKeys.add(key);
      closeUpdateDialog();
    }
  });
}

async function refreshAboutUpdateStatuses() {
  try {
    const [app, scramjet, transports] = await Promise.all([
      window.pdtk.checkForUpdates({ kind: "app", force: false }),
      window.pdtk.checkForUpdates({ kind: "scramjet", force: false }),
      window.pdtk.checkForUpdates({ kind: "transports", force: false }),
    ]);
    if (transports?.ok) setAboutStatus("transports", transportSummary(transports));
    if (app?.ok && app.updateAvailable) {
      setAboutStatus("app", `Update available: ${formatVersion(app.currentVersion)} --> ${formatVersion(app.latestVersion)}`);
    } else if (app?.ok) {
      setAboutStatus("app", app.reason === "no-releases" ? "No app releases found yet." : `App is up to date (${formatVersion(app.currentVersion)}).`);
    }
    if (scramjet?.ok && scramjet.updateAvailable) {
      setAboutStatus("scramjet", `Scramjet update available: ${formatVersion(scramjet.currentVersion)} --> ${formatVersion(scramjet.latestVersion)}`);
    } else if (scramjet?.ok) {
      setAboutStatus("scramjet", scramjet.reason === "no-releases" ? "No Scramjet releases found." : `Scramjet is up to date (${formatVersion(scramjet.currentVersion)}).`);
    }
  } catch {
    /* ignore background status refresh */
  }
}

async function runUpdateCheck({ kind = "app", source = "manual", force = false } = {}) {
  bindUpdateDialog();
  const statusKind = ABOUT_STATUS_IDS[kind] ? kind : "app";
  if (source !== "startup") setAboutStatus(statusKind, "Checking for updates…");
  try {
    const result = await window.pdtk.checkForUpdates({ kind, force });
    if (!result?.ok) {
      if (source !== "startup") setAboutStatus(statusKind, result?.error || "Could not check for updates.", true);
      return result;
    }
    if (kind === "transports") {
      setAboutStatus("transports", transportSummary(result));
      if (!result.updateAvailable) return result;
      const key = updateRemindKey(result);
      if (source === "startup" && key && remindLaterKeys.has(key)) return result;
      showUpdateDialog(result);
      return result;
    }
    if (!result.updateAvailable) {
      if (source !== "startup") {
        setAboutStatus(
          statusKind,
          result.reason === "no-releases"
            ? (kind === "scramjet" ? "No Scramjet releases found." : "No app releases found yet.")
            : `You're up to date (${formatVersion(result.currentVersion)}).`
        );
      }
      return result;
    }
    setAboutStatus(
      statusKind,
      `Update available: ${formatVersion(result.currentVersion)} --> ${formatVersion(result.latestVersion)}`
    );
    const key = updateRemindKey(result);
    if (source === "startup" && key && remindLaterKeys.has(key)) return result;
    showUpdateDialog(result);
    return result;
  } catch (error) {
    if (source !== "startup") setAboutStatus(statusKind, error.message || String(error), true);
    return { ok: false, error: error.message || String(error) };
  }
}

export async function runStartupUpdateCheck() {
  bindUpdateDialog();
  const appResult = await runUpdateCheck({ kind: "app", source: "startup", force: false });
  const [sjResult, transportResult] = await Promise.all([
    window.pdtk.checkForUpdates({ kind: "scramjet", force: false }),
    window.pdtk.checkForUpdates({ kind: "transports", force: false }),
  ]);
  if (sjResult?.ok && sjResult.updateAvailable) {
    setAboutStatus(
      "scramjet",
      `Update available: ${formatVersion(sjResult.currentVersion)} --> ${formatVersion(sjResult.latestVersion)}`
    );
  }
  if (transportResult?.ok) setAboutStatus("transports", transportSummary(transportResult));
  // One dialog at a time: each queued prompt waits for the previous one to close.
  for (const result of [sjResult, transportResult]) {
    if (!result?.ok || !result.updateAvailable) continue;
    const key = updateRemindKey(result);
    if (key && remindLaterKeys.has(key)) continue;
    await waitForDialogsClosed(["update-dialog", "restart-dialog"]);
    if (key && remindLaterKeys.has(key)) continue;
    showUpdateDialog(result);
  }
  return { app: appResult, scramjet: sjResult, transports: transportResult };
}

function waitForDialogsClosed(ids) {
  const isOpen = () => ids.some(isDialogOpen);
  if (!isOpen()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (!isOpen()) {
        clearInterval(timer);
        resolve();
      }
    }, 250);
    setTimeout(() => {
      clearInterval(timer);
      resolve();
    }, 120000);
  });
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

function maskToken(token) {
  const value = String(token || "");
  if (!value) return "";
  return "*".repeat(Math.max(8, Math.min(value.length, 48)));
}

function maskSnippetSecrets(text, token) {
  const value = String(token || "");
  if (!value) return String(text || "");
  const masked = maskToken(value);
  return String(text || "")
    .split(value)
    .join(masked);
}

let activeMcpClient = "cursor";
let mcpSnippetPlain = "";
let mcpSnippetRevealed = false;
let mcpTokenRevealed = false;

function syncMcpRevealButtons() {
  const tokenBtn = document.getElementById("mcp-token-reveal");
  const snippetBtn = document.getElementById("mcp-snippet-reveal");
  if (tokenBtn) {
    tokenBtn.textContent = mcpTokenRevealed ? "Hide" : "Show";
    tokenBtn.setAttribute("aria-pressed", mcpTokenRevealed ? "true" : "false");
  }
  if (snippetBtn) {
    snippetBtn.textContent = mcpSnippetRevealed ? "Hide token" : "Show token";
    snippetBtn.setAttribute("aria-pressed", mcpSnippetRevealed ? "true" : "false");
  }
}

function applyMcpSnippetDisplay() {
  const active = document.getElementById("mcp-snippet-active");
  if (!active) return;
  const token = runtime?.settings?.mcpToken || document.getElementById("mcp-token")?.value || "";
  active.value = mcpSnippetRevealed
    ? mcpSnippetPlain
    : maskSnippetSecrets(mcpSnippetPlain, token);
}

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
  const customWrap = document.getElementById("mcp-custom-fields");
  customWrap.classList.toggle("hidden", activeMcpClient !== "custom");
  if (activeMcpClient === "claude") {
    title.textContent = "Claude Desktop config snippet";
    mcpSnippetPlain = claude;
  } else if (activeMcpClient === "codex") {
    title.textContent = "Codex / OpenAI config snippet";
    mcpSnippetPlain = codex;
  } else if (activeMcpClient === "custom") {
    title.textContent = "Custom AI model snippet";
    mcpSnippetPlain = mcpCustomSnippet(settings, mcp, document.getElementById("mcp-custom-name").value);
  } else {
    title.textContent = "Cursor mcp.json snippet";
    mcpSnippetPlain = cursor;
  }
  applyMcpSnippetDisplay();
  syncMcpRevealButtons();
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
  document.getElementById("python-port").value = settings.pythonPort || "8000";
  document.getElementById("node-port").value = settings.nodePort || "3001";
  document.getElementById("wisp-port").value = settings.wispPort || "";
  radio("wisp-host", settings.hostWispLocally);
  radio("wisp-log", settings.logWispTraffic !== false);
  radio("devtools", settings.devtools !== false);
  radio("eruda", settings.eruda);
  paintTransportVersions(settings);
  document.getElementById("about-reset-transports")?.classList.toggle(
    "hidden",
    Object.keys(settings.transportVersions || {}).length === 0
  );

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
  radio("mcp-startup", settings.mcpLaunchOnStartup);
  document.getElementById("mcp-port").value = settings.mcpPort || "7432";
  const tokenInput = document.getElementById("mcp-token");
  tokenInput.value = settings.mcpToken || "";
  tokenInput.type = mcpTokenRevealed ? "text" : "password";
  radio("mcp-control", settings.mcpAllowControl !== false);
  const mcp = runtime.mcp || {};
  let mcpStatus = mcp.running
    ? `Running at ${mcp.url}${mcp.headless ? " (headless)" : ""}`
    : (settings.mcpEnabled || settings.mcpLaunchOnStartup
      ? "Enabled in settings, but not running yet."
      : "Stopped");
  document.getElementById("mcp-status").value = mcpStatus;
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
    pythonPort: document.getElementById("python-port").value.trim(),
    nodePort: document.getElementById("node-port").value.trim(),
    scramjetPreferContinuous: radioEnabled("sj-continuous"),
    scramjetContinuousCommit: (runtime?.settings?.scramjetContinuousCommit || ""),
    appPreferPrerelease: radioEnabled("app-prerelease"),
    transportPreferPrerelease: radioEnabled("transport-prerelease"),
    appCompileFromSource: radioEnabled("app-compile-source"),
    hostWispLocally: radioEnabled("wisp-host"),
    wispPort: document.getElementById("wisp-port").value.trim(),
    logWispTraffic: radioEnabled("wisp-log"),
    devtools: radioEnabled("devtools"),
    eruda: radioEnabled("eruda"),
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
    mcpLaunchOnStartup: radioEnabled("mcp-startup"),
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
      const message = result.error || "Could not save settings.";
      note(sourceNote || "settings-banner", message, true);
      if (sourceNote === "wisp-port-note" || /wisp|port/i.test(message)) {
        note("wisp-port-note", message, true);
      }
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
            : field === "python"
              ? "Empty falls back to the default Python port 8000."
              : field === "node"
                ? "Empty falls back to the default node.js port 3001."
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

let settingsCloseTimer = 0;

function openSettings(open, section) {
  const shouldOpen = Boolean(open);
  toggle.classList.toggle("active", shouldOpen);
  toggle.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
  page.setAttribute("aria-hidden", shouldOpen ? "false" : "true");

  if (settingsCloseTimer) {
    clearTimeout(settingsCloseTimer);
    settingsCloseTimer = 0;
  }

  if (shouldOpen) {
    page.classList.remove("hidden");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => page.classList.add("is-open"));
    });
    if (section) showSection(section);
    searchIndex = collectSearchIndex();
    const searchInput = document.getElementById("settings-search");
    if (searchInput?.value) runSettingsSearch(searchInput.value);
    return;
  }

  page.classList.remove("is-open");
  const finishClose = () => {
    if (page.classList.contains("is-open")) return;
    page.classList.add("hidden");
  };
  const onEnd = (event) => {
    if (event.target !== page || event.propertyName !== "opacity") return;
    page.removeEventListener("transitionend", onEnd);
    finishClose();
  };
  page.addEventListener("transitionend", onEnd);
  settingsCloseTimer = window.setTimeout(() => {
    page.removeEventListener("transitionend", onEnd);
    finishClose();
    settingsCloseTimer = 0;
  }, 280);
}

export function openMcpSettings() {
  openSettings(true, "mcp");
}

export function initSettings({ getNetworkLog, getWispLocation }) {
  initDownloadProgress();
  bindRestartDialog();
  toggle.addEventListener("click", () => openSettings(!page.classList.contains("is-open")));
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
    const copied = await copyText(mcpSnippetPlain || document.getElementById("mcp-snippet-active").value);
    note("settings-banner", copied ? "MCP snippet copied." : "Could not copy the MCP snippet.", !copied);
  });
  document.getElementById("mcp-snippet-reveal").addEventListener("click", () => {
    mcpSnippetRevealed = !mcpSnippetRevealed;
    applyMcpSnippetDisplay();
    syncMcpRevealButtons();
  });

  document.getElementById("about-attributions").addEventListener("click", () => showSection("attributions"));
  document.getElementById("about-github")?.addEventListener("click", () => {
    void window.pdtk.openExternal("https://github.com/yourworstnightmare1/proxy-development-toolkit");
  });
  document.getElementById("attributions-github")?.addEventListener("click", () => {
    void window.pdtk.openExternal("https://github.com/yourworstnightmare1/proxy-development-toolkit");
  });
  document.getElementById("about-check-app-updates").addEventListener("click", () => {
    void runUpdateCheck({ kind: "app", source: "manual", force: true });
  });
  document.getElementById("about-check-sj-updates").addEventListener("click", () => {
    void runUpdateCheck({ kind: "scramjet", source: "manual", force: true });
  });
  document.getElementById("about-check-transport-updates").addEventListener("click", () => {
    void runUpdateCheck({ kind: "transports", source: "manual", force: true });
  });
  document.getElementById("about-reset-transports").addEventListener("click", async () => {
    setAboutStatus("transports", "Restoring bundled transports…");
    try {
      const result = await window.pdtk.resetTransports();
      if (result?.state) paint(result.state);
      void refreshTransportCatalog();
      setAboutStatus("transports", "Using bundled transports. Start a new session to use them.");
    } catch (error) {
      setAboutStatus("transports", error.message || String(error), true);
    }
  });
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
  for (const select of transportSelects()) {
    const id = select.dataset.transport;
    select.addEventListener("change", () => {
      syncTransportDownload(id);
      const item = selectedTransportItem(id);
      if (!item || item.installed) void applyTransportVersion(id);
      else note(`tv-${id}-note`, "This version is not downloaded yet.", true);
    });
    document.getElementById(`tv-${id}-download`)?.addEventListener("click", () => void applyTransportVersion(id));
  }
  document.getElementById("uv-download").addEventListener("click", () => download("ultraviolet"));
  document.getElementById("sj-download").addEventListener("click", () => download("scramjet"));

  for (const [inputId, noteId, field] of [
    ["uv-port", "uv-port-note", "uv"],
    ["sj-port", "sj-port-note", "sj"],
    ["python-port", "python-port-note", "python"],
    ["node-port", "node-port-note", "node"],
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
    "wisp-host", "wisp-log", "devtools", "eruda", "multi-tabs", "url-mod", "site-redirects",
    "force-https", "indexeddb", "allow-download", "mcp-enabled", "mcp-startup", "mcp-control", "sj-continuous", "app-prerelease", "transport-prerelease", "app-compile-source", "screen-orientation",
  ]) {
    document.querySelectorAll(`input[name="${name}"]`).forEach((input) => {
      input.addEventListener("change", () => {
        if (name === "wisp-host" && input.value === "enabled" && input.checked) {
          const portInput = document.getElementById("wisp-port");
          if (portInput && !String(portInput.value || "").trim()) {
            portInput.value = "6001";
            note("wisp-port-note", "Using default Wisp port 6001.");
          }
        }
        persist(name === "wisp-host" ? "wisp-port-note" : "settings-banner");
        if (name === "eruda" && input.value === "enabled" && input.checked && radioEnabled("mcp-enabled")) {
          document.getElementById("eruda-mcp-dialog")?.classList.remove("hidden");
        }
      });
    });
  }

  const erudaDialog = document.getElementById("eruda-mcp-dialog");
  document.getElementById("eruda-mcp-ok")?.addEventListener("click", () => erudaDialog.classList.add("hidden"));
  document.getElementById("eruda-mcp-disable")?.addEventListener("click", async () => {
    erudaDialog.classList.add("hidden");
    while (saving) await new Promise((resolve) => setTimeout(resolve, 50));
    radio("eruda", false);
    persist("settings-banner");
  });

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

  document.getElementById("mcp-token-reveal").addEventListener("click", () => {
    mcpTokenRevealed = !mcpTokenRevealed;
    const input = document.getElementById("mcp-token");
    input.type = mcpTokenRevealed ? "text" : "password";
    syncMcpRevealButtons();
  });
  document.getElementById("mcp-token-copy").addEventListener("click", async () => {
    const copied = await copyText(document.getElementById("mcp-token").value);
    note("settings-banner", copied ? "MCP token copied." : "Could not copy the MCP token.", !copied);
  });
  document.getElementById("mcp-token-regen").addEventListener("click", async () => {
    const token = await window.pdtk.regenerateMcpToken();
    document.getElementById("mcp-token").value = token;
    mcpSnippetRevealed = false;
    await persist("settings-banner");
    applyMcpSnippetDisplay();
    syncMcpRevealButtons();
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
    void refreshTransportCatalog();
    selectMcpClient("cursor");
    if (listed.ultraviolet?.error) {
      note("uv-version-note", `Could not load remote Ultraviolet releases. ${listed.ultraviolet.error}`, true);
    }
    if (listed.scramjet?.error) {
      note("sj-version-note", `Could not load remote Scramjet releases. ${listed.scramjet.error}`, true);
    }
  });
}
