/** Locating and launching DeepSeek Harness (dsh). */
import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
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

/** The package name the harness is published under; its package.json states the version the binary reports. */
const DSH_PACKAGE = "@deepseek-ai/dsh";

/**
 * The version from the package.json of the installed package `bin` belongs to, or undefined when `bin` is not inside one
 * (a wrapper script, a test double). Reading one small file replaces starting the harness just to ask its version, which
 * cost about 65 ms on every run.
 */
export function packagedVersionOf(bin) {
  try {
    let dir = dirname(realpathSync(bin));
    for (let depth = 0; depth < 4; depth += 1) {
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      } catch {
        manifest = undefined;
      }
      if (manifest) return manifest.name === DSH_PACKAGE && parseVersion(String(manifest.version)) ? String(manifest.version) : undefined;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // not readable: ask the binary
  }
  return undefined;
}

/** The reported dsh version string, or undefined when it cannot be read. */
export function versionOf(bin) {
  const packaged = packagedVersionOf(bin);
  if (packaged !== undefined) return packaged;
  try {
    const result = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 20_000, env: withoutHostEnv(process.env) });
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

/** Host-app variables that belong to this process only; no child (and no tool the agent runs) may inherit them. */
export const HOST_ONLY_ENV = ["ULTRATERM_UI_TRANSCRIPT_FILE", "ULTRATERM_UI_SESSION_ID", "ULTRATERM_MAIN_SCREEN"];

/** The environment without the host-app variables (a copy). */
export function withoutHostEnv(env) {
  const out = { ...env };
  for (const name of HOST_ONLY_ENV) delete out[name];
  return out;
}

/**
 * Where the harness keeps Node's compiled-code cache, or undefined when it is switched off (STEAK_DSH_COMPILE_CACHE=0) or
 * the folder cannot be made. The harness loads several hundred modules at every start; with the cache Node reuses their
 * compiled form instead of compiling each again (about 100 ms a run, measured). The cache is keyed by file content, so an
 * upgraded harness never runs stale code. A NODE_COMPILE_CACHE the caller already set is left alone.
 */
export function compileCacheDir(env = process.env) {
  if (env.STEAK_DSH_COMPILE_CACHE === "0") return undefined;
  if (env.NODE_COMPILE_CACHE) return env.NODE_COMPILE_CACHE;
  const dir = join(env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache"), "steak-dsh", "compile-cache");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  } catch {
    return undefined;
  }
}

/**
 * The launch environment: DSH_TELEMETRY_MODE defaults to DISABLED when unset or empty; the host-app variables are removed;
 * Node's compile cache is switched on for the harness (compileCacheDir).
 */
export function launchEnv(env = process.env) {
  const cache = compileCacheDir(env);
  return { ...withoutHostEnv(env), DSH_TELEMETRY_MODE: env.DSH_TELEMETRY_MODE || "DISABLED", ...(cache ? { NODE_COMPILE_CACHE: cache } : {}) };
}
