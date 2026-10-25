"use strict";

const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const AdmZip = require("adm-zip");
const { downloadToFile } = require("./downloads");

const STEPS = 4;
const TAIL_LINES = 25;

function childEnv() {
  const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function run(command, args, { cwd, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: childEnv(),
      shell: process.platform === "win32",
      windowsHide: true,
    });
    const tail = [];
    const collect = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > TAIL_LINES) tail.shift();
        if (onLine) onLine(line);
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(tail);
      else reject(Object.assign(new Error(`${command} ${args.join(" ")} exited with code ${code}`), { tail }));
    });
  });
}

async function requireNpm() {
  try {
    const [version] = await run("npm", ["--version"]);
    return version;
  } catch {
    throw new Error("Compiling from source needs Node.js and npm installed and on your PATH. Install Node.js from https://nodejs.org and try again.");
  }
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

// Downloads `repo` at `ref`, installs dependencies, and runs `npm run dist`.
async function buildFromSource({ repo, ref, label, workRoot, headers, report = () => {} }) {
  const started = Date.now();
  let step = 0;
  let stage = "";
  let ticker = 0;
  const send = (extra = {}) => report({
    stage,
    step,
    steps: STEPS,
    elapsedSeconds: Math.round((Date.now() - started) / 1000),
    received: 0,
    total: null,
    percent: null,
    ...extra,
  });
  const begin = (nextStage) => {
    step += 1;
    stage = nextStage;
    send();
  };
  const startTicker = () => {
    clearInterval(ticker);
    ticker = setInterval(() => send(), 1000);
  };

  try {
    await requireNpm();
    await fs.rm(workRoot, { recursive: true, force: true });
    await fs.mkdir(workRoot, { recursive: true });

    begin("Downloading source");
    const zip = path.join(workRoot, "source.zip");
    await downloadToFile(`https://api.github.com/repos/${repo}/zipball/${encodeURIComponent(ref)}`, zip, {
      headers,
      onProgress: (data) => {
        if (!data.done && !data.error) send({ ...data });
      },
    });

    begin("Extracting source");
    const extractDir = path.join(workRoot, "source");
    new AdmZip(zip).extractAllTo(extractDir, true);
    await fs.rm(zip, { force: true });
    const [root] = (await fs.readdir(extractDir, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    if (!root) throw new Error("The source archive was empty.");
    const projectDir = path.join(extractDir, root.name);
    if (!(await exists(path.join(projectDir, "package.json")))) throw new Error("The source archive has no package.json.");

    begin("Installing dependencies");
    startTicker();
    const hasLock = await exists(path.join(projectDir, "package-lock.json"));
    await run("npm", hasLock ? ["ci", "--no-audit", "--no-fund"] : ["install", "--no-audit", "--no-fund"], {
      cwd: projectDir,
      onLine: (line) => console.log(`[source build] ${line}`),
    });

    begin("Compiling app");
    await run("npm", ["run", "dist"], {
      cwd: projectDir,
      onLine: (line) => console.log(`[source build] ${line}`),
    });
    clearInterval(ticker);

    const outputDir = path.join(projectDir, "release");
    if (!(await exists(outputDir))) throw new Error("The build finished but produced no release folder.");
    send({ done: true, percent: 100, stage: `Built ${label}` });
    return { ok: true, outputDir };
  } catch (error) {
    clearInterval(ticker);
    const detail = error.tail && error.tail.length ? `${error.message}\n${error.tail.slice(-5).join("\n")}` : error.message;
    send({ error: error.message || String(error) });
    throw Object.assign(new Error(detail || String(error)), { cause: error });
  }
}

module.exports = { buildFromSource };
