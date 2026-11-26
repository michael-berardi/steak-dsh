/**
 * Update check, notice and install (update contract v1; user docs in docs/updates.md).
 *
 * The check is one anonymous GET of this package's public "latest release" record, at most once per 24 hours. `chat` and
 * `tui` on a terminal start it in the background after launch and never wait for it; the notice is printed on stderr
 * after the session. Everything the check remembers lives in one small 0600 cache file. `steak-dsh update` upgrades an
 * npm-global copy through npm, and an installer-managed copy through the release's own installer, which is checked
 * against the release's SHA256SUMS before it runs.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir, setPriority, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { withoutHostEnv } from "./dsh.js";
import { UsageError } from "./errors.js";
import { compareVersions, parseVersion } from "./semver.js";
import { exitLogDir } from "./tui/session.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

export const DAY_MS = 24 * 60 * 60 * 1000;
export const LOG_MAX = 256 * 1024;
export const KEEP_PREVIOUS_MS = 7 * DAY_MS;
const CHECK_TIMEOUT_MS = 4000;
const START_DELAY_MS = 1500;
const USER_AGENT = "steak-dsh-update-check";
// CI and agent hosts: an automatic check never runs under them.
const QUIET_ENV = ["CI", "CLAUDECODE", "CODEX_SANDBOX", "GEMINI_CLI"];
const STABLE = /^v?\d+\.\d+\.\d+$/;
const RELEASE_DIR = /^release-(\d+\.\d+\.\d+)$/;

const isSet = (value) => value !== undefined && !["", "0", "false", "no"].includes(String(value).trim().toLowerCase());

/** owner/repo from this package's own repository field. */
export function repository() {
  const url = String(pkg.repository?.url ?? pkg.repository ?? "");
  const match = /github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?(?:[/#].*)?$/.exec(url);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

function apiUrl(env) {
  const override = (env.STEAK_DSH_UPDATE_API ?? "").trim();
  if (override) return override;
  const slug = repository();
  return slug ? `https://api.github.com/repos/${slug}/releases/latest` : "";
}

// ---- state: one cache file for the check, the user's config file for the two switches

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function cachePath(env = process.env) {
  return join(env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache"), "steak-dsh", "update.json");
}

export function readCache(env = process.env) {
  try {
    const value = JSON.parse(readFileSync(cachePath(env), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** Merge `patch` into the cache and return the result. A cache that cannot be written never breaks a session. */
export function updateCache(patch, env = process.env) {
  const next = { ...readCache(env), ...patch };
  try {
    writeAtomic(cachePath(env), JSON.stringify(next));
  } catch {
    // read-only or missing cache folder: the next session simply checks again
  }
  return next;
}

export function configPath(env = process.env) {
  return join((env.DSH_HOME ?? "").trim() || join(homedir(), ".dsh"), "steak-dsh.json");
}

function readConfig(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not a JSON object");
  return value;
}

/** `"updates"` in $DSH_HOME/steak-dsh.json: checks on and automatic install off unless the user chose otherwise. */
export function readSettings(env = process.env) {
  let updates;
  try {
    updates = readConfig(configPath(env)).updates;
  } catch {
    updates = undefined;
  }
  const u = updates && typeof updates === "object" ? updates : {};
  return { checkAutomatically: u.checkAutomatically !== false, auto: u.auto === true, autoAsked: u.autoAsked === true };
}

/** Change the update switches, keeping every other setting in the file. An unreadable file is never overwritten. */
export function saveSettings(patch, env = process.env) {
  const path = configPath(env);
  let config;
  try {
    config = readConfig(path);
  } catch (error) {
    throw new Error(`cannot save the setting: ${path} is not valid JSON (${error.message}); fix or remove it`);
  }
  config.updates = { ...(config.updates && typeof config.updates === "object" ? config.updates : {}), ...patch };
  writeAtomic(path, JSON.stringify(config, null, 2) + "\n");
}

/** Why automatic checks are switched off by the environment or the config, or "" when they are on. */
export function checksOff(env = process.env) {
  const host = QUIET_ENV.find((name) => isSet(env[name]));
  if (host) return `${host} is set`;
  if (isSet(env.STEAK_DSH_NO_UPDATE_CHECK)) return "STEAK_DSH_NO_UPDATE_CHECK is set";
  if (!readSettings(env).checkAutomatically) return `updates.checkAutomatically is false in ${configPath(env)}`;
  return "";
}

/** An automatic check needs a terminal on stdout and stderr and nothing in checksOff(). Explicit commands ignore this. */
export function checkAllowed(env = process.env, stdout = process.stdout, stderr = process.stderr) {
  return Boolean(stdout?.isTTY && stderr?.isTTY) && !checksOff(env);
}

// ---- the check

/** True only for a stable x.y.z release strictly newer than `current`. Prereleases and anything unparseable are not. */
export function isNewer(current, candidate) {
  const have = parseVersion(current);
  const next = STABLE.test(String(candidate ?? "").trim()) ? parseVersion(candidate) : undefined;
  return Boolean(have && next && compareVersions(next, have) > 0);
}

export function releaseNotes(body, lines = 3) {
  return String(body ?? "").split(/\r?\n/)
    .map((line) => line.replace(/^[\s#>*-]+/, "").trim())
    .filter((line) => line && !/^https?:\/\/\S+$/.test(line))
    .slice(0, lines)
    .map((line) => (line.length > 160 ? `${line.slice(0, 157)}...` : line));
}

const due = (cache, now) => !(Number.isFinite(cache.checkedAt) && now - cache.checkedAt >= 0 && now - cache.checkedAt < DAY_MS);

/**
 * One anonymous GET (fixed User-Agent, no version, id or machine data). The attempt is recorded before the request, so a
 * check that is cut off still counts toward the 24-hour limit; a failure keeps the last known release and records why.
 */
export async function checkNow({ env = process.env, fetchImpl = fetch, now = Date.now, signal } = {}) {
  updateCache({ checkedAt: now(), error: "the check did not finish" }, env);
  const timeout = AbortSignal.timeout(CHECK_TIMEOUT_MS);
  try {
    const url = apiUrl(env);
    if (!/^https?:\/\//.test(url)) throw new Error("package.json names no GitHub repository");
    const response = await fetchImpl(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/vnd.github+json" },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
    const data = await response.json();
    const tag = String(data?.tag_name ?? "").trim();
    const stable = !data?.draft && !data?.prerelease && STABLE.test(tag);
    return updateCache({ latest: stable ? tag.replace(/^v/, "") : null, notes: stable ? releaseNotes(data.body) : [], error: null }, env);
  } catch (error) {
    const cause = signal?.aborted ? "the session ended before the check finished"
      : timeout.aborted ? `no answer within ${CHECK_TIMEOUT_MS / 1000} s`
      : String(error?.message ?? error);
    return updateCache({ error: cause.slice(0, 200) }, env);
  }
}

// ---- the notice

export function noticeText(current, latest, { color = false, failure } = {}) {
  const second = failure
    ? `automatic install failed: ${failure} · skip: steak-dsh update --skip`
    : "turn on automatic updates: steak-dsh update --auto on · skip: steak-dsh update --skip";
  return `steak-dsh ${latest} available (you have ${current}) · run: steak-dsh update\n${color ? `\x1b[2m${second}\x1b[0m` : second}\n`;
}

/**
 * Start the automatic check for an interactive session. It begins a moment after launch and is never awaited; `finish()`
 * at the end of the session prints the notice (or starts the opt-in background install) from a check that has
 * completed, and drops one that has not.
 */
export function startBackgroundUpdate({ version = pkg.version, env = process.env, stdout = process.stdout, stderr = process.stderr, fetchImpl = fetch, now = Date.now, rootDir = root, delayMs = START_DELAY_MS } = {}) {
  if (!checkAllowed(env, stdout, stderr)) return { pending: Promise.resolve(), finish() {} };
  const cached = readCache(env);
  let result = due(cached, now()) ? undefined : cached;
  let timer;
  let settle = () => {};
  const abort = new AbortController();
  const pending = result ? Promise.resolve() : new Promise((resolve) => {
    settle = resolve;
    timer = setTimeout(() => {
      timer = undefined;
      checkNow({ env, fetchImpl, now, signal: abort.signal }).then((value) => { result = value; }, () => {}).finally(resolve);
    }, delayMs); // finish() always clears it, so it never holds a process open
  });
  return {
    pending,
    finish() {
      if (timer) {
        clearTimeout(timer); // the session ended before the check began: nothing was sent
        settle();
      }
      if (!result) {
        abort.abort();
        return;
      }
      afterCheck(result, { version, env, stderr, now, rootDir });
    },
  };
}

function afterCheck(cache, { version, env, stderr, now, rootDir }) {
  const latest = cache.latest;
  if (!isNewer(version, latest) || cache.skip === latest) return;
  const auto = cache.auto?.version === latest ? cache.auto : undefined;
  if (!auto && readSettings(env).auto && ["installer", "npm"].includes(installKind(rootDir))) {
    startAutoInstall(latest, { env, rootDir, now });
    return;
  }
  // An automatic install that finished, or is still running, applies on the next launch: nothing to say.
  if (auto?.state === "installed" || (auto?.state === "started" && now() - auto.at < 60 * 60 * 1000)) return;
  if (cache.shown?.version === latest && now() - cache.shown.at < DAY_MS) return;
  updateCache({ shown: { version: latest, at: now() } }, env);
  const failure = auto ? auto.cause ?? "it did not finish" : undefined;
  stderr.write(noticeText(version, latest, { color: Boolean(stderr.isTTY) && !env.NO_COLOR, failure }));
}

// ---- install kinds and installation

/** "installer" (<home>/app/release-x.y.z), "npm" (a node_modules/steak-dsh), "source" (a git checkout) or "unknown". */
export function installKind(rootDir = root) {
  let dir = rootDir;
  try {
    dir = realpathSync(rootDir);
  } catch {
    // keep the path as given
  }
  if (RELEASE_DIR.test(basename(dir)) && basename(dirname(dir)) === "app") return "installer";
  if (basename(dir) === "steak-dsh" && basename(dirname(dir)) === "node_modules") return "npm";
  if (existsSync(join(dir, ".git"))) return "source";
  return "unknown";
}

/** The command that updates a copy of this kind, as shown to the user. */
export function updateHint(kind, version, rootDir = root) {
  const slug = repository();
  if (kind === "installer") return "steak-dsh update";
  if (kind === "npm") return `npm i -g github:${slug}#v${version}`;
  if (kind === "source") return `git -C ${rootDir} pull`;
  return process.platform === "win32"
    ? `irm https://github.com/${slug}/releases/latest/download/install.ps1 | iex`
    : `curl -fsSL https://github.com/${slug}/releases/latest/download/install.sh | sh`;
}

async function download(url, file, fetchImpl) {
  const response = await fetchImpl(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  writeFileSync(file, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
}

function expectedSum(sums, name) {
  for (const line of sums.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(line.trim());
    if (match && match[2] === name) return match[1].toLowerCase();
  }
  return undefined;
}

function runTool(file, args, { env, log }) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: log ? ["ignore", "pipe", "pipe"] : "inherit", shell: process.platform === "win32" && file === "npm", windowsHide: true });
    if (log) {
      child.stdout.on("data", log);
      child.stderr.on("data", log);
    }
    child.on("error", (error) => reject(new Error(`could not start ${file}: ${error.message}`)));
    child.on("close", (code, signal) => resolve(signal ? `signal ${signal}` : code ?? 1));
  });
}

/**
 * Install `version` for this copy. npm-global copies are upgraded by npm (npm owns those files). Installer-managed copies
 * run that release's own installer once it matches the release's SHA256SUMS; the installer checks the archive the same way
 * before it unpacks anything, swaps the `current` link and keeps the previous release for `update --rollback`. The download
 * folder is removed whether this succeeds or fails.
 */
export async function installVersion(version, { env = process.env, rootDir = root, fetchImpl = fetch, log, tempRoot = tmpdir() } = {}) {
  const kind = installKind(rootDir);
  const childEnv = { ...withoutHostEnv(env), npm_config_update_notifier: "false" };
  if (kind === "npm") {
    const code = await runTool("npm", ["install", "-g", `github:${repository()}#v${version}`], { env: childEnv, log });
    if (code !== 0) throw new Error(`npm exited with ${code}`);
    return;
  }
  if (kind !== "installer") throw new Error(`this copy is not managed by the installer or npm; update it with: ${updateHint(kind, version, rootDir)}`);
  const base = (env.STEAK_DSH_RELEASE_BASE || `https://github.com/${repository()}/releases/download/v${version}`).replace(/\/+$/, "");
  const script = process.platform === "win32" ? "install.ps1" : "install.sh";
  const dir = mkdtempSync(join(tempRoot, "steak-dsh-update-"));
  try {
    await download(`${base}/SHA256SUMS`, join(dir, "SHA256SUMS"), fetchImpl);
    await download(`${base}/${script}`, join(dir, script), fetchImpl);
    const want = expectedSum(readFileSync(join(dir, "SHA256SUMS"), "utf8"), script);
    if (!want) throw new Error(`SHA256SUMS has no line for ${script}; nothing was installed`);
    if (createHash("sha256").update(readFileSync(join(dir, script))).digest("hex") !== want) {
      throw new Error(`checksum mismatch for ${script}; nothing was installed`);
    }
    // The same home the running copy lives in, pinned to the release that was checked.
    const installEnv = { ...childEnv, STEAK_DSH_HOME: dirname(dirname(realpathSync(rootDir))), STEAK_DSH_VERSION: version };
    const [file, args] = process.platform === "win32"
      ? ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(dir, script)]]
      : ["sh", [join(dir, script)]];
    const code = await runTool(file, args, { env: installEnv, log });
    if (code !== 0) throw new Error(`the installer exited with ${code}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function logPath(env = process.env) {
  return join(exitLogDir(env), "update.log");
}

/** The automatic-install log: one file, rewritten for each install and cut off at LOG_MAX bytes. */
export function openLog(env = process.env) {
  mkdirSync(exitLogDir(env), { recursive: true, mode: 0o700 });
  const fd = openSync(logPath(env), "w", 0o600);
  let size = 0;
  return {
    write(chunk) {
      const part = Buffer.from(chunk).subarray(0, Math.max(0, LOG_MAX - size));
      if (part.length === 0) return;
      writeSync(fd, part);
      size += part.length;
    },
    close() {
      closeSync(fd);
    },
  };
}

/** The opt-in automatic install: a detached, low-priority `steak-dsh update --apply <version>` that outlives the session. */
export function startAutoInstall(version, { env = process.env, rootDir = root, now = Date.now } = {}) {
  updateCache({ auto: { version, state: "started", at: now() } }, env);
  try {
    const child = spawn(process.execPath, [join(rootDir, "bin", "steak-dsh"), "update", "--apply", version], {
      detached: true, stdio: "ignore", env: withoutHostEnv(env), windowsHide: true,
    });
    child.on("error", () => {}); // still "started": the next session reports it as not finished
    if (child.pid) {
      try {
        setPriority(child.pid, 10);
      } catch {
        // priority is best effort
      }
    }
    child.unref();
  } catch (error) {
    updateCache({ auto: { version, state: "failed", at: now(), cause: String(error.message).slice(0, 200) } }, env);
  }
}

async function applyAuto(version, { env, rootDir, fetchImpl, now }) {
  const log = openLog(env);
  log.write(`${new Date(now()).toISOString()} installing steak-dsh ${version}\n`);
  try {
    await installVersion(version, { env, rootDir, fetchImpl, log: (chunk) => log.write(chunk) });
    updateCache({ auto: { version, state: "installed", at: now() } }, env);
    log.write("installed; it applies from the next launch\n");
    return 0;
  } catch (error) {
    const cause = String(error?.message ?? error).slice(0, 200);
    updateCache({ auto: { version, state: "failed", at: now(), cause } }, env);
    log.write(`failed: ${cause}\n`);
    return 1;
  } finally {
    log.close();
  }
}

// ---- the rollback copy

function releasesIn(app) {
  return readdirSync(app).map((name) => RELEASE_DIR.exec(name)?.[1]).filter(Boolean);
}

/**
 * Remove the rollback copy once this release has finished a session successfully, or 7 days after it became current.
 * Only for an installer-managed copy that is the current release, and never a newer release folder (an install may be
 * moving one into place right now).
 */
export function pruneRollback({ rootDir = root, succeeded = false, now = Date.now() } = {}) {
  if (installKind(rootDir) !== "installer") return [];
  const self = realpathSync(rootDir);
  const app = dirname(self);
  let since;
  try {
    if (realpathSync(join(app, "current")) !== self) return [];
    since = lstatSync(join(app, "current")).mtimeMs;
  } catch {
    return [];
  }
  if (!succeeded && now - since < KEEP_PREVIOUS_MS) return [];
  const mine = parseVersion(RELEASE_DIR.exec(basename(self))[1]);
  const removed = [];
  for (const version of releasesIn(app)) {
    if (compareVersions(parseVersion(version), mine) >= 0) continue;
    rmSync(join(app, `release-${version}`), { recursive: true, force: true });
    removed.push(version);
  }
  return removed;
}

/** End of a run/chat/tui session: the notice (or automatic install), then the rollback-copy rule. Never throws. */
export function finishSession(updates, succeeded) {
  try {
    updates?.finish();
  } catch {
    // an update problem never changes a session's result
  }
  try {
    pruneRollback({ succeeded });
  } catch {
    // a folder that cannot be removed now is removed by a later session
  }
}

function rollback({ env, rootDir, out, err }) {
  const kind = installKind(rootDir);
  if (kind !== "installer") {
    err(`steak-dsh: rollback works only for a copy the installer manages; install an older release with ${updateHint(kind, "<version>", rootDir)}\n`);
    return 1;
  }
  const app = dirname(realpathSync(rootDir));
  const current = join(app, "current");
  const active = RELEASE_DIR.exec(basename(realpathSync(current)))?.[1];
  const previous = releasesIn(app)
    .filter((version) => active && compareVersions(parseVersion(version), parseVersion(active)) < 0)
    .sort((a, b) => compareVersions(parseVersion(a), parseVersion(b)))
    .at(-1);
  if (!previous) {
    err("steak-dsh: no previous release is kept (it is removed once the new version has finished a session, or after 7 days)\n");
    return 1;
  }
  const target = join(app, `release-${previous}`);
  const check = spawnSync(process.execPath, [join(target, "bin", "steak-dsh"), "--version"], { encoding: "utf8", env: withoutHostEnv(env), timeout: 30_000 });
  if (check.status !== 0 || String(check.stdout).trim() !== previous) {
    err(`steak-dsh: release ${previous} does not start; nothing was changed\n`);
    return 1;
  }
  const tmp = `${current}.rollback.${process.pid}`;
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp, "junction");
  if (process.platform === "win32") unlinkSync(current); // a junction cannot be renamed over
  renameSync(tmp, current);
  updateCache({ skip: active }, env);
  out(`steak-dsh: rolled back to ${previous}; ${active} is skipped until a newer release\n`);
  return 0;
}

// ---- the command

async function askLine(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

const yes = (answer, byDefault) => {
  const text = String(answer ?? "").trim().toLowerCase();
  return text === "" ? byDefault : text === "y" || text === "yes";
};

/** `steak-dsh update [--check | --skip | --auto on|off|status | --rollback]`. */
export async function updateCommand(argv, { version = pkg.version, env = process.env, rootDir = root, fetchImpl = fetch, now = Date.now, io = {} } = {}) {
  const out = io.out ?? ((text) => process.stdout.write(text));
  const err = io.err ?? ((text) => process.stderr.write(text));
  const tty = io.tty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const ask = io.ask ?? askLine;
  const [flag, value, ...extra] = argv;
  const takesValue = flag === "--auto" || flag === "--apply";
  if (extra.length > 0 || (!takesValue && value !== undefined)) throw new UsageError(`update takes one option, got ${argv.join(" ")}`);
  const kind = installKind(rootDir);

  switch (flag) {
    case "--auto": {
      if (value === "status") {
        const settings = readSettings(env);
        const off = checksOff(env);
        out(`automatic updates: ${settings.auto ? "on" : "off"}\nupdate checks: ${off ? `off (${off})` : "on"}\nversion: ${version}\n`);
        return 0;
      }
      if (value !== "on" && value !== "off") throw new UsageError("update --auto needs on, off or status");
      saveSettings({ auto: value === "on", autoAsked: true }, env);
      if (value === "off") rmSync(logPath(env), { force: true });
      out(`automatic updates: ${value}\n`);
      return 0;
    }
    case "--rollback":
      return rollback({ env, rootDir, out, err });
    case "--apply": // the detached child that startAutoInstall starts
      if (!isNewer(version, value)) throw new UsageError("update --apply needs a newer x.y.z version");
      return applyAuto(value, { env, rootDir, fetchImpl, now });
    case "--check":
    case "--skip":
    case undefined:
      break;
    default:
      throw new UsageError(`unknown update option ${flag} (try steak-dsh --help)`);
  }

  // --skip may use the release the notice named; everything else asks GitHub now.
  const cached = readCache(env);
  const cache = flag === "--skip" && !due(cached, now()) && cached.latest ? { ...cached, error: null } : await checkNow({ env, fetchImpl, now });
  if (cache.error) {
    err(`steak-dsh: update check failed: ${cache.error}\n`);
    return 1;
  }
  const latest = cache.latest;
  if (!isNewer(version, latest)) {
    out(`steak-dsh ${version} is up to date\n`);
    return 0;
  }
  if (flag === "--check") {
    out(`steak-dsh ${latest} available (you have ${version}) · run: ${updateHint(kind, latest, rootDir)}\n`);
    return 10;
  }
  if (flag === "--skip") {
    updateCache({ skip: latest }, env);
    out(`steak-dsh: ${latest} skipped; a newer release will be announced again\n`);
    return 0;
  }

  out(`steak-dsh ${version} → ${latest}\n`);
  for (const line of Array.isArray(cache.notes) ? cache.notes : []) out(`  ${line}\n`);
  if (kind !== "installer" && kind !== "npm") {
    err(`steak-dsh: this copy is not managed by the installer or npm; update it with: ${updateHint(kind, latest, rootDir)}\n`);
    return 1;
  }
  if (kind === "npm") out(`installing with: ${updateHint(kind, latest, rootDir)}\n`);
  if (tty && !yes(await ask(`Install ${latest} now? [Y/n] `), true)) {
    out("nothing was changed\n");
    return 0;
  }
  try {
    await installVersion(latest, { env, rootDir, fetchImpl });
  } catch (error) {
    err(`steak-dsh: update failed: ${error.message}\n`);
    return 1;
  }
  out(`steak-dsh ${latest} installed; it applies from the next launch\n`);
  const settings = readSettings(env);
  if (tty && !settings.auto && !settings.autoAsked) {
    const auto = yes(await ask("Install future updates automatically? [y/N] "), false);
    try {
      saveSettings({ auto, autoAsked: true }, env);
      if (auto) out("automatic updates: on (turn off: steak-dsh update --auto off)\n");
    } catch (error) {
      err(`steak-dsh: ${error.message}\n`);
    }
  }
  return 0;
}
