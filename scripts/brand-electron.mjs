// Rebrands the development electron.exe so Task Manager shows the app name and icon during `npm start`.
// Packaged builds are branded by electron-builder and do not need this.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") process.exit(0);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const productName = pkg.productName || pkg.name;
const distDir = path.join(root, "node_modules", "electron", "dist");
const exe = path.join(distDir, "electron.exe");
const icon = path.join(root, "build", "icon.ico");
const marker = path.join(distDir, ".pdtk-branded");

let electronVersion;
try {
  electronVersion = JSON.parse(await fs.readFile(path.join(root, "node_modules", "electron", "package.json"), "utf8")).version;
  await fs.access(exe);
} catch {
  process.exit(0);
}

const iconHash = createHash("sha256").update(await fs.readFile(icon)).digest("hex");
const stamp = JSON.stringify({ electronVersion, productName, iconHash });
const current = await fs.readFile(marker, "utf8").catch(() => "");
if (current === stamp) process.exit(0);

const { rcedit } = await import("rcedit");
const staged = path.join(distDir, "electron.branding.exe");
try {
  await fs.copyFile(exe, staged);
  await rcedit(staged, {
    icon,
    "version-string": {
      FileDescription: productName,
      ProductName: productName,
      CompanyName: productName,
      InternalName: productName,
      OriginalFilename: "electron.exe",
    },
  });
  await fs.rename(staged, exe);
} catch (error) {
  await fs.rm(staged, { force: true });
  if (error.code === "EBUSY" || error.code === "EPERM") {
    console.warn(`[brand-electron] electron.exe is in use. Close ${productName} and run "npm run brand" to show its name and icon in Task Manager.`);
    process.exit(0);
  }
  throw error;
}

await fs.writeFile(marker, stamp);
console.log(`[brand-electron] electron.exe now shows as "${productName}" with the app icon.`);
