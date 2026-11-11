/** Locating and launching DeepSeek Harness (dsh). */
import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { MissingDshError } from "./errors.js";
import { parseVersion, satisfies } from "./semver.js";

const INSTALL_HINT = "install it with: npm i -g @deepseek-ai/dsh";

function isExecutableFile(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** STEAK_DSH_DSH_BIN wins; otherwise `dsh` on PATH. Missing: a named error with exit code 78. */
export function resolveDsh(env = process.env) {
  const explicit = env.STEAK_DSH_DSH_BIN;
  if (explicit) {
    if (isExecutableFile(explicit)) return explicit;
    throw new MissingDshError(`STEAK_DSH_DSH_BIN points at "${explicit}", which is not an executable file; ${INSTALL_HINT}`);
  }
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "dsh");
    if (isExecutableFile(candidate)) return candidate;
  }
  throw new MissingDshError(`dsh was not found on PATH; ${INSTALL_HINT} (or point STEAK_DSH_DSH_BIN at it)`);
}

/** The reported dsh version string, or undefined when it cannot be read. */
export function versionOf(bin) {
  try {
    const result = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 20_000 });
    if (result.status !== 0) return undefined;
    const text = String(result.stdout ?? "").trim();
    return parseVersion(text) ? text : undefined;
  } catch {
    return undefined;
  }
}

/** One stderr warning line when the version is unreadable or outside engines.dsh; never fatal. Returns the version. */
export function warnIfOutOfRange(bin, range, warn = (line) => process.stderr.write(line + "\n")) {
  const version = versionOf(bin);
  if (version === undefined) {
    warn(`steak-dsh: warning: could not read the dsh version from ${bin}; continuing`);
  } else if (!satisfies(version, range)) {
    warn(`steak-dsh: warning: dsh ${version} is outside the supported range "${range}"; continuing`);
  }
  return version;
}

/** The launch environment: unchanged except DSH_TELEMETRY_MODE defaults to DISABLED when unset or empty. */
export function launchEnv(env = process.env) {
  return { ...env, DSH_TELEMETRY_MODE: env.DSH_TELEMETRY_MODE || "DISABLED" };
}
