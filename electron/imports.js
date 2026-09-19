"use strict";

const { spawn } = require("child_process");
const fs = require("fs/promises");
const path = require("path");
const { randomBytes } = require("crypto");
const AdmZip = require("adm-zip");

const MAX_FILES = 80;
const MAX_BYTES = 25 * 1024 * 1024;

function newId() {
  return randomBytes(6).toString("hex");
}

function isGitUrl(value) {
  const raw = String(value || "").trim();
  if (/^(git@|ssh:\/\/|git:\/\/)/i.test(raw)) return true;
  if (/\.git$/i.test(raw)) return true;
  try {
    const url = new URL(raw);
    if (!/^https?:$/i.test(url.protocol)) return false;
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.length === 2 && !path.extname(parts[1]);
  } catch {
    return false;
  }
}

async function gitAvailable() {
  return new Promise((resolve) => {
    const child = spawn("git", ["--version"], { windowsHide: true });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

function cloneGit(url, dest, branch) {
  const name = String(branch || "").trim();
  if (name && (name.startsWith("-") || name.includes("..") || !/^[A-Za-z0-9._/-]+$/.test(name))) {
    return Promise.reject(new Error("Branch name is not valid."));
  }
  const args = ["clone", "--depth", "1"];
  if (name) args.push("--branch", name);
  args.push(url, dest);
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      windowsHide: true,
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        reject(new Error("Git is not installed or not on PATH."));
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(output.trim() || `git clone exited ${code}`));
    });
  });
}

async function copyFolder(source, dest) {
  await fs.cp(source, dest, { recursive: true, errorOnExist: false });
}

function assetHref(baseUrl, value) {
  if (!value || value.startsWith("data:") || value.startsWith("blob:") || value.startsWith("#")) {
    return null;
  }
  try {
    return new URL(value, baseUrl);
  } catch {
    return null;
  }
}

function collectRefs(html, pageUrl) {
  const refs = new Set();
  const attr = /\b(?:src|href)=["']([^"']+)["']/gi;
  let match;
  while ((match = attr.exec(html))) {
    const next = assetHref(pageUrl, match[1]);
    if (next && next.origin === pageUrl.origin) refs.add(next.href);
  }
  return [...refs];
}

async function downloadUrl(pageUrl, dest) {
  await fs.mkdir(dest, { recursive: true });
  const first = await fetch(pageUrl, { redirect: "follow" });
  if (!first.ok) throw new Error(`Download failed (${first.status}) for ${pageUrl}`);
  const type = first.headers.get("content-type") || "";
  const buffer = Buffer.from(await first.arrayBuffer());
  if (buffer.length > MAX_BYTES) throw new Error("Download is larger than 25 MB.");

  const pathname = new URL(first.url).pathname;
  if (type.includes("zip") || pathname.endsWith(".zip")) {
    const zip = new AdmZip(buffer);
    zip.extractAllTo(dest, true);
    return;
  }

  const filename = path.basename(pathname) || "index.html";
  const rootName = type.includes("html") || !path.extname(filename) ? "index.html" : filename;
  await fs.writeFile(path.join(dest, rootName), buffer);
  if (!type.includes("html") && rootName !== "index.html") return;

  const queue = collectRefs(buffer.toString("utf8"), new URL(first.url));
  const seen = new Set([first.url]);
  let total = buffer.length;
  let count = 1;
  while (queue.length && count < MAX_FILES) {
    const next = queue.shift();
    if (seen.has(next)) continue;
    seen.add(next);
    const response = await fetch(next, { redirect: "follow" });
    if (!response.ok) continue;
    const bytes = Buffer.from(await response.arrayBuffer());
    total += bytes.length;
    if (total > MAX_BYTES) throw new Error("Downloaded assets exceeded 25 MB.");
    const url = new URL(response.url);
    if (url.origin !== new URL(first.url).origin) continue;
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    const filePath = path.join(dest, rel);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, bytes);
    count += 1;
    const nextType = response.headers.get("content-type") || "";
    if (nextType.includes("html") || nextType.includes("javascript") || nextType.includes("css")) {
      for (const child of collectRefs(bytes.toString("utf8"), url)) {
        if (!seen.has(child)) queue.push(child);
      }
    }
  }
}

async function walkFiles(dir, depth, acc) {
  if (depth < 0) return;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(full, depth - 1, acc);
    else acc.push(full);
  }
}

async function detectProxy(root) {
  const files = [];
  await walkFiles(root, 4, files);
  const rel = files.map((file) => path.relative(root, file).replace(/\\/g, "/"));
  const find = (pattern) => rel.find((file) => pattern.test(file));
  const scramjet = find(/(^|\/)scramjet(\.all)?\.js$/i) || find(/(^|\/)scramjet\.mjs$/i);
  if (scramjet) {
    return {
      kind: "scramjet",
      scramjetJs: scramjet,
      wasm: find(/scramjet\.wasm$/i) || "",
      controllerSw: find(/controller\.sw\.js$/i) || "",
      controllerApi: find(/controller\.api\.js$/i) || "",
      controllerInject: find(/controller\.inject\.js$/i) || "",
    };
  }
  const uv = find(/(^|\/)uv\.bundle\.js$/i);
  if (uv) {
    return {
      kind: "ultraviolet",
      bundle: uv,
      handler: find(/uv\.handler\.js$/i) || "",
      client: find(/uv\.client\.js$/i) || "",
      sw: find(/(^|\/)uv\.sw\.js$/i) || "",
    };
  }
  const index = find(/^index\.html$/i) || find(/(^|\/)index\.html$/i);
  return { kind: "opaque", index: index || "" };
}

module.exports = {
  newId,
  isGitUrl,
  gitAvailable,
  cloneGit,
  copyFolder,
  downloadUrl,
  detectProxy,
};
