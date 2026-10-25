"use strict";

const crypto = require("crypto");
const fs = require("fs/promises");
const net = require("net");
const path = require("path");
const { spawn, execFile } = require("child_process");

const READY_TIMEOUT_MS = 120000;
const DEFAULT_PORTS = { python: 8000, node: 3001 };
const URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[::\])(?::(\d+))(?:\/[^\s]*)?/i;
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;
const MARKER = ".pdtk-deps";
const VENV_DIRS = [".venv", "venv", "env"];
const NODE_LOCKFILES = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];
const NODE_INSTALL = {
  npm: ["install", "--no-audit", "--no-fund"],
  pnpm: ["install"],
  yarn: ["install"],
  bun: ["install"],
};

let current = null;
let pythonCache = null;

function isWindows() {
  return process.platform === "win32";
}

function pythonCandidates() {
  if (process.platform === "darwin") return [["python3"]];
  if (isWindows()) return [["python"], ["py", "-3"]];
  return [["python3"], ["python"]];
}

function venvPython(venv) {
  return isWindows() ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");
}

function portAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function pickPort(preferred, fallback) {
  const start = Number(preferred) >= 1 && Number(preferred) <= 65535 ? Number(preferred) : fallback;
  for (let port = start; port < Math.min(start + 200, 65536); port += 1) {
    if (await portAvailable(port)) return { port, requested: start };
  }
  throw new Error(`No free port found starting at ${start}.`);
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (isWindows()) {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {});
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* gone */ } }
  }
}

function shellQuote(arg) {
  return /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function launch(command, args, { cwd, env = {}, onLine = () => {} }) {
  const win = isWindows();
  const child = spawn(win ? [command, ...args].map(shellQuote).join(" ") : command, win ? [] : args, {
    cwd,
    env: { ...process.env, ...env },
    shell: win,
    detached: !win,
    windowsHide: true,
  });
  const read = (chunk) => {
    for (const raw of String(chunk).split(/\r?\n/)) {
      const line = raw.replace(ANSI_PATTERN, "").trim();
      if (line) onLine(line);
    }
  };
  child.stdout.on("data", read);
  child.stderr.on("data", read);
  return child;
}

function runToEnd(command, args, options) {
  return new Promise((resolve, reject) => {
    const output = [];
    const child = launch(command, args, {
      ...options,
      onLine: (line) => {
        output.push(line);
        if (output.length > 20) output.shift();
        if (options.onLine) options.onLine(line);
      },
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${[path.basename(command), ...args].join(" ")} exited with code ${code}.${output.length ? ` ${output.slice(-3).join(" ")}` : ""}`));
    });
  });
}

async function commandWorks(command, args = ["--version"]) {
  try {
    const output = await runToEnd(command, args, { cwd: process.cwd() });
    return output.join("\n");
  } catch {
    return null;
  }
}

// Resolves once the server answers on `port` or on a localhost URL it prints.
function waitForReady(child, port, getUrlPort, label) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const poll = setInterval(async () => {
      const candidate = getUrlPort() || port;
      if (candidate && await portOpen(candidate)) finish(null, candidate);
    }, 500);
    const timer = setTimeout(() => finish(new Error(`${label} did not start listening within ${READY_TIMEOUT_MS / 1000} seconds.`)), READY_TIMEOUT_MS);
    child.once("error", (error) => finish(error));
    child.once("close", (code) => finish(new Error(`${label} exited before it was ready (code ${code}).`)));
  });
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readText(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function readPackage(folder) {
  const raw = await readText(path.join(folder, "package.json"));
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("package.json in this folder is not valid JSON.");
  }
}

async function fingerprint(folder, files) {
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update((await readText(path.join(folder, file))) || "");
  }
  return hash.digest("hex");
}

async function markerMatches(dir, value) {
  return ((await readText(path.join(dir, MARKER))) || "").trim() === value;
}

async function writeMarker(dir, value) {
  await fs.writeFile(path.join(dir, MARKER), value).catch(() => {});
}

async function detectPython(folder) {
  const files = [];
  if (await exists(path.join(folder, "requirements.txt"))) files.push("requirements.txt");
  const pyproject = await readText(path.join(folder, "pyproject.toml"));
  const installable = (pyproject && /^\s*\[(project|tool\.poetry|build-system)\]/m.test(pyproject))
    || await exists(path.join(folder, "setup.py"))
    || await exists(path.join(folder, "setup.cfg"));
  if (installable) {
    for (const file of ["pyproject.toml", "setup.py", "setup.cfg"]) {
      if (await exists(path.join(folder, file))) files.push(file);
    }
  }
  let venv = null;
  for (const name of VENV_DIRS) {
    if (await exists(path.join(folder, name, "pyvenv.cfg"))) {
      venv = name;
      break;
    }
  }
  return { files, installable: Boolean(installable), venv };
}

async function detectNode(folder) {
  const pkg = await readPackage(folder).catch(() => null);
  if (!pkg) return { hasPackage: false, hasDeps: false, manager: null, lockfile: null, hasStart: false };
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.optionalDependencies || {}) };
  let manager = null;
  let lockfile = null;
  for (const [file, name] of NODE_LOCKFILES) {
    if (await exists(path.join(folder, file))) {
      manager = name;
      lockfile = file;
      break;
    }
  }
  const declared = String(pkg.packageManager || "").split("@")[0];
  if (NODE_INSTALL[declared]) manager = declared;
  return {
    hasPackage: true,
    hasDeps: Object.keys(deps).length > 0,
    manager: manager || "npm",
    lockfile,
    hasStart: Boolean(pkg.scripts && pkg.scripts.start) || await exists(path.join(folder, "server.js")),
  };
}

async function detect(folder) {
  if (!folder) return { python: null, node: null };
  const [python, node] = await Promise.all([detectPython(folder), detectNode(folder)]);
  return { python, node };
}

async function findPython() {
  if (pythonCache) return pythonCache;
  for (const [command, ...prefix] of pythonCandidates()) {
    const output = await commandWorks(command, [...prefix, "--version"]);
    if (output && /Python 3\./.test(output)) {
      pythonCache = { command, prefix };
      return pythonCache;
    }
  }
  throw new Error("Python 3 was not found. Install Python 3 and make sure it is on your PATH.");
}

// Installs requirements.txt / pyproject dependencies into a project venv and returns its interpreter.
async function preparePython(folder, onLine, onStage) {
  const base = await findPython();
  const found = await detectPython(folder);
  if (!found.files.length) return { command: base.command, prefix: base.prefix };
  const venvDir = path.join(folder, found.venv || ".venv");
  const python = venvPython(venvDir);
  if (!found.venv || !(await exists(python))) {
    onStage("Creating a Python virtual environment (.venv)…");
    await runToEnd(base.command, [...base.prefix, "-m", "venv", venvDir], { cwd: folder, onLine });
  }
  const stamp = await fingerprint(folder, found.files);
  if (!(await markerMatches(venvDir, stamp))) {
    const label = found.files.includes("requirements.txt") ? "requirements.txt" : found.files[0];
    onStage(`Installing Python dependencies from ${label}…`);
    const pipEnv = { PIP_DISABLE_PIP_VERSION_CHECK: "1", PYTHONUNBUFFERED: "1" };
    if (found.files.includes("requirements.txt")) {
      await runToEnd(python, ["-m", "pip", "install", "-r", "requirements.txt"], { cwd: folder, env: pipEnv, onLine });
    }
    if (found.installable) {
      await runToEnd(python, ["-m", "pip", "install", "."], { cwd: folder, env: pipEnv, onLine });
    }
    await writeMarker(venvDir, stamp);
  }
  return { command: python, prefix: [] };
}

async function startPython(folder, preferredPort, onLine, onStage) {
  const runner = await preparePython(folder, onLine, onStage);
  const { port, requested } = await pickPort(preferredPort, DEFAULT_PORTS.python);
  if (port !== requested) onStage(`Port ${requested} is busy, using ${port} instead…`);
  onStage("Starting Python's http.server…");
  const args = [...runner.prefix, "-m", "http.server", String(port)];
  const child = launch(runner.command, args, { cwd: folder, env: { PYTHONUNBUFFERED: "1" }, onLine });
  try {
    const ready = await waitForReady(child, port, () => 0, "Python's http.server");
    const shown = path.isAbsolute(runner.command) ? path.relative(folder, runner.command) : runner.command;
    return { child, port: ready, command: [shown, ...args].join(" ") };
  } catch (error) {
    killTree(child);
    throw error;
  }
}

async function resolveManager(wanted, onStage) {
  if (wanted === "npm" || await commandWorks(wanted)) return wanted;
  if (await commandWorks("corepack", [wanted, "--version"])) return `corepack ${wanted}`;
  onStage(`${wanted} is not installed, falling back to npm…`);
  return "npm";
}

async function prepareNode(folder, info, onLine, onStage) {
  const manager = info.hasDeps ? await resolveManager(info.manager, onStage) : "npm";
  if (!info.hasDeps) return manager;
  const modules = path.join(folder, "node_modules");
  const stamp = await fingerprint(folder, ["package.json", info.lockfile].filter(Boolean));
  const hasModules = await exists(modules);
  if (hasModules && !(await exists(path.join(modules, MARKER)))) {
    await writeMarker(modules, stamp);
    return manager;
  }
  if (!hasModules || !(await markerMatches(modules, stamp))) {
    const [command, ...pre] = manager.split(" ");
    const name = pre[0] || command;
    onStage(`Installing Node dependencies (${name} install)…`);
    await runToEnd(command, [...pre, ...NODE_INSTALL[name]], { cwd: folder, env: { FORCE_COLOR: "0" }, onLine });
    await fs.mkdir(modules, { recursive: true }).catch(() => {});
    await writeMarker(modules, stamp);
  }
  return manager;
}

async function startNode(folder, preferredPort, onLine, onStage) {
  const info = await detectNode(folder);
  if (!info.hasPackage) throw new Error("This folder has no package.json, so npm start can't run here.");
  if (!info.hasStart) throw new Error("package.json has no \"start\" script (and there is no server.js for npm's default).");
  const manager = await prepareNode(folder, info, onLine, onStage);
  const [command, ...pre] = manager.split(" ");
  const args = [...pre, "start"];
  const { port, requested } = await pickPort(preferredPort, DEFAULT_PORTS.node);
  if (port !== requested) onStage(`Port ${requested} is busy, using ${port} instead…`);
  onStage(`Running ${[command, ...args].join(" ")}…`);
  let urlPort = 0;
  const child = launch(command, args, {
    cwd: folder,
    env: { PORT: String(port), BROWSER: "none", FORCE_COLOR: "0" },
    onLine: (line) => {
      const match = line.match(URL_PATTERN);
      if (match && !urlPort) urlPort = Number(match[1]);
      onLine(line);
    },
  });
  try {
    const ready = await waitForReady(child, port, () => urlPort, `${command} start`);
    return { child, port: ready, command: [command, ...args].join(" ") };
  } catch (error) {
    killTree(child);
    throw error;
  }
}

async function start({ runtime, folder, port, onLine = () => {}, onStage = () => {} }) {
  if (!folder) throw new Error("Choose a site folder first.");
  const stat = await fs.stat(folder).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new Error("The selected site folder no longer exists.");
  stop();
  const label = runtime === "node" ? "node" : "python";
  const log = (line) => {
    console.log(`[${label} server] ${line}`);
    onLine(line);
  };
  const result = label === "node"
    ? await startNode(folder, port, log, onStage)
    : await startPython(folder, port, log, onStage);
  current = { ...result, runtime: label, folder };
  result.child.once("close", () => {
    if (current && current.child === result.child) current = null;
  });
  return { ok: true, runtime: label, port: result.port, url: `http://localhost:${result.port}/`, command: result.command };
}

function stop() {
  if (!current) return false;
  killTree(current.child);
  current = null;
  return true;
}

function status() {
  return current ? { running: true, runtime: current.runtime, port: current.port, folder: current.folder } : { running: false };
}

module.exports = { start, stop, status, detect, DEFAULT_PORTS };
