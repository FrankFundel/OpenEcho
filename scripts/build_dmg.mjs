import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_JSON_PATH = path.join(ROOT, "package.json");
const TAURI_RUNNER = path.join(ROOT, "scripts", "run-tauri.mjs");
const APP_BUNDLE_PATH = path.join(
  ROOT,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "macos",
  "OpenEcho.app"
);
const DMG_DIR_PATH = path.join(
  ROOT,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "dmg"
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

function archLabel() {
  if (process.arch === "arm64") {
    return "aarch64";
  }

  if (process.arch === "x64") {
    return "x64";
  }

  return process.arch;
}

function main() {
  const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
  const version = packageJson.version;
  const dmgName = `OpenEcho_${version}_${archLabel()}.dmg`;
  const dmgPath = path.join(DMG_DIR_PATH, dmgName);
  const stagingPath = path.join(tmpdir(), `openecho-dmg-${process.pid}`);

  run("node", [
    TAURI_RUNNER,
    "build",
    "--ci",
    "--config",
    "src-tauri/tauri.bundle.conf.json",
    "--bundles",
    "app",
  ]);

  if (!existsSync(APP_BUNDLE_PATH)) {
    throw new Error(`Missing app bundle at ${APP_BUNDLE_PATH}`);
  }

  rmSync(stagingPath, { force: true, recursive: true });
  mkdirSync(stagingPath, { recursive: true });
  mkdirSync(DMG_DIR_PATH, { recursive: true });
  rmSync(dmgPath, { force: true });

  cpSync(APP_BUNDLE_PATH, path.join(stagingPath, "OpenEcho.app"), {
    recursive: true,
  });
  symlinkSync("/Applications", path.join(stagingPath, "Applications"));

  run("hdiutil", [
    "create",
    "-volname",
    "OpenEcho",
    "-srcfolder",
    stagingPath,
    "-ov",
    "-format",
    "UDZO",
    dmgPath,
  ]);

  rmSync(stagingPath, { force: true, recursive: true });
  console.log(`DMG created at ${dmgPath}`);
}

main();
