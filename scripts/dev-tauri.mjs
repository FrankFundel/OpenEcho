import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";


const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");


function commandAvailable(command, env) {
  const result = spawnSync(command, ["--version"], {
    env,
    stdio: "ignore",
  });

  return !result.error;
}


function resolvePython(env) {
  const candidates = [];

  if (env.PYTHON) {
    candidates.push(env.PYTHON);
  }

  if (env.CONDA_PREFIX) {
    candidates.push(path.join(env.CONDA_PREFIX, "bin", "python"));
  }

  candidates.push("python3", "python");

  for (const candidate of candidates) {
    if (candidate.includes(path.sep) && !existsSync(candidate)) {
      continue;
    }
    if (commandAvailable(candidate, env)) {
      return candidate;
    }
  }

  throw new Error("Python was not found. Set PYTHON or activate the environment you use for OpenEcho.");
}


function spawnProcess(command, args, env) {
  return spawn(command, args, {
    cwd: ROOT,
    env,
    stdio: "inherit",
  });
}


function terminate(processHandle) {
  if (!processHandle || processHandle.exitCode !== null || processHandle.signalCode !== null) {
    return;
  }

  processHandle.kill("SIGTERM");
}


function main() {
  const env = { ...process.env, BROWSER: "none" };
  const python = resolvePython(env);
  const backend = spawnProcess(python, ["main.py", "--reload", "--port", "8420"], env);
  const frontend = spawnProcess("npm", ["run", "start:frontend"], env);

  const shutdown = () => {
    terminate(frontend);
    terminate(backend);
  };

  backend.on("exit", (code) => {
    shutdown();
    process.exit(code ?? 0);
  });

  frontend.on("exit", (code) => {
    shutdown();
    process.exit(code ?? 0);
  });

  process.on("SIGINT", () => {
    shutdown();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    shutdown();
    process.exit(0);
  });
}


main();
