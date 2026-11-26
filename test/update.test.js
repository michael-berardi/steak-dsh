/** Update contract v1: version rules, the private cache, silence, notices, switches, verified install, rollback, debris. No network. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cachePath, checkAllowed, checkNow, configPath, DAY_MS, installKind, installVersion, isNewer, KEEP_PREVIOUS_MS, LOG_MAX, logPath,
  noticeText, openLog, pruneRollback, readCache, readSettings, releaseNotes, repository, startAutoInstall, startBackgroundUpdate,
  updateCache, updateCommand,
} from "../lib/update.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(root, "bin", "steak-dsh");
const nodeDir = dirname(process.execPath);

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "steak-dsh-utest-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const key of ["CI", "CLAUDECODE", "CODEX_SANDBOX", "GEMINI_CLI", "STEAK_DSH_NO_UPDATE_CHECK", "STEAK_DSH_UPDATE_API", "STEAK_DSH_RELEASE_BASE", "STEAK_DSH_VERSION", "STEAK_DSH_HOME", "STEAK_DSH_BIN_DIR", "NO_COLOR"]) delete env[key];
  Object.assign(env, { HOME: join(dir, "home"), XDG_CACHE_HOME: join(dir, "cache"), DSH_HOME: join(dir, "dsh"), TMPDIR: dir });
  for (const path of [env.HOME, env.XDG_CACHE_HOME, env.DSH_HOME]) mkdirSync(path, { recursive: true });
  return { dir, env };
}

const tty = { isTTY: true };
const pipe = { isTTY: false };
const release = (tag, extra = {}) => ({
  ok: true, status: 200,
  json: async () => ({ tag_name: tag, draft: false, prerelease: false, body: "## Changes\n- First note\n- Second note\nhttps://example.invalid/x\n- Third\n- Fourth", ...extra }),
});
const stub = (answer) => {
  const calls = [];
  return { calls, fetch: async (url, init) => { calls.push({ url, init }); return typeof answer === "function" ? answer(calls.length) : answer; } };
};
const stream = (isTTY = true) => {
  const chunks = [];
  return { isTTY, write: (text) => chunks.push(text), text: () => chunks.join(""), chunks };
};
const collect = (extra = {}) => {
  const out = [];
  const err = [];
  return { out: (text) => out.push(text), err: (text) => err.push(text), tty: false, ...extra, get stdout() { return out.join(""); }, get stderr() { return err.join(""); } };
};
/** One interactive session: start the check, let it finish (or not), end the session. */
async function session(options) {
  const updates = startBackgroundUpdate({ delayMs: 0, rootDir: join(options.env.HOME, "nowhere"), ...options });
  await updates.pending;
  updates.finish();
}

test("only a stable x.y.z strictly newer than this version counts", () => {
  assert.equal(isNewer("0.18.0", "0.18.1"), true);
  assert.equal(isNewer("0.18.0", "v0.19.0"), true);
  assert.equal(isNewer("0.18.0", "0.18.0"), false, "equal");
  assert.equal(isNewer("0.18.0", "0.17.9"), false, "older");
  assert.equal(isNewer("0.18.0", "0.19.0-rc.1"), false, "prerelease");
  assert.equal(isNewer("0.18.0", "0.19.0+build"), false, "not plain x.y.z");
  assert.equal(isNewer("0.18.0", "not-a-version"), false, "garbage");
  assert.equal(isNewer("0.18.0", null), false);
  assert.equal(isNewer("garbage", "0.19.0"), false);
  assert.equal(isNewer("0.19.0-rc.1", "0.19.0"), true, "the release after its own prerelease");
  assert.deepEqual(releaseNotes("## Changes\n- One\nhttps://example.invalid/x\n- Two\n- Three\n- Four"), ["Changes", "One", "Two"]);
  assert.match(repository(), /^[^/]+\/[^/]+$/);
});

test("the check is one anonymous GET; drafts, prereleases and unparseable tags are not offered", async (t) => {
  const { env } = fixture(t);
  const fake = stub((n) => [release("v0.19.0-rc.1", { prerelease: true }), release("v0.19.0", { draft: true }), release("junk"), release("v0.19.0")][n - 1]);
  for (let i = 0; i < 3; i += 1) assert.equal((await checkNow({ env, fetchImpl: fake.fetch })).latest, null);
  const found = await checkNow({ env, fetchImpl: fake.fetch });
  assert.equal(found.latest, "0.19.0");
  assert.deepEqual(found.notes, ["Changes", "First note", "Second note"]);
  assert.equal(fake.calls.length, 4);
  const { url, init } = fake.calls[0];
  assert.match(url, /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/latest$/);
  assert.deepEqual(Object.keys(init.headers).sort(), ["accept", "user-agent"]);
  assert.equal(init.headers["user-agent"], "steak-dsh-update-check");
  assert.equal(init.method, undefined, "a plain GET with no body");
  assert.equal(init.body, undefined);
});

test("a background check runs at most once per 24 hours into one private cache file", async (t) => {
  const { env } = fixture(t);
  const fake = stub(release("v0.19.0"));
  let clock = 10 * DAY_MS;
  const now = () => clock;
  await session({ version: "0.18.0", env, stdout: tty, stderr: stream(), fetchImpl: fake.fetch, now });
  assert.equal(fake.calls.length, 1);
  clock += DAY_MS - 1;
  await session({ version: "0.18.0", env, stdout: tty, stderr: stream(), fetchImpl: fake.fetch, now });
  assert.equal(fake.calls.length, 1, "a fresh cache is reused");
  clock += 1;
  await session({ version: "0.18.0", env, stdout: tty, stderr: stream(), fetchImpl: fake.fetch, now });
  assert.equal(fake.calls.length, 2, "checked again after 24 hours");
  assert.equal(statSync(cachePath(env)).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dirname(cachePath(env))), ["update.json"], "no temp files or other files are left");
  const keys = Object.keys(readCache(env)).sort();
  assert.deepEqual(keys, ["checkedAt", "error", "latest", "notes", "shown"]);
});

test("a failure is recorded with its cause, is not retried for 24 hours, and update --check reports it", async (t) => {
  const { env } = fixture(t);
  let calls = 0;
  const down = async () => { calls += 1; throw new Error("connect ECONNREFUSED"); };
  const err = stream();
  await session({ version: "0.18.0", env, stdout: tty, stderr: err, fetchImpl: down });
  assert.equal(readCache(env).error, "connect ECONNREFUSED");
  assert.equal(err.text(), "", "a failed background check prints nothing");
  await session({ version: "0.18.0", env, stdout: tty, stderr: err, fetchImpl: down });
  assert.equal(calls, 1, "no retry loop");
  const io = collect();
  assert.equal(await updateCommand(["--check"], { version: "0.18.0", env, fetchImpl: async () => ({ ok: false, status: 403 }), io }), 1);
  assert.match(io.stderr, /update check failed: HTTP 403 from api\.github\.com/);
  assert.equal(readCache(env).error, "HTTP 403 from api.github.com");
});

test("update --check exits 0 when current, 10 when a newer release exists, 1 when the check fails", async (t) => {
  const { env } = fixture(t);
  const current = collect();
  assert.equal(await updateCommand(["--check"], { version: "0.19.0", env, fetchImpl: stub(release("v0.19.0")).fetch, io: current }), 0);
  assert.equal(current.stdout, "steak-dsh 0.19.0 is up to date\n");
  const newer = collect();
  assert.equal(await updateCommand(["--check"], { version: "0.18.0", env, fetchImpl: stub(release("v0.19.0")).fetch, io: newer }), 10);
  assert.match(newer.stdout, /^steak-dsh 0\.19\.0 available \(you have 0\.18\.0\) · run: /);
  const failed = collect();
  assert.equal(await updateCommand(["--check"], { version: "0.18.0", env, fetchImpl: async () => { throw new Error("offline"); }, io: failed }), 1);
  assert.match(failed.stderr, /offline/);
  await assert.rejects(updateCommand(["--bogus"], { env, io: collect() }), /unknown update option/);
});

test("no automatic check off a terminal, in CI, under an agent host, or when opted out", async (t) => {
  const { env } = fixture(t);
  assert.equal(checkAllowed(env, tty, tty), true);
  const quiet = [
    [env, pipe, tty], [env, tty, pipe],
    [{ ...env, CI: "true" }, tty, tty], [{ ...env, CLAUDECODE: "1" }, tty, tty], [{ ...env, CODEX_SANDBOX: "seatbelt" }, tty, tty],
    [{ ...env, STEAK_DSH_NO_UPDATE_CHECK: "1" }, tty, tty],
  ];
  for (const [e, out, err] of quiet) assert.equal(checkAllowed(e, out, err), false);
  const fake = stub(release("v0.19.0"));
  const quietSessions = async (cases) => {
    for (const [e, out, err] of cases) {
      const capture = stream(err.isTTY);
      await session({ version: "0.18.0", env: e, stdout: out, stderr: capture, fetchImpl: fake.fetch });
      assert.equal(capture.text(), "");
    }
  };
  await quietSessions(quiet);
  writeFileSync(configPath(env), JSON.stringify({ updates: { checkAutomatically: false } }));
  assert.equal(checkAllowed(env, tty, tty), false, "the config switch");
  await quietSessions([[env, tty, tty]]);
  assert.equal(fake.calls.length, 0, "nothing was requested");
  assert.equal(existsSync(cachePath(env)), false, "nothing was written");
});

test("the notice is two lines on stderr, at most once per version per day; a skip lasts until a newer release", async (t) => {
  const { env } = fixture(t);
  assert.equal(noticeText("0.18.0", "0.19.0"),
    "steak-dsh 0.19.0 available (you have 0.18.0) · run: steak-dsh update\n" +
    "turn on automatic updates: steak-dsh update --auto on · skip: steak-dsh update --skip\n");
  let clock = 10 * DAY_MS;
  const now = () => clock;
  const err = stream();
  await session({ version: "0.18.0", env, stdout: tty, stderr: err, fetchImpl: stub(release("v0.19.0")).fetch, now });
  assert.equal(err.chunks.length, 1);
  assert.match(err.text(), /^steak-dsh 0\.19\.0 available \(you have 0\.18\.0\) · run: steak-dsh update\n\x1b\[2mturn on automatic updates: .*\x1b\[0m\n$/);
  clock += DAY_MS / 2;
  await session({ version: "0.18.0", env, stdout: tty, stderr: err, fetchImpl: stub(release("v0.19.0")).fetch, now });
  assert.equal(err.chunks.length, 1, "not again within 24 hours");
  clock += DAY_MS / 2;
  const plain = stream();
  await session({ version: "0.18.0", env: { ...env, NO_COLOR: "1" }, stdout: tty, stderr: plain, fetchImpl: stub(release("v0.19.0")).fetch, now });
  assert.equal(plain.text(), noticeText("0.18.0", "0.19.0"), "shown again the next day, without color under NO_COLOR");

  const io = collect();
  assert.equal(await updateCommand(["--skip"], { version: "0.18.0", env, fetchImpl: async () => { throw new Error("cache only"); }, now, io }), 0);
  assert.match(io.stdout, /0\.19\.0 skipped/);
  clock += DAY_MS;
  const skipped = stream();
  await session({ version: "0.18.0", env, stdout: tty, stderr: skipped, fetchImpl: stub(release("v0.19.0")).fetch, now });
  assert.equal(skipped.text(), "", "a skipped version is never announced");
  clock += DAY_MS;
  await session({ version: "0.18.0", env, stdout: tty, stderr: skipped, fetchImpl: stub(release("v0.19.1")).fetch, now });
  assert.match(skipped.text(), /0\.19\.1 available/, "a newer release notifies again");
});

test("a session that ends before the check finishes prints nothing and still counts as today's check", async (t) => {
  const { env } = fixture(t);
  let calls = 0;
  const slow = (_url, init) => { calls += 1; return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))); };
  const err = stream();
  const updates = startBackgroundUpdate({ version: "0.18.0", env, stdout: tty, stderr: err, fetchImpl: slow, delayMs: 0 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1, "the check started after the launch");
  updates.finish();
  await updates.pending;
  assert.equal(err.text(), "");
  assert.match(readCache(env).error, /session ended before the check finished/);
  await session({ version: "0.18.0", env, stdout: tty, stderr: err, fetchImpl: slow });
  assert.equal(calls, 1);
  // A session shorter than the start delay sends nothing at all.
  const fresh = fixture(t);
  const never = stub(release("v0.19.0"));
  startBackgroundUpdate({ version: "0.18.0", env: fresh.env, stdout: tty, stderr: err, fetchImpl: never.fetch, delayMs: 50 }).finish();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(never.calls.length, 0);
});

test("--auto on|off|status persists in the user config, keeps other settings, and never overwrites a broken file", async (t) => {
  const { env } = fixture(t);
  writeFileSync(configPath(env), JSON.stringify({ trusted: ["/x"], updates: { checkAutomatically: true } }));
  assert.deepEqual(readSettings(env), { checkAutomatically: true, auto: false, autoAsked: false }, "automatic install is off by default");
  const io = collect();
  await updateCommand(["--auto", "on"], { env, io });
  assert.equal(readSettings(env).auto, true);
  assert.deepEqual(JSON.parse(readFileSync(configPath(env), "utf8")).trusted, ["/x"]);
  assert.equal(statSync(configPath(env)).mode & 0o777, 0o600);
  const status = collect();
  await updateCommand(["--auto", "status"], { version: "0.18.0", env, io: status });
  assert.equal(status.stdout, "automatic updates: on\nupdate checks: on\nversion: 0.18.0\n");
  mkdirSync(dirname(logPath(env)), { recursive: true });
  writeFileSync(logPath(env), "old log\n");
  await updateCommand(["--auto", "off"], { env, io });
  assert.equal(readSettings(env).auto, false);
  assert.equal(existsSync(logPath(env)), false, "--auto off removes the automatic-install log");
  const off = collect();
  await updateCommand(["--auto", "status"], { version: "0.18.0", env: { ...env, STEAK_DSH_NO_UPDATE_CHECK: "1" }, io: off });
  assert.match(off.stdout, /update checks: off \(STEAK_DSH_NO_UPDATE_CHECK is set\)/);
  writeFileSync(configPath(env), "{ not json");
  await assert.rejects(updateCommand(["--auto", "on"], { env, io }), /not valid JSON/);
  assert.equal(readFileSync(configPath(env), "utf8"), "{ not json");
  await assert.rejects(updateCommand(["--auto", "maybe"], { env, io }), /on, off or status/);
});

// A global npm copy (<prefix>/lib/node_modules/steak-dsh) and a fake npm that records its arguments.
function npmCopy(f, npmExit = 0) {
  const rootDir = join(f.dir, "prefix", "lib", "node_modules", "steak-dsh");
  mkdirSync(join(rootDir, "bin"), { recursive: true });
  writeFileSync(join(rootDir, "package.json"), JSON.stringify({ name: "steak-dsh", version: "0.18.0" }));
  writeFileSync(join(rootDir, "bin", "steak-dsh"), "");
  const fakeBin = join(f.dir, "fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  const marker = join(f.dir, "npm-args");
  writeFileSync(join(fakeBin, "npm"), `#!/bin/sh\necho "$@" >> "${marker}"\necho "npm output"\nexit ${npmExit}\n`, { mode: 0o755 });
  f.env.PATH = `${fakeBin}:${nodeDir}:/usr/bin:/bin`;
  return { rootDir, marker };
}

test("update on a terminal asks before installing, then asks once about automatic installs (y turns them on)", async (t) => {
  const f = fixture(t);
  const { rootDir, marker } = npmCopy(f);
  assert.equal(installKind(rootDir), "npm");
  const questions = [];
  const answers = ["n"];
  const io = collect({ tty: true, ask: async (q) => { questions.push(q); return answers.shift() ?? ""; } });
  assert.equal(await updateCommand([], { version: "0.18.0", env: f.env, rootDir, fetchImpl: stub(release("v0.19.0")).fetch, io }), 0);
  assert.deepEqual(questions, ["Install 0.19.0 now? [Y/n] "]);
  assert.match(io.stdout, /steak-dsh 0\.18\.0 → 0\.19\.0\n  Changes\n  First note\n  Second note\n/);
  assert.match(io.stdout, /nothing was changed/);
  assert.equal(existsSync(marker), false);

  answers.push("", "y");
  const second = collect({ tty: true, ask: async (q) => { questions.push(q); return answers.shift() ?? ""; } });
  assert.equal(await updateCommand([], { version: "0.18.0", env: f.env, rootDir, fetchImpl: stub(release("v0.19.0")).fetch, io: second }), 0, second.stderr);
  assert.match(readFileSync(marker, "utf8"), /^install -g github:[^/]+\/steak-dsh#v0\.19\.0$/m, "npm owns the files: npm upgrades them");
  assert.deepEqual(questions.slice(1), ["Install 0.19.0 now? [Y/n] ", "Install future updates automatically? [y/N] "]);
  assert.deepEqual(readSettings(f.env), { checkAutomatically: true, auto: true, autoAsked: true });

  // Once answered, never asked again; without a terminal the explicit command installs without a question.
  writeFileSync(configPath(f.env), JSON.stringify({ updates: { auto: false, autoAsked: true } }));
  const quiet = collect({ tty: false, ask: async () => assert.fail("no question without a terminal") });
  assert.equal(await updateCommand([], { version: "0.18.0", env: f.env, rootDir, fetchImpl: stub(release("v0.19.0")).fetch, io: quiet }), 0);
  assert.equal(readFileSync(marker, "utf8").trim().split("\n").length, 2);
  assert.equal(readSettings(f.env).auto, false);
});

test("a source checkout or an unknown copy is never overwritten; update names the right command", async (t) => {
  const f = fixture(t);
  const checkout = join(f.dir, "checkout");
  mkdirSync(join(checkout, ".git"), { recursive: true });
  const unknown = join(f.dir, "somewhere");
  mkdirSync(unknown);
  assert.equal(installKind(checkout), "source");
  assert.equal(installKind(unknown), "unknown");
  assert.equal(installKind(root), "source");
  const io = collect();
  assert.equal(await updateCommand([], { version: "0.18.0", env: f.env, rootDir: checkout, fetchImpl: stub(release("v0.19.0")).fetch, io }), 1);
  assert.match(io.stderr, /not managed by the installer or npm; update it with: git -C .*checkout pull/);
  const other = collect();
  assert.equal(await updateCommand([], { version: "0.18.0", env: f.env, rootDir: unknown, fetchImpl: stub(release("v0.19.0")).fetch, io: other }), 1);
  assert.match(other.stderr, /releases\/latest\/download\/install\.(sh|ps1)/);
});

// ---- the installer path, against a local release server (in this process: nothing here may block the event loop)

function runAsync(file, args, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { env, cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function serve(t, dir) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    const file = join(dir, req.url.slice(1));
    if (!/^\/[\w.-]+$/.test(req.url) || !existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200);
    res.end(readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { base: `http://127.0.0.1:${server.address().port}`, hits };
}

/** A release folder (archive, installer, SHA256SUMS) whose launcher reports `version`, and an install home with a stand-in dsh. */
async function releaseFixture(t) {
  const f = fixture(t);
  const assets = join(f.dir, "assets");
  const home = join(f.dir, "install-home");
  const fakeBin = join(f.dir, "fake-bin");
  for (const path of [assets, join(home, "dsh", "node_modules", ".bin"), fakeBin, join(f.dir, "bin")]) mkdirSync(path, { recursive: true });
  writeFileSync(join(home, "dsh", "node_modules", ".bin", "dsh"), '#!/bin/sh\ncase "$1" in --version) echo 0.2.2-rc.1 ;; *) exit 0 ;; esac\n', { mode: 0o755 });
  writeFileSync(join(fakeBin, "pnpm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const server = await serve(t, assets);
  Object.assign(f.env, { PATH: `${fakeBin}:${nodeDir}:/usr/bin:/bin`, STEAK_DSH_RELEASE_BASE: server.base, STEAK_DSH_BIN_DIR: join(f.dir, "bin") });
  f.home = home;
  f.app = join(home, "app");
  f.server = server;
  f.publish = (version, { installer = readFileSync(join(root, "scripts", "install.sh"), "utf8") } = {}) => {
    const src = join(f.dir, `src-${version}`);
    mkdirSync(join(src, "bin"), { recursive: true });
    writeFileSync(join(src, "package.json"), JSON.stringify({ name: "steak-dsh", version }, null, 2) + "\n");
    writeFileSync(join(src, "cordis.patch.yml"), "# fixture\n");
    writeFileSync(join(src, "bin", "steak-dsh"), `#!/usr/bin/env node\nif (process.argv[2] === "--version") console.log(${JSON.stringify(version)});\n`, { mode: 0o755 });
    assert.equal(spawnSync("tar", ["-czf", join(assets, "steak-dsh.tar.gz"), "-C", src, "package.json", "cordis.patch.yml", "bin"]).status, 0);
    writeFileSync(join(assets, "install.sh"), installer);
    assert.equal(spawnSync("sh", ["-c", 'cd "$1" && (sha256sum steak-dsh.tar.gz install.sh 2>/dev/null || shasum -a 256 steak-dsh.tar.gz install.sh) > SHA256SUMS', "sh", assets]).status, 0);
  };
  /** The first install, done the way a user does it: the published installer run directly. */
  f.installFirst = async (version) => {
    f.publish(version);
    const r = await runAsync("sh", [join(assets, "install.sh")], { ...f.env, STEAK_DSH_HOME: home });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  };
  f.current = () => readlinkSync(join(f.app, "current")).split(/[/\\]/).pop();
  f.releases = () => readdirSync(f.app).filter((name) => name.startsWith("release-")).sort();
  f.temps = () => readdirSync(f.dir).filter((name) => name.startsWith("steak-dsh-update-"));
  return f;
}

test("update verifies the release's installer, which verifies the archive; a mismatch changes nothing and leaves no download", async (t) => {
  const f = await releaseFixture(t);
  await f.installFirst("0.18.0");
  const rootDir = join(f.app, "release-0.18.0");
  assert.equal(installKind(rootDir), "installer");

  // A tampered installer: refused before it runs.
  f.publish("0.18.1");
  writeFileSync(join(f.dir, "assets", "install.sh"), "#!/bin/sh\ntouch \"$HOME/ran\"\n");
  await assert.rejects(installVersion("0.18.1", { env: f.env, rootDir, tempRoot: f.dir }), /checksum mismatch for install\.sh; nothing was installed/);
  assert.equal(existsSync(join(f.env.HOME, "ran")), false);
  assert.equal(f.current(), "release-0.18.0");
  assert.deepEqual(f.temps(), [], "the download folder is removed on failure");

  // A tampered archive: the installer refuses it before unpacking.
  f.publish("0.18.1");
  const sums = readFileSync(join(f.dir, "assets", "SHA256SUMS"), "utf8").replace(/^[0-9a-f]{64}(?=\s+steak-dsh\.tar\.gz)/m, "0".repeat(64));
  writeFileSync(join(f.dir, "assets", "SHA256SUMS"), sums);
  await assert.rejects(installVersion("0.18.1", { env: f.env, rootDir, tempRoot: f.dir, log: () => {} }), /the installer exited with 1/);
  assert.equal(f.current(), "release-0.18.0");
  assert.deepEqual(f.releases(), ["release-0.18.0"]);

  // The real thing: verified, swapped, the previous release kept as the one rollback copy, the download removed.
  f.publish("0.18.1");
  const output = [];
  await installVersion("0.18.1", { env: f.env, rootDir, tempRoot: f.dir, log: (chunk) => output.push(String(chunk)) });
  assert.equal(f.current(), "release-0.18.1");
  assert.deepEqual(f.releases(), ["release-0.18.0", "release-0.18.1"]);
  assert.deepEqual(f.temps(), [], "the download folder is removed on success");
  assert.match(output.join(""), /Steak DSH 0\.18\.1 installed/);
  assert.ok(f.server.hits.includes("/SHA256SUMS") && f.server.hits.includes("/install.sh") && f.server.hits.includes("/steak-dsh.tar.gz"));

  // Never more than one rollback copy: the next install keeps 0.18.1 and drops 0.18.0.
  f.publish("0.18.2");
  await installVersion("0.18.2", { env: f.env, rootDir: join(f.app, "release-0.18.1"), tempRoot: f.dir, log: () => {} });
  assert.deepEqual(f.releases(), ["release-0.18.1", "release-0.18.2"]);
});

test("update --rollback checks the previous release starts, restores it, and skips the version rolled back from", async (t) => {
  const f = await releaseFixture(t);
  await f.installFirst("0.18.0");
  f.publish("0.18.1");
  await installVersion("0.18.1", { env: f.env, rootDir: join(f.app, "release-0.18.0"), tempRoot: f.dir, log: () => {} });
  const rootDir = join(f.app, "release-0.18.1");

  writeFileSync(join(f.app, "release-0.18.0", "bin", "steak-dsh"), "process.exit(3);\n");
  const broken = collect();
  assert.equal(await updateCommand(["--rollback"], { env: f.env, rootDir, io: broken }), 1);
  assert.match(broken.stderr, /release 0\.18\.0 does not start; nothing was changed/);
  assert.equal(f.current(), "release-0.18.1");

  writeFileSync(join(f.app, "release-0.18.0", "bin", "steak-dsh"), 'console.log("0.18.0");\n');
  const io = collect();
  assert.equal(await updateCommand(["--rollback"], { env: f.env, rootDir, io }), 0, io.stderr);
  assert.match(io.stdout, /rolled back to 0\.18\.0; 0\.18\.1 is skipped until a newer release/);
  assert.equal(f.current(), "release-0.18.0");
  assert.equal(readCache(f.env).skip, "0.18.1");
  const none = collect();
  assert.equal(await updateCommand(["--rollback"], { env: f.env, rootDir: join(f.app, "release-0.18.0"), io: none }), 1);
  assert.match(none.stderr, /no previous release is kept/);
});

test("the rollback copy is removed after the new release finishes a session, or after 7 days; never a newer one", (t) => {
  const { dir } = fixture(t);
  const app = join(dir, "home", "app");
  for (const version of ["0.18.0", "0.18.1", "0.18.2"]) mkdirSync(join(app, `release-${version}`, "bin"), { recursive: true });
  symlinkSync(join(app, "release-0.18.1"), join(app, "current"));
  const self = join(app, "release-0.18.1");
  assert.deepEqual(pruneRollback({ rootDir: self, succeeded: false }), [], "kept while the new release has not finished a session");
  assert.deepEqual(pruneRollback({ rootDir: join(app, "release-0.18.0"), succeeded: true }), [], "only the current release prunes");
  assert.deepEqual(pruneRollback({ rootDir: self, succeeded: false, now: Date.now() + KEEP_PREVIOUS_MS + 1000 }), ["0.18.0"], "7 days at most");
  mkdirSync(join(app, "release-0.18.0"));
  assert.deepEqual(pruneRollback({ rootDir: self, succeeded: true }), ["0.18.0"]);
  assert.deepEqual(readdirSync(app).sort(), ["current", "release-0.18.1", "release-0.18.2"], "a newer folder (an install in progress) stays");
  assert.deepEqual(pruneRollback({ rootDir: root, succeeded: true }), [], "a source checkout is left alone");
});

// ---- automatic installs

test("automatic install: a detached, low-priority child; its failure is recorded and the next session shows the prompt", async (t) => {
  const f = fixture(t);
  // The child is the launcher of the running copy: here a stand-in that records its arguments.
  const rootDir = join(f.dir, "copy");
  const marker = join(f.dir, "child-args");
  mkdirSync(join(rootDir, "bin"), { recursive: true });
  writeFileSync(join(rootDir, "bin", "steak-dsh"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(" "));\n`);
  writeFileSync(join(rootDir, "package.json"), "{}");
  startAutoInstall("0.19.0", { env: f.env, rootDir });
  for (let i = 0; i < 200 && !existsSync(marker); i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(readFileSync(marker, "utf8"), "update --apply 0.19.0");
  assert.equal(readCache(f.env).auto.state, "started");

  // The session that finds a release with auto on starts the install and prints nothing.
  const { rootDir: npmRoot } = npmCopy(f, 1);
  writeFileSync(configPath(f.env), JSON.stringify({ updates: { auto: true } }));
  updateCache({ auto: undefined }, f.env);
  const err = stream();
  await session({ version: "0.18.0", env: f.env, stdout: tty, stderr: err, fetchImpl: stub(release("v0.19.0")).fetch, rootDir: npmRoot });
  assert.equal(err.text(), "", "no notice while the install runs");
  assert.deepEqual({ ...readCache(f.env).auto, at: 0 }, { version: "0.19.0", state: "started", at: 0 });

  // The child itself (update --apply) records the failure with its cause in a bounded log.
  const io = collect();
  assert.equal(await updateCommand(["--apply", "0.19.0"], { version: "0.18.0", env: f.env, rootDir: npmRoot, io }), 1);
  assert.deepEqual({ ...readCache(f.env).auto, at: 0 }, { version: "0.19.0", state: "failed", at: 0, cause: "npm exited with 1" });
  assert.match(readFileSync(logPath(f.env), "utf8"), /installing steak-dsh 0\.19\.0\nnpm output\nfailed: npm exited with 1\n/);
  const next = stream();
  await session({ version: "0.18.0", env: f.env, stdout: tty, stderr: next, fetchImpl: stub(release("v0.19.0")).fetch, rootDir: npmRoot });
  assert.match(next.text(), /^steak-dsh 0\.19\.0 available \(you have 0\.18\.0\) · run: steak-dsh update\n.*automatic install failed: npm exited with 1 · skip: steak-dsh update --skip/);

  // A successful child records it, and sessions still on the old version say nothing.
  const ok = npmCopy(f, 0);
  updateCache({ shown: undefined }, f.env);
  assert.equal(await updateCommand(["--apply", "0.19.0"], { version: "0.18.0", env: f.env, rootDir: ok.rootDir, io }), 0);
  assert.equal(readCache(f.env).auto.state, "installed");
  const quiet = stream();
  await session({ version: "0.18.0", env: f.env, stdout: tty, stderr: quiet, fetchImpl: stub(release("v0.19.0")).fetch, rootDir: ok.rootDir });
  assert.equal(quiet.text(), "");
});

test("the automatic-install log is one file, rewritten each time and capped at 256 KB", (t) => {
  const { env } = fixture(t);
  let log = openLog(env);
  for (let i = 0; i < 40; i += 1) log.write("x".repeat(10_000) + "\n");
  log.close();
  assert.equal(statSync(logPath(env)).size, LOG_MAX);
  assert.equal(statSync(logPath(env)).mode & 0o777, 0o600);
  log = openLog(env);
  log.write("second run\n");
  log.close();
  assert.equal(readFileSync(logPath(env), "utf8"), "second run\n");
  assert.deepEqual(readdirSync(dirname(logPath(env))), ["update.log"]);
});

// ---- the launcher itself

async function apiServer(t, body, status = 200) {
  let hits = 0;
  const server = createServer((_req, res) => { hits += 1; res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { url: `http://127.0.0.1:${server.address().port}/latest`, hits: () => hits };
}

test("steak-dsh update --check against a release server: exit codes and output", async (t) => {
  const { env } = fixture(t);
  const run = (url) => runAsync(process.execPath, [launcher, "update", "--check"], { ...env, STEAK_DSH_UPDATE_API: url });
  const newer = await apiServer(t, { tag_name: "v99.0.0" });
  let r = await run(newer.url);
  assert.equal(r.status, 10, r.stderr);
  assert.match(r.stdout, /^steak-dsh 99\.0\.0 available \(you have \d+\.\d+\.\d+\) · run: /);
  const same = await apiServer(t, { tag_name: `v${JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version}` });
  r = await run(same.url);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /is up to date/);
  const broken = await apiServer(t, {}, 500);
  r = await run(broken.url);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /update check failed: HTTP 500/);
});

test("a headless run, even with --json, never contacts the release API and prints no notice", async (t) => {
  const { dir, env } = fixture(t);
  const api = await apiServer(t, { tag_name: "v99.0.0" });
  const fake = join(dir, "fake-dsh.mjs");
  writeFileSync(fake, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({type:"text",text:"ok"})+"\\n");\n', { mode: 0o755 });
  const result = await runAsync(process.execPath, [launcher, "run", "--json", "hi"], { ...env, STEAK_DSH_UPDATE_API: api.url, STEAK_DSH_DSH_BIN: fake }, dir);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim()).type, "text");
  assert.equal(api.hits(), 0);
  assert.doesNotMatch(result.stderr, /available/);
  assert.equal(existsSync(cachePath(env)), false);
});

test("update code, docs and tests carry no personal names, emails or home paths; the docs carry the contract marker", () => {
  const banned = [new RegExp("michael" + "-?berardi", "i"), new RegExp("/Users" + "/"), new RegExp("liberty" + "design", "i"), new RegExp("[\\w.-]+" + "@" + "[\\w-]+\\.[a-z]{2,}", "i")];
  for (const file of ["lib/update.js", "docs/updates.md", "test/update.test.js", "PRIVACY.md"]) {
    const text = readFileSync(join(root, file), "utf8");
    for (const pattern of banned) assert.equal(pattern.test(text), false, `${file} matches ${pattern}`);
  }
  assert.match(readFileSync(join(root, "docs", "updates.md"), "utf8"), /^<!-- update-contract: v1 -->$/m);
});
