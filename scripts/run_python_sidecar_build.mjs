import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIDECAR_BUILD_SCRIPT = path.join(ROOT, "scripts", "build_python_sidecar.py");
const CHECK_SNIPPET = "import PyInstaller, sys; print(sys.executable)";

function pythonCandidates() {
  const override = process.env.OPENECHO_BUILD_PYTHON;
  const candidates = [];

  if (override) {
    candidates.push([override]);
  }

  if (process.platform === "win32") {
    candidates.push(["py", "-3"]);
  }

  candidates.push(["python"]);
  candidates.push(["python3"]);

  const basePython = "/opt/homebrew/Caskroom/miniconda/base/bin/python";
  if (process.platform !== "win32" && existsSync(basePython)) {
    candidates.push([basePython]);
  }

  return candidates;
}

function run(commandParts, args, options = {}) {
  const [command, ...prefixArgs] = commandParts;
  return spawnSync(command, [...prefixArgs, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    ...options,
  });
}

function resolvePython() {
  const attempts = [];

  for (const candidate of pythonCandidates()) {
    const result = run(candidate, ["-c", CHECK_SNIPPET]);
    const label = candidate.join(" ");

    if (result.error) {
      attempts.push(`${label}: ${result.error.message}`);
      continue;
    }

    if (result.status === 0) {
      const executable = result.stdout.trim() || label;
      return { command: candidate, executable };
    }

    const stderr = (result.stderr || "").trim() || "PyInstaller unavailable";
    attempts.push(`${label}: ${stderr}`);
  }

  const details = attempts.length ? `\nTried:\n- ${attempts.join("\n- ")}` : "";
  throw new Error(
    "Unable to find a Python interpreter with PyInstaller. Set OPENECHO_BUILD_PYTHON if needed." +
      details
  );
}

function main() {
  const { command, executable } = resolvePython();
  console.log(`Using Python for sidecar build: ${executable}`);

  const result = run(command, [SIDECAR_BUILD_SCRIPT], { stdio: "inherit" });

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 1);
}

main();
