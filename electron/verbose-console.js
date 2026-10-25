"use strict";

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const consoles = new Map();

function logPath(kind) {
  return path.join(os.tmpdir(), `pdtk-${kind}-verbose.log`);
}

function pidPath(kind) {
  return `${logPath(kind)}.pid`;
}

function scriptPath(kind) {
  return `${logPath(kind)}.ps1`;
}

function readPid(kind) {
  try {
    const raw = fs.readFileSync(pidPath(kind), "utf8").trim();
    const pid = Number(raw);
    return Number.isFinite(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

function writePid(kind, pid) {
  try {
    fs.writeFileSync(pidPath(kind), String(pid), "utf8");
  } catch { /* ignore */ }
}

function clearPid(kind) {
  try { fs.unlinkSync(pidPath(kind)); } catch { /* ignore */ }
}

function killPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    } else {
      try { process.kill(pid, "SIGINT"); } catch {
        try { process.kill(pid, "SIGTERM"); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

function psSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function startConsole(kind, { title, minimized = false } = {}) {
  stopConsole(kind, { sigint: true });
  const file = logPath(kind);
  const label = String(title || kind).replace(/[\r\n']/g, "");
  fs.writeFileSync(file, `=== ${label} verbose log ===\n`, "utf8");
  let trackedPid = 0;
  try {
    if (process.platform === "win32") {
      const script = scriptPath(kind);
      fs.writeFileSync(
        script,
        [
          `$Host.UI.RawUI.WindowTitle = ${psSingleQuote(label)}`,
          `Get-Content -LiteralPath ${psSingleQuote(file)} -Wait`,
          "",
        ].join("\r\n"),
        "utf8"
      );
      const launcher = [
        "$ErrorActionPreference = 'Stop'",
        `$p = Start-Process -FilePath powershell.exe -PassThru -WindowStyle ${minimized ? "Minimized" : "Normal"} -ArgumentList '-NoExit','-NoProfile','-ExecutionPolicy','Bypass','-File',${psSingleQuote(script)}`,
        `Set-Content -LiteralPath ${psSingleQuote(pidPath(kind))} -Value $p.Id -Encoding ascii`,
        "Write-Output $p.Id",
      ].join("; ");
      const result = spawnSync("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-WindowStyle", "Hidden",
        "-Command", launcher,
      ], {
        windowsHide: true,
        encoding: "utf8",
        timeout: 8000,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        const detail = String(result.stderr || result.stdout || "").trim();
        throw new Error(detail || `Verbose console launcher exited with code ${result.status}`);
      }
      trackedPid = Number(String(result.stdout || "").trim()) || readPid(kind);
    } else if (process.platform === "darwin") {
      const script = `tell application "Terminal" to do script "printf '\\\\e]0;${label}\\\\a'; tail -f '${file.replace(/'/g, "'\\''")}'"`;
      const child = spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" });
      child.unref();
      trackedPid = child.pid || 0;
    } else {
      const child = spawn("x-terminal-emulator", ["-T", label, "-e", "bash", "-lc", `tail -f '${file.replace(/'/g, "'\\''")}'`], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      trackedPid = child.pid || 0;
    }
  } catch (error) {
    console.error(`Verbose console (${kind}) failed:`, error);
    return { ok: false, error: error.message || String(error), file };
  }
  if (trackedPid) writePid(kind, trackedPid);
  consoles.set(kind, { file, title: label, pid: trackedPid });
  return { ok: true, file, pid: trackedPid };
}

function writeConsole(kind, line) {
  const entry = consoles.get(kind);
  if (!entry) return;
  try {
    fs.appendFileSync(entry.file, `${String(line)}\n`, "utf8");
  } catch { /* ignore */ }
}

function stopConsole(kind, { sigint = true } = {}) {
  const entry = consoles.get(kind);
  const pid = (entry && entry.pid) || readPid(kind);
  if (entry) consoles.delete(kind);
  clearPid(kind);
  if (sigint && pid) killPid(pid);
  return { ok: true };
}

function stopAll({ sigint = true } = {}) {
  const kinds = new Set([...consoles.keys(), "wisp", "proxy", "transport"]);
  for (const kind of kinds) stopConsole(kind, { sigint });
}

module.exports = {
  startConsole,
  writeConsole,
  stopConsole,
  stopAll,
  logPath,
};
