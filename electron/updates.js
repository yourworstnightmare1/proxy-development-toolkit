"use strict";

const path = require("path");
const buildInfo = require("./build-info");
const { TRANSPORT_PACKAGES, bundledVersion } = require("./transports");

const APP_REPO = "yourworstnightmare1/proxy-development-toolkit";
const SJ_REPO = "MercuryWorkshop/scramjet";
const BUNDLED_SJ = "v2.0.67-alpha.2";
const CACHE_MS = 5 * 60 * 1000;

const cache = {
  app: { at: 0, result: null },
  scramjet: { at: 0, result: null },
  transports: { at: 0, result: null },
};

function githubHeaders() {
  return {
    "User-Agent": "proxy-development-toolkit",
    Accept: "application/vnd.github+json",
  };
}

function normalizeVersion(value) {
  return String(value || "").trim().replace(/^v/i, "");
}

function compareVersions(a, b) {
  const left = normalizeVersion(a).split(/[.+-]/).map((part) => {
    const n = Number(part);
    return Number.isFinite(n) ? n : 0;
  });
  const right = normalizeVersion(b).split(/[.+-]/).map((part) => {
    const n = Number(part);
    return Number.isFinite(n) ? n : 0;
  });
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const x = left[i] || 0;
    const y = right[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

function currentAppVersion() {
  return normalizeVersion(buildInfo.collect().version || require(path.join(__dirname, "..", "package.json")).version);
}

function currentScramjetDisplay(settings = {}) {
  const id = String(settings.scramjetVersion || "bundled");
  if (id === "bundled") return normalizeVersion(BUNDLED_SJ);
  if (id === "continuous" || id === "latest") {
    const commit = String(settings.scramjetContinuousCommit || "").trim();
    return commit ? commit.slice(0, 7) : "continuous";
  }
  return normalizeVersion(id);
}

function extractCommitId(release) {
  const body = String(release?.body || "");
  const match = body.match(/github\.com\/[^/\s]+\/[^/\s]+\/commit\/([a-f0-9]{7,40})/i);
  if (match) return match[1];
  const target = String(release?.target_commitish || "").trim();
  if (/^[a-f0-9]{7,40}$/i.test(target)) return target;
  return "";
}

function isContinuousRelease(release) {
  const tag = String(release?.tag_name || "");
  const name = String(release?.name || "");
  return tag === "latest" || /continuous/i.test(tag) || /continuous/i.test(name);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: githubHeaders(),
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 404) return { ok: false, status: 404, json: null };
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
  return { ok: true, status: response.status, json: await response.json() };
}

// Semver-ish ordering: a pre-release (x.y.z-tag) sorts below its x.y.z release.
function compareSemver(a, b) {
  const left = normalizeVersion(a);
  const right = normalizeVersion(b);
  const core = compareVersions(left.split("-")[0], right.split("-")[0]);
  if (core) return core;
  const preLeft = left.includes("-");
  const preRight = right.includes("-");
  if (preLeft !== preRight) return preLeft ? -1 : 1;
  return compareVersions(left, right);
}

async function fetchAppRelease(prerelease) {
  if (!prerelease) {
    const { ok, json } = await fetchJson(`https://api.github.com/repos/${APP_REPO}/releases/latest`);
    return ok && json && !json.draft ? json : null;
  }
  const { ok, json } = await fetchJson(`https://api.github.com/repos/${APP_REPO}/releases?per_page=30`);
  if (!ok || !Array.isArray(json)) return null;
  const candidates = json.filter((item) => item && !item.draft && normalizeVersion(item.tag_name || item.name));
  candidates.sort((a, b) => compareSemver(b.tag_name || b.name, a.tag_name || a.name));
  return candidates[0] || null;
}

// Pre-release + compile-from-source tracks the newest commit on the default branch.
async function fetchAppHeadCommit() {
  const repo = await fetchJson(`https://api.github.com/repos/${APP_REPO}`);
  const branch = (repo.ok && repo.json && repo.json.default_branch) || "main";
  const { ok, json } = await fetchJson(`https://api.github.com/repos/${APP_REPO}/commits/${encodeURIComponent(branch)}`);
  if (!ok || !json || !json.sha) return null;
  return {
    sha: String(json.sha),
    branch,
    message: String((json.commit && json.commit.message) || "").split("\n")[0],
    url: json.html_url || `https://github.com/${APP_REPO}/commit/${json.sha}`,
  };
}

async function fetchAppLatest(settings = {}) {
  const prerelease = Boolean(settings.appPreferPrerelease);
  const fromSource = Boolean(settings.appCompileFromSource);
  const current = currentAppVersion();
  if (prerelease && fromSource) {
    const head = await fetchAppHeadCommit();
    if (!head) return { ok: true, kind: "app", updateAvailable: false, reason: "no-releases", currentVersion: current };
    const currentCommit = String(buildInfo.collect().commit || "");
    const known = /^[0-9a-f]{7,40}$/i.test(currentCommit);
    return {
      ok: true,
      kind: "app",
      channel: "commit",
      compileFromSource: true,
      updateAvailable: !known || (!head.sha.startsWith(currentCommit) && !currentCommit.startsWith(head.sha)),
      currentVersion: known ? currentCommit.slice(0, 7) : current,
      latestVersion: head.sha.slice(0, 7),
      commitId: head.sha,
      commitMessage: head.message,
      branch: head.branch,
      sourceRef: head.sha,
      releaseUrl: head.url,
    };
  }
  const release = await fetchAppRelease(prerelease);
  if (!release) {
    return { ok: true, updateAvailable: false, reason: "no-releases", currentVersion: current };
  }
  const latestVersion = normalizeVersion(release.tag_name || release.name);
  if (!latestVersion) {
    return { ok: true, updateAvailable: false, reason: "no-releases", currentVersion: current };
  }
  return {
    ok: true,
    kind: "app",
    channel: release.prerelease ? "prerelease" : "stable",
    compileFromSource: fromSource,
    sourceRef: release.tag_name || `v${latestVersion}`,
    updateAvailable: compareSemver(latestVersion, current) > 0,
    currentVersion: current,
    latestVersion,
    releaseUrl: release.html_url || `https://github.com/${APP_REPO}/releases/tag/v${latestVersion}`,
    tagName: release.tag_name || `v${latestVersion}`,
    assets: (Array.isArray(release.assets) ? release.assets : [])
      .filter((asset) => asset && asset.name && /^https:\/\/github\.com\//.test(String(asset.browser_download_url || "")))
      .map((asset) => ({ name: String(asset.name), size: Number(asset.size) || 0, url: asset.browser_download_url })),
  };
}

// Picks the release asset built for this OS/arch (and installer vs portable on Windows).
function pickAppAsset(assets, { platform = process.platform, arch = process.arch, portable = Boolean(process.env.PORTABLE_EXECUTABLE_DIR) } = {}) {
  const list = Array.isArray(assets) ? assets : [];
  const named = (test) => list.filter((asset) => test(asset.name.toLowerCase()));
  let matches = [];
  if (platform === "win32") {
    matches = named((name) => /win/.test(name));
    const flavor = matches.filter((asset) => asset.name.toLowerCase().includes(portable ? "portable" : "installer"));
    if (flavor.length) matches = flavor;
  } else if (platform === "darwin") {
    matches = named((name) => /mac|darwin|osx/.test(name));
  } else {
    matches = named((name) => /linux|appimage|\.deb$/.test(name));
  }
  const archMatch = matches.filter((asset) => {
    const name = asset.name.toLowerCase();
    if (arch === "arm64") return name.includes("arm64");
    return !name.includes("arm64");
  });
  return archMatch[0] || null;
}

async function fetchScramjetReleases() {
  const all = [];
  for (let page = 1; page <= 3; page += 1) {
    const { ok, json: batch } = await fetchJson(
      `https://api.github.com/repos/${SJ_REPO}/releases?per_page=30&page=${page}`
    );
    if (!ok || !Array.isArray(batch)) break;
    all.push(...batch.filter((item) => item && !item.draft));
    if (batch.length < 30) break;
  }
  return all;
}

async function fetchScramjetUpdate(settings = {}) {
  const preferContinuous = Boolean(settings.scramjetPreferContinuous);
  const releases = await fetchScramjetReleases();
  if (!releases.length) {
    return {
      ok: true,
      kind: "scramjet",
      updateAvailable: false,
      reason: "no-releases",
      currentVersion: currentScramjetDisplay(settings),
    };
  }

  if (preferContinuous) {
    const continuous = releases.find((item) => isContinuousRelease(item));
    if (!continuous) {
      return {
        ok: true,
        kind: "scramjet",
        channel: "continuous",
        updateAvailable: false,
        reason: "no-releases",
        currentVersion: currentScramjetDisplay(settings),
      };
    }
    const commitId = extractCommitId(continuous);
    const known = String(settings.scramjetContinuousCommit || "").trim();
    const selected = String(settings.scramjetVersion || "bundled");
    const onContinuous = selected === "continuous" || selected === "latest";
    const updateAvailable = Boolean(commitId) && (!onContinuous || !known || known !== commitId);
    return {
      ok: true,
      kind: "scramjet",
      channel: "continuous",
      updateAvailable,
      currentVersion: currentScramjetDisplay(settings),
      latestVersion: commitId ? commitId.slice(0, 7) : "continuous",
      commitId,
      releaseId: "continuous",
      tagName: continuous.tag_name || "latest",
      releaseUrl: continuous.html_url || `https://github.com/${SJ_REPO}/releases/tag/latest`,
      publishedAt: continuous.published_at || "",
    };
  }

  const stable = releases.find((item) => !isContinuousRelease(item));
  if (!stable) {
    return {
      ok: true,
      kind: "scramjet",
      channel: "stable",
      updateAvailable: false,
      reason: "no-releases",
      currentVersion: currentScramjetDisplay(settings),
    };
  }
  const latestVersion = normalizeVersion(stable.tag_name || stable.name);
  const selected = String(settings.scramjetVersion || "bundled");
  const currentRaw = selected === "bundled"
    ? BUNDLED_SJ
    : (selected === "continuous" || selected === "latest" ? "0.0.0" : selected);
  const currentDisplay = currentScramjetDisplay(settings);
  const alreadySelected = normalizeVersion(selected) === latestVersion
    || normalizeVersion(selected === "bundled" ? BUNDLED_SJ : selected) === latestVersion;
  const updateAvailable = Boolean(latestVersion)
    && !alreadySelected
    && (selected === "continuous" || selected === "latest" || compareVersions(latestVersion, currentRaw) > 0);

  return {
    ok: true,
    kind: "scramjet",
    channel: "stable",
    updateAvailable,
    currentVersion: currentDisplay,
    latestVersion,
    releaseId: stable.tag_name,
    tagName: stable.tag_name,
    releaseUrl: stable.html_url || `https://github.com/${SJ_REPO}/releases/tag/${stable.tag_name}`,
    publishedAt: stable.published_at || "",
  };
}

async function checkForUpdate(settings = {}, { force = false } = {}) {
  const now = Date.now();
  const key = `${Boolean(settings.appPreferPrerelease)}:${Boolean(settings.appCompileFromSource)}`;
  if (!force && cache.app.result && cache.app.key === key && now - cache.app.at < CACHE_MS) {
    return { ...cache.app.result, cached: true };
  }
  try {
    const result = await fetchAppLatest(settings);
    cache.app = { at: now, key, result };
    return { ...result, cached: false };
  } catch (error) {
    return {
      ok: false,
      kind: "app",
      updateAvailable: false,
      currentVersion: currentAppVersion(),
      error: error.message || String(error),
    };
  }
}

async function checkScramjetUpdate(settings = {}, { force = false } = {}) {
  const channel = settings.scramjetPreferContinuous ? "continuous" : "stable";
  const now = Date.now();
  if (
    !force
    && cache.scramjet.result
    && cache.scramjet.result.channel === channel
    && now - cache.scramjet.at < CACHE_MS
  ) {
    return { ...cache.scramjet.result, cached: true };
  }
  try {
    const result = await fetchScramjetUpdate(settings);
    cache.scramjet = { at: now, result };
    return { ...result, cached: false };
  } catch (error) {
    return {
      ok: false,
      kind: "scramjet",
      channel,
      updateAvailable: false,
      currentVersion: currentScramjetDisplay(settings),
      error: error.message || String(error),
    };
  }
}

async function fetchNpmLatest(pkg, { prerelease = false } = {}) {
  const response = await fetch(`https://registry.npmjs.org/${pkg}`, {
    headers: { Accept: "application/vnd.npm.install-v1+json", "User-Agent": "proxy-development-toolkit" },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`npm returned ${response.status} for ${pkg}`);
  const doc = await response.json();
  const stable = normalizeVersion(doc["dist-tags"] && doc["dist-tags"].latest);
  if (!prerelease) return stable;
  const newest = Object.entries(doc.versions || {})
    .filter(([, meta]) => !(meta && meta.deprecated))
    .map(([version]) => version)
    .sort((a, b) => compareSemver(b, a))[0];
  return newest && (!stable || compareSemver(newest, stable) > 0) ? newest : stable;
}

function majorOf(version) {
  return Number(normalizeVersion(version).split(".")[0]) || 0;
}

async function fetchTransportUpdates(settings = {}) {
  const installed = settings.transportVersions || {};
  const items = await Promise.all(TRANSPORT_PACKAGES.map(async (item) => {
    const bundled = bundledVersion(item);
    const currentVersion = installed[item.id] || bundled;
    try {
      const latestVersion = await fetchNpmLatest(item.pkg, { prerelease: Boolean(settings.transportPreferPrerelease) });
      const updateAvailable = Boolean(latestVersion) && compareSemver(latestVersion, currentVersion) > 0;
      return {
        id: item.id,
        label: item.label,
        pkg: item.pkg,
        bundledVersion: bundled,
        currentVersion,
        downloaded: Boolean(installed[item.id]),
        latestVersion,
        updateAvailable,
        major: updateAvailable && majorOf(latestVersion) > majorOf(currentVersion),
      };
    } catch (error) {
      return {
        id: item.id,
        label: item.label,
        pkg: item.pkg,
        bundledVersion: bundled,
        currentVersion,
        downloaded: Boolean(installed[item.id]),
        updateAvailable: false,
        error: error.message || String(error),
      };
    }
  }));
  if (items.every((item) => item.error)) throw new Error(items[0].error);
  const outdated = items.filter((item) => item.updateAvailable);
  return {
    ok: true,
    kind: "transports",
    updateAvailable: outdated.length > 0,
    items,
    outdated: outdated.map((item) => item.id),
    latestVersion: outdated.map((item) => `${item.id}@${item.latestVersion}`).join(","),
  };
}

async function checkTransportUpdates(settings = {}, { force = false } = {}) {
  const now = Date.now();
  const key = JSON.stringify([settings.transportVersions || {}, Boolean(settings.transportPreferPrerelease)]);
  if (!force && cache.transports.result && cache.transports.key === key && now - cache.transports.at < CACHE_MS) {
    return { ...cache.transports.result, cached: true };
  }
  try {
    const result = await fetchTransportUpdates(settings);
    cache.transports = { at: now, key, result };
    return { ...result, cached: false };
  } catch (error) {
    return { ok: false, kind: "transports", updateAvailable: false, items: [], error: error.message || String(error) };
  }
}

async function checkAllUpdates(settings = {}, { force = false } = {}) {
  const [app, scramjet, transports] = await Promise.all([
    checkForUpdate(settings, { force }),
    checkScramjetUpdate(settings, { force }),
    checkTransportUpdates(settings, { force }),
  ]);
  return { ok: true, app, scramjet, transports };
}

module.exports = {
  APP_REPO,
  SJ_REPO,
  BUNDLED_SJ,
  checkForUpdate,
  pickAppAsset,
  githubHeaders,
  checkScramjetUpdate,
  checkTransportUpdates,
  checkAllUpdates,
  currentAppVersion,
  currentScramjetDisplay,
  compareVersions,
  compareSemver,
  normalizeVersion,
  extractCommitId,
};
