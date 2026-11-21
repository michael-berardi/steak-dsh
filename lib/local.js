/**
 * The `local` route: `--model local/<id>` runs on a local model managed by Steak Pi's local manager (`steak-pi local`).
 * The launcher takes a lease with `steak-pi local ensure <id>`, declares the returned endpoint like any gateway route,
 * and gives the lease back with `steak-pi local release <id>` when the run ends. The lease holder is this process (the
 * parent of the steak-pi process), so both commands are spawned directly, never through a shell.
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { LOCAL_ROUTE_PROVIDER } from "./args.js";
import { UsageError } from "./errors.js";

/** The variable the launcher sets for the declared route. Local servers need no key; the value is a placeholder. */
export const LOCAL_KEY_ENV = "STEAK_DSH_LOCAL_KEY";
const LOCAL_KEY_VALUE = "local-no-key";
const MISSING = "the local route needs Steak Pi's local manager (`steak-pi local`), which was not found; install Steak Pi and add a model with `steak-pi local add`, or pass --base-url (with --model <provider>/<id>, --api and --key-env) to use any OpenAI-compatible server yourself";

function isExecutableFile(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** STEAK_DSH_STEAK_PI wins; otherwise `steak-pi` on PATH. Returns the path, or undefined when it is not there. */
export function resolveSteakPi(env = process.env) {
  const explicit = env.STEAK_DSH_STEAK_PI;
  if (explicit) return isExecutableFile(explicit) ? explicit : undefined;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "steak-pi");
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

export function piAgentDir(env = process.env) {
  return (env.PI_CODING_AGENT_DIR ?? "").trim() || join(homedir(), ".pi", "agent");
}

const profilesDir = (env) => join(piAgentDir(env), "local", "profiles");

/** The profile's `ctx` (a positive integer) when the profile file is readable, else undefined. */
export function profileContext(id, env = process.env) {
  if (id.includes("/") || id.includes("\\") || id.includes("..")) return undefined;
  try {
    const ctx = JSON.parse(readFileSync(join(profilesDir(env), `${id}.json`), "utf8"))?.ctx;
    return Number.isInteger(ctx) && ctx > 0 ? ctx : undefined;
  } catch {
    return undefined;
  }
}

/** The ids of the profile files steak-pi local has, sorted. No server is started. */
export function listProfiles(env = process.env) {
  try {
    return readdirSync(profilesDir(env)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
  } catch {
    return [];
  }
}

export function doctorLine(env = process.env) {
  const bin = resolveSteakPi(env);
  return bin ? `steak-pi local: ${bin} (available; profiles: ${listProfiles(env).length})` : "steak-pi local: not found (only needed for --model local/<id>)";
}

/** STEAK_PI_UIO (the variable Steak Pi reads too), else `uio` on PATH, else ~/.local/bin/uio. Undefined when it is not there. */
export function resolveUio(env = process.env) {
  const explicit = env.STEAK_PI_UIO;
  if (explicit) return isExecutableFile(explicit) ? explicit : undefined;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, "uio");
    if (isExecutableFile(candidate)) return candidate;
  }
  const fallback = join((env.HOME ?? "").trim() || homedir(), ".local", "bin", "uio");
  return isExecutableFile(fallback) ? fallback : undefined;
}

/** The tuner's version line (`uio --version`), or undefined when it does not answer. Nothing else is run. */
function uioVersion(bin, env) {
  const run = spawnSync(bin, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env, timeout: 5000 });
  const text = run.status === 0 ? String(run.stdout ?? "").trim().split("\n")[0] : "";
  return text.replace(/^uio\s+/i, "") || undefined;
}

/** What `steak-pi local tune --apply` recorded in a profile (`uioLastTune`), when it is still readable. */
function lastTune(id, env) {
  try {
    const tune = JSON.parse(readFileSync(join(profilesDir(env), `${id}.json`), "utf8"))?.uioLastTune;
    if (!tune || typeof tune !== "object" || typeof tune.at !== "string") return undefined;
    const kept = typeof tune.workdir === "string" && tune.workdir !== "" && statSyncOk(join(tune.workdir, "best-config.json"));
    return { at: tune.at.slice(0, 10), decode: Number.isFinite(tune.decodeTokS) ? tune.decodeTokS : undefined, kept };
  } catch {
    return undefined;
  }
}

function statSyncOk(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** One doctor row: is the optional tuner installed, and which local profiles have a tune record. Runs nothing but `uio --version`. */
export function tuningLine(env = process.env) {
  const bin = resolveUio(env);
  const head = bin ? `uio ${uioVersion(bin, env) ?? "(version unknown)"} at ${bin}` : "uio not installed (optional: steak-pi local tune)";
  const ids = listProfiles(env);
  if (!ids.length) return `local tuning: ${head}; no local profiles`;
  const parts = ids.map((id) => {
    const tune = lastTune(id, env);
    return tune ? `${id}: tuned ${tune.at}${tune.decode !== undefined ? ` (${tune.decode} tok/s decode)` : ""}${tune.kept ? "" : ", record missing"}` : `${id}: no uio tune record`;
  });
  return `local tuning: ${head}; ${parts.join("; ")}`;
}

const READY = /^ready: local\/(.+?) at (\S+)(?: \(.*\))?\s*$/m;

function steakPi(bin, args) {
  return spawnSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: process.env });
}

/**
 * Run `fn(options)` with the local route made ready; any other route calls `fn(options)` unchanged.
 * `fn` gets options with the declared endpoint filled in. The lease is released after `fn` ends, however it ends.
 */
export async function withLocalRoute(options, fn, { err = (text) => process.stderr.write(text) } = {}) {
  if (options.provider !== LOCAL_ROUTE_PROVIDER) return fn(options);
  const id = options.model;
  const bin = resolveSteakPi();
  if (!bin) throw new UsageError(MISSING);
  const ensured = steakPi(bin, ["local", "ensure", id]);
  if (ensured.error) throw new UsageError(`could not run ${bin} local ensure ${id}: ${ensured.error.message}`);
  if (ensured.status !== 0) {
    const detail = String(ensured.stderr ?? "").trim() || `steak-pi local ensure ${id} exited ${ensured.status ?? ensured.signal}`;
    err(`${detail}\n`);
    return 2;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const result = steakPi(bin, ["local", "release", id]);
    if (result.error || result.status !== 0) {
      const detail = result.error ? result.error.message : String(result.stderr ?? "").trim() || `exited ${result.status ?? result.signal}`;
      err(`steak-dsh: could not release the local model lease for ${id}: ${detail}\n`);
    }
  };
  process.once("exit", release); // a signal path that ends with process.exit still gives the lease back
  try {
    const match = READY.exec(String(ensured.stdout ?? ""));
    if (!match) throw new UsageError(`"steak-pi local ensure ${id}" exited 0 but printed no "ready: local/${id} at <baseUrl>" line; got: ${String(ensured.stdout ?? "").trim() || "(nothing)"}`);
    if (match[1] !== id) throw new UsageError(`"steak-pi local ensure ${id}" answered for local/${match[1]}, not local/${id}`);
    if (!/^http:\/\/(?:127\.\d+\.\d+\.\d+|localhost|\[::1\])(?::\d+)?(?:\/|$)/.test(match[2])) throw new UsageError(`"steak-pi local ensure ${id}" gave ${match[2]}, which is not a server on this machine (http://127.0.0.1, localhost or [::1])`);
    const ctx = options.contextWindow ?? profileContext(id);
    process.env[LOCAL_KEY_ENV] = LOCAL_KEY_VALUE;
    return await fn({
      ...options,
      baseUrl: match[2], api: "openai-completions", keyEnv: LOCAL_KEY_ENV,
      ...(ctx !== undefined ? { contextWindow: ctx } : {}),
    });
  } finally {
    process.removeListener("exit", release);
    release();
  }
}
