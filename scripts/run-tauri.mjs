import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");


function withCargoPath(env) {
  const cargoDir = path.join(homedir(), ".cargo", "bin");
  const pathEntries = (env.PATH || "").split(path.delimiter).filter(Boolean);

  if (!pathEntries.includes(cargoDir) && existsSync(cargoDir)) {
    env.PATH = [cargoDir, ...pathEntries].join(path.delimiter);
  }

  return env;
}


function resolveTauriCli() {
  const localCli = path.join(
    ROOT,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tauri.cmd" : "tauri"
  );
  if (existsSync(localCli)) {
    return localCli;
  }

  return process.platform === "win32" ? "tauri.cmd" : "tauri";
}


function main(args) {
  const env = withCargoPath({ ...process.env });
  const command = resolveTauriCli();
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env,
    stdio: "inherit",
  });

  if (result.error) {
    const message = result.error.code === "ENOENT"
      ? "Unable to start Tauri. Ensure Node dependencies are installed and Rustup provides cargo in ~/.cargo/bin."
      : result.error.message;
    console.error(message);
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}


main(process.argv.slice(2));
